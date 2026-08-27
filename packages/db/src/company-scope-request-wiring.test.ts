import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDb } from "./client.js";
import {
  createRequestScopedDb,
  requestCompanyScopeStorage,
  runInCompanyScope,
  runInCompanyScopeBypass,
} from "./company-scope.js";
import { companies, crossCompanyAccessLog } from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// DUR-269: proves the reserved-connection/AsyncLocalStorage/Proxy mechanism
// reviewed and accepted on DUR-275 actually behaves the way the design
// review's 4 required modifications describe -- fail-loud on a lost async
// context, no claim bleed across a released connection's next use, generic
// (not enumerated) property forwarding including the nested `.query`
// builder, and a real role-membership check + audit log for the bypass
// path. See company-scope.ts's module comment above runInCompanyScope for
// the full design writeup.
describeEmbeddedPostgres("DUR-269: request-scoped db wiring (Proxy/ALS/reserved connection)", () => {
  let db!: Db;
  let connectionString!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-request-scoped-wiring-");
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(crossCompanyAccessLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** A single-connection db, so reserve()/release() is provably the same physical connection every time. */
  function createSingleConnectionDb(): Db {
    const sql = postgres(connectionString, { max: 1 });
    return drizzlePg(sql, {}) as unknown as Db;
  }

  async function seedCompany(label: string) {
    return db
      .insert(companies)
      .values({
        name: `DUR-269 ${label}`,
        issuePrefix: `RSW${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("createRequestScopedDb throws instead of falling back to the raw pooled db when no scope is active", () => {
    const proxied = createRequestScopedDb(db);
    expect(requestCompanyScopeStorage.getStore()).toBeUndefined();
    // Property reads trigger the get trap synchronously.
    expect(() => proxied.select).toThrow(/AsyncLocalStorage-tracked/);
  });

  it("runInCompanyScope sets the session claim and createRequestScopedDb resolves reads through it", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const proxied = createRequestScopedDb(db);

    const seenNames = await runInCompanyScope(db, companyA.id, async () => {
      // raw claim check via drizzle's sql template, forwarded through the
      // proxy to prove .execute is generically forwarded too, not just select/insert.
      const claim = await proxied.execute(drizzleSql`select current_setting('app.current_company_id', true) as claim`);
      expect((claim as unknown as { claim: string }[])[0]?.claim).toBe(companyA.id);

      const rows = await proxied.select({ name: companies.name }).from(companies).where(eq(companies.id, companyA.id));
      return rows.map((r) => r.name);
    });

    expect(seenNames).toEqual([`DUR-269 A`]);
    void companyB; // seeded only to prove isolation is exercised elsewhere (RLS itself is covered by rls-company-isolation.test.ts)
  });

  it("createRequestScopedDb deep-proxies db.query.<table> nested builders, not just top-level methods", async () => {
    const companyA = await seedCompany("A");
    const proxied = createRequestScopedDb(db);

    const found = await runInCompanyScope(db, companyA.id, async () => {
      return proxied.query.companies.findFirst({ where: eq(companies.id, companyA.id) });
    });

    expect(found?.id).toBe(companyA.id);
  });

  it("resets the session claim before releasing a reserved connection back to the pool -- no bleed across reuse", async () => {
    const singleConnDb = createSingleConnectionDb();
    const companyA = await seedCompany("A");

    await runInCompanyScope(singleConnDb, companyA.id, async () => {
      // no-op: just establishing + releasing the scope
    });

    // Reserve again on the SAME (max: 1) pool -- if the prior release didn't
    // reset the claim, this reserved connection would still carry company A's
    // claim even though nothing in this test set it.
    const reserved = await singleConnDb.$client.reserve();
    try {
      const rows = await reserved`select current_setting('app.current_company_id', true) as claim`;
      expect(rows[0]?.claim ?? "").toBe("");
    } finally {
      reserved.release();
      await singleConnDb.$client.end();
    }
  });

  it("runInCompanyScopeBypass throws when the connection's role is not a member of paperclip_app_bypass", async () => {
    // pg_has_role() always returns true for the migration-running superuser
    // regardless of actual grants, so the negative case has to run as a real
    // non-superuser role -- paperclip_app_scoped (created by migration 0148)
    // is never granted paperclip_app_bypass, by design.
    const sql = postgres(connectionString, { max: 1 });
    await sql.unsafe("SET ROLE paperclip_app_scoped");
    const scopedRoleDb = drizzlePg(sql, {}) as unknown as Db;

    try {
      await expect(
        runInCompanyScopeBypass(scopedRoleDb, { reason: "test: no bypass membership" }, async () => "unreachable"),
      ).rejects.toThrow(/not a member of paperclip_app_bypass/);
    } finally {
      await sql.end();
    }
  });

  it("runInCompanyScopeBypass succeeds once granted membership, and logs once to cross_company_access_log", async () => {
    const grantSql = postgres(connectionString, { max: 1 });
    try {
      await grantSql.unsafe("GRANT paperclip_app_bypass TO CURRENT_USER");
    } finally {
      await grantSql.end();
    }

    try {
      const proxied = createRequestScopedDb(db);
      const result = await runInCompanyScopeBypass(
        db,
        { reason: "DUR-269 test: bypass mechanism", actorType: "test", route: "/test" },
        async () => proxied.select({ id: companies.id }).from(companies),
      );
      expect(Array.isArray(result)).toBe(true);

      const logRows = await db.select().from(crossCompanyAccessLog).where(eq(crossCompanyAccessLog.reason, "DUR-269 test: bypass mechanism"));
      expect(logRows).toHaveLength(1);
      expect(logRows[0]?.actorType).toBe("test");
    } finally {
      const revokeSql = postgres(connectionString, { max: 1 });
      try {
        await revokeSql.unsafe("REVOKE paperclip_app_bypass FROM CURRENT_USER");
      } finally {
        await revokeSql.end();
      }
    }
  });
});
