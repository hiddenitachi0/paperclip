import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { agents } from "./schema/agents.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0189_lane_a_provider_routing applies on the embedded-Postgres
 * path (every migration, in journal order), adds lane_a_provider_routing
 * (jsonb, nullable, no default), writes no row, and is safe to run twice. An
 * existing quick agent stays null: OpenRouter keeps picking the host until
 * the operator chooses some.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0189 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0189_lane_a_provider_routing";
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
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0189-lane-a-provider-routing-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Model hosts', 'MHS')`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function rerunMigration() {
    for (const statement of migrationStatements()) {
      await db.execute(sql.raw(statement));
    }
  }

  async function insertAgent(): Promise<string> {
    const agentId = randomUUID();
    await db.execute(
      sql`INSERT INTO agents (id, company_id, name, lane_a_enabled) VALUES (${agentId}, ${companyId}, ${`Agent ${agentId.slice(0, 6)}`}, true)`,
    );
    return agentId;
  }

  async function column(): Promise<Row | undefined> {
    const rows = (await db.execute(sql`
      SELECT format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'agents'::regclass AND a.attname = 'lane_a_provider_routing' AND NOT a.attisdropped
    `)) as unknown as Row[];
    return rows[0];
  }

  it("adds lane_a_provider_routing (jsonb, nullable, no default)", async () => {
    expect(await column()).toEqual({ type: "jsonb", nullable: true, def: null });
  });

  it("a new agent starts with no host choice", async () => {
    const agentId = await insertAgent();
    const [row] = await db.select({ r: agents.laneAProviderRouting }).from(agents).where(eq(agents.id, agentId));
    expect(row?.r).toBeNull();
  });

  it("round-trips a host choice through the Drizzle column, and clears back to null", async () => {
    const agentId = await insertAgent();
    const routing = { only: ["deepinfra"], order: ["deepinfra"], ignore: ["venice"], allowFallbacks: false };
    await db.update(agents).set({ laneAProviderRouting: routing }).where(eq(agents.id, agentId));
    const [row] = await db.select({ r: agents.laneAProviderRouting }).from(agents).where(eq(agents.id, agentId));
    expect(row?.r).toEqual(routing);
    await db.update(agents).set({ laneAProviderRouting: null }).where(eq(agents.id, agentId));
    const [cleared] = await db.select({ r: agents.laneAProviderRouting }).from(agents).where(eq(agents.id, agentId));
    expect(cleared?.r).toBeNull();
  });

  it("an existing agent keeps its value through a re-run: no row is changed", async () => {
    const set = await insertAgent();
    await db.update(agents).set({ laneAProviderRouting: { only: ["deepinfra"] } }).where(eq(agents.id, set));
    const before = (await db.execute(sql`SELECT id, lane_a_provider_routing FROM agents ORDER BY id`)) as unknown as Row[];
    await rerunMigration();
    const after = (await db.execute(sql`SELECT id, lane_a_provider_routing FROM agents ORDER BY id`)) as unknown as Row[];
    expect(after).toEqual(before);
  });

  it("is idempotent: further runs change nothing", async () => {
    const before = await column();
    await rerunMigration();
    await rerunMigration();
    expect(await column()).toEqual(before);
  });

  it("is registered in the journal as idx 189 with a `when` greater than every earlier entry (Drizzle applies only strictly greater `when`)", () => {
    const journal = JSON.parse(readFileSync(fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const position = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
    expect(position).toBeGreaterThan(0);
    const mine = journal.entries[position]!;
    expect(mine).toMatchObject({ idx: 189 });
    expect(journal.entries[position - 1]!.tag).toBe("0188_purchase_settings");
    for (const entry of journal.entries.slice(0, position)) {
      expect(mine.when, `${MIGRATION_TAG} must come strictly after ${entry.tag}`).toBeGreaterThan(entry.when);
    }
    expect(journal.entries.filter((entry) => entry.when === mine.when)).toHaveLength(1);
  });

  it("the file only adds: one guarded nullable column, no DROP, no UPDATE, no DELETE", () => {
    const text = readFileSync(MIGRATION_PATH, "utf8")
      .split("\n")
      .map((line) => line.replace(/^\s*--.*$/, ""))
      .join("\n");
    expect(text).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bREVOKE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"?\w+"?\s+SET\b|\bALTER\s+COLUMN\b|\bDEFAULT\b|\bNOT NULL\b/i);
    expect(text.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(1);
    expect(text).toContain('ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "lane_a_provider_routing" jsonb;');
  });
});
