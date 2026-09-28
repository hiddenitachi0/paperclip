import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0180_agent_memories applies on the embedded-Postgres path (every
 * migration, in journal order), creates the quick-agent memory notebook with
 * the intended shape, grants and polices it like every other tenant table,
 * writes no row, and is safe to run twice. Deleting the job, the person or
 * the company takes their notes with it.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0180 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0180_agent_memories";
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
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0180-agent-memories-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Memory', 'MEM')`);
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
      "agent_memories_company_id_companies_id_fk",
      "agent_memories_agent_id_agents_id_fk",
      "agent_memories_persona_id_personas_id_fk",
      "agent_memories_source_check",
      "agent_memories_text_length_check",
    ];
    const out: Record<string, string | null> = {};
    for (const name of names) out[name] = await constraintDef(name);
    const indexes = (await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'agent_memories' ORDER BY indexname
    `)) as unknown as Row[];
    return { constraints: out, indexes: indexes.map((row) => row.indexname) };
  }

  async function insertAgent(): Promise<string> {
    const agentId = randomUUID();
    await db.execute(sql`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${companyId}, ${`Agent ${agentId.slice(0, 6)}`})`);
    return agentId;
  }

  async function insertPersona(): Promise<string> {
    const personaId = randomUUID();
    await db.execute(sql`INSERT INTO personas (id, company_id, display_name) VALUES (${personaId}, ${companyId}, 'Maja')`);
    return personaId;
  }

  async function insertNote(values: { agentId: string; personaId?: string | null; text?: string; source?: string }): Promise<string | null> {
    try {
      const rows = (await db.execute(sql`
        INSERT INTO agent_memories (company_id, agent_id, persona_id, text, source)
        VALUES (${companyId}, ${values.agentId}, ${values.personaId ?? null}, ${values.text ?? "I take my coffee black."}, ${values.source ?? "agent"})
        RETURNING id
      `)) as unknown as Row[];
      return rows[0]!.id as string;
    } catch {
      return null;
    }
  }

  it("creates agent_memories with the intended columns, keys and indexes", async () => {
    const cols = await columns("agent_memories");
    expect([...cols.keys()].sort()).toEqual([
      "agent_id", "company_id", "created_at", "created_by_user_id", "id", "persona_id", "source", "text", "updated_at",
    ]);
    expect(cols.get("company_id")).toMatchObject({ type: "uuid", nullable: false });
    expect(cols.get("agent_id")).toMatchObject({ type: "uuid", nullable: false });
    expect(cols.get("persona_id")).toMatchObject({ type: "uuid", nullable: true });
    expect(cols.get("text")).toMatchObject({ type: "text", nullable: false });
    expect(cols.get("source")).toMatchObject({ type: "text", nullable: false, def: null });
    expect(cols.get("created_by_user_id")).toMatchObject({ type: "text", nullable: true });
    expect(cols.get("created_at")).toMatchObject({ type: "timestamp with time zone", nullable: false, def: "now()" });
    const s = await snapshot();
    expect(s.constraints.agent_memories_company_id_companies_id_fk).toBe("FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE");
    expect(s.constraints.agent_memories_agent_id_agents_id_fk).toBe("FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE");
    expect(s.constraints.agent_memories_persona_id_personas_id_fk).toBe("FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE");
    expect(s.constraints.agent_memories_source_check).toBe("CHECK ((source = ANY (ARRAY['agent'::text, 'user'::text])))");
    expect(s.constraints.agent_memories_text_length_check).toContain("char_length(text)");
    expect(s.indexes).toEqual(["agent_memories_company_agent_idx", "agent_memories_company_persona_idx", "agent_memories_pkey"]);
  });

  it("refuses an empty note, a note over 500 characters and an unknown source", async () => {
    const agentId = await insertAgent();
    expect(await insertNote({ agentId, text: "x".repeat(500) })).not.toBeNull();
    expect(await insertNote({ agentId, text: "x".repeat(501) })).toBeNull();
    expect(await insertNote({ agentId, text: "" })).toBeNull();
    expect(await insertNote({ agentId, source: "system" })).toBeNull();
    expect(await insertNote({ agentId, source: "user" })).not.toBeNull();
  });

  it("deleting the job deletes its notes; deleting the person deletes the person's notes", async () => {
    const agentId = await insertAgent();
    const otherJob = await insertAgent();
    const personaId = await insertPersona();
    const own = await insertNote({ agentId });
    const persons = await insertNote({ agentId: otherJob, personaId });
    expect(own).not.toBeNull();
    expect(persons).not.toBeNull();
    await db.execute(sql`DELETE FROM agents WHERE id = ${agentId}`);
    await db.execute(sql`DELETE FROM personas WHERE id = ${personaId}`);
    const rows = (await db.execute(sql`SELECT id FROM agent_memories WHERE id IN (${own}, ${persons})`)) as unknown as Row[];
    expect(rows).toHaveLength(0);
  });

  it("is granted and policed like every other tenant table", async () => {
    const rows = (await db.execute(sql`
      SELECT c.relrowsecurity AS rls, p.policyname AS policy,
             has_table_privilege('paperclip_app_scoped', 'agent_memories', 'INSERT') AS scoped,
             has_table_privilege('paperclip_app_bypass_login', 'agent_memories', 'UPDATE') AS bypass
      FROM pg_class c
      LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'paperclip_company_scope'
      WHERE c.relname = 'agent_memories'
    `)) as unknown as Row[];
    expect(rows[0]?.rls).toBe(true);
    expect(rows[0]?.policy).toBe("paperclip_company_scope");
    expect(rows[0]?.scoped).toBe(true);
    expect(rows[0]?.bypass).toBe(true);
  });

  it("is idempotent: running the file a second time changes nothing", async () => {
    const before = await snapshot();
    const count = (await db.execute(sql`SELECT count(*)::int AS n FROM agent_memories`)) as unknown as Row[];
    const statements = migrationStatements();
    expect(statements.length).toBeGreaterThanOrEqual(4);
    for (const statement of statements) await db.execute(sql.raw(statement));
    expect(await snapshot()).toEqual(before);
    const after = (await db.execute(sql`SELECT count(*)::int AS n FROM agent_memories`)) as unknown as Row[];
    expect(after[0]?.n).toBe(count[0]?.n);
    const policies = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'agent_memories' AND policyname = 'paperclip_company_scope'
    `)) as unknown as Row[];
    expect(policies[0]?.n).toBe(1);
  });

  it("is registered in the journal after 0179 with a strictly greater timestamp", () => {
    const journal = JSON.parse(readFileSync(fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const position = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
    expect(position).toBeGreaterThan(0);
    const mine = journal.entries[position]!;
    const previous = journal.entries[position - 1]!;
    expect(mine).toMatchObject({ idx: 180 });
    expect(previous.tag).toBe("0179_lane_a_temperature");
    expect(mine.when).toBeGreaterThan(previous.when);
    expect(mine.when).toBeGreaterThan(1787160480000);
    expect(journal.entries.filter((entry) => entry.when === mine.when)).toHaveLength(1);
  });

  it("the file itself only creates, never drops, and touches no data", () => {
    const text = readFileSync(MIGRATION_PATH, "utf8")
      .split("\n")
      .map((line) => line.replace(/^\s*--.*$/, ""))
      .join("\n");
    expect(text).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bREVOKE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"?\w+"?\s+SET\b|\bINSERT\s+INTO\b/i);
    expect(text).not.toMatch(/information_schema\.(tables|columns)/);
    expect(text).not.toMatch(/ALL TABLES IN SCHEMA/);
  });
});
