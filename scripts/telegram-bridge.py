#!/usr/bin/env python3
"""Telegram bridge for Paperclip — a multi-bot, multi-COMPANY companion service.

Each Telegram-enabled agent has its own bot (its own identity), scoped to ONE
company. You chat with "the CEO", "Fork Lead", "Dashboard Boss" as separate
contacts across different companies. Bot-less agents escalate UP the org chart
*within their company*: their approvals/messages are sent via the nearest boss's
bot, tagged "(on behalf of X)". Purely additive to the dashboard — the same
approvals/tasks still live in Paperclip and the web UI.

- Outbound: a pending approval is routed to the requesting agent's bot (or the
  nearest boss's bot up `reportsTo`, within the same company), with Approve/Reject
  buttons. Credential requests link to the dashboard form instead (a button can't
  carry a secret value).
- Inbound (per bot): Approve/Reject taps resolve the approval. A text message
  goes through the same chat router the web chat uses (DUR-3978): a quick
  question is answered in the same chat when that bot's agent has quick answers
  switched on, and the chat keeps one conversation so follow-ups have context
  (`/new` starts over). Anything else becomes a task for that bot's agent in
  that bot's company, and the agent's answer is posted back into the chat the
  task came from once it is done or waiting.

Config: /root/paperclip/.telegram-agents.json =
  [{"agentId","name","token","companyId"?,"uiBase"?}, ...]  (root-only)
`companyId` scopes the bot to a company (defaults to PAPERCLIP_COMPANY_ID).
`uiBase` is the deep-link base for that company (defaults to PAPERCLIP_UI_HOST).
"""
import json
import os
import re
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from collections import defaultdict

DEFAULT_COMPANY_ID = os.environ.get("PAPERCLIP_COMPANY_ID", "7600f03c-c836-4326-8d48-c801813c3a87")
CONTAINER = os.environ.get("PAPERCLIP_CONTAINER", "docker-server-1")
API_BASE = os.environ.get("PAPERCLIP_API_BASE", "http://127.0.0.1:3100")
DATA_DIR = os.environ.get("PAPERCLIP_CLI_DATA_DIR", "/paperclip/cli-state")
UI_HOST = os.environ.get("PAPERCLIP_UI_HOST", "https://paperclip-prod.tailc4d456.ts.net")
CONFIG_FILE = os.environ.get("TELEGRAM_AGENTS_FILE", "/root/paperclip/.telegram-agents.json")
STATE_FILE = os.environ.get("TELEGRAM_STATE_FILE", "/root/paperclip/.telegram-state.json")
CLI = "cd /app && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts"
ARGS = f"--api-base {API_BASE} --data-dir {DATA_DIR} --json"

# DUR-3978: two-way chat.
TG_TEXT_LIMIT = 4096  # Telegram's limit per message, counted in UTF-16 units
QUICK_ANSWER_MAX_PARTS = 4
CUT_SHORT_NOTE = "\n(The answer was too long for Telegram and was cut short.)"
# Refusal codes from server/src/services/lane-a.ts meaning the stored
# conversation cannot be continued; the same message is sent again as the start
# of a fresh conversation. A test pins that these codes still exist there.
CONVERSATION_ENDED_CODES = ("LANE_A_CONVERSATION_EXPIRED", "LANE_A_TURN_CAP_REACHED")
# Refusals meaning "no quick answer right now": the daily limit, the model busy
# or down, or quick answers not set up on the server. The message is handed over
# as a task instead, which is what every message did before, so this is never
# worse than before (fail-open to the old behaviour, not to silence).
QUICK_UNAVAILABLE_STATUSES = (429, 502, 503, 504)
ANSWER_FINISHED_STATUSES = ("done", "cancelled")
ANSWER_WAITING_STATUSES = ("in_review", "blocked")
# A task that has not finished after this long stops being watched.
TASK_ANSWER_MAX_AGE_SECONDS = 30 * 24 * 3600
TASK_ANSWERS_PER_CALL = 50  # the server's limit per call
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

LOCK = threading.Lock()

# Telegram user ids allowed to use the bots; set in main(). Empty means nobody.
ALLOWED_USER_IDS = set()


def load_bots():
    with open(CONFIG_FILE) as f:
        bots = json.load(f)
    for b in bots:
        b["token"] = b["token"].strip()
        b.setdefault("companyId", DEFAULT_COMPANY_ID)
        b.setdefault("uiBase", UI_HOST)
    return bots


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {"bots": {}, "notified": []}


def save_state(s):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
    os.replace(tmp, STATE_FILE)


def tg(token, method, http_timeout=20, **params):
    data = urllib.parse.urlencode(
        {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in params.items()}
    ).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=data), timeout=http_timeout) as r:
            return json.load(r).get("result")
    except Exception as e:
        print(f"tg {method} error: {e}", flush=True)
        return None


