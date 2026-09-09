---
title: Database credential cutover (company isolation)
summary: Step-by-step guide to move the app off the all-powerful database login, in small reversible steps
---

# Database credential cutover (company isolation)

Tickets: DUR-244 (the problem), DUR-3945 (this cutover), DUR-247 / DUR-250 (the database rules this relies on).

## Why you are doing this

Today the app talks to the database as the login `paperclip`. That login is the
database *superuser* and it *owns* every table. Two things follow from that:

1. Anything that gets hold of that login (a leaked `DATABASE_URL`, a script, an
   agent that shouldn't have it) can read and change **every company's data**,
   and can change the database structure itself.
2. The company-isolation rules already in the database (row-level security,
   added in migrations 0149/0150/0164) **do not apply to it**. Postgres never
   applies those rules to a superuser or to the owner of a table.

This runbook replaces that single login with two limited ones, both created by
migration 0164 and both without a password until you set one:

| Login | Can see | Can change tables' structure? | Used for |
|---|---|---|---|
| `paperclip_app_bypass_login` | every company (needed for the background scheduler, sign-in/claim flows, admin lists) | No | `DATABASE_BYPASS_URL`, and as a first step also `DATABASE_URL` |
| `paperclip_app_scoped_login` | **only the company each request is for** | No | `DATABASE_URL`, final step (gated -- see step 4) |
| `paperclip` (existing) | everything, owns everything | Yes | `DATABASE_MIGRATION_URL` only: schema migrations and backups |

Every step below is reversible on its own by putting the previous `.env` line
back and restarting the server container. Nothing here deletes data or changes
the database structure; the migration only adds roles and permissions.

## Before you start

- This change must be deployed first (the branch with migration
  `0164_rls_login_roles`). When the server starts it applies the migration
  automatically and then prints one log line that starts with
  **"Database credential check (RLS cutover posture)"**. That line is your
  dashboard for this whole runbook: it names the login the app is using
  (`appRole`), what kind of login it is (`appPosture`), and the same for the
  bypass pool. Lines that follow it explain the situation in plain words. If it
  prints anything at `error` level, stop and read it.

- **How commands are run.** You run commands on the production box through
  `psh.sh`, which takes one command string and runs it there. Every command in
  this runbook is therefore written as a single line you can pass as that
  string. The checkout the deploy runner uses is `/root/paperclip` (that path
  is hard-wired in `deploy/systemd/paperclip-deploy-runner.service`). The two
  containers are called `docker-db-1` (the database) and `docker-server-1`
  (the app); `docker ps` lists them.

  Every SQL snippet in this runbook is run through the database container as
  the owner login, like this -- put the SQL between the double quotes and
  leave the single quotes inside the SQL exactly as written:

  ```bash
  docker exec docker-db-1 psql -U paperclip -d paperclip -c "<sql>"
  ```

  Reading the server log is:

  ```bash
  docker logs --since 10m docker-server-1 2>&1 | grep -A6 "Database credential check"
  ```

  Restarting the server container (every step ends with this) is:

  ```bash
  cd /root/paperclip && docker compose --env-file <ENV FILE> -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d --force-recreate server
  ```

  where `<ENV FILE>` is the file the next point tells you to use.

- **Which `.env` file counts -- check this before you edit anything.** The
  deploy runner (`scripts/deploy-runner.sh`) does not know about this runbook.
  It builds its own `docker compose` command from the project's deploy
  policy: if `deployPolicy.envFile` is set it passes `--env-file <that
  file>`; if it is not set, docker compose uses its default, which is the file
  named `.env` in the directory of the *first* compose file it was given (with
  `-f docker/docker-compose.yml` that is `/root/paperclip/docker/.env`; with no
  compose files configured at all it is `/root/paperclip/.env`). The dashboard
  does not show this field, so read it from the database:

  ```bash
  docker exec docker-db-1 psql -U paperclip -d paperclip -c "SELECT name, deploy_policy->>'envFile' AS env_file, deploy_policy->>'composeFiles' AS compose_files, deploy_policy->>'deployTargetPath' AS target FROM projects WHERE deploy_policy->>'enabled' = 'true';"
  ```

  The file you edit in the steps below **must be that `env_file`** (or the
  default described above when `env_file` is empty), and your restart line
  must name the same file. If you edit any other file, your manual restart
  picks up the new URLs but the **next automated deploy starts the server
  without them**, silently back on the old login -- and after step 3.5 (the
  password change) that is a server that cannot reach the database at all.

  Two ways to prove you edited the right file:

  1. Straight after your restart, this shows exactly what the running
     container was given (it prints passwords, so do not paste it anywhere):

     ```bash
     docker inspect docker-server-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^DATABASE_(BYPASS_|MIGRATION_)?URL='
     ```

  2. After the **first automated deploy** following each step, read the
     "Database credential check" log line again. It must still name the login
     you expect. If it went back to `paperclip`, the runner used a different
     env file: move your lines into the file the query above names and
     restart.

- Read the "What to check" list of each step before doing it, so you know what
  "working" looks like.

Keep a note of the current `DATABASE_URL` line in the env file (or, if there is
none, the value baked into `docker/docker-compose.prod.yml`,
`postgres://paperclip:paperclip@db:5432/paperclip`) -- that is your rollback
value for every step **until step 3.5 changes the owner password**; step 3.5
tells you the new rollback value.

## Step 1 -- give the two new logins a password (no restart needed)

The migration created both logins **without** a password so that it could ship
safely: a login with no password cannot connect at all. You choose the
passwords.

1. First confirm the logins exist:

   ```bash
   docker exec docker-db-1 psql -U paperclip -d paperclip -c "SELECT rolname, rolcanlogin, rolsuper, pg_has_role(rolname, 'paperclip_app_scoped', 'member') AS scoped, pg_has_role(rolname, 'paperclip_app_bypass', 'member') AS bypass FROM pg_roles WHERE rolname LIKE 'paperclip_app_%_login';"
   ```

   **If you get zero rows, migration 0164 has not run on this database: stop
   here.** The deploy that carries it has not happened yet (or failed at
   startup -- check the server log). Nothing below can work until the query
   returns two rows.

2. Make two strong passwords and keep them in your password manager:

   ```bash
   openssl rand -base64 30
   ```

   (run it twice, one per login). Avoid passwords containing `@`, `/`, `:`,
   `#` or `%`; they need extra encoding inside a URL. If you get one, just
   run the command again.

3. Set them in the database (replace the placeholders; keep the single
   quotes):

   ```bash
   docker exec docker-db-1 psql -U paperclip -d paperclip -c "ALTER ROLE paperclip_app_bypass_login PASSWORD '<bypass password>';"
   docker exec docker-db-1 psql -U paperclip -d paperclip -c "ALTER ROLE paperclip_app_scoped_login PASSWORD '<scoped password>';"
   ```

   **These two lines contain the passwords in clear text and are kept in
   shell history.** Clear that history right after you run them:

   - On your own machine, in the shell where you typed the `psh.sh` line
     (WSL bash): `history -c && history -w`. If you typed it in PowerShell:
     `Remove-Item (Get-PSReadlineOption).HistorySavePath`.
   - On the box, in case the command landed in root's history:
     `cat /dev/null > /root/.bash_history && history -c`.
   - Inside the database container, in case anyone ran the statement in an
     interactive psql instead of with `-c`:
     `docker exec docker-db-1 sh -c 'rm -f /root/.psql_history /var/lib/postgresql/.psql_history'`.

   If an `ALTER ROLE` fails (typo, wrong quotes), Postgres writes the failed
   statement -- password included -- into the database log. Choose a fresh
   password in that case rather than reusing the one that leaked into the log.

4. What to check -- run the query from point 1 again. Expected: two rows,
   `rolcanlogin = t`, `rolsuper = f`, the bypass login has
   `bypass = t, scoped = f`, the scoped login has `scoped = t, bypass = f`.
   If a login shows `t` in **both** columns, stop: that violates the isolation
   design. Run

   ```bash
   docker exec docker-db-1 psql -U paperclip -d paperclip -c "REVOKE paperclip_app_bypass FROM paperclip_app_scoped_login;"
   ```

   and check again.

Nothing in the running app has changed yet.

## Step 2 -- move background work and backups onto the new logins

This step keeps `DATABASE_URL` exactly as it is. It only tells the app to use
the bypass login for the background scheduler and instance-wide operations,
and the owner login for migrations and backups.

1. Add to the env file you identified in "Before you start" (never commit it):

   ```
   DATABASE_MIGRATION_URL=postgres://paperclip:paperclip@db:5432/paperclip
   DATABASE_BYPASS_URL=postgres://paperclip_app_bypass_login:<bypass password>@db:5432/paperclip
   ```

   If the password contains characters like `@`, `/`, `:` or `#`, percent-encode
   them (for example `@` becomes `%40`) or generate a password without them.

2. Restart the server container (same `<ENV FILE>` as above):

   ```bash
   cd /root/paperclip && docker compose --env-file <ENV FILE> -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d --force-recreate server
   ```

3. What to check:
   - `docker logs --since 10m docker-server-1 2>&1 | grep -A6 "Database credential check"`
     shows `bypassRole: "paperclip_app_bypass_login"`, `bypassPosture: "bypass-login"`,
     `sharedCredential: false`, and no `error` lines after it.
   - Within two scheduler ticks (about a minute) the audit table has rows from
     the scheduler again:

     ```bash
     docker exec docker-db-1 psql -U paperclip -d paperclip -c "SELECT route, max(occurred_at) FROM cross_company_access_log WHERE actor_type = 'scheduler' GROUP BY route ORDER BY 2 DESC;"
     ```

     Every route listed should have a timestamp from after the restart.
   - Wake an agent (any agent's "Run now") and confirm it runs to completion.
   - Sign out and sign back in to the dashboard.
   - Trigger a manual database backup from Instance Settings and confirm it
     completes (backups now run with `DATABASE_MIGRATION_URL`).
   - After the next automated deploy: the credential-check line still shows
     the bypass login (see "Which `.env` file counts").

4. Rollback: remove the two lines from the env file and run the restart line
   again. The app is then exactly as before this step.

## Step 3 -- take the app off the superuser login

This is the step that actually reduces the damage a leaked `DATABASE_URL` can
do: after it, the login the app uses day to day can still see every company
(so nothing changes for users), but it can no longer alter tables, create
roles, or do anything else only the owner can.

1. In the env file, add (or replace the existing line):

   ```
   DATABASE_URL=postgres://paperclip_app_bypass_login:<bypass password>@db:5432/paperclip
   ```

   `DATABASE_MIGRATION_URL` **must** stay on the `paperclip` owner login from
   step 2 -- migrations cannot run as the bypass login.

2. Restart:

   ```bash
   cd /root/paperclip && docker compose --env-file <ENV FILE> -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d --force-recreate server
   ```

3. What to check:
   - The "Database credential check" log shows `appRole: "paperclip_app_bypass_login"`,
     `appPosture: "bypass-login"`, followed by the note
     *"no longer the table owner or a superuser (good)"* and no `error` lines.
   - Open the dashboard: companies, issues, approvals and agents all show as
     before.
   - Create a comment on an issue, approve or reject one approval, wake an
     agent. All three must work.
   - Trigger a manual backup again.
   - Run the deploy flow once end to end with a harmless change (the deploy
     runner restarts the server, which re-runs migrations with
     `DATABASE_MIGRATION_URL`; a pending migration must apply cleanly). After
     it, the credential-check line must still show the bypass login.

4. Rollback: put the previous `DATABASE_URL` line back (or delete the line so
   the compose default applies) and restart. This "delete the line" shortcut
   only works **before** step 3.5.

5. (Step 3.5) Once step 3 has been stable for a day, change the `paperclip`
   owner password, because that is the login that was exposed in DUR-244:

   ```bash
   docker exec docker-db-1 psql -U paperclip -d paperclip -c "ALTER ROLE paperclip PASSWORD '<new owner password>';"
   ```

   then clear shell history exactly as in step 1, update
   `DATABASE_MIGRATION_URL` in the env file to the new password and restart.
   (The `POSTGRES_PASSWORD` value in `docker/docker-compose.yml` is only used
   the very first time the database volume is created; it does not need to
   match afterwards, but update it too so a future re-create is consistent.)
   Anything else on the box that used the old owner password -- the standalone
   backup script, ad-hoc psql -- must be updated at the same time.

   **Your rollback value has now changed.** The compose default
   `postgres://paperclip:paperclip@db:5432/paperclip` no longer works, because
   that password no longer exists. From this point on, if you ever have to
   roll `DATABASE_URL` back to the owner login, the line to put in the env
   file is exactly:

   ```
   DATABASE_URL=postgres://paperclip:<new owner password>@db:5432/paperclip
   ```

   Never roll back by *deleting* the `DATABASE_URL` line after this step: the
   compose default would apply and the server could not connect to the
   database at all. Update the note you took in "Before you start".

## Step 4 -- (GATED, do not do yet) bind the app itself to company isolation

The final state is `DATABASE_URL=...paperclip_app_scoped_login...`, where the
database itself refuses to show a request anything outside its own company.
**The application code is not ready for that yet.** When the app runs as the
scoped login, any code path that touches the database without first declaring
which company it is working for gets *zero rows back, with no error*. Doing
this step today would make parts of the dashboard look empty and break several
background jobs, silently.

What still has to happen before step 4 (engineering work, tracked under
DUR-277's remaining waves):

- These route files still use the database without declaring a company scope:
  `board-chat.ts`, `change-log.ts`, `chat-router.ts`, `cloud-upstreams.ts`,
  `company-import-paths.ts`, `customer-inbox.ts`, `deploy-runner.ts`,
  `environment-selection.ts`, `inbox-dismissals.ts`, `issues-checkout-wakeup.ts`,
  `lane-a.ts`, `org-chart-svg.ts`, `resource-memberships.ts`, `routines.ts`,
  `sidebar-badges.ts`, `user-profiles.ts`, plus the per-company halves of
  `companies.ts`, `environments.ts` and `plugins.ts` (documented as deferred in
  DUR-350).
- Startup and background code that reads across companies on the request
  pool: the local-trusted board bootstrap, the schedule-chain verification,
  the secret-surface scanner, feedback export, the plugin job scheduler and
  the heartbeat_runs retention sweep. Each needs to move to the bypass pool
  or declare a scope.

How you will know the gate is passed, without reading code: run the app for a
full day on step 3 with this extra line in the env file, then restart:

```
PAPERCLIP_LOG_UNSCOPED_TENANT_ACCESS=1
```

and afterwards search the server log for
`unscoped query touched tenant table`:

```bash
docker logs --since 24h docker-server-1 2>&1 | grep -c "unscoped query touched tenant table"
```

Each such warning names one table that some code path reads without a company
scope. When a full day of normal use (dashboard, agents running, a deploy, a
backup) produces **no** such warnings from `applicationName="paperclip-app"`,
step 4 is safe. Remove the line again afterwards -- it costs a little
performance.

When the gate is passed, step 4 is:

1. Env file: `DATABASE_URL=postgres://paperclip_app_scoped_login:<scoped password>@db:5432/paperclip`
   (keep `DATABASE_BYPASS_URL` and `DATABASE_MIGRATION_URL` from steps 2-3).
2. Restart. The credential check must show `appPosture: "scoped-login"`,
   `rlsBindsAppPool: true`, and the note *"Both credentials are in their final
   cutover positions"*.
3. Same checks as step 3, plus: as an agent from one company, use the API to
   read an issue that belongs to another company. You must get "not found",
   never the issue.
4. Rollback: switch `DATABASE_URL` back to the bypass login (step 3's value)
   and restart.

## Making the server refuse a bad combination

By default the credential check only logs. Once you are past step 2, add

```
PAPERCLIP_DB_ROLE_PREFLIGHT=strict
```

to the env file. From then on the server refuses to start if the logins cannot
work together (for example the scoped login as `DATABASE_URL` with no
`DATABASE_BYPASS_URL`), and prints exactly what is wrong and which step of this
runbook fixes it, instead of starting up and showing an empty instance.

**What a refusal looks like.** The server container starts, prints the
credential check, and exits. Because the production compose file sets
`restart: unless-stopped`, Docker starts it again immediately, so you see a
**restart loop**: `docker ps` shows `docker-server-1` as `Restarting` (or
flipping between `Up 3 seconds` and `Restarting`), the dashboard does not
load, and the deploy runner's health check fails. The reason is in the log:

```bash
docker logs --since 10m docker-server-1 2>&1 | grep -B8 "Refusing to start"
```

shows one `error` line per problem (each names the login concerned, what will
break, and what to change) followed by
*"Refusing to start: the database credentials cannot work together"*.

**The way out** is always the same two moves: remove (or comment out) the
`PAPERCLIP_DB_ROLE_PREFLIGHT=strict` line from the env file and recreate the
container with the restart line:

```bash
cd /root/paperclip && docker compose --env-file <ENV FILE> -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d --force-recreate server
```

The server then starts in log-only mode (same `error` lines, but it keeps
running), which gives you a working dashboard while you fix the URLs the
messages named. Put the `strict` line back once the credential check prints
no `error` lines.

## If something goes wrong

- **Dashboard looks empty / lists are empty but no errors**: the app is on a
  login the database rules block. Roll back the last env-file change and
  restart.
- **Server container restarting over and over, log says "Refusing to
  start"**: the strict preflight found a bad combination. See "What a refusal
  looks like" above -- remove the `strict` line, recreate, then fix the URLs.
- **Server container restarting, log says "password authentication failed
  for user paperclip"**: the running container got the compose default
  `DATABASE_URL` after the owner password was changed in step 3.5 -- almost
  always because an automated deploy used a different env file than the one
  you edited. Put your `DATABASE_*` lines into the file named by the query in
  "Which `.env` file counts" and restart.
- **Scheduler stopped / agents never wake / log full of "not a member of
  paperclip_app_bypass"**: `DATABASE_BYPASS_URL` points at a login that cannot
  bypass. Set it to the bypass login (step 2) and restart.
- **"permission denied for table ..." in the log**: a table the new logins were
  not granted. Migration 0164 grants every table that exists when it runs and
  sets defaults for future ones, so this means a table was created outside a
  migration. As the owner:

  ```bash
  docker exec docker-db-1 psql -U paperclip -d paperclip -c "GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO paperclip_app_scoped, paperclip_app_bypass_login;"
  ```

- **Migrations fail at startup with "must be owner"**: `DATABASE_MIGRATION_URL`
  is missing or not the owner login. Fix it and restart.
- **Backup fails**: same cause as the previous point; backups use
  `DATABASE_MIGRATION_URL`.
- **Lost a password**: set a new one with `ALTER ROLE ... PASSWORD '...'` as
  the owner (step 1 shows the exact command and the history clean-up), and
  update the env file.
