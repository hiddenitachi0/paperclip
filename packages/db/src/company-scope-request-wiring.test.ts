import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDb } from "./client.js";
import {
  ConnectionReleaseUnsafeError,
  createRequestScopedDb,
  requestCompanyScopeStorage,
  runInCompanyScope,
  runInCompanyScopeBypass,
  withCompanyScope,
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

  // DUR-421 follow-up: reproduces the production crash where a client abort
  // (Node's `close` event on http.ServerResponse, which fires on premature
  // termination as well as normal completion) let companyScope() middleware
  // release a reserved connection while its route handler was still
  // mid-flight, so a later request could reserve the same physical
  // connection and interleave its wire traffic with the orphaned handler's
  // -- surfaced as Postgres "bind message supplies N parameters, but
  // prepared statement requires M" errors that crashed the process. This
  // proves the fix at the primitive level: when `fn` signals
  // ConnectionReleaseUnsafeError, runInCompanyScope must abandon the
  // connection rather than recycle it.
  it("abandons (never releases) the reserved connection when fn() rejects with ConnectionReleaseUnsafeError", async () => {
    const singleConnDb = createSingleConnectionDb();
    const companyA = await seedCompany("A");

    try {
      const result = await runInCompanyScope(singleConnDb, companyA.id, async () => {
        throw new ConnectionReleaseUnsafeError();
      });
      expect(result).toBeUndefined();

      // The pool has exactly one physical connection. If it were released
      // (instead of abandoned), a fresh reserve() would resolve almost
      // immediately; since it must remain abandoned, reserve() should still
      // be pending after a short wait.
      let resolved = false;
      const reservePromise = singleConnDb.$client
        .reserve()
        .then((reserved) => {
          resolved = true;
          reserved.release();
        })
        .catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(resolved).toBe(false);
      void reservePromise;
    } finally {
      await singleConnDb.$client.end({ timeout: 0 });
    }
  });

  it("runInCompanyScopeBypass throws when the connection's role is not a member of paperclip_app_bypass", async () => {
    // pg_has_role() always returns true for the migration-running superuser
    // regardless of actual grants, so the negative case has to run as a real
    // non-superuser role -- paperclip_app_scoped (created by migration 0149)
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

// DUR-418: withCompanyScope(rawDb, companyId, fn) used to unconditionally call
// rawDb.transaction(...), which reserves a SECOND physical connection even
// when called from inside a runInCompanyScope()-reserved request scope for
// the very same company. Under enough concurrent requests that each hold one
// runInCompanyScope reservation and then call withCompanyScope, every nested
// db.transaction() blocks forever waiting for a connection that can only
// free up once that same blocked call returns -- a permanent pool-exhaustion
// deadlock. Fixed by detecting the active AsyncLocalStorage scope and running
// on that reserved connection via BEGIN/SAVEPOINT instead of a second BEGIN.
// These tests use a `max: 1` pool so a regression back to `rawDb.transaction()`
// inside an active scope hangs (and fails on the test's own timeout) rather
// than silently passing by drawing a second connection from a bigger pool.
describeEmbeddedPostgres("DUR-418: withCompanyScope reuses the runInCompanyScope-reserved connection", () => {
  let db!: Db;
  let connectionString!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-dur418-nested-scope-");
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createSingleConnectionDb(): Db {
    const sql = postgres(connectionString, { max: 1 });
    return drizzlePg(sql, {}) as unknown as Db;
  }

  async function seedCompany(label: string) {
    return db
      .insert(companies)
      .values({
        name: `DUR-418 ${label}`,
        issuePrefix: `D418${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it(
    "withCompanyScope inside an active runInCompanyScope for the same companyId does not draw a second connection",
    async () => {
      const singleConnDb = createSingleConnectionDb();
      const companyA = await seedCompany("reuse");
      try {
        const seenName = await runInCompanyScope(singleConnDb, companyA.id, async () => {
          return withCompanyScope(singleConnDb, companyA.id, async (tx) => {
            const rows = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyA.id));
            return rows[0]?.name;
          });
        });
        expect(seenName).toBe(`DUR-418 reuse`);
      } finally {
        await singleConnDb.$client.end();
      }
    },
    5_000,
  );

  it(
    "true nested withCompanyScope calls use SAVEPOINT (not a second BEGIN) and both writes commit",
    async () => {
      const singleConnDb = createSingleConnectionDb();
      const companyA = await seedCompany("nested-commit");
      try {
        await runInCompanyScope(singleConnDb, companyA.id, async () => {
          await withCompanyScope(singleConnDb, companyA.id, async (tx) => {
            await tx.update(companies).set({ name: "outer-write" }).where(eq(companies.id, companyA.id));
            await withCompanyScope(singleConnDb, companyA.id, async (innerTx) => {
              await innerTx.update(companies).set({ name: "inner-write" }).where(eq(companies.id, companyA.id));
            });
          });
        });

        const [row] = await db.select().from(companies).where(eq(companies.id, companyA.id));
        expect(row?.name).toBe("inner-write");
      } finally {
        await singleConnDb.$client.end();
      }
    },
    5_000,
  );

  it(
    "an error thrown inside a nested withCompanyScope call rolls back only its own SAVEPOINT, not the outer transaction",
    async () => {
      const singleConnDb = createSingleConnectionDb();
      const companyA = await seedCompany("nested-rollback");
      try {
        await runInCompanyScope(singleConnDb, companyA.id, async () => {
          await withCompanyScope(singleConnDb, companyA.id, async (tx) => {
            await tx.update(companies).set({ name: "outer-write" }).where(eq(companies.id, companyA.id));
            await expect(
              withCompanyScope(singleConnDb, companyA.id, async (innerTx) => {
                await innerTx
                  .update(companies)
                  .set({ name: "inner-write-should-roll-back" })
                  .where(eq(companies.id, companyA.id));
                throw new Error("boom");
              }),
            ).rejects.toThrow("boom");
          });
        });

        const [row] = await db.select().from(companies).where(eq(companies.id, companyA.id));
        expect(row?.name).toBe("outer-write");
      } finally {
        await singleConnDb.$client.end();
      }
    },
    5_000,
  );

  it(
    // DUR-916 review mod #3: rejects outright instead of silently falling
    // back to a second connection, which would reintroduce the deadlock
    // conditionally (only in the cross-company case) with no visible signal.
    "withCompanyScope for a DIFFERENT companyId than the active scoped scope rejects instead of silently acquiring a second connection",
    async () => {
      const companyA = await seedCompany("mismatch-outer");
      const companyB = await seedCompany("mismatch-inner");

      await runInCompanyScope(db, companyA.id, async () => {
        await expect(
          withCompanyScope(db, companyB.id, async (tx) => {
            await tx.execute(drizzleSql`select 1`);
          }),
        ).rejects.toThrow(/different companyId/);
      });
    },
    10_000,
  );

  it(
    // DUR-916 review mod #4: a "bypass" outer scope (runInCompanyScopeBypass)
    // has no per-company claim to protect, so it's always safe to reuse
    // regardless of what companyId the nested withCompanyScope call requests.
    "withCompanyScope inside an active runInCompanyScopeBypass scope reuses that connection for any companyId",
    async () => {
      const grantSql = postgres(connectionString, { max: 1 });
      try {
        await grantSql.unsafe("GRANT paperclip_app_bypass TO CURRENT_USER");
      } finally {
        await grantSql.end();
      }

      try {
        const singleConnDb = createSingleConnectionDb();
        const companyA = await seedCompany("bypass-reuse");
        try {
          const name = await runInCompanyScopeBypass(
            singleConnDb,
            { reason: "DUR-418 test: bypass reuse" },
            async () => {
              return withCompanyScope(singleConnDb, companyA.id, async (tx) => {
                const rows = await tx
                  .select({ name: companies.name })
                  .from(companies)
                  .where(eq(companies.id, companyA.id));
                return rows[0]?.name;
              });
            },
          );
          expect(name).toBe("DUR-418 bypass-reuse");
        } finally {
          await singleConnDb.$client.end();
        }
      } finally {
        const revokeSql = postgres(connectionString, { max: 1 });
        try {
          await revokeSql.unsafe("REVOKE paperclip_app_bypass FROM CURRENT_USER");
        } finally {
          await revokeSql.end();
        }
      }
    },
    10_000,
  );

  it(
    // DUR-916 review mod #2: tx.rollback() can't reproduce drizzle's
    // resolve-not-reject sentinel semantics on a hand-rolled BEGIN/SAVEPOINT
    // wrapper, so it must fail loudly instead of behaving subtly differently.
    "calling tx.rollback() inside a reused-connection withCompanyScope call throws a clear, explicit error",
    async () => {
      const singleConnDb = createSingleConnectionDb();
      const companyA = await seedCompany("rollback-guard");
      try {
        await runInCompanyScope(singleConnDb, companyA.id, async () => {
          await expect(
            withCompanyScope(singleConnDb, companyA.id, async (tx) => {
              (tx as unknown as { rollback: () => void }).rollback();
            }),
          ).rejects.toThrow(/tx\.rollback\(\) is not supported/);
        });
      } finally {
        await singleConnDb.$client.end();
      }
    },
    5_000,
  );

  it(
    // Regression found while validating this fix against a concurrent
    // change (DUR-417) that runs queueTaskWatchdogEvaluation()
    // fire-and-forget from inside a runInCompanyScope() request scope.
    // AsyncLocalStorage propagates the scope to that orphaned continuation
    // even after runInCompanyScope's own `fn` has returned and its `finally`
    // has already reset+released the connection back to the pool -- without
    // the liveness check, a withCompanyScope call from that orphaned
    // continuation would try to BEGIN on a connection some other request may
    // already be mid-transaction on. This proves withCompanyScope falls back
    // to its own connection once the outer scope's connection has been
    // released, instead of reusing a stale scope reference.
    "withCompanyScope from a continuation that outlives the outer runInCompanyScope call falls back to its own connection instead of touching the released one",
    async () => {
      const companyA = await seedCompany("outlives-release");
      let capturedScope: unknown;

      await runInCompanyScope(db, companyA.id, async () => {
        capturedScope = requestCompanyScopeStorage.getStore();
      });

      // By now runInCompanyScope's finally has already reset+released the
      // connection. Simulate the orphaned fire-and-forget continuation by
      // re-entering the captured scope directly and calling withCompanyScope.
      const name = await requestCompanyScopeStorage.run(capturedScope as never, async () => {
        return withCompanyScope(db, companyA.id, async (tx) => {
          const rows = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyA.id));
          return rows[0]?.name;
        });
      });

      expect(name).toBe("DUR-418 outlives-release");
    },
    10_000,
  );
});
