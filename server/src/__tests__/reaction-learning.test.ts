import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentMemories,
  agents,
  assets,
  companies,
  companyReactionEmojiConfig,
  createDb,
  issueAttachments,
  laneAConversations,
  laneAMessages,
  pluginState,
  plugins,
  telegramMessageReactions,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { telegramReactionRoutes } from "../routes/telegram-reactions.js";
import { PICTURE_FOLLOW_UP_QUESTION, reactionLearningService } from "../services/reaction-learning.js";
import { assemblePrompt, normalizeLearned } from "../../../packages/plugins/media-studio/src/look-prompt.js";

/**
 * DUR-4345 acceptance: a thumbs-down and a heart on two different pictures,
 * after summarising, produce notes and picture learnings that measurably
 * change the NEXT picture's assembled prompt; removing a reaction removes
 * its effect on the next run; the follow-up question is asked once per picture.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("reaction learning", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("reaction-learning");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  afterEach(async () => {
    for (const table of [telegramMessageReactions, companyReactionEmojiConfig, activityLog, agentMemories, pluginState, plugins, laneAMessages, laneAConversations, agents, issueAttachments, assets, companies]) {
      await db.delete(table);
    }
  });
  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "C", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Maja", role: "engineer", status: "idle", adapterType: "process", adapterConfig: { command: "echo" }, runtimeConfig: {} });
    const conversationId = randomUUID();
    await db.insert(laneAConversations).values({ id: conversationId, companyId, agentId, requestedByUserId: "u", turnCount: 1 });
    await db.insert(plugins).values({ pluginKey: "paperclip.media-studio", packageName: "ms", version: "1", manifestJson: {} as never, status: "ready" });
    return { companyId, agentId, conversationId };
  }

  async function picture(companyId: string) {
    const assetId = randomUUID();
    await db.insert(assets).values({ id: assetId, companyId, provider: "local", objectKey: `k/${assetId}`, contentType: "image/png", byteSize: 1, sha256: "x" });
    const id = randomUUID();
    await db.insert(issueAttachments).values({ id, companyId, assetId });
    return id;
  }

  const admin = { type: "board", source: "local_implicit", userId: "operator", isInstanceAdmin: true };
  function app() {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = admin;
      next();
    });
    a.use("/api", telegramReactionRoutes(db));
    a.use(errorHandler);
    return a;
  }

  async function react(s: Awaited<ReturnType<typeof seed>>, messageNo: number, emoji: string, prompt: string, action = "added") {
    const fileId = await picture(s.companyId);
    const res = await request(app())
      .post(`/api/companies/${s.companyId}/telegram-reactions`)
      .send({ agentId: s.agentId, telegramUserId: "42", telegramChatId: "42", telegramMessageId: messageNo, emoji, action: "added", picture: { fileId, prompt, look: "L", provider: "fal", model: "m" } });
    expect(res.status).toBe(201);
    if (action === "removed") {
      const rm = await request(app())
        .post(`/api/companies/${s.companyId}/telegram-reactions`)
        .send({ agentId: s.agentId, telegramUserId: "42", telegramChatId: "42", telegramMessageId: messageNo, emoji, action: "removed" });
      expect(rm.status).toBe(200);
    }
    return res.body as { id: string; followUpQuestion: string | null };
  }

  async function learnedFor(s: Awaited<ReturnType<typeof seed>>) {
    const [row] = await db.select().from(pluginState).where(and(eq(pluginState.stateKey, "pictureFeedback"), eq(pluginState.scopeId, s.companyId)));
    return normalizeLearned((row?.valueJson as Record<string, unknown> | undefined)?.[`agent:${s.agentId}`]);
  }

  it("a thumbs-down and a heart change the next picture's prompt, and removing one undoes its effect", async () => {
    const s = await seed();
    const svc = reactionLearningService(db);
    const before = assemblePrompt({ request: "a woman in a cafe", service: "fal" }).prompt;

    await react(s, 1, "👎", "a poster with big text and a caption");
    const loved = await react(s, 2, "❤", "warm golden hour portrait on a beach");
    await svc.summarize(s.companyId, s.agentId);

    const notes = await db.select().from(agentMemories).where(eq(agentMemories.source, "reaction"));
    const text = notes.map((n) => n.text).join(" ");
    expect(text).toContain("warm golden-hour light");
    expect(text).toContain("text or lettering in the picture");
    expect(notes.every((n) => n.text.length <= 500)).toBe(true);

    const learned = await learnedFor(s);
    expect(learned?.doMore).toContain("warm golden-hour light");
    expect(learned?.avoid).toContain("text or lettering in the picture");
    const after = assemblePrompt({ request: "a woman in a cafe", service: "fal", learned }).prompt;
    expect(after).not.toBe(before);
    expect(after).toContain("Lean towards: ");
    expect(after).toContain("Avoid: text or lettering in the picture");
    expect(after).not.toContain("big text and a caption"); // never the old prompt verbatim

    // Taking the heart back removes its effect immediately (removal re-summarises).
    await request(app())
      .post(`/api/companies/${s.companyId}/telegram-reactions`)
      .send({ agentId: s.agentId, telegramUserId: "42", telegramChatId: "42", telegramMessageId: 2, emoji: "❤", action: "removed" })
      .expect(200);
    const afterRemoval = await learnedFor(s);
    expect(afterRemoval?.doMore ?? []).not.toContain("warm golden-hour light");
    expect(afterRemoval?.avoid).toContain("text or lettering in the picture");
    expect(loved.id).toBeTruthy();
  });

  it("summarises on its own after every 5 new reactions, and keeps written notes", async () => {
    const s = await seed();
    await db.insert(agentMemories).values({ companyId: s.companyId, agentId: s.agentId, text: "likes tea", source: "user" });
    for (let i = 1; i <= 4; i++) await react(s, i, "❤", "warm sunset");
    expect(await db.select().from(agentMemories).where(eq(agentMemories.source, "reaction"))).toHaveLength(0);
    await react(s, 5, "❤", "warm sunset");
    expect((await db.select().from(agentMemories).where(eq(agentMemories.source, "reaction"))).length).toBeGreaterThan(0);
    expect(await db.select().from(agentMemories).where(eq(agentMemories.source, "user"))).toHaveLength(1);
  });

  it("asks the follow-up once per negatively-reacted picture and stores the answer", async () => {
    const s = await seed();
    const first = await react(s, 1, "👎", "a dark scene");
    expect(first.followUpQuestion).toBe(PICTURE_FOLLOW_UP_QUESTION);
    // Reacting again on the same picture never asks again.
    const again = await request(app())
      .post(`/api/companies/${s.companyId}/telegram-reactions`)
      .send({ agentId: s.agentId, telegramUserId: "42", telegramChatId: "42", telegramMessageId: 1, emoji: "🤨", action: "added", picture: { fileId: await picture(s.companyId), prompt: "a dark scene" } });
    expect(again.body.followUpQuestion).toBeNull();
    const heart = await react(s, 2, "❤", "warm");
    expect(heart.followUpQuestion).toBeNull();

    await request(app())
      .post(`/api/companies/${s.companyId}/telegram-reactions/${first.id}/follow-up-answer`)
      .send({ answer: "less dark colours" })
      .expect(200);
    const notes = await db.select().from(agentMemories).where(eq(agentMemories.source, "reaction"));
    expect(notes.map((n) => n.text).join(" ")).toContain("less dark colours");
    // The typed answer is kept out of the picture-prompt learnings.
    expect(JSON.stringify(await learnedFor(s))).not.toContain("less dark colours");
  });
});
