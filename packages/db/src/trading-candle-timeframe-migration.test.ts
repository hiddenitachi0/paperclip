import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0261_trading_candle_timeframe (DUR-4999) applies on the
 * embedded-Postgres path (every migration, in journal order), gives existing
 * strategies the 15m timeframe and no evaluated bar, accepts only the four
 * supported timeframes, is safe to run twice, and rolls back by dropping the
 * two columns and the one check.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0261 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0261_trading_candle_timeframe";
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

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0261-trading-timeframe-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Trading', 'TRD')`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }

  async function insertStrategy(timeframe?: string): Promise<string> {
    const id = randomUUID();
    const base = sql`INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, cash_nok, peak_equity_nok`;
    if (timeframe === undefined) {
      await db.execute(sql`${base}) VALUES (${id}, ${companyId}, 'S', 'BTC', '{}'::jsonb, '{}'::jsonb, 1000, 1000, 1000)`);
    } else {
      await db.execute(sql`${base}, timeframe) VALUES (${id}, ${companyId}, 'S', 'BTC', '{}'::jsonb, '{}'::jsonb, 1000, 1000, 1000, ${timeframe})`);
    }
    return id;
  }

  it("gives a row inserted without a timeframe 15m and no evaluated bar", async () => {
    const id = await insertStrategy();
    const [row] = await rows(sql`SELECT timeframe, last_evaluated_bar_at FROM trading_strategies WHERE id = ${id}`);
    expect(row).toEqual({ timeframe: "15m", last_evaluated_bar_at: null });
  });

  it("accepts each supported timeframe and refuses anything else", async () => {
    for (const timeframe of ["15m", "1h", "4h", "1d"]) {
      const id = await insertStrategy(timeframe);
      const [row] = await rows(sql`SELECT timeframe FROM trading_strategies WHERE id = ${id}`);
      expect(row?.timeframe).toBe(timeframe);
    }
    await expect(insertStrategy("5m")).rejects.toThrow();
  });

  it("is safe to run twice and keeps existing rows untouched", async () => {
    const id = await insertStrategy("1h");
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    const [row] = await rows(sql`SELECT timeframe FROM trading_strategies WHERE id = ${id}`);
    expect(row?.timeframe).toBe("1h");
  });

  it("rolls back by dropping the check and the two columns without losing strategies", async () => {
    const [before] = await rows(sql`SELECT count(*)::int AS n FROM trading_strategies`);
    await db.execute(sql`ALTER TABLE trading_strategies DROP CONSTRAINT IF EXISTS trading_strategies_timeframe_check, DROP COLUMN IF EXISTS timeframe, DROP COLUMN IF EXISTS last_evaluated_bar_at`);
    const cols = await rows(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'trading_strategies' AND column_name IN ('timeframe', 'last_evaluated_bar_at')`);
    expect(cols).toHaveLength(0);
    const [after] = await rows(sql`SELECT count(*)::int AS n FROM trading_strategies`);
    expect(after?.n).toBe(before?.n);
    // Re-applying restores the columns and defaults every surviving row to 15m.
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    const [row] = await rows(sql`SELECT count(*)::int AS n FROM trading_strategies WHERE timeframe = '15m'`);
    expect(row?.n).toBe(after?.n);
  });
});
