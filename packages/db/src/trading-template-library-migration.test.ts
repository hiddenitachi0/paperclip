import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * DUR-5014, migration 0271_trading_template_library: the rehearsal. It runs on
 * a database that already holds a strategy, proves the upgrade keeps it (and
 * leaves template_key NULL), that a second run changes nothing, that the
 * documented rollback removes only the new objects, and that the matrix is
 * immutable and a finished report is final.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping migration 0271 test: ${support.reason ?? "unsupported environment"}`);

const MIGRATION_PATH = fileURLToPath(new URL("./migrations/0271_trading_template_library.sql", import.meta.url));
const DIGEST = "b".repeat(64);
const TABLES = ["trading_eligibility_matrices", "trading_template_reports", "trading_template_trials"];

type Row = Record<string, unknown>;

function migrationStatements(): string[] {
  return readFileSync(MIGRATION_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function rollbackStatements(): string[] {
  return readFileSync(MIGRATION_PATH, "utf8")
    .split("\n")
    .filter((line) => /^--\s{3}(DROP|ALTER)/.test(line))
    .map((line) => line.replace(/^--\s+/, "").trim());
}

d("migration 0271_trading_template_library", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const strategyId = randomUUID();

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0271-template-library-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Trading', 'TRD')`);
    await db.execute(sql`
      INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, cash_nok, peak_equity_nok)
      VALUES (${strategyId}, ${companyId}, 'S', 'BTC', ${JSON.stringify({ type: "sma_crossover", version: 1, fastPeriod: 10, slowPeriod: 30, orderSizeFraction: 0.1 })}::jsonb, '{}'::jsonb, 3000, 3000, 3000)
    `);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertMatrix(version: number) {
    await db.execute(sql`INSERT INTO trading_eligibility_matrices (version, matrix, digest, note) VALUES (${version}, '{}'::jsonb, ${DIGEST}, 'first')`);
  }
  async function insertReport(id: string, status = "queued") {
    await db.execute(sql`INSERT INTO trading_template_reports (id, template_key, template_version, spec_digest, matrix_version, status, params, requested_by_type, requested_by_id) VALUES (${id}, 'pullback', 1, ${DIGEST}, 1, ${status}, '{}'::jsonb, 'system', 'boot')`);
  }

  it("upgrades a database that already holds a strategy without touching it, and a second run changes nothing", async () => {
    for (const statement of rollbackStatements()) await db.execute(sql.raw(statement));
    expect(await rows(sql`SELECT to_regclass('trading_template_reports') AS t`)).toEqual([{ t: null }]);
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await rows(sql`SELECT template_key, template_version FROM trading_strategies WHERE id = ${strategyId}`)).toEqual([{ template_key: null, template_version: null }]);
    for (const table of TABLES) expect(await rows(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`)).toEqual([{ n: 0 }]);
    const objects = () =>
      rows(sql`SELECT (SELECT count(*) FROM pg_constraint WHERE conname LIKE 'trading_template_%' OR conname LIKE 'trading_eligibility_%')::int AS c, (SELECT count(*) FROM pg_indexes WHERE tablename IN ('trading_template_reports','trading_template_trials','trading_eligibility_matrices'))::int AS i, (SELECT count(*) FROM pg_trigger WHERE (tgname LIKE 'trading_template_%' OR tgname LIKE 'trading_eligibility_%') AND NOT tgisinternal)::int AS t`);
    const firstRun = await objects();
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await objects()).toEqual(firstRun);
  });

  it("rolls back cleanly: the three tables, two columns and two functions go; the strategy stays; it applies again", async () => {
    const statements = rollbackStatements();
    expect(statements.length).toBeGreaterThanOrEqual(6);
    for (const statement of statements) await db.execute(sql.raw(statement));
    for (const table of TABLES) expect(await rows(sql`SELECT to_regclass(${table}) AS t`)).toEqual([{ t: null }]);
    expect(await rows(sql`SELECT proname FROM pg_proc WHERE proname LIKE 'trading_template_%' OR proname LIKE 'trading_eligibility_%'`)).toEqual([]);
    expect(await rows(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'trading_strategies' AND column_name LIKE 'template_%'`)).toEqual([]);
    expect(await rows(sql`SELECT count(*)::int AS n FROM trading_strategies WHERE id = ${strategyId}`)).toEqual([{ n: 1 }]);
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await rows(sql`SELECT to_regclass('trading_template_reports') AS t`)).not.toEqual([{ t: null }]);
  });

  it("keeps a matrix version immutable and undeletable", async () => {
    await insertMatrix(1);
    await expect(db.execute(sql`UPDATE trading_eligibility_matrices SET note = 'changed' WHERE version = 1`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM trading_eligibility_matrices WHERE version = 1`)).rejects.toThrow();
    await expect(db.execute(sql`INSERT INTO trading_eligibility_matrices (version, matrix, digest, note) VALUES (0, '{}'::jsonb, ${DIGEST}, 'x')`)).rejects.toThrow();
    await expect(db.execute(sql`INSERT INTO trading_eligibility_matrices (version, matrix, digest, note) VALUES (2, '{}'::jsonb, 'nope', 'x')`)).rejects.toThrow();
  });

  it("allows one active report per template version, and makes a finished report final", async () => {
    const first = randomUUID();
    await insertReport(first);
    await expect(insertReport(randomUUID())).rejects.toThrow();
    await db.execute(sql`UPDATE trading_template_reports SET status = 'running', started_at = now() WHERE id = ${first}`);
    await expect(db.execute(sql`UPDATE trading_template_reports SET template_key = 'other' WHERE id = ${first}`)).rejects.toThrow();
    await db.execute(sql`UPDATE trading_template_reports SET status = 'succeeded', gate_passed = true, holdout_start = now() - interval '1 year', holdout_end = now(), holdout_seen_count = 0, finished_at = now() WHERE id = ${first}`);
    await expect(db.execute(sql`UPDATE trading_template_reports SET gate_passed = false WHERE id = ${first}`)).rejects.toThrow();
    // A finished report no longer blocks the next one.
    await insertReport(randomUUID());
  });

  it("refuses a pass on an unfinished report and a half-filled holdout", async () => {
    await expect(db.execute(sql`INSERT INTO trading_template_reports (template_key, template_version, spec_digest, matrix_version, status, gate_passed, params, requested_by_type, requested_by_id) VALUES ('breakout', 1, ${DIGEST}, 1, 'queued', true, '{}'::jsonb, 'system', 'boot')`)).rejects.toThrow();
    await expect(db.execute(sql`INSERT INTO trading_template_reports (template_key, template_version, spec_digest, matrix_version, status, holdout_start, params, requested_by_type, requested_by_id) VALUES ('breakout', 1, ${DIGEST}, 1, 'queued', now(), '{}'::jsonb, 'system', 'boot')`)).rejects.toThrow();
  });

  it("removes a report's trials with it (cascade) and counts a variant once per template", async () => {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO trading_template_reports (id, template_key, template_version, spec_digest, matrix_version, status, params, requested_by_type, requested_by_id) VALUES (${id}, 'momentum', 1, ${DIGEST}, 1, 'succeeded', '{}'::jsonb, 'system', 'boot')`);
    await db.execute(sql`INSERT INTO trading_template_trials (template_key, report_id, variant_digest, variant_label) VALUES ('momentum', ${id}, ${DIGEST}, 'base')`);
    await expect(db.execute(sql`INSERT INTO trading_template_trials (template_key, report_id, variant_digest, variant_label) VALUES ('momentum', ${id}, ${DIGEST}, 'again')`)).rejects.toThrow();
    await db.execute(sql`DELETE FROM trading_template_reports WHERE id = ${id}`);
    expect(await rows(sql`SELECT count(*)::int AS n FROM trading_template_trials WHERE template_key = 'momentum'`)).toEqual([{ n: 0 }]);
  });
});
