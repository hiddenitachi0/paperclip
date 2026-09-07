import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { createDb } from "./client.js";
import {
  createRequestScopedDb,
  runInCompanyScope,
  runInCompanyScopeBypass,
  setCompanyScopeBypassPool,
  withCompanyScopeBypass,
} from "./company-scope.js";
import { companies, crossCompanyAccessLog, issues, pipelineStages, pipelines } from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const SCOPED_LOGIN = "paperclip_app_scoped_login";
const BYPASS_LOGIN = "paperclip_app_bypass_login";
const TEST_PASSWORD = "dur3945-test-only";

// DUR-3945 (DUR-244 item 3): proves migration 0161's two LOGIN roles behave
// the way docs/rls-cutover-runbook.md promises -- by actually logging in as
// them over the wire with a password (set here the same way the runbook has
// the operator set it), not just SET ROLE from the superuser. Everything the
// app does after the cutover goes through exactly these connections.
describeEmbeddedPostgres("DUR-3945: RLS login roles (migration 0161)", () => {
  let db!: Db;
  let connectionString!: string;
  let scopedUrl!: string;
  let bypassUrl!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-rls-login-roles-");
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
    // The runbook's first manual step: give the passwordless roles a password.
    await db.execute(sql.raw(`ALTER ROLE ${SCOPED_LOGIN} PASSWORD '${TEST_PASSWORD}'`));
    await db.execute(sql.raw(`ALTER ROLE ${BYPASS_LOGIN} PASSWORD '${TEST_PASSWORD}'`));
    const asUser = (user: string) => {
      const url = new URL(connectionString);
      url.username = user;
      url.password = TEST_PASSWORD;
      return url.toString();
    };
    scopedUrl = asUser(SCOPED_LOGIN);
    bypassUrl = asUser(BYPASS_LOGIN);
  }, 30_000);

  afterEach(async () => {
    setCompanyScopeBypassPool(null);
    await db.delete(crossCompanyAccessLog);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    setCompanyScopeBypassPool(null);
    await tempDb?.cleanup();
  });

  async function seedCompany(label: string) {
    return db
      .insert(companies)
      .values({
        name: `DUR-3945 ${label}`,
        issuePrefix: `LR${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
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

  async function seedPipelineWithStage(companyId: string, key: string) {
    const [pipeline] = await db.insert(pipelines).values({ companyId, key, name: key }).returning();
    await db.insert(pipelineStages).values({
      pipelineId: pipeline!.id,
      key: `${key}-stage`,
      name: `${key} stage`,
      kind: "working",
      position: 0,
    });
    return pipeline!;
  }

  // drizzle wraps the driver error as "Failed query: ..." and keeps Postgres's
  // own message on `cause`.
  async function expectPostgresError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const cause = caught instanceof Error ? (caught.cause ?? caught) : caught;
    expect(String((cause as { message?: string })?.message)).toMatch(pattern);
  }

  async function withPool<T>(url: string, fn: (pool: Db) => Promise<T>): Promise<T> {
    const pool = createDb(url, "paperclip-login-role-test");
    try {
      return await fn(pool);
    } finally {
      await pool.$client.end({ timeout: 5 });
    }
  }

  it("creates both login roles as non-superuser, non-owner, no-DDL, no-BYPASSRLS roles with disjoint memberships", async () => {
    const rows = (await db.execute(sql`
      SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolinherit,
             pg_has_role(rolname, 'paperclip_app_scoped', 'member') AS in_scoped,
             pg_has_role(rolname, 'paperclip_app_bypass', 'member') AS in_bypass
      FROM pg_roles WHERE rolname IN (${SCOPED_LOGIN}, ${BYPASS_LOGIN}) ORDER BY rolname
    `)) as unknown as Array<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolbypassrls: boolean;
      rolinherit: boolean;
      in_scoped: boolean;
      in_bypass: boolean;
    }>;
    expect(rows.map((r) => r.rolname)).toEqual([BYPASS_LOGIN, SCOPED_LOGIN]);
    for (const row of rows) {
      expect(row.rolcanlogin).toBe(true);
      expect(row.rolsuper).toBe(false);
      expect(row.rolcreaterole).toBe(false);
      expect(row.rolcreatedb).toBe(false);
      expect(row.rolbypassrls).toBe(false);
      expect(row.rolinherit).toBe(true);
    }
    const scoped = rows.find((r) => r.rolname === SCOPED_LOGIN)!;
    const bypass = rows.find((r) => r.rolname === BYPASS_LOGIN)!;
    // The 0149 SECURITY-CRITICAL INVARIANT, plus its mirror image.
    expect(scoped).toMatchObject({ in_scoped: true, in_bypass: false });
    expect(bypass).toMatchObject({ in_scoped: false, in_bypass: true });
  });

  it("ships the roles without a password so the migration alone can never open a new way in", async () => {
    // A fresh migration replay on a second database in this same cluster
    // would hit the IF NOT EXISTS guard, so check the attribute the CREATE
    // used rather than re-running it: pg_authid.rolpassword is NULL for
    // PASSWORD NULL and stays that way until an operator sets one. This
    // suite's beforeAll already set one, so assert on a scratch role created
    // with the migration's exact clause instead.
    await db.execute(sql`CREATE ROLE dur3945_passwordless_probe LOGIN PASSWORD NULL NOSUPERUSER`);
    try {
      const rows = (await db.execute(
        sql`SELECT rolpassword IS NULL AS no_password FROM pg_authid WHERE rolname = 'dur3945_passwordless_probe'`,
      )) as unknown as { no_password: boolean }[];
      expect(rows[0]?.no_password).toBe(true);
      const probe = new URL(connectionString);
      probe.username = "dur3945_passwordless_probe";
      probe.password = "anything";
      const sqlProbe = postgres(probe.toString(), { max: 1, connect_timeout: 5 });
      try {
        await expect(sqlProbe`select 1`).rejects.toThrow();
      } finally {
        await sqlProbe.end({ timeout: 1 });
      }
    } finally {
      await db.execute(sql`DROP ROLE dur3945_passwordless_probe`);
    }
  });

  it("the scoped login sees only the claimed company's rows -- through the app's own runInCompanyScope/proxy path", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedIssue(companyA.id, `${companyA.issuePrefix}-1`);
    await seedIssue(companyB.id, `${companyB.issuePrefix}-1`);

    await withPool(scopedUrl, async (scopedPool) => {
      const proxied = createRequestScopedDb(scopedPool);
      const seen = await runInCompanyScope(scopedPool, companyA.id, async () => {
        const rows = await proxied.select({ companyId: issues.companyId }).from(issues);
        // An explicit cross-company filter yields nothing either.
        const crossed = await proxied.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyB.id));
        return { rows, crossed };
      });
      expect(seen.rows).toHaveLength(1);
      expect(seen.rows[0]?.companyId).toBe(companyA.id);
      expect(seen.crossed).toHaveLength(0);
    });
  });

  it("the scoped login with no claim at all -- the DUR-244 shape -- reads zero rows from every tenant table", async () => {
    const companyA = await seedCompany("A");
    await seedIssue(companyA.id, `${companyA.issuePrefix}-1`);
    await seedPipelineWithStage(companyA.id, "p-a");

    await withPool(scopedUrl, async (scopedPool) => {
      expect(await scopedPool.select().from(issues)).toHaveLength(0);
      expect(await scopedPool.select().from(companies)).toHaveLength(0);
      expect(await scopedPool.select().from(pipelineStages)).toHaveLength(0);
    });
  });

  it("closes the pipeline_stages indirect-tenancy gap 0149 left open", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedPipelineWithStage(companyA.id, "p-a");
    await seedPipelineWithStage(companyB.id, "p-b");

    await withPool(scopedUrl, async (scopedPool) => {
      const proxied = createRequestScopedDb(scopedPool);
      const keys = await runInCompanyScope(scopedPool, companyA.id, async () =>
        (await proxied.select({ key: pipelineStages.key }).from(pipelineStages)).map((r) => r.key),
      );
      expect(keys).toEqual(["p-a-stage"]);
    });
  });

  it("the scoped login can reach the instance-wide tables 0149 never granted (auth users, cross_company_access_log)", async () => {
    await withPool(scopedUrl, async (scopedPool) => {
      // Would be "permission denied for table user" before 0161.
      const users = (await scopedPool.execute(sql`select count(*)::int as count from "user"`)) as unknown as {
        count: number;
      }[];
      expect(users[0]?.count).toBe(0);
      const audit = (await scopedPool.execute(
        sql`select count(*)::int as count from cross_company_access_log`,
      )) as unknown as { count: number }[];
      expect(audit[0]?.count).toBe(0);
    });
  });

  it("every public table with a company_id column carries the paperclip_company_scope policy (drift guard for future migrations)", async () => {
    const rows = (await db.execute(sql`
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'company_id' AND t.table_type = 'BASE TABLE'
        AND NOT EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = c.table_name AND p.policyname = 'paperclip_company_scope'
        )
      ORDER BY c.table_name
    `)) as unknown as { table_name: string }[];
    expect(
      rows.map((r) => r.table_name),
      "a migration added a tenant table without an RLS policy -- add a paperclip_company_scope policy for it in that migration (see 0149/0161)",
    ).toEqual([]);
  });

  it("every public table is readable by the scoped role (no permission-denied surprises after cutover)", async () => {
    const rows = (await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name NOT LIKE '\\_\\_drizzle%'
        AND NOT has_table_privilege('paperclip_app_scoped', quote_ident(table_schema) || '.' || quote_ident(table_name), 'SELECT')
      ORDER BY table_name
    `)) as unknown as { table_name: string }[];
    expect(rows.map((r) => r.table_name)).toEqual([]);
    const bypassRows = (await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name NOT LIKE '\\_\\_drizzle%'
        AND NOT has_table_privilege(${BYPASS_LOGIN}, quote_ident(table_schema) || '.' || quote_ident(table_name), 'SELECT, INSERT, UPDATE, DELETE')
      ORDER BY table_name
    `)) as unknown as { table_name: string }[];
    expect(bypassRows.map((r) => r.table_name)).toEqual([]);
  });

  it("the bypass login sees every company and passes the app's bypass helpers, but owns nothing and cannot run DDL", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedIssue(companyA.id, `${companyA.issuePrefix}-1`);
    await seedIssue(companyB.id, `${companyB.issuePrefix}-1`);

    await withPool(bypassUrl, async (bypassPool) => {
      expect(await bypassPool.select().from(issues)).toHaveLength(2);

      const proxied = createRequestScopedDb(bypassPool);
      const seen = await runInCompanyScopeBypass(bypassPool, { reason: "login-role test" }, async () =>
        proxied.select({ id: issues.id }).from(issues),
      );
      expect(seen).toHaveLength(2);
      const audited = await withCompanyScopeBypass(bypassPool, { reason: "login-role test (tx)" }, async (tx) =>
        tx.select({ id: issues.id }).from(issues),
      );
      expect(audited).toHaveLength(2);
      expect(await db.select().from(crossCompanyAccessLog)).toHaveLength(2);

      // Not an owner: schema changes are refused.
      await expectPostgresError(
        bypassPool.execute(sql`ALTER TABLE issues ADD COLUMN dur3945_probe text`),
        /must be owner|permission denied/i,
      );
      await expectPostgresError(bypassPool.execute(sql`CREATE ROLE dur3945_should_fail`), /permission denied/i);
    });
  });

  it("the scoped login cannot use the bypass helpers on its own, but can once the app registers its bypass pool (DUR-3945 wiring)", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedIssue(companyA.id, `${companyA.issuePrefix}-1`);
    await seedIssue(companyB.id, `${companyB.issuePrefix}-1`);

    await withPool(scopedUrl, async (scopedPool) => {
      await expect(
        withCompanyScopeBypass(scopedPool, { reason: "scoped pool cannot bypass" }, async () => undefined),
      ).rejects.toThrow(/not a member of paperclip_app_bypass/);

      await withPool(bypassUrl, async (bypassPool) => {
        setCompanyScopeBypassPool(bypassPool);
        // Same call, same `scopedPool` argument -- now served by the bypass
        // login, which is exactly what server/src/index.ts sets up when
        // DATABASE_BYPASS_URL is configured.
        const rows = await withCompanyScopeBypass(scopedPool, { reason: "served by registered pool" }, async (tx) =>
          tx.select({ id: issues.id }).from(issues),
        );
        expect(rows).toHaveLength(2);
        setCompanyScopeBypassPool(null);
      });
    });
  });

  it("the 0151 guard still refuses to grant bypass to the scoped login role when replayed as that role", async () => {
    // A future re-bootstrap must never be able to hand the scoped login the
    // bypass marker by replaying 0151 under it.
    const asScoped = postgres(scopedUrl, { max: 1 });
    try {
      await expect(
        asScoped.unsafe(
          "DO $$ BEGIN IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = CURRENT_USER) AND pg_has_role(CURRENT_USER, 'paperclip_app_scoped', 'member') THEN RAISE EXCEPTION 'refusing to grant paperclip_app_bypass to a role that holds paperclip_app_scoped membership'; END IF; EXECUTE format('GRANT paperclip_app_bypass TO %I', CURRENT_USER); END $$",
        ),
      ).rejects.toThrow(/refusing to grant paperclip_app_bypass/);
    } finally {
      await asScoped.end();
    }
  });
});
