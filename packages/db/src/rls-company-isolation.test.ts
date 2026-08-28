import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
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

// DUR-247: proves the Row-Level Security policies added in migration 0149
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
  async function openScopedConnection(claims: { companyId?: string }) {
    const sql = postgres(connectionString, { max: 1 });
    await sql`SET ROLE paperclip_app_scoped`;
    if (claims.companyId) {
      await sql`select set_config('app.current_company_id', ${claims.companyId}, false)`;
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

  it("a plain paperclip_app_scoped connection cannot self-grant the bypass via the old session-GUC path", async () => {
    // This is the exact mechanism a prior revision of this migration used
    // (`current_setting('app.rls_bypass', true) = 'true'`) and it was a real
    // hole: any SQL statement on this connection -- including one reached
    // via an unrelated SQL-injection-shaped bug -- could set this GUC on
    // itself with zero privilege check. Setting it must now be a complete
    // no-op: the policy no longer reads this GUC at all.
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedIssue(companyA.id, `${companyA.issuePrefix}-1`);
    await seedIssue(companyB.id, `${companyB.issuePrefix}-1`);

    const scoped = await openScopedConnection({ companyId: companyA.id });
    try {
      await scoped`select set_config('app.rls_bypass', 'true', false)`;
      const rows = await scoped`SELECT id FROM issues`;
      expect(rows).toHaveLength(1);
    } finally {
      await scoped.end();
    }
  });

  it("paperclip_app_scoped is never a member of the paperclip_app_bypass escape hatch", async () => {
    // The RLS bypass is now keyed off Postgres role membership
    // (pg_has_role), not a session claim -- see migration 0149's header
    // comment. This is the security-critical invariant that makes the
    // bypass non-self-grantable: it must be asserted directly against the
    // role catalog, because unlike a GUC, no SQL executed on a
    // paperclip_app_scoped connection can ever make this true.
    const rows = (await db.execute(
      sql`SELECT pg_has_role('paperclip_app_scoped', 'paperclip_app_bypass', 'member') AS has_bypass`,
    )) as unknown as { has_bypass: boolean }[];
    expect(rows[0]?.has_bypass).toBe(false);
  });

  it("a role granted paperclip_app_bypass membership genuinely bypasses company scoping", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedIssue(companyA.id, `${companyA.issuePrefix}-1`);
    await seedIssue(companyB.id, `${companyB.issuePrefix}-1`);

    const setupSql = postgres(connectionString, { max: 1 });
    try {
      // Membership in paperclip_app_scoped supplies the ordinary table
      // GRANTs (SELECT/INSERT/UPDATE/DELETE); membership in
      // paperclip_app_bypass is what satisfies the RLS policy's bypass
      // check. Both are needed -- RLS and table-level GRANTs are
      // independent gates in Postgres.
      await setupSql.unsafe(
        "CREATE ROLE paperclip_test_bypass_holder NOLOGIN IN ROLE paperclip_app_scoped, paperclip_app_bypass",
      );
    } finally {
      await setupSql.end();
    }

    try {
      const bypassed = postgres(connectionString, { max: 1 });
      try {
        await bypassed`SET ROLE paperclip_test_bypass_holder`;
        const rows = await bypassed`SELECT id FROM issues`;
        expect(rows).toHaveLength(2);
      } finally {
        await bypassed.end();
      }
    } finally {
      const cleanupSql = postgres(connectionString, { max: 1 });
      try {
        await cleanupSql.unsafe("DROP ROLE IF EXISTS paperclip_test_bypass_holder");
      } finally {
        await cleanupSql.end();
      }
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

  it("migration 0151's guard blocks the bypass grant for a non-superuser role that is only an INDIRECT member of paperclip_app_scoped", async () => {
    // DUR-275 follow-up (Security Reviewer 2's should-fix): the guard must
    // catch real Postgres role membership, not just an exact `CURRENT_USER
    // = 'paperclip_app_scoped'` name match -- e.g. a future login role that
    // joins paperclip_app_scoped as a group role without being named that
    // literally. This replays the migration's exact DO block against a
    // fresh, non-superuser role in that shape and asserts it still refuses.
    const migrationPath = new URL("./migrations/0151_guarded_bypass_role_grant.sql", import.meta.url);
    const migrationSql = await readFile(migrationPath, "utf8");

    const setupSql = postgres(connectionString, { max: 1 });
    try {
      await setupSql.unsafe(
        "CREATE ROLE paperclip_test_indirect_scoped_member NOLOGIN NOSUPERUSER IN ROLE paperclip_app_scoped",
      );
    } finally {
      await setupSql.end();
    }

    try {
      // SET ROLE (not a separate login) -- same pattern as
      // openScopedConnection above: the superuser connection switches its
      // effective role, so CURRENT_USER inside the migration DO block is the
      // indirect member, not the superuser.
      const asIndirectMember = postgres(connectionString, { max: 1 });
      try {
        await asIndirectMember`SET ROLE paperclip_test_indirect_scoped_member`;
        await expect(asIndirectMember.unsafe(migrationSql)).rejects.toThrow(
          /refusing to grant paperclip_app_bypass to a role that holds paperclip_app_scoped membership/,
        );
      } finally {
        await asIndirectMember.end();
      }
    } finally {
      const cleanupSql = postgres(connectionString, { max: 1 });
      try {
        await cleanupSql.unsafe("DROP ROLE IF EXISTS paperclip_test_indirect_scoped_member");
      } finally {
        await cleanupSql.end();
      }
    }
  });
});
