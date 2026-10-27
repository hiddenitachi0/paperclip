import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0257_legal_contract_reminders (DUR-4855): issues.due_date,
 * contract_deadlines.needs_owner, the partial unique index that keeps one open
 * reminder issue per deadline step, and the company-scoped contract_settings
 * table. Applies on the embedded-Postgres path, is safe to run twice (and does
 * not flip a needs_owner a person changed), polices contract_settings by
 * company, and rolls back by dropping what it added.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0257 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0257_legal_contract_reminders";
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
  let companyA = "";
  let companyB = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0257-reminders-");
    db = createDb(tempDb.connectionString);
    companyA = randomUUID();
    companyB = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyA}, 'Reminders A', 'RMA')`);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyB}, 'Reminders B', 'RMB')`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }

  async function insertIssue(companyId: string, fields: { originId: string; fingerprint: string; status?: string }) {
    await db.execute(
      sql`INSERT INTO issues (company_id, title, status, origin_kind, origin_id, origin_fingerprint) VALUES (${companyId}, 'Contract deadline', ${fields.status ?? "todo"}, 'contract_deadline', ${fields.originId}, ${fields.fingerprint})`,
    );
  }

  it("adds the nullable due date and the needs-owner flag with their defaults", async () => {
    await db.execute(sql`INSERT INTO issues (company_id, title) VALUES (${companyA}, 'Plain issue')`);
    const [issue] = await rows(sql`SELECT due_date FROM issues WHERE company_id = ${companyA} AND title = 'Plain issue'`);
    expect(issue.due_date).toBeNull();
    await db.execute(sql`UPDATE issues SET due_date = '2027-01-31' WHERE company_id = ${companyA} AND title = 'Plain issue'`);
    const [dated] = await rows(sql`SELECT due_date::text AS due_date FROM issues WHERE company_id = ${companyA} AND title = 'Plain issue'`);
    expect(dated.due_date).toBe("2027-01-31");

    const contractId = randomUUID();
    await db.execute(sql`INSERT INTO contracts (id, company_id, title, type) VALUES (${contractId}, ${companyA}, 'C', 'nda')`);
    await db.execute(
      sql`INSERT INTO contract_deadlines (company_id, contract_id, kind, due_date, lead_times_days) VALUES (${companyA}, ${contractId}, 'payment', '2027-03-01', ARRAY[30])`,
    );
    const [deadline] = await rows(sql`SELECT needs_owner FROM contract_deadlines WHERE contract_id = ${contractId}`);
    expect(deadline.needs_owner).toBe(false);
  });

  it("allows one open reminder issue per deadline step, but a new one once it is closed", async () => {
    const deadline = randomUUID();
    await insertIssue(companyA, { originId: deadline, fingerprint: `${deadline}:30` });
    await expect(insertIssue(companyA, { originId: deadline, fingerprint: `${deadline}:30` })).rejects.toThrow();
    await insertIssue(companyA, { originId: deadline, fingerprint: `${deadline}:7` });
    await db.execute(sql`UPDATE issues SET status = 'cancelled' WHERE origin_id = ${deadline} AND origin_fingerprint = ${`${deadline}:30`}`);
    await insertIssue(companyA, { originId: deadline, fingerprint: `${deadline}:30` });
    // Other origin kinds are not constrained by this index.
    await db.execute(sql`INSERT INTO issues (company_id, title, origin_kind, origin_id, origin_fingerprint) VALUES (${companyA}, 'x', 'manual', ${deadline}, ${`${deadline}:30`})`);
  });

  it("polices contract_settings by company and keeps one row per company", async () => {
    const [flags] = await rows(sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'contract_settings' AND relkind = 'r'`);
    expect(flags.relrowsecurity).toBe(true);
    const [policy] = await rows(sql`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'contract_settings' AND policyname = 'paperclip_company_scope'`);
    expect(policy.n).toBe(1);

    await db.execute(sql`INSERT INTO contract_settings (company_id, notice_lead_times_days) VALUES (${companyA}, ARRAY[90, 14])`);
    await db.execute(sql`INSERT INTO contract_settings (company_id, other_lead_times_days) VALUES (${companyB}, ARRAY[5])`);
    await expect(
      db.execute(sql`INSERT INTO contract_settings (company_id) VALUES (${companyA})`),
    ).rejects.toThrow();

    const scoped = postgres(tempDb!.connectionString, { max: 1, onnotice: () => {} });
    try {
      await scoped`SET ROLE paperclip_app_scoped`;
      await scoped`SELECT set_config('app.current_company_id', ${companyA}, false)`;
      const visible = await scoped<{ company_id: string }[]>`SELECT company_id FROM contract_settings`;
      expect(visible.map((r) => r.company_id)).toEqual([companyA]);
      await expect(
        scoped`INSERT INTO contract_settings (company_id) VALUES (${randomUUID()})`,
      ).rejects.toThrow(/row-level security|violates/);
      expect(await scoped`UPDATE contract_settings SET other_lead_times_days = ARRAY[1] WHERE company_id = ${companyB} RETURNING id`).toHaveLength(0);
    } finally {
      await scoped.end();
    }
  });

  it("is idempotent and does not flip a needs_owner a person changed", async () => {
    const contractId = randomUUID();
    await db.execute(sql`INSERT INTO contracts (id, company_id, title, type) VALUES (${contractId}, ${companyB}, 'C2', 'nda')`);
    await db.execute(
      sql`INSERT INTO contract_deadlines (company_id, contract_id, kind, due_date, lead_times_days, needs_owner) VALUES (${companyB}, ${contractId}, 'notice_extend', '2027-03-01', ARRAY[60], false)`,
    );
    for (const statement of migrationStatements()) {
      await db.execute(sql.raw(statement));
    }
    const [row] = await rows(sql`SELECT needs_owner FROM contract_deadlines WHERE contract_id = ${contractId}`);
    expect(row.needs_owner).toBe(false);
    const [indexes] = await rows(sql`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'issues_active_contract_deadline_reminder_uq'`);
    expect(indexes.n).toBe(1);
    const [policies] = await rows(sql`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'contract_settings'`);
    expect(policies.n).toBe(1);
  });

  it("rolls back by dropping what it added, leaving the rest alone", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`DROP TABLE "contract_settings"`);
      await tx.execute(sql`DROP INDEX "issues_active_contract_deadline_reminder_uq"`);
      await tx.execute(sql`ALTER TABLE "contract_deadlines" DROP COLUMN "needs_owner"`);
      await tx.execute(sql`ALTER TABLE "issues" DROP COLUMN "due_date"`);
      const [left] = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'issues' AND column_name = 'due_date') OR (table_name = 'contract_deadlines' AND column_name = 'needs_owner'))`,
      )) as unknown as Row[];
      expect(left.n).toBe(0);
      const [kept] = (await tx.execute(sql`SELECT count(*)::int AS n FROM contract_deadlines`)) as unknown as Row[];
      expect(kept.n).toBeGreaterThan(0);
      throw new Error("rollback");
    }).catch((error: Error) => expect(error.message).toBe("rollback"));
    const [present] = await rows(sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'issues' AND column_name = 'due_date'`);
    expect(present.n).toBe(1);
  });
});
