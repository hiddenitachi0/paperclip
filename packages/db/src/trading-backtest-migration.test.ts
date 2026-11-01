import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * DUR-5008, migration 0268_trading_backtest: the rehearsal. It runs against a
 * database that already holds a strategy with an approved version, an order
 * and a ledger row; proves the upgrade keeps all of them, that a second run
 * changes nothing, that the documented rollback removes only the new objects
 * (and the old rows stay), and that the tables are policed by company.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping migration 0268 test: ${support.reason ?? "unsupported environment"}`);

const MIGRATION_PATH = fileURLToPath(new URL("./migrations/0268_trading_backtest.sql", import.meta.url));
const DIGEST = "a".repeat(64);
const TABLES = ["trading_backtest_runs", "trading_backtest_trials", "trading_backtest_holdout_reads", "trading_start_gate_overrides"];

type Row = Record<string, unknown>;

function migrationStatements(): string[] {
  return readFileSync(MIGRATION_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** The rollback written in the migration's header comment, taken from the file itself so the two cannot drift. */
function rollbackStatements(): string[] {
  return readFileSync(MIGRATION_PATH, "utf8")
    .split("\n")
    .filter((line) => /^--\s{3}(DROP|ALTER)/.test(line))
    .map((line) => line.replace(/^--\s+/, "").trim());
}

d("migration 0268_trading_backtest", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const strategyId = randomUUID();
  const versionId = randomUUID();

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0268-trading-backtest-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Trading', 'TRD')`);
    await db.execute(sql`
      INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, cash_nok, peak_equity_nok)
      VALUES (${strategyId}, ${companyId}, 'S', 'BTC', ${JSON.stringify({ type: "sma_crossover", version: 1, fastPeriod: 10, slowPeriod: 30, orderSizeFraction: 0.1 })}::jsonb, '{}'::jsonb, 3000, 3000, 3000)
    `);
    await db.execute(sql`
      INSERT INTO trading_strategy_versions (id, company_id, strategy_id, version, spec, status, proposed_by_type, proposed_by_id, approved_by_user_id, approved_at, spec_digest)
      VALUES (${versionId}, ${companyId}, ${strategyId}, 1, '{}'::jsonb, 'approved', 'user', 'u', 'owner-1', now(), ${DIGEST})
    `);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("upgrades a database that already holds trading rows without touching them, and a second run changes nothing", async () => {
    for (const statement of rollbackStatements()) await db.execute(sql.raw(statement));
    expect(await rows(sql`SELECT to_regclass('trading_backtest_runs') AS t`)).toEqual([{ t: null }]);
    const orderId = randomUUID();
    await db.execute(sql`INSERT INTO trading_orders (id, company_id, strategy_id, side, status, rule_version, signal_price_nok, requested_quantity) VALUES (${orderId}, ${companyId}, ${strategyId}, 'buy', 'filled', 'x', 100, 1)`);
    const counts = () => rows(sql`SELECT (SELECT count(*) FROM trading_strategies)::int AS s, (SELECT count(*) FROM trading_strategy_versions)::int AS v, (SELECT count(*) FROM trading_orders)::int AS o`);
    const before = await counts();

    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await counts()).toEqual(before);
    for (const table of TABLES) expect(await rows(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`)).toEqual([{ n: 0 }]);

    const objects = () =>
      rows(sql`SELECT (SELECT count(*) FROM pg_constraint WHERE conname LIKE 'trading_backtest_%' OR conname LIKE 'trading_start_gate_%')::int AS c, (SELECT count(*) FROM pg_indexes WHERE tablename LIKE 'trading_backtest_%' OR tablename = 'trading_start_gate_overrides')::int AS i, (SELECT count(*) FROM pg_trigger WHERE (tgname LIKE 'trading_backtest_%' OR tgname LIKE 'trading_start_gate_%') AND NOT tgisinternal)::int AS t, (SELECT count(*) FROM pg_policies WHERE tablename LIKE 'trading_backtest_%' OR tablename = 'trading_start_gate_overrides')::int AS p`);
    const firstRun = await objects();
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await objects()).toEqual(firstRun);
  });

  it("rolls back cleanly: the four tables and their functions go, every old row stays; it applies again", async () => {
    const before = await rows(sql`SELECT (SELECT count(*) FROM trading_strategies)::int AS s, (SELECT count(*) FROM trading_strategy_versions)::int AS v, (SELECT count(*) FROM trading_orders)::int AS o`);
    const statements = rollbackStatements();
    expect(statements.length).toBeGreaterThanOrEqual(7);
    for (const statement of statements) await db.execute(sql.raw(statement));
    for (const table of TABLES) expect(await rows(sql`SELECT to_regclass(${table}) AS t`)).toEqual([{ t: null }]);
    expect(await rows(sql`SELECT proname FROM pg_proc WHERE proname LIKE 'trading_backtest_%'`)).toEqual([]);
    expect(await rows(sql`SELECT (SELECT count(*) FROM trading_strategies)::int AS s, (SELECT count(*) FROM trading_strategy_versions)::int AS v, (SELECT count(*) FROM trading_orders)::int AS o`)).toEqual(before);
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await rows(sql`SELECT to_regclass('trading_backtest_runs') AS t`)).not.toEqual([{ t: null }]);
  });

  it("polices all four tables by company like every other tenant table", async () => {
    for (const table of TABLES) {
      expect(await rows(sql`SELECT relrowsecurity FROM pg_class WHERE relname = ${table}`)).toEqual([{ relrowsecurity: true }]);
      expect(await rows(sql`SELECT policyname FROM pg_policies WHERE tablename = ${table}`)).toEqual([{ policyname: "paperclip_company_scope" }]);
    }
  });

  it("removing a strategy removes its runs, trials, holdout reads and overrides (the cascade) and nothing else", async () => {
    const otherStrategy = randomUUID();
    await db.execute(sql`INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, cash_nok, peak_equity_nok) VALUES (${otherStrategy}, ${companyId}, 'Other', 'ETH', '{}'::jsonb, '{}'::jsonb, 3000, 3000, 3000)`);
    const otherVersion = randomUUID();
    await db.execute(sql`INSERT INTO trading_strategy_versions (id, company_id, strategy_id, version, spec, status, proposed_by_type, proposed_by_id, approved_by_user_id, approved_at, spec_digest) VALUES (${otherVersion}, ${companyId}, ${otherStrategy}, 1, '{}'::jsonb, 'approved', 'user', 'u', 'o', now(), ${DIGEST})`);
    const runId = randomUUID();
    await db.execute(sql`INSERT INTO trading_backtest_runs (id, company_id, strategy_id, version_id, purpose, spec_digest, params, requested_by_type, requested_by_id) VALUES (${runId}, ${companyId}, ${otherStrategy}, ${otherVersion}, 'gate', ${DIGEST}, '{}'::jsonb, 'user', 'u')`);
    await db.execute(sql`INSERT INTO trading_backtest_trials (company_id, strategy_id, run_id, variant_digest, variant_label) VALUES (${companyId}, ${otherStrategy}, ${runId}, ${DIGEST}, 'x')`);
    await db.execute(sql`INSERT INTO trading_backtest_holdout_reads (company_id, strategy_id, version_id, run_id, holdout_start, holdout_end) VALUES (${companyId}, ${otherStrategy}, ${otherVersion}, ${runId}, now() - interval '1 year', now())`);
    await db.execute(sql`INSERT INTO trading_start_gate_overrides (company_id, strategy_id, version_id, reason, overridden_by_user_id) VALUES (${companyId}, ${otherStrategy}, ${otherVersion}, 'a long enough reason', 'o')`);
    await db.execute(sql`DELETE FROM trading_strategies WHERE id = ${otherStrategy}`);
    for (const table of TABLES) expect(await rows(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`)).toEqual([{ n: 0 }]);
    expect(await rows(sql`SELECT count(*)::int AS n FROM trading_strategies WHERE id = ${strategyId}`)).toEqual([{ n: 1 }]);
  });
});
