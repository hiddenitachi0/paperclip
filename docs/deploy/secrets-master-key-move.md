---
title: Moving the Secrets Master Key
summary: Move the local_encrypted master key out of the agent-readable key file and into the root-only server key file
---

Agent runs share a Linux user with the server, so they can read the key file at
`/paperclip/instances/default/secrets/master.key`. This runbook moves the same
key into the root-only server key file, `/root/paperclip-secrets/server.env`,
where the container entrypoint hands it to the server through a private pipe.

You are **moving** the key, not rotating it. The key value stays exactly the
same, so every existing secret keeps decrypting.

**Never paste the key into a task, a comment, a chat or a log.** Do every step
below on the host, as root, in a terminal. Do not echo the key and do not
include it in any command output you share.

## Before you start

- The secrets overlay is described in `docker/docker-compose.secrets.yml`. It
  blanks the server key names in the container settings and sets
  `PAPERCLIP_SECRETS_REQUIRE_ENV_KEY=true`, so a missing key makes the
  provider fail with an error instead of creating a new key file.
- Make a root-only backup of the current key file. Keep it until the last step.

```sh
install -d -m 0700 /root/paperclip-secrets/backup
install -m 0400 /paperclip/instances/default/secrets/master.key \
  /root/paperclip-secrets/backup/master.key
```

## Steps

1. **Add the key to the server key file.** Open
   `/root/paperclip-secrets/server.env` in an editor as root and add one line,
   `PAPERCLIP_SECRETS_MASTER_KEY=<same value as the master.key file>`. Copy the
   value from the file in the editor; do not type it into a shell command.
   Keep the file at mode `0400`, owned by root.
2. **Bring the server up with the secrets overlay.**

   ```sh
   docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml \
     -f docker/docker-compose.secrets.yml up -d
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
   - `/paperclip/instances/default/secrets/master.key`
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

1. Put the file back from the root-only backup:

   ```sh
   install -m 0600 /root/paperclip-secrets/backup/master.key \
     /paperclip/instances/default/secrets/master.key
   ```

2. Bring the server up without the secrets overlay (drop
   `-f docker/docker-compose.secrets.yml`), so
   `PAPERCLIP_SECRETS_REQUIRE_ENV_KEY` is no longer set and the provider reads
   the file again.
3. Re-run the health check; it should show `keySource: "file"`.

## After the move

`/root/paperclip-secrets/server.env` is now the **only copy** of the master
key. The database alone cannot restore the secrets, and neither can a backup
without this file. Back up `server.env` to a place agents cannot read (a
root-only location or an offline store), separately from the database backups.
Never copy it into a volume or snapshot that agents can mount.
