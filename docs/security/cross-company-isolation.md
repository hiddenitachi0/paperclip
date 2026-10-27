# Cross-company isolation: audit and proof

Last audited: 2026-10-10, branch `security-cross-company-isolation`.

## In plain words

One Paperclip hosts several companies, for example Durkan Agency and
Nordstrand. The promise is that **nothing moves between companies on its own**.
A person, agent or key from one company cannot see, list, change or link to
anything that belongs to another company. That covers tasks, comments,
documents, files, secrets, agents, skills, costs, activity, approvals,
routines, memories, the model catalogue and the live screen updates. The only
way anything crosses is a channel someone switched on deliberately, and that
channel leaves an audit trail.

How we checked it:

- **An automated test drives every route in the app (about 900) as an
  intruder.** It creates two companies. The "victim" company holds one of
  everything, and each item carries a unique tracer word. The "intruder"
  company then calls every route with its owner's key, its agent's key and its
  machine key, aiming at the victim's records. The test fails if the tracer
  word or the victim's secret value shows up in any answer, or if any victim
  record changes at all. It also fails if the intruder manages to tie one of
  its own records to one of the victim's.
- The test cannot see two things, so they were checked by reading the code
  instead: the live screen updates, and changes to instance-wide settings
  (settings shared by all companies).
- The test found **two real holes**, and both are now fixed. A project could be
  linked to another company's goal, after which that goal's title showed up in
  the intruder's project list. A goal could also be hung under another
  company's goal, or given another company's agent as its owner. A project
  link to another company's goal made before the fix is now ignored: project
  reads drop it, a new task or a task moved into that project no longer takes
  over the other company's goal, and the task page, its parent chain and the
  agent's wake-up context no longer show that goal. One trace remains: a task
  that took over such a goal before the fix still stores the other company's
  goal id (an id only, never its title or text) and shows it in task lists
  until the task is next edited.
- It also found **one smaller audit problem**, now fixed. Refused requests to
  the admin pages were written to the "cross-company access" audit log as if an
  admin had used them.
- **Open items**, explained below: the Telegram bridge's fallback allow-list
  covers all companies at once; the database's own isolation rules (RLS) only
  apply after a manual switch-over that this audit could not confirm on
  production; and two smaller items.

Bottom line: within the app's own code, isolation holds on every route we can
reach. The biggest remaining risk sits outside the app's request code: the
Telegram bridge's shared allow-list and the database-level lock that has not
been switched on yet.

## How isolation is enforced (where to look)

| Layer | What it does | Where |
| --- | --- | --- |
| Company gate | Every company route calls `assertCompanyAccess(companyId)`. A board user must be an active member, an agent key or JWT must belong to that company, and a service token must be for that company. A cross-company attempt by an agent or service token is logged as `security.cross_company_write_blocked`. | `server/src/routes/authz.ts:174` |
| Default deny for machine keys | A company service token reaches only routes that explicitly accept it (today: Lane A). | `server/src/routes/authz.ts:49`, `:146` |
| Request company scope | `companyScope*` middleware resolves the company (from the URL, the body or the looked-up record), runs the access check first, then pins the DB connection to that company (`app.current_company_id`). | `server/src/middleware/company-scope.ts:45` |
| Per-record checks | Routes like `/api/issues/:id` load the record, then call `assertCompanyAccess(record.companyId)`. Services filter every list by `companyId`. | e.g. `server/src/routes/goals.ts`, `server/src/services/*.ts` |
| Reference checks | A write that names another record (secret, goal, agent, ...) must name one from the same company. | `services/secrets.ts:590`, `services/projects.ts:470` (new), `services/goals.ts:12` (new), `services/issues.ts:7428` (mentions) |
| Database RLS | See the next section. | `packages/db/src/migrations/0149`, `0150`, `0164` |

## What the database (RLS) covers, and what relies on app code

