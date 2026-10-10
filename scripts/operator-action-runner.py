#!/usr/bin/env python3
"""On-box runner for one-click host actions ("operator actions").

Sibling of scripts/deploy-runner.sh, same shape: runs on the host, outside any
container, as root, from a systemd timer (deploy/systemd/
paperclip-operator-action-runner.{service,timer}), and talks to Paperclip only
through the CLI's stored instance-admin credential inside the server
container.

Each tick:

  1. Loads the instance admin's allow-list from CONFIG_PATH (default
     /etc/paperclip/operator-actions.json -- on the box, never in the
     database; format in doc/operator-actions.md). A missing or invalid file
     means NOTHING is allowed: approved cards are answered "not run".
  2. Publishes a cut-down copy (names, labels, the exact command for each
     action, settings-file paths and allowed keys; never secret values) into
     the server's volume, so the server can refuse bad requests at filing
     time and stamp the exact command on the card.
  3. For every APPROVED `request_board_approval` card with
     payload.kind == "operator_action", in every company, not yet processed:
       - re-validates the card against the LOCAL allow-list for THAT company
         (the server's approval is necessary, never sufficient);
       - refuses the card if the command stamped on it (`willRun`) is not
         exactly what this runner would run -- so the person approving always
         saw the real command;
       - records the card as processed BEFORE doing anything, so an action
         runs at most once, even if this process dies half-way;
       - runs a FIXED argv template (no shell, nothing from the card is ever
         interpolated into a command: the card only selects an entry from the
         allow-list by name);
       - writes one JSON audit line and posts the result (with the tail of the
         output) on the card and on every task linked to it. A comment that
         cannot be delivered is queued and retried on later ticks; the action
         itself is never retried.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from typing import Any

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)


def _env(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


CONFIG_PATH = _env("PAPERCLIP_OPERATOR_ACTIONS_CONFIG", "/etc/paperclip/operator-actions.json")
PROCESSED_PATH = _env("PAPERCLIP_OPERATOR_ACTION_RUNNER_PROCESSED", os.path.join(REPO_DIR, ".operator-action-runner-processed"))
UNSENT_PATH = _env("PAPERCLIP_OPERATOR_ACTION_RUNNER_UNSENT", os.path.join(REPO_DIR, ".operator-action-runner-unsent.jsonl"))
PUBLISHED_PATH = _env("PAPERCLIP_OPERATOR_ACTION_RUNNER_PUBLISHED", os.path.join(REPO_DIR, ".operator-action-runner-published"))
LOG_PATH = _env("PAPERCLIP_OPERATOR_ACTION_RUNNER_LOG", os.path.join(REPO_DIR, "operator-action-runner.log"))
AUDIT_PATH = _env("PAPERCLIP_OPERATOR_ACTION_RUNNER_AUDIT_LOG", os.path.join(REPO_DIR, "operator-actions-audit.log"))
LOCK_PATH = _env("PAPERCLIP_OPERATOR_ACTION_RUNNER_LOCK", "/tmp/paperclip-operator-action-runner.lock")
CONTAINER = _env(
    "PAPERCLIP_OPERATOR_ACTION_RUNNER_CONTAINER",
    _env("PAPERCLIP_DEPLOY_RUNNER_CONTAINER", "docker-server-1"),
)
# Where the server reads the published catalogue (inside the container).
# Keep in step with OPERATOR_ACTIONS_CATALOG_PATH_DEFAULT in
# server/src/services/operator-actions.ts.
CATALOG_PATH_IN_CONTAINER = _env("PAPERCLIP_OPERATOR_ACTIONS_CATALOG_PATH", "/paperclip/operator-actions/catalog.json")
# A card approved longer ago than this is answered "not run" instead of acted
# on: an approval is a decision about the situation at the time.
MAX_AGE_SECONDS = int(_env("PAPERCLIP_OPERATOR_ACTION_RUNNER_MAX_AGE_SECONDS", "86400"))
COMMAND_TIMEOUT_SECONDS = int(_env("PAPERCLIP_OPERATOR_ACTION_RUNNER_COMMAND_TIMEOUT", "600"))
COMMENT_RETRIES = int(_env("PAPERCLIP_OPERATOR_ACTION_RUNNER_COMMENT_RETRIES", "3"))
COMMENT_RETRY_SLEEP_SECONDS = float(_env("PAPERCLIP_OPERATOR_ACTION_RUNNER_COMMENT_RETRY_SLEEP", "5"))
REPUBLISH_SECONDS = int(_env("PAPERCLIP_OPERATOR_ACTION_RUNNER_REPUBLISH_SECONDS", "600"))
OUTPUT_TAIL_LINES = 30
OUTPUT_TAIL_CHARS = 3000
MAX_SECRET_VALUE_LENGTH = 8192

CLI_PREFIX = ["node", "cli/node_modules/tsx/dist/cli.mjs", "cli/src/index.ts"]
CLI_SUFFIX = ["--api-base", "http://127.0.0.1:3100", "--data-dir", "/paperclip/cli-state", "--json"]
# Same hardening as deploy-runner.sh (DUR-3994): root's HOME, no tsx cache,
# and no shell at all -- the argv goes straight to `node`.
CLI_EXEC_FLAGS = ["-e", "HOME=/root", "-e", "TSX_DISABLE_CACHE=1", "-w", "/app"]

ACTIONS = ("restart_service", "recreate_container", "set_env_var")
SERVICE_ACTIONS = ("restart_service", "recreate_container")

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
ENV_KEY_RE = re.compile(r"^[A-Z_][A-Z0-9_]{0,127}$")
UNIT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,240}\.service$")
CONTAINER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
REL_FILE_RE = re.compile(r"^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,200}$")
ABS_PATH_RE = re.compile(r"^/[A-Za-z0-9_./-]{1,400}$")
SAFE_UNQUOTED_VALUE_RE = re.compile(r"^[A-Za-z0-9_./:@+,=%-]*$")


class ConfigError(Exception):
    pass


class Refusal(Exception):
    """The card is not run; the message is shown to the operator as-is."""


# --------------------------------------------------------------------------- utils


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(message: str) -> None:
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(f"[{now_iso()}] {message}\n")
    except OSError:
        pass


def audit(entry: dict[str, Any]) -> None:
    line = json.dumps({"ts": now_iso(), **entry}, sort_keys=True)
    try:
        with open(AUDIT_PATH, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError as err:
        log(f"could not write audit line ({err}): {line}")


def parse_when(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text[-1:] in ("Z", "z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def tail_output(raw: bytes | str | None) -> str:
    if raw is None:
        return ""
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    lines = text.rstrip("\n").splitlines()[-OUTPUT_TAIL_LINES:]
    out = "\n".join(lines)
    if len(out) > OUTPUT_TAIL_CHARS:
        out = out[-OUTPUT_TAIL_CHARS:]
    return out.replace("```", "'''")


def is_safe_relative(path: str) -> bool:
    if not REL_FILE_RE.match(path) or path.startswith("-"):
        return False
    return all(part not in ("", "..") for part in path.split("/"))


def is_safe_absolute(path: str) -> bool:
    if not ABS_PATH_RE.match(path):
        return False
    return all(part != ".." for part in path.split("/"))


def check_label(value: Any, where: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 120:
        raise ConfigError(f"{where}.label must be a short one-line text")
    if any(ord(ch) < 32 for ch in value):
        raise ConfigError(f"{where}.label must be one line")
    return value.strip()


# --------------------------------------------------------------------------- config


def load_config(path: str = CONFIG_PATH) -> dict[str, Any]:
    """Load and strictly validate the allow-list. Any problem -> ConfigError (nothing runs)."""
    try:
        st = os.stat(path)
    except FileNotFoundError:
        raise ConfigError(f"no host actions config at {path}")
    if os.environ.get("PAPERCLIP_OPERATOR_ACTION_RUNNER_SKIP_OWNER_CHECK") != "1":
        # The allow-list is the security boundary: it must not be writable by
        # anyone but root.
        if st.st_uid != 0 or (st.st_mode & (stat.S_IWGRP | stat.S_IWOTH)):
            raise ConfigError(f"{path} must be owned by root and not writable by group/others")
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as err:
        raise ConfigError(f"{path} is not valid JSON: {err}")
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise ConfigError("config must be an object with \"version\": 1")
    companies = raw.get("companies")
    if not isinstance(companies, dict):
        raise ConfigError("config.companies must be an object keyed by company id")
    out: dict[str, Any] = {}
    for company_id, company in companies.items():
        where = f"companies.{company_id}"
        if not isinstance(company_id, str) or not UUID_RE.match(company_id):
            raise ConfigError(f"{where}: company id must be a lower-case UUID")
        if not isinstance(company, dict):
            raise ConfigError(f"{where} must be an object")
        services_out: dict[str, Any] = {}
        for name, service in (company.get("services") or {}).items():
            services_out[name] = validate_service(name, service, f"{where}.services.{name}")
        env_out: dict[str, Any] = {}
        for name, env_file in (company.get("envFiles") or {}).items():
            env_out[name] = validate_env_file(name, env_file, f"{where}.envFiles.{name}")
        out[company_id] = {"services": services_out, "envFiles": env_out}
    return out


def validate_service(name: Any, service: Any, where: str) -> dict[str, Any]:
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise ConfigError(f"{where}: name must match {NAME_RE.pattern}")
    if not isinstance(service, dict):
        raise ConfigError(f"{where} must be an object")
    label = check_label(service.get("label"), where)
    backends = [key for key in ("systemdUnit", "container", "compose") if key in service]
    if len(backends) != 1:
        raise ConfigError(f"{where}: set exactly one of systemdUnit, container, compose")
    actions = service.get("actions")
    if not isinstance(actions, list) or not actions or any(a not in SERVICE_ACTIONS for a in actions):
        raise ConfigError(f"{where}.actions must be a non-empty list of {', '.join(SERVICE_ACTIONS)}")
    result: dict[str, Any] = {"label": label, "actions": sorted(set(actions))}
    backend = backends[0]
    if backend == "systemdUnit":
        unit = service["systemdUnit"]
        if not isinstance(unit, str) or not UNIT_RE.match(unit):
            raise ConfigError(f"{where}.systemdUnit must be a unit name ending in .service")
        result["systemdUnit"] = unit
    elif backend == "container":
        container = service["container"]
        if not isinstance(container, str) or not CONTAINER_RE.match(container):
            raise ConfigError(f"{where}.container must be a container name")
        result["container"] = container
    else:
        compose = service["compose"]
        if not isinstance(compose, dict):
            raise ConfigError(f"{where}.compose must be an object")
        directory = compose.get("directory")
        if not isinstance(directory, str) or not is_safe_absolute(directory):
            raise ConfigError(f"{where}.compose.directory must be an absolute path")
        files = compose.get("files") or []
        if not isinstance(files, list) or any(not isinstance(f, str) or not is_safe_relative(f) for f in files):
            raise ConfigError(f"{where}.compose.files must be paths relative to the directory")
        env_file = compose.get("envFile")
        if env_file is not None and (not isinstance(env_file, str) or not is_safe_relative(env_file)):
            raise ConfigError(f"{where}.compose.envFile must be a path relative to the directory")
        project_name = compose.get("projectName")
        if project_name is not None and (not isinstance(project_name, str) or not NAME_RE.match(project_name)):
            raise ConfigError(f"{where}.compose.projectName must match {NAME_RE.pattern}")
        svc = compose.get("service")
        if not isinstance(svc, str) or not CONTAINER_RE.match(svc):
            raise ConfigError(f"{where}.compose.service must be a compose service name")
        result["compose"] = {
            "directory": directory,
            "files": list(files),
            "envFile": env_file,
            "projectName": project_name,
            "service": svc,
        }
    if "recreate_container" in result["actions"] and backend != "compose":
        raise ConfigError(f"{where}: recreate_container is only possible for a compose service")
    return result


def validate_env_file(name: Any, env_file: Any, where: str) -> dict[str, Any]:
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise ConfigError(f"{where}: name must match {NAME_RE.pattern}")
    if not isinstance(env_file, dict):
        raise ConfigError(f"{where} must be an object")
    label = check_label(env_file.get("label"), where)
    path = env_file.get("path")
    if not isinstance(path, str) or not is_safe_absolute(path):
        raise ConfigError(f"{where}.path must be an absolute path")
    keys = env_file.get("keys")
    if not isinstance(keys, list) or any(not isinstance(k, str) or not ENV_KEY_RE.match(k) for k in keys):
        raise ConfigError(f"{where}.keys must be a list of upper-case setting names")
    return {"label": label, "path": path, "keys": sorted(set(keys))}


# --------------------------------------------------------------------------- command templates


def service_command(service: dict[str, Any], action: str) -> tuple[list[str], str | None]:
    """The fixed argv (and working directory) for one allow-listed service action."""
    if action not in service["actions"]:
        raise Refusal(f"{service['label']} is not allowed to {action.replace('_', ' ')} on this server")
    if "systemdUnit" in service:
        return ["systemctl", "restart", service["systemdUnit"]], None
    if "container" in service:
        return ["docker", "restart", service["container"]], None
    compose = service["compose"]
    argv = ["docker", "compose"]
    if compose.get("projectName"):
        argv += ["-p", compose["projectName"]]
    if compose.get("envFile"):
        argv += ["--env-file", compose["envFile"]]
    for compose_file in compose["files"]:
        argv += ["-f", compose_file]
    if action == "restart_service":
        argv += ["restart", compose["service"]]
    else:
        argv += ["up", "-d", "--no-deps", "--no-build", "--force-recreate", compose["service"]]
    return argv, compose["directory"]


def render_command(argv: list[str], cwd: str | None) -> str:
    joined = shlex.join(argv)
    return f"cd {shlex.quote(cwd)} && {joined}" if cwd else joined


def render_set_env_will_run(env_key: str, path: str) -> str:
    # Keep in step with renderSetEnvVarWillRun in server/src/services/operator-actions.ts.
    return f"write {env_key}=<secret value> into {path}"


def build_catalog(config: dict[str, Any]) -> dict[str, Any]:
    companies: dict[str, Any] = {}
    for company_id, company in config.items():
        services = {}
        for name, service in company["services"].items():
            services[name] = {
                "label": service["label"],
                "actions": {action: render_command(*service_command(service, action)) for action in service["actions"]},
            }
        env_files = {
            name: {"label": env["label"], "path": env["path"], "keys": env["keys"]}
            for name, env in company["envFiles"].items()
        }
        companies[company_id] = {"services": services, "envFiles": env_files}
    return {"version": 1, "companies": companies}


# --------------------------------------------------------------------------- Paperclip CLI


def cli(*args: str, timeout: int = 120) -> tuple[int, str]:
    argv = ["docker", "exec", *CLI_EXEC_FLAGS, CONTAINER, *CLI_PREFIX, *args, *CLI_SUFFIX]
    try:
        done = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as err:
        log(f"cli {' '.join(args[:2])} failed to run: {err}")
        return 1, ""
    if done.returncode != 0:
        log(f"cli {' '.join(args[:2])} exited {done.returncode}: {tail_output(done.stderr)[-300:]}")
    return done.returncode, done.stdout.decode("utf-8", "replace")


def cli_json(*args: str) -> Any:
    code, out = cli(*args)
    if code != 0:
        return None
    try:
        return json.loads(out)
    except ValueError:
        log(f"cli {' '.join(args[:2])} did not return JSON: {out[:200]!r}")
        return None


def publish_catalog(config: dict[str, Any]) -> None:
    body = json.dumps(build_catalog(config), sort_keys=True, indent=2) + "\n"
    digest = hashlib.sha256(body.encode()).hexdigest()
    try:
        with open(PUBLISHED_PATH, encoding="utf-8") as handle:
            last_digest, last_epoch = handle.read().split()
        if last_digest == digest and time.time() - float(last_epoch) < REPUBLISH_SECONDS:
            return
    except (OSError, ValueError):
        pass
    argv = [
        "docker", "exec", "-i", "-e", f"CATALOG_PATH={CATALOG_PATH_IN_CONTAINER}", CONTAINER, "sh", "-c",
        'umask 022 && mkdir -p "$(dirname "$CATALOG_PATH")" && cat > "$CATALOG_PATH.tmp" && mv "$CATALOG_PATH.tmp" "$CATALOG_PATH"',
    ]
    try:
        done = subprocess.run(argv, input=body.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired) as err:
        log(f"could not publish the host actions list: {err}")
        return
    if done.returncode != 0:
        log(f"could not publish the host actions list (exit {done.returncode}): {tail_output(done.stderr)[-300:]}")
        return
    try:
        with open(PUBLISHED_PATH, "w", encoding="utf-8") as handle:
            handle.write(f"{digest} {time.time()}\n")
    except OSError:
        pass


def deliver_comment(approval_id: str, body: str) -> bool:
    delivered = False
    for attempt in range(1, COMMENT_RETRIES + 1):
        code, _ = cli("approval", "comment", approval_id, "--body", body)
        if code == 0:
            delivered = True
            break
        if attempt < COMMENT_RETRIES:
            time.sleep(COMMENT_RETRY_SLEEP_SECONDS)
    if not delivered:
        return False
    issues = cli_json("approval", "issues", approval_id)
    for issue in issues if isinstance(issues, list) else []:
        issue_id = issue.get("id") if isinstance(issue, dict) else None
        if isinstance(issue_id, str) and UUID_RE.match(issue_id):
            if cli("issue", "comment", issue_id, "--body", body)[0] != 0:
                log(f"{approval_id}: could not post the result on task {issue_id} (non-fatal)")
    return True


def queue_unsent(approval_id: str, body: str) -> None:
    with open(UNSENT_PATH, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"approvalId": approval_id, "body": body}) + "\n")


def retry_unsent() -> None:
    try:
        with open(UNSENT_PATH, encoding="utf-8") as handle:
            pending = [json.loads(line) for line in handle if line.strip()]
    except FileNotFoundError:
        return
    except (OSError, ValueError) as err:
        log(f"could not read {UNSENT_PATH}: {err}")
        return
    still = [item for item in pending if not deliver_comment(item["approvalId"], item["body"])]
    with open(UNSENT_PATH + ".tmp", "w", encoding="utf-8") as handle:
        for item in still:
            handle.write(json.dumps(item) + "\n")
    os.replace(UNSENT_PATH + ".tmp", UNSENT_PATH)


# --------------------------------------------------------------------------- processed set


def load_processed() -> set[str]:
    try:
        with open(PROCESSED_PATH, encoding="utf-8") as handle:
            return {line.strip() for line in handle if line.strip()}
    except FileNotFoundError:
        return set()


def mark_processed(approval_id: str) -> None:
    # Written and flushed to disk BEFORE the action runs: at most once.
    with open(PROCESSED_PATH, "a", encoding="utf-8") as handle:
        handle.write(approval_id + "\n")
        handle.flush()
        os.fsync(handle.fileno())


# --------------------------------------------------------------------------- actions


def plan(card: dict[str, Any], company_id: str, config: dict[str, Any]) -> dict[str, Any]:
    """Validate one approved card against the LOCAL allow-list. Returns what to do, or raises Refusal."""
    if card.get("type") != "request_board_approval" or card.get("status") != "approved":
        raise Refusal("this card is not an approved host action")
    if card.get("companyId") != company_id:
        raise Refusal("this card belongs to a different company than the one it was listed under")
    decided_by = card.get("decidedByUserId")
    if not isinstance(decided_by, str) or not decided_by.strip() or decided_by.startswith(("automation", "system")):
        raise Refusal("this card was not approved by a person")
    decided = parse_when(card.get("decidedAt"))
    if decided is None or (datetime.now(timezone.utc) - decided).total_seconds() > MAX_AGE_SECONDS:
        hours = MAX_AGE_SECONDS // 3600
        raise Refusal(f"this card was approved more than {hours} hours ago (or has no approval time). Ask for it again if it is still needed")
    payload = card.get("payload") or {}
    action = payload.get("action")
    target = payload.get("target")
    if action not in ACTIONS:
        raise Refusal("the card asks for an action this server does not know")
    if not isinstance(target, str) or not NAME_RE.match(target):
        raise Refusal("the card does not name a valid target")
    company = config.get(company_id)
    if company is None:
        raise Refusal("no host actions are set up for this company on this server")
    stamped = payload.get("willRun")

    if action == "set_env_var":
        env_file = company["envFiles"].get(target)
        if env_file is None:
            raise Refusal(f'"{target}" is not a settings file on this company\'s host actions list on this server')
        env_key = payload.get("envKey")
        if not isinstance(env_key, str) or not ENV_KEY_RE.match(env_key) or env_key not in env_file["keys"]:
            raise Refusal(f"that setting may not be changed in {env_file['label']} on this server")
        will_run = render_set_env_will_run(env_key, env_file["path"])
        if stamped != will_run:
            raise Refusal("the command shown on the card is not what this server would run, so it was not run")
        return {"action": action, "target": target, "label": env_file["label"], "envKey": env_key, "path": env_file["path"], "willRun": will_run}

    service = company["services"].get(target)
    if service is None:
        raise Refusal(f'"{target}" is not a service on this company\'s host actions list on this server')
    argv, cwd = service_command(service, action)
    will_run = render_command(argv, cwd)
    if stamped != will_run:
        raise Refusal("the command shown on the card is not what this server would run, so it was not run")
    return {"action": action, "target": target, "label": service["label"], "argv": argv, "cwd": cwd, "willRun": will_run}


def run_command(argv: list[str], cwd: str | None) -> tuple[int, str]:
    if cwd is not None and not os.path.isdir(cwd):
        return 127, f"folder {cwd} does not exist on this server"
    try:
        done = subprocess.run(
            argv,
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=COMMAND_TIMEOUT_SECONDS,
            check=False,
            shell=False,
        )
    except subprocess.TimeoutExpired as err:
        return 124, tail_output(err.output) + f"\n(stopped after {COMMAND_TIMEOUT_SECONDS} seconds)"
    except OSError as err:
        return 127, str(err)
    return done.returncode, tail_output(done.stdout)


def format_env_line(key: str, value: str) -> str:
    if SAFE_UNQUOTED_VALUE_RE.match(value):
        return f"{key}={value}"
    # Single quotes: docker compose and python-dotenv both take the content
    # literally (no $-expansion). A value containing a single quote cannot be
    # written that way, so it is refused before we get here.
    return f"{key}='{value}'"


def write_env_var(path: str, key: str, value: str) -> str:
    """Set KEY in an existing env file, atomically, keeping its owner and mode. Returns 'replaced' or 'added'."""
    st = os.lstat(path)  # raises FileNotFoundError: we never create settings files
    if not stat.S_ISREG(st.st_mode):
        raise Refusal(f"{path} is not a plain file on this server")
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    pattern = re.compile(r"^\s*(?:export\s+)?" + re.escape(key) + r"\s*=")
    new_line = format_env_line(key, value)
    out: list[str] = []
    replaced = False
    for line in lines:
        if pattern.match(line):
            if not replaced:
                out.append(new_line)
                replaced = True
            continue  # drop later duplicates so there is exactly one value
        out.append(line)
    if not replaced:
        out.append(new_line)
    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".operator-action-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("\n".join(out) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, stat.S_IMODE(st.st_mode))
        try:
            os.chown(tmp, st.st_uid, st.st_gid)
        except PermissionError:
            pass
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return "replaced" if replaced else "added"


def fetch_secret_value(approval_id: str) -> str:
    result = cli_json("approval", "operator-action-secret", approval_id)
    value = result.get("value") if isinstance(result, dict) else None
    if not isinstance(value, str):
        raise Refusal("the secret named on the card could not be read")
    if len(value) > MAX_SECRET_VALUE_LENGTH:
        raise Refusal("the secret's value is too long for a settings file")
    if any(ch in value for ch in ("\n", "\r", "\0")):
        raise Refusal("the secret's value has a line break in it, which a settings file cannot hold")
    if "'" in value:
        raise Refusal("the secret's value contains a single quote, which cannot be written safely into a settings file")
    return value


VERB = {
    "restart_service": ("restarted", "restart"),
    "recreate_container": ("recreated", "recreate"),
}


def execute(card: dict[str, Any], company_id: str, config: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Runs one card. Returns (comment body, audit fields). Never raises."""
    approval_id = card["id"]
    try:
        step = plan(card, company_id, config)
    except Refusal as refusal:
        return (
            f"Not run: {refusal}. Nothing was changed on the server.",
            {"outcome": "refused", "reason": str(refusal)},
        )
    base = {"action": step["action"], "target": step["target"], "willRun": step["willRun"]}

    if step["action"] == "set_env_var":
        secret_value = ""
        try:
            secret_value = fetch_secret_value(approval_id)
            how = write_env_var(step["path"], step["envKey"], secret_value)
        except Refusal as refusal:
            return f"Not run: {refusal}. Nothing was changed on the server.", {**base, "outcome": "refused", "reason": str(refusal)}
        except OSError as err:
            message = str(err).replace(secret_value, "<secret value>") if secret_value else str(err)
            return (
                f"Failed: could not change {step['envKey']} in {step['label']} ({message}). The file was left as it was.",
                {**base, "outcome": "failed", "reason": message},
            )
        what = "replaced the old value" if how == "replaced" else "the setting was not there before, so it was added"
        return (
            f"Done: {step['envKey']} in {step['label']} now has the value from the secret ({what}). "
            "It is used the next time that app is recreated, so ask for a recreate if it should take effect now.",
            {**base, "outcome": "succeeded", "envChange": how},
        )

    exit_code, output = run_command(step["argv"], step["cwd"])
    done_word, do_word = VERB[step["action"]]
    tail = f"\n\nLast lines of output:\n```\n{output}\n```" if output.strip() else ""
    if exit_code == 0:
        body = f"Done: {done_word} {step['label']}.\nRan: `{step['willRun']}` (finished without errors).{tail}"
        return body, {**base, "outcome": "succeeded", "exitCode": 0}
    body = (
        f"Failed: could not {do_word} {step['label']}.\nRan: `{step['willRun']}` (exit code {exit_code}). "
        f"Nothing else was tried.{tail}"
    )
    return body, {**base, "outcome": "failed", "exitCode": exit_code}


