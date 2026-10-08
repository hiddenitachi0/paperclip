import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0235_model_directory_catalogue adds the catalogue columns
 * (maker, base model, lane, availability, tags, specs, favourite, archive) to
 * model_directory_entries. Checked on a table that already holds rows (the
 * columns are dropped first, as before 0235): existing rows get the defaults,
 * a bad lane / availability is refused, the company policy still holds, and
 * the file is safe to run twice.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const MIGRATION_TAG = "0235_model_directory_catalogue";
const MIGRATION_PATH = fileURLToPath(new URL(`./migrations/${MIGRATION_TAG}.sql`, import.meta.url));
const NEW_COLUMNS = ["maker", "base_model", "lane", "availability", "tags", "specs", "favorite", "archived_at"];

type Row = Record<string, unknown>;

d(`migration ${MIGRATION_TAG}`, () => {
  let db!: ReturnType<typeof createDb>;
  let connectionString!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyA = randomUUID();
  const companyB = randomUUID();

  async function runMigrationFile() {
    const statements = readFileSync(MIGRATION_PATH, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const statement of statements) await db.execute(sql.raw(statement));
  }

  async function tryInsert(companyId: string, name: string, lane: string | null, availability: string | null): Promise<boolean> {
    try {
      await db.execute(sql`
        INSERT INTO model_directory_entries (company_id, name, provider, model, lane, availability)
        VALUES (${companyId}, ${name}, 'anthropic', 'claude-sonnet-5', ${lane}, ${availability})
      `);
      return true;
    } catch {
      return false;
    }
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0235-model-directory-catalogue-");
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyA}, 'A', 'MCA'), (${companyB}, 'B', 'MCB')`);
    // Back to the shape before 0235, with rows in it, then run 0235 itself.
    await db.execute(sql.raw(`ALTER TABLE "model_directory_entries" ${NEW_COLUMNS.map((c) => `DROP COLUMN "${c}"`).join(", ")}`));
    await db.execute(sql`
      INSERT INTO model_directory_entries (company_id, name, provider, model)
      VALUES (${companyA}, 'Before A', 'anthropic', 'claude-sonnet-5'), (${companyB}, 'Before B', 'anthropic', 'claude-sonnet-5')
    `);
    await runMigrationFile();
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("adds the catalogue columns with the intended types and defaults", async () => {
    const rows = (await db.execute(sql`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'model_directory_entries'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    `)) as unknown as Row[];
    const cols = new Map(rows.map((r) => [r.name as string, r]));
    expect(cols.get("maker")).toMatchObject({ type: "text", nullable: true, def: null });
    expect(cols.get("base_model")).toMatchObject({ type: "text", nullable: true, def: null });
    expect(cols.get("lane")).toMatchObject({ type: "text", nullable: true, def: null });
    expect(cols.get("availability")).toMatchObject({ type: "text", nullable: true, def: null });
    expect(cols.get("tags")).toMatchObject({ type: "text[]", nullable: false, def: "'{}'::text[]" });
    expect(cols.get("specs")).toMatchObject({ type: "jsonb", nullable: true, def: null });
    expect(cols.get("favorite")).toMatchObject({ type: "boolean", nullable: false, def: "false" });
    expect(cols.get("archived_at")).toMatchObject({ type: "timestamp with time zone", nullable: true, def: null });
    expect(cols.has("api_key")).toBe(false);
  });

  it("gives rows saved before the migration the defaults: no tags, not a favourite, not archived", async () => {
    const rows = (await db.execute(sql`
      SELECT name, maker, base_model, lane, availability, tags, specs, favorite, archived_at
      FROM model_directory_entries WHERE name LIKE 'Before%' ORDER BY name
    `)) as unknown as Row[];
    expect(rows).toEqual([
      { name: "Before A", maker: null, base_model: null, lane: null, availability: null, tags: [], specs: null, favorite: false, archived_at: null },
      { name: "Before B", maker: null, base_model: null, lane: null, availability: null, tags: [], specs: null, favorite: false, archived_at: null },
    ]);
  });

  it("accepts the known lanes and availabilities (or none) and refuses anything else", async () => {
    expect(await tryInsert(companyA, "quick installed", "quick", "installed")).toBe(true);
    expect(await tryInsert(companyA, "full downloading", "full", "downloading")).toBe(true);
    expect(await tryInsert(companyA, "both planned", "both", "planned")).toBe(true);
    expect(await tryInsert(companyA, "cloud", null, "cloud")).toBe(true);
    expect(await tryInsert(companyA, "unsaid", null, null)).toBe(true);
    expect(await tryInsert(companyA, "bad lane", "sometimes", null)).toBe(false);
    expect(await tryInsert(companyA, "bad availability", null, "maybe")).toBe(false);
  });

  it("keeps the company policy: company A's scoped connection sees and changes only A's rows, new columns included", async () => {
    const scoped = postgres(connectionString, { max: 1 });
    try {
      await scoped`SET ROLE paperclip_app_scoped`;
      await scoped`select set_config('app.current_company_id', ${companyA}, false)`;
      const rows = await scoped`SELECT company_id, tags, favorite, archived_at FROM model_directory_entries`;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.company_id === companyA)).toBe(true);
      expect(await scoped`UPDATE model_directory_entries SET favorite = true WHERE company_id = ${companyB} RETURNING id`).toHaveLength(0);
      expect(await scoped`UPDATE model_directory_entries SET archived_at = now() WHERE company_id = ${companyB} RETURNING id`).toHaveLength(0);
      expect((await scoped`UPDATE model_directory_entries SET tags = ARRAY['fast'] WHERE name = 'Before A' RETURNING tags`)[0]?.tags).toEqual(["fast"]);
    } finally {
      await scoped.end();
    }
    const b = (await db.execute(sql`SELECT favorite, archived_at FROM model_directory_entries WHERE company_id = ${companyB}`)) as unknown as Row[];
    expect(b).toEqual([{ favorite: false, archived_at: null }]);
  });

  it("is idempotent: running the file a second time changes nothing", async () => {
    const before = (await db.execute(sql`SELECT count(*)::int AS n FROM model_directory_entries`)) as unknown as Row[];
    await runMigrationFile();
    const checks = (await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'model_directory_entries'::regclass AND conname IN ('model_directory_entries_lane_check', 'model_directory_entries_availability_check')
      ORDER BY conname
    `)) as unknown as Row[];
    expect(checks.map((c) => c.conname)).toEqual(["model_directory_entries_availability_check", "model_directory_entries_lane_check"]);
    const after = (await db.execute(sql`SELECT count(*)::int AS n FROM model_directory_entries`)) as unknown as Row[];
    expect(after[0]?.n).toBe(before[0]?.n);
    const tags = (await db.execute(sql`SELECT tags FROM model_directory_entries WHERE name = 'Before A'`)) as unknown as Row[];
    expect(tags[0]?.tags).toEqual(["fast"]);
  });

  it("is registered in the journal, after the one before it", () => {
    const journal = JSON.parse(readFileSync(fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const at = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
    expect(at).toBeGreaterThan(0);
    expect(journal.entries[at]!.when).toBeGreaterThan(journal.entries[at - 1]!.when);
  });
});
