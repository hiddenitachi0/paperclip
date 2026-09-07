import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
  workspaceOperations,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { workspaceOperationService } from "../services/workspace-operations.js";

// DUR-3931: regression test for the "deadlock detected" the signoff-policy e2e
// hit on CI runs 34025840842 and 34101687694. Both times an agent PATCH on an
// issue died inside assertCheckoutOwner -> clearExecutionRunIfTerminal at
//
//   select "heartbeat_runs"."id" from "heartbeat_runs" where id = $1 for update
//
// while holding the issue row `for update`. The partner transaction is the
// finalizing run's own bookkeeping: recordWorkspaceFinalize inserts a
// workspace_operations row that references BOTH the heartbeat run and the
// issue. Postgres checks those two foreign keys at the end of that single
// INSERT, one after the other, taking a `for key share` lock on each parent
// row -- run first, then issue -- and holds them until the insert commits.
// `for key share` on the run does not conflict with anything except `for
// update`, which is exactly what the checkout helpers asked for, so:
//
//   PATCH:  lock issue (for update) ........ wait for run (for update)
//   insert: key-share run ................... wait for issue (key share vs for update)
//
// The second CI failure even shows the insert losing the same deadlock
// ("insert into workspace_operations ...: deadlock detected"), which is how the
// pair was identified. Locking the issue row first in adoptUnownedCheckoutRun
// alone (the earlier attempt) could not help: a single-statement INSERT has no
// lock order to fix, and it already takes the run before the issue.
//
// The fix keeps the issue-first order but takes the run rows `for no key
// update` -- the same strength an UPDATE of the run's status takes, so the
// helpers still serialize against a run finishing underneath them, while
// foreign-key `key share` holders (workspace_operations, issue_comments,
// activity_log, ... every table that references heartbeat_runs) no longer
// conflict with them in either direction.
//
// The tests below drive the two real service code paths concurrently and use
// a third, plain `for share` transaction as a scheduling gate so the
// interleaving is deterministic rather than a CI coin flip. Postgres runs with
// log_lock_waits on and a 200ms deadlock_timeout so a regression fails fast and
// prints the server's own explanation of who waited on whom.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue checkout / run finalize deadlock tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const DEADLOCK_TIMEOUT_MS = 200;
// Long enough for Postgres to run its deadlock check on every waiting backend
// (each backend checks once, deadlock_timeout after it started waiting).
const DEADLOCK_DETECTION_GRACE_MS = DEADLOCK_TIMEOUT_MS * 4;

