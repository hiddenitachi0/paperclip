import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySecrets,
  createDb,
  issueComments,
  issues,
  telegramBots,
  telegramChatRequests,
  telegramPersonLinks,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { HttpError } from "../errors.js";
import { telegramChatRoutes } from "../routes/telegram-chat.js";
import { telegramBotRoutes } from "../routes/telegram-bots.js";
import { agentService } from "../services/agents.js";
import { hashTelegramLinkCode, shouldTryQuickAnswer, type TelegramChatLaneA } from "../services/telegram-chat.js";

/**
 * Hermes parity slice 1: two-way Telegram chat for linked people.
 *
 * What a careless change would quietly take away, and so what is pinned:
 *  - only a person who linked their Telegram (one-time code, once, 15 min)
 *    gets anything; everyone else gets one "link first" sentence and no model
 *    call, no row, no task;
 *  - the company is the bot's, never the caller's choice;
 *  - the question runs as THAT person: their membership, the quick agent's
 *    own refusal, tasks:assign before a hand-over, issue:read again before an
 *    answer leaves Paperclip;
 *  - the outbox delivers a finished task's answer once;
 *  - the per-person daily cap;
 *  - the bridge routes are instance-admin only, the setting owner/admin only.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping Telegram chat route tests: ${support.reason ?? "unsupported environment"}`);
}

const TG_USER = "700000001";
const SECRET_NAMES = ["PAPERCLIP_AGENT_JWT_SECRET", "BETTER_AUTH_SECRET"] as const;
const TEST_SECRET = "telegram-chat-test-master-secret";

d("telegram chat (linked people)", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousSecrets = Object.fromEntries(SECRET_NAMES.map((name) => [name, process.env[name]]));

  beforeAll(async () => {
    // Link codes are HMACed with a key derived from the server's master secret.
    process.env.PAPERCLIP_AGENT_JWT_SECRET = TEST_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    const started = await startEmbeddedPostgresTestDatabase("telegram-chat");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  afterAll(async () => {
    await stopDb?.();
    for (const name of SECRET_NAMES) {
      if (previousSecrets[name] === undefined) delete process.env[name];
      else process.env[name] = previousSecrets[name];
    }
  });

  const bridgeActor = () => ({ type: "board", source: "local_implicit", userId: "operator", isInstanceAdmin: true });
  const personActor = (userId: string, companyId: string, membershipRole = "operator") => ({
    type: "board",
    source: "session",
    userId,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole }],
  });

  function createApp(actor: Record<string, unknown>, laneA: TelegramChatLaneA, now?: () => Date) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", telegramChatRoutes(db, { laneA, heartbeat: { wakeup: vi.fn(async () => null) }, now }));
    app.use(errorHandler);
    return app;
  }

  const noLaneA = (): TelegramChatLaneA & { sendMessage: ReturnType<typeof vi.fn> } => ({
    sendMessage: vi.fn(async () => {
      throw new Error("the quick agent must not be called");
    }),
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Firma ${companyId.slice(0, 6)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedUser(companyId: string | null, membershipRole = "operator", status = "active") {
    const userId = `user-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: `Person ${userId.slice(5)}`, email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    if (companyId) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status, membershipRole });
    }
    return userId;
  }

  async function seedAgent(companyId: string, opts: { laneA?: boolean; name?: string } = {}) {
    const agent = await agentService(db).create(companyId, {
      name: opts.name ?? `A-${randomUUID().slice(0, 6)}`,
      role: "general",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    if (opts.laneA) await db.update(agents).set({ laneAEnabled: true }).where(eq(agents.id, agent.id));
    return agent;
  }

  async function seedBot(companyId: string, agentId: string) {
    const [secret] = await db
      .insert(companySecrets)
      .values({ companyId, key: `tg-${randomUUID().slice(0, 6)}`, name: `Telegram bot token ${randomUUID().slice(0, 6)}` })
      .returning();
    const [bot] = await db
      .insert(telegramBots)
      .values({ companyId, agentId, name: "Daglig leder", tokenSecretId: secret!.id })
      .returning();
    return bot!;
  }

  /** A company with a people bot, a quick agent and a full agent, switched on. */
  async function seedSetup(opts: { quick?: boolean; full?: boolean; cap?: number } = {}) {
    const companyId = await seedCompany();
    const owner = await seedUser(companyId, "owner");
    const quick = await seedAgent(companyId, { laneA: true, name: "Maja" });
    const full = await seedAgent(companyId, { name: "Analytiker" });
    const bot = await seedBot(companyId, quick.id);
    const ownerApp = createApp(personActor(owner, companyId, "owner"), noLaneA());
    const put = await request(ownerApp)
      .put(`/api/companies/${companyId}/telegram-chat/settings`)
      .send({
        enabled: true,
        botId: bot.id,
        quickAgentId: opts.quick === false ? null : quick.id,
        fullAgentId: opts.full === false ? null : full.id,
        dailyQuestionsPerPerson: opts.cap ?? 30,
      });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    return { companyId, owner, quick, full, bot };
  }

  /** Makes a code on the person's profile and sends it from Telegram. */
  async function link(companyId: string, botId: string, userId: string, telegramUserId = TG_USER) {
    const code = await request(createApp(personActor(userId, companyId), noLaneA())).post("/api/me/telegram-link/code");
    expect(code.status).toBe(201);
    const claimed = await request(createApp(bridgeActor(), noLaneA()))
      .post(`/api/companies/${companyId}/telegram-chat/link`)
      .send({ botId, telegramUserId, code: code.body.code, telegramUsername: "kari" });
    expect(claimed.body.outcome).toBe("linked");
  }

  function ask(app: express.Express, companyId: string, botId: string, message: string, telegramUserId = TG_USER) {
    return request(app)
      .post(`/api/companies/${companyId}/telegram-chat/ask`)
      .send({ botId, telegramUserId, chatId: telegramUserId, message });
  }

  // ── Linking ────────────────────────────────────────────────────────────────

  it("links a Telegram account with a one-time code, once", async () => {
    const { companyId, bot } = await seedSetup();
    const kari = await seedUser(companyId);
    const personApp = createApp(personActor(kari, companyId), noLaneA());
    const bridge = createApp(bridgeActor(), noLaneA());
    const tgUser = "700000101";

    const before = await request(personApp).get("/api/me/telegram-link");
    expect(before.body).toMatchObject({ linked: false, pendingCodeExpiresAt: null });

    const code = await request(personApp).post("/api/me/telegram-link/code");
    expect(code.body.code).toMatch(/^[A-Z2-9]{8}$/);

    const wrong = await request(bridge)
      .post(`/api/companies/${companyId}/telegram-chat/link`)
      .send({ botId: bot.id, telegramUserId: tgUser, code: "ZZZZ2222" });
    expect(wrong.body.outcome).toBe("bad_code");

    // Lower case and a dash are the same code.
    const typed = `${code.body.code.slice(0, 4).toLowerCase()}-${code.body.code.slice(4)}`;
    const ok = await request(bridge)
      .post(`/api/companies/${companyId}/telegram-chat/link`)
      .send({ botId: bot.id, telegramUserId: tgUser, code: typed, telegramUsername: "kari" });
    expect(ok.body.outcome).toBe("linked");

    const after = await request(personApp).get("/api/me/telegram-link");
    expect(after.body).toMatchObject({ linked: true, telegramUsername: "kari" });

    // The code works once.
    const again = await request(bridge)
      .post(`/api/companies/${companyId}/telegram-chat/link`)
      .send({ botId: bot.id, telegramUserId: "700000102", code: code.body.code });
    expect(again.body.outcome).toBe("bad_code");

    // Unlinking from the profile page stops the answers.
    await request(personApp).delete("/api/me/telegram-link").expect(200);
    const asked = await ask(bridge, companyId, bot.id, "Hvordan gikk salget i går?", tgUser);
    expect(asked.body.outcome).toBe("not_linked");
  });

  it("stores the code as an HMAC under the server's secret, never a plain hash", async () => {
    const companyId = await seedCompany();
    const kari = await seedUser(companyId);
    const code = await request(createApp(personActor(kari, companyId), noLaneA())).post("/api/me/telegram-link/code");
    const [row] = await db.select().from(telegramPersonLinks).where(eq(telegramPersonLinks.userId, kari));
    expect(row!.linkCodeHash).toBe(hashTelegramLinkCode(code.body.code, TEST_SECRET));
    expect(row!.linkCodeHash).not.toBe(createHash("sha256").update(code.body.code).digest("hex"));
    expect(row!.linkCodeHash).not.toContain(code.body.code);
    // Another server secret gives another hash: the database alone cannot test guesses.
    expect(hashTelegramLinkCode(code.body.code, "another-secret")).not.toBe(row!.linkCodeHash);
    // Same code however it is typed.
    expect(hashTelegramLinkCode(` ${code.body.code.toLowerCase()} `, TEST_SECRET)).toBe(row!.linkCodeHash);
  });

  it("refuses to make or accept codes when the server has no secret", async () => {
    const { companyId, bot } = await seedSetup();
    const kari = await seedUser(companyId);
    const issued = await request(createApp(personActor(kari, companyId), noLaneA())).post("/api/me/telegram-link/code");
    expect(hashTelegramLinkCode("ABCD2345", null)).toBeNull();
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    try {
      const refused = await request(createApp(personActor(kari, companyId), noLaneA())).post("/api/me/telegram-link/code");
      expect(refused.status).toBe(503);
      const claim = await request(createApp(bridgeActor(), noLaneA()))
        .post(`/api/companies/${companyId}/telegram-chat/link`)
        .send({ botId: bot.id, telegramUserId: "700000251", code: issued.body.code });
      expect(claim.body.outcome).toBe("bad_code");
      expect(claim.body.reply).toMatch(/not available/);
    } finally {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = TEST_SECRET;
    }
  });

  it("an expired code does not link", async () => {
    const { companyId, bot } = await seedSetup();
    const kari = await seedUser(companyId);
    let now = new Date();
    const clock = () => now;
    const code = await request(createApp(personActor(kari, companyId), noLaneA(), clock)).post("/api/me/telegram-link/code");
    now = new Date(now.getTime() + 16 * 60_000);
    const claimed = await request(createApp(bridgeActor(), noLaneA(), clock))
      .post(`/api/companies/${companyId}/telegram-chat/link`)
      .send({ botId: bot.id, telegramUserId: "700000201", code: code.body.code });
    expect(claimed.body.outcome).toBe("bad_code");
  });

  it("stops accepting codes from one Telegram account after five wrong ones", async () => {
    const { companyId, bot } = await seedSetup();
    const bridge = createApp(bridgeActor(), noLaneA());
    for (let i = 0; i < 5; i += 1) {
      const res = await request(bridge)
        .post(`/api/companies/${companyId}/telegram-chat/link`)
        .send({ botId: bot.id, telegramUserId: "700000301", code: `WRONG${i}22` });
      expect(res.body.outcome).toBe("bad_code");
    }
    const sixth = await request(bridge)
      .post(`/api/companies/${companyId}/telegram-chat/link`)
      .send({ botId: bot.id, telegramUserId: "700000301", code: "ANYTHING" });
    expect(sixth.body.outcome).toBe("too_many_attempts");
  });

  // ── Who gets an answer ────────────────────────────────────────────────────

  it("an unlinked sender gets one 'link first' sentence and nothing else", async () => {
    const { companyId, bot } = await seedSetup();
    const laneA = noLaneA();
    const res = await ask(createApp(bridgeActor(), laneA), companyId, bot.id, "How are sales?", "700000401");
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("not_linked");
    expect(res.body.reply).toMatch(/link/i);
    expect(laneA.sendMessage).not.toHaveBeenCalled();
    const rows = await db.select().from(telegramChatRequests).where(eq(telegramChatRequests.companyId, companyId));
    expect(rows).toHaveLength(0);
  });

  it("takes the company from the bot, never from the caller", async () => {
    const a = await seedSetup();
    const b = await seedSetup();
    const kari = await seedUser(a.companyId);
    await link(a.companyId, a.bot.id, kari, "700000501");
    const laneA = noLaneA();
    const bridge = createApp(bridgeActor(), laneA);
    // Company B's path with company A's bot: that bot is not B's.
    const crossed = await ask(bridge, b.companyId, a.bot.id, `Show me ${b.companyId} sales`, "700000501");
    expect(crossed.status).toBe(404);
    expect(laneA.sendMessage).not.toHaveBeenCalled();
    // And a linked person who is not a member of the bot's company gets nothing.
    const other = await ask(bridge, b.companyId, b.bot.id, "How are sales?", "700000501");
    expect(other.body.outcome).toBe("no_access");
    expect(laneA.sendMessage).not.toHaveBeenCalled();
  });

  it("answers through the quick agent as the linked person", async () => {
    const { companyId, bot, quick } = await seedSetup();
    const kari = await seedUser(companyId, "operator");
    await link(companyId, bot.id, kari, "700000601");
    const laneA = {
      sendMessage: vi.fn(async () => ({ response: "Salget i september: 412 enheter (Shopify).", conversationId: null, actions: [] })),
    };
    const res = await ask(createApp(bridgeActor(), laneA), companyId, bot.id, "Hvordan gikk salget i september?", "700000601");
    expect(res.body).toMatchObject({ outcome: "answered", reply: "Salget i september: 412 enheter (Shopify)." });
    expect(laneA.sendMessage).toHaveBeenCalledTimes(1);
    const call = laneA.sendMessage.mock.calls[0]![0] as Record<string, any>;
    expect(call.companyId).toBe(companyId);
    expect(call.targetAgent.id).toBe(quick.id);
    // The person, not the bridge's operator.
    expect(call.requester).toEqual({ userId: kari, agentId: null });
    expect(call.actor).toMatchObject({ type: "board", userId: kari, isInstanceAdmin: false });
    expect(call.actor.memberships).toEqual([expect.objectContaining({ companyId, membershipRole: "operator" })]);
    const [row] = await db.select().from(telegramChatRequests).where(eq(telegramChatRequests.userId, kari));
    expect(row).toMatchObject({ route: "quick", status: "answered", botId: bot.id });
  });

  it("a refusal from the quick agent is passed on, and the question is NOT handed to the full agent", async () => {
    const { companyId, bot } = await seedSetup();
    const kari = await seedUser(companyId);
    await link(companyId, bot.id, kari, "700000701");
    const laneA = {
      sendMessage: vi.fn(async () => {
        throw new HttpError(403, "Maja only answers the people it is assigned to.", { code: "LANE_A_NOT_ASSIGNED" });
      }),
    };
    const res = await ask(createApp(bridgeActor(), laneA), companyId, bot.id, "How are sales?", "700000701");
    expect(res.body.outcome).toBe("refused");
    expect(res.body.reply).toContain("only answers the people it is assigned to");
    const tasks = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(tasks).toHaveLength(0);
  });

  it("hands over to the full agent when quick answers are unavailable", async () => {
    const { companyId, bot, full } = await seedSetup();
    const kari = await seedUser(companyId);
    await link(companyId, bot.id, kari, "700000801");
    const laneA = {
      sendMessage: vi.fn(async () => {
        throw new HttpError(503, "The model is busy");
      }),
    };
    const res = await ask(createApp(bridgeActor(), laneA), companyId, bot.id, "How are sales?", "700000801");
    expect(res.body.outcome).toBe("handed_over");
    expect(res.body.reply).toContain("Quick answers aren't available right now");
    const [task] = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(task).toMatchObject({ assigneeAgentId: full.id, createdByUserId: kari, status: "todo" });
  });

  it("a viewer cannot hand work to the full agent through Telegram", async () => {
    const { companyId, bot } = await seedSetup({ quick: false });
    const viewer = await seedUser(companyId, "viewer");
    await link(companyId, bot.id, viewer, "700000901");
    const res = await ask(createApp(bridgeActor(), noLaneA()), companyId, bot.id, "Research our best sellers", "700000901");
    expect(res.body.outcome).toBe("refused");
    expect(res.body.reply).toMatch(/not allowed to give it tasks/);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
  });

  it("an Employee (light) without chat access gets nothing", async () => {
    const { companyId, bot } = await seedSetup();
    const employee = await seedUser(companyId, "employee");
    await link(companyId, bot.id, employee, "700001001");
    const laneA = noLaneA();
    const res = await ask(createApp(bridgeActor(), laneA), companyId, bot.id, "How are sales?", "700001001");
    expect(res.body.outcome).toBe("no_access");
    expect(laneA.sendMessage).not.toHaveBeenCalled();
  });

  // ── The outbox ─────────────────────────────────────────────────────────────

  it("posts the full agent's answer once the task is done, once", async () => {
    const { companyId, bot, full } = await seedSetup({ quick: false });
    const kari = await seedUser(companyId);
    await link(companyId, bot.id, kari, "700001101");
    const bridge = createApp(bridgeActor(), noLaneA());
    const asked = await ask(bridge, companyId, bot.id, "Research the sales trend for sofas this year", "700001101");
    expect(asked.body.outcome).toBe("handed_over");

    const [task] = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect((await request(bridge).get(`/api/companies/${companyId}/telegram-chat/outbox`)).body.answers).toEqual([]);

    await db.insert(issueComments).values({
      companyId,
      issueId: task!.id,
      authorAgentId: full.id,
      authorType: "agent",
      body: "Sofa sales are up 12 % from January to September (Shopify, units).",
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, task!.id));

    const out = await request(bridge).get(`/api/companies/${companyId}/telegram-chat/outbox`);
    expect(out.body.answers).toHaveLength(1);
    const item = out.body.answers[0];
    expect(item).toMatchObject({ botId: bot.id, chatId: "700001101", taskIdentifier: task!.identifier });
    expect(item.text).toContain("is finished");
    expect(item.text).toContain("Sofa sales are up 12 %");

    await request(bridge).post(`/api/companies/${companyId}/telegram-chat/outbox/${item.id}/ack`).send({ outcome: "delivered" }).expect(200);
    // A repeated acknowledgement (one that got lost on the way back) is fine.
    await request(bridge).post(`/api/companies/${companyId}/telegram-chat/outbox/${item.id}/ack`).send({ outcome: "delivered" }).expect(200);
    expect((await request(bridge).get(`/api/companies/${companyId}/telegram-chat/outbox`)).body.answers).toEqual([]);
  });

  it("does not send a task's answer to someone who lost access in the meantime", async () => {
    const { companyId, bot, full } = await seedSetup({ quick: false });
    const kari = await seedUser(companyId);
    await link(companyId, bot.id, kari, "700001201");
    const bridge = createApp(bridgeActor(), noLaneA());
    await ask(bridge, companyId, bot.id, "Research the sales trend", "700001201");
    const [task] = await db.select().from(issues).where(eq(issues.companyId, companyId));
    await db.insert(issueComments).values({ companyId, issueId: task!.id, authorAgentId: full.id, authorType: "agent", body: "Secret numbers" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, task!.id));
    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, kari)));

    const out = await request(bridge).get(`/api/companies/${companyId}/telegram-chat/outbox`);
    expect(out.body.answers).toEqual([]);
    const [row] = await db.select().from(telegramChatRequests).where(eq(telegramChatRequests.userId, kari));
    expect(row!.status).toBe("failed");
    expect(row!.answerText).toBeNull();
  });

  it("re-checks a ready answer on every outbox read, and drops it when the person lost access", async () => {
    const { companyId, bot, full } = await seedSetup({ quick: false });
    const kari = await seedUser(companyId);
    const ola = await seedUser(companyId);
    await link(companyId, bot.id, kari, "700001251");
    await link(companyId, bot.id, ola, "700001252");
    const bridge = createApp(bridgeActor(), noLaneA());
    await ask(bridge, companyId, bot.id, "Research the sales trend for chairs", "700001251");
    await ask(bridge, companyId, bot.id, "Research the sales trend for tables", "700001252");
    for (const task of await db.select().from(issues).where(eq(issues.companyId, companyId))) {
      await db.insert(issueComments).values({ companyId, issueId: task.id, authorAgentId: full.id, authorType: "agent", body: "Numbers." });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, task.id));
    }

    // Both answers become ready, but the bridge does not send them yet
    // (Paperclip restarting, the bot offline...).
    expect((await request(bridge).get(`/api/companies/${companyId}/telegram-chat/outbox`)).body.answers).toHaveLength(2);

    // Meanwhile Kari leaves the company and Ola unlinks.
    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, kari)));
    await request(createApp(personActor(ola, companyId), noLaneA())).delete("/api/me/telegram-link").expect(200);

    const again = await request(bridge).get(`/api/companies/${companyId}/telegram-chat/outbox`);
    expect(again.body.answers).toEqual([]);
    const rows = await db.select().from(telegramChatRequests).where(eq(telegramChatRequests.companyId, companyId));
    expect(rows.map((row) => row.status).sort()).toEqual(["failed", "failed"]);
    expect(rows.every((row) => row.answerText === null)).toBe(true);
    expect(rows.find((row) => row.userId === kari)!.note).toMatch(/no longer use this company/);
    expect(rows.find((row) => row.userId === ola)!.note).toMatch(/unlinked/);
    // A late acknowledgement for it cannot bring it back.
    const ack = await request(bridge)
      .post(`/api/companies/${companyId}/telegram-chat/outbox/${rows[0]!.id}/ack`)
      .send({ outcome: "delivered" });
    expect(ack.body.status).toBe("failed");
  });

  // ── Limits ─────────────────────────────────────────────────────────────────

  it("stops at the per-person daily limit", async () => {
    const { companyId, bot } = await seedSetup({ cap: 2 });
    const kari = await seedUser(companyId);
    await link(companyId, bot.id, kari, "700001301");
    const laneA = { sendMessage: vi.fn(async () => ({ response: "Svar.", conversationId: null, actions: [] })) };
    const bridge = createApp(bridgeActor(), laneA);
    expect((await ask(bridge, companyId, bot.id, "One?", "700001301")).body.outcome).toBe("answered");
    expect((await ask(bridge, companyId, bot.id, "Two?", "700001301")).body.outcome).toBe("answered");
    const third = await ask(bridge, companyId, bot.id, "Three?", "700001301");
    expect(third.body.outcome).toBe("over_cap");
    expect(third.body.reply).toContain("daily limit");
    expect(laneA.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("long or work-shaped messages go straight to the full agent", () => {
    expect(shouldTryQuickAnswer("Hvordan gikk salget av sofaer i september?")).toBe(true);
    expect(shouldTryQuickAnswer("Research the sofa market")).toBe(false);
    expect(shouldTryQuickAnswer("x".repeat(301))).toBe(false);
  });

  it("tells the bridge which bot answers linked people, and only while switched on", async () => {
    const { companyId, bot, quick, full, owner } = await seedSetup();
    const second = await seedBot(companyId, full.id);
    const rosterApp = express();
    rosterApp.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = bridgeActor();
      next();
    });
    rosterApp.use("/api", telegramBotRoutes(db));
    rosterApp.use(errorHandler);
    const flags = async () => {
      const res = await request(rosterApp).get("/api/instance/telegram-bridge-config");
      expect(res.status).toBe(200);
      return Object.fromEntries(
        (res.body.bots as Array<{ id: string; answersLinkedPeople: boolean }>)
          .filter((b) => b.id === bot.id || b.id === second.id)
          .map((b) => [b.id, b.answersLinkedPeople]),
      );
    };
    expect(await flags()).toEqual({ [bot.id]: true, [second.id]: false });
    await request(createApp(personActor(owner, companyId, "owner"), noLaneA()))
      .put(`/api/companies/${companyId}/telegram-chat/settings`)
      .send({ enabled: false, botId: bot.id, quickAgentId: quick.id, fullAgentId: full.id, dailyQuestionsPerPerson: 30 })
      .expect(200);
    expect(await flags()).toEqual({ [bot.id]: false, [second.id]: false });
  });

  // ── Gates ──────────────────────────────────────────────────────────────────

  it("the bridge routes are for the instance admin only", async () => {
    const { companyId, bot, owner } = await seedSetup();
    const ownerApp = createApp(personActor(owner, companyId, "owner"), noLaneA());
    expect((await ask(ownerApp, companyId, bot.id, "Hi")).status).toBe(403);
    expect((await request(ownerApp).get(`/api/companies/${companyId}/telegram-chat/outbox`)).status).toBe(403);
    const linkRes = await request(ownerApp)
      .post(`/api/companies/${companyId}/telegram-chat/link`)
      .send({ botId: bot.id, telegramUserId: TG_USER, code: "ABCD2345" });
    expect(linkRes.status).toBe(403);
  });

  it("only an owner or admin changes the setting, and only to agents that fit", async () => {
    const { companyId, bot, full } = await seedSetup();
    const operator = await seedUser(companyId, "operator");
    const operatorApp = createApp(personActor(operator, companyId, "operator"), noLaneA());
    const body = { enabled: true, botId: bot.id, quickAgentId: null, fullAgentId: full.id, dailyQuestionsPerPerson: 10 };
    expect((await request(operatorApp).put(`/api/companies/${companyId}/telegram-chat/settings`).send(body)).status).toBe(403);
    expect((await request(operatorApp).get(`/api/companies/${companyId}/telegram-chat/settings`)).status).toBe(200);

    const owner = await seedUser(companyId, "owner");
    const ownerApp = createApp(personActor(owner, companyId, "owner"), noLaneA());
    // A full agent cannot be the quick agent: it has no quick answers.
    const bad = await request(ownerApp)
      .put(`/api/companies/${companyId}/telegram-chat/settings`)
      .send({ ...body, quickAgentId: full.id });
    expect(bad.status).toBe(422);
    // Another company's bot cannot be picked.
    const other = await seedSetup();
    const crossBot = await request(ownerApp)
      .put(`/api/companies/${companyId}/telegram-chat/settings`)
      .send({ ...body, botId: other.bot.id });
    expect(crossBot.status).toBe(422);
  });
});
