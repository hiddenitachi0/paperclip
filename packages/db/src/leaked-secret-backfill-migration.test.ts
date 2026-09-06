import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { agents, companies, heartbeatRuns, workspaceOperations } from "./schema/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const MIGRATION_PATH = fileURLToPath(new URL("./migrations/0160_leaked_secret_backfill.sql", import.meta.url));

type Db = ReturnType<typeof createDb>;

async function applyMigrationStatements(db: Db, migrationSql: string) {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

// DUR-372: migration 0160 backfills leaked-secret patterns
// (server/src/redaction.ts's SECRET_LEAK_PATTERNS) out of heartbeat_runs and
// workspace_operations rows that predate the DUR-317 write-time gate
// (heartbeat_runs) or that were never gated at all (workspace_operations).
// It already ran once, against empty tables, when startEmbeddedPostgresTestDatabase
// applied every migration below. To prove the backfill SQL itself is correct
// against a real Postgres -- not just that the TS regex is -- this test
// seeds rows with a raw secret written directly (bypassing all app-level
// redaction, the same way the pre-DUR-317 row got created) and then
// re-applies the exact statements from the on-disk migration file, so there
// is no duplicated/drifting copy of the pattern list living in the test.
describeEmbeddedPostgres("DUR-372: leaked-secret backfill migration (0160)", () => {
  let db!: Db;
  let migrationSql!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-leaked-secret-backfill-");
    db = createDb(tempDb.connectionString);
    migrationSql = await readFile(MIGRATION_PATH, "utf8");
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const issuePrefix = `D${randomUUID().replace(/-/g, "").slice(0, 3).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name: "DUR-372 Co", issuePrefix }).returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "DUR-372 Agent",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    return { company, agent };
  }

  it("scrubs raw leaked-secret patterns already sitting in heartbeat_runs and workspace_operations columns", async () => {
    const { company, agent } = await seedCompanyAndAgent();
    const leakedToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";

    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "failed",
        error: `push failed: ${leakedToken}`,
        stdoutExcerpt: `cloning with ${leakedToken}`,
        stderrExcerpt: `auth error ${leakedToken}`,
        resultJson: { detail: "slack token xoxb-test-fixture-not-a-real-token-000000 leaked" },
      })
      .returning();

    const [operation] = await db
      .insert(workspaceOperations)
      .values({
        companyId: company.id,
        phase: "run",
        status: "failed",
        stdoutExcerpt: `git clone https://x-access-token:${leakedToken}@github.com/org/repo.git failed`,
        stderrExcerpt: `fatal: auth error ${leakedToken}`,
        metadata: { remote: `https://x-access-token:${leakedToken}@github.com/org/repo.git` },
      })
      .returning();

    await applyMigrationStatements(db, migrationSql);

    const [reloadedRun] = await db.execute<{
      error: string | null;
      stdout_excerpt: string | null;
      stderr_excerpt: string | null;
      result_json: unknown;
    }>(sql`SELECT error, stdout_excerpt, stderr_excerpt, result_json FROM heartbeat_runs WHERE id = ${run.id}`);
    expect(reloadedRun.error).toBe("push failed: [REDACTED:github_token]");
    expect(reloadedRun.stdout_excerpt).toBe("cloning with [REDACTED:github_token]");
    expect(reloadedRun.stderr_excerpt).toBe("auth error [REDACTED:github_token]");
    expect(reloadedRun.result_json).toEqual({ detail: "slack token [REDACTED:slack_bot_token] leaked" });
    expect(JSON.stringify(reloadedRun)).not.toContain(leakedToken);

    const [reloadedOp] = await db.execute<{
      stdout_excerpt: string | null;
      stderr_excerpt: string | null;
      metadata: unknown;
    }>(sql`SELECT stdout_excerpt, stderr_excerpt, metadata FROM workspace_operations WHERE id = ${operation.id}`);
    expect(reloadedOp.stdout_excerpt).toBe(
      "git clone https://x-access-token:[REDACTED:github_token]@github.com/org/repo.git failed",
    );
    expect(reloadedOp.stderr_excerpt).toBe("fatal: auth error [REDACTED:github_token]");
    expect(reloadedOp.metadata).toEqual({
      remote: "https://x-access-token:[REDACTED:github_token]@github.com/org/repo.git",
    });
    expect(JSON.stringify(reloadedOp)).not.toContain(leakedToken);
  });

  it("leaves rows without a matching pattern byte-for-byte untouched", async () => {
    const { company, agent } = await seedCompanyAndAgent();

    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "succeeded",
        error: null,
        stdoutExcerpt: "build succeeded, no credentials here",
        stderrExcerpt: null,
        resultJson: { summary: "ok", cost_usd: 0.12 },
      })
      .returning();

    await applyMigrationStatements(db, migrationSql);

    const [reloadedRun] = await db.execute<{
      stdout_excerpt: string | null;
      result_json: unknown;
    }>(sql`SELECT stdout_excerpt, result_json FROM heartbeat_runs WHERE id = ${run.id}`);
    expect(reloadedRun.stdout_excerpt).toBe("build succeeded, no credentials here");
    expect(reloadedRun.result_json).toEqual({ summary: "ok", cost_usd: 0.12 });
  });

  it("leaves the helper function dropped after the backfill runs", async () => {
    await applyMigrationStatements(db, migrationSql);

    const rows = await db.execute<{ proname: string }>(
      sql`SELECT proname FROM pg_proc WHERE proname = 'dur372_redact_leaked_secret_patterns'`,
    );
    expect(Array.isArray(rows) ? rows.length : 0).toBe(0);
  });
});
