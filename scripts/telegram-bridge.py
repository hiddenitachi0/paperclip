#!/usr/bin/env python3
"""Telegram bridge for Paperclip — a companion service (not a plugin).

Runs on the prod VPS as a systemd service. It is purely ADDITIVE to the
dashboard: the same approvals/tasks still live in Paperclip and on the web UI.
This bridge just mirrors what needs you to Telegram and lets you act from your
phone, in tandem with the dashboard.

- Outbound: new pending approvals -> a Telegram message with Approve/Reject buttons.
- Inbound: Approve/Reject taps resolve the approval; a text message creates a task
  ("/task <title>", "/project <name>", "/status", or plain text -> a task).

Paperclip is reached via the admin CLI inside the server container (loopback OK);
Telegram is reached over the internet via long-polling (so a tailnet-only
instance still works). Config comes from env; state persists to a JSON file.
"""
import json
import os
import subprocess
import time
import urllib.parse
import urllib.request

TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
COMPANY_ID = os.environ.get("PAPERCLIP_COMPANY_ID", "7600f03c-c836-4326-8d48-c801813c3a87")
CONTAINER = os.environ.get("PAPERCLIP_CONTAINER", "docker-server-1")
API_BASE = os.environ.get("PAPERCLIP_API_BASE", "http://127.0.0.1:3100")
DATA_DIR = os.environ.get("PAPERCLIP_CLI_DATA_DIR", "/paperclip/cli-state")
UI_BASE = os.environ.get("PAPERCLIP_UI_BASE", "https://paperclip-prod.tailc4d456.ts.net/DUR")
STATE_FILE = os.environ.get("TELEGRAM_STATE_FILE", "/root/paperclip/.telegram-state.json")
TG = f"https://api.telegram.org/bot{TOKEN}"
CLI = "cd /app && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts"
ARGS = f"--api-base {API_BASE} --data-dir {DATA_DIR} --json"


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {"offset": 0, "chats": [], "notified": []}


def save_state(s):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
    os.replace(tmp, STATE_FILE)


def tg(method, http_timeout=20, **params):
    data = urllib.parse.urlencode(
        {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in params.items()}
    ).encode()
    req = urllib.request.Request(f"{TG}/{method}", data=data)
    try:
        with urllib.request.urlopen(req, timeout=http_timeout) as r:
            return json.load(r).get("result")
    except Exception as e:
        print(f"tg {method} error: {e}", flush=True)
        return None


def cli(*parts):
    """Run a Paperclip CLI command in the container, return parsed JSON (or None)."""
    cmd = f"{CLI} {' '.join(parts)} {ARGS}"
    try:
        out = subprocess.check_output(
            ["docker", "exec", CONTAINER, "sh", "-lc", cmd], stderr=subprocess.DEVNULL, timeout=60
        )
        return json.loads(out.decode())
    except Exception as e:
        print(f"cli error ({parts[0] if parts else '?'}): {e}", flush=True)
        return None


def cli_env(env, *parts):
    """CLI with an env var injected (for passing text bodies safely)."""
    cmd = f"{CLI} {' '.join(parts)} {ARGS}"
    args = ["docker", "exec"]
    for k, v in env.items():
        args += ["-e", f"{k}={v}"]
    args += [CONTAINER, "sh", "-lc", cmd]
    try:
        out = subprocess.check_output(args, stderr=subprocess.DEVNULL, timeout=90)
        return json.loads(out.decode())
    except Exception as e:
        print(f"cli_env error ({parts[0] if parts else '?'}): {e}", flush=True)
        return None


def approval_title(a):
    p = a.get("payload") or {}
    t = a.get("type")
    subject = p.get("title") or p.get("name") or p.get("summary")
    if t == "credential_request":
        return f"🔑 Credential request: {p.get('name') or p.get('envKey') or 'credential'}"
    if str(p.get("kind")) == "deploy":
        return f"🚀 Deploy request: {subject or 'to production'}"
    if t == "hire_agent":
        return f"🧑‍💼 Hire agent: {subject or ''}".strip()
    return f"🔔 Approval: {subject or t}"


def notify_approvals(state):
    data = cli("approval", "list", "-C", COMPANY_ID)
    if data is None:
        return
    items = data if isinstance(data, list) else data.get("approvals", [])
    notified = set(state["notified"])
    changed = False
    for a in items:
        if a.get("status") not in ("pending", "revision_requested"):
            continue
        aid = a.get("id")
        if aid in notified:
            continue
        p = a.get("payload") or {}
        detail = p.get("note") or p.get("summary") or p.get("description") or ""
        text = f"*{approval_title(a)}*"
        if detail:
            text += f"\n{detail[:300]}"
        text += f"\n\n[Open in Paperclip]({UI_BASE}/approvals/{aid})"
        kb = {"inline_keyboard": [[
            {"text": "✅ Approve", "callback_data": f"approve:{aid}"},
            {"text": "❌ Reject", "callback_data": f"reject:{aid}"},
        ]]}
        for chat in state["chats"]:
            tg("sendMessage", chat_id=chat, text=text, parse_mode="Markdown",
               reply_markup=kb, disable_web_page_preview=True)
        notified.add(aid)
        changed = True
    if changed:
        state["notified"] = list(notified)[-500:]
        save_state(state)