def cli(*parts):
    try:
        out = subprocess.check_output(
            ["docker", "exec", CONTAINER, "sh", "-lc", f"{CLI} {' '.join(parts)} {ARGS}"],
            stderr=subprocess.DEVNULL, timeout=60)
        return json.loads(out.decode())
    except Exception as e:
        print(f"cli error ({parts[0] if parts else '?'}): {e}", flush=True)
        return None


def cli_env(env, *parts):
    args = ["docker", "exec"]
    for k, v in env.items():
        args += ["-e", f"{k}={v}"]
    args += [CONTAINER, "sh", "-lc", f"{CLI} {' '.join(parts)} {ARGS}"]
    try:
        return json.loads(subprocess.check_output(args, stderr=subprocess.DEVNULL, timeout=90).decode())
    except Exception as e:
        print(f"cli_env error ({parts[0] if parts else '?'}): {e}", flush=True)
        return None


def fetch_org(company_id):
    """Return (reports_to, names) maps from a company's live org."""
    data = cli("agent", "list", "-C", company_id) or []
    reports_to, names = {}, {}
    for a in data:
        reports_to[a["id"]] = a.get("reportsTo")
        names[a["id"]] = a.get("name")
    return reports_to, names


def resolve_bot(agent_id, bots_by_agent, reports_to, default_bot):
    """Walk up the org from agent_id to the nearest bot-enabled agent (same company)."""
    seen, cur = set(), agent_id
    while cur and cur not in seen:
        seen.add(cur)
        if cur in bots_by_agent:
            return bots_by_agent[cur], cur != agent_id
        cur = reports_to.get(cur)
    return default_bot, True  # fallback: everyone reaches the company's top bot


def _org_depth(agent_id, reports_to):
    """Distance from agent to the org root (used to pick a company's top bot)."""
    d, cur, seen = 0, agent_id, set()
    while cur and cur not in seen and reports_to.get(cur):
        seen.add(cur)
        cur = reports_to.get(cur)
        d += 1
    return d


def approval_title(a):
    p = a.get("payload") or {}
    subject = p.get("title") or p.get("name") or p.get("summary")
    if a.get("type") == "credential_request":
        return f"🔑 Credential request: {p.get('name') or p.get('envKey') or 'credential'}"
    if str(p.get("kind")) == "deploy":
        return f"🚀 Deploy request: {subject or 'to production'}"
    if a.get("type") == "hire_agent":
        return f"🧑‍💼 Hire agent: {subject or ''}".strip()
    if str(p.get("kind")) == "model_boost":
        # The server already words the title as "<Agent> asks to use Opus at
        # high effort for this task, up to $20, for the next 4 hours".
        return f"⚡ Boost request: {subject or 'a stronger model for one task'}"
    return f"🔔 Approval: {subject or a.get('type')}"


def boost_boss_review(a):
    """The boss-first routing stamp on a model_boost approval, or None."""
    p = a.get("payload") or {}
    if str(p.get("kind")) != "model_boost":
        return None
    review = p.get("bossReview")
    return review if isinstance(review, dict) else None


def boost_waiting_on_boss(a):
    """True while a boost ask is still with the requester's boss (agent -> boss
    -> operator). The dashboard card is already visible, but Telegram holds
    the ping back until the boss answers or the server times the boss out."""
    review = boost_boss_review(a)
    return bool(review) and review.get("status") == "awaiting_boss"


def boost_boss_line(a):
    """One plain line saying what the boss did with a boost ask, or None."""
    review = boost_boss_review(a)
    if not review:
        return None
    boss = review.get("bossName") or "Their boss"
    note = (review.get("note") or "").strip()
    status = review.get("status")
    if status == "forwarded":
        return f"{boss} passed this on to you: {note}" if note else f"{boss} passed this on to you without a recommendation."
    if status == "timed_out":
        return f"{boss} did not answer in time, so this came to you."
    return None