- **Policies exist.** Migration 0149 creates `paperclip_company_scope`
  policies on every Paperclip table that has a `company_id`:
  `company_id = current_setting('app.current_company_id')`, or the session
  holds the `paperclip_app_bypass` role. Migration 0150 adds the
  indirectly-tenanted tables (`company_secret_versions`). Migration 0164 adds
  the tables created after 0149 (named explicitly and checked against the
  schema by `packages/db/src/rls-login-roles.test.ts`) and `pipeline_stages`
  / `pipeline_transitions`. It also creates the two login roles
  `paperclip_app_scoped_login` (bound by RLS) and `paperclip_app_bypass_login`
  (sees all companies, never superuser, never owner). A connection with no
  company claim sees **no rows** (default deny).
- **They only bite after the manual cutover** in `docs/rls-cutover-runbook.md`.
  Migrations create the login roles without passwords. Out of the box, the
  app connects as the user that **owns** the tables
  (`docker/docker-compose.prod.yml:52`, default
  `postgres://paperclip:...`), and table owners skip RLS. 0149 does not set
  `FORCE ROW LEVEL SECURITY`. So unless the runbook's steps have been carried
  out on production (this audit had no production access and could not
  check), **isolation on production is enforced by the app code only**. The
  sweep test and the per-surface tests below are what check that code.
- **Not covered by RLS at all:** instance-wide tables without `company_id`
  (instance settings, plugins, `plugin_state`, `plugin_jobs`, environments,
  auth users and sessions, board keys, `cross_company_access_log`).
  `plugin_state` is keyed by `scope_kind/scope_id`, so a company's plugin
  data (Media Studio looks, keys and pictures) is separated only by plugin and
  host code.
- **Cutover readiness:** 37 of 99 route files in `server/src/routes` still use
  the raw database handle and never set a company scope (for example
  `routines.ts`, `jobs.ts`, `lane-a.ts`, `board-chat.ts`, `chat-router.ts`,
  `customer-inbox.ts`). On the scoped login role those routes would see zero
  rows, so they have to be scope-wired (the DUR-277 pattern) before
  `DATABASE_URL` can move to `paperclip_app_scoped_login`.

## Surface by surface

Status: **OK** means verified, with nothing to fix; **OK (code review)** means
verified by reading the code only, with no test behind it. **FIXED** means a gap
found and fixed on this branch. **GAP** means still open, with a recommended
fix below.

Tests:
- **Sweep** = `server/src/__tests__/cross-company-isolation-sweep.test.ts`, the
  generic all-routes sweep (described under "The automated proof" below).
- **Audit** = `server/src/__tests__/cross-company-isolation-audit.test.ts`, the
  hand-written per-family audit that already existed.
- **Refs** = `server/src/__tests__/cross-company-reference-guards.test.ts` (new).

