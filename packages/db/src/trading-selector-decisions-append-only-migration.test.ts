import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/** DUR-5171, migration 0274: selector decisions are append-only; a company's removal still cascades. */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping migration 0274 test: ${support.reason ?? "unsupported environment"}`);

const MIGRATION_PATH = fileURLToPath(new URL("./migrations/0274_trading_selector_decisions_append_only.sql", import.meta.url));
const DIGEST = "a".repeat(64);

const migrationStatements = () =>
  readFileSync(MIGRATION_PATH, "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter((s) => s.length > 0);
/** The rollback from the migration header, so the two cannot drift. */
const rollbackStatements = () =>
  readFileSync(MIGRATION_PATH, "utf8").split("\n").filter((l) => /^--\s{3}(DROP)/.test(l)).map((l) => l.replace(/^--\s+/, "").trim());

d("migration 0274_trading_selector_decisions_append_only", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  type Row = Record<string, unknown>;
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as Row[];
  const insertDecision = async (company: string, checkpoint: string) => {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO trading_selector_decisions (id, company_id, checkpoint_at, rules_version, rules_digest, decided_at, state_before, output, input_digest, output_digest, choice, trials, tested, discoveries, reason) VALUES (${id}, ${company}, ${checkpoint}::timestamptz, 1, ${DIGEST}, now(), '{}'::jsonb, '{}'::jsonb, ${DIGEST}, ${DIGEST}, 'cash', 1, 0, 0, 'x')`);
    return id;
  };
  const triggerCount = async () =>
    (await rows(sql`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trading_selector_decisions_no_delete' AND NOT tgisinternal`))[0]!.n as number;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0274-decisions-append-only-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Trading', 'TRD')`);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${otherCompanyId}, 'Other', 'OTH')`);
    await db.execute(sql`INSERT INTO trading_selector_rules (version, rules, digest, note) VALUES (1, '{}'::jsonb, ${DIGEST}, 'first')`);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("refuses to delete a decision, singly or in bulk, and the row stays", async () => {
    const id = await insertDecision(companyId, "2026-02-01T00:00:00Z");
    await expect(db.execute(sql`DELETE FROM trading_selector_decisions WHERE id = ${id}`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM trading_selector_decisions`)).rejects.toThrow();
    expect(await rows(sql`SELECT id FROM trading_selector_decisions WHERE id = ${id}`)).toHaveLength(1);
  });

  it("does not let a decision be deleted to cascade away the confirmation window that names it", async () => {
    const decisionId = await insertDecision(companyId, "2026-03-01T00:00:00Z");
    const cellId = randomUUID();
    await db.execute(sql`INSERT INTO trading_shadow_cells (id, company_id, template_key, template_version, family, weather, asset) VALUES (${cellId}, ${companyId}, 'trend_pullback', 1, 'trend', 'up', 'BTC')`);
    await db.execute(sql`INSERT INTO trading_selector_confirmations (company_id, cell_id, opened_checkpoint_at, opened_decision_id) VALUES (${companyId}, ${cellId}, '2026-03-01T00:00:00Z', ${decisionId})`);
    await expect(db.execute(sql`DELETE FROM trading_selector_decisions WHERE id = ${decisionId}`)).rejects.toThrow();
    expect(await rows(sql`SELECT count(*)::int AS n FROM trading_selector_confirmations WHERE opened_decision_id = ${decisionId}`)).toEqual([{ n: 1 }]);
  });

  it("still lets removing a whole company take its decisions with it, and only its own", async () => {
    await insertDecision(otherCompanyId, "2026-02-01T00:00:00Z");
    const mine = (await rows(sql`SELECT count(*)::int AS n FROM trading_selector_decisions WHERE company_id = ${companyId}`))[0]!.n as number;
    await db.execute(sql`DELETE FROM companies WHERE id = ${otherCompanyId}`);
    expect(await rows(sql`SELECT count(*)::int AS n FROM trading_selector_decisions WHERE company_id = ${otherCompanyId}`)).toEqual([{ n: 0 }]);
    expect(await rows(sql`SELECT count(*)::int AS n FROM trading_selector_decisions WHERE company_id = ${companyId}`)).toEqual([{ n: mine }]);
  });

  it("a second run changes nothing, and the documented rollback removes only the guard, keeps every row, and applies again", async () => {
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await triggerCount()).toBe(1);
    const before = (await rows(sql`SELECT count(*)::int AS n FROM trading_selector_decisions`))[0]!.n as number;
    const statements = rollbackStatements();
    expect(statements).toHaveLength(2);
    for (const statement of statements) await db.execute(sql.raw(statement));
    expect(await triggerCount()).toBe(0);
    expect(await rows(sql`SELECT proname FROM pg_proc WHERE proname = 'trading_selector_decisions_no_delete'`)).toEqual([]);
    expect(await rows(sql`SELECT count(*)::int AS n FROM trading_selector_decisions`)).toEqual([{ n: before }]);
    // The update guard of 0273 is not part of this migration and stays.
    expect(await rows(sql`SELECT tgname FROM pg_trigger WHERE tgname = 'trading_selector_decisions_guard'`)).toHaveLength(1);
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await triggerCount()).toBe(1);
  });
});
