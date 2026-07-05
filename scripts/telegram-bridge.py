#!/usr/bin/env python3
"""Telegram bridge for Paperclip — a multi-bot companion service (not a plugin).

Each Telegram-enabled agent has its own bot (its own identity), so you chat with
"the CEO" and "Fork Lead" as separate contacts. Bot-less agents escalate UP the
org chart: their approvals/messages are sent via the nearest boss's bot, tagged
"(on behalf of X)". Purely additive to the dashboard — the same approvals/tasks
still live in Paperclip and the web UI.

- Outbound: a pending approval is routed to its requesting agent's bot (or the
  nearest boss's bot up `reportsTo`), with Approve/Reject buttons.
- Inbound (per bot): Approve/Reject taps resolve the approval; a text message
  creates a task for that bot's agent ("/task", "/project", "/status", or plain
  text). Runs even on a tailnet-only instance (long-polls Telegram over the net).

Config: /root/paperclip/.telegram-agents.json = [{"agentId","name","token"}, ...]
(root-only). Paperclip is reached via the admin CLI in the server container.
"""
import json
import os
import subprocess
import threading
import time
import urllib.parse
import urllib.request

COMPANY_ID = os.environ.get("PAPERCLIP_COMPANY_ID", "7600f03c-c836-4326-8d48-c801813c3a87")
CONTAINER = os.environ.get("PAPERCLIP_CONTAINER", "docker-server-1")
API_BASE = os.environ.get("PAPERCLIP_API_BASE", "http://127.0.0.1:3100")
DATA_DIR = os.environ.get("PAPERCLIP_CLI_DATA_DIR", "/paperclip/cli-state")
UI_BASE = os.environ.get("PAPERCLIP_UI_BASE", "https://paperclip-prod.tailc4d456.ts.net/DUR")
CONFIG_FILE = os.environ.get("TELEGRAM_AGENTS_FILE", "/root/paperclip/.telegram-agents.json")
STATE_FILE = os.environ.get("TELEGRAM_STATE_FILE", "/root/paperclip/.telegram-state.json")
CLI = "cd /app && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts"
ARGS = f"--api-base {API_BASE} --data-dir {DATA_DIR} --json"

LOCK = threading.Lock()


def load_bots():
    with open(CONFIG_FILE) as f:
        bots = json.load(f)
    for b in bots:
        b["token"] = b["token"].strip()
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


def fetch_org():
    """Return (reports_to, names) maps from the live org."""
    data = cli("agent", "list", "-C", COMPANY_ID) or []
    reports_to, names = {}, {}
    for a in data:
        reports_to[a["id"]] = a.get("reportsTo")
        names[a["id"]] = a.get("name")
    return reports_to, names


def resolve_bot(agent_id, bots_by_agent, reports_to, default_bot):
    """Walk up the org from agent_id to the nearest bot-enabled agent."""
    seen, cur = set(), agent_id
    while cur and cur not in seen:
        seen.add(cur)
        if cur in bots_by_agent:
            return bots_by_agent[cur], cur != agent_id
        cur = reports_to.get(cur)
    return default_bot, True  # fallback: everyone reaches the top bot (CEO)


def approval_title(a):
    p = a.get("payload") or {}
    subject = p.get("title") or p.get("name") or p.get("summary")
    if a.get("type") == "credential_request":
        return f"🔑 Credential request: {p.get('name') or p.get('envKey') or 'credential'}"
    if str(p.get("kind")) == "deploy":
        return f"🚀 Deploy request: {subject or 'to production'}"
    if a.get("type") == "hire_agent":
        return f"🧑‍💼 Hire agent: {subject or ''}".strip()
    return f"🔔 Approval: {subject or a.get('type')}"


