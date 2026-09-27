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
  carry a secret value). When nobody asked (a card the board filed itself) or
  nobody on the way up has a bot, it goes to the company's notice bot — see
  company_notice_bot for how that one is chosen.
- Inbound (per bot): Approve/Reject taps resolve the approval. A text message
  goes through the same chat router the web chat uses (DUR-3978): a quick
  question is answered in the same chat when that bot's agent has quick answers
  switched on, and the chat keeps one conversation so follow-ups have context
  (`/new` starts over). A picture the quick answer made (Media Studio) is
  uploaded into the chat as a photo: the bridge fetches its bytes from
  Paperclip (`chat image`), so Telegram never gets a Paperclip address.
  Anything else becomes a task for that bot's agent in
  that bot's company, and the agent's answer is posted back into the chat the
  task came from once it is done or waiting.

Config (DUR-3978 slice 2): the bots come from Paperclip itself — the operator
connects them in company settings, and this service reads them through the
same `docker exec` CLI path it already uses for everything else
(`telegram bridge-config`). Bots appear and disappear without a restart.

The old file, /root/paperclip/.telegram-agents.json =
  [{"agentId","name","token","companyId"?,"uiBase"?}, ...]  (root-only)
still works, as a fallback: when Paperclip does not answer, the file's bots
keep running, and a bot that only exists in the file (nobody has moved it into
the app yet) keeps running alongside the ones that do. Paperclip wins where
both describe the same agent.
`companyId` scopes the bot to a company (defaults to PAPERCLIP_COMPANY_ID).
`uiBase` is the deep-link base for that company (defaults to PAPERCLIP_UI_HOST).
"""
import json
import os
import re
import subprocess
import threading
import base64
import time
import urllib.parse
import urllib.request
import uuid
from collections import defaultdict

DEFAULT_COMPANY_ID = os.environ.get("PAPERCLIP_COMPANY_ID", "7600f03c-c836-4326-8d48-c801813c3a87")
CONTAINER = os.environ.get("PAPERCLIP_CONTAINER", "docker-server-1")
API_BASE = os.environ.get("PAPERCLIP_API_BASE", "http://127.0.0.1:3100")
DATA_DIR = os.environ.get("PAPERCLIP_CLI_DATA_DIR", "/paperclip/cli-state")
UI_HOST = os.environ.get("PAPERCLIP_UI_HOST", "https://paperclip-prod.tailc4d456.ts.net")
CONFIG_FILE = os.environ.get("TELEGRAM_AGENTS_FILE", "/root/paperclip/.telegram-agents.json")
STATE_FILE = os.environ.get("TELEGRAM_STATE_FILE", "/root/paperclip/.telegram-state.json")
CLI = "cd /app && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts"
CHAT_SEND_TIMEOUT_SECONDS = 200
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
# The quick-answer model is set up wrong (wrong model name or address, a key
# the service refuses, no key): handing the message over as a full task would
# only hide the mistake and cost a Claude run, so say what is wrong instead.
QUICK_SETUP_ERROR_CODES = ("LANE_A_SETUP_REFUSED", "LANE_A_KEY_REFUSED", "LANE_A_KEY_MISSING", "LANE_A_KEY_UNRESOLVED")
ANSWER_FINISHED_STATUSES = ("done", "cancelled")
ANSWER_WAITING_STATUSES = ("in_review", "blocked")
# A task that has not finished after this long stops being watched.
TASK_ANSWER_MAX_AGE_SECONDS = 30 * 24 * 3600
TASK_ANSWERS_PER_CALL = 50  # the server's limit per call
# Pictures a quick answer carried (Media Studio's "Generate image"): at most
# this many are sent per answer, each as an upload of the bytes the bridge
# fetched from Paperclip (the Paperclip address is private, so Telegram never
# gets it). Telegram's photo limit is 10 MB; bigger ones and SVGs go as files.
QUICK_ANSWER_MAX_IMAGES = 4
TG_PHOTO_MAX_BYTES = 10 * 1024 * 1024
TG_PHOTO_TYPES = ("image/jpeg", "image/png", "image/webp", "image/gif")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

LOCK = threading.Lock()

# Telegram user ids allowed to use the bots; set in main(). Empty means nobody.
ALLOWED_USER_IDS = set()

# The bots that should be running right now, keyed by token. Replaced wholesale
# on every refresh, so a bot removed in Paperclip disappears from here and its
# thread stops on its next pass (DUR-3978 slice 2).
CURRENT_BOTS = {}
BOT_THREADS = {}


def _normalized_user_ids(raw):
    """Telegram user ids as ints. Anything that is not a plain id is dropped —
    a damaged entry must never become a wildcard."""
    ids = set()
    for value in raw or []:
        text = str(value).strip()
        if text.isdigit():
            ids.add(int(text))
    return ids


def fetch_bots_from_api():
    """The bots the operator has connected in Paperclip, or None.

    None means "Paperclip did not answer" — NOT "there are no bots". The
    difference matters: on None the caller keeps serving whatever it already
    had, so an API that is down, restarting, or refusing this operator can
    never take a running bot off the air. An empty list, by contrast, is a real
    answer and is treated as one.
    """
    data = cli("telegram", "bridge-config")
    if not isinstance(data, dict) or not isinstance(data.get("bots"), list):
        return None
    bots = []
    for b in data["bots"]:
        if not isinstance(b, dict):
            continue
        token = str(b.get("token") or "").strip()
        agent_id = b.get("agentId")
        if not token or not agent_id:
            continue
        bots.append({
            "agentId": agent_id,
            "name": b.get("name") or "Paperclip",
            "token": token,
            "companyId": b.get("companyId") or DEFAULT_COMPANY_ID,
            "uiBase": b.get("uiBase") or UI_HOST,
            "allowedUserIds": _normalized_user_ids(b.get("allowedUserIds")),
            # How company_notice_bot picks the company's notice bot.
            "receivesCompanyNotices": b.get("receivesCompanyNotices") is True,
            "createdAt": b.get("createdAt") if isinstance(b.get("createdAt"), str) else None,
            "agentRole": b.get("agentRole") if isinstance(b.get("agentRole"), str) else None,
            "source": "paperclip",
        })
    return bots


def load_file_bots():
    """The bots in the old root-only file. Missing or damaged file = no bots."""
    try:
        with open(CONFIG_FILE) as f:
            text = f.read().strip()
    except FileNotFoundError:
        return []
    except Exception as e:
        print(f"telegram-bridge: could not read the bot file ({type(e).__name__})", flush=True)
        return []
    # An empty file is the ordinary state once every bot has been moved into
    # Paperclip, so it is not worth a line of log every twelve seconds.
    if not text:
        return []
    try:
        raw = json.loads(text)
    except Exception as e:
        print(f"telegram-bridge: could not read the bot file ({type(e).__name__})", flush=True)
        return []
    bots = []
    for index, b in enumerate(raw if isinstance(raw, list) else []):
        token = str(b.get("token") or "").strip()
        if not token or not b.get("agentId"):
            continue
        bots.append({
            "agentId": b["agentId"],
            "name": b.get("name") or "Paperclip",
            "token": token,
            "companyId": b.get("companyId") or DEFAULT_COMPANY_ID,
            "uiBase": b.get("uiBase") or UI_HOST,
            # The file has never carried a per-bot allowlist; those bots keep
            # using the instance-wide list, exactly as before.
            "allowedUserIds": set(),
            # A file bot cannot be marked as the company's notice bot, and it
            # counts as older than any bot connected in the app; among file
            # bots, the one listed first is the oldest.
            "fileIndex": index,
            "source": "file",
        })
    return bots


def merge_bots(api_bots, file_bots):
    """Paperclip wins; the file covers agents Paperclip has no bot for.

    So: removing a bot in the app stops it (it was never in the file), and an
    old file-only bot keeps working until somebody moves it into the app.
    """
    if api_bots is None:
        return file_bots
    known = {(b["companyId"], b["agentId"]) for b in api_bots}
    return api_bots + [b for b in file_bots if (b["companyId"], b["agentId"]) not in known]


# The last answer Paperclip gave about its bots. When Paperclip does not answer
# (restarting for a deploy), the bridge keeps serving these instead of
# dropping them: dropping and re-adding a bot while its old thread was still
# waiting on Telegram left two threads for one bot, and every message was
# answered twice (27 Sep).
LAST_API_BOTS = None


def load_bots():
    """Every bot that should be running right now."""
    global LAST_API_BOTS
    api_bots = fetch_bots_from_api()
    if api_bots is None:
        api_bots = LAST_API_BOTS
    else:
        LAST_API_BOTS = api_bots
    return merge_bots(api_bots, load_file_bots())


def allowed_users_for(bot):
    """Who may use THIS bot.

    A bot configured in the app carries its own list, and that list is the
    whole answer for that bot. A bot with an empty list — a newly connected one
    the operator has not filled in yet, or an old file bot — falls back to the
    instance-wide list that was the only rule before this existed. Never wider
    than one of those two, and never "everybody": with neither set, nobody.
    """
    return set(bot.get("allowedUserIds") or ()) or ALLOWED_USER_IDS


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


def cli_env(env, *parts, timeout=90):
    args = ["docker", "exec"]
    for k, v in env.items():
        args += ["-e", f"{k}={v}"]
    args += [CONTAINER, "sh", "-lc", f"{CLI} {' '.join(parts)} {ARGS}"]
    try:
        return json.loads(subprocess.check_output(args, stderr=subprocess.DEVNULL, timeout=timeout).decode())
    except Exception as e:
        print(f"cli_env error ({parts[0] if parts else '?'}): {e}", flush=True)
        return None


# Paperclip restarts on every deploy (about a minute). A message that arrives
# then used to fail at once with "I didn't hear back from Paperclip". Now the
# bridge checks Paperclip is up BEFORE sending, waits for it if it is
# restarting, and after a failure says plainly when a restart was the cause.
# It never re-sends on its own after sending, because Paperclip may already
# have acted on the message.
HEALTH_URL = os.environ.get("PAPERCLIP_HEALTH_URL", "http://127.0.0.1:3100/api/health")
RESTART_WAIT_SECONDS = int(os.environ.get("PAPERCLIP_RESTART_WAIT_SECONDS", "150"))
RESTART_POLL_SECONDS = 5


def container_started_at():
    """When the Paperclip container last started, or None if it is not running."""
    try:
        out = subprocess.check_output(
            ["docker", "inspect", "-f", "{{.State.Running}} {{.State.StartedAt}}", CONTAINER],
            stderr=subprocess.DEVNULL, timeout=10).decode().split()
    except Exception:
        return None
    if len(out) != 2 or out[0] != "true":
        return None
    return out[1]


def paperclip_ready():
    """True when the container runs and Paperclip answers its health check."""
    if container_started_at() is None:
        return False
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=5) as r:
            return r.status == 200 and json.load(r).get("status") == "ok"
    except Exception:
        return False


def wait_for_paperclip(sleep=time.sleep, now=time.monotonic):
    """Wait up to RESTART_WAIT_SECONDS for Paperclip to come back. True if it did."""
    deadline = now() + RESTART_WAIT_SECONDS
    while now() < deadline:
        sleep(RESTART_POLL_SECONDS)
        if paperclip_ready():
            return True
    return False


def fetch_org(company_id):
    """Return (reports_to, names, roles) maps from a company's live org."""
    data = cli("agent", "list", "-C", company_id) or []
    reports_to, names, roles = {}, {}, {}
    for a in data:
        reports_to[a["id"]] = a.get("reportsTo")
        names[a["id"]] = a.get("name")
        roles[a["id"]] = a.get("role")
    return reports_to, names, roles


