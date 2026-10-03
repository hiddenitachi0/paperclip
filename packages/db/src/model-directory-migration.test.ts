import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * DUR-4379: migration 0216_model_directory_entries creates the company-scoped
 * table, grants and polices it like every other tenant table (a connection
 * scoped to company A never sees or writes company B's rows), refuses a bad
 * thinking default and a duplicate name within one company, and is safe to run
 * twice.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const MIGRATION_TAG = "0216_model_directory_entries";
const MIGRATION_PATH = fileURLToPath(new URL(`./migrations/${MIGRATION_TAG}.sql`, import.meta.url));

type Row = Record<string, unknown>;

d(`migration ${MIGRATION_TAG}`, () => {
  let db!: ReturnType<typeof createDb>;
  let connectionString!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyA = randomUUID();
  const companyB = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0216-model-directory-");
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyA}, 'A', 'MDA'), (${companyB}, 'B', 'MDB')`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertEntry(companyId: string, name: string, thinking: string | null = null): Promise<boolean> {
    try {
      await db.execute(sql`
        INSERT INTO model_directory_entries (company_id, name, provider, model, default_thinking)
        VALUES (${companyId}, ${name}, 'local', 'llama3.1', ${thinking})
      `);
      return true;
    } catch {
      return false;
    }
  }

  it("creates the table with the intended columns and defaults", async () => {
    const rows = (await db.execute(sql`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'model_directory_entries'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    `)) as unknown as Row[];
    const cols = new Map(rows.map((r) => [r.name as string, r]));
    expect(cols.get("company_id")).toMatchObject({ type: "uuid", nullable: false });
    expect(cols.get("base_url")).toMatchObject({ type: "text", nullable: true });
    expect(cols.get("provider_routing")).toMatchObject({ type: "jsonb", nullable: true });
    expect(cols.get("backup_entry_ids")).toMatchObject({ type: "jsonb", nullable: false, def: "'[]'::jsonb" });
    expect(cols.has("api_key")).toBe(false);
  });

  it("refuses a bad thinking default and a duplicate name within one company only", async () => {
    expect(await insertEntry(companyA, "Local llama", "on")).toBe(true);
    expect(await insertEntry(companyA, "Local llama")).toBe(false);
    expect(await insertEntry(companyB, "Local llama")).toBe(true);
    expect(await insertEntry(companyA, "Bad", "maybe")).toBe(false);
  });

  it("cascades with the company", async () => {
    const other = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${other}, 'C', 'MDC')`);
    expect(await insertEntry(other, "x")).toBe(true);
    await db.execute(sql`DELETE FROM companies WHERE id = ${other}`);
    const rows = (await db.execute(sql`SELECT 1 FROM model_directory_entries WHERE company_id = ${other}`)) as unknown as Row[];
    expect(rows).toHaveLength(0);
  });

  it("is granted and policed: company A's scoped connection never sees or writes company B's rows", async () => {
    const meta = (await db.execute(sql`
      SELECT c.relrowsecurity AS rls,
             has_table_privilege('paperclip_app_scoped', 'model_directory_entries', 'INSERT') AS scoped,
             has_table_privilege('paperclip_app_bypass_login', 'model_directory_entries', 'UPDATE') AS bypass
      FROM pg_class c WHERE c.relname = 'model_directory_entries'
    `)) as unknown as Row[];
    expect(meta[0]).toMatchObject({ rls: true, scoped: true, bypass: true });

    const scoped = postgres(connectionString, { max: 1 });
    try {
      await scoped`SET ROLE paperclip_app_scoped`;
      await scoped`select set_config('app.current_company_id', ${companyA}, false)`;
      const rows = await scoped`SELECT company_id FROM model_directory_entries`;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.company_id === companyA)).toBe(true);
      expect(await scoped`SELECT id FROM model_directory_entries WHERE company_id = ${companyB}`).toHaveLength(0);
      await expect(
        scoped`INSERT INTO model_directory_entries (company_id, name, provider, model) VALUES (${companyB}, 'smuggled', 'local', 'm')`,
      ).rejects.toThrow();
      expect(await scoped`UPDATE model_directory_entries SET note = 'x' WHERE company_id = ${companyB} RETURNING id`).toHaveLength(0);
      expect(await scoped`DELETE FROM model_directory_entries WHERE company_id = ${companyB} RETURNING id`).toHaveLength(0);
    } finally {
      await scoped.end();
    }
    const noClaim = postgres(connectionString, { max: 1 });
    try {
      await noClaim`SET ROLE paperclip_app_scoped`;
      expect(await noClaim`SELECT id FROM model_directory_entries`).toHaveLength(0);
    } finally {
      await noClaim.end();
    }
  });

  it("is idempotent: running the file a second time changes nothing", async () => {
    const statements = readFileSync(MIGRATION_PATH, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const statement of statements) await db.execute(sql.raw(statement));
    const policies = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'model_directory_entries' AND policyname = 'paperclip_company_scope'
    `)) as unknown as Row[];
    expect(policies[0]?.n).toBe(1);
    const n = (await db.execute(sql`SELECT count(*)::int AS n FROM model_directory_entries`)) as unknown as Row[];
    expect(n[0]?.n).toBe(2);
  });

  it("is registered last in the journal", () => {
    const journal = JSON.parse(readFileSync(fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const last = journal.entries[journal.entries.length - 1]!;
    expect(last.tag).toBe(MIGRATION_TAG);
    expect(last.when).toBeGreaterThan(journal.entries[journal.entries.length - 2]!.when);
  });
});
