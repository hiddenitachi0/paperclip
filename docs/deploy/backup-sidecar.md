---
title: Backup Service (database dumps out of agents' reach)
summary: Move the hourly database dumps into a separate container that writes to a host folder the server and the agents cannot see
---

Agents run as the same Linux user as the server, so every hourly dump the
server wrote to `/paperclip/instances/default/data/backups` could be read, and
deleted, by any agent. No file permission can change that while the server is
the one writing. This overlay moves the job into its own container:

- the `backup` service uses the same `postgres:17-alpine` image as `db`, with
  **no `/paperclip` mount**; the server has no mount of the dump folder;
- it writes `paperclip-YYYYMMDD-HHMMSS.sql.gz` (same name, same format, UTC) to
  a host folder, `/root/paperclip-backups` by default (root-owned, mode `0700`);
- the server's own scheduled backup is switched off
  (`PAPERCLIP_DB_BACKUP_MANAGED_EXTERNALLY=true`, set by the overlay).

Without the overlay nothing changes: the server keeps making its own dumps.

The dumps were readable by agents from the day backups started until you move
them. Treat everything in the old folder as exposed.

## What it does

`scripts/backup-sidecar.sh` runs inside the container:

- every `BACKUP_INTERVAL_MINUTES` (60) it runs
  `pg_dump --format=plain --clean --if-exists --no-owner --no-privileges | gzip`,
  the same arguments as `packages/db/src/backup-lib.ts`;
- it writes to a hidden temp file and renames it into place, so a half-written
  dump is never listed, pruned around or copied offsite;
- on any failure (pg_dump, gzip, disk full) it deletes the temp file, keeps
  nothing, does **not** prune, and exits non-zero (Docker restarts the
  container and retries);
- after a good dump it prunes with the same tiers as `selectBackupsToDelete`:
  everything from the last 48 hours, then the newest per day, per ISO week and
  per month, back to the retention windows. The windows come from **Instance
  Settings** (the retention buttons in the UI) on every run; if the database
  cannot be asked, the `PAPERCLIP_BACKUP_DAILY_DAYS` / `_WEEKLY_WEEKS` /
  `_MONTHLY_MONTHS` values (7 / 4 / 1) are used;
- the container has a health check: unhealthy when the last good dump is older
  than two intervals plus 15 minutes (`docker compose ps`).

The container runs as root *inside its own container* (it must write a root
`0700` folder and read a root-only login file) with every Linux capability
dropped, `no-new-privileges` and a read-only root filesystem. Nothing is shared
with the server or the agents.

## Set up (operator, on the host, as root)

Do not paste the password anywhere except the file below.

1. **Create the folder.**

   ```sh
   install -d -m 0700 -o root -g root /root/paperclip-backups
   ```

2. **Create a read-only database login for dumps.** `BYPASSRLS` is required,
   otherwise row-level security would make a dump silently incomplete;
   `pg_read_all_data` lets it read everything and write nothing.

   ```sh
   BACKUP_PW="$(openssl rand -hex 24)"
   docker compose --env-file .env -f docker/docker-compose.yml -f docker/docker-compose.prod.yml \
     exec -T db psql -U paperclip -d paperclip -v ON_ERROR_STOP=1 \
     -c "CREATE ROLE paperclip_backup LOGIN PASSWORD '$BACKUP_PW' BYPASSRLS" \
     -c "GRANT pg_read_all_data TO paperclip_backup"
   ```

3. **Put the login in a root-only file** (same pattern as the server's
   `/root/paperclip-secrets/server.env`):

   ```sh
   install -d -m 0700 /root/paperclip-secrets
   ( umask 077; printf 'PGUSER=paperclip_backup\nPGPASSWORD=%s\n' "$BACKUP_PW" > /root/paperclip-secrets/backup.env )
   chmod 0400 /root/paperclip-secrets/backup.env
   unset BACKUP_PW
   ```

   Only `PGUSER` and `PGPASSWORD` are read. The file is mounted as the Docker
   secret `/run/secrets/paperclip_backup`; the password is not in the image,
   `docker inspect`, the compose files or the logs.

4. **Move the existing dumps** to the new folder, then delete the originals
   (they are in the `paperclip-data` volume, so run this in the server
   container; check the copy before deleting):

   ```sh
   DC="docker compose --env-file .env -f docker/docker-compose.yml -f docker/docker-compose.prod.yml -f docker/docker-compose.browser.yml -f docker/docker-compose.crawl4ai.yml"
   SERVER="$($DC ps -q server)"
   docker cp "$SERVER:/paperclip/instances/default/data/backups/." /root/paperclip-backups/
   ls -l /root/paperclip-backups | head          # the same files, the same sizes
   $DC exec -T -u root server sh -c 'rm -f /paperclip/instances/default/data/backups/paperclip-*.sql*'
   ```

   (If the secrets overlay is already in use, add `-f docker/docker-compose.secrets.yml`
   to `DC`; it applies to the `backup` overlay below as well.)

5. **Start with the overlay** (add the file to the deploy's compose file list,
   last):

   ```sh
   $DC -f docker/docker-compose.backup.yml up -d
   ```

   The server restarts with `PAPERCLIP_DB_BACKUP_MANAGED_EXTERNALLY=true`; the
   `backup` container makes its first dump right away.

6. **Check it** (see "Verify" below), then re-point the offsite job (next
   section).

Optional settings (in the root `.env`): `PAPERCLIP_BACKUP_DIR`
(default `/root/paperclip-backups`), `PAPERCLIP_BACKUP_SECRETS_FILE`
(`/root/paperclip-secrets/backup.env`), `PAPERCLIP_BACKUP_INTERVAL_MINUTES`
(60), `PAPERCLIP_BACKUP_DAILY_DAYS`, `PAPERCLIP_BACKUP_WEEKLY_WEEKS`,
`PAPERCLIP_BACKUP_MONTHLY_MONTHS`.

## Re-point the offsite job

The host job that copies the dumps offsite (the Storage Box job) must now read
**`/root/paperclip-backups`**. After you change it:

- confirm its source list contains **only** that folder: no
  `secrets/master.key`, no `/paperclip` volume, no `docker/.env`, no
  `/root/paperclip-secrets`;
- run it once and list what arrived offsite; there must be no key material in
  it. Dumps hold the encrypted company secrets; the master key must never sit
  next to them (see [Secrets master key move](/deploy/secrets-master-key-move)).

## Verify

```sh
# A fresh dump, written by the backup container, and none in the server's volume
ls -l /root/paperclip-backups | tail -3
docker compose ... ps backup                       # healthy
docker compose ... logs --tail 5 backup            # "dump complete: ..." and "retention ..."
docker compose ... exec -T server sh -c 'ls -A /paperclip/instances/default/data/backups; find /paperclip -name "paperclip-*.sql*" | head'   # prints nothing
```

Then run the isolation probe as an agent with stage 6 enforced
(`PROBE_ENFORCED_STAGES="0 1 2 6" sh scripts/isolation-probe.sh`). It must print
`PASS 6 server-only-path .../data/backups` and
`PASS 6 backup-dump-under-home /paperclip`. A dump anywhere under `/paperclip`
makes it report `LEAK 6`.

## Restore from a dump

The dump is the same plain SQL as before; restore it with `psql`. Do this with
the server stopped (or into a fresh database to look first):

```sh
# Into a scratch database, to check a dump:
docker compose ... exec -T db createdb -U paperclip restore_check
gunzip -c /root/paperclip-backups/paperclip-YYYYMMDD-HHMMSS.sql.gz \
  | docker compose ... exec -T db psql -U paperclip -d restore_check -v ON_ERROR_STOP=1 -q

# Over the live database (stop the server first; the dump drops and recreates objects):
docker compose ... stop server
gunzip -c /root/paperclip-backups/paperclip-YYYYMMDD-HHMMSS.sql.gz \
  | docker compose ... exec -T db psql -U paperclip -d paperclip -v ON_ERROR_STOP=1 -q
docker compose ... start server
```

Use the owner login (`paperclip`) to restore, not `paperclip_backup`. The CI
acceptance run (`ISOLATION_BACKUP_SIDECAR=1 scripts/agent-isolation-acceptance.sh`)
restores a sidecar dump into a fresh database this way on every change.

Do not use `paperclipai db:backup` inside the server container on a setup with
this overlay: it writes into the agent-visible folder again.

## What you lose

- **The manual "run backup now" and the live backup-size figures.** With the
  overlay, `POST /api/instance/database-backups` and
  `GET /api/instance/database-backups/stats` answer `409` with the message
  "Database backups are managed by the separate backup service" (code
  `backup_managed_externally`) and do not touch any folder. To take a dump now:
  `docker compose ... exec -T backup sh /usr/local/bin/backup-sidecar.sh once`.
  A later card can add the button back through the service.
- One more container.

## Roll back

Remove `-f docker/docker-compose.backup.yml` from the compose list and
`docker compose ... up -d --remove-orphans`. The server's own backup resumes
(no flag), writing to `data/backups` again, and the agent-visible-dump gap is
back. The dumps in `/root/paperclip-backups` stay where they are.
