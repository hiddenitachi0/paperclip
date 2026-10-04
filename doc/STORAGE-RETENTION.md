# Storage retention: run logs and server.log

## Run logs (`data/run-logs`) — in-app

The server prunes `data/run-logs` itself (DUR-4498, `server/src/services/run-log-retention.ts`).

- Runs once at startup, then daily.
- Deletes regular files whose mtime is older than 30 days, then removes directories left empty (never the root).
- Override with `PAPERCLIP_RUN_LOG_RETENTION_DAYS=<n>`; `0` disables.
- Base dir follows `RUN_LOG_BASE_PATH` if set, else `<instance>/data/run-logs`.
- Safety: symlinks are never followed or removed, only regular files are unlinked, every path is checked to be strictly inside the base dir. Missing/empty dir is a no-op.

This replaces the one-off manual cleanup of 4 Oct (13,639 old run logs).

## server.log — host logrotate (chosen over in-app rotation)

We document the existing host rule instead of rotating inside the app: the app process holds
`server.log` open as the log sink, so truncating/compressing it from inside risks lost or
interleaved lines, and the host already has a tested logrotate rule. Doing it twice would race.

Rule currently in place on the host:

- rotate **daily**
- keep **14** rotations
- **max size 500MB** (rotate early if exceeded)

If the host is rebuilt, re-create this rule (use `copytruncate` since the app keeps the file open).
