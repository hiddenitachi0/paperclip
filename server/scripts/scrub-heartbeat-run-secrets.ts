#!/usr/bin/env tsx
/**
 * One-shot backfill (DUR-372): scrub already-persisted `heartbeat_runs` rows
 * for known-shape leaked secrets (GitHub PATs, AWS keys, Slack tokens, etc.)
 * that predate the write-time gate `redactHeartbeatRunPatchSecrets` (DUR-317,
 * commit be5d641bb, merged 2026-08-28T11:10:37+02:00). That gate only masks
 * *new* writes via setRunStatus/setRunStatusIfRunning -- rows persisted
 * before it landed still carry raw credentials (e.g. the github_pat in run
 * 39f285c4-955f-41a8-a2a7-4b26919b24bc, recorded 2026-08-27T01:51:01.800Z).
 *
 * Sweeps the *entire* table, not just pre-cutoff rows, in case other rows
 * carry undetected secrets the write-time gate would have caught had it
 * existed then.
 *
 * Reuses `redactHeartbeatRunPatchSecrets` from server/src/redaction.ts --
 * the exact same pattern list as the write-time gate -- so this can never
 * drift from what new writes already mask.
 *
 * Usage:
 *   tsx server/scripts/scrub-heartbeat-run-secrets.ts \
 *     [--database-url <url>] [--dry-run] [--json] [--batch-size 500]
 *
 * DATABASE_URL env var is used if --database-url is not passed.
 *
 * Idempotent: rows with no matching secret pattern are left byte-for-byte
 * untouched, so re-running after a partial run or after new writes land is
 * always safe. Does NOT touch usage_json or any column other than error,
 * stdout_excerpt, stderr_excerpt, result_json.
 *
 * Out of scope: revoking/rotating the leaked credential at the provider --
 * that is an operator action tracked on DUR-369.
 */
import { asc, eq, gt } from "drizzle-orm";
import { createDb, heartbeatRuns } from "@paperclipai/db";
import { redactHeartbeatRunPatchSecrets } from "../src/redaction.js";

interface ScrubRow {
  id: string;
  error: string | null;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  resultJson: Record<string, unknown> | null;
}

export interface ScrubPatch {
  error?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  resultJson?: Record<string, unknown> | null;
}

export interface ScrubResult {
  id: string;
  changed: boolean;
  patch: ScrubPatch;
}

/**
 * Pure diff: runs the row's scrubbable fields through the same gate DUR-317
 * applies at write time, and reports only the fields that actually changed
 * so the caller can issue a minimal UPDATE (and so unaffected rows are never
 * written at all).
 */
export function computeScrub(row: ScrubRow): ScrubResult {
  const sanitized = redactHeartbeatRunPatchSecrets({
    error: row.error,
    stdoutExcerpt: row.stdoutExcerpt,
    stderrExcerpt: row.stderrExcerpt,
    resultJson: row.resultJson,
  });

  const patch: ScrubPatch = {};
  if (sanitized.error !== row.error) patch.error = sanitized.error as string | null;
  if (sanitized.stdoutExcerpt !== row.stdoutExcerpt) {
    patch.stdoutExcerpt = sanitized.stdoutExcerpt as string | null;
  }
  if (sanitized.stderrExcerpt !== row.stderrExcerpt) {
    patch.stderrExcerpt = sanitized.stderrExcerpt as string | null;
  }
  if (JSON.stringify(sanitized.resultJson) !== JSON.stringify(row.resultJson)) {
    patch.resultJson = (sanitized.resultJson ?? null) as Record<string, unknown> | null;
  }

  return { id: row.id, changed: Object.keys(patch).length > 0, patch };
}

interface CliArgs {
  databaseUrl: string | null;
  dryRun: boolean;
  json: boolean;
  batchSize: number;
}

const USAGE = `Usage:
  tsx server/scripts/scrub-heartbeat-run-secrets.ts [flags]

Flags:
  --database-url <url>  Override DB connection string (default: $DATABASE_URL).
  --dry-run             Report rows that would change but do not write.
  --json                Emit a single JSON summary on stdout.
  --batch-size <n>      Rows fetched per page (default: 500).
  -h, --help            Print this usage.
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { databaseUrl: null, dryRun: false, json: false, batchSize: 500 };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case "--database-url":
        args.databaseUrl = argv[++i] ?? null;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--batch-size":
        args.batchSize = Number(argv[++i]) || 500;
        break;
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        if (token.startsWith("--")) throw new Error(`Unknown flag: ${token}`);
    }
  }
  return args;
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL ?? null;
  if (!databaseUrl) {
    throw new Error("Unable to resolve database URL. Pass --database-url or set DATABASE_URL.");
  }

  const db = createDb(databaseUrl, "paperclip-script-scrub-heartbeat-run-secrets");
  const closableDb = db as typeof db & {
    $client?: { end?: (options?: { timeout?: number }) => Promise<void> };
  };

  const log = (line: string) => {
    if (!args.json) process.stdout.write(`${line}\n`);
  };

  const summary = {
    scanned: 0,
    changed: 0,
    dryRun: args.dryRun,
    changedIds: [] as string[],
  };

  try {
    let cursor: string | null = null;
    for (;;) {
      const rows: ScrubRow[] = await db
        .select({
          id: heartbeatRuns.id,
          error: heartbeatRuns.error,
          stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
          stderrExcerpt: heartbeatRuns.stderrExcerpt,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(cursor ? gt(heartbeatRuns.id, cursor) : undefined)
        .orderBy(asc(heartbeatRuns.id))
        .limit(args.batchSize);

      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;

      for (const row of rows) {
        summary.scanned += 1;
        const result = computeScrub(row);
        if (!result.changed) continue;
        summary.changed += 1;
        summary.changedIds.push(result.id);
        log(`[scrub] row=${result.id} fields=${Object.keys(result.patch).join(",")}`);
        if (!args.dryRun) {
          await db
            .update(heartbeatRuns)
            .set({ ...result.patch, updatedAt: new Date() })
            .where(eq(heartbeatRuns.id, result.id));
        }
      }

      if (rows.length < args.batchSize) break;
    }

    log(
      `Scanned ${summary.scanned} row(s); ${summary.changed} needed scrubbing (dryRun=${args.dryRun}).`,
    );
    if (args.json) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    }
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 });
  }
}

if (process.argv[1] && process.argv[1].endsWith("scrub-heartbeat-run-secrets.ts")) {
  await main(process.argv.slice(2));
}
