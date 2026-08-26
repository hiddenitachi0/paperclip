import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDb } from "./client.js";
import { companies, issues } from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// DUR-247: proves the Row-Level Security policies added in migration 0148
// actually hold against a real Postgres instance, connecting directly to the
// database (never through the app's Express routes/API) as the
// `paperclip_app_scoped` role -- the same shape of connection a leaked
// DATABASE_URL or a stray script would make. See that migration's header
// comment for why enforcement is proven against this dedicated non-owner
// role rather than the app's own (table-owning) runtime role in this first
// phase.
describeEmbeddedPostgres("DUR-247: RLS company_id isolation (paperclip_app_scoped)", () => {
  let db!: Db;
  let connectionString!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-rls-company-isolation-");
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(label: string) {
    return db
      .insert(companies)
      .values({
        name: `DUR-247 ${label}`,
        issuePrefix: `RLS${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedIssue(companyId: string, identifier: string) {
    return db
      .insert(issues)
      .values({ companyId, identifier, title: `issue for ${companyId}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  /** Opens a fresh, disposable connection as the scoped role -- exactly what a raw `psql "$DATABASE_URL"` session run by that role would do. */
  async function openScopedConnection(claims: { companyId?: string; bypass?: boolean }) {
    const sql = postgres(connectionString, { max: 1 });
    await sql`SET ROLE paperclip_app_scoped`;
    if (claims.companyId) {
      await sql`select set_config('app.current_company_id', ${claims.companyId}, false)`;
    }
    if (claims.bypass) {
      await sql`select set_config('app.rls_bypass', 'true', false)`;
    }
    return sql;
  }

  it("a connection scoped to company A reads zero rows of company B's data", async () => {
    const companyA = await seedCompany("A (Durkan)");
    const companyB = await seedCompany("B (Nordstrand)");
    await seedIssue(companyA.id, `${companyA.issuePrefix}-1`);
    await seedIssue(companyB.id, `${companyB.issuePrefix}-1`);

    const asCompanyA = await openScopedConnection({ companyId: companyA.id });
    try {
      const rows = await asCompanyA`SELECT id, company_id FROM issues ORDER BY identifier`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.company_id).toBe(companyA.id);
    } finally {
      await asCompanyA.end();
    }
  });

  it("a raw connection with no claim set at all -- the exact DUR-244 shape -- reads zero rows from any company", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedIssue(companyA.id, `${companyA.issuePrefix}-1`);
    await seedIssue(companyB.id, `${companyB.issuePrefix}-1`);

    const unscoped = await openScopedConnection({});
    try {
      const rows = await unscoped`SELECT id FROM issues`;
      expect(rows).toHaveLength(0);
    } finally {
      await unscoped.end();
    }
  });

  it("an explicit cross-company WHERE filter cannot be used to read another company's row under a single-company claim", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedIssue(companyB.id, `${companyB.issuePrefix}-1`);

    const asCompanyA = await openScopedConnection({ companyId: companyA.id });
    try {
      const rows = await asCompanyA`SELECT id FROM issues WHERE company_id = ${companyB.id}`;
      expect(rows).toHaveLength(0);
    } finally {
      await asCompanyA.end();
    }
  });

  it("rejects an INSERT tagged with another company's id under a mismatched claim", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");

    const asCompanyA = await openScopedConnection({ companyId: companyA.id });
    try {
      await expect(
        asCompanyA`INSERT INTO issues (id, company_id, title) VALUES (${randomUUID()}, ${companyB.id}, 'cross-company write attempt')`,
      ).rejects.toThrow();
    } finally {
      await asCompanyA.end();
    }
  });

  it("app.rls_bypass is a real, explicit escape hatch across companies (for the trusted first-party paths that need it)", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedIssue(companyA.id, `${companyA.issuePrefix}-1`);
    await seedIssue(companyB.id, `${companyB.issuePrefix}-1`);

    const bypassed = await openScopedConnection({ bypass: true });
    try {
      const rows = await bypassed`SELECT id FROM issues`;
      expect(rows).toHaveLength(2);
    } finally {
      await bypassed.end();
    }
  });

  it("Phase 1 does not change the app's own owner-role connection: createDb() still sees every company, unaffected", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedIssue(companyA.id, `${companyA.issuePrefix}-1`);
    await seedIssue(companyB.id, `${companyB.issuePrefix}-1`);

    const rows = await db.select().from(issues);
    expect(rows).toHaveLength(2);
  });
});
