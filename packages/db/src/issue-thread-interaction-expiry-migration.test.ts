import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0176_issue_thread_interaction_expiry applies on the
 * embedded-Postgres path (every migration, in journal order), adds the two
 * per-card expiry columns and the CHECK that keeps 0 out, writes no row, and
 * is safe to run twice. A row inserted before a re-run keeps NULL / false, so
 * the server's per-creator default (a board user's card never closes by
 * itself) is what decides about every card that already exists.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0176 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0176_issue_thread_interaction_expiry";
const MIGRATION_PATH = fileURLToPath(new URL(`./migrations/${MIGRATION_TAG}.sql`, import.meta.url));
const CHECK_NAME = "issue_thread_interactions_expires_after_hours_check";

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
  let issueId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0176-card-expiry-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    issueId = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Card expiry', 'CEX')`);
    await db.execute(sql`INSERT INTO issues (id, company_id, title, status, priority, issue_number, identifier) VALUES (${issueId}, ${companyId}, 'Operator to-do list', 'in_review', 'medium', 1, 'CEX-1')`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function rerunMigration() {
    for (const statement of migrationStatements()) {
      await db.execute(sql.raw(statement));
    }
  }

  async function columns(): Promise<Map<string, { type: string; nullable: boolean; def: string | null }>> {
    const rows = (await db.execute(sql`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'issue_thread_interactions'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    `)) as unknown as Row[];
    return new Map(rows.map((row) => [
      row.name as string,
      { type: row.type as string, nullable: row.nullable as boolean, def: (row.def as string | null) ?? null },
    ]));
  }

  async function checkDef(): Promise<{ count: number; def: string | null }> {
    const rows = (await db.execute(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${CHECK_NAME}`,
    )) as unknown as Row[];
    return { count: rows.length, def: (rows[0]?.def as string | undefined) ?? null };
  }

  async function insertCard(input: { expiresAfterHours: number | null; neverExpires?: boolean; byUser?: boolean }): Promise<{ ok: boolean; id: string }> {
    const id = randomUUID();
    try {
      await db.execute(sql`
        INSERT INTO issue_thread_interactions
          (id, company_id, issue_id, kind, status, continuation_policy, title, created_by_user_id, expires_after_hours, never_expires, payload)
        VALUES
          (${id}, ${companyId}, ${issueId}, 'request_checkbox_confirmation', 'pending', 'wake_assignee', 'To-do',
           ${input.byUser === false ? null : "user-filip"}, ${input.expiresAfterHours}, ${input.neverExpires ?? false},
           '{"version":1,"prompt":"Tick what is done","options":[{"id":"a","label":"A"}]}'::jsonb)
      `);
      return { ok: true, id };
    } catch {
      return { ok: false, id };
    }
  }

  it("adds expires_after_hours (integer, nullable, no default) and never_expires (boolean, not null, false)", async () => {
    const cols = await columns();
    expect(cols.get("expires_after_hours")).toEqual({ type: "integer", nullable: true, def: null });
    expect(cols.get("never_expires")).toEqual({ type: "boolean", nullable: false, def: "false" });
  });

  it("keeps 0 and negatives out of expires_after_hours with a named CHECK, and accepts NULL, a positive number and never_expires", async () => {
    expect(await checkDef()).toEqual({ count: 1, def: "CHECK (((expires_after_hours IS NULL) OR (expires_after_hours > 0)))" });
    expect((await insertCard({ expiresAfterHours: 0 })).ok).toBe(false);
    expect((await insertCard({ expiresAfterHours: -1 })).ok).toBe(false);
    expect((await insertCard({ expiresAfterHours: null })).ok).toBe(true);
    expect((await insertCard({ expiresAfterHours: 2 })).ok).toBe(true);
    expect((await insertCard({ expiresAfterHours: null, neverExpires: true })).ok).toBe(true);
  });

  it("an existing pending card keeps NULL / false through a re-run: the per-creator default decides, no data is migrated", async () => {
    const { ok, id } = await insertCard({ expiresAfterHours: null });
    expect(ok).toBe(true);
    await rerunMigration();
    const [row] = (await db.execute(
      sql`SELECT status, expires_after_hours, never_expires, created_by_user_id, created_by_agent_id FROM issue_thread_interactions WHERE id = ${id}`,
    )) as unknown as Row[];
    expect(row).toEqual({
      status: "pending",
      expires_after_hours: null,
      never_expires: false,
      created_by_user_id: "user-filip",
      created_by_agent_id: null,
    });
  });

  it("is idempotent: a further run changes nothing and keeps exactly one CHECK", async () => {
    const before = await columns();
    await rerunMigration();
    await rerunMigration();
    expect(await columns()).toEqual(before);
    expect((await checkDef()).count).toBe(1);
  });

  it("keeps row-level security and the company-scope policy on issue_thread_interactions", async () => {
    const rows = (await db.execute(sql`
      SELECT c.relrowsecurity AS rls, p.policyname AS policy
      FROM pg_class c
      LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'paperclip_company_scope'
      WHERE c.relname = 'issue_thread_interactions'
    `)) as unknown as Row[];
    expect(rows[0]?.rls).toBe(true);
    expect(rows[0]?.policy).toBe("paperclip_company_scope");
  });

  it("is registered in the journal as idx 176, strictly after 0175 (Drizzle applies only strictly greater `when`)", () => {
    const journal = JSON.parse(readFileSync(fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const position = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
    expect(position).toBeGreaterThan(0);
    const mine = journal.entries[position]!;
    const previous = journal.entries[position - 1]!;
    expect(mine).toMatchObject({ idx: 176 });
    expect(previous).toMatchObject({ idx: 175, tag: "0175_persona_identity", when: 1787160450000 });
    expect(mine.when).toBeGreaterThan(previous.when);
    expect(journal.entries.filter((entry) => entry.when === mine.when)).toHaveLength(1);
    for (const entry of journal.entries.slice(position + 1)) {
      expect(entry.when, `${entry.tag} must come strictly after ${MIGRATION_TAG}`).toBeGreaterThan(mine.when);
    }
  });

  it("the file only adds: two guarded columns and one guarded CHECK, no DROP, no UPDATE, no DELETE", () => {
    const text = readFileSync(MIGRATION_PATH, "utf8")
      .split("\n")
      .map((line) => line.replace(/^\s*--.*$/, ""))
      .join("\n");
    expect(text).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bREVOKE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"?\w+"?\s+SET\b|\bALTER\s+COLUMN\b/i);
    expect(text).not.toMatch(/information_schema\.(tables|columns)/);
    expect(text.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(2);
    expect(text).toContain('ADD COLUMN IF NOT EXISTS "expires_after_hours" integer');
    expect(text).toContain('ADD COLUMN IF NOT EXISTS "never_expires" boolean DEFAULT false NOT NULL');
    expect(text.match(/ADD CONSTRAINT/g)).toHaveLength(1);
    expect(text).toMatch(new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_constraint WHERE conname = '${CHECK_NAME}'\\)`));
  });
});