def resolve_bot(agent_id, bots_by_agent, reports_to, default_bot):
    """Walk up the org from agent_id to the nearest bot-enabled agent (same company)."""
    seen, cur = set(), agent_id
    while cur and cur not in seen:
        seen.add(cur)
        if cur in bots_by_agent:
            return bots_by_agent[cur], cur != agent_id
        cur = reports_to.get(cur)
    return default_bot, True  # fallback: the company's notice bot


def _bot_age_key(bot):
    """Oldest first: every file bot before any app bot (the file is where bots
    lived before the app had them), file bots in the order the file lists them,
    app bots by when they were connected (one without a date after those with
    one). The agent id settles any remaining tie, so the answer never depends
    on the order the bots happen to arrive in."""
    if bot.get("source") == "file":
        return (0, 0, "", bot.get("fileIndex", 0), str(bot.get("agentId")))
    created = bot.get("createdAt") or ""
    return (1, 0 if created else 1, created, 0, str(bot.get("agentId")))


def _bot_agent_role(bot, roles):
    role = bot.get("agentRole") or (roles or {}).get(bot.get("agentId"))
    return str(role).strip().lower() if role else None


def company_notice_bot(cbots, roles=None):
    """The bot that gets a company's approvals, questions and waiting/stalled
    notices when no agent's own bot (or its boss's) should: a card the board
    filed itself, or an agent with no bot anywhere above it.

    1. the bot the operator marked in the app ("Sends this company's approvals
       and questions");
    2. else the bot whose agent is the CEO (app or file);
    3. else the oldest bot (see _bot_age_key).

    Never "the first bot in the list": on 27 Sep a newly connected assistant
    with no boss tied with the CEO for "closest to the top of the org", came
    first in the list, and started receiving the company's deploy cards.
    """
    return choose_company_notice_bot(cbots, roles)[0]