def notify_approvals(state, bots):
    """Route each company's pending approvals to the right bot in that company."""
    by_company = defaultdict(list)
    for b in bots:
        by_company[b["companyId"]].append(b)
    with LOCK:
        notified = set(state["notified"])
    for company_id, cbots in by_company.items():
        data = cli("approval", "list", "-C", company_id)
        if data is None:
            continue
        items = data if isinstance(data, list) else data.get("approvals", [])
        reports_to, names = fetch_org(company_id)
        bots_by_agent = {b["agentId"]: b for b in cbots}
        # The company's "top bot" (closest to the org root) is the escalation sink.
        default_bot = min(cbots, key=lambda b: _org_depth(b["agentId"], reports_to))
        for a in items:
            if a.get("status") not in ("pending", "revision_requested"):
                continue
            aid = a.get("id")
            if aid in notified:
                continue
            if boost_waiting_on_boss(a):
                continue
            requester = a.get("requestedByAgentId")
            bot, escalated = resolve_bot(requester, bots_by_agent, reports_to, default_bot)
            p = a.get("payload") or {}
            detail = p.get("note") or p.get("summary") or p.get("description") or ""
            is_cred = a.get("type") == "credential_request"
            text = f"*{approval_title(a)}*"
            if detail:
                text += f"\n{detail[:300]}"
            boss_line = boost_boss_line(a)
            if boss_line:
                text += f"\n_{boss_line[:300]}_"
            # PR/branch/commit trail, if any, stays a small secondary line —
            # never the headline. See DUR-24.
            technical_reference = p.get("technicalReference")
            if technical_reference:
                text += f"\n_{technical_reference}_"
            if escalated and requester:
                text += f"\n_(on behalf of {names.get(requester, 'a teammate')})_"
            if is_cred:
                text += "\n⚠️ Provide the value in Paperclip — a button can't carry a secret."
            text += f"\n\n[Open in Paperclip]({bot['uiBase']}/approvals/{aid})"
            # Credential requests need a value, not an Approve/Reject tap — send them
            # without the keyboard so the only path is the (secure) dashboard form.
            kb = None if is_cred else {"inline_keyboard": [[
                {"text": "✅ Approve", "callback_data": f"approve:{aid}"},
                {"text": "❌ Reject", "callback_data": f"reject:{aid}"},
            ]]}
            sent = False
            for chat in deliverable_chats(state, bot["token"]):
                params = dict(chat_id=chat, text=text, parse_mode="Markdown", disable_web_page_preview=True)
                if kb:
                    params["reply_markup"] = kb
                res = tg(bot["token"], "sendMessage", **params)
                if res is None:
                    # Legacy Markdown 400s on unbalanced entities in agent-authored
                    # text — retry once as plain text so the alert still lands.
                    params.pop("parse_mode", None)
                    res = tg(bot["token"], "sendMessage", **params)
                if res is not None:
                    sent = True
            # Only suppress future re-notification once it has actually been
            # delivered. If no chat is registered yet (user hasn't /start-ed this
            # bot), leave it un-notified so a later poll delivers it once they do.
            if sent:
                notified.add(aid)
    with LOCK:
        state["notified"] = list(notified)[-800:]
        save_state(state)


# Statuses that mean "work has parked and a human probably needs to look" — the
# safety net so a stalled task surfaces even when the agent never filed a card.
# Covers both review-parked and blocked/stopped work.
WAITING_STATUSES = "in_review,blocked"


def notify_waiting(state, bots):
    """Ping the owning bot when a task parks in a waiting state, so stalls surface."""
    by_company = defaultdict(list)
    for b in bots:
        by_company[b["companyId"]].append(b)
    with LOCK:
        seen = set(state.get("notified_waiting", []))
    for company_id, cbots in by_company.items():
        data = cli("issue", "list", "-C", company_id, "--status", WAITING_STATUSES)
        if data is None:
            continue
        items = data if isinstance(data, list) else data.get("issues", [])
        reports_to, names = fetch_org(company_id)
        bots_by_agent = {b["agentId"]: b for b in cbots}
        default_bot = min(cbots, key=lambda b: _org_depth(b["agentId"], reports_to))
        for it in items:
            iid = it.get("id")
            status = it.get("status")
            key = f"{iid}:{status}"
            if not iid or key in seen:
                continue
            owner = it.get("assigneeAgentId")
            bot, escalated = (
                resolve_bot(owner, bots_by_agent, reports_to, default_bot)
                if owner
                else (default_bot, True)
            )
            ident = it.get("identifier") or iid[:8]
            title = (it.get("title") or "")[:200]
            label = "🚧 Blocked / stopped" if status == "blocked" else "🔎 Parked for review"
            text = f"*{label}: {ident}*\n{title}"
            if escalated and owner:
                text += f"\n_(owned by {names.get(owner, 'a teammate')})_"
            text += "\nThis task is waiting and may need your input or go-ahead."
            text += f"\n\n[Open in Paperclip]({bot['uiBase']}/issues/{iid})"
            sent = False
            for chat in deliverable_chats(state, bot["token"]):
                res = tg(bot["token"], "sendMessage", chat_id=chat, text=text,
                         parse_mode="Markdown", disable_web_page_preview=True)
                if res is None:
                    res = tg(bot["token"], "sendMessage", chat_id=chat, text=text,
                             disable_web_page_preview=True)
                if res is not None:
                    sent = True
            if sent:
                seen.add(key)
    with LOCK:
        state["notified_waiting"] = list(seen)[-800:]
        save_state(state)


