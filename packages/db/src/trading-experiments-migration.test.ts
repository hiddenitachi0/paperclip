import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * DUR-5018, migration 0272_trading_experiments: the rehearsal. It runs against
 * a database that already holds a strategy with an approved version and an
 * order; proves the upgrade keeps them, that a second run changes nothing, that
 * the documented rollback removes only the new objects, that the table is
 * policed by company, and that the database itself keeps a finished experiment
 * final and refuses a result that is not backed by a recommendation.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping migration 0272 test: ${support.reason ?? "unsupported environment"}`);

const MIGRATION_PATH = fileURLToPath(new URL("./migrations/0272_trading_experiments.sql", import.meta.url));
const DIGEST = "a".repeat(64);

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

d("migration 0272_trading_experiments", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const strategyId = randomUUID();
  const versionId = randomUUID();

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }
  async function refused(statement: ReturnType<typeof sql>, message: RegExp) {
    let error: unknown = null;
    try {
      await db.execute(statement);
    } catch (err) {
      error = err;
    }
    expect(error, "the database should have refused this").not.toBeNull();
    const text = `${(error as Error).message} ${((error as { cause?: Error }).cause?.message) ?? ""}`;
    expect(text).toMatch(message);
  }
  const insertExperiment = (id: string, over: { status?: string } = {}) =>
    db.execute(sql`INSERT INTO trading_experiments (id, company_id, strategy_id, version_id, status, spec_digest, params, requested_by_type, requested_by_id) VALUES (${id}, ${companyId}, ${strategyId}, ${versionId}, ${over.status ?? "queued"}, ${DIGEST}, '{}'::jsonb, 'agent', 'a')`);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0272-trading-experiments-");
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
    expect(await rows(sql`SELECT to_regclass('trading_experiments') AS t`)).toEqual([{ t: null }]);
    const orderId = randomUUID();
    await db.execute(sql`INSERT INTO trading_orders (id, company_id, strategy_id, side, status, rule_version, signal_price_nok, requested_quantity) VALUES (${orderId}, ${companyId}, ${strategyId}, 'buy', 'filled', 'x', 100, 1)`);
    const counts = () => rows(sql`SELECT (SELECT count(*) FROM trading_strategies)::int AS s, (SELECT count(*) FROM trading_strategy_versions)::int AS v, (SELECT count(*) FROM trading_orders)::int AS o`);
    const before = await counts();

    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await counts()).toEqual(before);
    expect(await rows(sql`SELECT count(*)::int AS n FROM trading_experiments`)).toEqual([{ n: 0 }]);

    const objects = () =>
      rows(sql`SELECT (SELECT count(*) FROM pg_constraint WHERE conname LIKE 'trading_experiments_%')::int AS c, (SELECT count(*) FROM pg_indexes WHERE tablename = 'trading_experiments')::int AS i, (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trading_experiments_%' AND NOT tgisinternal)::int AS t, (SELECT count(*) FROM pg_policies WHERE tablename = 'trading_experiments')::int AS p`);
    const firstRun = await objects();
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await objects()).toEqual(firstRun);
  });

  it("rolls back cleanly: the table and its functions go, every old row stays; it applies again", async () => {
    const before = await rows(sql`SELECT (SELECT count(*) FROM trading_strategies)::int AS s, (SELECT count(*) FROM trading_strategy_versions)::int AS v, (SELECT count(*) FROM trading_orders)::int AS o`);
    const statements = rollbackStatements();
    expect(statements).toHaveLength(3);
    for (const statement of statements) await db.execute(sql.raw(statement));
    expect(await rows(sql`SELECT to_regclass('trading_experiments') AS t`)).toEqual([{ t: null }]);
    expect(await rows(sql`SELECT proname FROM pg_proc WHERE proname LIKE 'trading_experiments_%'`)).toEqual([]);
    expect(await rows(sql`SELECT (SELECT count(*) FROM trading_strategies)::int AS s, (SELECT count(*) FROM trading_strategy_versions)::int AS v, (SELECT count(*) FROM trading_orders)::int AS o`)).toEqual(before);
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await rows(sql`SELECT to_regclass('trading_experiments') AS t`)).not.toEqual([{ t: null }]);
  });

  it("is policed by company like every other tenant table", async () => {
    expect(await rows(sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'trading_experiments'`)).toEqual([{ relrowsecurity: true }]);
    expect(await rows(sql`SELECT policyname FROM pg_policies WHERE tablename = 'trading_experiments'`)).toEqual([{ policyname: "paperclip_company_scope" }]);
  });

  it("an experiment starts queued and empty: one born finished or with a result is refused", async () => {
    await refused(sql`INSERT INTO trading_experiments (company_id, strategy_id, version_id, status, spec_digest, params, requested_by_type, requested_by_id) VALUES (${companyId}, ${strategyId}, ${versionId}, 'succeeded', ${DIGEST}, '{}'::jsonb, 'agent', 'a')`, /starts queued and empty/);
    await refused(sql`INSERT INTO trading_experiments (company_id, strategy_id, version_id, spec_digest, params, requested_by_type, requested_by_id, trial_count) VALUES (${companyId}, ${strategyId}, ${versionId}, ${DIGEST}, '{}'::jsonb, 'agent', 'a', 4)`, /starts queued and empty/);
    await refused(sql`INSERT INTO trading_experiments (company_id, strategy_id, version_id, spec_digest, params, requested_by_type, requested_by_id, recommended_variant_digest, recommended_spec) VALUES (${companyId}, ${strategyId}, ${versionId}, ${DIGEST}, '{}'::jsonb, 'agent', 'a', ${DIGEST}, '{}'::jsonb)`, /starts queued and empty|recommended_check/);
  });

  it("keeps a finished experiment final, keeps what it tests fixed, and only moves forward", async () => {
    const id = randomUUID();
    await insertExperiment(id);
    await refused(sql`UPDATE trading_experiments SET params = '{"x":1}'::jsonb WHERE id = ${id}`, /never changes/);
    await refused(sql`UPDATE trading_experiments SET requested_by_id = 'someone-else' WHERE id = ${id}`, /never changes/);
    await refused(sql`UPDATE trading_experiments SET status = 'succeeded' WHERE id = ${id}`, /cannot move from queued to succeeded/);
    await db.execute(sql`UPDATE trading_experiments SET status = 'running' WHERE id = ${id}`);
    // A recommendation must come with its spec, and only on a succeeded experiment.
    await refused(sql`UPDATE trading_experiments SET status = 'succeeded', recommended_variant_digest = ${DIGEST} WHERE id = ${id}`, /recommended_check/);
    await refused(sql`UPDATE trading_experiments SET recommended_variant_digest = ${DIGEST}, recommended_spec = '{}'::jsonb WHERE id = ${id}`, /recommended_check/);
    await refused(sql`UPDATE trading_experiments SET status = 'succeeded', recommended_variant_digest = 'not-a-digest', recommended_spec = '{}'::jsonb WHERE id = ${id}`, /recommended_digest_check/);
    await db.execute(sql`UPDATE trading_experiments SET status = 'succeeded', recommended_variant_digest = ${DIGEST}, recommended_spec = '{}'::jsonb, trial_count = 4 WHERE id = ${id}`);
    await refused(sql`UPDATE trading_experiments SET recommended_variant_digest = ${"b".repeat(64)} WHERE id = ${id}`, /finished experiment is final/);
    await refused(sql`UPDATE trading_experiments SET status = 'failed' WHERE id = ${id}`, /finished experiment is final/);
  });

  it("allows one active experiment per version", async () => {
    const first = randomUUID();
    await insertExperiment(first);
    await refused(sql`INSERT INTO trading_experiments (company_id, strategy_id, version_id, spec_digest, params, requested_by_type, requested_by_id) VALUES (${companyId}, ${strategyId}, ${versionId}, ${DIGEST}, '{}'::jsonb, 'agent', 'a')`, /one_active_per_version/);
    await db.execute(sql`UPDATE trading_experiments SET status = 'cancelled' WHERE id = ${first}`);
    await insertExperiment(randomUUID());
    await db.execute(sql`UPDATE trading_experiments SET status = 'cancelled' WHERE status = 'queued'`);
  });

  it("removing a strategy removes its experiments and nothing else", async () => {
    const otherStrategy = randomUUID();
    await db.execute(sql`INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, cash_nok, peak_equity_nok) VALUES (${otherStrategy}, ${companyId}, 'Other', 'ETH', '{}'::jsonb, '{}'::jsonb, 3000, 3000, 3000)`);
    const otherVersion = randomUUID();
    await db.execute(sql`INSERT INTO trading_strategy_versions (id, company_id, strategy_id, version, spec, status, proposed_by_type, proposed_by_id, approved_by_user_id, approved_at, spec_digest) VALUES (${otherVersion}, ${companyId}, ${otherStrategy}, 1, '{}'::jsonb, 'approved', 'user', 'u', 'o', now(), ${DIGEST})`);
    await db.execute(sql`INSERT INTO trading_experiments (company_id, strategy_id, version_id, spec_digest, params, requested_by_type, requested_by_id) VALUES (${companyId}, ${otherStrategy}, ${otherVersion}, ${DIGEST}, '{}'::jsonb, 'user', 'u')`);
    const total = (await rows(sql`SELECT count(*)::int AS n FROM trading_experiments`))[0]!.n as number;
    await db.execute(sql`DELETE FROM trading_strategies WHERE id = ${otherStrategy}`);
    expect(await rows(sql`SELECT count(*)::int AS n FROM trading_experiments`)).toEqual([{ n: total - 1 }]);
    expect(await rows(sql`SELECT count(*)::int AS n FROM trading_strategies WHERE id = ${strategyId}`)).toEqual([{ n: 1 }]);
  });
});