def choose_company_notice_bot(cbots, roles=None):
    """company_notice_bot, plus a few plain words on why it was chosen."""
    if not cbots:
        return None, None
    marked = [b for b in cbots if b.get("source") == "paperclip" and b.get("receivesCompanyNotices") is True]
    if marked:
        return min(marked, key=_bot_age_key), "chosen in Paperclip"
    ceo = [b for b in cbots if _bot_agent_role(b, roles) == "ceo"]
    if ceo:
        return min(ceo, key=_bot_age_key), "the CEO's bot"
    return min(cbots, key=_bot_age_key), "the oldest bot; none is chosen in Paperclip and no CEO has a bot"


# The last notice bot logged per company, so the log says it once at start and
# again only when it changes — the line to look for after a restart.
LAST_NOTICE_BOT = {}


def log_company_notice_bot(company_id, cbots, roles):
    bot, why = choose_company_notice_bot(cbots, roles)
    if bot is None:
        return
    key = (bot.get("agentId"), why)
    if LAST_NOTICE_BOT.get(company_id) == key:
        return
    LAST_NOTICE_BOT[company_id] = key
    print(f"telegram-bridge: company {str(company_id)[:8]}: approvals and questions with no bot of their own "
          f"go to {bot.get('name')} ({why})", flush=True)


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
        reports_to, names, roles = fetch_org(company_id)
        bots_by_agent = {b["agentId"]: b for b in cbots}
        # Where a card goes when no agent's own bot (or its boss's) should.
        default_bot = company_notice_bot(cbots, roles)
        log_company_notice_bot(company_id, cbots, roles)
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
            for chat in deliverable_chats(state, bot["token"], allowed_users_for(bot)):
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
        reports_to, names, roles = fetch_org(company_id)
        bots_by_agent = {b["agentId"]: b for b in cbots}
        default_bot = company_notice_bot(cbots, roles)
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
            for chat in deliverable_chats(state, bot["token"], allowed_users_for(bot)):
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
        reports_to, names, roles = fetch_org(company_id)
        bots_by_agent = {b["agentId"]: b for b in cbots}
        default_bot = company_notice_bot(cbots, roles)
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
            for chat in deliverable_chats(state, bot["token"], allowed_users_for(bot)):
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
        reports_to, names, roles = fetch_org(company_id)
        bots_by_agent = {b["agentId"]: b for b in cbots}
        default_bot = company_notice_bot(cbots, roles)
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
            for chat in deliverable_chats(state, bot["token"], allowed_users_for(bot)):
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


