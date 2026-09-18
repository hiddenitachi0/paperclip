import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { runInCompanyScopeBypass, withCompanyScope } from "./company-scope.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping bypass settle/release tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

// DUR-3991: production had no scheduled agent wake-up for over twelve hours on
// 2026-09-17. Each restart, one scheduler chain entered
// runInCompanyScopeBypass and never came out: its reserved connection was
// never released and the DUR-385 single-flight guard skipped every later tick
// of that chain. The database was idle throughout.
//
// The bookkeeping bug behind it is proved deterministically in
// reserved-scope-turns.test.ts. This is the end-to-end guarantee, against a
// real database and through the real entry point: a bypass chain SETTLES, and
// it GIVES ITS CONNECTION BACK -- on the DUR-386-silenced scheduler route just
// as much as on an audited one.
describeEmbeddedPostgres("DUR-3991: a bypass chain always settles and always releases its connection", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-bypass-settles-");
    db = createDb(tempDb.connectionString);
    const grantSql = postgres(tempDb.connectionString, { max: 1 });
    try {
      await grantSql.unsafe("GRANT paperclip_app_bypass TO CURRENT_USER");
    } finally {
      await grantSql.end();
    }
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Rejects rather than hanging, so a wedge fails the test instead of timing the suite out. */
  async function within<T>(label: string, ms: number, promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The shape that wedged: sibling withCompanyScope() calls on one bypass
   * scope's reserved connection, not awaited relative to each other, some
   * finishing while others are still open.
   */
  async function overlappingSiblings() {
    const companyId = randomUUID();
    await Promise.all([
      withCompanyScope(db, companyId, async (tx) => {
        await tx.execute(sql`select 1`);
      }),
      withCompanyScope(db, companyId, async (tx) => {
        await tx.execute(sql`select pg_sleep(0.02)`);
        await tx.execute(sql`select 2`);
      }),
      withCompanyScope(db, companyId, async (tx) => {
        await tx.execute(sql`select 3`);
      }),
    ]);
    return "done";
  }

  // The routes the scheduler actually uses, both sides of the DUR-386 split:
  // "heartbeat-scheduler:tickTimers" writes no audit row (silenced), so it is
  // the branch that issues NO query of its own before the callback -- exactly
  // the path the wedged chain took.
  for (const route of ["heartbeat-scheduler:tickTimers", "/board-api-keys"]) {
    const silenced = route.startsWith("heartbeat-scheduler:");
    it(`settles on the ${silenced ? "silenced scheduler" : "audited"} route, with siblings closing out of order`, async () => {
      const result = await within(
        `bypass chain for ${route}`,
        20_000,
        runInCompanyScopeBypass(
          db,
          { reason: "DUR-3991 settle check", actorType: silenced ? "scheduler" : "user", route },
          overlappingSiblings,
        ),
      );
      expect(result).toBe("done");
    });

    it(`gives its connection back on the ${silenced ? "silenced scheduler" : "audited"} route, chain after chain`, async () => {
      // More chains than the pool has connections. If a single one failed to
      // release, an early chain here would block forever instead of finishing
      // -- which is precisely what production looked like.
      const poolMax = Number((db.$client as unknown as { options?: { max?: number } }).options?.max ?? 10);
      expect(poolMax).toBeGreaterThan(0);
      for (let chain = 0; chain < poolMax * 3; chain += 1) {
        await within(
          `bypass chain ${chain} for ${route}`,
          20_000,
          runInCompanyScopeBypass(
            db,
            { reason: "DUR-3991 release check", actorType: silenced ? "scheduler" : "user", route },
            overlappingSiblings,
          ),
        );
      }
    }, 60_000);
  }

  it("still releases its connection when the callback throws", async () => {
    const poolMax = Number((db.$client as unknown as { options?: { max?: number } }).options?.max ?? 10);
    for (let chain = 0; chain < poolMax * 2; chain += 1) {
      await expect(
        within(
          `failing bypass chain ${chain}`,
          20_000,
          runInCompanyScopeBypass(
            db,
            { reason: "DUR-3991 release check", actorType: "scheduler", route: "heartbeat-scheduler:tickTimers" },
            async () => {
              throw new Error("chain blew up");
            },
          ),
        ),
      ).rejects.toThrow("chain blew up");
    }

    // And the pool is still usable afterwards.
    await within("post-failure bypass chain", 20_000, runInCompanyScopeBypass(
      db,
      { reason: "DUR-3991 release check", actorType: "scheduler", route: "heartbeat-scheduler:tickTimers" },
      async () => "ok",
    ));
  }, 60_000);
});
