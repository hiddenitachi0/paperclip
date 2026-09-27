import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0178_telegram_bot_company_notices applies on the embedded-Postgres
 * path (every migration, in journal order), adds receives_company_notices
 * (boolean, NOT NULL, false) and a partial unique index that allows at most
 * one marked bot per company, writes no row, and is safe to run twice. An
 * existing bot keeps false through a re-run: nothing is picked for the
 * operator, the bridge's own fallback rule decides until he picks one.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0178 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0178_telegram_bot_company_notices";
const MIGRATION_PATH = fileURLToPath(new URL(`./migrations/${MIGRATION_TAG}.sql`, import.meta.url));
const INDEX_NAME = "telegram_bots_company_notices_uq";

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
  let companyA = "";
  let companyB = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0178-telegram-notices-");
    db = createDb(tempDb.connectionString);
    companyA = randomUUID();
    companyB = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyA}, 'Notices A', 'TNA')`);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyB}, 'Notices B', 'TNB')`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function rerunMigration() {
    for (const statement of migrationStatements()) {
      await db.execute(sql.raw(statement));
    }
  }

  /** A bot row with its agent and saved token. Returns the bot id. */
  async function insertBot(companyId: string, receivesCompanyNotices?: boolean): Promise<string> {
    const agentId = randomUUID();
    const secretId = randomUUID();
    const botId = randomUUID();
    await db.execute(sql`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${companyId}, ${`Agent ${agentId.slice(0, 6)}`})`);
    await db.execute(sql`INSERT INTO company_secrets (id, company_id, key, name) VALUES (${secretId}, ${companyId}, ${`bot-${secretId}`}, ${`Bot ${secretId}`})`);
    if (receivesCompanyNotices === undefined) {
      await db.execute(sql`INSERT INTO telegram_bots (id, company_id, agent_id, name, token_secret_id) VALUES (${botId}, ${companyId}, ${agentId}, 'Bot', ${secretId})`);
    } else {
      await db.execute(sql`INSERT INTO telegram_bots (id, company_id, agent_id, name, token_secret_id, receives_company_notices) VALUES (${botId}, ${companyId}, ${agentId}, 'Bot', ${secretId}, ${receivesCompanyNotices})`);
    }
    return botId;
  }

  async function mark(botId: string, value: boolean): Promise<boolean> {
    try {
      await db.execute(sql`UPDATE telegram_bots SET receives_company_notices = ${value} WHERE id = ${botId}`);
      return true;
    } catch {
      return false;
    }
  }

  async function column(): Promise<Row | undefined> {
    const rows = (await db.execute(sql`
      SELECT format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'telegram_bots'::regclass AND a.attname = 'receives_company_notices' AND NOT a.attisdropped
    `)) as unknown as Row[];
    return rows[0];
  }

  async function indexDefs(): Promise<string[]> {
    const rows = (await db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'telegram_bots' AND indexname = ${INDEX_NAME}`,
    )) as unknown as Row[];
    return rows.map((row) => row.indexdef as string);
  }

  it("adds receives_company_notices (boolean, not null, false)", async () => {
    expect(await column()).toEqual({ type: "boolean", nullable: false, def: "false" });
  });

  it("a new bot starts off unmarked", async () => {
    const botId = await insertBot(companyA);
    const [row] = (await db.execute(
      sql`SELECT receives_company_notices FROM telegram_bots WHERE id = ${botId}`,
    )) as unknown as Row[];
    expect(row?.receives_company_notices).toBe(false);
  });

  it("allows one marked bot per company, and one in each of two companies", async () => {
    const first = await insertBot(companyA);
    const second = await insertBot(companyA);
    const other = await insertBot(companyB);

    expect(await mark(first, true)).toBe(true);
    expect(await mark(second, true)).toBe(false);
    expect(await mark(other, true)).toBe(true);

    // Moving the mark: clear the first, then the second may take it.
    expect(await mark(first, false)).toBe(true);
    expect(await mark(second, true)).toBe(true);
  });

  it("is a partial unique index on company_id, only over marked bots", async () => {
    const defs = await indexDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toContain("CREATE UNIQUE INDEX telegram_bots_company_notices_uq");
    expect(defs[0]).toContain("(company_id)");
    expect(defs[0]).toContain("WHERE receives_company_notices");
  });

  it("an existing bot keeps its value through a re-run: no row is changed", async () => {
    const marked = await insertBot(companyB, false);
    const before = (await db.execute(
      sql`SELECT id, receives_company_notices FROM telegram_bots ORDER BY id`,
    )) as unknown as Row[];
    await rerunMigration();
    const after = (await db.execute(
      sql`SELECT id, receives_company_notices FROM telegram_bots ORDER BY id`,
    )) as unknown as Row[];
    expect(after).toEqual(before);
    expect(after.find((row) => row.id === marked)?.receives_company_notices).toBe(false);
  });

  it("is idempotent: a further run changes nothing and keeps exactly one index", async () => {
    const before = await column();
    await rerunMigration();
    await rerunMigration();
    expect(await column()).toEqual(before);
    expect(await indexDefs()).toHaveLength(1);
  });

  it("keeps row-level security and the company-scope policy on telegram_bots", async () => {
    const rows = (await db.execute(sql`
      SELECT c.relrowsecurity AS rls, p.policyname AS policy
      FROM pg_class c
      LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'paperclip_company_scope'
      WHERE c.relname = 'telegram_bots'
    `)) as unknown as Row[];
    expect(rows[0]?.rls).toBe(true);
    expect(rows[0]?.policy).toBe("paperclip_company_scope");
  });

  it("is registered in the journal as idx 178 with a `when` greater than every earlier entry (Drizzle applies only strictly greater `when`)", () => {
    const journal = JSON.parse(readFileSync(fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const position = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
    expect(position).toBeGreaterThan(0);
    const mine = journal.entries[position]!;
    expect(mine).toMatchObject({ idx: 178, when: 1787160470000 });
    // 0177 (a separate change) uses 1787160460000; this must come after it
    // whichever of the two is merged first.
    expect(mine.when).toBeGreaterThan(1787160460000);
    for (const entry of journal.entries.slice(0, position)) {
      expect(mine.when, `${MIGRATION_TAG} must come strictly after ${entry.tag}`).toBeGreaterThan(entry.when);
    }
    expect(journal.entries.filter((entry) => entry.when === mine.when)).toHaveLength(1);
  });

  it("the file only adds: one guarded column and one guarded index, no DROP, no UPDATE, no DELETE", () => {
    const text = readFileSync(MIGRATION_PATH, "utf8")
      .split("\n")
      .map((line) => line.replace(/^\s*--.*$/, ""))
      .join("\n");
    expect(text).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bREVOKE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"?\w+"?\s+SET\b|\bALTER\s+COLUMN\b/i);
    expect(text).not.toMatch(/information_schema\.(tables|columns)/);
    expect(text.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(1);
    expect(text).toContain('ADD COLUMN IF NOT EXISTS "receives_company_notices" boolean DEFAULT false NOT NULL');
    expect(text.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g)).toHaveLength(1);
    expect(text).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "telegram_bots" ("company_id") WHERE "receives_company_notices"`);
  });

  it("0164 does not list the new column (it is a column, not a table)", () => {
    const text = readFileSync(fileURLToPath(new URL("./migrations/0164_rls_login_roles.sql", import.meta.url)), "utf8");
    expect(text).not.toContain("receives_company_notices");
  });
});
