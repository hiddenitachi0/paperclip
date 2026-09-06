import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agents wakeup company-scope tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

// DUR-392: proves POST /agents/:id/wakeup survives a real company-scoped
// request end to end. heartbeat.wakeup() (enqueueWakeup) internally calls
// withCompanyScope(rawDb, companyId, fn), which needs a genuinely raw Db to
// open its own short-lived transaction -- passing the request-scoped proxy
// instead makes createRequestScopedDb's own guard hard-throw on
// `db.transaction()` (see packages/db/src/company-scope.ts), because that
// proxy deliberately refuses to forward `.transaction()`. Regression target:
// agentRoutes() previously constructed its own `heartbeat` instance without
// threading `rawDb` through, so this route 500'd on every call before that
// wiring was added.
describeEmbeddedPostgres("agentRoutes wakeup company-scope wiring (DUR-392)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agents-wakeup-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithIdleAgent() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "DUR-392 wakeup", issuePrefix });

    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Wakeup Test Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      // maxDailyRuns: 0 makes getHeartbeatDailyCapBlock trip immediately
      // *inside* the withCompanyScope(rawDb, ...) transaction this test
      // exercises, short-circuiting before a real run is queued/executed --
      // this route's real (unmocked) execution path is heavyweight and not
      // what this regression test is about.
      runtimeConfig: { heartbeat: { maxDailyRuns: 0 } },
      permissions: {},
    });

    return { companyId, agentId };
  }

  it("does not 500 when a self-invoked agent wakes itself up (real withCompanyScope path)", { timeout: 20_000 }, async () => {
    const { companyId, agentId } = await seedCompanyWithIdleAgent();

    const { agentRoutes } = await import("../routes/agents.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId,
        companyId,
        source: "agent_key",
      } as Express.Request["actor"];
      next();
    });
    app.use("/api", await agentRoutes(db, {}));
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
    });

    const res = await request(app).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand" });

    // The specific outcome (a fresh run enqueued, or a 202 skip because of a
    // daily cap / concurrency guard) doesn't matter here -- either is a sign
    // the withCompanyScope(rawDb, ...) call inside enqueueWakeup actually ran
    // against a real raw connection. What this test guards against is the
    // 500 from createRequestScopedDb's "db.transaction() is not supported
    // through the request-scoped proxy" throw, which fires synchronously the
    // instant enqueueWakeup is called with an unscoped `rawDb` reference.
    expect(res.status, `unexpected response body: ${JSON.stringify(res.body)}`).toBe(202);
    expect(res.body).toMatchObject({ status: "skipped" });

    // The skip row itself is written from inside the withCompanyScope(rawDb,
    // ...) callback (see enqueueWakeup in services/heartbeat.ts) -- its
    // presence proves that transaction actually committed against a real
    // connection rather than throwing before ever reaching this insert.
    const [skippedRequest] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(skippedRequest).toMatchObject({
      agentId,
      companyId,
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
  });
});