def notify_stalled_agents(state, bots):
    """DUR-128: page the operator when an agent has sat in 'error' past the
    server's stall threshold. Server-side agent-error-alerts.ts already marks
    errorAlertedAt in the DB once per error episode -- this just has to
    surface that same signal in Telegram instead of leaving it to be found in
    an activity log nobody is looking at. Keyed on id:errorAt so a later
    episode for the same agent (a fresh errorAt) re-notifies."""
    by_company = defaultdict(list)
    for b in bots:
        by_company[b["companyId"]].append(b)
    with LOCK:
        seen = set(state.get("notified_stalled_agents", []))
    for company_id, cbots in by_company.items():
        data = cli("agent", "list", "-C", company_id)
        if data is None:
            continue
        reports_to, names = fetch_org(company_id)
        bots_by_agent = {b["agentId"]: b for b in cbots}
        default_bot = min(cbots, key=lambda b: _org_depth(b["agentId"], reports_to))
        for a in data:
            if a.get("status") != "error" or not a.get("errorAlertedAt"):
                continue
            aid = a.get("id")
            key = f"{aid}:{a.get('errorAt')}"
            if not aid or key in seen:
                continue
            bot, escalated = resolve_bot(aid, bots_by_agent, reports_to, default_bot)
            reason = (a.get("errorReason") or "no reason recorded")[:300]
            text = f"🛑 *{a.get('name') or aid} has been stuck in error*\n{reason}"
            text += "\nNo one has cleared it yet. It needs `clear-error` + `resume`, or someone to look."
            text += f"\n\n[Open in Paperclip]({bot['uiBase']}/agents/{aid})"
            sent = False
            for chat in deliverable_chats(state, bot["token"]):
                res = tg(bot["token"], "sendMessage", chat_id=chat, text=text,
                         parse_mode="Markdown", disable_web_page_preview=True)
                if res is None:
                    res = tg(bot["token"], "sendMessage", chat_id=chat, text=text,
                             disable_web_page_preview=True)
                if res is not None:
                    sent = True
            if sent:
                seen.add(key)
    with LOCK:
        state["notified_stalled_agents"] = list(seen)[-800:]
        save_state(state)


def interaction_question(it):
    """Plain-language question text — the prompt an agent halted on, not a
    generic status label. Mirrors ui/src/pages/DashboardNow.tsx's
    interactionQuestionText (DUR-30)."""
    title = (it.get("title") or "").strip()
    if title:
        return title
    kind = it.get("kind")
    payload = it.get("payload") or {}
    if kind in ("request_confirmation", "request_checkbox_confirmation"):
        return payload.get("prompt") or "Confirmation needed"
    if kind == "ask_user_questions":
        questions = payload.get("questions") or []
        return payload.get("title") or (questions[0].get("prompt") if questions else None) or "Question"
    if kind == "suggest_tasks":
        count = len(payload.get("tasks") or [])
        return (it.get("summary") or "").strip() or f"{count} suggested task{'s' if count != 1 else ''}"
    return "Needs your answer"


def notify_interactions(state, bots):
    """Ping the owning bot when an agent halts an issue thread with a direct
    question — independent of the issue's status, unlike notify_waiting below.
    Only ever polls status=pending, i.e. asks still awaiting a human (DUR-30)."""
    by_company = defaultdict(list)
    for b in bots:
        by_company[b["companyId"]].append(b)
    with LOCK:
        seen = set(state.get("notified_interactions", []))
    for company_id, cbots in by_company.items():
        data = cli("issue", "interactions:pending", "-C", company_id)
        if data is None:
            continue
        items = data if isinstance(data, list) else data.get("interactions", [])
        reports_to, names = fetch_org(company_id)
        bots_by_agent = {b["agentId"]: b for b in cbots}
        default_bot = min(cbots, key=lambda b: _org_depth(b["agentId"], reports_to))
        for it in items:
            iid = it.get("id")
            issue_id = it.get("issueId")
            if not iid or not issue_id or iid in seen:
                continue
            requester = it.get("createdByAgentId")
            bot, escalated = resolve_bot(requester, bots_by_agent, reports_to, default_bot)
            issue_ref = it.get("issueIdentifier") or issue_id
            issue_title = (it.get("issueTitle") or "")[:200]
            question = interaction_question(it)[:300]
            text = f"*❓ {question}*"
            text += f"\n{issue_ref} · {issue_title}"
            if escalated and requester:
                text += f"\n_(from {names.get(requester, 'a teammate')})_"
            text += "\nYour OK is needed before this continues."
            text += f"\n\n[Open in Paperclip]({bot['uiBase']}/issues/{issue_ref}#interaction-{iid})"
            # Only a plain confirmation resolves with a single tap; checkbox
            # selections, question forms, and task drafts need the full form in
            # the issue thread, same split as the Needs-you lane in the UI. A
            # confirmation that requires a decline reason also needs the full
            # form — a Decline tap with no reason would just fail server-side.
            supports_inline_decision = (
                it.get("kind") == "request_confirmation"
                and (it.get("payload") or {}).get("rejectRequiresReason") is not True
            )
            kb = None if not supports_inline_decision else {"inline_keyboard": [[
                {"text": "✅ Approve", "callback_data": f"iaccept:{issue_id}:{iid}"},
                {"text": "❌ Decline", "callback_data": f"ireject:{issue_id}:{iid}"},
            ]]}
            sent = False
            for chat in deliverable_chats(state, bot["token"]):
                params = dict(chat_id=chat, text=text, parse_mode="Markdown", disable_web_page_preview=True)
                if kb:
                    params["reply_markup"] = kb
                res = tg(bot["token"], "sendMessage", **params)
                if res is None:
                    params.pop("parse_mode", None)
                    res = tg(bot["token"], "sendMessage", **params)
                if res is not None:
                    sent = True
            if sent:
                seen.add(iid)
    with LOCK:
        state["notified_interactions"] = list(seen)[-800:]
        save_state(state)


