import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0260_code_render_jobs (Media Studio D14) applies on the
 * embedded-Postgres path (every migration, in journal order), creates the
 * company-scoped code_render_jobs table with row-level security, keeps the
 * job history when a task, agent or saved file goes away, is safe to run
 * twice, and rolls back by dropping the one table.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0260 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0260_code_render_jobs";
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
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0260-code-renders-");
    db = createDb(tempDb.connectionString);
    companyA = randomUUID();
    companyB = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyA}, 'Renders A', 'CRA')`);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyB}, 'Renders B', 'CRB')`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }

  async function insertJob(companyId: string, title = "Job", issueId: string | null = null): Promise<string> {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO code_render_jobs (id, company_id, kind, title, issue_id) VALUES (${id}, ${companyId}, 'render', ${title}, ${issueId})`);
    return id;
  }

  it("creates the table with the documented defaults", async () => {
    const id = await insertJob(companyA);
    const [row] = await rows(sql`SELECT status, requested_seconds, options, worker_job_id, result_file_id FROM code_render_jobs WHERE id = ${id}`);
    expect(row).toEqual({ status: "queued", requested_seconds: 0, options: {}, worker_job_id: null, result_file_id: null });
  });

  it("enables row-level security with the company policy", async () => {
    const [policed] = await rows(sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'code_render_jobs' AND relkind = 'r'`);
    expect(policed?.relrowsecurity).toBe(true);
    const policies = await rows(sql`SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 'paperclip_company_scope' AND tablename = 'code_render_jobs'`);
    expect(policies[0]!.n).toBe(1);
  });

  it("lets a company-scoped login see and write only its own company's jobs", async () => {
    const a = await insertJob(companyA, "A render");
    const b = await insertJob(companyB, "B render");
    const scoped = postgres(tempDb!.connectionString, { max: 1, onnotice: () => {} });
    try {
      await scoped`SET ROLE paperclip_app_scoped`;
      await scoped`SELECT set_config('app.current_company_id', ${companyA}, false)`;
      const visible = await scoped<{ id: string }[]>`SELECT id FROM code_render_jobs`;
      expect(visible.map((r) => r.id)).toContain(a);
      expect(visible.map((r) => r.id)).not.toContain(b);
      await expect(scoped`INSERT INTO code_render_jobs (company_id, kind, title) VALUES (${companyB}, 'render', 'planted')`).rejects.toThrow(/row-level security/);
      expect(await scoped`UPDATE code_render_jobs SET title = 'pwn' WHERE id = ${b} RETURNING id`).toHaveLength(0);
      await scoped`SELECT set_config('app.current_company_id', '', false)`;
      expect(await scoped`SELECT id FROM code_render_jobs`).toHaveLength(0);
    } finally {
      await scoped.end();
    }
  });

  it("keeps the job when its task goes away, and removes it with its company", async () => {
    const issueId = randomUUID();
    await db.execute(sql`INSERT INTO issues (id, company_id, title, status) VALUES (${issueId}, ${companyA}, 'Explainer', 'todo')`);
    const job = await insertJob(companyA, "Attached", issueId);
    await db.execute(sql`DELETE FROM issues WHERE id = ${issueId}`);
    const [row] = await rows(sql`SELECT issue_id FROM code_render_jobs WHERE id = ${job}`);
    expect(row!.issue_id).toBeNull();

    const gone = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${gone}, 'Gone', 'CRG')`);
    await insertJob(gone, "Bye");
    await db.execute(sql`DELETE FROM companies WHERE id = ${gone}`);
    const [count] = await rows(sql`SELECT count(*)::int AS n FROM code_render_jobs WHERE company_id = ${gone}`);
    expect(count!.n).toBe(0);
  });

  it("is idempotent: a further run changes no row and keeps each index and policy once", async () => {
    const before = await rows(sql`SELECT id, title FROM code_render_jobs ORDER BY id`);
    for (const statement of migrationStatements()) {
      await db.execute(sql.raw(statement));
    }
    expect(await rows(sql`SELECT id, title FROM code_render_jobs ORDER BY id`)).toEqual(before);
    const policies = await rows(sql`SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 'paperclip_company_scope' AND tablename = 'code_render_jobs'`);
    expect(policies[0]!.n).toBe(1);
    const indexes = await rows(sql`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'code_render_jobs' AND indexname LIKE 'code_render_jobs_%_idx'`);
    expect(indexes[0]!.n).toBe(4);
  });

  it("rolls back by dropping the one table, leaving other tables alone", async () => {
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`DROP TABLE "code_render_jobs"`);
        const [left] = (await tx.execute(
          sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'code_render_jobs'`,
        )) as unknown as Row[];
        expect(left!.n).toBe(0);
        const [companies] = (await tx.execute(sql`SELECT count(*)::int AS n FROM companies`)) as unknown as Row[];
        expect(companies!.n).toBe(2);
        throw new Error("rollback");
      })
      .catch((error: Error) => expect(error.message).toBe("rollback"));
  });
});
