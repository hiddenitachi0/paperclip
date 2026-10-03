import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  assets,
  issueAttachments,
  companies,
  companyReactionEmojiConfig,
  createDb,
  laneAConversations,
  laneAMessages,
  telegramMessageReactions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { telegramReactionRoutes } from "../routes/telegram-reactions.js";

/**
 * DUR-4344: Telegram reaction feedback. What a careless change would quietly
 * take away: company isolation, removal voiding (not duplicating) the event,
 * the agent/board gates, and the per-company emoji meanings.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping Telegram reaction route tests: ${support.reason ?? "unsupported environment"}`);
}

d("telegram reaction routes", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("telegram-reactions");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(telegramMessageReactions);
    await db.delete(companyReactionEmojiConfig);
    await db.delete(activityLog);
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(agents);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Quick",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      runtimeConfig: {},
    });
    const conversationId = randomUUID();
    await db.insert(laneAConversations).values({ id: conversationId, companyId, agentId, requestedByUserId: "u", turnCount: 1 });
    const messageId = randomUUID();
    await db.insert(laneAMessages).values({ id: messageId, companyId, conversationId, agentId, role: "assistant", content: "hi" });
    return { companyId, agentId, conversationId, messageId };
  }

  const admin = { type: "board", source: "local_implicit", userId: "operator", isInstanceAdmin: true };
  const member = (companyId: string, membershipRole: string) => ({
    type: "board",
    source: "session",
    userId: "member",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole }],
  });

  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = actor;
      next();
    });
    a.use("/api", telegramReactionRoutes(db));
    a.use(errorHandler);
    return a;
  }

  async function seedPicture(companyId: string) {
    const assetId = randomUUID();
    await db.insert(assets).values({
      id: assetId, companyId, provider: "local", objectKey: `k/${assetId}`, contentType: "image/png", byteSize: 1, sha256: "x",
    });
    const id = randomUUID();
    await db.insert(issueAttachments).values({ id, companyId, assetId });
    return id;
  }

  const event = (s: Awaited<ReturnType<typeof seed>>, extra: Record<string, unknown> = {}) => ({
    agentId: s.agentId,
    telegramUserId: "42",
    telegramChatId: "42",
    telegramMessageId: 7,
    conversationId: s.conversationId,
    messageId: s.messageId,
    emoji: "👍",
    action: "added",
    ...extra,
  });

  it("records a reaction with picture metadata and writes an activity row", async () => {
    const s = await seed();
    const fileId = await seedPicture(s.companyId);
    const res = await request(app(admin))
      .post(`/api/companies/${s.companyId}/telegram-reactions`)
      .send(event(s, { picture: { fileId, prompt: "a blue sofa", look: "warm", provider: "x", model: "y" } }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ emoji: "👍", active: true, pictureFileId: fileId, picturePrompt: "a blue sofa" });
    const activity = await db.select().from(activityLog);
    expect(activity.map((row) => row.action)).toContain("telegram_reaction.added");
  });

  it("refuses a plain member and a picture from another company", async () => {
    const s = await seed();
    const other = await seed();
    const url = `/api/companies/${s.companyId}/telegram-reactions`;
    expect((await request(app(member(s.companyId, "member"))).post(url).send(event(s))).status).toBe(403);
    expect((await request(app(member(s.companyId, "admin"))).post(url).send(event(s))).status).toBe(201);
    const foreign = await seedPicture(other.companyId);
    const res = await request(app(admin)).post(url).send(event(s, { emoji: "🔥", picture: { fileId: foreign } }));
    expect(res.status).toBe(422);
    expect((await request(app(admin)).post(url).send(event(s, { emoji: "🔥", picture: { fileId: randomUUID() } }))).status).toBe(422);
  });

  it("removal voids the same row; re-adding revives it; no duplicate rows", async () => {
    const s = await seed();
    const url = `/api/companies/${s.companyId}/telegram-reactions`;
    expect((await request(app(admin)).post(url).send(event(s))).status).toBe(201);
    expect((await request(app(admin)).post(url).send(event(s))).status).toBe(409);
    expect((await request(app(admin)).post(url).send(event(s, { action: "removed" }))).status).toBe(200);
    expect((await request(app(admin)).post(url).send(event(s, { action: "removed" }))).status).toBe(404);
    let rows = await db.select().from(telegramMessageReactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ active: false });
    expect(rows[0]!.removedAt).not.toBeNull();
    expect((await request(app(admin)).post(url).send(event(s))).status).toBe(200);
    rows = await db.select().from(telegramMessageReactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ active: true, removedAt: null });
  });

  it("refuses bad input, foreign agents/conversations, agents and other companies", async () => {
    const s = await seed();
    const other = await seed();
    const url = `/api/companies/${s.companyId}/telegram-reactions`;
    expect((await request(app(admin)).post(url).send(event(s, { emoji: "nope" }))).status).toBe(400);
    expect((await request(app(admin)).post(url).send(event(s, { agentId: other.agentId }))).status).toBe(404);
    expect((await request(app(admin)).post(url).send(event(s, { conversationId: other.conversationId }))).status).toBe(422);
    expect((await request(app(admin)).post(url).send(event(s, { messageId: other.messageId }))).status).toBe(422);
    const agentActor = { type: "agent", agentId: s.agentId, companyId: s.companyId, source: "agent_key", runId: null };
    expect((await request(app(agentActor)).post(url).send(event(s))).status).toBe(403);
    expect((await request(app(member(other.companyId, "owner"))).post(url).send(event(s))).status).toBe(403);
    expect(await db.select().from(telegramMessageReactions)).toHaveLength(0);
  });

  it("serves defaults, lets an admin (not a plain member) change them, and rejects overlap", async () => {
    const s = await seed();
    const url = `/api/companies/${s.companyId}/reaction-emoji-config`;
    const initial = await request(app(member(s.companyId, "member"))).get(url);
    expect(initial.body).toMatchObject({ isDefault: true, positive: expect.arrayContaining(["👍"]) });

    const body = { positive: ["👍", "🎉"], negative: ["👎"], neutral: ["😂"] };
    expect((await request(app(member(s.companyId, "member"))).put(url).send(body)).status).toBe(403);
    expect((await request(app(member(s.companyId, "admin"))).put(url).send({ ...body, neutral: ["👍"] })).status).toBe(422);
    const saved = await request(app(member(s.companyId, "admin"))).put(url).send(body);
    expect(saved.status).toBe(200);
    expect((await request(app(admin)).get(url)).body).toMatchObject({ isDefault: false, positive: ["👍", "🎉"] });

    const e = await request(app(admin)).post(`/api/companies/${s.companyId}/telegram-reactions`).send(event(s, { emoji: "🎉" }));
    expect(e.status).toBe(201);
    const listed = await request(app(admin)).get(`/api/companies/${s.companyId}/telegram-reactions`);
    expect(listed.body[0]).toMatchObject({ emoji: "🎉", meaning: "positive" });
  });
});
