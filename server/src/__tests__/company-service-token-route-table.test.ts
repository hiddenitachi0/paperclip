import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyServiceTokens, createDb } from "@paperclipai/db";
import { SERVICE_TOKEN_SCOPES } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyServiceTokenService } from "../services/company-service-tokens.js";

/**
 * DUR-3977: what a company service token can reach IN THE REAL ROUTE TABLE.
 *
 * company-service-token-auth.test.ts probes four synthetic handlers, which is
 * why the original build shipped a token that could read the company
 * dashboard and call POST /api/chat/classify (an uncapped metered Anthropic
 * call): those routes call `assertCompanyAccess`, the service actor passed it
 * for its own company, and no test ever pointed the credential at a route
 * anyone actually serves.
 *
 * This file mounts the routers as app.ts mounts them and drives them with a
 * real token through the real auth middleware. It is the pinned list the
 * review asked for before this credential is handed to the Nordstrand
 * dashboard: the transform lane is reachable, and everything named below is
 * not.
 */

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

// The classifier would make a real model call if a route ever got that far.
// Making it throw turns "reached the handler" into a loud failure rather than
// a network attempt: any status other than 403 fails the test either way.
vi.mock("../services/secretary-classifier.js", () => ({
  secretaryClassifierService: () => ({
    classify: vi.fn(async () => {
      throw new Error("a service token must never reach the classifier");
    }),
  }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping service-token route-table test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("DUR-3977: which real routes a company service token reaches", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let companyId!: string;
  let agentId!: string;
  let token!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dur3977-route-table-");
    db = createDb(tempDb.connectionString);

    const [
      { errorHandler },
      { actorMiddleware },
      { laneARoutes },
      { chatRouterRoutes },
      { dashboardRoutes },
      { agentRoutes },
      { companyRoutes },
      { activityRoutes },
      { costRoutes },
      { accessRoutes },
    ] = await Promise.all([
      import("../middleware/index.js"),
      import("../middleware/auth.js"),
      import("../routes/lane-a.js"),
      import("../routes/chat-router.js"),
      import("../routes/dashboard.js"),
      import("../routes/agents.js"),
      import("../routes/companies.js"),
      import("../routes/activity.js"),
      import("../routes/costs.js"),
      import("../routes/access.js"),
    ]);

    const storageStub = {} as never;
    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    const api = express.Router();
    api.use(laneARoutes(db));
    api.use(chatRouterRoutes(db));
    api.use(dashboardRoutes(db));
    api.use(agentRoutes(db, {}));
    api.use(activityRoutes(db));
    api.use(costRoutes(db));
    api.use(
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "local",
        bindHost: "127.0.0.1",
        allowedHostnames: ["localhost"],
      }),
    );
    api.use("/companies", companyRoutes(db, storageStub));
    app.use("/api", api);
    app.use("/api", (_req, res) => {
      res.status(404).json({ error: "API route not found" });
    });
    app.use(errorHandler);
  }, 60_000);

  afterEach(async () => {
    await db.delete(companyServiceTokens);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Nordstrand",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Produkttekster",
      role: "general",
      status: "idle",
      laneAEnabled: true,
    });
    const created = await companyServiceTokenService(db).createToken({
      companyId,
      name: "Nordstrand dashboard",
      createdByUserId: null,
      scopes: [...SERVICE_TOKEN_SCOPES],
    });
    token = created.token;
  }

  function auth(req: request.Test) {
    return req.set("authorization", `Bearer ${token}`);
  }

  /**
   * The pinned list. Every one of these is a real, mounted route that calls
   * `assertCompanyAccess` for a company the token legitimately belongs to —
   * which is exactly the shape that used to let the credential through.
   *
   * The two the review called out by name are first. The rest are here
   * because "the dashboard can also download our issue attachments" must be a
   * decision someone made, not a consequence of which helper a 2024 route
   * reached for.
   */
  const forbiddenRoutes: Array<{ what: string; call: (a: express.Express) => request.Test }> = [
    {
      what: "the company dashboard",
      call: (a) => request(a).get(`/api/companies/${companyId}/dashboard`),
    },
    {
      // The metered-spend hole specifically: an uncapped Anthropic call, with
      // no daily cap, no budget metric and no concurrency limit behind it.
      what: "the chat classifier (an uncapped metered model call)",
      call: (a) => request(a).post("/api/chat/classify").send({ companyId, message: "hei" }),
    },
    {
      what: "the chat send path (the other way to spend on the model)",
      call: (a) =>
        request(a).post(`/api/chat/${agentId}/messages`).send({ companyId, message: "hei" }),
    },
    {
      what: "Lane A chat, which keeps a transcript",
      call: (a) =>
        request(a).post(`/api/lane-a/${agentId}/messages`).send({ companyId, message: "hei" }),
    },
    {
      what: "the company's agent roster",
      call: (a) => request(a).get(`/api/companies/${companyId}/agents`),
    },
    {
      what: "one agent's full configuration",
      call: (a) => request(a).get(`/api/agents/${agentId}`),
    },
    {
      what: "the activity log",
      call: (a) => request(a).get(`/api/companies/${companyId}/activity`),
    },
    {
      what: "the cost summary",
      call: (a) => request(a).get(`/api/companies/${companyId}/costs/summary`),
    },
    {
      what: "minting another service token",
      call: (a) =>
        request(a).post(`/api/companies/${companyId}/service-tokens`).send({ name: "self-issued" }),
    },
    {
      what: "listing this company's service tokens",
      call: (a) => request(a).get(`/api/companies/${companyId}/service-tokens`),
    },
  ];

  for (const route of forbiddenRoutes) {
    it(`is refused by ${route.what}`, async () => {
      await seed();
      const res = await auth(route.call(app));
      expect(res.status, `${route.what} answered ${res.status}: ${JSON.stringify(res.body)}`).toBe(403);
    });
  }

  it("reaches the transform lane it was issued for", async () => {
    await seed();
    // No ANTHROPIC_API_KEY in the test environment, so the call gets as far as
    // the model and stops with 503. The point is that it is NOT 403: the
    // credential passed every authorization gate and entered the handler.
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await auth(
        request(app).post(`/api/lane-a/${agentId}/transform`).send({ input: "Stol i eik." }),
      );
      expect(res.status).toBe(503);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("reaches the agent-discovery read it was issued for", async () => {
    await seed();
    const res = await auth(request(app).get("/api/lane-a/agents"));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0]).toMatchObject({ id: agentId, name: "Produkttekster", usable: true });
  });

  it("loses both once the token is revoked, with the same 403 as an unknown token", async () => {
    await seed();
    const [row] = await db.select().from(companyServiceTokens);
    await companyServiceTokenService(db).revokeToken({
      tokenId: row!.id,
      companyId,
      revokedByUserId: null,
    });

    const discovery = await auth(request(app).get("/api/lane-a/agents"));
    const transform = await auth(
      request(app).post(`/api/lane-a/${agentId}/transform`).send({ input: "Stol i eik." }),
    );

    expect(discovery.status).toBe(403);
    expect(transform.status).toBe(403);
    expect(discovery.body.error).toBe("A company service token or board access is required");
  });

  it("loses both when the token's scope is taken away", async () => {
    await seed();
    await db.update(companyServiceTokens).set({ scopes: [] }).where(eq(companyServiceTokens.companyId, companyId));

    const discovery = await auth(request(app).get("/api/lane-a/agents"));
    const transform = await auth(
      request(app).post(`/api/lane-a/${agentId}/transform`).send({ input: "Stol i eik." }),
    );

    expect(discovery.status).toBe(403);
    expect(transform.status).toBe(403);
    expect(discovery.body.error).toContain("not scoped for lane_a:transform");
  });
});