def notify_approvals(state, bots, bots_by_agent):
    data = cli("approval", "list", "-C", COMPANY_ID)
    if data is None:
        return
    items = data if isinstance(data, list) else data.get("approvals", [])
    reports_to, names = fetch_org()
    default_bot = bots[0]
    with LOCK:
        notified = set(state["notified"])
    for a in items:
        if a.get("status") not in ("pending", "revision_requested"):
            continue
        aid = a.get("id")
        if aid in notified:
            continue
        requester = a.get("requestedByAgentId")
        bot, escalated = resolve_bot(requester, bots_by_agent, reports_to, default_bot)
        p = a.get("payload") or {}
        detail = p.get("note") or p.get("summary") or p.get("description") or ""
        text = f"*{approval_title(a)}*"
        if detail:
            text += f"\n{detail[:300]}"
        if escalated and requester:
            text += f"\n_(on behalf of {names.get(requester, 'a teammate')})_"
        text += f"\n\n[Open in Paperclip]({UI_BASE}/approvals/{aid})"
        kb = {"inline_keyboard": [[
            {"text": "✅ Approve", "callback_data": f"approve:{aid}"},
            {"text": "❌ Reject", "callback_data": f"reject:{aid}"},
        ]]}
        for chat in bots_state(state, bot["token"])["chats"]:
            tg(bot["token"], "sendMessage", chat_id=chat, text=text, parse_mode="Markdown",
               reply_markup=kb, disable_web_page_preview=True)
        notified.add(aid)
    with LOCK:
        state["notified"] = list(notified)[-800:]
        save_state(state)


def bots_state(state, token):
    with LOCK:
        return state["bots"].setdefault(token, {"offset": 0, "chats": []})


def register_chat(state, token, chat_id):
    with LOCK:
        bs = state["bots"].setdefault(token, {"offset": 0, "chats": []})
        if chat_id not in bs["chats"]:
            bs["chats"].append(chat_id)
            save_state(state)


def handle_callback(cq):
    action, _, aid = cq.get("data", "").partition(":")
    tgtoken = cq["_token"]
    if action not in ("approve", "reject") or not aid:
        tg(tgtoken, "answerCallbackQuery", callback_query_id=cq.get("id"))
        return
    ok = cli("approval", "approve" if action == "approve" else "reject", aid) is not None
    label = "Approved ✅" if action == "approve" else "Rejected ❌"
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
    register_chat(state, bot["token"], chat_id)
    token, agent_id, agent_name = bot["token"], bot["agentId"], bot["name"]
    low = text.lower()
    if low in ("/start", "/help"):
        tg(token, "sendMessage", chat_id=chat_id, parse_mode="Markdown", text=(
            f"*Connected — you're talking to {agent_name}.*\n"
            "I'll send approvals here; tap ✅/❌ to act.\n\n"
            f"• Any message → a task for {agent_name}\n"
            "• `/project <name>` → a project\n"
            "• `/status` → what's happening now"))
        return
    if low == "/status":
        runs = cli("run", "live", "-C", COMPANY_ID) or []
        appr = cli("approval", "list", "-C", COMPANY_ID) or []
        pending = [a for a in appr if a.get("status") in ("pending", "revision_requested")]
        lines = [f"*Now:* {len(runs)} running · {len(pending)} awaiting you"]
        for r in runs[:6]:
            lines.append(f"• {r.get('agentName')} — {r.get('status')}")
        tg(token, "sendMessage", chat_id=chat_id, text="\n".join(lines), parse_mode="Markdown")
        return
    if low.startswith("/project "):
        name = text[len("/project "):].strip()
        res = cli_env({"NM": name}, "project", "create", "-C", COMPANY_ID, "--name", '"$NM"')
        tg(token, "sendMessage", chat_id=chat_id, parse_mode="Markdown",
           text=(f"📁 Created project *{name}*" if res else "Couldn't create the project."))
        return
    title = text[len("/task "):].strip() if low.startswith("/task ") else text
    if not title:
        return
    # A message to an agent's bot becomes a task assigned to that agent.
    res = cli_env({"TT": title}, "issue", "create", "-C", COMPANY_ID,
                  "--title", '"$TT"', "--assignee-agent-id", agent_id)
    ident = (res or {}).get("identifier", "")
    tg(token, "sendMessage", chat_id=chat_id, parse_mode="Markdown",
       text=(f"✅ Sent to {agent_name} as *{ident}* — {title}" if res else "Couldn't create the task."))


def bot_thread(state, bot):
    print(f"telegram-bridge: bot for {bot['name']} started", flush=True)
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
    bots_by_agent = {b["agentId"]: b for b in bots}
    for b in bots:
        threading.Thread(target=bot_thread, args=(state, b), daemon=True).start()
    print(f"telegram-bridge: {len(bots)} bot(s) up", flush=True)
    while True:
        try:
            notify_approvals(state, bots, bots_by_agent)
        except Exception as e:
            print(f"notify error: {e}", flush=True)
        time.sleep(12)


if __name__ == "__main__":
    main()