| Surface | How it is scoped | Test that proves it | Status |
| --- | --- | --- | --- |
| Issues, comments, documents, labels, attachments | Company gate plus per-record lookup; identifiers resolved within the company | Sweep, Audit, `issues-routes-company-scope.test.ts`, `dur110-cross-company-issue-writes.test.ts` | OK |
| Agents, agent keys, memories, personas | Company gate; `assertCanUpdateAgent` (`authz.ts`) | Sweep, `agents-routes-company-scope.test.ts`, `personas-routes-company-scope.test.ts` | OK |
| Projects (goal links, lead agent) | `assertProjectReferencesInCompany` `services/projects.ts:470` | Sweep (found it), Refs | **FIXED**. A's project could link B's goal, and B's goal title then showed in A's project list. Links written before the fix are now ignored everywhere they were used. Project reads (`attachGoals` `services/projects.ts:96`) return no goal title, goal id or lead agent id from another company. A new issue, or one moved into such a project, does not inherit B's goal (`getProjectDefaultGoalId` `services/issues.ts:1112`), and an issue update (`issueService.update`) drops a B goal the issue already stored (`:6235`). Issue detail and heartbeat context (`resolveIssueProjectAndGoal` `routes/issues.ts:3621`) and the parent chain (`getAncestors` `services/issues.ts:7488`) return no B goal title, description or id. Refs inserts such links and such an issue directly and checks all of these. Remaining: an issue that inherited B's goal before the fix and has not been edited since still stores B's goal **id** and shows it (never its content) in issue lists |
| Goals (parent goal, owner agent) | `assertGoalReferencesInCompany` `services/goals.ts:12` | Sweep (found it), Refs | **FIXED**. A's goal could sit under B's goal tree or name B's agent as owner. A link written before the fix still stores B's id in `parentId` / `ownerAgentId`, but no goal read joins it, so none of B's content is returned (code review) |
| Secrets and secret bindings | `assertSecretInCompany` `services/secrets.ts:590`; value resolution re-checks the company (`:746`) | Sweep (B's secret value never appears), `secrets-routes-company-scope.test.ts` | OK |
| Files and assets (object storage) | Asset rows per company; storage keys are prefixed with the company id | Sweep (storage stub flags any read of a B key) | OK |
| Approvals and deploy cards | Company gate on `/approvals/:id/*`; deploy-runner status filtered per company `services/deploy-runner-status.ts:83` | Sweep, Audit | OK |
| Routines and webhooks | Company gate; a public webhook resolves its own trigger and verifies its secret (`routes/routines.ts:691`) | Sweep | OK |
| Costs, activity log, dashboard | Company gate on every view | Sweep, `costs-routes-company-scope.test.ts`, `activity-routes-company-scope.test.ts`, `dashboard-routes-company-scope.test.ts` | OK |
| Activity log of refused attempts | A refused attempt by A on B's issue is logged in B's feed (by design). That record never copies B's content into A's feed | Sweep (rule `auditRowAllowed`) | OK (note 3) |
| Search | Company-scoped (`routes/issues.ts:3789`, `routes/crm.ts`) | Sweep sends `?q=` with a prefix both companies' data share, so a cross-company hit would carry B's tracer | OK |
| Skills | Company skills behind the company gate; "public link" sharing is switched off (`services/company-skills.ts:1343`); the catalogue `/api/skills/catalog` is static bundled content with no company data (`routes/company-skills.ts:143`) | Sweep | OK |
| Model catalogue | Per company (`routes/model-directory.ts:87`, entry routes behind the company scope) | Sweep (A-path plus B entry id) | OK |
| Helper and investigations | Board member of the company; references filtered to what the person may see (`services/helper-investigations.ts:705`) | Sweep | OK |
| Heartbeat wake payloads | Context is built from records filtered by the agent's own company (`services/heartbeat.ts:15169`); @mentions only resolve to agents in the same company (`services/issues.ts:7428`) | Code review; `heartbeat-tick-timers-agent-isolation.test.ts`, `agents-wakeup-company-scope.test.ts` | OK |
| Live events (websocket) | The upgrade requires company membership (session) or an agent key of that company (`realtime/live-events-ws.ts:117`); a client subscribes to its own company channel only (`:230`); the global channel carries only plugin ids | Code review only. Not covered by the sweep (it opens no websocket), and `live-events-ws.test.ts` tests only upgrade-socket error handling, not company scoping | OK (code review) |
| Plugins and Media Studio | Bridge calls require company access for the `companyId` they name (`routes/plugins.ts:742`); Media Studio keys all state by the host-verified company (`media-studio/src/worker.ts:361`, `company-settings.ts:52`); entities, logs and jobs carry `company_id` | Sweep, `plugin-tenant-isolation.test.ts` | OK (note 4) |
| Environments | Instance resource (no `company_id`); any member sees the list with config, env and metadata redacted; only instance admins change it; changes are announced in every company's feed | Redaction: `environment-routes.test.ts` ("redacts environment config / detail config for non-admin board readers", `:287`, `:310`). Admin-only changes and the every-company announcement: `environment-instance-routes.test.ts` ("rejects non-admin signed-in board members from mutating instance environments", `:210`; "creates an instance-scoped environment and logs the mutation to every company", `:232`). Sweep: only that the two environment reads (`/environments`, `/environments/capabilities`) are the only B URLs allowed to answer 2xx, and that they carry none of B's data; it cannot see a change to the environments table (see its known limits) | OK, shared by design |
| Instance settings and admin routes | Instance admin only | Code review only. Not covered by the sweep: its database check only sees rows that mention B, so it cannot see a change to an instance-wide table | OK (code review) |
| Admin user routes (`/api/admin/users/*`) | Instance admin is now checked **before** the all-companies bypass scope opens (`routes/access.ts:5164`) | Sweep, for the `/admin/users/:userId/*` routes only: called with B's user id, a refused request would log a bypass row naming that id, and the sweep finds none. A refused `GET /admin/users` would log a row that names no company, which the sweep cannot see; that route rests on code review (it uses the same guard) | **FIXED** (audit log noise, low) |
| Company export | Builds only from the exporting company's own lists (`services/company-portability.ts:3244`) | Sweep (one call each; too slow to repeat for every field) and code review | OK |
| Cross-company instructions | Intentional channel, see below | `cross-company-instructions-routes.test.ts`, Audit | OK (note 2) |
| Telegram bridge | Runs as an instance-admin service; every CLI call passes the bot's own company (`-C`); roster and tokens are instance-admin only (`routes/telegram-bots.ts:268`, `:314`) | Code review (Python service, outside the app) | **GAP**, medium (note 1) |
| Database RLS | See above | `packages/db/src/rls-login-roles.test.ts` | **GAP**, medium. Not enforced until the cutover is done |

## Intentional cross-company channels

1. **Cross-company instructions** (`server/src/routes/cross-company-instructions.ts`,
   `server/src/services/cross-company-instructions.ts`).
   - *Off by default*: the instance setting `enableCrossCompanyInstructions`
     defaults to `false` (`services/cross-company-instructions.ts:108`).
   - *Explicit*: only the instruction text crosses. It goes to the receiving
     company's single liaison (the one active agent with role `tech_boss`,
     `:126`) as an **approval card**, and nothing happens until that company's
     board approves.
   - *Redacted*: the sender sees only its own side and the outcome, never the
     receiver's approval id, liaison, task or decision note (`:328`).
   - *Audited*: the crossing runs in a logged bypass scope
     (`cross_company_access_log`), and each side gets an activity entry.
   - It does not reveal which companies exist: "missing" and "cannot
     receive" give the same answer.
