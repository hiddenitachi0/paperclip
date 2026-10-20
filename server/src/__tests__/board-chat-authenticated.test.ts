import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * Board chat on a signed-in Paperclip, end to end over real HTTP with a real
 * database: who may use it, the per-run credential, held changes, Approve and
 * Cancel, the deploy/merge refusal, caps, cost and the activity log. The
 * `claude` CLI is a fake process; no model is ever called.
 */

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping Board chat signed-in tests: ${support.reason ?? "embedded Postgres unsupported"}`);
}

type FakeProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (text: string) => void; end: () => void };
  exitCode: number | null;
  killed: boolean;
  kill: (signal?: string) => void;
  prompt: string;
};

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.prompt = "";
  proc.stdin = { write: (text: string) => { proc.prompt += text; }, end: () => {} };
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    setImmediate(() => {
      proc.exitCode = 143;
      proc.emit("close", 143);
    });
  };
  return proc;
}

describeDb("Board chat on a signed-in server", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: http.Server | null = null;
  let base = "";
  let spawned: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; proc: FakeProc }> = [];
  const targetCalls: Array<{ route: string; body: unknown; actor: any }> = [];

  let companyA = "";
  let companyB = "";
  const owner = `owner-${randomUUID()}`;
  const owner2 = `owner2-${randomUUID()}`;
  const admin = `admin-${randomUUID()}`;
  const member = `member-${randomUUID()}`;
  const outsider = `outsider-${randomUUID()}`;
  const instanceAdmin = `iadmin-${randomUUID()}`;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-chat-signed-in-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    spawned = [];
    targetCalls.length = 0;
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
        [owner, owner2, admin, member, outsider, instanceAdmin].map((id) => ({
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
      // admin with an ordinary role still gets Board chat.
      { companyId: companyA, principalType: "user", principalId: instanceAdmin, status: "active", membershipRole: "operator" },
    ]);
    await db.insert(instanceUserRoles).values({ userId: instanceAdmin, role: "instance_admin" }).onConflictDoNothing();
    await db.insert(boardChatCompanySettings).values({ companyId: companyA, enabled: true, dailyMessageCap: 40 });

    const [{ instanceSettingsService }, { actorMiddleware }, { boardChatGuard }, { boardMutationGuard }, { boardChatRoutes }, { errorHandler }, { assertCompanyAccess }] =
      await Promise.all([
        import("../services/instance-settings.js"),
        import("../middleware/auth.js"),
        import("../middleware/board-chat-guard.js"),
        import("../middleware/board-mutation-guard.js"),
        import("../routes/board-chat.js"),
        import("../middleware/error-handler.js"),
        import("../routes/authz.js"),
      ]);
    await instanceSettingsService(db).updateExperimental({ enableConferenceRoomChat: true });

    const app = express();
    app.use(express.json());
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
          spawn: ((command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
            const proc = makeFakeProc();
            spawned.push({ command, args, cwd: options.cwd, env: options.env, proc });
            return proc as any;
          }) as any,
          resolveClaudeFallbackToken: async () => null,
        },
      }),
    );
    // Stand-ins for the real routes a held change ends up calling.
    api.get("/companies/:companyId/dashboard", (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      res.json({ ok: true, userId: req.actor.userId });
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
    api.get("/instance/settings", (_req, res) => res.json({ secret: "nope" }));
    app.use("/api", api);
    app.use(errorHandler);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    for (const table of [boardChatActions, boardChatRuns, boardChatCompanySettings, costEvents, activityLog, approvals]) {
      await db.delete(table);
    }
  });

  function asUser(userId: string, extra: Record<string, string> = {}) {
    return { "x-test-user": userId, origin: base, "content-type": "application/json", ...extra };
  }

  async function startChat(userId: string, message = "What is going on?") {
    const before = spawned.length;
    const response = fetch(`${base}/api/board/chat/stream`, {
      method: "POST",
      headers: asUser(userId),
      body: JSON.stringify({ companyId: companyA, message }),
    });
    await vi.waitFor(() => expect(spawned.length).toBeGreaterThan(before), { timeout: 10_000 });
    const entry = spawned[spawned.length - 1]!;
    const mcpConfig = JSON.parse(entry.args[entry.args.indexOf("--mcp-config") + 1]!);
    const env = mcpConfig.mcpServers.paperclip.env as Record<string, string>;
    const res = await response;
    const textPromise = res.text();
    return {
      ...entry,
      status: res.status,
      runId: env.PAPERCLIP_BC_RUN_ID,
      bootstrap: env.PAPERCLIP_BC_BOOTSTRAP,
      async exchange(code = env.PAPERCLIP_BC_BOOTSTRAP) {
        const r = await fetch(`${base}/api/board/chat/runs/${env.PAPERCLIP_BC_RUN_ID}/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        });
        return { status: r.status, body: (await r.json()) as { token?: string } };
      },
      async finish(lines: unknown[] = []) {
        for (const line of lines) entry.proc.stdout.emit("data", Buffer.from(`${JSON.stringify(line)}\n`));
        entry.proc.exitCode = 0;
        entry.proc.emit("close", 0);
        return textPromise;
      },
    };
  }

  function asRun(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  it("lets an owner chat with a locked-down CLI that has only the Paperclip connector", async () => {
    const chat = await startChat(owner);
    expect(chat.status).toBe(200);
    expect(chat.command).toBe("claude");
    expect(chat.args).not.toContain("--dangerously-skip-permissions");
    expect(chat.args[chat.args.indexOf("--tools") + 1]).toBe("");
    expect(chat.args).toContain("--strict-mcp-config");
    expect(chat.args[chat.args.indexOf("--allowedTools") + 1]).toBe("mcp__paperclip__api");
    expect(chat.args[chat.args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(chat.cwd).not.toBe("/tmp");
    // The CLI never sees a usable credential: only a one-time code, in the connector's config.
    expect(chat.bootstrap).toMatch(/^pcp_bcboot_/);
    expect(JSON.stringify(chat.args)).not.toMatch(/pcp_bcrun_|pcp_bcexec_/);
    expect(JSON.stringify(chat.env)).not.toMatch(/pcp_bc/);
    expect(chat.env.DATABASE_URL).toBeUndefined();
    const sse = await chat.finish([{ type: "stream_event", event: { type: "content_block_delta", delta: { text: "All good." } } }]);
    expect(sse).toContain('"type":"done"');
  });

  it("lets an admin and an instance admin chat, refuses members and other companies", async () => {
    const adminChat = await startChat(admin);
    expect(adminChat.status).toBe(200);
    await adminChat.finish();
    const iadminChat = await startChat(instanceAdmin);
    expect(iadminChat.status).toBe(200);
    await iadminChat.finish();
    spawned = [];

    const memberRes = await fetch(`${base}/api/board/chat/stream`, {
      method: "POST",
      headers: asUser(member),
      body: JSON.stringify({ companyId: companyA, message: "hi" }),
    });
    expect(memberRes.status).toBe(403);
    expect(await memberRes.json()).toMatchObject({ code: "BOARD_CHAT_ROLE_REQUIRED", error: "Board chat is only for this company's owner and admins." });

    const outsiderRes = await fetch(`${base}/api/board/chat/stream`, {
      method: "POST",
      headers: asUser(outsider),
      body: JSON.stringify({ companyId: companyA, message: "hi" }),
    });
    expect(outsiderRes.status).toBe(403);
    expect(spawned).toHaveLength(0);

    const availability = await fetch(`${base}/api/companies/${companyA}/board-chat/availability`, { headers: asUser(member) });
    expect(await availability.json()).toMatchObject({ available: false, reason: "not_allowed", mode: "signed_in" });
    const ownerAvailability = await fetch(`${base}/api/companies/${companyA}/board-chat/availability`, { headers: asUser(owner) });
    expect(await ownerAvailability.json()).toMatchObject({ available: true, canChangeSettings: true });
  });

  it("is off until the company switches it on, and only an owner can switch it", async () => {
    await db.update(boardChatCompanySettings).set({ enabled: false }).where(eq(boardChatCompanySettings.companyId, companyA));
    const off = await fetch(`${base}/api/board/chat/stream`, {
      method: "POST",
      headers: asUser(owner),
      body: JSON.stringify({ companyId: companyA, message: "hi" }),
    });
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ code: "BOARD_CHAT_COMPANY_OFF" });

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

  it("enforces the daily message cap", async () => {
    await db.update(boardChatCompanySettings).set({ dailyMessageCap: 1 }).where(eq(boardChatCompanySettings.companyId, companyA));
    const first = await startChat(owner);
    await first.finish();
    const second = await fetch(`${base}/api/board/chat/stream`, {
      method: "POST",
      headers: asUser(owner),
      body: JSON.stringify({ companyId: companyA, message: "again" }),
    });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "BOARD_CHAT_DAILY_CAP" });
  });

  it("gives the run a credential that reads only this company and dies with the run", async () => {
    const chat = await startChat(owner);
    const { status, body } = await chat.exchange();
    expect(status).toBe(200);
    const token = body.token!;
    expect(token).toMatch(/^pcp_bcrun_/);

    const own = await fetch(`${base}/api/companies/${companyA}/dashboard`, { headers: asRun(token) });
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ ok: true, userId: owner });
    const other = await fetch(`${base}/api/companies/${companyB}/dashboard`, { headers: asRun(token) });
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ code: "BOARD_CHAT_OTHER_COMPANY" });
    const instance = await fetch(`${base}/api/instance/settings`, { headers: asRun(token) });
    expect(instance.status).toBe(403);
    const ownApproval = await fetch(`${base}/api/board/chat/actions/${randomUUID()}/confirm`, { method: "POST", headers: asRun(token) });
    expect(ownApproval.status).toBe(403);

    await chat.finish();
    const after = await fetch(`${base}/api/companies/${companyA}/dashboard`, { headers: asRun(token) });
    expect(after.status).toBe(401); // the credential no longer authenticates anyone
    const [run] = await db.select().from(boardChatRuns).where(eq(boardChatRuns.id, chat.runId!));
    expect(run).toMatchObject({ status: "done", tokenHash: null });
  });

  it("revokes the credential when the one-time code is used twice", async () => {
    const chat = await startChat(owner);
    const first = await chat.exchange();
    expect(first.status).toBe(200);
    const second = await chat.exchange();
    expect(second.status).toBe(403);
    const blocked = await fetch(`${base}/api/companies/${companyA}/dashboard`, { headers: asRun(first.body.token!) });
    expect(blocked.status).toBe(401);
    const sse = await chat.finish();
    expect(sse).toContain("stopped for safety");
  });

  it("holds a write until the person approves it, then makes exactly that change once", async () => {
    const chat = await startChat(owner);
    const token = (await chat.exchange()).body.token!;
    const held = await fetch(`${base}/api/companies/${companyA}/issues`, {
      method: "POST",
      headers: asRun(token),
      body: JSON.stringify({ title: "Launch plan", priority: "high" }),
    });
    expect(held.status).toBe(202);
    const heldBody = (await held.json()) as { held: boolean; pendingActionId: string; summary: string };
    expect(heldBody).toMatchObject({ held: true, summary: 'Create a new task "Launch plan"' });
    expect(targetCalls).toHaveLength(0);
    const sse = await chat.finish();
    expect(sse).toContain('"type":"action"');

    const list = await fetch(`${base}/api/companies/${companyA}/board-chat/actions`, { headers: asUser(owner) });
    const { actions } = (await list.json()) as { actions: Array<{ id: string; status: string; details: unknown[] }> };
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: heldBody.pendingActionId, status: "pending" });
    expect(actions[0]!.details).toContainEqual({ label: "Priority", value: "high" });

    // Nobody else can approve it: not a member, not another owner.
    const byMember = await fetch(`${base}/api/board/chat/actions/${heldBody.pendingActionId}/confirm`, { method: "POST", headers: asUser(member) });
    expect(byMember.status).toBe(403);
    const byOtherOwner = await fetch(`${base}/api/board/chat/actions/${heldBody.pendingActionId}/confirm`, { method: "POST", headers: asUser(owner2) });
    expect(byOtherOwner.status).toBe(403);
    expect(await byOtherOwner.json()).toMatchObject({ code: "BOARD_CHAT_NOT_YOUR_CHANGE" });
    expect(targetCalls).toHaveLength(0);

    const confirm = await fetch(`${base}/api/board/chat/actions/${heldBody.pendingActionId}/confirm`, { method: "POST", headers: asUser(owner) });
    expect(confirm.status).toBe(200);
    expect(await confirm.json()).toMatchObject({ action: { status: "done", resultMessage: "Done (ALP-9)." } });
    expect(targetCalls).toHaveLength(1);
    expect(targetCalls[0]).toMatchObject({
      route: "create_issue",
      body: { title: "Launch plan", priority: "high" },
      actor: { type: "board", userId: owner, companyIds: [companyA], isInstanceAdmin: false, source: "board_chat_confirmed" },
    });

    const again = await fetch(`${base}/api/board/chat/actions/${heldBody.pendingActionId}/confirm`, { method: "POST", headers: asUser(owner) });
    expect(again.status).toBe(409);
    expect(targetCalls).toHaveLength(1);

    const actionsLogged = (await db.select().from(activityLog).where(eq(activityLog.companyId, companyA))).map((row) => [row.action, row.actorId]);
    expect(actionsLogged).toEqual(
      expect.arrayContaining([
        ["board_chat.message_sent", owner],
        ["board_chat.action_requested", owner],
        ["board_chat.action_confirmed", owner],
        ["board_chat.reply_finished", owner],
      ]),
    );
  });

  it("drops a held change on Cancel and never makes it", async () => {
    const chat = await startChat(owner);
    const token = (await chat.exchange()).body.token!;
    const held = (await (await fetch(`${base}/api/companies/${companyA}/issues`, {
      method: "POST",
      headers: asRun(token),
      body: JSON.stringify({ title: "Never" }),
    })).json()) as { pendingActionId: string };
    await chat.finish();
    const cancel = await fetch(`${base}/api/board/chat/actions/${held.pendingActionId}/cancel`, { method: "POST", headers: asUser(owner) });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({ action: { status: "cancelled" } });
    const confirm = await fetch(`${base}/api/board/chat/actions/${held.pendingActionId}/confirm`, { method: "POST", headers: asUser(owner) });
    expect(confirm.status).toBe(409);
    expect(targetCalls).toHaveLength(0);
    const logged = await db.select().from(activityLog).where(and(eq(activityLog.action, "board_chat.action_cancelled"), eq(activityLog.actorId, owner)));
    expect(logged).toHaveLength(1);
  });

  it("only lets an Approve credential send the exact approved request", async () => {
    const { boardChatService } = await import("../services/board-chat.js");
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
    const begun = await svc.beginConfirm(action.id, owner);
    const tampered = await fetch(`${base}/api/companies/${companyA}/issues`, {
      method: "POST",
      headers: asRun(begun!.execToken),
      body: JSON.stringify({ title: "Something else" }),
    });
    expect(tampered.status).toBe(403);
    expect(await tampered.json()).toMatchObject({ code: "BOARD_CHAT_REPLAY_MISMATCH" });
    // Single use: the credential was spent on the refused attempt.
    const retry = await fetch(`${base}/api/companies/${companyA}/issues`, {
      method: "POST",
      headers: asRun(begun!.execToken),
      body: JSON.stringify({ title: "Exact" }),
    });
    expect(retry.status).toBe(401);
    expect(targetCalls).toHaveLength(0);
  });

  it("never lets the chat decide deploy or merge cards, but can ask to approve a hire", async () => {
    const [deploy, merge, hire] = await db
      .insert(approvals)
      .values([
        { companyId: companyA, type: "request_board_approval", payload: { kind: "deploy", title: "Deploy abc" } },
        { companyId: companyA, type: "request_board_approval", payload: { kind: "merge_pr", title: "Merge #1" } },
        { companyId: companyA, type: "hire_agent", payload: { name: "Bob" } },
      ])
      .returning();
    const chat = await startChat(owner);
    const token = (await chat.exchange()).body.token!;
    for (const card of [deploy!, merge!]) {
      for (const verb of ["approve", "reject", "request-revision"]) {
        const res = await fetch(`${base}/api/approvals/${card.id}/${verb}`, { method: "POST", headers: asRun(token), body: "{}" });
        expect(res.status, `${verb} ${card.id}`).toBe(403);
        expect(await res.json()).toMatchObject({ code: "BOARD_CHAT_APPROVAL_NOT_ALLOWED" });
      }
    }
    const hireRes = await fetch(`${base}/api/approvals/${hire!.id}/approve`, { method: "POST", headers: asRun(token), body: "{}" });
    expect(hireRes.status).toBe(202);
    await chat.finish();
    const held = await db.select().from(boardChatActions).where(eq(boardChatActions.companyId, companyA));
    expect(held).toHaveLength(1);
    expect(held[0]!.summary).toBe('Approve the card "Bob"');
    expect(targetCalls).toHaveLength(0);
  });

  it("records each message's spend as a cost event for the company", async () => {
    const chat = await startChat(owner);
    await chat.finish([
      { type: "stream_event", event: { type: "content_block_delta", delta: { text: "Here you go." } } },
      {
        type: "result",
        result: "Here you go.",
        total_cost_usd: 0.0234,
        usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 300 },
        modelUsage: { "claude-sonnet-5-5": {} },
      },
    ]);
    const [event] = await db.select().from(costEvents).where(eq(costEvents.companyId, companyA));
    expect(event).toMatchObject({
      billingCode: "board_chat",
      createdByUserId: owner,
      agentId: null,
      costCents: 2,
      inputTokens: 1200,
      outputTokens: 80,
      model: "claude-sonnet-5-5",
    });
    const [run] = await db.select().from(boardChatRuns).where(eq(boardChatRuns.id, chat.runId!));
    expect(run).toMatchObject({ costCents: 2, costEventId: event!.id });
  });
});
