import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0256_legal_contract_register (DUR-4852) applies on the
 * embedded-Postgres path (every migration, in journal order), creates the five
 * company-scoped contract tables with row-level security, the version-chain,
 * reminder and term uniqueness the services rely on, is safe to run twice, and
 * can be rolled back by dropping the five tables in the documented order
 * without touching any other table.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0256 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0256_legal_contract_register";
const MIGRATION_PATH = fileURLToPath(new URL(`./migrations/${MIGRATION_TAG}.sql`, import.meta.url));
const TABLES = ["contracts", "contract_parties", "contract_deadlines", "contract_deadline_reminders", "contract_terms"];

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
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0256-contracts-");
    db = createDb(tempDb.connectionString);
    companyA = randomUUID();
    companyB = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyA}, 'Contracts A', 'CTA')`);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyB}, 'Contracts B', 'CTB')`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertContract(companyId: string, title = "Contract", supersedes: string | null = null): Promise<string> {
    const id = randomUUID();
    await db.execute(
      sql`INSERT INTO contracts (id, company_id, title, type, supersedes_contract_id) VALUES (${id}, ${companyId}, ${title}, 'nda', ${supersedes})`,
    );
    return id;
  }

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }

  it("creates the five tables with the documented defaults", async () => {
    const found = await rows(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('contracts','contract_parties','contract_deadlines','contract_deadline_reminders','contract_terms')`);
    expect(found.map((r) => r.table_name).sort()).toEqual([...TABLES].sort());
    const id = await insertContract(companyA);
    const [row] = await rows(sql`SELECT status, text_status, version_no, supersedes_contract_id FROM contracts WHERE id = ${id}`);
    expect(row).toEqual({ status: "draft", text_status: "pending", version_no: 1, supersedes_contract_id: null });
  });

  it("enables row-level security with a company policy on every table", async () => {
    const policed = await rows(sql`SELECT c.relname, c.relrowsecurity FROM pg_class c WHERE c.relname IN ('contracts','contract_parties','contract_deadlines','contract_deadline_reminders','contract_terms') AND c.relkind = 'r'`);
    expect(policed).toHaveLength(5);
    expect(policed.every((r) => r.relrowsecurity === true)).toBe(true);
    const policies = await rows(sql`SELECT tablename FROM pg_policies WHERE policyname = 'paperclip_company_scope' AND tablename IN ('contracts','contract_parties','contract_deadlines','contract_deadline_reminders','contract_terms')`);
    expect(policies.map((r) => r.tablename).sort()).toEqual([...TABLES].sort());
  });

  it("lets a company-scoped login see and write only its own company's rows", async () => {
    const [role] = await rows(sql`SELECT 1 AS present FROM pg_roles WHERE rolname = 'paperclip_app_scoped'`);
    expect(role?.present).toBe(1);
    const a = await insertContract(companyA, "A secret");
    const b = await insertContract(companyB, "B secret");

    const scoped = postgres(tempDb!.connectionString, { max: 1, onnotice: () => {} });
    try {
      await scoped`SET ROLE paperclip_app_scoped`;
      await scoped`SELECT set_config('app.current_company_id', ${companyA}, false)`;
      const visible = await scoped<{ id: string }[]>`SELECT id FROM contracts`;
      expect(visible.map((r) => r.id)).toContain(a);
      expect(visible.map((r) => r.id)).not.toContain(b);
      await expect(
        scoped`INSERT INTO contracts (company_id, title, type) VALUES (${companyB}, 'planted', 'nda')`,
      ).rejects.toThrow(/row-level security/);
      const updated = await scoped`UPDATE contracts SET title = 'pwn' WHERE id = ${b} RETURNING id`;
      expect(updated).toHaveLength(0);
      const deleted = await scoped`DELETE FROM contracts WHERE id = ${b} RETURNING id`;
      expect(deleted).toHaveLength(0);
      // No claim at all: nothing is visible.
      await scoped`SELECT set_config('app.current_company_id', '', false)`;
      expect(await scoped`SELECT id FROM contracts`).toHaveLength(0);
    } finally {
      await scoped.end();
    }
    const [untouched] = await rows(sql`SELECT title FROM contracts WHERE id = ${b}`);
    expect(untouched.title).toBe("B secret");
  });

  it("keeps a version chain a line: at most one successor per contract", async () => {
    const v1 = await insertContract(companyA, "v1");
    await insertContract(companyA, "v2", v1);
    await expect(insertContract(companyA, "v2-fork", v1)).rejects.toThrow();
    // Contracts with no predecessor are unconstrained.
    await insertContract(companyA, "free 1");
    await insertContract(companyA, "free 2");
  });

  it("makes reminders unique per (deadline, lead step) and terms unique per (contract, key)", async () => {
    const contractId = await insertContract(companyA);
    const deadlineId = randomUUID();
    await db.execute(
      sql`INSERT INTO contract_deadlines (id, company_id, contract_id, kind, due_date, lead_times_days) VALUES (${deadlineId}, ${companyA}, ${contractId}, 'notice_terminate', '2027-03-01', ARRAY[60,30,7])`,
    );
    await db.execute(sql`INSERT INTO contract_deadline_reminders (company_id, deadline_id, lead_days) VALUES (${companyA}, ${deadlineId}, 60)`);
    await db.execute(sql`INSERT INTO contract_deadline_reminders (company_id, deadline_id, lead_days) VALUES (${companyA}, ${deadlineId}, 30)`);
    await expect(
      db.execute(sql`INSERT INTO contract_deadline_reminders (company_id, deadline_id, lead_days) VALUES (${companyA}, ${deadlineId}, 60)`),
    ).rejects.toThrow();

    await db.execute(sql`INSERT INTO contract_terms (company_id, contract_id, key, value_kind, number_value) VALUES (${companyA}, ${contractId}, 'liability_cap', 'number', 100)`);
    await expect(
      db.execute(sql`INSERT INTO contract_terms (company_id, contract_id, key, value_kind) VALUES (${companyA}, ${contractId}, 'liability_cap', 'not_mentioned')`),
    ).rejects.toThrow();
  });

  it("removes a contract's parties, deadlines, reminders and terms with it", async () => {
    const contractId = await insertContract(companyB);
    const deadlineId = randomUUID();
    await db.execute(sql`INSERT INTO contract_parties (company_id, contract_id, role, name) VALUES (${companyB}, ${contractId}, 'vendor', 'Acme')`);
    await db.execute(
      sql`INSERT INTO contract_deadlines (id, company_id, contract_id, kind, due_date, lead_times_days) VALUES (${deadlineId}, ${companyB}, ${contractId}, 'expiry', '2027-01-01', ARRAY[30,7])`,
    );
    await db.execute(sql`INSERT INTO contract_deadline_reminders (company_id, deadline_id, lead_days) VALUES (${companyB}, ${deadlineId}, 30)`);
    await db.execute(sql`INSERT INTO contract_terms (company_id, contract_id, key, value_kind) VALUES (${companyB}, ${contractId}, 'liability_cap', 'not_mentioned')`);
    await db.execute(sql`DELETE FROM contracts WHERE id = ${contractId}`);
    for (const table of ["contract_parties", "contract_deadlines", "contract_deadline_reminders", "contract_terms"]) {
      const [count] = await rows(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE company_id = ${companyB}`);
      expect(count.n).toBe(0);
    }
  });

  it("is idempotent: a further run changes no row and keeps each index and policy once", async () => {
    const before = await rows(sql`SELECT id, title FROM contracts ORDER BY id`);
    for (const statement of migrationStatements()) {
      await db.execute(sql.raw(statement));
    }
    const after = await rows(sql`SELECT id, title FROM contracts ORDER BY id`);
    expect(after).toEqual(before);
    const policies = await rows(sql`SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 'paperclip_company_scope' AND tablename = 'contracts'`);
    expect(policies[0].n).toBe(1);
    const uq = await rows(sql`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'contracts_supersedes_uq'`);
    expect(uq[0].n).toBe(1);
  });

  it("rolls back by dropping the five tables in the documented order, leaving other tables alone", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`DROP TABLE "contract_deadline_reminders", "contract_terms", "contract_parties", "contract_deadlines", "contracts"`);
      const left = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'contract%'`,
      )) as unknown as Row[];
      expect(left[0].n).toBe(0);
      const [companies] = (await tx.execute(sql`SELECT count(*)::int AS n FROM companies`)) as unknown as Row[];
      expect(companies.n).toBe(2);
      // Roll the drop back so the remaining assertions in this file still see the tables.
      throw new Error("rollback");
    }).catch((error: Error) => expect(error.message).toBe("rollback"));
    const [present] = await rows(sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'contracts'`);
    expect(present.n).toBe(1);
  });
});
