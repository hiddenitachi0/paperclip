import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  approvals,
  companies,
  companySecretBindings,
  companySecrets,
  companySkills,
  createDb,
  documents,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  laneAConversations,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
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

// The plugin router needs a registry/lifecycle to boot; only its
// authorization gate on POST /plugins/tools/execute is under test here, and
// that gate runs before either dependency is touched.
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getById: vi.fn().mockResolvedValue(null),
    getByKey: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
  }),
}));
vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({ load: vi.fn(), unload: vi.fn() }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cross-company isolation audit on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

/**
 * Everything seeded for one company. Every human-readable field carries the
 * company's MARKER so a leak is detectable by a plain substring search over
 * the response body, whatever shape the route returns.
 */
interface SeededCompany {
  id: string;
  marker: string;
  issuePrefix: string;
  agentId: string;
  liaisonAgentId: string;
  agentApiKey: string;
  projectId: string;
  projectWorkspaceId: string;
  executionWorkspaceId: string;
  goalId: string;
  issueId: string;
  commentId: string;
  documentId: string;
  secretId: string;
  secretBindingId: string;
  skillId: string;
  approvalId: string;
  runId: string;
  laneAConversationId: string;
  /** Every id above, for the "no B id appears in an A response" check. */
  ids: string[];
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function seedCompany(db: Db, label: "A" | "B"): Promise<SeededCompany> {
  const marker = `ISOLATION-MARKER-${label}-${randomUUID().slice(0, 8)}`;
  const issuePrefix = `ISO${label}${randomUUID().replace(/-/g, "").slice(0, 3).toUpperCase()}`;
  const [company] = await db
    .insert(companies)
    .values({ name: `Company ${label} ${marker}`, description: `Description ${marker}`, issuePrefix })
    .returning();
  const companyId = company!.id;

  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      name: `Engineer ${marker}`,
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { note: `adapter ${marker}` },
      runtimeConfig: {},
      permissions: {},
      capabilities: `capabilities ${marker}`,
    })
    .returning();
  const [liaison] = await db
    .insert(agents)
    .values({
      companyId,
      name: `Tech Boss ${marker}`,
      role: "tech_boss",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })
    .returning();

  const agentApiKey = `pcp_test_${label}_${randomUUID().replace(/-/g, "")}`;
  await db.insert(agentApiKeys).values({
    agentId: agent!.id,
    companyId,
    name: `key ${marker}`,
    keyHash: sha256(agentApiKey),
  });

  const [project] = await db
    .insert(projects)
    .values({ companyId, name: `Project ${marker}`, description: `Project description ${marker}` })
    .returning();
  const [projectWorkspace] = await db
    .insert(projectWorkspaces)
    .values({ companyId, projectId: project!.id, name: `Workspace ${marker}`, cwd: `/tmp/${marker}` })
    .returning();
  const [executionWorkspace] = await db
    .insert(executionWorkspaces)
    .values({
      companyId,
      projectId: project!.id,
      projectWorkspaceId: projectWorkspace!.id,
      mode: "isolated",
      strategyType: "git_worktree",
      name: `Execution workspace ${marker}`,
    })
    .returning();
  const [goal] = await db
    .insert(goals)
    .values({ companyId, title: `Goal ${marker}`, description: `Goal description ${marker}` })
    .returning();

  const [issue] = await db
    .insert(issues)
    .values({
      companyId,
      identifier: `${issuePrefix}-1`,
      title: `Issue ${marker}`,
      description: `Issue description ${marker}`,
      status: "todo",
      priority: "medium",
      projectId: project!.id,
      goalId: goal!.id,
      assigneeAgentId: agent!.id,
    })
    .returning();
  const [comment] = await db
    .insert(issueComments)
    .values({ companyId, issueId: issue!.id, body: `Comment ${marker}`, authorAgentId: agent!.id })
    .returning();
  const [document] = await db
    .insert(documents)
    .values({ companyId, title: `Document ${marker}`, latestBody: `Document body ${marker}` })
    .returning();
  await db.insert(issueDocuments).values({
    companyId,
    issueId: issue!.id,
    documentId: document!.id,
    key: "plan",
  });

  const [secret] = await db
    .insert(companySecrets)
    .values({
      companyId,
      key: `SECRET_${label}`,
      name: `Secret ${marker}`,
      description: `Secret description ${marker}`,
      provider: "local_encrypted",
      status: "active",
      managedMode: "paperclip_managed",
    })
    .returning();
  const [binding] = await db
    .insert(companySecretBindings)
    .values({
      companyId,
      secretId: secret!.id,
      targetType: "agent",
      targetId: agent!.id,
      configPath: `env.SECRET_${label}`,
    })
    .returning();

  const [skill] = await db
    .insert(companySkills)
    .values({
      companyId,
      key: `skill-${label.toLowerCase()}`,
      slug: `skill-${label.toLowerCase()}`,
      name: `Skill ${marker}`,
      description: `Skill description ${marker}`,
      markdown: `# Skill ${marker}`,
    })
    .returning();

  const [approval] = await db
    .insert(approvals)
    .values({
      companyId,
      type: "request_board_approval",
      requestedByAgentId: agent!.id,
      status: "pending",
      payload: { kind: "generic", title: `Approval ${marker}`, summary: `Approval summary ${marker}` },
    })
    .returning();

  const [run] = await db
    .insert(heartbeatRuns)
    .values({
      companyId,
      agentId: agent!.id,
      status: "succeeded",
      triggerDetail: "manual",
      contextSnapshot: { note: `run ${marker}` },
    })
    .returning();

  const [conversation] = await db
    .insert(laneAConversations)
    .values({
      companyId,
      agentId: agent!.id,
      title: `Conversation ${marker}`,
      messages: [{ role: "user", content: `Hello ${marker}` }],
    })
    .returning();

  await db.insert(activityLog).values({
    companyId,
    actorType: "agent",
    actorId: agent!.id,
    action: "issue.created",
    entityType: "issue",
    entityId: issue!.id,
    agentId: agent!.id,
    details: { note: `activity ${marker}` },
  });

  const seeded: SeededCompany = {
    id: companyId,
    marker,
    issuePrefix,
    agentId: agent!.id,
    liaisonAgentId: liaison!.id,
    agentApiKey,
    projectId: project!.id,
    projectWorkspaceId: projectWorkspace!.id,
    executionWorkspaceId: executionWorkspace!.id,
    goalId: goal!.id,
    issueId: issue!.id,
    commentId: comment!.id,
    documentId: document!.id,
    secretId: secret!.id,
    secretBindingId: binding!.id,
    skillId: skill!.id,
    approvalId: approval!.id,
    runId: run!.id,
    laneAConversationId: conversation!.id,
    ids: [],
  };
  seeded.ids = [
    seeded.id,
    seeded.agentId,
    seeded.liaisonAgentId,
    seeded.projectId,
    seeded.projectWorkspaceId,
    seeded.executionWorkspaceId,
    seeded.goalId,
    seeded.issueId,
    seeded.commentId,
    seeded.documentId,
    seeded.secretId,
    seeded.secretBindingId,
    seeded.skillId,
    seeded.approvalId,
    seeded.runId,
    seeded.laneAConversationId,
  ];
  return seeded;
}

