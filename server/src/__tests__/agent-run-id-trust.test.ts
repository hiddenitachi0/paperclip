import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentApiKeys, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware, resolveAgentKeyRunId } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

/**
 * DUR-3992: an agent must not be able to act as a run it does not own just by
 * sending a different `x-paperclip-run-id` header. Checkout ownership, the
 * self-review-pass bypass and run budget attribution all trust actor.runId.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function createProbeApp(db: Db, deploymentMode: "authenticated" | "local_trusted" = "authenticated") {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode, resolveSession: async () => null }));
  app.get("/actor", (req, res) => res.json(req.actor));
  return app;
}

describeEmbeddedPostgres("DUR-3992: agent run id comes from something the server trusts", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "dur3992-test-secret-not-a-real-credential";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dur3992-run-id-trust-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(agentApiKeys);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousJwtSecret;
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Durkan") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(companyId: string, agentId: string, status: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status,
      invocationSource: "on_demand",
    });
    return runId;
  }

  async function seedApiKey(companyId: string, agentId: string) {
    const token = `pcp_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(agentApiKeys).values({
      agentId,
      companyId,
      name: "test key",
      keyHash: createHash("sha256").update(token).digest("hex"),
    });
    return token;
  }

  async function getActor(token: string | null, runIdHeader?: string) {
    let req = request(createProbeApp(db)).get("/actor");
    if (token) req = req.set("authorization", `Bearer ${token}`);
    if (runIdHeader !== undefined) req = req.set("x-paperclip-run-id", runIdHeader);
    const res = await req;
    expect(res.status).toBe(200);
    return res.body as { type: string; agentId?: string; runId?: string; source: string };
  }

  describe("signed agent JWT", () => {
    it("keeps the signed run when the header matches it", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Builder");
      const runId = await seedRun(companyId, agentId, "running");
      const jwt = createLocalAgentJwt(agentId, companyId, "claude_local", runId)!;
      expect(jwt).toBeTruthy();

      const actor = await getActor(jwt, runId);
      expect(actor).toMatchObject({ type: "agent", agentId, runId, source: "agent_jwt" });
    });

    it("ignores a header naming a different run (another agent's) and keeps the signed run", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Builder");
      const otherAgentId = await seedAgent(companyId, "Reviewer");
      const runId = await seedRun(companyId, agentId, "running");
      const otherRunId = await seedRun(companyId, otherAgentId, "running");
      const jwt = createLocalAgentJwt(agentId, companyId, "claude_local", runId)!;

      const actor = await getActor(jwt, otherRunId);
      expect(actor).toMatchObject({ type: "agent", agentId, runId, source: "agent_jwt" });
      expect(actor.runId).not.toBe(otherRunId);
    });

    it("uses the signed run when no header is sent", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Builder");
      const runId = await seedRun(companyId, agentId, "running");
      const jwt = createLocalAgentJwt(agentId, companyId, "claude_local", runId)!;

      const actor = await getActor(jwt);
      expect(actor).toMatchObject({ type: "agent", agentId, runId, source: "agent_jwt" });
    });
  });

  describe("agent API key", () => {
    it("accepts the header when it names this agent's own active run", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Builder");
      const runningRunId = await seedRun(companyId, agentId, "running");
      const queuedRunId = await seedRun(companyId, agentId, "queued");
      const token = await seedApiKey(companyId, agentId);

      expect(await getActor(token, runningRunId)).toMatchObject({
        type: "agent",
        agentId,
        runId: runningRunId,
        source: "agent_key",
      });
      expect((await getActor(token, queuedRunId)).runId).toBe(queuedRunId);
    });

    it("drops the header when it names another agent's run in the same company", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Builder");
      const otherAgentId = await seedAgent(companyId, "Reviewer");
      const otherRunId = await seedRun(companyId, otherAgentId, "running");
      const token = await seedApiKey(companyId, agentId);

      const actor = await getActor(token, otherRunId);
      expect(actor).toMatchObject({ type: "agent", agentId, source: "agent_key" });
      expect(actor.runId).toBeUndefined();
    });

    it("drops the header when it names a run in another company", async () => {
      const companyId = await seedCompany("Durkan");
      const otherCompanyId = await seedCompany("Nordstrand");
      const agentId = await seedAgent(companyId, "Builder");
      const foreignAgentId = await seedAgent(otherCompanyId, "Foreign");
      const foreignRunId = await seedRun(otherCompanyId, foreignAgentId, "running");
      const token = await seedApiKey(companyId, agentId);

      const actor = await getActor(token, foreignRunId);
      expect(actor).toMatchObject({ type: "agent", agentId, companyId, source: "agent_key" });
      expect(actor.runId).toBeUndefined();
    });

    it("drops the header when this agent's run has already finished", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Builder");
      const token = await seedApiKey(companyId, agentId);

      for (const status of ["succeeded", "failed", "cancelled", "timed_out"]) {
        const finishedRunId = await seedRun(companyId, agentId, status);
        const actor = await getActor(token, finishedRunId);
        expect(actor).toMatchObject({ type: "agent", agentId, source: "agent_key" });
        expect(actor.runId, `status ${status}`).toBeUndefined();
      }
    });

    it("drops a header naming a run that does not exist, or that is not a run id at all", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Builder");
      const token = await seedApiKey(companyId, agentId);

      expect((await getActor(token, randomUUID())).runId).toBeUndefined();
      expect((await getActor(token, "not-a-uuid")).runId).toBeUndefined();
    });

    it("has no run id when no header is sent", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "Builder");
      const token = await seedApiKey(companyId, agentId);

      const actor = await getActor(token);
      expect(actor).toMatchObject({ type: "agent", agentId, source: "agent_key" });
      expect(actor.runId).toBeUndefined();
    });
  });

  it("fails open to the header as sent if the run lookup itself errors", async () => {
    // Only this one case uses a broken database on purpose: it is the
    // "unexpected error" path, which must never block the agent's action.
    const brokenDb = {
      select: () => {
        throw new Error("connection reset");
      },
    } as unknown as Db;
    const headerRunId = randomUUID();
    await expect(
      resolveAgentKeyRunId(brokenDb, {
        runIdHeader: headerRunId,
        agentId: randomUUID(),
        companyId: randomUUID(),
        keyId: randomUUID(),
      }),
    ).resolves.toBe(headerRunId);
  });

  describe("board / no bearer (unchanged)", () => {
    it("still passes the header through for the local implicit board", async () => {
      const headerRunId = randomUUID();
      const res = await request(createProbeApp(db, "local_trusted"))
        .get("/actor")
        .set("x-paperclip-run-id", headerRunId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ type: "board", source: "local_implicit", runId: headerRunId });
    });
  });
});
