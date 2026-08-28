// DUR-370 / DUR-371: DUR-317 added write-time masking (redactHeartbeatRunPatchSecrets)
// for fixed-shape secret patterns (github_pat_, ghp_/gho_/ghu_/ghs_/ghr_, sk-, shpss_,
// shpat_, xoxb-/xoxp-, AKIA, PEM private keys) before a heartbeat_runs row is written --
// but it only guards the write path going forward. Rows persisted *before* that fix
// landed (2026-08-28, PR #187) can still carry an unredacted match in
// error/stdoutExcerpt/stderrExcerpt/resultJson, readable via GET /heartbeat-runs/:id by
// any company-scoped API key. This sweeps existing rows and applies the same
// redactHeartbeatRunPatchSecrets masking in place.
//
// Run with: tsx scripts/backfill-dur370-redact-heartbeat-run-secrets.ts [--run-id <id>] [--apply]
// Without --apply, it only reports which rows would be touched (and which pattern names
// matched, without printing the secret text itself).
import { eq, or, sql } from "drizzle-orm";
import { createDb, heartbeatRuns } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { redactHeartbeatRunPatchSecrets, SECRET_LEAK_PATTERNS } from "../server/src/redaction.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function matchedPatternNames(text: string | null): string[] {
  if (!text) return [];
  return SECRET_LEAK_PATTERNS.filter((pattern) => {
    pattern.regex.lastIndex = 0;
    return pattern.regex.test(text);
  }).map((pattern) => pattern.name);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const runId = parseFlag("--run-id");
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl, "paperclip-script-backfill-dur370-redact-heartbeat-run-secrets");

  // Cheap pre-filter so we don't pull every row's (potentially large) text columns into
  // memory just to find the rare match -- narrow to rows that contain any pattern's fixed
  // literal prefix before doing the full regex pass in JS.
  const prefixes = ["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "sk-", "shpss_", "shpat_", "xoxb-", "xoxp-", "AKIA", "-----BEGIN"];
  const prefixFilter = or(
    ...prefixes.flatMap((prefix) => [
      sql`${heartbeatRuns.error} LIKE ${"%" + prefix + "%"}`,
      sql`${heartbeatRuns.stdoutExcerpt} LIKE ${"%" + prefix + "%"}`,
      sql`${heartbeatRuns.stderrExcerpt} LIKE ${"%" + prefix + "%"}`,
      sql`${heartbeatRuns.resultJson}::text LIKE ${"%" + prefix + "%"}`,
    ]),
  );

  const candidates = runId
    ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))
    : await db.select().from(heartbeatRuns).where(prefixFilter);

  console.log(`Scanning ${candidates.length} candidate row(s) (${apply ? "APPLY" : "dry run"})...`);

  let touched = 0;
  for (const row of candidates) {
    const names = new Set([
      ...matchedPatternNames(row.error),
      ...matchedPatternNames(row.stdoutExcerpt),
      ...matchedPatternNames(row.stderrExcerpt),
      ...matchedPatternNames(row.resultJson ? JSON.stringify(row.resultJson) : null),
    ]);
    if (names.size === 0) continue;

    touched += 1;
    console.log(`- ${row.id} (company ${row.companyId}): patterns [${Array.from(names).join(", ")}]`);
    if (!apply) continue;

    const redacted = redactHeartbeatRunPatchSecrets({
      error: row.error,
      stdoutExcerpt: row.stdoutExcerpt,
      stderrExcerpt: row.stderrExcerpt,
      resultJson: row.resultJson,
    });
    await db
      .update(heartbeatRuns)
      .set({
        error: redacted.error,
        stdoutExcerpt: redacted.stdoutExcerpt,
        stderrExcerpt: redacted.stderrExcerpt,
        resultJson: redacted.resultJson,
      })
      .where(eq(heartbeatRuns.id, row.id));
  }

  console.log(
    apply
      ? `Done. Redacted ${touched} row(s).`
      : `Dry run complete. ${touched} row(s) would be redacted. Re-run with --apply to write.`,
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`DUR-370 heartbeat_runs secret backfill failed: ${message}`);
  process.exitCode = 1;
});