const BLOCKED_STATUSES = new Set([400, 401, 403, 404, 422]);

describeEmbeddedPostgres("cross-company isolation audit: nothing from company B is visible or writable from company A", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let A!: SeededCompany;
  let B!: SeededCompany;
  /** Requests carry company A's real agent API key through the real auth middleware. */
  let agentApp!: express.Express;
  /** Requests carry a board session whose only membership is company A. */
  let boardApp!: express.Express;
  const boardUserId = randomUUID();

  async function buildApp(actorSetup: express.RequestHandler) {
    const [
      { errorHandler },
      { companyRoutes },
      { companySkillRoutes },
      { agentRoutes },
      { projectRoutes },
      { issueRoutes },
      { executionWorkspaceRoutes },
      { goalRoutes },
      { laneARoutes },
      { chatRouterRoutes },
      { approvalRoutes },
      { secretRoutes },
      { activityRoutes },
      { dashboardRoutes },
      { pluginRoutes },
      { crossCompanyInstructionRoutes },
    ] = await Promise.all([
      import("../middleware/index.js"),
      import("../routes/companies.js"),
      import("../routes/company-skills.js"),
      import("../routes/agents.js"),
      import("../routes/projects.js"),
      import("../routes/issues.js"),
      import("../routes/execution-workspaces.js"),
      import("../routes/goals.js"),
      import("../routes/lane-a.js"),
      import("../routes/chat-router.js"),
      import("../routes/approvals.js"),
      import("../routes/secrets.js"),
      import("../routes/activity.js"),
      import("../routes/dashboard.js"),
      import("../routes/plugins.js"),
      import("../routes/cross-company-instructions.js"),
    ]);
    const storageStub = {} as never;
    const app = express();
    app.use(express.json());
    app.use(actorSetup);
    const api = express.Router();
    api.use("/companies", companyRoutes(db, storageStub));
    api.use(companySkillRoutes(db));
    api.use(agentRoutes(db, {}));
    api.use(projectRoutes(db));
    api.use(issueRoutes(db, storageStub, {}));
    api.use(executionWorkspaceRoutes(db, {}));
    api.use(goalRoutes(db));
    api.use(laneARoutes(db));
    api.use(chatRouterRoutes(db));
    api.use(approvalRoutes(db, {}));
    api.use(secretRoutes(db));
    api.use(activityRoutes(db));
    api.use(dashboardRoutes(db));
    api.use(crossCompanyInstructionRoutes(db));
    api.use(
      pluginRoutes(
        db,
        { installPlugin: vi.fn() } as never,
        undefined,
        undefined,
        // A dispatcher stub so the route reaches its company check instead
        // of short-circuiting with "dispatch is not enabled"; the check
        // runs before the dispatcher is ever called.
        { toolDispatcher: { execute: vi.fn(), listTools: vi.fn().mockResolvedValue([]) } } as never,
        { workerManager: { isRunning: () => true, call: vi.fn() } } as never,
      ),
    );
    app.use("/api", api);
    app.use("/api", (_req, res) => {
      res.status(404).json({ error: "API route not found" });
    });
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-company-isolation-audit-");
    db = createDb(tempDb.connectionString);
    A = await seedCompany(db, "A");
    B = await seedCompany(db, "B");

    const { actorMiddleware } = await import("../middleware/auth.js");
    agentApp = await buildApp(actorMiddleware(db, { deploymentMode: "authenticated" }));
    boardApp = await buildApp((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "session",
        userId: boardUserId,
        companyIds: [A.id],
        memberships: [{ companyId: A.id, membershipRole: "admin", status: "active" }],
        isInstanceAdmin: false,
      } as typeof req.actor;
      next();
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const asAgentA = () => ({
    get: (url: string) => request(agentApp).get(url).set("Authorization", `Bearer ${A.agentApiKey}`),
    post: (url: string) => request(agentApp).post(url).set("Authorization", `Bearer ${A.agentApiKey}`),
    patch: (url: string) => request(agentApp).patch(url).set("Authorization", `Bearer ${A.agentApiKey}`),
    delete: (url: string) => request(agentApp).delete(url).set("Authorization", `Bearer ${A.agentApiKey}`),
  });
  const asBoardA = () => ({
    get: (url: string) => request(boardApp).get(url),
    post: (url: string) => request(boardApp).post(url),
    patch: (url: string) => request(boardApp).patch(url),
    delete: (url: string) => request(boardApp).delete(url),
  });

  /**
   * A response is clean when (a) it did not succeed, and (b) neither the
   * marker text nor any id from company B appears anywhere in the body.
   * Checking the body as well as the status catches the "403 but the error
   * message echoes the foreign row" and "200 with an empty-looking wrapper
   * that still carries a foreign id" shapes.
   */
  function expectBlockedAndClean(res: request.Response, label: string) {
    const body = JSON.stringify(res.body ?? {}) + (res.text ?? "");
    expect(BLOCKED_STATUSES.has(res.status), `${label}: expected a blocked status, got ${res.status} ${body.slice(0, 300)}`).toBe(true);
    expect(body, `${label}: company B marker leaked`).not.toContain(B.marker);
    for (const id of B.ids) {
      expect(body, `${label}: company B id ${id} leaked`).not.toContain(id);
    }
  }

  /**
   * Runs every probe and reports ALL failures at once, so one leak never
   * hides the next one in the same route family.
   */
  async function collectFailures(
    probes: Array<[string, () => request.Test]>,
    check: (res: request.Response, label: string) => void,
  ) {
    const failures: string[] = [];
    for (const [label, run] of probes) {
      const res = await run();
      try {
        check(res, label);
      } catch (err) {
        failures.push((err as Error).message.split("\n")[0] ?? label);
      }
    }
    return failures;
  }

  /** A successful company-A response must still carry nothing from company B. */
  function expectOkAndClean(res: request.Response, label: string) {
    const body = JSON.stringify(res.body ?? {});
    expect(res.status, `${label}: ${body.slice(0, 300)}`).toBe(200);
    expect(body, `${label}: company B marker leaked into a company A response`).not.toContain(B.marker);
    for (const id of B.ids) {
      expect(body, `${label}: company B id ${id} leaked into a company A response`).not.toContain(id);
    }
  }

  /**
   * The search route echoes the caller's own query text back (`query` /
   * `normalizedQuery`), so the marker legitimately appears there. What must
   * not appear is any *result* from company B. A board session without the
   * default permission grants may be refused outright (403) -- also clean.
   */
  function expectSearchClean(res: request.Response, label: string) {
    if (res.status === 403) {
      expectBlockedAndClean(res, label);
      return;
    }
    expect(res.status, `${label}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    expect(res.body.results, `${label}: search returned company B rows`).toEqual([]);
    const resultsBody = JSON.stringify({ ...res.body, query: undefined, normalizedQuery: undefined });
    expect(resultsBody, `${label}: company B marker leaked`).not.toContain(B.marker);
    for (const id of B.ids) {
      expect(resultsBody, `${label}: company B id ${id} leaked`).not.toContain(id);
    }
  }

  function readProbes(target: SeededCompany) {
    return [
      `/api/companies/${target.id}`,
      `/api/companies/${target.id}/agents`,
      `/api/companies/${target.id}/agent-configurations`,
      `/api/companies/${target.id}/org`,
      `/api/companies/${target.id}/issues`,
      `/api/companies/${target.id}/search?q=${encodeURIComponent(target.marker)}`,
      `/api/companies/${target.id}/approvals`,
      `/api/companies/${target.id}/activity`,
      `/api/companies/${target.id}/secrets`,
      `/api/companies/${target.id}/secret-providers`,
      `/api/companies/${target.id}/secret-provider-configs`,
      `/api/companies/${target.id}/skills`,
      `/api/companies/${target.id}/execution-workspaces`,
      `/api/companies/${target.id}/workspace-overview`,
      `/api/companies/${target.id}/projects`,
      `/api/companies/${target.id}/goals`,
      `/api/companies/${target.id}/heartbeat-runs`,
      `/api/companies/${target.id}/live-runs`,
      `/api/companies/${target.id}/dashboard`,
      `/api/companies/${target.id}/timeline`,
      `/api/companies/${target.id}/instructions`,
      `/api/companies/${target.id}/cross-company-instructions`,
      `/api/agents/${target.agentId}`,
      `/api/agents/${target.agentId}/configuration`,
      `/api/agents/${target.agentId}/keys`,
      `/api/agents/${target.agentId}/skills`,
      `/api/agents/${target.agentId}/runtime-state`,
      `/api/agents/${target.agentId}/task-sessions`,
      `/api/agents/${target.agentId}/config-revisions`,
      `/api/agents/${target.agentId}/instructions-bundle`,
      `/api/agents/${target.agentId}/plugin-tool-grants`,
      `/api/issues/${target.issueId}`,
      `/api/issues/${target.issueId}/comments`,
      `/api/issues/${target.issueId}/documents`,
      `/api/issues/${target.issueId}/activity`,
      `/api/issues/${target.issueId}/runs`,
      `/api/approvals/${target.approvalId}`,
      `/api/approvals/${target.approvalId}/comments`,
      `/api/approvals/${target.approvalId}/issues`,
      `/api/secrets/${target.secretId}`,
      `/api/secrets/${target.secretId}/usage`,
      `/api/secrets/${target.secretId}/access-events`,
      `/api/companies/${target.id}/skills/${target.skillId}`,
      `/api/execution-workspaces/${target.executionWorkspaceId}`,
      `/api/projects/${target.projectId}`,
      `/api/heartbeat-runs/${target.runId}`,
      `/api/heartbeat-runs/${target.runId}/issues`,
    ];
  }

  describe("as company A's agent (real API key through the auth middleware)", () => {
    it("authenticates as company A and sees its own data", async () => {
      const me = await asAgentA().get("/api/agents/me");
      expect(me.status).toBe(200);
      expect(me.body.companyId).toBe(A.id);

      expectOkAndClean(await asAgentA().get(`/api/companies/${A.id}/issues`), "own issues");
      expectOkAndClean(await asAgentA().get(`/api/companies/${A.id}/agents`), "own agents");
      expectOkAndClean(await asAgentA().get(`/api/companies/${A.id}/approvals`), "own approvals");
      expectOkAndClean(await asAgentA().get(`/api/companies/${A.id}/activity`), "own activity");
      expectOkAndClean(await asAgentA().get(`/api/companies/${A.id}/skills`), "own skills");
      expectOkAndClean(await asAgentA().get(`/api/issues/${A.issueId}/documents`), "own documents");
    });

    it("cannot read any company B resource through any list/get route family", async () => {
      const failures = await collectFailures(
        readProbes(B).map((url) => [`agent GET ${url}`, () => asAgentA().get(url)] as [string, () => request.Test]),
        expectBlockedAndClean,
      );
      expect(failures).toEqual([]);
    });

    it("cannot list companies at all (board-only) and gets no company B row", async () => {
      expectBlockedAndClean(await asAgentA().get("/api/companies"), "agent GET /api/companies");
      expectBlockedAndClean(await asAgentA().get("/api/companies/stats"), "agent GET /api/companies/stats");
    });

    it("searching company A for company B's marker finds nothing", async () => {
      const res = await asAgentA().get(`/api/companies/${A.id}/search?q=${encodeURIComponent(B.marker)}`);
      expectSearchClean(res, "agent search A for B marker");
    });

    it("cannot write into company B", async () => {
      const probes: Array<[string, () => request.Test]> = [
        ["comment on B issue", () => asAgentA().post(`/api/issues/${B.issueId}/comments`).send({ body: "intrusion" })],
        ["patch B issue", () => asAgentA().patch(`/api/issues/${B.issueId}`).send({ title: "renamed by intruder" })],
        ["create issue in B", () => asAgentA().post(`/api/companies/${B.id}/issues`).send({ title: "intruder issue" })],
        ["create agent in B", () => asAgentA().post(`/api/companies/${B.id}/agents`).send({ name: "intruder", role: "engineer", adapterType: "process" })],
        ["patch B agent", () => asAgentA().patch(`/api/agents/${B.agentId}`).send({ name: "renamed" })],
        ["mint key for B agent", () => asAgentA().post(`/api/agents/${B.agentId}/keys`).send({ name: "intruder key" })],
        ["wake B agent", () => asAgentA().post(`/api/agents/${B.agentId}/wakeup`).send({})],
        ["create secret in B", () => asAgentA().post(`/api/companies/${B.id}/secrets`).send({ name: "INTRUDER", value: "x" })],
        ["create approval in B", () => asAgentA().post(`/api/companies/${B.id}/approvals`).send({ type: "request_board_approval", payload: { kind: "generic" } })],
        ["comment on B approval", () => asAgentA().post(`/api/approvals/${B.approvalId}/comments`).send({ body: "intrusion" })],
        ["lane-a message to B agent", () => asAgentA().post(`/api/lane-a/${B.agentId}/messages`).send({ companyId: B.id, message: "hello" })],
        ["lane-a message to B agent claiming company A", () => asAgentA().post(`/api/lane-a/${B.agentId}/messages`).send({ companyId: A.id, message: "hello" })],
        ["chat-router classify in B", () => asAgentA().post("/api/chat/classify").send({ companyId: B.id, message: "hello" })],
        ["chat-router message to B agent", () => asAgentA().post(`/api/chat/${B.agentId}/messages`).send({ companyId: B.id, message: "hello" })],
        ["chat-router message to B agent claiming company A", () => asAgentA().post(`/api/chat/${B.agentId}/messages`).send({ companyId: A.id, message: "hello" })],
        ["plugin tool execution in B", () => asAgentA().post("/api/plugins/tools/execute").send({
          tool: "anything",
          parameters: {},
          runContext: { agentId: A.agentId, runId: randomUUID(), companyId: B.id, projectId: B.projectId },
        })],
        ["patch B execution workspace", () => asAgentA().patch(`/api/execution-workspaces/${B.executionWorkspaceId}`).send({ name: "renamed" })],
        ["patch B company", () => asAgentA().patch(`/api/companies/${B.id}`).send({ name: "renamed" })],
        ["star B skill", () => asAgentA().post(`/api/companies/${B.id}/skills/${B.skillId}/star`).send({})],
        // The guarded channel itself: A cannot file an instruction "from" B,
        // and with the flag off (the default here) cannot file one at all.
        ["send instruction as B", () => asAgentA().post(`/api/companies/${B.id}/cross-company-instructions`).send({ toCompanyId: A.id, subject: "x", instruction: "y" })],
        ["send instruction to B with channel off", () => asAgentA().post(`/api/companies/${A.id}/cross-company-instructions`).send({ toCompanyId: B.id, subject: "x", instruction: "y" })],
      ];
      expect(await collectFailures(probes, (res, label) => expectBlockedAndClean(res, `agent ${label}`))).toEqual([]);

      const bIssue = await db.select().from(issues).where(eq(issues.id, B.issueId)).then((rows) => rows[0]!);
      expect(bIssue.title).toBe(`Issue ${B.marker}`);
      const bComments = await db.select().from(issueComments).where(eq(issueComments.issueId, B.issueId));
      expect(bComments).toHaveLength(1);
      const bAgent = await db.select().from(agents).where(eq(agents.id, B.agentId)).then((rows) => rows[0]!);
      expect(bAgent.name).toBe(`Engineer ${B.marker}`);
    });

    it("cannot smuggle a reference to a company B row into a company A write", async () => {
      const smuggles: Array<[string, () => request.Test]> = [
        ["assign A issue to B agent", () => asAgentA().patch(`/api/issues/${A.issueId}`).send({ assigneeAgentId: B.agentId })],
        ["parent A issue under B issue", () => asAgentA().patch(`/api/issues/${A.issueId}`).send({ parentId: B.issueId })],
        ["move A issue into B project", () => asAgentA().patch(`/api/issues/${A.issueId}`).send({ projectId: B.projectId })],
        ["move A issue onto B goal", () => asAgentA().patch(`/api/issues/${A.issueId}`).send({ goalId: B.goalId })],
        ["block A issue on B issue", () => asAgentA().patch(`/api/issues/${A.issueId}`).send({ blockedByIssueIds: [B.issueId] })],
        ["move A issue into B execution workspace", () => asAgentA().patch(`/api/issues/${A.issueId}`).send({ projectWorkspaceId: B.projectWorkspaceId })],
        ["create A issue assigned to B agent", () => asAgentA().post(`/api/companies/${A.id}/issues`).send({ title: "smuggle", assigneeAgentId: B.agentId })],
        ["create A issue under B parent", () => asAgentA().post(`/api/companies/${A.id}/issues`).send({ title: "smuggle", parentId: B.issueId })],
        ["create A issue in B project", () => asAgentA().post(`/api/companies/${A.id}/issues`).send({ title: "smuggle", projectId: B.projectId })],
        ["create A issue on B goal", () => asAgentA().post(`/api/companies/${A.id}/issues`).send({ title: "smuggle", goalId: B.goalId })],
        ["create A issue blocked by B issue", () => asAgentA().post(`/api/companies/${A.id}/issues`).send({ title: "smuggle", blockedByIssueIds: [B.issueId] })],
        ["link A approval to B issue", () => asAgentA().post(`/api/companies/${A.id}/approvals`).send({ type: "request_board_approval", payload: { kind: "generic", title: "smuggle" }, issueIds: [B.issueId] })],
      ];
      const failures = await collectFailures(smuggles, (res, label) => {
        const body = JSON.stringify(res.body ?? {});
        expect(res.status >= 400, `agent ${label}: expected rejection, got ${res.status} ${body.slice(0, 300)}`).toBe(true);
        expect(body, `agent ${label}: company B marker leaked`).not.toContain(B.marker);
      });
      expect(failures).toEqual([]);

      const aIssue = await db.select().from(issues).where(eq(issues.id, A.issueId)).then((rows) => rows[0]!);
      expect(aIssue.assigneeAgentId).toBe(A.agentId);
      expect(aIssue.parentId).toBeNull();
      expect(aIssue.projectId).toBe(A.projectId);
      expect(aIssue.goalId).toBe(A.goalId);
      const aIssues = await db.select().from(issues).where(eq(issues.companyId, A.id));
      expect(aIssues).toHaveLength(1);
    });
  });

  describe("as a board user whose only company is A", () => {
    it("lists only company A", async () => {
      const list = await asBoardA().get("/api/companies");
      expectOkAndClean(list, "board GET /api/companies");
      expect(list.body.map((c: { id: string }) => c.id)).toEqual([A.id]);

      const stats = await asBoardA().get("/api/companies/stats");
      expectOkAndClean(stats, "board GET /api/companies/stats");
      expect(Object.keys(stats.body)).not.toContain(B.id);
    });

    it("cannot read any company B resource through any list/get route family", async () => {
      const failures = await collectFailures(
        readProbes(B).map((url) => [`board GET ${url}`, () => asBoardA().get(url)] as [string, () => request.Test]),
        expectBlockedAndClean,
      );
      expect(failures).toEqual([]);
    });

    it("searching company A for company B's marker finds nothing", async () => {
      expectSearchClean(
        await asBoardA().get(`/api/companies/${A.id}/search?q=${encodeURIComponent(B.marker)}`),
        "board search A for B marker",
      );
    });

    it("cannot decide or write into company B", async () => {
      const probes: Array<[string, () => request.Test]> = [
        ["approve B approval", () => asBoardA().post(`/api/approvals/${B.approvalId}/approve`).send({})],
        ["reject B approval", () => asBoardA().post(`/api/approvals/${B.approvalId}/reject`).send({})],
        ["comment on B issue", () => asBoardA().post(`/api/issues/${B.issueId}/comments`).send({ body: "intrusion" })],
        ["patch B issue", () => asBoardA().patch(`/api/issues/${B.issueId}`).send({ title: "renamed" })],
        ["create issue in B", () => asBoardA().post(`/api/companies/${B.id}/issues`).send({ title: "intruder" })],
        ["patch B agent", () => asBoardA().patch(`/api/agents/${B.agentId}`).send({ name: "renamed" })],
        ["terminate B agent", () => asBoardA().post(`/api/agents/${B.agentId}/terminate`).send({})],
        ["wake B agent", () => asBoardA().post(`/api/agents/${B.agentId}/wakeup`).send({})],
        ["create secret in B", () => asBoardA().post(`/api/companies/${B.id}/secrets`).send({ name: "INTRUDER", value: "x" })],
        ["delete B secret", () => asBoardA().delete(`/api/secrets/${B.secretId}`)],
        ["patch B company", () => asBoardA().patch(`/api/companies/${B.id}`).send({ name: "renamed" })],
        ["archive B company", () => asBoardA().post(`/api/companies/${B.id}/archive`).send({})],
        ["lane-a message to B agent", () => asBoardA().post(`/api/lane-a/${B.agentId}/messages`).send({ companyId: B.id, message: "hello" })],
        ["chat-router message to B agent", () => asBoardA().post(`/api/chat/${B.agentId}/messages`).send({ companyId: B.id, message: "hello" })],
        ["plugin tool execution in B", () => asBoardA().post("/api/plugins/tools/execute").send({
          tool: "anything",
          parameters: {},
          runContext: { agentId: B.agentId, runId: randomUUID(), companyId: B.id, projectId: B.projectId },
        })],
      ];
      expect(await collectFailures(probes, (res, label) => expectBlockedAndClean(res, `board ${label}`))).toEqual([]);

      const bApproval = await db.select().from(approvals).where(eq(approvals.id, B.approvalId)).then((rows) => rows[0]!);
      expect(bApproval.status).toBe("pending");
      const bAgent = await db.select().from(agents).where(eq(agents.id, B.agentId)).then((rows) => rows[0]!);
      expect(bAgent.status).toBe("active");
      const bSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, B.id));
      expect(bSecrets).toHaveLength(1);
    });
  });

  it("company B's data is still intact after every probe", async () => {
    const bCompany = await db.select().from(companies).where(eq(companies.id, B.id)).then((rows) => rows[0]!);
    expect(bCompany.name).toBe(`Company B ${B.marker}`);
    expect(bCompany.status).toBe("active");
  });
});
