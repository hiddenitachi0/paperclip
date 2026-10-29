---
title: Moving the Secrets Master Key
summary: Move the local_encrypted master key out of the agent-readable key file and into the root-only server key file
---

Agent runs share a Linux user with the server, so they can read the key file at
`/paperclip/instances/default/secrets/master.key` (a path **inside the server
container**). This runbook moves the same
key into the root-only server key file, `/root/paperclip-secrets/server.env`,
where the container entrypoint hands it to the server through a private pipe.

You are **moving** the key, not rotating it. The key value stays exactly the
same, so every existing secret keeps decrypting.

**Never paste the key into a task, a comment, a chat or a log.** Do every step
below on the host, as root, in a terminal, from the repo root. Do not echo the
key and do not include it in any command output you share.

`/paperclip` is the `paperclip-data` named volume, so it does not exist as such
on the host. Every command that touches the key file therefore runs inside the
server container as root, through the `DC` shortcut below. `DC` is the exact
command `scripts/deploy-prod.sh` uses (including `--env-file .env`, so the
server still gets the root `.env` settings); only the secrets overlay differs
between the two variants.

## Before you start

- The secrets overlay is described in `docker/docker-compose.secrets.yml`. It
  blanks the server key names in the container settings and sets
  `PAPERCLIP_SECRETS_REQUIRE_ENV_KEY=true`, so a missing key makes the
  provider fail with an error instead of creating a new key file.
- Define the shortcuts for this terminal session. `DC` is the deploy as it runs
  today, `DC_SECRETS` is the same plus the overlay:

  ```sh
  KEY_FILE=/paperclip/instances/default/secrets/master.key
  DC="docker compose --env-file .env -f docker/docker-compose.yml -f docker/docker-compose.prod.yml"
  DC_SECRETS="$DC -f docker/docker-compose.secrets.yml"
  ```

- Make a root-only backup of the current key file on the host. Keep it until
  the last step. The `umask` makes the backup unreadable to anyone but root, and
  nothing is printed.

  ```sh
  install -d -m 0700 /root/paperclip-secrets/backup
  (umask 0377; $DC exec -T -u root server cat "$KEY_FILE" \
    > /root/paperclip-secrets/backup/master.key)
  test -s /root/paperclip-secrets/backup/master.key && echo backup ok
  ```

## Steps

1. **Add the key to the server key file.** Open
   `/root/paperclip-secrets/server.env` in an editor as root and add one line,
   `PAPERCLIP_SECRETS_MASTER_KEY=<same value as the master.key file>`. Copy the
   value from the file in the editor; do not type it into a shell command.
   Keep the file at mode `0400`, owned by root.
2. **Bring the server up with the secrets overlay.**

   ```sh
   $DC_SECRETS up -d
   ```

3. **Check the key source.** Call
   `GET /api/companies/{id}/secret-providers/health` as a board user. The
   `local_encrypted` entry must show `status: "ok"` and
   `details.keySource: "env"`. If it shows `status: "error"` and
   `keySource: "missing"`, the server did not receive the key: re-check step 1
   and the overlay, and see Rollback.
4. **Check an existing secret still resolves.** In `Company Settings >
   Secrets`, use the Test button on a secret that is already stored (or run any
   agent that uses one). A decryption failure means the value in `server.env`
   differs from the old key: stop and use Rollback.
5. **Only now, remove the old copies.**
   - the key file inside the container (this removes it from the volume):

     ```sh
     $DC_SECRETS exec -T -u root server rm -f "$KEY_FILE"
     $DC_SECRETS exec -T -u root server test ! -e "$KEY_FILE" && echo key file gone
     ```

   - any copy of that file inside volume backups or snapshots (agents can read
     those too)

   Keep `/root/paperclip-secrets/backup/master.key` until step 6 passes.
6. **Run the isolation probe.**

   ```sh
   PROBE_ENFORCED_STAGES=3 scripts/isolation-probe.sh
   ```

   Expect `PASS 3 master-key-readable`. After it passes, delete the root-only
   backup from "Before you start" **only if** `server.env` is itself backed up (see below).

## Rollback

If anything in steps 3 to 6 fails:

1. Put the file back from the root-only backup, **owned by the server user**
   (`node`, uid/gid 1000). A root-owned file cannot be read by the server and
   every secret would fail to resolve:

   ```sh
   $DC_SECRETS exec -T -u root server sh -c \
     'umask 0177; cat > "$1" && chown 1000:1000 "$1"' _ "$KEY_FILE" \
     < /root/paperclip-secrets/backup/master.key
   $DC_SECRETS exec -T -u root server stat -c '%U:%G %a' "$KEY_FILE"
   ```

   The last command must print `node:node 600`. If the server container is
   not running, start it first (`$DC_SECRETS up -d`; it will report the key as
   missing, which is fine for this step) or write the file at the volume's host
   path (`docker volume inspect <project>_paperclip-data -f '{{.Mountpoint}}'`)
   with `install -o 1000 -g 1000 -m 0600`.

2. Bring the server up without the secrets overlay, so
   `PAPERCLIP_SECRETS_REQUIRE_ENV_KEY` is no longer set and the provider reads
   the file again:

   ```sh
   $DC up -d
   ```

3. Re-run the health check; it must show `keySource: "file"`.
4. Use the Test button on an existing stored secret (as in step 4). It must
   pass. A health check alone does not prove the file is readable by the
   server user with the right content.

## After the move

`/root/paperclip-secrets/server.env` is now the **only copy** of the master
key. The database alone cannot restore the secrets, and neither can a backup
without this file. Back up `server.env` to a place agents cannot read (a
root-only location or an offline store), separately from the database backups.
Never copy it into a volume or snapshot that agents can mount.

Do not run `paperclipai onboard` or `paperclipai configure` inside the server
container after the move. They do not know about
`PAPERCLIP_SECRETS_REQUIRE_ENV_KEY` and would create a fresh, agent-readable
`master.key`. The server ignores that file while the flag is on, but it would
make the isolation probe fail `master-key-readable` again. If it happens,
delete the new file as in step 5.