def bots_state(state, token):
    with LOCK:
        return state["bots"].setdefault(token, {"offset": 0, "chats": []})


def parse_allowed_user_ids(raw):
    ids = set()
    for part in (raw or "").replace(";", ",").split(","):
        part = part.strip()
        if part.isdigit():
            ids.add(int(part))
    return ids


def resolve_allowed_user_ids(state, env_value):
    """Who may use the bots: their Telegram user ids, and where that came from.

    Every bot can create tasks and its Approve button runs with the operator's
    board rights, so this is fail-closed: nobody listed means nobody gets in.
    TELEGRAM_ALLOWED_USER_IDS (comma-separated) wins when set. Without it, the
    private chats already connected when this check was introduced are kept,
    so the operator's existing chat keeps working with no setup. In a private
    chat the chat id is the user's id. Group chats never count.
    """
    configured = parse_allowed_user_ids(env_value)
    if configured:
        return configured, "TELEGRAM_ALLOWED_USER_IDS"
    derived = set()
    for bs in (state.get("bots") or {}).values():
        for chat in bs.get("chats") or []:
            if isinstance(chat, int) and chat > 0:
                derived.add(chat)
    return derived, "private chats already connected"


def deliverable_chats(state, token):
    """The chats a bot may send cards to: allowed people's private chats only."""
    return [chat for chat in bots_state(state, token)["chats"] if chat in ALLOWED_USER_IDS]


def register_chat(state, token, chat_id):
    with LOCK:
        bs = state["bots"].setdefault(token, {"offset": 0, "chats": []})
        if chat_id not in bs["chats"]:
            bs["chats"].append(chat_id)
            save_state(state)


# ─── DUR-3978: two-way chat ────────────────────────────────────────────────────

def _bot_entry(state, token):
    """This bot's state. The caller must hold LOCK."""
    return state["bots"].setdefault(token, {"offset": 0, "chats": []})


def get_conversation(state, token, chat_id):
    """The quick-answer conversation this chat is in with this bot, if any."""
    with LOCK:
        entry = (_bot_entry(state, token).get("conversations") or {}).get(str(chat_id)) or {}
    conversation_id = entry.get("id")
    return conversation_id if isinstance(conversation_id, str) and UUID_RE.match(conversation_id) else None


def set_conversation(state, token, chat_id, conversation_id):
    """Remember (or, with None, forget) the conversation for one (bot, chat)."""
    with LOCK:
        conversations = _bot_entry(state, token).setdefault("conversations", {})
        if conversation_id:
            conversations[str(chat_id)] = {"id": conversation_id, "at": time.time()}
        else:
            conversations.pop(str(chat_id), None)
        save_state(state)


def remember_task(state, token, chat_id, task_ref, text):
    """Record that a task came from this chat, so its answer goes back there."""
    with LOCK:
        tasks = _bot_entry(state, token).setdefault("tasks", {})
        tasks[task_ref["issueId"]] = {
            "chat": chat_id,
            "identifier": task_ref.get("identifier") or "",
            "title": first_line(text)[:200],
            "at": time.time(),
        }
        save_state(state)


def first_line(text):
    return next((line.strip() for line in (text or "").splitlines() if line.strip()), "")


def tg_len(text):
    """Length the way Telegram counts it (UTF-16 code units)."""
    return len(text.encode("utf-16-le")) // 2


def tg_truncate(text, limit):
    """Shorten to at most `limit` Telegram units, ending in an ellipsis if cut."""
    if tg_len(text) <= limit:
        return text
    out, used = [], 0
    for ch in text:
        width = 2 if ord(ch) > 0xFFFF else 1
        if used + width > limit - 1:
            break
        out.append(ch)
        used += width
    return "".join(out) + "…"


def split_for_telegram(text, limit=TG_TEXT_LIMIT, max_parts=QUICK_ANSWER_MAX_PARTS):
    """Split into messages Telegram accepts, preferring line breaks. Past
    `max_parts` the last part is cut short and says so."""
    parts, rest = [], text
    while rest:
        if tg_len(rest) <= limit:
            parts.append(rest)
            break
        if len(parts) == max_parts - 1:
            parts.append(tg_truncate(rest, limit - tg_len(CUT_SHORT_NOTE)) + CUT_SHORT_NOTE)
            break
        head = tg_truncate(rest, limit)[:-1]
        cut = head.rfind("\n")
        if cut <= len(head) // 2:
            cut = len(head)
        parts.append(rest[:cut])
        rest = rest[cut:].lstrip("\n")
    return parts


