import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0181_watchers applies on the embedded-Postgres path (every
 * migration, in journal order), creates the three watcher tables with the
 * intended shape, grants and polices them like every other tenant table,
 * writes no row, and is safe to run twice. Deleting the agent or the company
 * takes the watchers, their price history and their alerts with them.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0181 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0181_watchers";
const MIGRATION_PATH = fileURLToPath(new URL(`./migrations/${MIGRATION_TAG}.sql`, import.meta.url));
const TABLES = ["watchers", "watcher_price_points", "watcher_alerts"] as const;

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
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0181-watchers-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Watch', 'WAT')`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function columnNames(table: string): Promise<string[]> {
    const rows = (await db.execute(sql`
      SELECT a.attname AS name FROM pg_attribute a
      WHERE a.attrelid = ${table}::regclass AND a.attnum > 0 AND NOT a.attisdropped
    `)) as unknown as Row[];
    return rows.map((row) => row.name as string).sort();
  }

  async function constraintDef(name: string): Promise<string | null> {
    const rows = (await db.execute(sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}`)) as unknown as Row[];
    return (rows[0]?.def as string | undefined) ?? null;
  }

  async function snapshot() {
    const constraints = (await db.execute(sql`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid IN ('watchers'::regclass, 'watcher_price_points'::regclass, 'watcher_alerts'::regclass)
      ORDER BY conname
    `)) as unknown as Row[];
    const indexes = (await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename IN ('watchers', 'watcher_price_points', 'watcher_alerts') ORDER BY indexname
    `)) as unknown as Row[];
    return { constraints, indexes: indexes.map((row) => row.indexname) };
  }

  async function insertAgent(): Promise<string> {
    const agentId = randomUUID();
    await db.execute(sql`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${companyId}, ${`Agent ${agentId.slice(0, 6)}`})`);
    return agentId;
  }

  async function insertWatcher(agentId: string, values: { source?: string; checkEvery?: number } = {}): Promise<string | null> {
    try {
      const rows = (await db.execute(sql`
        INSERT INTO watchers (company_id, agent_id, name, source, symbol, rule, check_every_minutes)
        VALUES (${companyId}, ${agentId}, 'Bitcoin jumps', ${values.source ?? "crypto"}, 'BTC',
                ${JSON.stringify({ kind: "change", direction: "up", percent: 5, windowHours: 24 })}::jsonb,
                ${values.checkEvery ?? 15})
        RETURNING id
      `)) as unknown as Row[];
      return rows[0]!.id as string;
    } catch {
      return null;
    }
  }

  it("creates the three tables with the intended columns, keys and indexes", async () => {
    expect(await columnNames("watchers")).toEqual([
      "agent_id", "alerts_today", "check_every_minutes", "check_lease_until", "checks_today", "company_id",
      "condition_met", "consecutive_failures", "cooldown_minutes", "counters_day", "created_at", "created_by_user_id",
      "enabled", "id", "key_secret_id", "last_alert_at", "last_alert_price", "last_check_at", "last_check_message",
      "last_check_ok", "last_price", "last_price_at", "name", "next_check_at", "rule", "source", "symbol",
      "updated_at", "with_picture",
    ]);
    expect(await columnNames("watcher_price_points")).toEqual(["company_id", "id", "observed_at", "price", "watcher_id"]);
    expect(await columnNames("watcher_alerts")).toEqual([
      "agent_id", "company_id", "compose_attempts", "compose_lease_until", "created_at", "delivered_at", "facts", "id",
      "image_file_id", "is_test", "note", "ready_at", "status", "text", "watcher_id",
    ]);
    expect(await constraintDef("watchers_agent_id_agents_id_fk")).toBe("FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE");
    expect(await constraintDef("watchers_key_secret_id_company_secrets_id_fk")).toBe(
      "FOREIGN KEY (key_secret_id) REFERENCES company_secrets(id) ON DELETE SET NULL",
    );
    expect(await constraintDef("watcher_alerts_status_check")).toContain("'composing'::text");
    const s = await snapshot();
    expect(s.indexes).toEqual([
      "watcher_alerts_company_status_idx",
      "watcher_alerts_pkey",
      "watcher_alerts_watcher_created_idx",
      "watcher_price_points_pkey",
      "watcher_price_points_watcher_observed_idx",
      "watchers_company_idx",
      "watchers_due_idx",
      "watchers_pkey",
    ]);
  });

  it("refuses an unknown source and a check more often than every 5 minutes", async () => {
    const agentId = await insertAgent();
    expect(await insertWatcher(agentId)).not.toBeNull();
    expect(await insertWatcher(agentId, { source: "forex" })).toBeNull();
    expect(await insertWatcher(agentId, { checkEvery: 4 })).toBeNull();
    expect(await insertWatcher(agentId, { checkEvery: 5 })).not.toBeNull();
  });

  it("refuses an unknown alert status", async () => {
    const agentId = await insertAgent();
    const watcherId = await insertWatcher(agentId);
    await expect(
      db.execute(sql`
        INSERT INTO watcher_alerts (company_id, watcher_id, agent_id, status, facts)
        VALUES (${companyId}, ${watcherId}, ${agentId}, 'sent', '{}'::jsonb)
      `),
    ).rejects.toThrow();
  });

  it("deleting the agent deletes its watchers, their price history and their alerts", async () => {
    const agentId = await insertAgent();
    const watcherId = await insertWatcher(agentId);
    await db.execute(sql`INSERT INTO watcher_price_points (company_id, watcher_id, price) VALUES (${companyId}, ${watcherId}, 83000)`);
    await db.execute(sql`
      INSERT INTO watcher_alerts (company_id, watcher_id, agent_id, facts) VALUES (${companyId}, ${watcherId}, ${agentId}, '{}'::jsonb)
    `);
    await db.execute(sql`DELETE FROM agents WHERE id = ${agentId}`);
    for (const table of TABLES) {
      const column = table === "watchers" ? "id" : "watcher_id";
      const rows = (await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = '${watcherId}'`))) as unknown as Row[];
      expect(rows[0]?.n).toBe(0);
    }
  });

  it("is granted and policed like every other tenant table", async () => {
    for (const table of TABLES) {
      const rows = (await db.execute(sql`
        SELECT c.relrowsecurity AS rls, p.policyname AS policy,
               has_table_privilege('paperclip_app_scoped', ${table}, 'INSERT') AS scoped,
               has_table_privilege('paperclip_app_bypass_login', ${table}, 'UPDATE') AS bypass
        FROM pg_class c
        LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'paperclip_company_scope'
        WHERE c.relname = ${table}
      `)) as unknown as Row[];
      expect(rows[0]).toMatchObject({ rls: true, policy: "paperclip_company_scope", scoped: true, bypass: true });
    }
  });

  it("is idempotent: running the file a second time changes nothing", async () => {
    const before = await snapshot();
    const count = (await db.execute(sql`SELECT count(*)::int AS n FROM watchers`)) as unknown as Row[];
    const statements = migrationStatements();
    expect(statements.length).toBeGreaterThanOrEqual(8);
    for (const statement of statements) await db.execute(sql.raw(statement));
    expect(await snapshot()).toEqual(before);
    const after = (await db.execute(sql`SELECT count(*)::int AS n FROM watchers`)) as unknown as Row[];
    expect(after[0]?.n).toBe(count[0]?.n);
    const policies = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_policies
      WHERE tablename IN ('watchers', 'watcher_price_points', 'watcher_alerts') AND policyname = 'paperclip_company_scope'
    `)) as unknown as Row[];
    expect(policies[0]?.n).toBe(3);
  });

  it("is registered in the journal after 0180 with a strictly greater timestamp", () => {
    const journal = JSON.parse(readFileSync(fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const position = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
    expect(position).toBeGreaterThan(0);
    const mine = journal.entries[position]!;
    const previous = journal.entries[position - 1]!;
    expect(mine).toMatchObject({ idx: 181 });
    expect(previous.tag).toBe("0180_agent_memories");
    expect(mine.when).toBeGreaterThan(previous.when);
    expect(mine.when).toBeGreaterThan(1787160490000);
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
