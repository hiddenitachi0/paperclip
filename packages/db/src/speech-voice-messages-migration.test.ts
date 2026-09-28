import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0181_speech_voice_messages applies on the embedded-Postgres path
 * (every migration, in journal order): two defaulted columns on telegram_bots,
 * the per-company speech allowances, and the speech usage log, granted and
 * policed like every other tenant table, with no row written, and safe to run
 * twice.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0181 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0181_speech_voice_messages";
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
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0181-speech-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Voice', 'VOI')`);
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

  async function snapshot() {
    const constraints = (await db.execute(sql`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid IN ('telegram_bots'::regclass, 'company_speech_settings'::regclass, 'speech_usage_events'::regclass)
      ORDER BY conname
    `)) as unknown as Row[];
    const indexes = (await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('company_speech_settings', 'speech_usage_events') ORDER BY indexname
    `)) as unknown as Row[];
    return { constraints, indexes: indexes.map((row) => row.indexname) };
  }

  async function tryExec(query: ReturnType<typeof sql>): Promise<boolean> {
    try {
      await db.execute(query);
      return true;
    } catch {
      return false;
    }
  }

  it("adds the voice columns to telegram_bots with a safe default", async () => {
    const cols = await columns("telegram_bots");
    expect(cols.get("voice_reply_mode")).toMatchObject({ type: "text", nullable: false, def: "'when_voice'::text" });
    expect(cols.get("voice")).toMatchObject({ type: "text", nullable: true, def: null });
    const s = await snapshot();
    const check = s.constraints.find((row) => row.conname === "telegram_bots_voice_reply_mode_check");
    expect(check?.def).toBe("CHECK ((voice_reply_mode = ANY (ARRAY['never'::text, 'when_voice'::text, 'always'::text])))");
  });

  it("creates the allowance and usage tables with the intended shape", async () => {
    const settings = await columns("company_speech_settings");
    expect([...settings.keys()].sort()).toEqual([
      "company_id", "created_at", "daily_speak_characters_cap", "daily_transcribe_seconds_cap", "id", "updated_at", "updated_by_user_id",
    ]);
    expect(settings.get("daily_transcribe_seconds_cap")).toMatchObject({ type: "integer", nullable: false, def: "3600" });
    expect(settings.get("daily_speak_characters_cap")).toMatchObject({ type: "integer", nullable: false, def: "50000" });
    const usage = await columns("speech_usage_events");
    expect([...usage.keys()].sort()).toEqual([
      "actor_user_id", "amount", "company_id", "created_at", "id", "kind", "model", "source", "telegram_bot_id",
    ]);
    const s = await snapshot();
    expect(s.indexes).toEqual([
      "company_speech_settings_company_uq",
      "company_speech_settings_pkey",
      "speech_usage_events_company_kind_created_idx",
      "speech_usage_events_pkey",
    ]);
    const fk = s.constraints.find((row) => row.conname === "speech_usage_events_telegram_bot_id_telegram_bots_id_fk");
    expect(fk?.def).toBe("FOREIGN KEY (telegram_bot_id) REFERENCES telegram_bots(id) ON DELETE SET NULL");
  });

  it("refuses an unknown kind, a negative amount, a negative cap and a second settings row", async () => {
    expect(await tryExec(sql`INSERT INTO speech_usage_events (company_id, kind, amount, model, source) VALUES (${companyId}, 'transcribe', 3, 'm', 'telegram')`)).toBe(true);
    expect(await tryExec(sql`INSERT INTO speech_usage_events (company_id, kind, amount, model, source) VALUES (${companyId}, 'sing', 3, 'm', 'telegram')`)).toBe(false);
    expect(await tryExec(sql`INSERT INTO speech_usage_events (company_id, kind, amount, model, source) VALUES (${companyId}, 'speak', -1, 'm', 'chat')`)).toBe(false);
    expect(await tryExec(sql`INSERT INTO company_speech_settings (company_id, daily_transcribe_seconds_cap) VALUES (${companyId}, -5)`)).toBe(false);
    expect(await tryExec(sql`INSERT INTO company_speech_settings (company_id) VALUES (${companyId})`)).toBe(true);
    expect(await tryExec(sql`INSERT INTO company_speech_settings (company_id) VALUES (${companyId})`)).toBe(false);
    await db.execute(sql`DELETE FROM speech_usage_events`);
    await db.execute(sql`DELETE FROM company_speech_settings`);
  });

  it("is granted and policed like every other tenant table", async () => {
    for (const table of ["company_speech_settings", "speech_usage_events"]) {
      const rows = (await db.execute(sql`
        SELECT c.relrowsecurity AS rls, p.policyname AS policy,
               has_table_privilege('paperclip_app_scoped', ${table}, 'INSERT') AS scoped,
               has_table_privilege('paperclip_app_bypass_login', ${table}, 'UPDATE') AS bypass
        FROM pg_class c
        LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'paperclip_company_scope'
        WHERE c.relname = ${table}
      `)) as unknown as Row[];
      expect(rows[0], table).toMatchObject({ rls: true, policy: "paperclip_company_scope", scoped: true, bypass: true });
    }
  });

  it("is idempotent: running the file a second time changes nothing", async () => {
    const before = await snapshot();
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    expect(await snapshot()).toEqual(before);
    const policies = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_policies
      WHERE tablename IN ('company_speech_settings', 'speech_usage_events') AND policyname = 'paperclip_company_scope'
    `)) as unknown as Row[];
    expect(policies[0]?.n).toBe(2);
  });

  it("is registered in the journal after 0180 with a strictly greater timestamp", () => {
    const journal = JSON.parse(readFileSync(fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const position = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
    expect(position).toBeGreaterThan(0);
    const mine = journal.entries[position]!;
    const previous = journal.entries[position - 1]!;
    expect(mine.when).toBeGreaterThan(previous.when);
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