def send_plain(token, chat_id, text):
    """Send text written by an agent or a person. No parse mode, so nothing in
    it can format the message, hide a link behind other words, or make
    Telegram reject the message."""
    for part in split_for_telegram(text):
        tg(token, "sendMessage", chat_id=chat_id, text=part, disable_web_page_preview=True)


def chat_send(bot, text, conversation_id=None, lane=None):
    """One message through the chat router. The agent and the company are always
    the bot's own from its config; the message only ever travels as data in an
    environment variable, never as part of the command."""
    parts = ["chat", "send", bot["agentId"], "-C", bot["companyId"], "--message", '"$TT"']
    if conversation_id and UUID_RE.match(conversation_id):
        parts += ["--conversation-id", conversation_id]
    if lane in ("a", "b"):
        parts += ["--lane", lane]
    return cli_env({"TT": text}, *parts)


def _refused(res):
    return isinstance(res, dict) and res.get("ok") is False


def ask_agent(state, bot, chat_id, text, force_task=False):
    """Send a chat message to the bot's agent and reply in the same chat."""
    token, agent_name = bot["token"], bot["name"]
    tg(token, "sendChatAction", chat_id=chat_id, action="typing")
    conversation_id = None if force_task else get_conversation(state, token, chat_id)
    notes = []
    res = chat_send(bot, text, conversation_id, "b" if force_task else None)
    if _refused(res) and conversation_id and res.get("code") in CONVERSATION_ENDED_CODES:
        set_conversation(state, token, chat_id, None)
        notes.append("(The earlier conversation had ended, so this starts a fresh one.)")
        res = chat_send(bot, text)
    if _refused(res) and not force_task and res.get("status") in QUICK_UNAVAILABLE_STATUSES:
        notes.append("Quick answers aren't available right now, so I've handed this over as a task.")
        res = chat_send(bot, text, lane="b")

    if res is None:
        # The command may have timed out after the server acted, so do not
        # claim that nothing happened.
        send_plain(token, chat_id, (
            f"I didn't hear back from Paperclip, so I can't tell whether {agent_name} got that. "
            "Check Paperclip before sending it again."))
        return
    if _refused(res):
        reason = str(res.get("error") or "").strip()[:300]
        send_plain(token, chat_id, f"Couldn't send that to {agent_name}." + (f" Paperclip said: {reason}" if reason else ""))
        return

    lane = res.get("lane") if isinstance(res, dict) else None
    if lane == "a":
        result = res.get("result") or {}
        conversation = result.get("conversationId")
        if isinstance(conversation, str) and UUID_RE.match(conversation):
            set_conversation(state, token, chat_id, conversation)
        answer = str(result.get("response") or "").strip() or f"{agent_name} had nothing to add."
        send_plain(token, chat_id, "\n\n".join(notes + [answer]))
        return
    task_ref = res.get("taskRef") if isinstance(res, dict) else None
    if lane == "b" and isinstance(task_ref, dict) and isinstance(task_ref.get("issueId"), str) \
            and UUID_RE.match(task_ref["issueId"]):
        # Durable first: the chat is recorded before the reply goes out.
        remember_task(state, token, chat_id, task_ref, text)
        ident = task_ref.get("identifier") or "a task"
        confirmation = (
            f"✅ Sent to {agent_name} as {ident} — {tg_truncate(first_line(text), 200)}\n"
            "I'll post the answer here when it's done.")
        send_plain(token, chat_id, "\n\n".join(notes + [confirmation]))
        return
    send_plain(token, chat_id, (
        f"Something went wrong sending that to {agent_name}. "
        "Check Paperclip before sending it again."))


def format_task_answer(bot, item, entry, answer):
    """The message that carries a task's answer back into its chat."""
    ident = item.get("identifier") or entry.get("identifier") or "The task"
    title = (item.get("title") or entry.get("title") or "").strip()[:200]
    status = item.get("status")
    link = f"{bot['uiBase']}/issues/{item.get('identifier') or item.get('id')}"
    if status == "done":
        head = f"✅ {bot['name']} finished {ident}"
    elif status == "cancelled":
        head = f"✖️ {ident} was cancelled"
    else:
        head = f"⏸ {ident} is waiting and may need you"
    if title:
        head += f" — {title}"
    footer = f"\n\nOpen the task: {link}"
    if not answer:
        return f"{head}\nNo written answer.{footer}"
    body = str(answer.get("body") or "").strip()
    room = TG_TEXT_LIMIT - tg_len(head) - tg_len(footer) - 2
    if tg_len(body) > room:
        footer = f"\n\nThis answer is too long for Telegram. Read all of it here: {link}"
        room = TG_TEXT_LIMIT - tg_len(head) - tg_len(footer) - 2
        body = tg_truncate(body, room)
    return f"{head}\n\n{body}{footer}"


