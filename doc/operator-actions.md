# One-click host actions ("operator actions")

Agents often find a problem that needs something done on the server itself:
restart the Telegram bridge after its code changed, recreate a container so a
changed `.env` is used, or change one setting. They have no host access and
must not get it. Host actions give them a safe way to ask:

1. The agent files a `request_board_approval` card with
   `payload.kind: "operator_action"`, naming ONE action and ONE target from a
   list the instance admin keeps on the server.
2. The company owner or an admin approves it with one click. The card shows,
   in plain words, what will happen and the exact command that will run.
3. `scripts/operator-action-runner.py`, running on the box from a systemd timer
   (same pattern as the deploy runner), performs exactly that action and posts
   the result on the card and on the linked task.

## Actions

| `action` | `target` is | What runs |
|---|---|---|
| `restart_service` | a service name | `systemctl restart <unit>`, `docker restart <container>` or `docker compose ... restart <service>` |
| `recreate_container` | a compose service name | `docker compose ... up -d --no-deps --no-build --force-recreate <service>` |
| `set_env_var` | a settings-file name | writes `KEY=<value of a company secret>` into that file |

Nothing else. The card never carries a command, path, unit or value: it only
picks an entry from the list by name. `set_env_var` takes `envKey` (must be on
that file's `keys` list) and `secretId` (a secret of the same company); the
value is fetched by the runner on the box and is never shown on the card, in
comments or in logs.

## The allow-list file (on the box, not in the database)

Default path: `/etc/paperclip/operator-actions.json` (override with
`PAPERCLIP_OPERATOR_ACTIONS_CONFIG` in the service unit). It must be owned by
root and not writable by group or others, or the runner refuses everything.
An example is in `deploy/operator-actions.example.json`.

```json
{
  "version": 1,
  "companies": {
    "<company id>": {
      "services": {
        "<name>": {
          "label": "the Telegram bridge",
          "systemdUnit": "paperclip-telegram-bridge.service",
          "actions": ["restart_service"]
        },
        "<name>": {
          "label": "the dashboard website",
          "compose": {
            "directory": "/root/nordstrand-dashboard",
            "files": ["docker-compose.yml"],
            "envFile": ".env",
            "projectName": "optional-compose-project-name",
            "service": "web"
          },
          "actions": ["restart_service", "recreate_container"]
        },
        "<name>": {
          "label": "the web crawler",
          "container": "crawl4ai",
          "actions": ["restart_service"]
        }
      },
      "envFiles": {
        "<name>": {
          "label": "the dashboard settings file",
          "path": "/root/nordstrand-dashboard/.env",
          "keys": ["FEATURE_NEW_CHECKOUT"]
        }
      }
    }
  }
}
```

Rules (checked on every tick; any mistake switches host actions off and is
written to `operator-action-runner.log`):

- Company ids are the Paperclip company UUIDs. A company can only ever reach
  the services and files listed under its own id.
- `<name>`: lowercase letters, digits, `-` and `_` (max 63). This is what the
  agent asks for.
- `label`: one short line. It is what the operator reads on the card
  ("Restart **the Telegram bridge**").
- Each service has exactly one of `systemdUnit` (must end in `.service`),
  `container` (a container name) or `compose`.
- `compose.directory` is an absolute path; `files` and `envFile` are relative
  to it (no `..`). `recreate_container` is only allowed for compose services.
- `envFiles.*.path` is absolute and must already exist (the runner never
  creates files). `keys` are upper-case setting names.

## How the pieces fit

- Each tick the runner publishes a cut-down copy of the list (names, labels,
  the exact command for each action, settings-file paths and allowed keys;
  never secret values) into the server's volume at
  `/paperclip/operator-actions/catalog.json`. The server uses it to refuse bad
  requests when they are filed and to stamp the card's text and `willRun`.
  Agents read their company's part with
  `GET /api/companies/:companyId/operator-actions`.
- The published copy is a convenience, not the boundary. The runner checks
  every approved card against its OWN file again, for the card's own company,
  and refuses the card if the command stamped on it is not exactly what it
  would run. So a tampered copy can at worst produce a card that is refused.
- Approval: only a person who is the company's owner or admin, or an instance
  admin (`/approvals/:id/approve`). The card cannot be decided through a
  linked confirmation card. Agents can ask but never approve.
- The runner only acts on cards approved within the last 24 hours
  (`PAPERCLIP_OPERATOR_ACTION_RUNNER_MAX_AGE_SECONDS`); older ones are answered
  "not run". Unapproved cards follow the normal card expiry rules.
- At most once: a card's id is written to `.operator-action-runner-processed`
  before anything runs. If the result comment cannot be delivered it is
  queued in `.operator-action-runner-unsent.jsonl` and retried; the action is
  never repeated.
- Every card the runner handles gets one JSON line in
  `operator-actions-audit.log` (approval, company, who approved, action,
  target, command, outcome, exit code).
- The value for `set_env_var` is read through
  `GET /api/approvals/:id/operator-action-secret`: instance admin only, only
  for an approved `set_env_var` card, only the secret named on it, recorded in
  the secret's access trail.

## Install on the box (as root)

```sh
cd /root/paperclip && git pull                     # the checkout the deploy runner uses
install -d -m 0755 /etc/paperclip
install -m 0600 -o root -g root deploy/operator-actions.example.json /etc/paperclip/operator-actions.json
"${EDITOR:-nano}" /etc/paperclip/operator-actions.json   # real company ids, services, files
PAPERCLIP_OPERATOR_ACTIONS_CONFIG=/etc/paperclip/operator-actions.json \
  python3 -I -c 'import importlib.util as u; s=u.spec_from_file_location("r","/root/paperclip/scripts/operator-action-runner.py"); m=u.module_from_spec(s); s.loader.exec_module(m); import json; print(json.dumps(m.build_catalog(m.load_config()), indent=2))'
cp deploy/systemd/paperclip-operator-action-runner.service /etc/systemd/system/
cp deploy/systemd/paperclip-operator-action-runner.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now paperclip-operator-action-runner.timer
```

The `python3 -I -c ...` line checks the file and prints what each action will
run; fix any error it reports before enabling the timer. The runner uses the
same CLI sign-in inside the server container as the deploy runner (instance
admin), and needs the server version that has the
`approval operator-action-secret` CLI command for `set_env_var`.

Logs and state live next to the script's checkout (repo root):
`operator-action-runner.log`, `operator-actions-audit.log`,
`.operator-action-runner-processed`, `.operator-action-runner-unsent.jsonl`.

Switch it off: `systemctl disable --now paperclip-operator-action-runner.timer`.
