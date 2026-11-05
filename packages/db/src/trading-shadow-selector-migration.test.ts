import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * DUR-5015, migration 0273_trading_shadow_selector: the rehearsal. It proves
 * the upgrade keeps existing trading rows and a second run changes nothing,
 * that the documented rollback removes only the new objects and applies again,
 * that the tenant tables are policed by company, and that the database itself
 * keeps a shadow trade and a selector decision from being rewritten.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping migration 0273 test: ${support.reason ?? "unsupported environment"}`);

const MIGRATION_PATH = fileURLToPath(new URL("./migrations/0273_trading_shadow_selector.sql", import.meta.url));
const DIGEST = "a".repeat(64);
const TABLES = ["trading_selector_confirmations", "trading_selector_decisions", "trading_shadow_trades", "trading_shadow_cells", "trading_selector_rules"];

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

d("migration 0273_trading_shadow_selector", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const strategyId = randomUUID();

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
  const newCell = async (company = companyId, asset = "BTC", weather = "up") => {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO trading_shadow_cells (id, company_id, template_key, template_version, family, weather, asset) VALUES (${id}, ${company}, 'trend_pullback', 1, 'trend', ${weather}, ${asset})`);
    return id;
  };
  const newTrade = async (cellId: string, signalAt: string, over: { company?: string; asset?: string } = {}) => {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO trading_shadow_trades (id, company_id, cell_id, template_key, template_version, asset, timeframe, weather, signal_bar_close_at, weather_label) VALUES (${id}, ${over.company ?? companyId}, ${cellId}, 'trend_pullback', 1, ${over.asset ?? "BTC"}, '4h', 'up', ${signalAt}::timestamptz, '{"trend":"uptrend"}'::jsonb)`);
    return id;
  };
  const closeTrade = (id: string, signalAt: string) =>
    db.execute(sql`UPDATE trading_shadow_trades SET status = 'closed', entry_at = ${signalAt}::timestamptz, exit_at = ${signalAt}::timestamptz + interval '8 hours', entry_price = 100, exit_price = 103, exit_reason = 'target', bars_held = 2, r_1x = 1.2, r_2x = 1.0, net_return_1x = 0.02, net_return_2x = 0.012, resolved_at = now() WHERE id = ${id}`);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0273-shadow-selector-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Trading', 'TRD')`);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${otherCompanyId}, 'Other', 'OTH')`);
    await db.execute(sql`
      INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, cash_nok, peak_equity_nok)
      VALUES (${strategyId}, ${companyId}, 'S', 'BTC', ${JSON.stringify({ type: "sma_crossover", version: 1, fastPeriod: 10, slowPeriod: 30, orderSizeFraction: 0.1 })}::jsonb, '{}'::jsonb, 3000, 3000, 3000)
    `);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("upgrades a database that already holds trading rows without touching them, and a second run changes nothing", async () => {
    for (const statement of rollbackStatements()) await db.execute(sql.raw(statement));
    for (const table of TABLES) expect(await rows(sql`SELECT to_regclass(${table}) AS t`)).toEqual([{ t: null }]);
    const counts = () => rows(sql`SELECT (SELECT count(*) FROM trading_strategies)::int AS s, (SELECT count(*) FROM companies)::int AS c`);
    const before = await counts();

    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await counts()).toEqual(before);
    for (const table of TABLES) expect(await rows(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).toEqual([{ n: 0 }]);

    const objects = () =>
      rows(sql`SELECT (SELECT count(*) FROM pg_constraint WHERE conname LIKE 'trading_shadow_%' OR conname LIKE 'trading_selector_%')::int AS c, (SELECT count(*) FROM pg_indexes WHERE tablename LIKE 'trading_shadow_%' OR tablename LIKE 'trading_selector_%')::int AS i, (SELECT count(*) FROM pg_trigger WHERE (tgname LIKE 'trading_shadow_%' OR tgname LIKE 'trading_selector_%') AND NOT tgisinternal)::int AS t, (SELECT count(*) FROM pg_policies WHERE tablename LIKE 'trading_shadow_%' OR tablename LIKE 'trading_selector_%')::int AS p`);
    const firstRun = await objects();
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await objects()).toEqual(firstRun);
  });

  it("rolls back cleanly: the tables and their functions go, every old row stays; it applies again", async () => {
    const before = await rows(sql`SELECT (SELECT count(*) FROM trading_strategies)::int AS s, (SELECT count(*) FROM companies)::int AS c`);
    const statements = rollbackStatements();
    expect(statements).toHaveLength(10);
    for (const statement of statements) await db.execute(sql.raw(statement));
    for (const table of TABLES) expect(await rows(sql`SELECT to_regclass(${table}) AS t`)).toEqual([{ t: null }]);
    expect(await rows(sql`SELECT proname FROM pg_proc WHERE proname LIKE 'trading_shadow_%' OR proname LIKE 'trading_selector_%'`)).toEqual([]);
    expect(await rows(sql`SELECT (SELECT count(*) FROM trading_strategies)::int AS s, (SELECT count(*) FROM companies)::int AS c`)).toEqual(before);
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    for (const table of TABLES) expect(await rows(sql`SELECT to_regclass(${table}) AS t`)).not.toEqual([{ t: null }]);
  });

  it("polices the four tenant tables by company; the rules table is instance-wide", async () => {
    for (const table of TABLES.filter((t) => t !== "trading_selector_rules")) {
      expect(await rows(sql`SELECT relrowsecurity FROM pg_class WHERE relname = ${table}`)).toEqual([{ relrowsecurity: true }]);
      expect(await rows(sql`SELECT policyname FROM pg_policies WHERE tablename = ${table}`)).toEqual([{ policyname: "paperclip_company_scope" }]);
    }
    expect(await rows(sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'trading_selector_rules' AND column_name = 'company_id'`)).toEqual([{ n: 0 }]);
  });

  it("a shadow trade starts open, and the server stamps its decision time", async () => {
    const cell = await newCell();
    await refused(sql`INSERT INTO trading_shadow_trades (company_id, cell_id, template_key, template_version, asset, timeframe, weather, signal_bar_close_at, weather_label, status, entry_at, exit_at, entry_price, exit_price, exit_reason, net_return_1x, net_return_2x, resolved_at) VALUES (${companyId}, ${cell}, 't', 1, 'BTC', '4h', 'up', now() - interval '1 hour', '{}'::jsonb, 'closed', now(), now(), 1, 1, 'x', 0, 0, now())`, /starts open/);
    await refused(sql`INSERT INTO trading_shadow_trades (company_id, cell_id, template_key, template_version, asset, timeframe, weather, signal_bar_close_at, weather_label) VALUES (${companyId}, ${cell}, 't', 1, 'BTC', '4h', 'up', now() + interval '1 hour', '{}'::jsonb)`, /has not closed yet/);
    const id = await newTrade(cell, "2026-01-01T00:00:00Z");
    const [row] = await rows(sql`SELECT decided_at > now() - interval '1 minute' AS stamped FROM trading_shadow_trades WHERE id = ${id}`);
    expect(row).toEqual({ stamped: true });
  });

  it("allows one open trade per template version and coin, and one signal per bar", async () => {
    const cell = await newCell(companyId, "ETH");
    const first = await newTrade(cell, "2026-01-02T00:00:00Z", { asset: "ETH" });
    await refused(sql`INSERT INTO trading_shadow_trades (company_id, cell_id, template_key, template_version, asset, timeframe, weather, signal_bar_close_at, weather_label) VALUES (${companyId}, ${cell}, 'trend_pullback', 1, 'ETH', '4h', 'up', '2026-01-02T04:00:00Z', '{}'::jsonb)`, /one_open_uq/);
    await closeTrade(first, "2026-01-02T04:00:00Z");
    // The same bar cannot be signalled twice even after the first closed.
    await refused(sql`INSERT INTO trading_shadow_trades (company_id, cell_id, template_key, template_version, asset, timeframe, weather, signal_bar_close_at, weather_label) VALUES (${companyId}, ${cell}, 'trend_pullback', 1, 'ETH', '4h', 'up', '2026-01-02T00:00:00Z', '{}'::jsonb)`, /one_per_bar_uq/);
    await newTrade(cell, "2026-01-03T00:00:00Z", { asset: "ETH" });
  });

  it("keeps what a trade was decided on fixed and makes a closed trade final", async () => {
    const cell = await newCell(companyId, "SOL");
    const id = await newTrade(cell, "2026-01-04T00:00:00Z", { asset: "SOL" });
    await refused(sql`UPDATE trading_shadow_trades SET weather = 'range' WHERE id = ${id}`, /never changes/);
    await refused(sql`UPDATE trading_shadow_trades SET signal_bar_close_at = signal_bar_close_at + interval '1 hour' WHERE id = ${id}`, /never changes/);
    await refused(sql`UPDATE trading_shadow_trades SET weather_label = '{"trend":"downtrend"}'::jsonb WHERE id = ${id}`, /never changes/);
    await refused(sql`UPDATE trading_shadow_trades SET status = 'closed' WHERE id = ${id}`, /closed_check/);
    await closeTrade(id, "2026-01-04T00:00:00Z");
    await refused(sql`UPDATE trading_shadow_trades SET r_2x = 9 WHERE id = ${id}`, /closed shadow trade is final/);
    await refused(sql`UPDATE trading_shadow_trades SET status = 'void', void_reason = 'x' WHERE id = ${id}`, /closed shadow trade is final/);
  });

  it("a void trade carries a reason and no result", async () => {
    const cell = await newCell(companyId, "ADA");
    const id = await newTrade(cell, "2026-01-05T00:00:00Z", { asset: "ADA" });
    await refused(sql`UPDATE trading_shadow_trades SET status = 'void', resolved_at = now() WHERE id = ${id}`, /closed_check/);
    await db.execute(sql`UPDATE trading_shadow_trades SET status = 'void', void_reason = 'engine did not enter', resolved_at = now() WHERE id = ${id}`);
  });

  it("a selector decision is a record: it never changes, and it can never say a risk cap changed", async () => {
    await db.execute(sql`INSERT INTO trading_selector_rules (version, rules, digest, note) VALUES (1, '{"fdrQ":0.1}'::jsonb, ${DIGEST}, 'first')`);
    await refused(sql`UPDATE trading_selector_rules SET note = 'edited' WHERE version = 1`, /rules version is final/);
    const decisionId = randomUUID();
    const insert = (id: string, extra = sql`false`) =>
      db.execute(sql`INSERT INTO trading_selector_decisions (id, company_id, checkpoint_at, rules_version, rules_digest, decided_at, state_before, output, input_digest, output_digest, choice, trials, tested, discoveries, reason, risk_caps_changed) VALUES (${id}, ${companyId}, '2026-02-01T00:00:00Z', 1, ${DIGEST}, now(), '{}'::jsonb, '{}'::jsonb, ${DIGEST}, ${DIGEST}, 'cash', 12, 0, 0, 'cash', ${extra})`);
    await refused(sql`INSERT INTO trading_selector_decisions (company_id, checkpoint_at, rules_version, rules_digest, decided_at, state_before, output, input_digest, output_digest, choice, trials, tested, discoveries, reason, risk_caps_changed) VALUES (${companyId}, '2026-03-01T00:00:00Z', 1, ${DIGEST}, now(), '{}'::jsonb, '{}'::jsonb, ${DIGEST}, ${DIGEST}, 'cash', 1, 0, 0, 'x', true)`, /risk_check/);
    await insert(decisionId);
    await refused(sql`INSERT INTO trading_selector_decisions (company_id, checkpoint_at, rules_version, rules_digest, decided_at, state_before, output, input_digest, output_digest, choice, trials, tested, discoveries, reason) VALUES (${companyId}, '2026-02-01T00:00:00Z', 1, ${DIGEST}, now(), '{}'::jsonb, '{}'::jsonb, ${DIGEST}, ${DIGEST}, 'cash', 1, 0, 0, 'x')`, /checkpoint_uq/);
    await refused(sql`UPDATE trading_selector_decisions SET choice = 'cells' WHERE id = ${decisionId}`, /never changes/);
    await refused(sql`UPDATE trading_selector_decisions SET reason = 'edited' WHERE id = ${decisionId}`, /never changes/);
    // An unknown rules version cannot be named.
    await refused(sql`INSERT INTO trading_selector_decisions (company_id, checkpoint_at, rules_version, rules_digest, decided_at, state_before, output, input_digest, output_digest, choice, trials, tested, discoveries, reason) VALUES (${companyId}, '2026-04-01T00:00:00Z', 99, ${DIGEST}, now(), '{}'::jsonb, '{}'::jsonb, ${DIGEST}, ${DIGEST}, 'cash', 1, 0, 0, 'x')`, /rules_version/);
  });

  it("confirmation windows move forward only; a failed one is final; one live window per cell", async () => {
    const cell = await newCell(companyId, "XRP");
    const [decision] = await rows(sql`SELECT id FROM trading_selector_decisions LIMIT 1`);
    const open = async () => {
      const id = randomUUID();
      await db.execute(sql`INSERT INTO trading_selector_confirmations (id, company_id, cell_id, opened_checkpoint_at, opened_decision_id) VALUES (${id}, ${companyId}, ${cell}, '2026-02-01T00:00:00Z', ${decision!.id as string})`);
      return id;
    };
    const first = await open();
    await refused(sql`INSERT INTO trading_selector_confirmations (company_id, cell_id, opened_checkpoint_at, opened_decision_id) VALUES (${companyId}, ${cell}, '2026-03-01T00:00:00Z', ${decision!.id as string})`, /one_live_uq/);
    await refused(sql`UPDATE trading_selector_confirmations SET promoted = true WHERE id = ${first}`, /promoted_check/);
    await refused(sql`UPDATE trading_selector_confirmations SET opened_checkpoint_at = '2026-01-01T00:00:00Z' WHERE id = ${first}`, /never changes/);
    await db.execute(sql`UPDATE trading_selector_confirmations SET status = 'passed', promoted = true, promoted_at = now() WHERE id = ${first}`);
    await db.execute(sql`UPDATE trading_selector_confirmations SET status = 'failed', promoted = false, demoted_at = now() WHERE id = ${first}`);
    await refused(sql`UPDATE trading_selector_confirmations SET status = 'passed' WHERE id = ${first}`, /final/);
    // Once the old window ended, the cell may earn another.
    await open();
  });

  it("removing a company removes its shadow data and nothing of another company", async () => {
    const cell = await newCell(otherCompanyId, "BTC");
    await newTrade(cell, "2026-01-06T00:00:00Z", { company: otherCompanyId });
    const mine = (await rows(sql`SELECT count(*)::int AS n FROM trading_shadow_trades WHERE company_id = ${companyId}`))[0]!.n as number;
    await db.execute(sql`DELETE FROM companies WHERE id = ${otherCompanyId}`);
    expect(await rows(sql`SELECT count(*)::int AS n FROM trading_shadow_trades WHERE company_id = ${otherCompanyId}`)).toEqual([{ n: 0 }]);
    expect(await rows(sql`SELECT count(*)::int AS n FROM trading_shadow_cells WHERE company_id = ${otherCompanyId}`)).toEqual([{ n: 0 }]);
    expect(await rows(sql`SELECT count(*)::int AS n FROM trading_shadow_trades WHERE company_id = ${companyId}`)).toEqual([{ n: mine }]);
  });
});