def notify_task_answers(state, bots):
    """Post each chat task's answer into the chat the task came from, once.

    Only tasks this bot recorded from one of its chats are ever looked at, only
    in this bot's company, and only ever posted to the chat that created them
    (never to the bot's other chats). An answer is marked as posted in the state
    file after Telegram accepted it, so a restart does not post it again and a
    failed send is retried on the next pass.
    """
    for bot in bots:
        token = bot["token"]
        with LOCK:
            tasks = {iid: dict(e) for iid, e in (_bot_entry(state, token).get("tasks") or {}).items()}
        if not tasks:
            continue
        now = time.time()
        finished = {iid for iid, e in tasks.items()
                    if not UUID_RE.match(iid) or now - float(e.get("at") or 0) > TASK_ANSWER_MAX_AGE_SECONDS}
        posted = {}
        ids = sorted((iid for iid in tasks if iid not in finished),
                     key=lambda iid: float(tasks[iid].get("at") or 0), reverse=True)[:TASK_ANSWERS_PER_CALL]
        data = cli("chat", "answers", "-C", bot["companyId"], *ids) if ids else None
        items = data.get("issues") if isinstance(data, dict) else None
        for it in items if isinstance(items, list) else []:
            iid = it.get("id")
            entry = tasks.get(iid)
            if not entry or iid in finished or it.get("companyId") != bot["companyId"]:
                continue
            status = it.get("status")
            is_finished = status in ANSWER_FINISHED_STATUSES
            if not is_finished and status not in ANSWER_WAITING_STATUSES:
                continue
            chat = entry.get("chat")
            if chat not in ALLOWED_USER_IDS:
                # That person is no longer allowed: post nothing, stop watching.
                if is_finished:
                    finished.add(iid)
                continue
            answer = it.get("answer") if isinstance(it.get("answer"), dict) else None
            comment_id = (answer or {}).get("commentId")
            is_new = bool(comment_id) and comment_id != entry.get("postedCommentId")
            text = None
            if is_new:
                text = format_task_answer(bot, it, entry, answer)
            elif is_finished and not entry.get("postedCommentId"):
                text = format_task_answer(bot, it, entry, None)
            if text is not None:
                if tg(token, "sendMessage", chat_id=chat, text=text, disable_web_page_preview=True) is None:
                    continue  # not delivered; try again next pass
                if is_new:
                    posted[iid] = comment_id
            if is_finished:
                finished.add(iid)
        if not finished and not posted:
            continue
        with LOCK:
            live = _bot_entry(state, token).setdefault("tasks", {})
            for iid, comment_id in posted.items():
                if iid in live:
                    live[iid]["postedCommentId"] = comment_id
            for iid in finished:
                live.pop(iid, None)
            save_state(state)


def handle_callback(cq):
    data = cq.get("data", "")
    action, _, rest = data.partition(":")
    tgtoken = cq["_token"]
    if (cq.get("from") or {}).get("id") not in ALLOWED_USER_IDS:
        print("telegram-bridge: refused a button tap from a Telegram user who is not allowed", flush=True)
        tg(tgtoken, "answerCallbackQuery", callback_query_id=cq.get("id"), text="Not allowed")
        return
    if action in ("approve", "reject") and rest:
        ok = cli("approval", "approve" if action == "approve" else "reject", rest) is not None
        label = "Approved ✅" if action == "approve" else "Rejected ❌"
    elif action in ("iaccept", "ireject") and rest.count(":") == 1:
        issue_id, _, interaction_id = rest.partition(":")
        ok = cli(
            "issue", "interaction:accept" if action == "iaccept" else "interaction:reject",
            issue_id, interaction_id,
        ) is not None
        label = "Approved ✅" if action == "iaccept" else "Declined ❌"
    else:
        tg(tgtoken, "answerCallbackQuery", callback_query_id=cq.get("id"))
        return
    tg(tgtoken, "answerCallbackQuery", callback_query_id=cq.get("id"),
       text=label if ok else "Failed — use the dashboard")
    msg = cq.get("message") or {}
    if ok and msg.get("message_id"):
        base = (msg.get("text") or "").split("\n")[0]
        tg(tgtoken, "editMessageText", chat_id=(msg.get("chat") or {}).get("id"),
           message_id=msg["message_id"], text=f"{base}\n\n*{label}* via Telegram", parse_mode="Markdown")


