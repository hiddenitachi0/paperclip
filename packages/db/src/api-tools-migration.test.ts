import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * DUR-4004: migration 0177_company_api_tools applies on the embedded-Postgres
 * path (every migration, in journal order), creates the two tables and the
 * agents column with the intended shape, grants and polices both tables like
 * every other tenant table, writes no row, and is safe to run twice.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-4004 migration test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0177_company_api_tools";
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
  const companyId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0177-api-tools-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'API tools', 'APT')`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function columns(table: string): Promise<Map<string, { type: string; nullable: boolean; def: string | null }>> {
    const rows = (await db.execute(sql`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = ${table}::regclass AND a.attnum > 0 AND NOT a.attisdropped
    `)) as unknown as Row[];
    return new Map(rows.map((row) => [row.name as string, { type: row.type as string, nullable: row.nullable as boolean, def: (row.def as string | null) ?? null }]));
  }

  async function constraintDef(name: string): Promise<string | null> {
    const rows = (await db.execute(sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}`)) as unknown as Row[];
    return (rows[0]?.def as string | undefined) ?? null;
  }

  async function snapshot() {
    const names = [
      "company_api_tools_company_id_companies_id_fk",
      "company_api_tools_status_check",
      "company_api_tools_daily_cap_check",
      "company_api_tool_calls_company_id_companies_id_fk",
      "company_api_tool_calls_tool_id_company_api_tools_id_fk",
      "company_api_tool_calls_channel_check",
      "company_api_tool_calls_status_check",
    ];
    const out: Record<string, string | null> = {};
    for (const name of names) out[name] = await constraintDef(name);
    const indexes = (await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename IN ('company_api_tools', 'company_api_tool_calls') ORDER BY indexname
    `)) as unknown as Row[];
    return { constraints: out, indexes: indexes.map((row) => row.indexname) };
  }

  it("creates company_api_tools with the intended columns and defaults", async () => {
    const cols = await columns("company_api_tools");
    expect(cols.get("company_id")).toMatchObject({ type: "uuid", nullable: false });
    expect(cols.get("key")).toMatchObject({ type: "text", nullable: false });
    expect(cols.get("base_url")).toMatchObject({ type: "text", nullable: false });
    expect(cols.get("auth")).toMatchObject({ type: "jsonb", nullable: false, def: "'{}'::jsonb" });
    expect(cols.get("actions")).toMatchObject({ type: "jsonb", nullable: false, def: "'[]'::jsonb" });
    expect(cols.get("openapi_url")).toMatchObject({ type: "text", nullable: true });
    expect(cols.get("daily_cap")).toMatchObject({ type: "integer", nullable: false, def: "300" });
    expect(cols.get("status")).toMatchObject({ type: "text", nullable: false, def: "'active'::text" });
    expect(cols.get("last_test_ok")).toMatchObject({ type: "boolean", nullable: true });
    expect(cols.get("created_by_user_id")).toMatchObject({ type: "text", nullable: true });
    const s = await snapshot();
    expect(s.constraints.company_api_tools_company_id_companies_id_fk).toBe("FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE");
    expect(s.constraints.company_api_tools_status_check).toBe("CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))");
    expect(s.constraints.company_api_tools_daily_cap_check).toBe("CHECK ((daily_cap > 0))");
    expect(s.indexes).toContain("company_api_tools_company_key_uq");
    expect(s.indexes).toContain("company_api_tools_company_id_idx");
  });

  it("creates company_api_tool_calls as an audit table that survives the tool being deleted", async () => {
    const cols = await columns("company_api_tool_calls");
    expect(cols.get("tool_id")).toMatchObject({ type: "uuid", nullable: true });
    expect(cols.get("agent_id")).toMatchObject({ type: "uuid", nullable: true });
    expect(cols.get("channel")).toMatchObject({ type: "text", nullable: false });
    expect(cols.get("status")).toMatchObject({ type: "text", nullable: false });
    expect(cols.get("http_status")).toMatchObject({ type: "integer", nullable: true });
    // No column could ever carry a request, a response or an error text.
    expect([...cols.keys()].sort()).toEqual([
      "action", "agent_id", "channel", "company_id", "created_at", "duration_ms", "http_status", "id", "run_id", "status", "tool_id", "user_id",
    ]);
    const s = await snapshot();
    expect(s.constraints.company_api_tool_calls_tool_id_company_api_tools_id_fk).toBe("FOREIGN KEY (tool_id) REFERENCES company_api_tools(id) ON DELETE SET NULL");
    expect(s.constraints.company_api_tool_calls_channel_check).toContain("'quick_chat'::text");
    expect(s.constraints.company_api_tool_calls_status_check).toContain("'rate_limited'::text");
    expect(s.indexes).toContain("company_api_tool_calls_company_created_idx");
    expect(s.indexes).toContain("company_api_tool_calls_tool_created_idx");
  });

  it("adds agents.api_tool_ids as an empty list by default", async () => {
    const cols = await columns("agents");
    expect(cols.get("api_tool_ids")).toMatchObject({ type: "jsonb", nullable: false, def: "'[]'::jsonb" });
  });

  it("refuses a bad status, a zero cap and a duplicate key within one company; the audit row keeps living after the tool is gone", async () => {
    async function insertTool(values: { key: string; status?: string; dailyCap?: number }): Promise<string | null> {
      try {
        const rows = (await db.execute(sql`
          INSERT INTO company_api_tools (company_id, name, key, base_url, status, daily_cap)
          VALUES (${companyId}, ${values.key}, ${values.key}, 'https://fal.run', ${values.status ?? "active"}, ${values.dailyCap ?? 300})
          RETURNING id
        `)) as unknown as Row[];
        return rows[0]!.id as string;
      } catch {
        return null;
      }
    }
    const toolId = await insertTool({ key: "fal-ai" });
    expect(toolId).not.toBeNull();
    expect(await insertTool({ key: "fal-ai" })).toBeNull();
    expect(await insertTool({ key: "fiken", status: "paused" })).toBeNull();
    expect(await insertTool({ key: "fiken", dailyCap: 0 })).toBeNull();

    await db.execute(sql`
      INSERT INTO company_api_tool_calls (company_id, tool_id, action, channel, status, http_status)
      VALUES (${companyId}, ${toolId}, 'run', 'quick_chat', 'ok', 200)
    `);
    await expect(db.execute(sql`
      INSERT INTO company_api_tool_calls (company_id, tool_id, action, channel, status)
      VALUES (${companyId}, ${toolId}, 'run', 'email', 'ok')
    `)).rejects.toThrow();
    await db.execute(sql`DELETE FROM company_api_tools WHERE id = ${toolId}`);
    const rows = (await db.execute(sql`SELECT tool_id FROM company_api_tool_calls WHERE company_id = ${companyId}`)) as unknown as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_id).toBeNull();
  });

  it("both tables are granted and policed like every other tenant table", async () => {
    for (const table of ["company_api_tools", "company_api_tool_calls"]) {
      const rows = (await db.execute(sql`
        SELECT c.relrowsecurity AS rls, p.policyname AS policy,
               has_table_privilege('paperclip_app_scoped', ${table}, 'INSERT') AS scoped,
               has_table_privilege('paperclip_app_bypass_login', ${table}, 'UPDATE') AS bypass
        FROM pg_class c
        LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'paperclip_company_scope'
        WHERE c.relname = ${table}
      `)) as unknown as Row[];
      expect(rows[0]?.rls, `${table} row security`).toBe(true);
      expect(rows[0]?.policy, `${table} policy`).toBe("paperclip_company_scope");
      expect(rows[0]?.scoped, `${table} scoped grant`).toBe(true);
      expect(rows[0]?.bypass, `${table} bypass grant`).toBe(true);
    }
  });

  it("is idempotent: running the file a second time changes nothing", async () => {
    const before = await snapshot();
    const statements = migrationStatements();
    expect(statements.length).toBeGreaterThanOrEqual(5);
    for (const statement of statements) await db.execute(sql.raw(statement));
    expect(await snapshot()).toEqual(before);
    const policies = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_policies WHERE tablename IN ('company_api_tools', 'company_api_tool_calls') AND policyname = 'paperclip_company_scope'
    `)) as unknown as Row[];
    expect(policies[0]?.n).toBe(2);
  });

  it("is registered in the journal after 0176 with a strictly greater timestamp", () => {
    const journal = JSON.parse(readFileSync(fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const position = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
    expect(position).toBeGreaterThan(0);
    const mine = journal.entries[position]!;
    const previous = journal.entries[position - 1]!;
    expect(mine).toMatchObject({ idx: 177 });
    expect(previous.tag).toBe("0176_issue_thread_interaction_expiry");
    expect(mine.when).toBeGreaterThan(previous.when);
    expect(journal.entries.filter((entry) => entry.when === mine.when)).toHaveLength(1);
  });

  it("the file itself only creates, never drops, and touches no data", () => {
    const text = readFileSync(MIGRATION_PATH, "utf8")
      .split("\n")
      .map((line) => line.replace(/^\s*--.*$/, ""))
      .join("\n");
    expect(text).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bREVOKE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"?\w+"?\s+SET\b/i);
    expect(text).not.toMatch(/information_schema\.(tables|columns)/);
    expect(text).not.toMatch(/ALL TABLES IN SCHEMA/);
  });
});