def deliverable_chats(state, token, allowed=None):
    """The chats a bot may send cards to: allowed people's private chats only.

    `allowed` is this bot's own list when it has one (see allowed_users_for).
    With nothing given it falls back to the instance-wide list, which is what
    every caller did before per-bot lists existed.
    """
    permitted = ALLOWED_USER_IDS if allowed is None else allowed
    return [chat for chat in bots_state(state, token)["chats"] if chat in permitted]


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


def tg_upload(token, method, field, filename, content_type, data, http_timeout=60, **params):
    """A Telegram call that uploads one file (multipart/form-data), e.g.
    sendPhoto. Same result shape as tg(): the result, or None on failure."""
    boundary = "paperclip-" + uuid.uuid4().hex
    body = bytearray()
    for key, value in params.items():
        if value is None:
            continue
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n"
                 f"{value}\r\n").encode()
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", filename) or "picture"
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{safe_name}\"\r\n"
             f"Content-Type: {content_type}\r\n\r\n").encode()
    body += data
    body += f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}", data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(request, timeout=http_timeout) as r:
            return json.load(r).get("result")
    except Exception as e:
        print(f"tg {method} error: {e}", flush=True)
        return None


def reply_images(result):
    """The pictures a quick answer carried, from its actions: file id, type and
    seed. Only well-formed file ids; the server already checked each one is a
    picture in this bot's company."""
    images = []
    for action in (result or {}).get("actions") or []:
        image = action.get("image") if isinstance(action, dict) else None
        if not isinstance(image, dict):
            continue
        file_id = image.get("fileId")
        if not isinstance(file_id, str) or not UUID_RE.match(file_id):
            continue
        if any(i["fileId"] == file_id for i in images):
            continue
        seed = image.get("seed")
        images.append({
            "fileId": file_id,
            "seed": seed if isinstance(seed, int) and not isinstance(seed, bool) else None,
            "hasTask": bool(image.get("issueId")),
        })
    return images[:QUICK_ANSWER_MAX_IMAGES]


