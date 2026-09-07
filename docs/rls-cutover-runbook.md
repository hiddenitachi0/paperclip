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
   added in migrations 0149/0150/0160) **do not apply to it**. Postgres never
   applies those rules to a superuser or to the owner of a table.

This runbook replaces that single login with two limited ones, both created by
migration 0160 and both without a password until you set one:

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
  `0160_rls_login_roles`). When the server starts it applies the migration
  automatically and then prints one log line that starts with
  **"Database credential check (RLS cutover posture)"**. That line is your
  dashboard for this whole runbook: it names the login the app is using
  (`appRole`), what kind of login it is (`appPosture`), and the same for the
  bypass pool. Lines that follow it explain the situation in plain words. If it
  prints anything at `error` level, stop and read it.
- You need a shell on the production box and the compose command that box
  uses. Throughout, `COMPOSE` stands for:

  ```bash
  cd /path/to/paperclip   # the checkout the deploy runner uses
  COMPOSE="docker compose --env-file .env -f docker/docker-compose.yml -f docker/docker-compose.prod.yml"
  ```

  and `PSQL` stands for a psql session as the owner login:

  ```bash
  $COMPOSE exec db psql -U paperclip -d paperclip
  ```

- Read the "What to check" list of each step before doing it, so you know what
  "working" looks like.

Keep a note of the current line in `.env` (or the value baked into
`docker/docker-compose.yml`, `postgres://paperclip:paperclip@db:5432/paperclip`)
-- that is your rollback value for every step.

## Step 1 -- give the two new logins a password (no restart needed)

The migration created both logins **without** a password so that it could ship
safely: a login with no password cannot connect at all. You choose the
passwords.

1. Make two strong passwords and keep them in your password manager:

   ```bash
   openssl rand -base64 30   # run twice, one per login
   ```

2. Set them in the database (replace the placeholders; keep the single quotes):

   ```sql
   ALTER ROLE paperclip_app_bypass_login PASSWORD '<bypass password>';
   ALTER ROLE paperclip_app_scoped_login PASSWORD '<scoped password>';
   ```

3. What to check -- from the same psql session:

   ```sql
   SELECT rolname, rolcanlogin, rolsuper,
          pg_has_role(rolname, 'paperclip_app_scoped', 'member') AS scoped,
          pg_has_role(rolname, 'paperclip_app_bypass', 'member') AS bypass
   FROM pg_roles WHERE rolname LIKE 'paperclip_app_%_login';
   ```

   Expected: two rows, `rolcanlogin = t`, `rolsuper = f`, the bypass login has
   `bypass = t, scoped = f`, the scoped login has `scoped = t, bypass = f`.
   If a login shows `t` in **both** columns, stop: that violates the isolation
   design. Run `REVOKE paperclip_app_bypass FROM paperclip_app_scoped_login;`
   and check again.

Nothing in the running app has changed yet.

## Step 2 -- move background work and backups onto the new logins

This step keeps `DATABASE_URL` exactly as it is. It only tells the app to use
the bypass login for the background scheduler and instance-wide operations,
and the owner login for migrations and backups.

1. Add to `.env` (the file next to the compose command; never commit it):

   ```
   DATABASE_MIGRATION_URL=postgres://paperclip:paperclip@db:5432/paperclip
   DATABASE_BYPASS_URL=postgres://paperclip_app_bypass_login:<bypass password>@db:5432/paperclip
   ```

   If the password contains characters like `@`, `/`, `:` or `#`, percent-encode
   them (for example `@` becomes `%40`) or generate a password without them.

2. Restart the server container:

   ```bash
   $COMPOSE up -d --force-recreate server
   ```

