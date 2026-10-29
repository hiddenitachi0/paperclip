import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0262_trading_strategy_versions (DUR-5002), rehearsed on the
 * embedded-Postgres path (every migration, in journal order) against a table
 * that already holds strategies, orders and ledger rows: nothing existing is
 * rewritten; a stored version's content is immutable; the status only moves
 * forward; the cache columns only change together with active_version_id; the
 * active version must be approved and belong to the same strategy and company;
 * the migration is safe to run twice and rolls back without losing strategies.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0262 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0262_trading_strategy_versions";
const MIGRATION_PATH = fileURLToPath(new URL(`./migrations/${MIGRATION_TAG}.sql`, import.meta.url));
const DIGEST = "a".repeat(64);

type Row = Record<string, unknown>;

function migrationStatements(): string[] {
  return readFileSync(MIGRATION_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

d(`migration ${MIGRATION_TAG}`, () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let otherCompanyId = "";
  let legacyStrategyId = "";
  let legacyOrderId = "";

  /** Drizzle wraps the Postgres error ("Failed query: ..."); the reason is on `cause`. */
  async function refuses(statement: Promise<unknown>, reason?: RegExp) {
    let failure: unknown = null;
    try {
      await statement;
    } catch (err) {
      failure = err;
    }
    expect(failure, "expected the statement to be refused").not.toBeNull();
    if (reason) {
      const e = failure as { message?: string; cause?: { message?: string } };
      expect(`${e.cause?.message ?? ""} ${e.message ?? ""}`).toMatch(reason);
    }
  }
  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }
  async function insertStrategy(company: string): Promise<string> {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, cash_nok, peak_equity_nok) VALUES (${id}, ${company}, 'S', 'BTC', '{"type":"sma_crossover"}'::jsonb, '{"a":1}'::jsonb, 1000, 1000, 1000)`);
    return id;
  }
  async function insertVersion(strategyId: string, company: string, version: number, overrides: { status?: string; approvedBy?: string | null; grandfathered?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const status = overrides.status ?? "draft";
    const approvedBy = overrides.approvedBy === undefined ? null : overrides.approvedBy;
    await db.execute(sql`INSERT INTO trading_strategy_versions (id, company_id, strategy_id, version, spec, guidelines, status, proposed_by_type, proposed_by_id, approved_by_user_id, approved_at, spec_digest, grandfathered)
      VALUES (${id}, ${company}, ${strategyId}, ${version}, '{"specVersion":2}'::jsonb, 'notes', ${status}, 'user', 'u1', ${approvedBy}, ${approvedBy ? sql`now()` : sql`NULL`}, ${DIGEST}, ${overrides.grandfathered ?? false})`);
    return id;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0262-strategy-versions-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Trading', 'TRD'), (${otherCompanyId}, 'Other', 'OTH')`);
    legacyStrategyId = await insertStrategy(companyId);
    legacyOrderId = randomUUID();
    await db.execute(sql`INSERT INTO trading_orders (id, company_id, strategy_id, side, status, rule_version, signal_price_nok, requested_quantity) VALUES (${legacyOrderId}, ${companyId}, ${legacyStrategyId}, 'buy', 'filled', 'sma_crossover@1', 100, 1)`);
    await db.execute(sql`INSERT INTO trading_ledger_entries (company_id, strategy_id, event_type) VALUES (${companyId}, ${legacyStrategyId}, 'signal')`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("leaves existing strategies, orders and ledger rows untouched and unstamped", async () => {
    const [s] = await rows(sql`SELECT active_version_id, rule_config, risk_config FROM trading_strategies WHERE id = ${legacyStrategyId}`);
    expect(s).toEqual({ active_version_id: null, rule_config: { type: "sma_crossover" }, risk_config: { a: 1 } });
    const [o] = await rows(sql`SELECT strategy_version_id FROM trading_orders WHERE id = ${legacyOrderId}`);
    expect(o?.strategy_version_id).toBeNull();
    const [l] = await rows(sql`SELECT count(*)::int AS n FROM trading_ledger_entries WHERE strategy_version_id IS NULL`);
    expect(l?.n).toBe(1);
  });

  it("allows only one draft per strategy and unique version numbers", async () => {
    const strategy = await insertStrategy(companyId);
    await insertVersion(strategy, companyId, 1);
    await refuses(insertVersion(strategy, companyId, 2)); // second draft
    await refuses(insertVersion(strategy, companyId, 1, { status: "superseded" })); // duplicate number
  });

  it("refuses an approved version without an approver unless it is the grandfathered conversion", async () => {
    const strategy = await insertStrategy(companyId);
    await refuses(insertVersion(strategy, companyId, 1, { status: "approved" }));
    await expect(insertVersion(strategy, companyId, 1, { status: "approved", grandfathered: true })).resolves.toBeTruthy();
  });

  it("refuses a malformed digest and a missing proposer id", async () => {
    const strategy = await insertStrategy(companyId);
    await refuses(db.execute(sql`INSERT INTO trading_strategy_versions (company_id, strategy_id, version, spec, proposed_by_type, proposed_by_id, spec_digest) VALUES (${companyId}, ${strategy}, 1, '{}'::jsonb, 'user', 'u', 'nothex')`));
    await refuses(db.execute(sql`INSERT INTO trading_strategy_versions (company_id, strategy_id, version, spec, proposed_by_type, spec_digest) VALUES (${companyId}, ${strategy}, 1, '{}'::jsonb, 'agent', ${DIGEST})`));
    await expect(db.execute(sql`INSERT INTO trading_strategy_versions (company_id, strategy_id, version, spec, proposed_by_type, spec_digest) VALUES (${companyId}, ${strategy}, 1, '{}'::jsonb, 'system', ${DIGEST})`)).resolves.toBeTruthy();
  });

  it("makes a stored version's content immutable and its status forward-only", async () => {
    const strategy = await insertStrategy(companyId);
    const v1 = await insertVersion(strategy, companyId, 1);
    await refuses(db.execute(sql`UPDATE trading_strategy_versions SET spec = '{"specVersion":2,"x":1}'::jsonb WHERE id = ${v1}`), /never changes/);
    await refuses(db.execute(sql`UPDATE trading_strategy_versions SET guidelines = 'other' WHERE id = ${v1}`), /never changes/);
    await refuses(db.execute(sql`UPDATE trading_strategy_versions SET spec_digest = ${"b".repeat(64)} WHERE id = ${v1}`), /never changes/);
    await refuses(db.execute(sql`UPDATE trading_strategy_versions SET version = 9 WHERE id = ${v1}`), /never changes/);
    // draft -> approved needs the approver pair
    await refuses(db.execute(sql`UPDATE trading_strategy_versions SET status = 'approved' WHERE id = ${v1}`));
    await db.execute(sql`UPDATE trading_strategy_versions SET status = 'approved', approved_by_user_id = 'owner', approved_at = now() WHERE id = ${v1}`);
    // once approved: the approver cannot be rewritten, the status can only go to superseded
    await refuses(db.execute(sql`UPDATE trading_strategy_versions SET approved_by_user_id = 'someone-else' WHERE id = ${v1}`), /never change/);
    await refuses(db.execute(sql`UPDATE trading_strategy_versions SET status = 'draft' WHERE id = ${v1}`), /cannot become/);
    await db.execute(sql`UPDATE trading_strategy_versions SET status = 'superseded', superseded_at = now() WHERE id = ${v1}`);
    await refuses(db.execute(sql`UPDATE trading_strategy_versions SET status = 'approved' WHERE id = ${v1}`), /cannot become/);
  });

  it("writes the cache columns only together with active_version_id, and only for an approved version of the same strategy", async () => {
    const strategy = await insertStrategy(companyId);
    const draft = await insertVersion(strategy, companyId, 1);
    // A direct cache write is refused.
    await refuses(db.execute(sql`UPDATE trading_strategies SET rule_config = '{"type":"x"}'::jsonb WHERE id = ${strategy}`), /cache of the active version/);
    await refuses(db.execute(sql`UPDATE trading_strategies SET risk_config = '{"b":2}'::jsonb WHERE id = ${strategy}`), /cache of the active version/);
    // A name edit is a plain edit.
    await db.execute(sql`UPDATE trading_strategies SET name = 'renamed' WHERE id = ${strategy}`);
    // A draft cannot be activated.
    await refuses(db.execute(sql`UPDATE trading_strategies SET active_version_id = ${draft} WHERE id = ${strategy}`), /approved version/);
    await db.execute(sql`UPDATE trading_strategy_versions SET status = 'approved', approved_by_user_id = 'owner', approved_at = now() WHERE id = ${draft}`);
    // Another strategy's version, or another company's strategy, is refused by the composite key.
    const otherStrategy = await insertStrategy(companyId);
    await refuses(db.execute(sql`UPDATE trading_strategies SET active_version_id = ${draft} WHERE id = ${otherStrategy}`));
    // Activation writes the cache and the pointer in one statement.
    await db.execute(sql`UPDATE trading_strategies SET active_version_id = ${draft}, rule_config = '{"type":"strategy_spec"}'::jsonb, risk_config = '{"b":2}'::jsonb WHERE id = ${strategy}`);
    const [row] = await rows(sql`SELECT active_version_id, rule_config FROM trading_strategies WHERE id = ${strategy}`);
    expect(row).toEqual({ active_version_id: draft, rule_config: { type: "strategy_spec" } });
    // ...and a later direct cache write is refused again.
    await refuses(db.execute(sql`UPDATE trading_strategies SET rule_config = '{"type":"x"}'::jsonb WHERE id = ${strategy}`), /cache of the active version/);
  });

  it("keeps versions inside their company", async () => {
    const strategy = await insertStrategy(companyId);
    // The version names the other company: the composite key to the strategy does not care, but the active pointer does.
    const foreign = await insertVersion(strategy, otherCompanyId, 1, { status: "approved", grandfathered: true });
    await refuses(db.execute(sql`UPDATE trading_strategies SET active_version_id = ${foreign} WHERE id = ${strategy}`));
  });

  it("stamps orders and ledger rows with a version, and is safe to run twice", async () => {
    const v = await insertVersion(legacyStrategyId, companyId, 1, { status: "approved", grandfathered: true });
    await db.execute(sql`UPDATE trading_orders SET strategy_version_id = ${v} WHERE id = ${legacyOrderId}`);
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    const [o] = await rows(sql`SELECT strategy_version_id FROM trading_orders WHERE id = ${legacyOrderId}`);
    expect(o?.strategy_version_id).toBe(v);
    const [n] = await rows(sql`SELECT count(*)::int AS n FROM trading_strategy_versions WHERE id = ${v}`);
    expect(n?.n).toBe(1);
  });

  it("rolls back as documented without losing strategies, orders or ledger rows, and re-applies", async () => {
    const [before] = await rows(sql`SELECT (SELECT count(*)::int FROM trading_strategies) AS s, (SELECT count(*)::int FROM trading_orders) AS o, (SELECT count(*)::int FROM trading_ledger_entries) AS l`);
    await db.execute(sql`DROP TRIGGER IF EXISTS trading_strategies_cache_guard ON trading_strategies`);
    await db.execute(sql`DROP TRIGGER IF EXISTS trading_strategy_versions_guard ON trading_strategy_versions`);
    await db.execute(sql`DROP FUNCTION IF EXISTS trading_strategies_cache_guard()`);
    await db.execute(sql`DROP FUNCTION IF EXISTS trading_strategy_versions_guard()`);
    await db.execute(sql`ALTER TABLE trading_strategies DROP CONSTRAINT IF EXISTS trading_strategies_active_version_fk, DROP COLUMN IF EXISTS active_version_id`);
    await db.execute(sql`ALTER TABLE trading_orders DROP COLUMN IF EXISTS strategy_version_id`);
    await db.execute(sql`ALTER TABLE trading_ledger_entries DROP COLUMN IF EXISTS strategy_version_id`);
    await db.execute(sql`DROP TABLE IF EXISTS trading_strategy_versions`);
    const [after] = await rows(sql`SELECT (SELECT count(*)::int FROM trading_strategies) AS s, (SELECT count(*)::int FROM trading_orders) AS o, (SELECT count(*)::int FROM trading_ledger_entries) AS l`);
    expect(after).toEqual(before);
    // The old code keeps working: cache columns are plain columns again.
    await db.execute(sql`UPDATE trading_strategies SET rule_config = '{"type":"sma_crossover"}'::jsonb WHERE id = ${legacyStrategyId}`);
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    const [t] = await rows(sql`SELECT count(*)::int AS n FROM trading_strategy_versions`);
    expect(t?.n).toBe(0);
  });
});