2. **Instance-admin surfaces**: the admin user and company-access routes,
   `/api/instance/*`, the Telegram roster and tokens, and the cross-company
   access log viewer (`/api/instance/cross-company-access`). All are instance
   admin only, and the bypass routes write `cross_company_access_log`.
3. **Instance-wide shared resources** with no company data: execution
   environments (redacted for non-admins), the static skills catalogue,
   adapter and model capability lists, and the `llms` help texts. Instance
   admin changes to environments or admins are announced in every company's
   Activity feed.
4. **Background schedulers** that loop over companies use logged bypass
   scopes (`cross-company-scheduler-bypass-silencing.test.ts` covers the
   noise control).

## Open gaps and recommended fixes

1. **Telegram bridge allow-list falls back across companies (medium).**
   `scripts/telegram-bridge.py:301` (`allowed_users_for`). A bot whose
   per-bot list in the app is empty falls back to the instance-wide list,
   which is either `TELEGRAM_ALLOWED_USER_IDS` or, failing that, every private
   chat that has ever talked to any bot (`:884`). So a Telegram user allowed
   for a Durkan bot can use a Nordstrand bot that has no list of its own: ask
   it about Nordstrand data and press its Approve buttons, which run with the
   operator's board rights. *Fix:* give every company bot its own list (the
   app already supports it). Then, in the bridge, limit the fallback to people
   allowed on bots of the **same company**, or refuse to serve a bot with an
   empty list. Show a warning in the bot settings when the list is empty. Not
   changed here, because it is a behaviour change for a separately deployed
   service and could lock the operator out of existing bots.
