import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { Router } from "express";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  approvals,
  authUsers,
  boardChatActions,
  boardChatCompanySettings,
  boardChatRuns,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  instanceUserRoles,
  agents,
  goals,
  issueComments,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * Board chat on a signed-in Paperclip, end to end over real HTTP with a real
 * database. The model runs in-process (a scripted fake Claude client; no
 * model is ever called) and its tools are in-process requests into this same
 * app. There is no child process and no credential on the signed-in path.
 */

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping Board chat signed-in tests: ${support.reason ?? "embedded Postgres unsupported"}`);
}

type ScriptStep =
  | { text: string }
  | { tool: string; input: Record<string, unknown> };

function anthropicMessage(steps: ScriptStep[]) {
  const content = steps.map((step, index) =>
    "tool" in step
      ? { type: "tool_use", id: `tool-${index}-${Math.random().toString(36).slice(2, 8)}`, name: step.tool, input: step.input }
      : { type: "text", text: step.text },
  );
  const usesTools = steps.some((step) => "tool" in step);
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    type: "message",
    role: "assistant",
    model: "claude-test",
    content,
    stop_reason: usesTools ? "tool_use" : "end_turn",
    usage: { input_tokens: 1000, output_tokens: 50 },
  };
}

describeDb("Board chat on a signed-in server", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: http.Server | null = null;
  let testApp: any = null;
  let base = "";
  const spawnSpy = vi.fn();
  const targetCalls: Array<{ route: string; body: unknown; actor: any }> = [];
  let script: ScriptStep[][] = [];
  let onModelCall: (() => Promise<void>) | null = null;
  const modelCalls: Array<{ tools?: Array<{ name: string }>; messages: unknown[]; system: string }> = [];

  let companyA = "";
  let companyB = "";
  const owner = `owner-${randomUUID()}`;
  const owner2 = `owner2-${randomUUID()}`;
  const admin = `admin-${randomUUID()}`;
  const member = `member-${randomUUID()}`;
  const outsider = `outsider-${randomUUID()}`;
  const instanceAdmin = `iadmin-${randomUUID()}`;
  const loneInstanceAdmin = `loneadmin-${randomUUID()}`;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-chat-signed-in-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    spawnSpy.mockReset();
    targetCalls.length = 0;
    modelCalls.length = 0;
    script = [];
    onModelCall = null;
    companyA = randomUUID();
    companyB = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "Alpha Co", issuePrefix: `A${companyA.slice(0, 4).toUpperCase()}` },
      { id: companyB, name: "Beta Co", issuePrefix: `B${companyB.slice(0, 4).toUpperCase()}` },
    ]);
    const now = new Date();
    await db
      .insert(authUsers)
      .values(
        [owner, owner2, admin, member, outsider, instanceAdmin, loneInstanceAdmin].map((id) => ({
          id,
          name: id.split("-")[0]!,
          email: `${id}@example.test`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing();
    await db.insert(companyMemberships).values([
      { companyId: companyA, principalType: "user", principalId: owner, status: "active", membershipRole: "owner" },
      { companyId: companyA, principalType: "user", principalId: owner2, status: "active", membershipRole: "owner" },
      { companyId: companyA, principalType: "user", principalId: admin, status: "active", membershipRole: "admin" },
      { companyId: companyA, principalType: "user", principalId: member, status: "active", membershipRole: "operator" },
      { companyId: companyB, principalType: "user", principalId: outsider, status: "active", membershipRole: "owner" },
      // Paperclip only lets people into companies they belong to; an instance
      // admin with an ordinary role still gets Board chat there.
      { companyId: companyA, principalType: "user", principalId: instanceAdmin, status: "active", membershipRole: "operator" },
      // The owner of A is also an owner of B: the chat must still stay in A.
      { companyId: companyB, principalType: "user", principalId: owner, status: "active", membershipRole: "owner" },
    ]);
    await db
      .insert(instanceUserRoles)
      .values([
        { userId: instanceAdmin, role: "instance_admin" },
        { userId: loneInstanceAdmin, role: "instance_admin" },
      ])
      .onConflictDoNothing();
    await db.insert(boardChatCompanySettings).values({ companyId: companyA, enabled: true, dailyMessageCap: 40 });

    const [
      { instanceSettingsService },
      { actorMiddleware },
      { boardChatGuard },
      { boardMutationGuard },
      { boardChatRoutes },
      { errorHandler },
      { assertCompanyAccess },
      { createInProcessDispatcher },
      { goalRoutes },
      { agentRoutes },
      { httpLogger },
      { createRequestLoadTracker },
    ] = await Promise.all([
      import("../services/instance-settings.js"),
      import("../middleware/auth.js"),
      import("../middleware/board-chat-guard.js"),
      import("../middleware/board-mutation-guard.js"),
      import("../routes/board-chat.js"),
      import("../middleware/error-handler.js"),
      import("../routes/authz.js"),
      import("../services/board-chat-dispatch.js"),
      import("../routes/goals.js"),
      import("../routes/agents.js"),
      import("../middleware/logger.js"),
      import("../services/request-load.js"),
    ]);
    await instanceSettingsService(db).updateExperimental({ enableConferenceRoomChat: true });

    const fakeClient = {
      messages: {
        create: vi.fn(async (params: any) => {
          modelCalls.push({ tools: params.tools, messages: params.messages, system: params.system });
          if (onModelCall) await onModelCall();
          const next = script.shift() ?? [{ text: "All done." }];
          return anthropicMessage(next);
        }),
      },
    };

    const app = express();
    app.use(express.json());
    // The same request-wide middleware the real app runs before sign-in, so
    // in-process requests are proven to pass through them too.
    app.use(httpLogger);
    app.use(createRequestLoadTracker().middleware());
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async (req) => {
          const userId = req.header("x-test-user");
          return userId ? { user: { id: userId, name: userId.split("-")[0], email: null }, session: { id: `s-${userId}`, userId } } : null;
        },
      }),
    );
    app.use(boardChatGuard(db));
    const api = Router();
    api.use(boardMutationGuard());
    api.use(
      boardChatRoutes(db, {
        deploymentMode: "authenticated",
        deps: {
          spawn: spawnSpy as never,
          dispatch: createInProcessDispatcher(() => app as never),
          helperOptions: { createModelClient: () => fakeClient as never },
        },
      }),
    );
    // Stand-ins for the real routes the tools and approved changes call.
    api.get("/companies/:companyId/dashboard", (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      targetCalls.push({ route: "dashboard", body: null, actor: { ...req.actor } });
      res.json({ ok: true, agents: 3, userId: req.actor.userId });
    });
    api.get("/companies/:companyId/mail-accounts/:accountId/messages", (_req, res) => {
      targetCalls.push({ route: "mail", body: null, actor: null });
      res.json({ secret: "mail" });
    });
    api.post("/companies/:companyId/issues", (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      targetCalls.push({ route: "create_issue", body: req.body, actor: { ...req.actor } });
      res.status(201).json({ id: randomUUID(), identifier: "ALP-9" });
    });
    api.post("/approvals/:id/approve", (req, res) => {
      targetCalls.push({ route: "approve", body: req.body, actor: { ...req.actor } });
      res.json({ ok: true });
    });
    // One real route file, so a held change is proven against real route code
    // (company scope, validation, activity log), not only stand-ins.
    api.use(goalRoutes(db));
    api.use(agentRoutes(db));
    app.use("/api", api);
    app.use(errorHandler);
    testApp = app;

    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    for (const table of [boardChatActions, boardChatRuns, boardChatCompanySettings, costEvents, activityLog, approvals, issueComments, issues, goals, agents]) {
      await db.delete(table);
    }
  });

  function asUser(userId: string) {
    return { "x-test-user": userId, origin: base, "content-type": "application/json" };
  }

  async function chat(userId: string, message = "What is going on?") {
    const res = await fetch(`${base}/api/board/chat/stream`, {
      method: "POST",
      headers: asUser(userId),
      body: JSON.stringify({ companyId: companyA, message }),
    });
    return { status: res.status, text: await res.text() };
  }

  it("answers in-process with a closed tool list and never starts a child process", async () => {
    script = [[{ tool: "get_overview", input: {} }], [{ text: "You have 3 agents." }]];
    const res = await chat(owner);
    expect(res.status).toBe(200);
    expect(res.text).toContain("You have 3 agents.");
    expect(spawnSpy).not.toHaveBeenCalled();
    // The model only ever sees the named tools: no shell, no free-form address tool.
    const toolNames = (modelCalls[0]!.tools ?? []).map((t) => t.name).sort();
    expect(toolNames).toContain("get_overview");
    expect(toolNames).toContain("create_task");
    expect(toolNames).not.toContain("api");
    expect(toolNames.some((name) => /bash|shell|fetch|http|request/i.test(name))).toBe(false);
    // The read ran in-process as the person, inside one company, never as instance admin.
    expect(targetCalls).toHaveLength(1);
    expect(targetCalls[0]!.actor).toMatchObject({ type: "board", userId: owner, companyIds: [companyA], isInstanceAdmin: false, source: "board_chat" });
    // Nothing credential-shaped anywhere in what the model was sent.
    expect(JSON.stringify(modelCalls)).not.toMatch(/pcp_|Bearer /);
  });

  it("lets an admin and an instance admin who belongs here chat; refuses members, other companies and outsiders", async () => {
    expect((await chat(admin)).status).toBe(200);
    expect((await chat(instanceAdmin)).status).toBe(200);

    const memberRes = await chat(member);
    expect(memberRes.status).toBe(403);
    expect(JSON.parse(memberRes.text)).toMatchObject({ code: "BOARD_CHAT_ROLE_REQUIRED", error: "Board chat is only for this company's owner and admins." });
    expect((await chat(outsider)).status).toBe(403);
    expect((await chat(loneInstanceAdmin)).status).toBe(403);

    const availability = await fetch(`${base}/api/companies/${companyA}/board-chat/availability`, { headers: asUser(member) });
    expect(await availability.json()).toMatchObject({ available: false, reason: "not_allowed", mode: "signed_in" });
    const ownerAvailability = await fetch(`${base}/api/companies/${companyA}/board-chat/availability`, { headers: asUser(owner) });
    expect(await ownerAvailability.json()).toMatchObject({ available: true, canChangeSettings: true });
    const anonymous = await fetch(`${base}/api/companies/${companyA}/board-chat/availability`);
    expect(anonymous.status).toBe(403);
  });

  it("is off until the company switches it on, and only an owner can switch it", async () => {
    await db.update(boardChatCompanySettings).set({ enabled: false }).where(eq(boardChatCompanySettings.companyId, companyA));
    const off = await chat(owner);
    expect(off.status).toBe(403);
    expect(JSON.parse(off.text)).toMatchObject({ code: "BOARD_CHAT_COMPANY_OFF" });

    const adminPatch = await fetch(`${base}/api/companies/${companyA}/board-chat/settings`, {
      method: "PATCH",
      headers: asUser(admin),
      body: JSON.stringify({ enabled: true }),
    });
    expect(adminPatch.status).toBe(403);
    const ownerPatch = await fetch(`${base}/api/companies/${companyA}/board-chat/settings`, {
      method: "PATCH",
      headers: asUser(owner),
      body: JSON.stringify({ enabled: true, dailyMessageCap: 5 }),
    });
    expect(ownerPatch.status).toBe(200);
    expect(await ownerPatch.json()).toMatchObject({ enabled: true, dailyMessageCap: 5, enabledByUserId: owner });
    const logged = await db.select().from(activityLog).where(eq(activityLog.action, "board_chat.settings_updated"));
    expect(logged[0]).toMatchObject({ actorType: "user", actorId: owner, companyId: companyA });
  });

  it("enforces the daily message cap, even for messages sent at the same moment", async () => {
    await db.update(boardChatCompanySettings).set({ dailyMessageCap: 2 }).where(eq(boardChatCompanySettings.companyId, companyA));
    const results = await Promise.all([chat(owner), chat(owner), chat(owner)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    const refused = results.find((r) => r.status === 429)!;
    expect(JSON.parse(refused.text)).toMatchObject({ code: "BOARD_CHAT_DAILY_CAP" });
    const runs = await db.select().from(boardChatRuns).where(eq(boardChatRuns.companyId, companyA));
    expect(runs).toHaveLength(2);
  });

  it("keeps in-process reads inside the one company, refuses mixed-case addresses, and holds any write", async () => {
    const { boardChatService } = await import("../services/board-chat.js");
    const { createInProcessDispatcher } = await import("../services/board-chat-dispatch.js");
    const dispatch = createInProcessDispatcher(() => testApp);
    const actor = (await boardChatService(db).buildActor({ companyId: companyA, userId: owner }))!;
    expect(actor).toMatchObject({ companyIds: [companyA], isInstanceAdmin: false, source: "board_chat" });

    expect((await dispatch({ method: "GET", path: `/api/companies/${companyA}/dashboard`, actor })).status).toBe(200);
    // The owner also owns company B, but this chat is about A only.
    const other = await dispatch({ method: "GET", path: `/api/companies/${companyB}/dashboard`, actor });
    expect(other.status).toBe(403);
    expect(other.json).toMatchObject({ code: "BOARD_CHAT_OTHER_COMPANY" });
    for (const path of [
      `/api/companies/${companyA}/Mail-Accounts/x/messages`,
      `/api/companies/${companyA}/MAIL-ACCOUNTS/x/messages`,
      `/api/companies/${companyA}/mail-accounts/x/messages`,
      "/api/Admin/users",
      "/api/Secrets/1/usage",
      `/API/companies/${companyA}/dashboard`,
    ]) {
      const res = await dispatch({ method: "GET", path, actor });
      expect(res.status, path).toBe(403);
    }
    expect(targetCalls.filter((c) => c.route === "mail")).toHaveLength(0);

    // A write that reaches the guard is held, never made.
    const write = await dispatch({ method: "POST", path: `/api/companies/${companyA}/issues`, body: { title: "Held" }, actor });
    expect(write.status).toBe(202);
    expect(targetCalls.filter((c) => c.route === "create_issue")).toHaveLength(0);

    // An approved-change actor can only send exactly the approved request.
    const svc = boardChatService(db);
    const action = await svc.createAction({
      companyId: companyA,
      runId: null,
      issueId: null,
      userId: owner,
      method: "POST",
      path: `/api/companies/${companyA}/issues`,
      bodyJson: JSON.stringify({ title: "Exact" }),
      summary: 'Create a new task "Exact"',
      details: [],
    });
    const confirmedActor = (await svc.buildActor({ companyId: companyA, userId: owner, actionId: action.id }))!;
    const tampered = await dispatch({
      method: "POST",
      path: `/api/companies/${companyA}/issues`,
      body: { title: "Something else" },
      actor: confirmedActor,
      action: { id: action.id, companyId: companyA, userId: owner, issueId: null, method: "POST", path: `/api/companies/${companyA}/issues`, bodyJson: JSON.stringify({ title: "Exact" }), summary: "x" },
    });
    expect(tampered.status).toBe(403);
    expect(tampered.json).toMatchObject({ code: "BOARD_CHAT_REPLAY_MISMATCH" });
    expect(targetCalls.filter((c) => c.route === "create_issue")).toHaveLength(0);
  });

  it("holds a write until the person approves it, then makes exactly that change once, in-process", async () => {
    script = [
      [{ tool: "create_task", input: { title: "Launch plan", priority: "high" } }],
      [{ text: "I prepared a task for you to approve." }],
    ];
    const res = await chat(owner, "Make a launch plan task");
    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"action"');
    expect(targetCalls.filter((c) => c.route === "create_issue")).toHaveLength(0);
    // The model was told it was held, not made.
    const toolResult = JSON.stringify(modelCalls[1]!.messages);
    expect(toolResult).toContain("NOT made");

    const list = await fetch(`${base}/api/companies/${companyA}/board-chat/actions`, { headers: asUser(owner) });
    const { actions } = (await list.json()) as { actions: Array<{ id: string; status: string; details: unknown[]; summary: string }> };
    expect(actions).toHaveLength(1);
    const held = actions[0]!;
    expect(held).toMatchObject({ status: "pending", summary: 'Create a new task "Launch plan"' });
    expect(held.details).toEqual([
      { label: "Title", value: "Launch plan" },
      { label: "Priority", value: "high" },
    ]);

    const byMember = await fetch(`${base}/api/board/chat/actions/${held.id}/confirm`, { method: "POST", headers: asUser(member) });
    expect(byMember.status).toBe(403);
    const byOtherOwner = await fetch(`${base}/api/board/chat/actions/${held.id}/confirm`, { method: "POST", headers: asUser(owner2) });
    expect(byOtherOwner.status).toBe(403);
    expect(await byOtherOwner.json()).toMatchObject({ code: "BOARD_CHAT_NOT_YOUR_CHANGE" });
    expect(targetCalls.filter((c) => c.route === "create_issue")).toHaveLength(0);

    const confirm = await fetch(`${base}/api/board/chat/actions/${held.id}/confirm`, { method: "POST", headers: asUser(owner) });
    expect(confirm.status).toBe(200);
    expect(await confirm.json()).toMatchObject({ action: { status: "done", resultMessage: "Done (ALP-9)." } });
    const made = targetCalls.filter((c) => c.route === "create_issue");
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({
      body: { title: "Launch plan", priority: "high" },
      actor: { type: "board", userId: owner, companyIds: [companyA], isInstanceAdmin: false, source: "board_chat_confirmed" },
    });
    expect(spawnSpy).not.toHaveBeenCalled();

    const again = await fetch(`${base}/api/board/chat/actions/${held.id}/confirm`, { method: "POST", headers: asUser(owner) });
    expect(again.status).toBe(409);
    expect(targetCalls.filter((c) => c.route === "create_issue")).toHaveLength(1);

    const logged = (await db.select().from(activityLog).where(eq(activityLog.companyId, companyA))).map((row) => [row.action, row.actorId]);
    expect(logged).toEqual(
      expect.arrayContaining([
        ["board_chat.message_sent", owner],
        ["board_chat.action_requested", owner],
        ["board_chat.action_confirmed", owner],
        ["board_chat.reply_finished", owner],
      ]),
    );
  });

  it("drops a held change on Cancel and never makes it", async () => {
    script = [[{ tool: "create_task", input: { title: "Never" } }], [{ text: "Prepared." }]];
    await chat(owner);
    const [held] = await db.select().from(boardChatActions).where(eq(boardChatActions.companyId, companyA));
    const cancel = await fetch(`${base}/api/board/chat/actions/${held!.id}/cancel`, { method: "POST", headers: asUser(owner) });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({ action: { status: "cancelled" } });
    const confirm = await fetch(`${base}/api/board/chat/actions/${held!.id}/confirm`, { method: "POST", headers: asUser(owner) });
    expect(confirm.status).toBe(409);
    expect(targetCalls.filter((c) => c.route === "create_issue")).toHaveLength(0);
    const logged = await db.select().from(activityLog).where(and(eq(activityLog.action, "board_chat.action_cancelled"), eq(activityLog.actorId, owner)));
    expect(logged).toHaveLength(1);
  });

  it("never lets the chat decide deploy, merge or hire cards, but can prepare approving a strategy card", async () => {
    const [deploy, merge, hire, strategy] = await db
      .insert(approvals)
      .values([
        { companyId: companyA, type: "request_board_approval", payload: { kind: "deploy", title: "Deploy abc" } },
        { companyId: companyA, type: "request_board_approval", payload: { kind: "merge_pr", title: "Merge #1" } },
        { companyId: companyA, type: "hire_agent", payload: { name: "Bob", adapterType: "process", adapterConfig: { command: "/bin/sh" } } },
        { companyId: companyA, type: "approve_ceo_strategy", payload: { title: "Q4 plan" } },
      ])
      .returning();
    script = [
      [
        { tool: "decide_card", input: { cardId: deploy!.id, decision: "approve" } },
        { tool: "decide_card", input: { cardId: merge!.id, decision: "reject" } },
        { tool: "decide_card", input: { cardId: hire!.id, decision: "approve" } },
        { tool: "decide_card", input: { cardId: strategy!.id, decision: "approve" } },
      ],
      [{ text: "Done preparing." }],
    ];
    await chat(owner);
    const toolResults = JSON.stringify(modelCalls[1]!.messages);
    expect(toolResults).toContain("Deploy and merge cards can't be decided in Board chat");
    expect(toolResults).toContain("Board chat can't decide this kind of card");
    const held = await db.select().from(boardChatActions).where(eq(boardChatActions.companyId, companyA));
    expect(held).toHaveLength(1);
    expect(held[0]!.summary).toBe('Approve the card "Q4 plan"');
    expect(targetCalls.filter((c) => c.route === "approve")).toHaveLength(0);
  });

  it("refuses agent changes outside the allow-list, and unknown tools, without holding anything", async () => {
    const agentId = randomUUID();
    script = [
      [
        { tool: "update_agent", input: { agentId, runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { command: "/bin/sh" } } } } } },
        { tool: "hire_agent", input: { name: "Eve", permissions: { canCreateAgents: true }, laneABaseUrl: "https://attacker.example" } },
        { tool: "api", input: { method: "GET", path: "/api/instance/settings" } },
      ],
      [{ text: "I couldn't do that." }],
    ];
    await chat(owner);
    const toolResults = JSON.stringify(modelCalls[1]!.messages);
    expect(toolResults).toContain("don't fit update_agent");
    expect(toolResults).toContain("don't fit hire_agent");
    expect(toolResults).toContain("There is no tool called api");
    expect(await db.select().from(boardChatActions).where(eq(boardChatActions.companyId, companyA))).toHaveLength(0);
  });

  it("records each model call's spend as a cost event for the company", async () => {
    script = [[{ tool: "get_overview", input: {} }], [{ text: "Here you go." }]];
    await chat(owner);
    const events = await db.select().from(costEvents).where(eq(costEvents.companyId, companyA));
    expect(events.length).toBe(2);
    for (const event of events) expect(event).toMatchObject({ billingCode: "board_chat", agentId: null, inputTokens: 1000, outputTokens: 50 });
    const [run] = await db.select().from(boardChatRuns).where(eq(boardChatRuns.companyId, companyA));
    expect(run).toMatchObject({ status: "done", inputTokens: 2000, outputTokens: 100 });
  });

  it("reads and, after Approve, writes through a real route in-process as the person", async () => {
    script = [
      [{ tool: "list_goals", input: {} }],
      [{ tool: "create_goal", input: { title: "Reach 100 customers", description: "By year end" } }],
      [{ text: "Prepared a goal for you." }],
    ];
    await chat(owner);
    expect(JSON.stringify(modelCalls[1]!.messages)).toContain("[]");
    expect(await db.select().from(goals).where(eq(goals.companyId, companyA))).toHaveLength(0);
    const [held] = await db.select().from(boardChatActions).where(eq(boardChatActions.companyId, companyA));
    expect(held!.details).toEqual([
      { label: "Title", value: "Reach 100 customers" },
      { label: "Description", value: "By year end" },
    ]);
    const confirm = await fetch(`${base}/api/board/chat/actions/${held!.id}/confirm`, { method: "POST", headers: asUser(owner) });
    expect(await confirm.json()).toMatchObject({ action: { status: "done" } });
    const made = await db.select().from(goals).where(eq(goals.companyId, companyA));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ title: "Reach 100 customers", description: "By year end" });
    const [logged] = await db.select().from(activityLog).where(eq(activityLog.action, "goal.created"));
    expect(logged).toMatchObject({ actorType: "user", actorId: owner, companyId: companyA });
  });

  it("never hands an agent's credentials to the model or the saved reply (real agent routes)", async () => {
    const githubToken = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const mcpSecret = "sk-live-" + "9Z8y7X6w5V4u3T2s1R0q";
    const oddlyNamed = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: companyA,
        name: "Coder",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          model: "claude-sonnet-5-5",
          env: { GITHUB_TOKEN: { type: "plain", value: githubToken }, REPO_NOTE: oddlyNamed },
          mcpServers: [{ name: "gh", url: "https://mcp.example", headers: { Authorization: `Bearer ${mcpSecret}` } }],
        },
      })
      .returning();
    script = [
      [{ tool: "list_agents", input: {} }],
      [{ tool: "get_agent", input: { agentId: agent!.id } }],
      // Even if a model somehow repeated one, it is masked before it is shown or saved.
      [{ text: `Coder is set up. (${githubToken})` }],
    ];
    const res = await chat(owner, "Tell me about my agents");
    expect(res.status).toBe(200);
    const seenByModel = JSON.stringify(modelCalls);
    expect(seenByModel).toContain("Coder");
    for (const secret of [githubToken, mcpSecret, oddlyNamed]) {
      expect(seenByModel).not.toContain(secret);
      expect(res.text).not.toContain(secret);
    }
    // The routes themselves give Board chat the masked view (no live credentials).
    const { boardChatService } = await import("../services/board-chat.js");
    const { createInProcessDispatcher } = await import("../services/board-chat-dispatch.js");
    const actor = (await boardChatService(db).buildActor({ companyId: companyA, userId: owner }))!;
    const dispatch = createInProcessDispatcher(() => testApp);
    for (const path of [`/api/agents/${agent!.id}`, `/api/companies/${companyA}/agents`]) {
      const raw = await dispatch({ method: "GET", path, actor });
      expect(raw.status, path).toBe(200);
      expect(raw.text, path).toContain("Coder");
      expect(raw.text, path).not.toContain(githubToken);
      expect(raw.text, path).not.toContain(mcpSecret);
    }
    const saved = await db.select().from(issueComments).where(eq(issueComments.authorUserId, "board-concierge"));
    expect(saved).toHaveLength(1);
    for (const secret of [githubToken, mcpSecret, oddlyNamed]) expect(saved[0]!.body).not.toContain(secret);
    expect(saved[0]!.body).toContain("Coder is set up.");
  });

  it("stops between model calls when the company hits its spending limit mid-message", async () => {
    script = [[{ tool: "get_overview", input: {} }], [{ text: "should never be asked" }]];
    onModelCall = async () => {
      await db.update(companies).set({ status: "paused", pauseReason: "budget" }).where(eq(companies.id, companyA));
    };
    const res = await chat(owner);
    expect(res.status).toBe(200);
    expect(modelCalls).toHaveLength(1);
    expect(res.text).toContain("Board chat stopped: Company is paused because its budget hard-stop was reached.");
    const [run] = await db.select().from(boardChatRuns).where(eq(boardChatRuns.companyId, companyA));
    expect(run).toMatchObject({ status: "failed", inputTokens: 1000 });
  });

  it("keeps the conversation on the Board Operations task only", async () => {
    const [other] = await db
      .insert(issues)
      .values({ companyId: companyA, title: "Agent work", status: "todo", priority: "medium" })
      .returning();
    const res = await fetch(`${base}/api/board/chat/stream`, {
      method: "POST",
      headers: asUser(owner),
      body: JSON.stringify({ companyId: companyA, message: "hi", taskId: other!.id }),
    });
    expect(res.status).toBe(403);
  });
});