3. What to check:
   - `$COMPOSE logs --since 5m server | grep -A6 "Database credential check"`
     shows `bypassRole: "paperclip_app_bypass_login"`, `bypassPosture: "bypass-login"`,
     `sharedCredential: false`, and no `error` lines after it.
   - Within two scheduler ticks (about a minute) the audit table has rows from
     the scheduler again:

     ```sql
     SELECT route, max(occurred_at) FROM cross_company_access_log
     WHERE actor_type = 'scheduler' GROUP BY route ORDER BY 2 DESC;
     ```

     Every route listed should have a timestamp from after the restart.
   - Wake an agent (any agent's "Run now") and confirm it runs to completion.
   - Sign out and sign back in to the dashboard.
   - Trigger a manual database backup from Instance Settings and confirm it
     completes (backups now run with `DATABASE_MIGRATION_URL`).

4. Rollback: remove the two lines from `.env` and run the restart command
   again. The app is then exactly as before this step.

## Step 3 -- take the app off the superuser login

This is the step that actually reduces the damage a leaked `DATABASE_URL` can
do: after it, the login the app uses day to day can still see every company
(so nothing changes for users), but it can no longer alter tables, create
roles, or do anything else only the owner can.

1. In `.env`, add (or replace the existing line):

   ```
   DATABASE_URL=postgres://paperclip_app_bypass_login:<bypass password>@db:5432/paperclip
   ```

   `DATABASE_MIGRATION_URL` **must** stay on the `paperclip` owner login from
   step 2 -- migrations cannot run as the bypass login.

2. Restart:

   ```bash
   $COMPOSE up -d --force-recreate server
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
     `DATABASE_MIGRATION_URL`; a pending migration must apply cleanly).

4. Rollback: put the previous `DATABASE_URL` line back (or delete the line so
   the compose default applies) and restart.

5. Once step 3 has been stable for a day, change the `paperclip` owner
   password, because that is the login that was exposed in DUR-244:

   ```sql
   ALTER ROLE paperclip PASSWORD '<new owner password>';
   ```

   then update `DATABASE_MIGRATION_URL` in `.env` to the new password and
   restart. (The `POSTGRES_PASSWORD` value in `docker/docker-compose.yml` is only
   used the very first time the database volume is created; it does not need
   to match afterwards, but update it too so a future re-create is consistent.)
   Anything else on the box that used the old owner password -- the standalone
   backup script, ad-hoc psql -- must be updated at the same time.

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
full day on step 3 with this extra line in `.env`, then restart:

```
PAPERCLIP_LOG_UNSCOPED_TENANT_ACCESS=1
```

and afterwards search the server log for
`unscoped query touched tenant table`. Each such warning names one table that
some code path reads without a company scope. When a full day of normal use
(dashboard, agents running, a deploy, a backup) produces **no** such warnings
from `applicationName="paperclip-app"`, step 4 is safe. Remove the line again
afterwards -- it costs a little performance.

When the gate is passed, step 4 is:

1. `.env`: `DATABASE_URL=postgres://paperclip_app_scoped_login:<scoped password>@db:5432/paperclip`
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

to `.env`. From then on the server refuses to start if the logins cannot work
together (for example the scoped login as `DATABASE_URL` with no
`DATABASE_BYPASS_URL`), and prints exactly what is wrong and which step of this
runbook fixes it, instead of starting up and showing an empty instance.

## If something goes wrong

- **Dashboard looks empty / lists are empty but no errors**: the app is on a
  login the database rules block. Roll back the last `.env` change and restart.
- **Scheduler stopped / agents never wake / log full of "not a member of
  paperclip_app_bypass"**: `DATABASE_BYPASS_URL` points at a login that cannot
  bypass. Set it to the bypass login (step 2) and restart.
- **"permission denied for table ..." in the log**: a table the new logins were
  not granted. Migration 0160 grants every table that exists when it runs and
  sets defaults for future ones, so this means a table was created outside a
  migration. As the owner: `GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO paperclip_app_scoped, paperclip_app_bypass_login;`
- **Migrations fail at startup with "must be owner"**: `DATABASE_MIGRATION_URL`
  is missing or not the owner login. Fix it and restart.
- **Backup fails**: same cause as the previous point; backups use
  `DATABASE_MIGRATION_URL`.
- **Lost a password**: set a new one with `ALTER ROLE ... PASSWORD '...'` as
  the owner and update `.env`.