def image_caption(image):
    where = "Attached to its task in Paperclip." if image["hasTask"] else "Saved in Paperclip's Files."
    return f"{where} Seed {image['seed']}." if image["seed"] is not None else where


def send_reply_images(bot, chat_id, images):
    """Upload each picture into the chat. The bytes come from Paperclip through
    the CLI, with the bridge's own sign-in and the bot's own company; a picture
    that cannot be fetched or sent gets one plain line instead of silence."""
    token = bot["token"]
    for image in images:
        data = cli("chat", "image", image["fileId"], "-C", bot["companyId"])
        payload = None
        content_type = ""
        if isinstance(data, dict) and data.get("ok") is True and isinstance(data.get("contentBase64"), str):
            try:
                payload = base64.b64decode(data["contentBase64"], validate=True)
            except Exception:
                payload = None
            content_type = str(data.get("contentType") or "").lower()
        if not payload or not content_type.startswith("image/"):
            send_plain(token, chat_id, "I made a picture but could not send it here. It is in Paperclip's Files.")
            continue
        extension = content_type.split("/", 1)[1].split("+", 1)[0] or "img"
        filename = f"picture-{image['fileId'][:8]}.{extension}"
        caption = image_caption(image)
        sent = None
        if content_type in TG_PHOTO_TYPES and len(payload) <= TG_PHOTO_MAX_BYTES:
            sent = tg_upload(token, "sendPhoto", "photo", filename, content_type, payload,
                             chat_id=chat_id, caption=caption)
        if sent is None:
            # Not a type Telegram shows as a photo (an SVG), too big, or the
            # photo upload was refused: send it as a file instead.
            sent = tg_upload(token, "sendDocument", "document", filename, content_type, payload,
                             chat_id=chat_id, caption=caption)
        if sent is None:
            send_plain(token, chat_id, "I made a picture but could not send it here. It is in Paperclip's Files.")


