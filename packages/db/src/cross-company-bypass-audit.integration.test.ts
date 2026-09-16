import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDb } from "./client.js";
import { runInCompanyScopeBypass, withCompanyScopeBypass } from "./company-scope.js";
import {
  resetRoutineSchedulerBypassCounts,
  snapshotRoutineSchedulerBypassCounts,
} from "./cross-company-audit.js";
import { crossCompanyAccessLog } from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cross-company bypass audit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

// DUR-386: the routine heartbeat-scheduler tick chains must stop writing a
// cross_company_access_log row every tick, and EVERY other bypass consumer
// must keep writing one. Both halves are asserted against a real database
// through the real bypass entry points, not against the predicate alone.
describeEmbeddedPostgres("DUR-386: cross-company audit rows for bypass consumers", () => {
  let db!: Db;
  let connectionString!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-cross-company-audit-");
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
    // pg_has_role() is unconditionally true for the migration-running
    // superuser, but the bypass entry points still require the grant to
    // exist; mirror company-scope-request-wiring.test.ts and grant it.
    const grantSql = postgres(connectionString, { max: 1 });
    try {
      await grantSql.unsafe("GRANT paperclip_app_bypass TO CURRENT_USER");
    } finally {
      await grantSql.end();
    }
  }, 30_000);

  afterEach(async () => {
    await db.delete(crossCompanyAccessLog);
    resetRoutineSchedulerBypassCounts();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function auditRows() {
    return db.select().from(crossCompanyAccessLog);
  }

  it("writes no row for a silenced scheduler tick, but counts it", async () => {
    await runInCompanyScopeBypass(
      db,
      {
        reason: "heartbeat scheduler tick: tickTimers",
        actorType: "scheduler",
        route: "heartbeat-scheduler:tickTimers",
      },
      async () => "ticked",
    );

    expect(await auditRows()).toHaveLength(0);
    expect(snapshotRoutineSchedulerBypassCounts()).toEqual({ "heartbeat-scheduler:tickTimers": 1 });
  });

  it("writes no rows for a whole tick's worth of silenced chains", async () => {
    for (const route of [
      "heartbeat-scheduler:tickTimers",
      "heartbeat-scheduler:tickScheduledTriggers",
      "heartbeat-scheduler:mergeDeployVisibility",
      "heartbeat-scheduler:periodicRecoveryPipeline",
    ]) {
      await runInCompanyScopeBypass(
        db,
        { reason: `heartbeat scheduler tick: ${route}`, actorType: "scheduler", route },
        async () => null,
      );
    }
    expect(await auditRows()).toHaveLength(0);
  });

  it("still writes a row for a request-driven bypass", async () => {
    await runInCompanyScopeBypass(
      db,
      {
        reason: "board API key management is scoped to the user, not a single company",
        actorType: "user",
        actorId: "user-1",
        route: "/board-api-keys",
      },
      async () => null,
    );

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.route).toBe("/board-api-keys");
    expect(rows[0]?.actorType).toBe("user");
  });

  it("still writes a row for the once-per-boot scheduler startup recovery", async () => {
    await runInCompanyScopeBypass(
      db,
      {
        reason: "heartbeat scheduler startup recovery",
        actorType: "scheduler",
        route: "heartbeat-scheduler:startup-recovery",
      },
      async () => null,
    );

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.route).toBe("heartbeat-scheduler:startup-recovery");
  });

  it("fails open: an unlisted scheduler route still writes a row", async () => {
    await runInCompanyScopeBypass(
      db,
      {
        reason: "heartbeat scheduler tick: a chain added after DUR-386",
        actorType: "scheduler",
        route: "heartbeat-scheduler:brandNewChain",
      },
      async () => null,
    );
    // ...as does a listed route claimed by something other than the scheduler.
    await runInCompanyScopeBypass(
      db,
      { reason: "not actually the scheduler", actorType: "agent", route: "heartbeat-scheduler:tickTimers" },
      async () => null,
    );

    expect(await auditRows()).toHaveLength(2);
    expect(snapshotRoutineSchedulerBypassCounts()).toEqual({});
  });

  it("applies the same rule to the transaction-shaped withCompanyScopeBypass", async () => {
    await withCompanyScopeBypass(
      db,
      {
        reason: "heartbeat scheduler tick: quietModeAlerts",
        actorType: "scheduler",
        route: "heartbeat-scheduler:quietModeAlerts",
      },
      async () => null,
    );
    expect(await auditRows()).toHaveLength(0);

    await withCompanyScopeBypass(
      db,
      {
        reason: "board ownership claim grants membership across every company in the instance",
        actorType: "user",
        route: "/board-claim",
      },
      async () => null,
    );
    expect(await auditRows()).toHaveLength(1);
  });
});