def handle_message(state, bot, m):
    chat_id = (m.get("chat") or {}).get("id")
    text = (m.get("text") or "").strip()
    if chat_id is None:
        return
    # Anyone can find a bot and write to it. A stranger gets no reply, so the
    # bot does not even confirm it is alive, and is never added to its chats.
    if (m.get("chat") or {}).get("type") != "private" or (m.get("from") or {}).get("id") not in ALLOWED_USER_IDS:
        print(f"telegram-bridge: ignored a message to {bot['name']} from a Telegram user or chat that is not allowed", flush=True)
        return
    register_chat(state, bot["token"], chat_id)
    token, agent_id, agent_name = bot["token"], bot["agentId"], bot["name"]
    company_id = bot["companyId"]
    low = text.lower()
    if low in ("/start", "/help"):
        tg(token, "sendMessage", chat_id=chat_id, parse_mode="Markdown", text=(
            f"*Connected — you're talking to {agent_name}.*\n"
            "I'll send approvals here; tap ✅/❌ to act.\n\n"
            f"• Any message → {agent_name} answers here. A quick question gets a quick answer "
            f"when quick answers are switched on for {agent_name}; anything bigger becomes a task, "
            "and its answer comes back here when it's done\n"
            "• `/task <text>` → always make it a task\n"
            "• `/new` → start a fresh conversation\n"
            "• `/project <name>` → a project\n"
            "• `/status` → what's happening now"))
        return
    if low == "/new":
        set_conversation(state, token, chat_id, None)
        send_plain(token, chat_id, f"🆕 Fresh start. {agent_name} won't remember the earlier conversation.")
        return
    if low == "/status":
        runs = cli("run", "live", "-C", company_id) or []
        appr = cli("approval", "list", "-C", company_id) or []
        pending = [a for a in appr if a.get("status") in ("pending", "revision_requested")]
        lines = [f"*Now:* {len(runs)} running · {len(pending)} awaiting you"]
        for r in runs[:6]:
            lines.append(f"• {r.get('agentName')} — {r.get('status')}")
        tg(token, "sendMessage", chat_id=chat_id, text="\n".join(lines), parse_mode="Markdown")
        return
    if low.startswith("/project "):
        name = text[len("/project "):].strip()
        res = cli_env({"NM": name}, "project", "create", "-C", company_id, "--name", '"$NM"')
        tg(token, "sendMessage", chat_id=chat_id, parse_mode="Markdown",
           text=(f"📁 Created project *{name}*" if res else "Couldn't create the project."))
        return
    force_task = low.startswith("/task ")
    body = text[len("/task "):].strip() if force_task else text
    if not body:
        return
    # The chat router decides between a quick answer and a task, exactly as
    # for the web chat. Nothing in the text can approve or reject anything:
    # it is only ever sent to the agent as a message.
    ask_agent(state, bot, chat_id, body, force_task=force_task)


def bot_thread(state, bot):
    print(f"telegram-bridge: bot for {bot['name']} ({bot['companyId'][:8]}) started", flush=True)
    while True:
        bs = bots_state(state, bot["token"])
        updates = tg(bot["token"], "getUpdates", http_timeout=40, offset=bs["offset"] + 1, timeout=25) or []
        for u in updates:
            with LOCK:
                bs2 = state["bots"].setdefault(bot["token"], {"offset": 0, "chats": []})
                bs2["offset"] = max(bs2["offset"], u.get("update_id", 0))
                save_state(state)
            try:
                if "callback_query" in u:
                    cq = u["callback_query"]; cq["_token"] = bot["token"]
                    handle_callback(cq)
                elif "message" in u:
                    handle_message(state, bot, u["message"])
            except Exception as e:
                print(f"update error ({bot['name']}): {e}", flush=True)


def main():
    bots = load_bots()
    if not bots:
        print("telegram-bridge: no bots configured", flush=True)
        return
    state = load_state()
    global ALLOWED_USER_IDS
    ALLOWED_USER_IDS, source = resolve_allowed_user_ids(state, os.environ.get("TELEGRAM_ALLOWED_USER_IDS", ""))
    if ALLOWED_USER_IDS:
        print(f"telegram-bridge: {len(ALLOWED_USER_IDS)} Telegram user(s) allowed ({source})", flush=True)
    else:
        print("telegram-bridge: nobody is allowed to use the bots; set TELEGRAM_ALLOWED_USER_IDS", flush=True)
    for b in bots:
        threading.Thread(target=bot_thread, args=(state, b), daemon=True).start()
    companies = len({b["companyId"] for b in bots})
    print(f"telegram-bridge: {len(bots)} bot(s) across {companies} companies up", flush=True)
    while True:
        try:
            notify_task_answers(state, bots)
        except Exception as e:
            print(f"task-answer-notify error: {e}", flush=True)
        try:
            notify_approvals(state, bots)
        except Exception as e:
            print(f"notify error: {e}", flush=True)
        try:
            notify_interactions(state, bots)
        except Exception as e:
            print(f"interaction-notify error: {e}", flush=True)
        try:
            notify_waiting(state, bots)
        except Exception as e:
            print(f"waiting-notify error: {e}", flush=True)
        try:
            notify_stalled_agents(state, bots)
        except Exception as e:
            print(f"stalled-agent-notify error: {e}", flush=True)
        time.sleep(12)


if __name__ == "__main__":
    main()