def handle_callback(cq, state):
    data = cq.get("data", "")
    cq_id = cq.get("id")
    msg = cq.get("message") or {}
    chat_id = (msg.get("chat") or {}).get("id")
    mid = msg.get("message_id")
    action, _, aid = data.partition(":")
    if action not in ("approve", "reject") or not aid:
        tg("answerCallbackQuery", callback_query_id=cq_id)
        return
    res = cli("approval", "approve" if action == "approve" else "reject", aid)
    ok = res is not None
    label = "Approved ✅" if action == "approve" else "Rejected ❌"
    tg("answerCallbackQuery", callback_query_id=cq_id, text=label if ok else "Failed — try the dashboard")
    if ok and chat_id and mid:
        base = (msg.get("text") or "").split("\n")[0]
        tg("editMessageText", chat_id=chat_id, message_id=mid,
           text=f"{base}\n\n*{label}* via Telegram", parse_mode="Markdown")


def register_chat(state, chat_id):
    if chat_id not in state["chats"]:
        state["chats"].append(chat_id)
        save_state(state)


def handle_message(m, state):
    chat_id = (m.get("chat") or {}).get("id")
    text = (m.get("text") or "").strip()
    if chat_id is None:
        return
    register_chat(state, chat_id)
    low = text.lower()
    if low in ("/start", "/help"):
        tg("sendMessage", chat_id=chat_id, parse_mode="Markdown", text=(
            "*Connected to Durkan Agency.*\n"
            "I'll send approvals here — tap ✅/❌ to act.\n\n"
            "• Any message → creates a task\n"
            "• `/task <title>` → task\n"
            "• `/project <name>` → project\n"
            "• `/status` → what's happening now"))
        return
    if low == "/status":
        runs = cli("run", "live", "-C", COMPANY_ID) or []
        runs = runs if isinstance(runs, list) else runs.get("runs", [])
        appr = cli("approval", "list", "-C", COMPANY_ID) or []
        appr = appr if isinstance(appr, list) else appr.get("approvals", [])
        pending = [a for a in appr if a.get("status") in ("pending", "revision_requested")]
        lines = [f"*Now:* {len(runs)} running · {len(pending)} awaiting you"]
        for r in runs[:6]:
            lines.append(f"• {r.get('agentName')} — {r.get('status')}")
        tg("sendMessage", chat_id=chat_id, text="\n".join(lines), parse_mode="Markdown")
        return
    if low.startswith("/project "):
        name = text[len("/project "):].strip()
        res = cli_env({"NM": name}, "project", "create", "-C", COMPANY_ID, "--name", '"$NM"')
        ident = (res or {}).get("name", name)
        tg("sendMessage", chat_id=chat_id, text=f"📁 Created project *{ident}*" if res else "Couldn't create the project.", parse_mode="Markdown")
        return
    title = text[len("/task "):].strip() if low.startswith("/task ") else text
    if not title:
        return
    res = cli_env({"TT": title}, "issue", "create", "-C", COMPANY_ID, "--title", '"$TT"')
    ident = (res or {}).get("identifier", "")
    tg("sendMessage", chat_id=chat_id,
       text=f"✅ Created task *{ident}* — {title}" if res else "Couldn't create the task.",
       parse_mode="Markdown")


def main():
    state = load_state()
    print("telegram-bridge: started", flush=True)
    last_notify = 0.0
    while True:
        # Inbound: long-poll Telegram (25s server-side; give urllib more headroom).
        updates = tg("getUpdates", http_timeout=40, offset=state["offset"] + 1, timeout=25) or []
        for u in updates:
            state["offset"] = max(state["offset"], u.get("update_id", 0))
            try:
                if "callback_query" in u:
                    handle_callback(u["callback_query"], state)
                elif "message" in u:
                    handle_message(u["message"], state)
            except Exception as e:
                print(f"update error: {e}", flush=True)
        save_state(state)
        # Outbound: notify on new approvals (throttled).
        now = time.time()
        if now - last_notify > 12:
            try:
                notify_approvals(state)
            except Exception as e:
                print(f"notify error: {e}", flush=True)
            last_notify = now


if __name__ == "__main__":
    main()
