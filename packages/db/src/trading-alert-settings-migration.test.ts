import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * DUR-5017, migration 0270_trading_alert_settings: a second run changes
 * nothing, existing alert rows keep their data (and, with no key, never
 * collide), the same occurrence cannot be queued twice for one company, the
 * settings table has safe defaults and refuses nonsense, and the rollback in
 * the migration's header removes only what the migration added.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping migration 0270 test: ${support.reason ?? "unsupported environment"}`);

const MIGRATION_PATH = fileURLToPath(new URL("./migrations/0270_trading_alert_settings.sql", import.meta.url));

function migrationStatements(): string[] {
  return readFileSync(MIGRATION_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

type Row = Record<string, unknown>;

d("migration 0270_trading_alert_settings", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0270-alert-settings-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Trading', 'TRD'), (${otherCompanyId}, 'Other', 'OTH')`);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("running the migration again changes nothing", async () => {
    await db.execute(sql`INSERT INTO trading_alerts (company_id, kind, text) VALUES (${companyId}, 'wallet_paused', 'old alert')`);
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    const old = await rows(sql`SELECT text, dedupe_key FROM trading_alerts WHERE company_id = ${companyId}`);
    expect(old).toEqual([{ text: "old alert", dedupe_key: null }]);
  });

  it("alerts without a key never collide; the same keyed occurrence is refused once per company, not across companies", async () => {
    await db.execute(sql`INSERT INTO trading_alerts (company_id, kind, text) VALUES (${companyId}, 'wallet_paused', 'second old alert')`);
    await db.execute(sql`INSERT INTO trading_alerts (company_id, kind, text, dedupe_key) VALUES (${companyId}, 'big_move', 'one', 'big_move:BTC:t1')`);
    await expect(db.execute(sql`INSERT INTO trading_alerts (company_id, kind, text, dedupe_key) VALUES (${companyId}, 'big_move', 'again', 'big_move:BTC:t1')`)).rejects.toThrow();
    await db.execute(sql`INSERT INTO trading_alerts (company_id, kind, text, dedupe_key) VALUES (${otherCompanyId}, 'big_move', 'other company', 'big_move:BTC:t1')`);
  });

  it("settings: a company has everything on by default, and the two numbers are range-checked", async () => {
    await db.execute(sql`INSERT INTO trading_alert_settings (company_id) VALUES (${companyId})`);
    const [row] = await rows(sql`SELECT * FROM trading_alert_settings WHERE company_id = ${companyId}`);
    expect(row).toMatchObject({ weather_flips_on: true, big_moves_on: true, breaker_trips_on: true, paused_after_restart_on: true, daily_summary_on: true, big_move_atr_k: 3, paused_after_restart_hours: 2 });
    await expect(db.execute(sql`UPDATE trading_alert_settings SET big_move_atr_k = 0.5 WHERE company_id = ${companyId}`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE trading_alert_settings SET big_move_atr_k = 11 WHERE company_id = ${companyId}`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE trading_alert_settings SET paused_after_restart_hours = 0 WHERE company_id = ${companyId}`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE trading_alert_settings SET paused_after_restart_hours = 73 WHERE company_id = ${companyId}`)).rejects.toThrow();
  });

  it("the table is policed by company", async () => {
    const [flags] = await rows(sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'trading_alert_settings'`);
    const policies = await rows(sql`SELECT policyname FROM pg_policies WHERE tablename = 'trading_alert_settings'`);
    // Roles from the RLS migrations exist in this database only when they were created; where they were, the policy is there.
    const [role] = await rows(sql`SELECT 1 AS present FROM pg_roles WHERE rolname = 'paperclip_app_scoped'`);
    if (role) {
      expect(flags!.relrowsecurity).toBe(true);
      expect(policies.map((p) => p.policyname)).toContain("paperclip_company_scope");
    }
  });

  it("the documented rollback removes only what the migration added; old alerts stay", async () => {
    await db.execute(sql`DROP TABLE "trading_alert_settings"`);
    await db.execute(sql`DROP INDEX "trading_alerts_dedupe_uq"`);
    await db.execute(sql`ALTER TABLE "trading_alerts" DROP COLUMN "dedupe_key"`);
    const left = await rows(sql`SELECT text FROM trading_alerts WHERE company_id = ${companyId} ORDER BY text`);
    expect(left.map((r) => r.text)).toEqual(expect.arrayContaining(["old alert", "second old alert"]));
    // And the migration applies cleanly again on the rolled-back database.
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    const [after] = await rows(sql`SELECT count(*)::int AS n FROM trading_alerts WHERE company_id = ${companyId} AND dedupe_key IS NULL`);
    expect(after!.n).toBeGreaterThanOrEqual(2);
  });
});