2. **Cross-company instruction receivers opt in implicitly (low).** With the
   instance flag on, any company with exactly one active `tech_boss` agent
   can receive instructions, and any other company can file approval cards
   into its queue. The board approval contains the damage, but a company
   cannot say "only from these companies". *Fix:* a per-company "accept
   instructions from" list, empty by default.
3. **Refusal records land in the target company's feed (info).** When A
   tries to touch B's issue, the denial is logged in **B's** Activity (for a
   user) or A's (for an agent). That is the right audit behaviour and copies
   no content, but repeated attempts can add noise to B's feed. *Fix (if it
   becomes a problem):* rate-limit identical refusal entries.
4. **Plugins are trusted instance code (info).** A plugin worker can pass any
   `companyId` to host services. Isolation for plugin pages therefore depends
   on the host's bridge check plus the plugin's own care. Media Studio does
   this correctly. *Fix (larger):* pin a worker's host-service calls made
   while it serves a bridge request to that request's company.
5. **Telegram bridge default company (low).** `scripts/telegram-bridge.py:72`
   falls back to a hard-coded company id for a legacy file bot that names no
   company. *Fix:* refuse such bots instead.
6. **RLS not enforced until the cutover (medium).** See above. *Fix:* finish
   `docs/rls-cutover-runbook.md`, scope-wiring the 37 raw-db route files
   first.

## The automated proof (how the sweep works)

`server/src/__tests__/cross-company-isolation-sweep.test.ts` (embedded
Postgres, runs in about 5 minutes):

- It builds the real app with `createApp` and records every route the server
  registers (about 900). It uses the same recorder as
  `company-service-token-every-route.test.ts`, so a new route is covered
  automatically.
- It seeds companies A and B with one of each: agent, goal, project, issue,
  comment, label, document, secret, approval, routine, heartbeat run, activity
  entry, cost event, asset, company skill, agent memory, model-catalogue
  entry, report script, persona, CRM contact, pipeline, video storyline,
  watcher and job. Every text field of B carries a tracer, and B's secret has a
  unique value.
- **Sweep 1.** Every route, as A's owner key, A's agent key and A's service
  token. First with B's ids everywhere in the URL, then with A's company in
  the URL but B's record ids (the classic "checks the company, loads by id"
  hole). Every GET also carries `?q=` with a prefix that both companies'
  data share.
- **Sweep 2.** Every POST, PUT and PATCH that A can call on its own records
  is called again once per reference field (about 40: `assigneeAgentId`,
  `projectId`, `goalIds`, `parentId`, `labelIds`, `secretId`, ...), each time
  with that one field pointing at B's record.
- **Assertions.** No answer contains B's tracer or secret value. Every
  database row that mentions B is unchanged, and no new row mentions B except
  refusal audit entries. No B-company URL answers 2xx except the two
  instance-wide environment reads.
- If a probe logs A's credential out (for example
  `POST /api/cli-auth/revoke-current`), the test issues a new one and
  repeats the probe, so later routes are not silently skipped.

Known limits of the sweep:

- Route parameters for record types it does not seed (plugin ids,
  workspaces, mail accounts, Telegram bots, data connections, ...) get random
  ids. Those routes are still checked for refusals and leaks, but not against
  a real B record.
- Sweep 2 only reaches the roughly 70 write routes that accept a generic
  body. The others need route-specific bodies; the hand-written Audit test
  covers the important ones.
- The database check only sees rows that mention B (by one of B's ids or its
  tracer). A change to an instance-wide table (instance settings, plugins,
  environments) does not mention B, so the sweep cannot detect it.
- The websocket (handshake and live events) and the Telegram bridge run
  outside Express, and the sweep does not listen for live events. They are
  covered by code review, not by the sweep. `live-events-ws.test.ts` tests
  only upgrade-socket error handling.
