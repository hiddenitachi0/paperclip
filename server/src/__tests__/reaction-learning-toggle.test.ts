import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentMemories,
  agents,
  assets,
  companies,
  companyMemberships,
  companyReactionEmojiConfig,
  createDb,
  issueAttachments,
  laneAConversations,
  laneAMessages,
  telegramMessageReactions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentMemoryRoutes } from "../routes/agent-memories.js";
import { telegramReactionRoutes } from "../routes/telegram-reactions.js";
import { agentMemoryService } from "../services/agent-memories.js";
import { REACTION_SUMMARY_EVERY_N, reactionLearningService } from "../services/reaction-learning.js";

/**
 * DUR-4829: the per-agent "learn from emoji reactions" switch, and the board
 * read side of it. What a careless change would quietly take away: nothing new
 * recorded or learned while it is off, no picture rules or reaction notes in
 * the prompt, a removal still voiding an earlier reaction, and the
 * recent-reactions list staying company-scoped, board-only and private.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping reaction learning toggle tests: ${support.reason ?? "unsupported environment"}`);
}

d("reaction learning toggle", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("reaction-learning-toggle");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentMemories);
    await db.delete(telegramMessageReactions);
    await db.delete(companyReactionEmojiConfig);
    await db.delete(activityLog);
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  const admin = { type: "board", source: "local_implicit", userId: "operator", isInstanceAdmin: true };
  const outsider = (companyId: string) => ({
    type: "board",
    source: "session",
    userId: "outsider",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "owner" }],
  });

  function app(actor: Record<string, unknown> = admin) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = actor;
      next();
    });
    a.use("/api", telegramReactionRoutes(db));
    a.use("/api", agentMemoryRoutes(db));
    a.use(errorHandler);
    return a;
  }

  async function seed(opts: { reactionLearningEnabled?: boolean; requestedByUserId?: string } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "Maja", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: { command: "echo" }, runtimeConfig: {},
      ...(opts.reactionLearningEnabled === undefined ? {} : { reactionLearningEnabled: opts.reactionLearningEnabled }),
    });
    const conversationId = randomUUID();
    await db.insert(laneAConversations).values({
      id: conversationId, companyId, agentId, requestedByUserId: opts.requestedByUserId ?? "u", turnCount: 1,
    });
    return { companyId, agentId, conversationId };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  const setEnabled = (s: Seed, value: boolean) =>
    db.update(agents).set({ reactionLearningEnabled: value }).where(eq(agents.id, s.agentId));

  async function seedPicture(companyId: string) {
    const assetId = randomUUID();
    await db.insert(assets).values({
      id: assetId, companyId, provider: "local", objectKey: `k/${assetId}`, contentType: "image/png", byteSize: 1, sha256: "x",
    });
    const id = randomUUID();
    await db.insert(issueAttachments).values({ id, companyId, assetId });
    return id;
  }

  async function reply(s: Seed, content: string) {
    const [row] = await db
      .insert(laneAMessages)
      .values({ companyId: s.companyId, conversationId: s.conversationId, agentId: s.agentId, role: "assistant", content })
      .returning();
    return row!.id;
  }

  function react(s: Seed, telegramMessageId: number, emoji: string, extra: Record<string, unknown> = {}, action = "added") {
    return request(app())
      .post(`/api/companies/${s.companyId}/telegram-reactions`)
      .send({ agentId: s.agentId, telegramUserId: "42", telegramChatId: "42", telegramMessageId, emoji, action, ...extra });
  }

  it("defaults to on, so every agent that existed before keeps learning", async () => {
    const s = await seed();
    const [row] = await db.select({ on: agents.reactionLearningEnabled }).from(agents);
    expect(row!.on).toBe(true);
    expect(await reactionLearningService(db).isEnabled(s.companyId, s.agentId)).toBe(true);
  });

  describe("while it is off", () => {
    it("records nothing, asks no follow-up question and learns nothing", async () => {
      const s = await seed({ reactionLearningEnabled: false });
      for (let i = 0; i < REACTION_SUMMARY_EVERY_N + 1; i += 1) {
        const fileId = await seedPicture(s.companyId);
        const res = await react(s, 10 + i, "👎", { picture: { fileId, prompt: "a poster with text" } });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ recorded: false, reason: "reaction_learning_disabled" });
      }
      expect(await db.select().from(telegramMessageReactions)).toHaveLength(0);
      expect(await db.select().from(agentMemories)).toHaveLength(0);
      expect(await db.select().from(activityLog)).toHaveLength(0);
    });

    it("answers a follow-up answer without storing it", async () => {
      const s = await seed({ reactionLearningEnabled: false });
      const res = await request(app())
        .post(`/api/companies/${s.companyId}/telegram-reactions/follow-up-answer`)
        .send({ agentId: s.agentId, telegramUserId: "42", telegramChatId: "42", telegramMessageId: 1, answer: "less text" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ recorded: false, reason: "reaction_learning_disabled" });
    });

    it("still voids a reaction recorded while it was on, so switching back on never revives it", async () => {
      const s = await seed();
      const fileId = await seedPicture(s.companyId);
      expect((await react(s, 10, "👎", { picture: { fileId, prompt: "a poster with text" } })).status).toBe(201);
      await setEnabled(s, false);
      expect((await react(s, 10, "👎", {}, "removed")).status).toBe(200);
      // Removing something that was never recorded is not an error either.
      expect((await react(s, 99, "👎", {}, "removed")).status).toBe(200);
      const rows = await db.select().from(telegramMessageReactions);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ active: false });
      expect(await db.select().from(agentMemories)).toHaveLength(0);
    });

    it("applies no picture rules and writes no notes, but leaves the notes learned earlier alone", async () => {
      const s = await seed();
      const a = await seedPicture(s.companyId);
      const b = await seedPicture(s.companyId);
      await react(s, 10, "👎", { picture: { fileId: a, prompt: "a poster with text" } });
      await react(s, 11, "❤", { picture: { fileId: b, prompt: "warm golden hour portrait" } });
      const learning = reactionLearningService(db);
      await learning.summarizeAgent(s.companyId, s.agentId);
      const learned = await db.select().from(agentMemories);
      expect(learned.length).toBeGreaterThan(0);
      expect((await learning.pictureRules(s.companyId, s.agentId)).avoid).toContain("text in the picture");

      await setEnabled(s, false);
      expect(await learning.pictureRules(s.companyId, s.agentId)).toEqual({ doMore: [], avoid: [] });
      expect(await learning.summarizeAgent(s.companyId, s.agentId)).toEqual({ removed: 0, added: 0, reactionsRead: 0 });
      expect(await learning.maybeSummarize(s.companyId, s.agentId, { force: true })).toEqual({ removed: 0, added: 0, reactionsRead: 0 });
      expect(await learning.maybeSummarize(s.companyId, s.agentId)).toBeNull();
      expect((await db.select().from(agentMemories)).map((n) => n.id).sort()).toEqual(learned.map((n) => n.id).sort());

      await setEnabled(s, true);
      expect((await learning.pictureRules(s.companyId, s.agentId)).avoid).toContain("text in the picture");
    });

    it("keeps reaction notes out of the agent's prompt but on the board's page, and only those", async () => {
      const s = await seed();
      await db.insert(agentMemories).values([
        { companyId: s.companyId, agentId: s.agentId, text: "Call me Filip", source: "user" },
        { companyId: s.companyId, agentId: s.agentId, text: "Prefers shorter replies.", source: "reaction", category: "reply_style" },
      ]);
      const memories = agentMemoryService(db);
      expect((await memories.listForAgent(s.companyId, s.agentId)).map((n) => n.text).sort()).toEqual([
        "Call me Filip",
        "Prefers shorter replies.",
      ]);
      await setEnabled(s, false);
      expect((await memories.listForAgent(s.companyId, s.agentId)).map((n) => n.text)).toEqual(["Call me Filip"]);
      expect((await memories.list(s.companyId, s.agentId)).notes).toHaveLength(2);
    });
  });

  describe("GET /agents/:agentId/memories?source=reaction", () => {
    it("lists only the notes learned from reactions", async () => {
      const s = await seed();
      await db.insert(agentMemories).values([
        { companyId: s.companyId, agentId: s.agentId, text: "Call me Filip", source: "user" },
        { companyId: s.companyId, agentId: s.agentId, text: "Likes pictures with: nature.", source: "reaction", category: "picture_like" },
      ]);
      const all = await request(app()).get(`/api/agents/${s.agentId}/memories`);
      expect(all.body.notes).toHaveLength(2);
      const learned = await request(app()).get(`/api/agents/${s.agentId}/memories?source=reaction`);
      expect(learned.status).toBe(200);
      expect(learned.body.notes.map((n: { text: string; source: string }) => [n.text, n.source])).toEqual([
        ["Likes pictures with: nature.", "reaction"],
      ]);
      expect((await request(app()).get(`/api/agents/${s.agentId}/memories?source=bogus`)).status).toBe(400);
    });
  });

  describe("GET /agents/:agentId/reactions", () => {
    it("lists the newest reactions with a short excerpt, a picture reference and the switch, and pages", async () => {
      const s = await seed();
      const long = `${"word ".repeat(80)}end`;
      const messageId = await reply(s, long);
      const fileId = await seedPicture(s.companyId);
      await react(s, 1, "👍", { conversationId: s.conversationId, messageId });
      await react(s, 2, "👎", { picture: { fileId, prompt: "a poster with text", look: "Neon" } });
      await react(s, 3, "🔥");
      await react(s, 3, "🔥", {}, "removed");

      const res = await request(app()).get(`/api/agents/${s.agentId}/reactions`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ agentId: s.agentId, reactionLearningEnabled: true, limit: 25, offset: 0, hasMore: false });
      expect(res.body.items.map((i: { emoji: string }) => i.emoji)).toEqual(["🔥", "👎", "👍"]);
      const [removed, pic, text] = res.body.items;
      expect(removed).toMatchObject({ emoji: "🔥", active: false, meaning: "positive" });
      expect(removed.removedAt).not.toBeNull();
      expect(pic).toMatchObject({
        emoji: "👎", active: true, meaning: "negative",
        picture: { fileId, look: "Neon", promptExcerpt: "a poster with text" },
        message: { excerpt: null },
      });
      expect(text.message.id).toBe(messageId);
      expect(text.message.excerpt.length).toBeLessThanOrEqual(160);
      expect(text.message.excerpt.endsWith("…")).toBe(true);
      expect(text.picture).toBeNull();
      // Nothing that identifies the Telegram person or chat leaves the server.
      expect(JSON.stringify(res.body)).not.toMatch(/telegramUserId|telegramChatId|"42"/);

      const first = await request(app()).get(`/api/agents/${s.agentId}/reactions?limit=2`);
      expect(first.body.items.map((i: { emoji: string }) => i.emoji)).toEqual(["🔥", "👎"]);
      expect(first.body.hasMore).toBe(true);
      const next = await request(app()).get(`/api/agents/${s.agentId}/reactions?limit=2&offset=2`);
      expect(next.body.items.map((i: { emoji: string }) => i.emoji)).toEqual(["👍"]);
      expect(next.body.hasMore).toBe(false);
    });

    it("reports the switch as off", async () => {
      const s = await seed({ reactionLearningEnabled: false });
      const res = await request(app()).get(`/api/agents/${s.agentId}/reactions`);
      expect(res.status).toBe(200);
      expect(res.body.reactionLearningEnabled).toBe(false);
    });

    it("leaves out reactions in a chat requested by an active Employee (light) member", async () => {
      const s = await seed({ requestedByUserId: "light-employee" });
      await db.insert(companyMemberships).values({
        companyId: s.companyId, principalType: "user", principalId: "light-employee", status: "active", membershipRole: "employee",
      });
      const messageId = await reply(s, "a private answer");
      await react(s, 1, "👍", { conversationId: s.conversationId, messageId });
      await react(s, 2, "🔥");
      const res = await request(app()).get(`/api/agents/${s.agentId}/reactions`);
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { emoji: string }) => i.emoji)).toEqual(["🔥"]);
      expect(JSON.stringify(res.body)).not.toContain("a private answer");
    });

    it("is company-scoped and board-only: another company's board user 403, an agent 403, an unknown agent 404", async () => {
      const mine = await seed();
      const other = await seed();
      await react(mine, 1, "👍");
      const url = `/api/agents/${mine.agentId}/reactions`;
      expect((await request(app(outsider(other.companyId))).get(url)).status).toBe(403);
      const agentActor = { type: "agent", agentId: mine.agentId, companyId: mine.companyId, source: "agent_key", runId: null };
      expect((await request(app(agentActor)).get(url)).status).toBe(403);
      expect((await request(app()).get(`/api/agents/${randomUUID()}/reactions`)).status).toBe(404);
      expect((await request(app()).get("/api/agents/not-a-uuid/reactions")).status).toBe(404);
      // Asking for my reactions through the other company's agent id shows none of them.
      const crossed = await request(app()).get(`/api/agents/${other.agentId}/reactions`);
      expect(crossed.status).toBe(200);
      expect(crossed.body.items).toEqual([]);
    });
  });
});