def list_companies() -> list[str] | None:
    data = cli_json("company", "list")
    if data is None:
        return None
    items = data if isinstance(data, list) else (data.get("companies") or []) if isinstance(data, dict) else []
    return [c["id"] for c in items if isinstance(c, dict) and isinstance(c.get("id"), str) and UUID_RE.match(c["id"])]


def approved_cards(company_id: str) -> list[dict[str, Any]]:
    data = cli_json("approval", "list", "-C", company_id, "--status", "approved")
    items = data if isinstance(data, list) else (data.get("approvals") or []) if isinstance(data, dict) else []
    return [
        a for a in items
        if isinstance(a, dict)
        and a.get("type") == "request_board_approval"
        and a.get("status") == "approved"
        and isinstance(a.get("payload"), dict)
        and a["payload"].get("kind") == "operator_action"
        and isinstance(a.get("id"), str)
        and UUID_RE.match(a["id"])
    ]


def main() -> int:
    retry_unsent()
    config_error: str | None = None
    try:
        config = load_config()
    except ConfigError as err:
        config, config_error = {}, str(err)
        log(f"host actions are switched off: {err}")
    if config_error is None:
        publish_catalog(config)

    company_ids = list_companies()
    if company_ids is None:
        log("company list failed (is the CLI still signed in inside the server container?)")
        return 0
    processed = load_processed()
    for company_id in company_ids:
        for card in approved_cards(company_id):
            approval_id = card["id"]
            if approval_id in processed:
                continue
            mark_processed(approval_id)
            processed.add(approval_id)
            if config_error is not None:
                body = "Not run: host actions are not set up on this server. Nothing was changed on the server."
                fields: dict[str, Any] = {"outcome": "refused", "reason": config_error}
            else:
                body, fields = execute(card, company_id, config)
            audit({
                "approvalId": approval_id,
                "companyId": company_id,
                "decidedByUserId": card.get("decidedByUserId"),
                "requestedByAgentId": card.get("requestedByAgentId"),
                **fields,
            })
            log(f"{approval_id}: {fields.get('outcome')} {fields.get('action', '')} {fields.get('target', '')}".rstrip())
            if not deliver_comment(approval_id, body):
                log(f"{approval_id}: result comment not delivered; queued for the next tick")
                queue_unsent(approval_id, body)
    return 0


if __name__ == "__main__":
    lock = open(LOCK_PATH, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(0)
    for state_file in (PROCESSED_PATH,):
        open(state_file, "a").close()
    sys.exit(main())
