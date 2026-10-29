import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0262_trading_fx_rates (DUR-5001), rehearsed the way production
 * meets it: the database is first put back into its pre-0262 shape (the
 * rollback below), old-style trading rows are written into that shape, and
 * then the migration is applied on top. Covers the backfill of existing orders,
 * lots and strategies, a second run being a no-op, and the rollback leaving
 * every order, lot and strategy in place.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0262 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0262_trading_fx_rates";
const MIGRATION_PATH = fileURLToPath(new URL(`./migrations/${MIGRATION_TAG}.sql`, import.meta.url));

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
  const ids = { strategyWithQuote: randomUUID(), strategyWithoutQuote: randomUUID(), filledBuy: randomUUID(), filledSell: randomUUID(), rejected: randomUUID(), lot: randomUUID() };

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }

  async function applyMigration() {
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
  }

  async function rollBack() {
    await db.execute(sql`ALTER TABLE trading_strategies DROP COLUMN IF EXISTS starting_quote_usd, DROP COLUMN IF EXISTS starting_cash_usd, DROP COLUMN IF EXISTS cash_usd, DROP COLUMN IF EXISTS peak_equity_usd`);
    await db.execute(sql`ALTER TABLE trading_fifo_lots DROP COLUMN IF EXISTS fx_rate, DROP COLUMN IF EXISTS fx_date, DROP COLUMN IF EXISTS fx_source`);
    await db.execute(sql`ALTER TABLE trading_orders DROP COLUMN IF EXISTS fx_rate, DROP COLUMN IF EXISTS fx_date, DROP COLUMN IF EXISTS fx_source`);
    await db.execute(sql`DROP TABLE IF EXISTS fx_rates`);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0262-trading-fx-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Trading', 'TRD')`);

    // Back to the pre-0262 shape, then write rows the way the old code did.
    await rollBack();
    await db.execute(sql`
      INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, starting_quote_nok, cash_nok, position_quantity, position_cost_nok, peak_equity_nok)
      VALUES (${ids.strategyWithQuote}, ${companyId}, 'Has quote', 'BTC', '{}'::jsonb, '{}'::jsonb, 2000, 230, 1000, 4, 1000, 2300)`);
    await db.execute(sql`
      INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, starting_quote_nok, cash_nok, peak_equity_nok)
      VALUES (${ids.strategyWithoutQuote}, ${companyId}, 'No quote', 'ETH', '{}'::jsonb, '{}'::jsonb, 1150, NULL, 1150, 1150)`);
    await db.execute(sql`
      INSERT INTO trading_orders (id, company_id, strategy_id, side, status, rule_version, signal_price_nok, requested_quantity, filled_quantity, filled_price_nok, fee_nok)
      VALUES (${ids.filledBuy}, ${companyId}, ${ids.strategyWithQuote}, 'buy', 'filled', 'sma_crossover@1', 230, 4, 4, 230, 2.5)`);
    await db.execute(sql`
      INSERT INTO trading_orders (id, company_id, strategy_id, side, status, rule_version, signal_price_nok, requested_quantity, filled_quantity, filled_price_nok, fee_nok, realized_pnl_nok)
      VALUES (${ids.filledSell}, ${companyId}, ${ids.strategyWithQuote}, 'sell', 'filled', 'sma_crossover@1', 230, 1, 1, 240, 0.6, 9)`);
    await db.execute(sql`
      INSERT INTO trading_orders (id, company_id, strategy_id, side, status, rule_version, signal_price_nok, requested_quantity, rejection_reason)
      VALUES (${ids.rejected}, ${companyId}, ${ids.strategyWithQuote}, 'buy', 'rejected', 'sma_crossover@1', 230, 4, 'risk')`);
    await db.execute(sql`
      INSERT INTO trading_fifo_lots (id, company_id, strategy_id, source_order_id, quantity_remaining, cost_nok_per_unit, acquired_at)
      VALUES (${ids.lot}, ${companyId}, ${ids.strategyWithQuote}, ${ids.filledBuy}, 4, 230.6, now())`);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("marks existing fills and lots as the fixed 11.5 estimate, and so are rejected orders (their signal price was converted at 11.5 too)", async () => {
    await applyMigration();
    const marked = await rows(sql`SELECT id, fx_rate, fx_date, fx_source FROM trading_orders WHERE id IN (${ids.filledBuy}, ${ids.filledSell})`);
    expect(marked).toHaveLength(2);
    for (const row of marked) expect(row).toMatchObject({ fx_rate: 11.5, fx_date: null, fx_source: "fixed_estimate_11.5" });
    const [lot] = await rows(sql`SELECT fx_rate, fx_date, fx_source FROM trading_fifo_lots WHERE id = ${ids.lot}`);
    expect(lot).toEqual({ fx_rate: 11.5, fx_date: null, fx_source: "fixed_estimate_11.5" });
    const [rejected] = await rows(sql`SELECT fx_rate, fx_source FROM trading_orders WHERE id = ${ids.rejected}`);
    expect(rejected).toEqual({ fx_rate: 11.5, fx_source: "fixed_estimate_11.5" });
  });

  it("backfills the USD side of each strategy as the NOK figure / 11.5 and leaves the NOK columns alone", async () => {
    const [row] = await rows(sql`SELECT starting_quote_usd, starting_cash_usd, cash_usd, peak_equity_usd, starting_cash_nok, cash_nok, peak_equity_nok, starting_quote_nok FROM trading_strategies WHERE id = ${ids.strategyWithQuote}`);
    expect(row?.starting_quote_usd).toBeCloseTo(20, 9);
    expect(row?.starting_cash_usd).toBeCloseTo(2000 / 11.5, 9);
    expect(row?.cash_usd).toBeCloseTo(1000 / 11.5, 9);
    expect(row?.peak_equity_usd).toBeCloseTo(2300 / 11.5, 9);
    expect(row).toMatchObject({ starting_cash_nok: 2000, cash_nok: 1000, peak_equity_nok: 2300, starting_quote_nok: 230 });
    const [noQuote] = await rows(sql`SELECT starting_quote_usd, starting_cash_usd FROM trading_strategies WHERE id = ${ids.strategyWithoutQuote}`);
    expect(noQuote?.starting_quote_usd).toBeNull();
    expect(noQuote?.starting_cash_usd).toBeCloseTo(100, 9);
  });

  it("creates fx_rates: one row per date, a positive rate only", async () => {
    await db.execute(sql`INSERT INTO fx_rates (rate_date, rate, source) VALUES ('2026-10-23', 9.35, 'norges_bank')`);
    await expect(db.execute(sql`INSERT INTO fx_rates (rate_date, rate, source) VALUES ('2026-10-23', 9.4, 'norges_bank')`)).rejects.toThrow();
    await expect(db.execute(sql`INSERT INTO fx_rates (rate_date, rate, source) VALUES ('2026-10-26', 0, 'norges_bank')`)).rejects.toThrow();
    const [row] = await rows(sql`SELECT rate_date::text AS rate_date, rate, source, published_at IS NOT NULL AS has_published_at FROM fx_rates`);
    expect(row).toEqual({ rate_date: "2026-10-23", rate: 9.35, source: "norges_bank", has_published_at: true });
  });

  it("is safe to run twice: nothing already marked or backfilled is touched", async () => {
    await db.execute(sql`UPDATE trading_orders SET fx_rate = 9.35, fx_date = '2026-10-23', fx_source = 'norges_bank' WHERE id = ${ids.filledSell}`);
    await db.execute(sql`UPDATE trading_strategies SET cash_usd = 77 WHERE id = ${ids.strategyWithQuote}`);
    await applyMigration();
    const [order] = await rows(sql`SELECT fx_rate, fx_date::text AS fx_date, fx_source FROM trading_orders WHERE id = ${ids.filledSell}`);
    expect(order).toEqual({ fx_rate: 9.35, fx_date: "2026-10-23", fx_source: "norges_bank" });
    const [strategy] = await rows(sql`SELECT cash_usd FROM trading_strategies WHERE id = ${ids.strategyWithQuote}`);
    expect(strategy?.cash_usd).toBe(77);
    const [{ n }] = (await rows(sql`SELECT count(*)::int AS n FROM fx_rates`)) as Array<{ n: number }>;
    expect(n).toBe(1);
  });

  it("rolls back without losing a single order, lot or strategy, and re-applies cleanly", async () => {
    await rollBack();
    const [counts] = await rows(sql`SELECT (SELECT count(*)::int FROM trading_orders) AS orders, (SELECT count(*)::int FROM trading_fifo_lots) AS lots, (SELECT count(*)::int FROM trading_strategies) AS strategies`);
    expect(counts).toEqual({ orders: 3, lots: 1, strategies: 2 });
    await applyMigration();
    const [marked] = await rows(sql`SELECT count(*)::int AS n FROM trading_orders WHERE fx_source = 'fixed_estimate_11.5'`);
    expect(marked?.n).toBe(3);
  });
});
