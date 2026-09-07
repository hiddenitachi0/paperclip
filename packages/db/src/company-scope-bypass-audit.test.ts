import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql as drizzleSql } from "drizzle-orm";
import { createDb } from "./client.js";
import {
  createRequestScopedDb,
  resetCompanyScopeBypassAuditCoalescing,
  runInCompanyScopeBypass,
  setCompanyScopeBypassPool,
  withCompanyScopeBypass,
} from "./company-scope.js";
import { crossCompanyAccessLog } from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// DUR-386 (audit-row coalescing) and DUR-3945 (registered bypass pool) for
// the two bypass helpers in company-scope.ts. Runs against a real embedded
// Postgres: the helpers' first statement is a pg_has_role() membership check
// that only a real role catalog can answer.
describeEmbeddedPostgres("company-scope bypass helpers: audit coalescing + registered bypass pool", () => {
  let db!: Db;
  let connectionString!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-bypass-audit-");
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
  }, 30_000);

  afterEach(async () => {
    setCompanyScopeBypassPool(null);
    resetCompanyScopeBypassAuditCoalescing();
    await db.delete(crossCompanyAccessLog);
  });

  afterAll(async () => {
    setCompanyScopeBypassPool(null);
    await tempDb?.cleanup();
  });

  async function auditRows() {
    return db.select().from(crossCompanyAccessLog).orderBy(crossCompanyAccessLog.occurredAt);
  }

  it("writes one audit row per call when auditCoalesceMs is unset (today's behaviour, unchanged)", async () => {
    for (let i = 0; i < 3; i += 1) {
      await runInCompanyScopeBypass(db, { reason: "one-off", route: "test:one-off" }, async () => undefined);
    }
    await withCompanyScopeBypass(db, { reason: "one-off", route: "test:one-off" }, async () => undefined);
    expect(await auditRows()).toHaveLength(4);
  });

  it("runInCompanyScopeBypass writes at most one audit row per (route, reason) inside the coalescing window", async () => {
    const opts = {
      reason: "heartbeat scheduler tick: tickTimers",
      actorType: "scheduler",
      route: "heartbeat-scheduler:tickTimers",
      auditCoalesceMs: 60 * 60 * 1000,
    };
    let ran = 0;
    for (let i = 0; i < 5; i += 1) {
      await runInCompanyScopeBypass(db, opts, async () => {
        ran += 1;
      });
    }
    // Every call still ran -- coalescing only affects the audit insert.
    expect(ran).toBe(5);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.route).toBe("heartbeat-scheduler:tickTimers");
  });

  it("withCompanyScopeBypass coalesces the same way, and a different route/reason gets its own row", async () => {
    const base = { reason: "scheduler chain", auditCoalesceMs: 60 * 60 * 1000 };
    await withCompanyScopeBypass(db, { ...base, route: "chain:a" }, async () => undefined);
    await withCompanyScopeBypass(db, { ...base, route: "chain:a" }, async () => undefined);
    await withCompanyScopeBypass(db, { ...base, route: "chain:b" }, async () => undefined);
    await withCompanyScopeBypass(db, { ...base, route: "chain:a", reason: "another reason" }, async () => undefined);
    const routes = (await auditRows()).map((row) => `${row.route}|${row.reason}`).sort();
    expect(routes).toEqual(["chain:a|another reason", "chain:a|scheduler chain", "chain:b|scheduler chain"]);
  });

  it("writes again once the window has elapsed", async () => {
    const opts = { reason: "short window", route: "chain:short", auditCoalesceMs: 30 };
    await runInCompanyScopeBypass(db, opts, async () => undefined);
    await runInCompanyScopeBypass(db, opts, async () => undefined);
    expect(await auditRows()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await runInCompanyScopeBypass(db, opts, async () => undefined);
    expect(await auditRows()).toHaveLength(2);
  });

  it("still verifies role membership on every coalesced call (the check is not what gets skipped)", async () => {
    // A pool whose connections drop to a role with no bypass membership must
    // be refused every time, coalesced or not. SET ROLE on a fresh pool is
    // the same trick rls-company-isolation.test.ts uses.
    const scopedOnly = createDb(connectionString, "paperclip-scoped-only-test");
    await scopedOnly.execute(drizzleSql`SET ROLE paperclip_app_scoped`);
    const opts = { reason: "coalesced but unprivileged", route: "chain:unprivileged", auditCoalesceMs: 60_000 };
    try {
      await expect(runInCompanyScopeBypass(scopedOnly, opts, async () => undefined)).rejects.toThrow(
        /not a member of paperclip_app_bypass/,
      );
      await expect(runInCompanyScopeBypass(scopedOnly, opts, async () => undefined)).rejects.toThrow(
        /not a member of paperclip_app_bypass/,
      );
    } finally {
      await scopedOnly.$client.end({ timeout: 5 });
    }
  });

  it("routes both helpers through the registered bypass pool once one is set (DUR-3945)", async () => {
    const bypassPool = createDb(connectionString, "paperclip-bypass-pool-test");
    setCompanyScopeBypassPool(bypassPool);
    try {
      const proxied = createRequestScopedDb(db);
      const reservedAppName = await runInCompanyScopeBypass(db, { reason: "registered pool" }, async () => {
        const rows = (await proxied.execute(
          drizzleSql`select current_setting('application_name') as app`,
        )) as unknown as { app: string }[];
        return rows[0]?.app;
      });
      expect(reservedAppName).toBe("paperclip-bypass-pool-test");

      const txAppName = await withCompanyScopeBypass(db, { reason: "registered pool" }, async (tx) => {
        const rows = (await tx.execute(
          drizzleSql`select current_setting('application_name') as app`,
        )) as unknown as { app: string }[];
        return rows[0]?.app;
      });
      expect(txAppName).toBe("paperclip-bypass-pool-test");
    } finally {
      setCompanyScopeBypassPool(null);
      await bypassPool.$client.end({ timeout: 5 });
    }

    // With the registration cleared, the helpers are back on the caller's db.
    const appName = await withCompanyScopeBypass(db, { reason: "unregistered" }, async (tx) => {
      const rows = (await tx.execute(
        drizzleSql`select current_setting('application_name') as app`,
      )) as unknown as { app: string }[];
      return rows[0]?.app;
    });
    expect(appName).toBe("paperclip-app");
  });
});