def chat_send(bot, text, conversation_id=None, lane=None):
    """One message through the chat router. The agent and the company are always
    the bot's own from its config; the message only ever travels as data in an
    environment variable, never as part of the command."""
    parts = ["chat", "send", bot["agentId"], "-C", bot["companyId"], "--message", '"$TT"']
    if conversation_id and UUID_RE.match(conversation_id):
        parts += ["--conversation-id", conversation_id]
    if lane in ("a", "b"):
        parts += ["--lane", lane]
    # A quick answer can include making a picture, which may take up to about
    # two minutes, so wait longer than for other commands.
    return cli_env({"TT": text}, *parts, timeout=CHAT_SEND_TIMEOUT_SECONDS)


def _refused(res):
    return isinstance(res, dict) and res.get("ok") is False


def ask_agent(state, bot, chat_id, text, force_task=False):
    """Send a chat message to the bot's agent and reply in the same chat."""
    token, agent_name = bot["token"], bot["name"]
    tg(token, "sendChatAction", chat_id=chat_id, action="typing")
    conversation_id = None if force_task else get_conversation(state, token, chat_id)
    notes = []
    if not paperclip_ready():
        send_plain(token, chat_id, (
            f"Paperclip is restarting. I'll pass this on to {agent_name} as soon as it's back, "
            "usually within a minute."))
        if not wait_for_paperclip():
            send_plain(token, chat_id, (
                f"Paperclip is still not back, so {agent_name} did not get your message. "
                "Please send it again in a few minutes."))
            return
        tg(token, "sendChatAction", chat_id=chat_id, action="typing")
    started_before = container_started_at()
    res = chat_send(bot, text, conversation_id, "b" if force_task else None)
    if _refused(res) and conversation_id and res.get("code") in CONVERSATION_ENDED_CODES:
        set_conversation(state, token, chat_id, None)
        notes.append("(The earlier conversation had ended, so this starts a fresh one.)")
        res = chat_send(bot, text)
    if _refused(res) and not force_task and res.get("code") in QUICK_SETUP_ERROR_CODES:
        reason = str(res.get("error") or "").strip()[:400]
        send_plain(token, chat_id, (
            f"{agent_name}'s quick answers are set up wrong, so nothing was sent and no task was made. "
            + (f"{reason} " if reason else "")
            + f"Fix it on {agent_name}'s page in Paperclip, then send your message again."))
        return
    if _refused(res) and not force_task and res.get("status") in QUICK_UNAVAILABLE_STATUSES:
        notes.append("Quick answers aren't available right now, so I've handed this over as a task.")
        res = chat_send(bot, text, lane="b")

    if res is None and started_before is not None and container_started_at() != started_before:
        # Paperclip restarted while it was answering: the answer is lost, and
        # it may have started on the request, so ask rather than re-send.
        send_plain(token, chat_id, (
            f"Paperclip restarted while {agent_name} was working on that, so the answer was lost. "
            "Please send it again. If it asked for a task or a picture, check Paperclip first so it isn't done twice."))
        return
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
        images = reply_images(result)
        answer = str(result.get("response") or "").strip() or (
            "" if images else f"{agent_name} had nothing to add.")
        if notes or answer:
            send_plain(token, chat_id, "\n\n".join(notes + ([answer] if answer else [])))
        if images:
            send_reply_images(bot, chat_id, images)
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
            if chat not in allowed_users_for(bot):
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
    # This bot's own list when the caller supplied one, otherwise the
    # instance-wide list — same rule as before for a bot that has no list.
    if (cq.get("from") or {}).get("id") not in (cq.get("_allowed") or ALLOWED_USER_IDS):
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
    if (m.get("chat") or {}).get("type") != "private" or (m.get("from") or {}).get("id") not in allowed_users_for(bot):
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


def current_bot(token):
    """This bot as it is configured right now, or None once it is gone."""
    with LOCK:
        return CURRENT_BOTS.get(token)


