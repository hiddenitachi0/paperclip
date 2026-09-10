# Database isolation cutover (row-level security) — runbook

This is the operator-facing runbook for moving Paperclip onto database-enforced
company isolation. Today the app connects as the database user that owns every
table, and a table owner is exempt from the isolation rules. The cutover moves
the app onto two ordinary login users that are not exempt.

Nothing in this runbook happens automatically. Migrations create the users
without passwords, which means they cannot connect to anything until you give
them one by hand.

---

## Rehearse the migrations first — required before every deploy

**Never deploy a migration that has not been run against a copy of the real
database first.**

On 2026-09-09 a migration was written against the tables in this repository and
deployed straight to production. The production database also holds a client's
Django tables, whose `company_id` column is a whole number rather than an id.
The migration tried to compare the two, Postgres refused, the migration stopped
half-way, and the server could not start. It restarted in a loop until the
deploy was rolled back. Nothing in this repository could have caught that,
because this repository does not contain the client's tables — only a copy of
the real database does.

The rehearsal is that missing step. It restores a backup into a throwaway
database, runs the migrations there, and tells you plainly whether they worked:

```bash
# 1. Take (or fetch) a dump of the database you are about to migrate.
# 2. Rehearse against it, on your own machine — never against the live server:
pnpm db:rehearse --dump /path/to/backup.dump
```

What you will see:

- **PASSED** — every pending migration ran cleanly against a copy of the real
  data. Safe to deploy, as far as the database is concerned.
- **FAILED** — the name of the migration that failed and the exact message
  Postgres gave, plus a log file with the full detail. Do not deploy. Fix the
  migration and rehearse again.

Useful options: `--scratch-db <name>` to name the throwaway database (it must
start with `rehearsal_`), `--admin-url <url>` to point at a Postgres server
other than a local one, and `--keep` to leave the throwaway database behind so
you can look inside it.

The script refuses to run if the target looks like a real database: the scratch
name must start with `rehearsal_`, it will not use the URL your app runs on, and
it will not touch a non-local server unless you explicitly set
`PAPERCLIP_REHEARSAL_ALLOW_REMOTE=1`.

CI runs `node --test scripts/__tests__/rehearse-migrations.test.mjs`, which
checks the script itself (its safety refusals, its reporting, and that it names
the failing migration). CI deliberately does **not** run the rehearsal itself —
that needs a dump of real data, which never belongs in CI.

---

## The two database users

| User | What it sees | Used for |
| --- | --- | --- |
| `paperclip_app_scoped_login` | only the company the current request is for | ordinary app traffic |
| `paperclip_app_bypass_login` | every company | migrations' successor tasks, backups, and the schedulers that legitimately work across companies |

Neither user is an administrator, neither owns any table, and neither can create
or change tables. Every use of the second one is written to the
`cross_company_access_log` table so cross-company access stays visible.

## Cutover steps

1. **Rehearse and deploy the migrations** (see above). This creates the two
   users, with no password, and finishes the isolation rules on the tables added
   since the first isolation migration.
2. **Give each user a password**, by hand, on the database server:

   ```sql
   ALTER ROLE paperclip_app_scoped_login PASSWORD '<a long random password>';
   ALTER ROLE paperclip_app_bypass_login PASSWORD '<a different long random password>';
   ```

   Store both in the instance's secrets, never in the repository.
3. **Point `DATABASE_BYPASS_URL` at `paperclip_app_bypass_login`** and restart.
   Nothing changes in what the app can see; this only gets the cross-company
   code paths off the owner credential.
4. **Point `DATABASE_URL` at `paperclip_app_bypass_login`** and restart. Still no
   change in what the app can see, but the app is now off the owner credential
   entirely, so a stray script or a leaked connection string can no longer
   quietly read everything by owning the tables.
5. **Watch `cross_company_access_log`** for a few days. Every entry is a code
   path that genuinely reads across companies. Each one must be understood
   before step 6.
6. **Point `DATABASE_URL` at `paperclip_app_scoped_login`** and restart. From
   this moment the database itself refuses to return another company's rows to
   ordinary request traffic.

Steps 3, 4 and 6 are each reversible by putting the old connection string back
and restarting.

## Notes and known limits

- Migrations keep running as the owner, through `DATABASE_MIGRATION_URL`.
  Neither new user can change the database structure.
- The migration only ever touches tables this codebase defines, by name. Tables
  belonging to another application in the same database are left completely
  alone — not read, not changed, not granted to the Paperclip users.
- One exception worth knowing: the migration also says "anything this owner
  creates from now on is readable by the two Paperclip users". If another
  application ever creates its tables **as the same database owner**, its new
  tables would inherit that permission. If that ever becomes the case, tell the
  other application to use its own database user.