type Deferred<T = void> = { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function describeRejection(reason: unknown): string {
  const err = reason as { message?: string; cause?: { detail?: string; message?: string } };
  const parts = [err?.message ?? String(reason)];
  if (err?.cause?.detail) parts.push(`postgres detail: ${err.cause.detail}`);
  return parts.join("\n");
}

describeEmbeddedPostgres("DUR-3931: issue checkout vs. run finalization lock ordering", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let logBasePath!: string;
  let previousLogBasePath: string | undefined;
  const serverLog: string[] = [];

  beforeAll(async () => {
    previousLogBasePath = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    logBasePath = mkdtempSync(path.join(os.tmpdir(), "issue-checkout-deadlock-logs-"));
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = logBasePath;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-checkout-deadlock-", {
      postgresFlags: [
        "-c",
        "log_lock_waits=on",
        "-c",
        `deadlock_timeout=${DEADLOCK_TIMEOUT_MS}ms`,
        "-c",
        "log_error_verbosity=default",
      ],
      onLog: (message) => {
        serverLog.push(message);
      },
    });
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    serverLog.length = 0;
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    rmSync(logBasePath, { recursive: true, force: true });
    if (previousLogBasePath === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = previousLogBasePath;
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Executor",
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });
    // The state the e2e leaves behind: claimQueuedRun stamped executionRunId
    // when the run started, nothing has checked the issue out yet.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Signoff comment required",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "executor",
      executionLockedAt: new Date(),
    });

    return { companyId, agentId, issueId, runId };
  }

  async function backendsWaitingOnLock(): Promise<Array<{ pid: number; query: string }>> {
    const rows = (await db.execute(
      sql`select pid, query from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    )) as unknown as Array<{ pid: number; query: string }>;
    return rows;
  }

  async function waitForBackendWaitingOn(pattern: RegExp, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const waiting = await backendsWaitingOnLock();
      const match = waiting.find((row) => pattern.test(row.query));
      if (match) return match;
      await sleep(10);
    }
    throw new Error(`No backend started waiting on a lock with a statement matching ${pattern} within ${timeoutMs}ms`);
  }

  /**
   * Holds a plain `for share` lock on the run row until released. It stands in
   * for whichever earlier locker is on the row when the race happens (in the
   * e2e that is the finalizing run's own status UPDATE): it makes the checkout
   * helper's run lock wait, so the finalize INSERT can arrive in the middle of
   * the helper's transaction instead of before or after it.
   */
  async function holdRunRowForShare(runId: string) {
    const held = deferred();
    const release = deferred();
    const done = db.transaction(async (tx) => {
      await tx.execute(sql`select id from heartbeat_runs where id = ${runId} for share`);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    return {
      release: async () => {
        release.resolve();
        await done;
      },
    };
  }

  function recordWorkspaceFinalize(input: { companyId: string; runId: string; issueId: string }) {
    // The exact call heartbeat.ts's recordWorkspaceFinalize makes at the end of
    // executeRun: one INSERT that references both the run and the issue.
    return workspaceOperationService(db)
      .createRecorder({ companyId: input.companyId, heartbeatRunId: input.runId, issueId: input.issueId })
      .recordOperation({
        phase: "workspace_finalize",
        cwd: "/tmp/paperclip-e2e",
        metadata: { adapterType: "process", executionTargetKind: "local" },
        run: async () => ({ status: "succeeded", exitCode: 0 }),
      });
  }

  async function raceCheckoutHelperAgainstFinalize(
    seeded: Awaited<ReturnType<typeof seed>>,
    checkoutHelper: () => Promise<unknown>,
  ) {
    const gate = await holdRunRowForShare(seeded.runId);

    // 1. The checkout helper locks the issue row, then blocks on the run row.
    const helper = checkoutHelper();
    await waitForBackendWaitingOn(/from "heartbeat_runs" where .* for (no key )?update/i);

    // 2. The finalizing run records its workspace_finalize operation: the FK
    //    checks key-share the run (compatible with the gate's `for share`) and
    //    then queue on the issue behind the helper.
    const finalize = recordWorkspaceFinalize(seeded);
    let finalizeSettled = false;
    void finalize.then(() => { finalizeSettled = true; }, () => { finalizeSettled = true; });
    const finalizeWaitDeadline = Date.now() + 5_000;
    while (!finalizeSettled && Date.now() < finalizeWaitDeadline) {
      const waiting = await backendsWaitingOnLock();
      if (waiting.some((row) => /insert into "workspace_operations"/i.test(row.query))) break;
      await sleep(10);
    }

    // 3. Give Postgres' deadlock detector time to run on every waiter, then
    //    let the gate go. With the fix nobody is in a cycle and both finish.
    await sleep(DEADLOCK_DETECTION_GRACE_MS);
    await gate.release();

    const results = await Promise.allSettled([helper, finalize]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const deadlockLog = serverLog.filter((line) => /deadlock|still waiting for/i.test(line));
    expect(
      rejected.map((r) => describeRejection(r.reason)),
      `expected both transactions to complete; postgres log:\n${deadlockLog.join("")}`,
    ).toEqual([]);
    expect(serverLog.join("")).not.toMatch(/deadlock detected/);
    return results;
  }

  it("agent PATCH (assertCheckoutOwner) and the run's workspace_finalize record both complete", async () => {
    const seeded = await seed();
    const svc = issueService(db);

    const [ownership] = await raceCheckoutHelperAgainstFinalize(seeded, () =>
      svc.assertCheckoutOwner(seeded.issueId, seeded.agentId, seeded.runId),
    );
    expect(ownership.status).toBe("fulfilled");
    expect((ownership as PromiseFulfilledResult<{ checkoutRunId: string | null }>).value).toMatchObject({
      checkoutRunId: seeded.runId,
    });

    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: seeded.runId, executionRunId: seeded.runId });

    const recorded = await db
      .select({ status: workspaceOperations.status, phase: workspaceOperations.phase })
      .from(workspaceOperations)
      .where(eq(workspaceOperations.heartbeatRunId, seeded.runId));
    expect(recorded).toEqual([{ status: "succeeded", phase: "workspace_finalize" }]);
  });

  it("agent checkout (POST /issues/:id/checkout) and the run's workspace_finalize record both complete", async () => {
    const seeded = await seed();
    const svc = issueService(db);

    const [checkout] = await raceCheckoutHelperAgainstFinalize(seeded, () =>
      svc.checkout(seeded.issueId, seeded.agentId, ["in_progress"], seeded.runId),
    );
    expect(checkout.status).toBe("fulfilled");

    const row = await db
      .select({ status: issues.status, checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ status: "in_progress", checkoutRunId: seeded.runId, executionRunId: seeded.runId });
  });

  // Second ordering hazard in the same family: adoptUnownedCheckoutRun used to
  // lock the actor run first and then UPDATE the issue, while every sibling
  // helper locks the issue first. Two requests from the same agent on the same
  // issue (the e2e does a checkout and a PATCH back to back; a real agent can
  // overlap them) could then hold one row each and wait for the other. This
  // pauses one request's transaction right after it takes its run lock, lets
  // a second request in, and checks both still finish.
  it("two overlapping agent requests adopting the same run do not deadlock", async () => {
    const seeded = await seed();

    const dialect = new PgDialect();
    let runLockStatements = 0;
    let pauseAfterRunLock: Deferred | null = null;
    const pausedHoldingRunLock = deferred();
    const instrumentedRawDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return (fn: (tx: unknown) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              const observedTx = new Proxy(tx, {
                get(txTarget, txProp) {
                  if (txProp === "execute") {
                    return async (query: Parameters<typeof tx.execute>[0]) => {
                      const result = await txTarget.execute(query);
                      const text = dialect.sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
                      if (/from "heartbeat_runs" where .* for (no key )?update/i.test(text)) {
                        runLockStatements += 1;
                        if (pauseAfterRunLock && runLockStatements === 2) {
                          pausedHoldingRunLock.resolve();
                          await pauseAfterRunLock.promise;
                        }
                      }
                      return result;
                    };
                  }
                  const value = Reflect.get(txTarget, txProp, txTarget);
                  return typeof value === "function" ? value.bind(txTarget) : value;
                },
              });
              return fn(observedTx);
            });
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;

    // Request 1: clearExecutionRunIfTerminal takes run lock #1 (issue-first,
    // released again since the run is live); adoptUnownedCheckoutRun then takes
    // run lock #2, where the transaction is paused.
    pauseAfterRunLock = deferred();
    const first = issueService(db, { rawDb: instrumentedRawDb }).assertCheckoutOwner(
      seeded.issueId,
      seeded.agentId,
      seeded.runId,
    );
    await pausedHoldingRunLock.promise;

    // Request 2 (plain service): issue row first, then the run row.
    const second = issueService(db).assertCheckoutOwner(seeded.issueId, seeded.agentId, seeded.runId);
    await waitForBackendWaitingOn(/"issues"|"heartbeat_runs"/i);
    await sleep(DEADLOCK_DETECTION_GRACE_MS);

    pauseAfterRunLock.resolve();
    const results = await Promise.allSettled([first, second]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const deadlockLog = serverLog.filter((line) => /deadlock|still waiting for/i.test(line));
    expect(
      rejected.map((r) => describeRejection(r.reason)),
      `expected both requests to complete; postgres log:\n${deadlockLog.join("")}`,
    ).toEqual([]);
    expect(serverLog.join("")).not.toMatch(/deadlock detected/);
    // Guards the pause point: if the helper chain ever takes a different number
    // of run locks before adoption, the test must be re-aimed, not silently pass.
    expect(runLockStatements).toBe(2);

    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: seeded.runId, executionRunId: seeded.runId });
  });
});