def _is_registered_thread(token):
    """True when the running thread is the one refresh_bots registered for this bot."""
    with LOCK:
        return BOT_THREADS.get(token) is threading.current_thread()


def bot_thread(state, token):
    started = current_bot(token)
    if started:
        print(f"telegram-bridge: bot for {started['name']} ({started['companyId'][:8]}) started", flush=True)
    while True:
        # Re-read the bot every pass instead of closing over the dict this
        # thread started with: that is what lets a changed allowlist, a
        # renamed bot or a removal take effect without a restart.
        bot = current_bot(token)
        if bot is None:
            print("telegram-bridge: a bot is no longer configured and has stopped answering", flush=True)
            return
        if not _is_registered_thread(token):
            # A newer thread serves this bot now; two would answer every
            # message twice.
            return
        bs = bots_state(state, token)
        updates = tg(token, "getUpdates", http_timeout=40, offset=bs["offset"] + 1, timeout=25) or []
        if updates and not _is_registered_thread(token):
            return
        handle_updates(state, token, bot, updates)


def handle_updates(state, token, bot, updates):
    """Handle one batch of Telegram updates for a bot, each at most once.

    The offset is advanced under the lock before an update is handled, and an
    update at or below the saved offset is skipped, so even two threads that
    fetched the same batch cannot both answer it.
    """
    for u in updates:
        update_id = u.get("update_id", 0)
        with LOCK:
            bs2 = state["bots"].setdefault(token, {"offset": 0, "chats": []})
            if update_id <= bs2["offset"]:
                # Already handled (by this or another thread): never twice.
                continue
            bs2["offset"] = update_id
            save_state(state)
        try:
            if "callback_query" in u:
                cq = u["callback_query"]
                cq["_token"] = token
                cq["_allowed"] = allowed_users_for(bot)
                handle_callback(cq)
            elif "message" in u:
                handle_message(state, bot, u["message"])
        except Exception as e:
            print(f"update error ({bot['name']}): {e}", flush=True)


def refresh_bots(state):
    """Re-read the configuration and make the running threads match it.

    Returns the bots that should be served right now. A newly connected bot
    gets a thread here, without a restart; a removed one is dropped from
    CURRENT_BOTS, which is what makes its thread stop on its next pass.
    """
    bots = load_bots()
    tokens = {b["token"] for b in bots}
    with LOCK:
        CURRENT_BOTS.clear()
        for b in bots:
            CURRENT_BOTS[b["token"]] = b
    for token in list(BOT_THREADS):
        if token not in tokens:
            BOT_THREADS.pop(token, None)
    for b in bots:
        with LOCK:
            thread = BOT_THREADS.get(b["token"])
            if thread is not None and thread.is_alive():
                continue
            thread = threading.Thread(target=bot_thread, args=(state, b["token"]), daemon=True)
            BOT_THREADS[b["token"]] = thread
        thread.start()
    return bots


def main():
    state = load_state()
    global ALLOWED_USER_IDS
    ALLOWED_USER_IDS, source = resolve_allowed_user_ids(state, os.environ.get("TELEGRAM_ALLOWED_USER_IDS", ""))
    if ALLOWED_USER_IDS:
        print(f"telegram-bridge: {len(ALLOWED_USER_IDS)} Telegram user(s) allowed by default ({source})", flush=True)
    else:
        print("telegram-bridge: nobody is allowed to use the bots by default; set TELEGRAM_ALLOWED_USER_IDS "
              "or add people to each bot in Paperclip", flush=True)
    bots = refresh_bots(state)
    if bots:
        companies = len({b["companyId"] for b in bots})
        print(f"telegram-bridge: {len(bots)} bot(s) across {companies} companies up", flush=True)
    else:
        # Not fatal any more: a bot connected in Paperclip a minute from now is
        # picked up by the refresh below, with no restart and nobody on the box.
        print("telegram-bridge: no bots configured yet; waiting for one", flush=True)
    while True:
        try:
            bots = refresh_bots(state)
        except Exception as e:
            print(f"config-refresh error: {e}", flush=True)
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
