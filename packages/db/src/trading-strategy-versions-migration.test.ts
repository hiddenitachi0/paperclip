import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * DUR-5002, migration 0263_trading_strategy_versions: the rehearsal. It runs
 * against a database that already holds a strategy, an order and a ledger row,
 * proves the upgrade keeps every one of them (new columns NULL), that a second
 * run changes nothing, that the documented rollback removes only the new
 * objects and leaves the old rows alone, and that the database itself refuses
 * to edit an approved version or to point a strategy at a version that is not
 * its own approved one.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0263 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_PATH = fileURLToPath(new URL("./migrations/0263_trading_strategy_versions.sql", import.meta.url));
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

d("migration 0263_trading_strategy_versions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const strategyId = randomUUID();
  const otherStrategyId = randomUUID();

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }

  async function insertVersion(over: { strategy?: string; version?: number; status?: string; grandfathered?: boolean; approvedBy?: string | null; approvedAt?: boolean } = {}) {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO trading_strategy_versions (id, company_id, strategy_id, version, spec, guidelines, status, proposed_by_type, proposed_by_id, approved_by_user_id, approved_at, spec_digest, grandfathered)
      VALUES (${id}, ${companyId}, ${over.strategy ?? strategyId}, ${over.version ?? 1}, ${JSON.stringify({ a: 1 })}::jsonb, 'g', ${over.status ?? "draft"}, 'user', 'u1',
              ${over.approvedBy ?? null}, ${over.approvedAt ? sql`now()` : null}, ${DIGEST}, ${over.grandfathered ?? false})
    `);
    return id;
  }

  async function fails(statement: ReturnType<typeof sql>, message: RegExp) {
    let error: unknown = null;
    try {
      await db.execute(statement);
    } catch (err) {
      error = err;
    }
    expect(String((error as { cause?: { message?: string }; message?: string } | null)?.cause?.message ?? (error as Error | null)?.message ?? error)).toMatch(message);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0263-trading-versions-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Trading', 'TRD')`);
    for (const id of [strategyId, otherStrategyId]) {
      await db.execute(sql`
        INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, cash_nok, peak_equity_nok)
        VALUES (${id}, ${companyId}, 'S', 'BTC', ${JSON.stringify({ type: "sma_crossover", version: 1, fastPeriod: 10, slowPeriod: 30, orderSizeFraction: 0.1 })}::jsonb, '{}'::jsonb, 3000, 3000, 3000)
      `);
    }
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("upgrades a database that already holds trading rows without touching them, and a second run changes nothing", async () => {
    // Put the database back into its pre-0263 shape, with real rows in it.
    for (const statement of rollbackStatements()) await db.execute(sql.raw(statement));
    const orderId = randomUUID();
    await db.execute(sql`
      INSERT INTO trading_orders (id, company_id, strategy_id, side, status, rule_version, signal_price_nok, requested_quantity)
      VALUES (${orderId}, ${companyId}, ${strategyId}, 'buy', 'filled', 'sma_crossover@1 · engine 2', 100, 1)
    `);
    await db.execute(sql`INSERT INTO trading_ledger_entries (company_id, strategy_id, order_id, event_type) VALUES (${companyId}, ${strategyId}, ${orderId}, 'signal')`);
    const before = await rows(sql`SELECT (SELECT count(*) FROM trading_strategies)::int AS s, (SELECT count(*) FROM trading_orders)::int AS o, (SELECT count(*) FROM trading_ledger_entries)::int AS l`);

    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    const after = await rows(sql`SELECT (SELECT count(*) FROM trading_strategies)::int AS s, (SELECT count(*) FROM trading_orders)::int AS o, (SELECT count(*) FROM trading_ledger_entries)::int AS l`);
    expect(after).toEqual(before);
    const stamped = await rows(sql`
      SELECT s.active_version_id, s.position_levels, o.strategy_version_id AS order_version, l.strategy_version_id AS ledger_version, s.rule_config
      FROM trading_strategies s, trading_orders o, trading_ledger_entries l WHERE s.id = ${strategyId} AND o.id = ${orderId} AND l.order_id = ${orderId}
    `);
    expect(stamped[0]).toMatchObject({ active_version_id: null, position_levels: null, order_version: null, ledger_version: null });
    expect((stamped[0]!.rule_config as { fastPeriod: number }).fastPeriod).toBe(10);

    // Second run: no error, no new object.
    const objects = async () =>
      rows(sql`SELECT (SELECT count(*) FROM pg_constraint WHERE conname LIKE 'trading_%version%')::int AS c, (SELECT count(*) FROM pg_indexes WHERE tablename = 'trading_strategy_versions')::int AS i, (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trading_%' AND NOT tgisinternal)::int AS t, (SELECT count(*) FROM pg_policies WHERE tablename = 'trading_strategy_versions')::int AS p`);
    const firstRun = await objects();
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await objects()).toEqual(firstRun);
  });

  it("rolls back cleanly: the new objects go, every old row stays", async () => {
    const orderId = (await rows(sql`SELECT id FROM trading_orders WHERE strategy_id = ${strategyId}`))[0]!.id as string;
    const before = await rows(sql`SELECT (SELECT count(*) FROM trading_strategies)::int AS s, (SELECT count(*) FROM trading_orders)::int AS o, (SELECT count(*) FROM trading_ledger_entries)::int AS l`);
    const statements = rollbackStatements();
    expect(statements.length).toBeGreaterThanOrEqual(6);
    for (const statement of statements) await db.execute(sql.raw(statement));
    expect(await rows(sql`SELECT to_regclass('trading_strategy_versions') AS t`)).toEqual([{ t: null }]);
    expect(await rows(sql`SELECT 1 FROM information_schema.columns WHERE table_name IN ('trading_strategies','trading_orders','trading_ledger_entries') AND column_name IN ('active_version_id','position_levels','strategy_version_id')`)).toEqual([]);
    expect(await rows(sql`SELECT (SELECT count(*) FROM trading_strategies)::int AS s, (SELECT count(*) FROM trading_orders)::int AS o, (SELECT count(*) FROM trading_ledger_entries)::int AS l`)).toEqual(before);
    expect((await rows(sql`SELECT rule_version FROM trading_orders WHERE id = ${orderId}`))[0]).toEqual({ rule_version: "sma_crossover@1 · engine 2" });
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement)); // and it applies again
    expect(await rows(sql`SELECT to_regclass('trading_strategy_versions') AS t`)).not.toEqual([{ t: null }]);
  });

  it("polices the table by company like every other tenant table", async () => {
    const info = await rows(sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'trading_strategy_versions'`);
    expect(info[0]).toEqual({ relrowsecurity: true });
    const policies = await rows(sql`SELECT policyname FROM pg_policies WHERE tablename = 'trading_strategy_versions'`);
    expect(policies).toEqual([{ policyname: "paperclip_company_scope" }]);
  });

  describe("immutability, enforced by the database", () => {
    it("a draft's rules, guidelines and digest never change; its status can move on", async () => {
      const id = await insertVersion({ version: 1 });
      await fails(sql`UPDATE trading_strategy_versions SET spec = '{"a":2}'::jsonb WHERE id = ${id}`, /never change/);
      await fails(sql`UPDATE trading_strategy_versions SET guidelines = 'other' WHERE id = ${id}`, /never change/);
      await fails(sql`UPDATE trading_strategy_versions SET spec_digest = ${"b".repeat(64)} WHERE id = ${id}`, /never change/);
      await fails(sql`UPDATE trading_strategy_versions SET version = 9 WHERE id = ${id}`, /never change/);
      await fails(sql`UPDATE trading_strategy_versions SET proposed_by_id = 'someone-else' WHERE id = ${id}`, /never change/);
      await db.execute(sql`UPDATE trading_strategy_versions SET status = 'superseded', superseded_at = now() WHERE id = ${id}`);
    });

    it("an approved version can only be superseded; a superseded one is final", async () => {
      const id = await insertVersion({ version: 2, status: "approved", approvedBy: "owner-1", approvedAt: true });
      await fails(sql`UPDATE trading_strategy_versions SET status = 'draft' WHERE id = ${id}`, /cannot move from approved to draft/);
      await fails(sql`UPDATE trading_strategy_versions SET spec = '{"a":3}'::jsonb WHERE id = ${id}`, /never change/);
      await fails(sql`UPDATE trading_strategy_versions SET approved_by_user_id = 'someone-else' WHERE id = ${id}`, /never changes/);
      await fails(sql`UPDATE trading_strategy_versions SET approval_id = ${randomUUID()} WHERE id = ${id}`, /approval card|foreign key/);
      await db.execute(sql`UPDATE trading_strategy_versions SET status = 'superseded', superseded_at = now() WHERE id = ${id}`);
      await fails(sql`UPDATE trading_strategy_versions SET status = 'approved' WHERE id = ${id}`, /cannot move from superseded to approved/);
      await fails(sql`UPDATE trading_strategy_versions SET superseded_at = now() + interval '1 day' WHERE id = ${id}`, /final/);
    });

    it("an approved version always names who approved it and when, except a grandfathered conversion", async () => {
      await fails(
        sql`INSERT INTO trading_strategy_versions (company_id, strategy_id, version, spec, status, proposed_by_type, proposed_by_id, spec_digest) VALUES (${companyId}, ${strategyId}, 70, '{}'::jsonb, 'approved', 'user', 'u', ${DIGEST})`,
        /approval_pair_check/,
      );
      await insertVersion({ version: 71, status: "approved", grandfathered: true, approvedAt: true });
      await db.execute(sql`UPDATE trading_strategy_versions SET status = 'superseded', superseded_at = now() WHERE strategy_id = ${strategyId} AND version = 71`);
    });

    it("at most one approved version per strategy, one number per version", async () => {
      const first = await insertVersion({ strategy: otherStrategyId, version: 1, status: "approved", approvedBy: "o", approvedAt: true });
      await fails(sql`INSERT INTO trading_strategy_versions (company_id, strategy_id, version, spec, status, proposed_by_type, proposed_by_id, approved_by_user_id, approved_at, spec_digest) VALUES (${companyId}, ${otherStrategyId}, 2, '{}'::jsonb, 'approved', 'user', 'u', 'o', now(), ${DIGEST})`, /one_approved_uq/);
      await fails(sql`INSERT INTO trading_strategy_versions (company_id, strategy_id, version, spec, proposed_by_type, proposed_by_id, spec_digest) VALUES (${companyId}, ${otherStrategyId}, 1, '{}'::jsonb, 'user', 'u', ${DIGEST})`, /strategy_version_uq/);
      await db.execute(sql`UPDATE trading_strategy_versions SET status = 'superseded', superseded_at = now() WHERE id = ${first}`);
    });

    it("rejects a malformed digest and an unknown proposer type", async () => {
      await fails(sql`INSERT INTO trading_strategy_versions (company_id, strategy_id, version, spec, proposed_by_type, proposed_by_id, spec_digest) VALUES (${companyId}, ${strategyId}, 80, '{}'::jsonb, 'user', 'u', 'nope')`, /digest_check/);
      await fails(sql`INSERT INTO trading_strategy_versions (company_id, strategy_id, version, spec, proposed_by_type, proposed_by_id, spec_digest) VALUES (${companyId}, ${strategyId}, 81, '{}'::jsonb, 'robot', 'u', ${DIGEST})`, /proposer_check/);
    });
  });

  describe("the active version is always an approved version of the same strategy", () => {
    it("refuses a draft, another strategy's version, and a superseded one; accepts its own approved version", async () => {
      const draft = await insertVersion({ version: 90 });
      const foreign = await insertVersion({ strategy: otherStrategyId, version: 91, status: "approved", approvedBy: "o", approvedAt: true });
      const own = await insertVersion({ version: 92, status: "approved", approvedBy: "o", approvedAt: true });
      await fails(sql`UPDATE trading_strategies SET active_version_id = ${draft} WHERE id = ${strategyId}`, /approved version of this same strategy/);
      await fails(sql`UPDATE trading_strategies SET active_version_id = ${foreign} WHERE id = ${strategyId}`, /approved version of this same strategy/);
      await db.execute(sql`UPDATE trading_strategies SET active_version_id = ${own} WHERE id = ${strategyId}`);
      expect((await rows(sql`SELECT active_version_id FROM trading_strategies WHERE id = ${strategyId}`))[0]).toEqual({ active_version_id: own });
      // other columns can be updated freely afterwards; the guard only watches active_version_id
      await db.execute(sql`UPDATE trading_strategies SET cash_nok = 1 WHERE id = ${strategyId}`);
      await db.execute(sql`UPDATE trading_strategies SET active_version_id = NULL WHERE id = ${strategyId}`);
      await db.execute(sql`UPDATE trading_strategy_versions SET status = 'superseded', superseded_at = now() WHERE id = ${foreign}`);
      await fails(sql`UPDATE trading_strategies SET active_version_id = ${foreign} WHERE id = ${otherStrategyId}`, /approved version of this same strategy/);
    });
  });

  it("deleting a strategy takes its versions with it", async () => {
    const strategy = randomUUID();
    await db.execute(sql`
      INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, cash_nok, peak_equity_nok)
      VALUES (${strategy}, ${companyId}, 'Temp', 'ETH', '{}'::jsonb, '{}'::jsonb, 1, 1, 1)
    `);
    await insertVersion({ strategy, version: 1, status: "approved", approvedBy: "o", approvedAt: true });
    await db.execute(sql`DELETE FROM trading_strategies WHERE id = ${strategy}`);
    expect(await rows(sql`SELECT 1 FROM trading_strategy_versions WHERE strategy_id = ${strategy}`)).toEqual([]);
  });
});
