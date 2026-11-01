import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * DUR-5010, migration 0267_trading_predictions: the rehearsal and the guards.
 * The table's integrity rules live in the database, so they are tested against
 * a real Postgres: forecast columns cannot be updated, a second resolution is
 * refused, a duplicate prediction for a bar is refused, a prediction that uses
 * data from after it was made is refused, the cascades from companies and
 * strategies still work, no verdict can be written before the planned sample
 * size and test period, and the upgrade/rollback keep every older row.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0267 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_PATH = fileURLToPath(new URL("./migrations/0267_trading_predictions.sql", import.meta.url));

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
    .filter((line) => /^--\s{3}(DROP|ALTER|DELETE)/.test(line))
    .map((line) => line.replace(/^--\s+/, "").trim());
}

const MIN = 60_000;
const HOUR = 60 * MIN;

d("migration 0267_trading_predictions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const strategyId = randomUUID();

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
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

  /** A fresh, valid, unresolved prediction: the bar closed 1h ago, one bar of 4h ahead is still to come. */
  async function insertPrediction(over: Partial<Record<string, string | number | null>> = {}, strategy = strategyId, company = companyId) {
    const id = randomUUID();
    const barClose = new Date(Date.now() - HOUR);
    const v = {
      forecaster_key: "rule",
      forecaster_kind: "rule",
      asset: "BTC",
      spec_version: 1,
      bar_close_at: barClose.toISOString(),
      data_cutoff_at: barClose.toISOString(),
      resolves_at: new Date(barClose.getTime() + 4 * HOUR).toISOString(),
      direction: "up",
      probability: null as number | null,
      probability_source: null as string | null,
      ...over,
    };
    await db.execute(sql`
      INSERT INTO trading_predictions (id, company_id, strategy_id, spec_version, forecaster_kind, forecaster_key, asset, timeframe, bar_close_at, data_cutoff_at, horizon_bars, resolves_at, direction, probability, probability_source, reference_price, flat_band_pct)
      VALUES (${id}, ${company}, ${strategy}, ${v.spec_version}, ${v.forecaster_kind}, ${v.forecaster_key}, ${v.asset}, '4h', ${v.bar_close_at}::timestamptz, ${v.data_cutoff_at}::timestamptz, 1, ${v.resolves_at}::timestamptz, ${v.direction}, ${v.probability}, ${v.probability_source}, 100, 0.45)
    `);
    return id;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0267-trading-predictions-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Trading', 'TRD')`);
    await db.execute(sql`
      INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, cash_nok, peak_equity_nok)
      VALUES (${strategyId}, ${companyId}, 'S', 'BTC', '{}'::jsonb, '{}'::jsonb, 3000, 3000, 3000)
    `);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("upgrades a database that already holds ledger rows without touching them, a second run changes nothing, and the rollback restores the old event list", async () => {
    for (const statement of rollbackStatements()) await db.execute(sql.raw(statement));
    await db.execute(sql`INSERT INTO trading_ledger_entries (company_id, strategy_id, event_type) VALUES (${companyId}, ${strategyId}, 'signal')`);
    const before = await rows(sql`SELECT count(*)::int AS l FROM trading_ledger_entries`);
    await fails(sql`INSERT INTO trading_ledger_entries (company_id, strategy_id, event_type) VALUES (${companyId}, ${strategyId}, 'evaluator_gap')`, /event_type_check/);

    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await rows(sql`SELECT count(*)::int AS l FROM trading_ledger_entries`)).toEqual(before);
    await db.execute(sql`INSERT INTO trading_ledger_entries (company_id, strategy_id, event_type, detail) VALUES (${companyId}, ${strategyId}, 'evaluator_gap', '{"seconds":60}'::jsonb)`);

    const objects = async () =>
      rows(sql`SELECT (SELECT count(*) FROM pg_constraint WHERE conrelid IN ('trading_predictions'::regclass, 'trading_prediction_verdicts'::regclass, 'trading_evaluator_state'::regclass))::int AS c, (SELECT count(*) FROM pg_indexes WHERE tablename LIKE 'trading_pred%')::int AS i, (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trading_pred%' AND NOT tgisinternal)::int AS t, (SELECT count(*) FROM pg_policies WHERE tablename LIKE 'trading_pred%')::int AS p`);
    const firstRun = await objects();
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await objects()).toEqual(firstRun);

    // Rollback: new objects go (including the gap rows, by design), every older row stays.
    expect(rollbackStatements().length).toBeGreaterThanOrEqual(7);
    for (const statement of rollbackStatements()) await db.execute(sql.raw(statement));
    expect(await rows(sql`SELECT to_regclass('trading_predictions') AS t, to_regclass('trading_prediction_verdicts') AS v, to_regclass('trading_evaluator_state') AS e`)).toEqual([{ t: null, v: null, e: null }]);
    expect(await rows(sql`SELECT count(*)::int AS l FROM trading_ledger_entries`)).toEqual(before);
    expect((await rows(sql`SELECT count(*)::int AS s FROM trading_strategies`))[0]).toEqual({ s: 1 });
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement)); // and it applies again
    expect(await rows(sql`SELECT to_regclass('trading_predictions') AS t`)).not.toEqual([{ t: null }]);
  });

  it("polices both company tables by company; the instance-wide heartbeat table has no policy", async () => {
    const info = await rows(sql`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('trading_predictions', 'trading_prediction_verdicts', 'trading_evaluator_state') ORDER BY relname`);
    expect(info).toEqual([
      { relname: "trading_evaluator_state", relrowsecurity: false },
      { relname: "trading_prediction_verdicts", relrowsecurity: true },
      { relname: "trading_predictions", relrowsecurity: true },
    ]);
  });

  describe("one prediction per bar", () => {
    it("rejects a duplicate for the same forecaster, strategy, version, coin and bar, but allows another forecaster, version, coin or bar", async () => {
      const barClose = new Date(Date.now() - 2 * HOUR).toISOString();
      const at = { bar_close_at: barClose, data_cutoff_at: barClose, resolves_at: new Date(Date.now() + 2 * HOUR).toISOString() };
      await insertPrediction({ ...at, forecaster_key: "dup" });
      let error: unknown = null;
      try {
        await insertPrediction({ ...at, forecaster_key: "dup" });
      } catch (err) {
        error = err;
      }
      expect(String((error as { cause?: { message?: string } } | null)?.cause?.message ?? error)).toMatch(/trading_predictions_one_per_bar_uq/);
      await insertPrediction({ ...at, forecaster_key: "dup-other" });
      await insertPrediction({ ...at, forecaster_key: "dup", spec_version: 2 });
      await insertPrediction({ ...at, forecaster_key: "dup", asset: "ETH" });
    });
  });

  describe("no look-ahead", () => {
    it("rejects a data cutoff at or after the decision, and a cutoff after the bar's close", async () => {
      const future = new Date(Date.now() + 10 * MIN).toISOString();
      const bar = new Date(Date.now() - 3 * HOUR);
      let error: unknown = null;
      try {
        await insertPrediction({ forecaster_key: "late-cutoff", bar_close_at: new Date(Date.now() + 20 * MIN).toISOString(), data_cutoff_at: future, resolves_at: new Date(Date.now() + 5 * HOUR).toISOString() });
      } catch (err) {
        error = err;
      }
      expect(String((error as { cause?: { message?: string } } | null)?.cause?.message ?? error)).toMatch(/cannot use data from after it was made|cutoff_check/);
      error = null;
      try {
        await insertPrediction({ forecaster_key: "cutoff-after-bar", bar_close_at: bar.toISOString(), data_cutoff_at: new Date(bar.getTime() + MIN).toISOString(), resolves_at: new Date(bar.getTime() + 4 * HOUR).toISOString() });
      } catch (err) {
        error = err;
      }
      expect(String((error as { cause?: { message?: string } } | null)?.cause?.message ?? error)).toMatch(/cutoff_check/);
    });

    it("rejects a decision time that is not the server's clock, and a prediction whose outcome is already known", async () => {
      const bar = new Date(Date.now() - 6 * HOUR);
      const common = { bar_close_at: bar.toISOString(), data_cutoff_at: bar.toISOString() };
      let error: unknown = null;
      try {
        await insertPrediction({ ...common, forecaster_key: "known", resolves_at: new Date(Date.now() - HOUR).toISOString() });
      } catch (err) {
        error = err;
      }
      expect(String((error as { cause?: { message?: string } } | null)?.cause?.message ?? error)).toMatch(/before_outcome_check/);
      error = null;
      try {
        await db.execute(sql`
          INSERT INTO trading_predictions (company_id, strategy_id, spec_version, forecaster_kind, forecaster_key, asset, timeframe, bar_close_at, decided_at, data_cutoff_at, horizon_bars, resolves_at, direction, reference_price, flat_band_pct)
          VALUES (${companyId}, ${strategyId}, 1, 'rule', 'backdated', 'BTC', '4h', ${bar.toISOString()}::timestamptz, ${new Date(Date.now() - 5 * HOUR).toISOString()}::timestamptz, ${bar.toISOString()}::timestamptz, 1, ${new Date(Date.now() + HOUR).toISOString()}::timestamptz, 'up', 100, 0.45)
        `);
      } catch (err) {
        error = err;
      }
      expect(String((error as { cause?: { message?: string } } | null)?.cause?.message ?? error)).toMatch(/server's clock/);
    });

    it("rejects a prediction written with an outcome", async () => {
      await fails(
        sql`INSERT INTO trading_predictions (company_id, strategy_id, spec_version, forecaster_kind, forecaster_key, asset, timeframe, bar_close_at, data_cutoff_at, horizon_bars, resolves_at, direction, reference_price, flat_band_pct, resolved_at, outcome, resolver_version)
            VALUES (${companyId}, ${strategyId}, 1, 'rule', 'with-outcome', 'BTC', '4h', now() - interval '1 hour', now() - interval '1 hour', 1, now() + interval '3 hours', 'up', 100, 0.45, now(), 'hit', 1)`,
        /written without an outcome/,
      );
    });
  });

  describe("probability only for forecasters with real probabilities", () => {
    it("needs a stated source, stays within 0..1, and a fixed rule without one carries none", async () => {
      await insertPrediction({ forecaster_key: "model-a", forecaster_kind: "model", probability: 0.62, probability_source: "model" });
      await insertPrediction({ forecaster_key: "rule-fitted", probability: 0.55, probability_source: "fitted_out_of_sample" });
      await fails(sql`UPDATE trading_predictions SET probability = 0.5 WHERE forecaster_key = 'model-a'`, /forecast columns/);
      let error: unknown = null;
      try {
        await insertPrediction({ forecaster_key: "p-no-source", probability: 0.6, probability_source: null });
      } catch (err) {
        error = err;
      }
      expect(String((error as { cause?: { message?: string } } | null)?.cause?.message ?? error)).toMatch(/probability_check/);
      error = null;
      try {
        await insertPrediction({ forecaster_key: "p-out-of-range", forecaster_kind: "model", probability: 1.5, probability_source: "model" });
      } catch (err) {
        error = err;
      }
      expect(String((error as { cause?: { message?: string } } | null)?.cause?.message ?? error)).toMatch(/probability_check/);
    });
  });

  describe("append-only", () => {
    it("forbids any update of a forecast column", async () => {
      const id = await insertPrediction({ forecaster_key: "append-only" });
      for (const change of [
        sql`direction = 'down'`,
        sql`reference_price = 101`,
        sql`probability = 0.9, probability_source = 'model'`,
        sql`bar_close_at = bar_close_at - interval '1 hour'`,
        sql`data_cutoff_at = data_cutoff_at - interval '1 hour'`,
        sql`decided_at = decided_at + interval '1 minute'`,
        sql`resolves_at = resolves_at + interval '1 hour'`,
        sql`forecaster_key = 'other'`,
        sql`strategy_id = ${randomUUID()}`,
        sql`regime = '{"trend":"up"}'::jsonb`,
        sql`flat_band_pct = 5`,
      ]) {
        await fails(sql`UPDATE trading_predictions SET ${change} WHERE id = ${id}`, /forecast columns|foreign key|cutoff_check|probability_check/);
      }
      // A no-op update is not a resolution either.
      await fails(sql`UPDATE trading_predictions SET reference_price = reference_price WHERE id = ${id}`, /only allowed update is the single resolution/);
    });

    it("resolves once, not before the outcome time, and then the row is final", async () => {
      const id = await insertPrediction({ forecaster_key: "resolve-once" });
      await fails(
        sql`UPDATE trading_predictions SET resolved_at = now(), outcome = 'hit', realized_return = 0.01, mfe = 0.02, mae = -0.01, resolver_version = 1, independent = true WHERE id = ${id}`,
        /cannot be resolved before its outcome time/,
      );
      // A prediction whose outcome time has passed: made a moment ago, then allowed to mature.
      const past = await insertPrediction({ forecaster_key: "resolve-matured", bar_close_at: new Date(Date.now() - 1000).toISOString(), data_cutoff_at: new Date(Date.now() - 1000).toISOString(), resolves_at: new Date(Date.now() + 1500).toISOString() });
      await new Promise((resolve) => setTimeout(resolve, 1700));
      await db.execute(sql`UPDATE trading_predictions SET resolved_at = now(), outcome = 'hit', realized_return = 0.01, mfe = 0.02, mae = -0.01, resolver_version = 1, independent = true WHERE id = ${past}`);
      await fails(sql`UPDATE trading_predictions SET outcome = 'miss' WHERE id = ${past}`, /already resolved/);
      await fails(sql`UPDATE trading_predictions SET resolved_at = now(), outcome = 'miss', resolver_version = 2 WHERE id = ${past}`, /already resolved/);
      await fails(sql`UPDATE trading_predictions SET independent = false WHERE id = ${past}`, /already resolved/);
      await fails(sql`UPDATE trading_predictions SET direction = 'down' WHERE id = ${past}`, /already resolved/);
    });

    it("keeps the outcome columns consistent: all or none, a known label, and a void is never independent", async () => {
      const id = await insertPrediction({ forecaster_key: "pair", bar_close_at: new Date(Date.now() - 1000).toISOString(), data_cutoff_at: new Date(Date.now() - 1000).toISOString(), resolves_at: new Date(Date.now() + 1500).toISOString() });
      await new Promise((resolve) => setTimeout(resolve, 1700));
      await fails(sql`UPDATE trading_predictions SET resolved_at = now(), resolver_version = 1 WHERE id = ${id}`, /resolution_pair_check/);
      await fails(sql`UPDATE trading_predictions SET resolved_at = now(), outcome = 'win', resolver_version = 1 WHERE id = ${id}`, /outcome_check/);
      await fails(sql`UPDATE trading_predictions SET resolved_at = now() + interval '1 day', outcome = 'hit', resolver_version = 1 WHERE id = ${id}`, /in the future/);
      await fails(sql`UPDATE trading_predictions SET resolved_at = now(), outcome = 'void', resolver_version = 1, independent = true WHERE id = ${id}`, /void prediction/);
      await db.execute(sql`UPDATE trading_predictions SET resolved_at = now(), outcome = 'void', resolver_version = 1 WHERE id = ${id}`);
    });
  });

  describe("deletes still cascade", () => {
    it("deleting a strategy takes its predictions and verdicts with it; deleting a company takes everything", async () => {
      const company = randomUUID();
      const strategy = randomUUID();
      const other = randomUUID();
      await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${company}, 'Cascade', 'CSC')`);
      for (const id of [strategy, other]) {
        await db.execute(sql`
          INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, cash_nok, peak_equity_nok)
          VALUES (${id}, ${company}, 'C', 'ETH', '{}'::jsonb, '{}'::jsonb, 1, 1, 1)
        `);
      }
      await insertPrediction({ forecaster_key: "cascade" }, strategy, company);
      await insertPrediction({ forecaster_key: "cascade" }, other, company);
      await db.execute(sql`DELETE FROM trading_strategies WHERE id = ${strategy}`);
      expect(await rows(sql`SELECT 1 FROM trading_predictions WHERE strategy_id = ${strategy}`)).toEqual([]);
      expect(await rows(sql`SELECT 1 FROM trading_predictions WHERE strategy_id = ${other}`)).toHaveLength(1);
      await db.execute(sql`DELETE FROM companies WHERE id = ${company}`);
      expect(await rows(sql`SELECT 1 FROM trading_predictions WHERE company_id = ${company}`)).toEqual([]);
    });
  });

  describe("no verdict before the planned sample size", () => {
    it("refuses a verdict while fewer than N independent resolved predictions exist or the test period is short, and never lets one change", async () => {
      const company = randomUUID();
      const strategy = randomUUID();
      await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${company}, 'Verdict', 'VRD')`);
      await db.execute(sql`
        INSERT INTO trading_strategies (id, company_id, name, asset, rule_config, risk_config, starting_cash_nok, cash_nok, peak_equity_nok)
        VALUES (${strategy}, ${company}, 'V', 'BTC', '{}'::jsonb, '{}'::jsonb, 1, 1, 1)
      `);
      const verdict = (over: { target?: number; days?: number; counted?: number; running?: number; calendar?: number } = {}) =>
        sql`INSERT INTO trading_prediction_verdicts (company_id, strategy_id, spec_version, forecaster_key, target_samples, min_running_days, samples_counted, running_ms, calendar_ms, verdict)
            VALUES (${company}, ${strategy}, 1, 'rule', ${over.target ?? 3}, ${over.days ?? 0}, ${over.counted ?? 3}, ${over.running ?? 0}, ${over.calendar ?? 0}, '{"status":"complete"}'::jsonb)`;
      // Zero resolved predictions, then two: no verdict.
      await fails(verdict(), /no verdict before the planned sample size/);
      // Resolved predictions need a matured outcome time; build them with a short horizon.
      const resolveOne = async (key: string, independent: boolean) => {
        const bar = new Date(Date.now() - 1000);
        const id = await insertPrediction({ forecaster_key: "rule", asset: key, bar_close_at: bar.toISOString(), data_cutoff_at: bar.toISOString(), resolves_at: new Date(Date.now() + 800).toISOString() }, strategy, company);
        await new Promise((resolve) => setTimeout(resolve, 900));
        await db.execute(sql`UPDATE trading_predictions SET resolved_at = now(), outcome = 'hit', resolver_version = 1, independent = ${independent} WHERE id = ${id}`);
      };
      await resolveOne("BTC", true);
      await resolveOne("ETH", true);
      await resolveOne("SOL", false); // not independent: does not count
      await fails(verdict(), /no verdict before the planned sample size \(2 independent/);
      await resolveOne("XRP", true);
      // N reached, but the test period (1 day) is not.
      await fails(verdict({ days: 1 }), /minimum test period of 1 days/);
      await fails(verdict({ counted: 5 }), /no verdict before the planned sample size|samples_counted|reached_check/);
      await db.execute(verdict());
      await fails(verdict(), /verdict_once_uq|once_uq/);
      await fails(sql`UPDATE trading_prediction_verdicts SET verdict = '{"status":"x"}'::jsonb WHERE strategy_id = ${strategy}`, /computed once/);
      await db.execute(sql`DELETE FROM trading_strategies WHERE id = ${strategy}`);
      expect(await rows(sql`SELECT 1 FROM trading_prediction_verdicts WHERE strategy_id = ${strategy}`)).toEqual([]);
    });
  });
});
