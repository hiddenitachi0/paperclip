import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyHelperSettings,
  costEvents,
  createDb,
  modelDirectoryEntries,
  plugins,
  videoScenes,
  videoStorylineDirectors,
  videoUploads,
} from "@paperclipai/db";
import { HELPER_BINDING_TARGET_TYPE, helperKeyConfigPath, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.ts";
import { videoStorylineRoutes } from "../routes/video-storylines.ts";
import { secretService } from "../services/secrets.ts";
import { videoStorylineDirectorsService } from "../services/video-storyline-directors.ts";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.ts";
import { videoStorylineWriterService } from "../services/video-storyline-writer.ts";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.ts";
import type { StorageService } from "../storage/types.ts";

/**
 * Storyline directors and the AI story writer (18 Oct 2026): directors CRUD,
 * starters and permissions; the one-stop write flow with mocked models
 * (picture analysis -> writer -> saved shots), follow-up questions, the
 * text-only path with JSON repair, the tool-helper path, improvements as
 * accepted changes, and company scoping. No real model is ever called: every
 * provider request goes to the stub below, which answers by who is asking
 * (the system prompt) and records what was sent.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping story writer tests: ${support.reason ?? "unsupported environment"}`);
}

const ACTOR: VideoStorylineActor = { actorType: "user", actorId: "owner-1", agentId: null };

type Body = { model: string; messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>; tools?: unknown[] };
type Reply = Record<string, unknown>;

function textReply(content: string, cost = 0.001): Reply {
  return { choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, cost } };
}

function toolReply(name: string, args: Record<string, unknown>, cost = 0.001): Reply {
  return {
    choices: [{ message: { content: "", tool_calls: [{ id: `call_${randomUUID().slice(0, 6)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 120, completion_tokens: 60, cost },
  };
}

const STORYBOARD = {
  title: "The Lighthouse",
  characters: { Ada: "a woman in her 60s with short silver hair and a yellow scarf" },
  music: "soft piano, slow",
  voice: null,
  scenes: [
    {
      scene_title: "Dusk",
      scene_notes: null,
      shots: [
        { prompt: "Wide shot of a white lighthouse on a cliff at dusk.", camera_notes: "slow push-in", duration_seconds: 5, transition_in: "fade", cast: [] },
        { prompt: "Ada, a woman in her 60s with short silver hair and a yellow scarf, climbs the stairs.", camera_notes: null, duration_seconds: 5, transition_in: null, cast: ["Ada"] },
        { prompt: "The lamp turns on and its beam sweeps the sea.", camera_notes: "static", duration_seconds: 10, transition_in: null, cast: [] },
      ],
    },
  ],
};

d("storyline directors and the AI story writer", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const sent: Array<{ who: string; body: Body }> = [];
  const queues: Record<string, Reply[]> = { writer: [], helper: [], repair: [], analysis: [], age: [] };
  let png!: Buffer;

  function who(body: Body): string {
    const system = String(body.messages.find((m) => m.role === "system")?.content ?? "");
    if (system.includes("You check a picture")) return "age";
    if (system.includes("You look at reference pictures")) return "analysis";
    if (system.includes("You help a storyboard writer")) return "helper";
    if (system.includes("You fix a storyboard writer")) return "repair";
    if (system.includes("You are the story writer")) return "writer";
    return "other";
  }

  const providerFetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    const role = who(body);
    sent.push({ who: role, body });
    const next = queues[role]?.shift();
    if (!next) return new Response(JSON.stringify({ error: { message: `no stub answer left for ${role}` } }), { status: 500 });
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const storage = (() => ({
    getObject: async () => ({ stream: Readable.from(png), contentType: "image/png", contentLength: png.byteLength }),
  })) as unknown as () => StorageService;

  const options = { providerFetch, storage, priceFetch: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch };

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-writer");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    const manifest = {
      id: "paperclip.media-studio",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Media Studio",
      description: "Media generation",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [],
      entrypoints: { worker: "dist/worker.js" },
    } as unknown as PaperclipPluginManifestV1;
    await db.insert(plugins).values({
      pluginKey: "paperclip.media-studio",
      packageName: "@paperclipai/plugin-media-studio",
      version: "1.0.0",
      manifestJson: manifest,
      status: "ready",
    });
    png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  function reset() {
    sent.length = 0;
    for (const key of Object.keys(queues)) queues[key] = [];
  }

  async function entry(companyId: string, values: { name: string; provider: string; model: string; specs?: Record<string, unknown> }) {
    const [row] = await db
      .insert(modelDirectoryEntries)
      .values({ companyId, name: values.name, provider: values.provider, model: values.model, baseUrl: null, specs: (values.specs ?? null) as never })
      .returning();
    return row!.id;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Film Co",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const secrets = secretService(db);
    const openaiKey = await secrets.create(companyId, { name: `OpenAI ${randomUUID().slice(0, 4)}`, provider: "local_encrypted", value: `sk-test-${randomUUID()}` });
    const openrouterKey = await secrets.create(companyId, { name: `OpenRouter ${randomUUID().slice(0, 4)}`, provider: "local_encrypted", value: `sk-or-test-${randomUUID()}` });
    const vision = await entry(companyId, { name: "Eyes", provider: "openai", model: "gpt-4o", specs: { vision: true } });
    const toolWriter = await entry(companyId, { name: "Tool writer", provider: "openai", model: "gpt-4.1", specs: { tools: "yes" } });
    const textWriter = await entry(companyId, {
      name: "Story model",
      provider: "openrouter",
      model: "someorg/storyteller-70b",
      specs: { openrouterHostsSeen: [{ slug: "onlyhost", tools: false }] },
    });
    const helperModel = await entry(companyId, { name: "Helper", provider: "openai", model: "gpt-4.1-mini", specs: { tools: "yes" } });
    // The helper's default (also the age check's picture reader) with the helper's OpenAI key.
    await secrets.syncSecretRefsForTarget(
      companyId,
      { targetType: HELPER_BINDING_TARGET_TYPE, targetId: companyId },
      [{ secretId: openaiKey.id, configPath: helperKeyConfigPath("openai"), label: "Helper (OpenAI)" }],
      { replaceAll: true },
    );
    await db.insert(companyHelperSettings).values({ companyId, defaultDirectoryEntryId: vision, updatedByUserId: "test" });
    const storyline = await videoStorylineService(db).createStoryline(
      companyId,
      { title: "Lighthouse", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] } as never,
      ACTOR,
    );
    return { companyId, storylineId: storyline.id, openaiKey: openaiKey.id, openrouterKey: openrouterKey.id, vision, toolWriter, textWriter, helperModel };
  }

  // ─── Directors ───

  it("gives every company the two starters once; deleting them does not bring them back", async () => {
    const co = await seedCompany();
    const svc = videoStorylineDirectorsService(db, options);
    const first = await svc.list(co.companyId, { canEdit: true });
    expect(first.directors.map((d) => d.name)).toEqual(["Tutorial / explainer", "Action movie"]);
    expect(first.directors.map((d) => d.builtinKey)).toEqual(["tutorial", "action"]);
    expect(first.directors[1]!.styleInstructions).toMatch(/Tracking shots/);
    await svc.remove(co.companyId, first.directors[0]!.id, ACTOR);
    const again = await svc.list(co.companyId, { canEdit: true });
    expect(again.directors.map((d) => d.name)).toEqual(["Action movie"]);
  });

  it("says so when a starter has no model to write with (no writing model, no helper model, no Paperclip key)", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Bare Co", issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const view = await videoStorylineDirectorsService(db, options).list(companyId, { canEdit: false });
      expect(view.directors.every((d) => d.writerMode === "no_model")).toBe(true);
      expect(view.directors[0]!.writerModeNote).toMatch(/no writing model/);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("creates, edits and deletes directors, only with this company's saved models and keys", async () => {
    const co = await seedCompany();
    const other = await seedCompany();
    const svc = videoStorylineDirectorsService(db, options);
    const created = await svc.create(
      co.companyId,
      {
        name: "Noir",
        description: "Dark and moody",
        writingEntryId: co.textWriter,
        writingKeySecretId: co.openrouterKey,
        analysisEntryId: co.vision,
        analysisKeySecretId: co.openaiKey,
        helperEntryId: co.helperModel,
        helperKeySecretId: co.openaiKey,
        temperature: 0.7,
        thinking: "off",
        styleInstructions: "Rain, neon, long shadows.",
        defaultVideoProviderId: "fal",
        defaultVideoModel: null,
        defaultLookId: null,
        defaultShotSeconds: 10,
      },
      ACTOR,
    );
    expect(created.writing?.name).toBe("Story model");
    expect(created.writing?.toolSupport?.canUseTools).toBe(false);
    expect(created.writing?.keyReady).toBe(true);
    expect(created.analysis?.canSeePictures).toBe(true);
    expect(created.writerMode).toBe("text_with_helper");
    expect(created.writerModeNote).toBe("This model can't use tools; the helper model does the lookups for it.");
    expect(created.helper?.readiness?.badge).toBeTruthy();

    await expect(svc.create(co.companyId, { ...baseInput("Theft"), writingEntryId: other.toolWriter }, ACTOR)).rejects.toThrow(/not one of this company's saved models/);
    await expect(svc.create(co.companyId, { ...baseInput("Theft 2"), writingKeySecretId: other.openaiKey }, ACTOR)).rejects.toThrow(/not one of this company's secrets/);
    await expect(svc.create(co.companyId, baseInput("noir"), ACTOR)).rejects.toThrow(/already a director called/);

    const updated = await svc.update(co.companyId, created.id, { name: "Noir II", helperEntryId: null }, ACTOR);
    expect(updated.name).toBe("Noir II");
    expect(updated.writerMode).toBe("text_only");
    // Another company can neither read nor change it.
    await expect(svc.update(other.companyId, created.id, { name: "Mine" }, ACTOR)).rejects.toThrow(/not in this company/);
    await expect(svc.setStorylineDirector(other.companyId, other.storylineId, created.id, ACTOR)).rejects.toThrow(/not in this company/);
    await svc.remove(co.companyId, created.id, ACTOR);
    const [gone] = await db.select().from(videoStorylineDirectors).where(eq(videoStorylineDirectors.id, created.id));
    expect(gone).toBeUndefined();
  });

  function baseInput(name: string) {
    return {
      name,
      description: "",
      writingEntryId: null,
      writingKeySecretId: null,
      analysisEntryId: null,
      analysisKeySecretId: null,
      helperEntryId: null,
      helperKeySecretId: null,
      temperature: null,
      thinking: null,
      styleInstructions: "",
      defaultVideoProviderId: null,
      defaultVideoModel: null,
      defaultLookId: null,
      defaultShotSeconds: null,
    };
  }

  it("routes: anyone in the company sees directors; only owners and admins change them", async () => {
    const co = await seedCompany();
    const member = { type: "board", source: "session", userId: "member-1", isInstanceAdmin: false, companyIds: [co.companyId], memberships: [{ companyId: co.companyId, status: "active", membershipRole: "member" }] };
    const owner = { ...member, userId: "owner-1", memberships: [{ companyId: co.companyId, status: "active", membershipRole: "owner" }] };
    const outsider = { ...member, userId: "x-1", companyIds: [randomUUID()], memberships: [] };
    const appFor = (actor: unknown) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = actor as typeof req.actor;
        next();
      });
      app.use("/api", videoStorylineRoutes(db));
      app.use(errorHandler);
      return app;
    };
    const base = `/api/companies/${co.companyId}/video-storylines`;
    const asMember = await request(appFor(member)).get(`${base}/directors`);
    expect(asMember.status).toBe(200);
    expect(asMember.body.canEdit).toBe(false);
    expect(asMember.body.directors).toHaveLength(2);
    expect((await request(appFor(member)).post(`${base}/directors`).send({ name: "Mine" })).status).toBe(403);
    expect((await request(appFor(member)).delete(`${base}/directors/${asMember.body.directors[0].id}`)).status).toBe(403);
    const asOwner = await request(appFor(owner)).get(`${base}/directors`);
    expect(asOwner.body.canEdit).toBe(true);
    const created = await request(appFor(owner)).post(`${base}/directors`).send({ name: "Mine", styleInstructions: "Short and sweet." });
    expect(created.status).toBe(201);
    expect((await request(appFor(owner)).patch(`${base}/directors/${created.body.id}`).send({ description: "Changed" })).body.description).toBe("Changed");
    // A member may still pick a director for a storyline.
    const picked = await request(appFor(member)).put(`${base}/${co.storylineId}/director`).send({ directorId: created.body.id });
    expect(picked.status).toBe(200);
    expect(picked.body.directorId).toBe(created.body.id);
    expect((await request(appFor(owner)).delete(`${base}/directors/${created.body.id}`)).status).toBe(204);
    // Someone outside the company sees nothing.
    expect((await request(appFor(outsider)).get(`${base}/directors`)).status).toBe(403);
    expect((await request(appFor(outsider)).get(`${base}/${co.storylineId}/writer`)).status).toBe(403);
  });

  // ─── The writer ───

  async function director(companyId: string, values: Partial<ReturnType<typeof baseInput>>) {
    return videoStorylineDirectorsService(db, options).create(companyId, { ...baseInput(`D ${randomUUID().slice(0, 6)}`), ...values }, ACTOR);
  }

  it("one stop: the pictures are described by the vision model, the writer (with tools) writes, the shots are saved", async () => {
    reset();
    const co = await seedCompany();
    const dir = await director(co.companyId, {
      writingEntryId: co.toolWriter,
      writingKeySecretId: co.openaiKey,
      analysisEntryId: co.vision,
      analysisKeySecretId: co.openaiKey,
      styleInstructions: "Slow and calm.",
    });
    const [upload] = await db
      .insert(videoUploads)
      .values({ companyId: co.companyId, storylineId: co.storylineId, kind: "photo", status: "ready", sourceContentType: "image/png", objectKey: "photo-1", originalFilename: "cliff.png" })
      .returning();
    queues.age.push(textReply('{"peopleShown": false, "apparentAdult": null}'));
    queues.analysis.push(textReply("Picture 1 (the storyline's photo): a red cliff at dusk, warm light."));
    queues.writer.push(toolReply("lookup_cast", {}), toolReply("submit_storyboard", { note: "A calm lighthouse film.", storyboard: STORYBOARD }));

    const writer = videoStorylineWriterService(db, options);
    const session = await writer.write(
      co.companyId,
      co.storylineId,
      { directorId: dir.id, ideas: "A lighthouse keeper's evening, calm.", targetSeconds: 20, referenceUploadIds: [upload!.id], useCastPictures: true, skipQuestions: false },
      ACTOR,
    );
    expect(session.messages.map((m) => m.kind)).toEqual(["brief", "analysis", "storyboard", "note"]);
    expect(session.state).toBe("idle");
    expect(session.directorId).toBe(dir.id);
    const analysis = session.messages[1]!.payload as { text: string; pictureCount: number };
    expect(analysis.pictureCount).toBe(1);

    // Chain: age check, then the vision model with the picture, then the writer (tools, no picture).
    expect(sent.map((s) => s.who)).toEqual(["age", "analysis", "writer", "writer"]);
    const analysisBody = sent[1]!.body;
    expect(JSON.stringify(analysisBody.messages)).toContain("image_url");
    const writerBody = sent[2]!.body;
    expect(writerBody.model).toBe("gpt-4.1");
    expect(writerBody.tools?.length).toBeGreaterThan(0);
    expect(JSON.stringify(writerBody.messages)).toContain("a red cliff at dusk");
    expect(JSON.stringify(writerBody.messages)).not.toContain("image_url");
    expect(String(writerBody.messages[0]!.content)).toContain("Slow and calm.");
    // The lookup was answered by the server.
    expect(JSON.stringify(sent[3]!.body.messages)).toContain("no cast yet");

    const shots = (await videoStorylineService(db).listShots(co.companyId, co.storylineId)).sort((a, b) => a.orderIndex - b.orderIndex);
    expect(shots.map((s) => s.prompt)).toEqual(STORYBOARD.scenes[0]!.shots.map((s) => s.prompt));
    // Transitions are off for this company, so none were saved.
    expect(shots.every((s) => s.transitionIn === null)).toBe(true);
    const storyline = await videoStorylineService(db).getStoryline(co.companyId, co.storylineId);
    const ada = storyline.cast.members.find((m) => m.name === "Ada");
    expect(ada).toBeTruthy();
    expect((await db.select().from(videoScenes).where(eq(videoScenes.storylineId, co.storylineId)))[0]!.notes).toContain("Music idea: soft piano");
    const costs = await db.select().from(costEvents).where(eq(costEvents.companyId, co.companyId));
    const codes = costs.map((c) => c.billingCode);
    expect(codes).toContain("video_storyline_writer");
    expect(codes).toContain("video_storyline_writer_analysis");
    expect(codes).toContain("video_storyline_footage_age_check");
  });

  it("asks follow-up questions first, then writes with the answers", async () => {
    reset();
    const co = await seedCompany();
    const dir = await director(co.companyId, { writingEntryId: co.toolWriter, writingKeySecretId: co.openaiKey });
    queues.writer.push(toolReply("submit_questions", { questions: [{ question: "Who is it for?", options: ["Kids", "Adults"] }, { question: "How long?" }] }));
    const writer = videoStorylineWriterService(db, options);
    const asking = await writer.write(
      co.companyId,
      co.storylineId,
      { directorId: dir.id, ideas: "A film about a lighthouse.", targetSeconds: null, referenceUploadIds: [], useCastPictures: false, skipQuestions: false },
      ACTOR,
    );
    expect(asking.state).toBe("asking");
    expect(asking.openQuestions?.questions.map((q) => q.question)).toEqual(["Who is it for?", "How long?"]);
    expect(await videoStorylineService(db).listShots(co.companyId, co.storylineId)).toHaveLength(0);

    queues.writer.push(toolReply("submit_storyboard", { storyboard: STORYBOARD }));
    const [q1, q2] = asking.openQuestions!.questions;
    const done = await writer.answer(co.companyId, co.storylineId, { answers: [{ questionId: q1!.id, answer: "Adults" }, { questionId: q2!.id, answer: "20 seconds" }], skipQuestions: false }, ACTOR);
    expect(done.state).toBe("idle");
    const lastWriterBody = sent.filter((s) => s.who === "writer").at(-1)!.body;
    const asText = JSON.stringify(lastWriterBody.messages);
    expect(asText).toContain("ANSWERS TO YOUR QUESTIONS");
    expect(asText).toContain("Adults");
    expect(await videoStorylineService(db).listShots(co.companyId, co.storylineId)).toHaveLength(3);
    await expect(writer.answer(co.companyId, co.storylineId, { answers: [], skipQuestions: false }, ACTOR)).rejects.toThrow(/no open question/);
  });

  it("text-only writer: no tools are sent, and a broken answer is sent back with the problems until it is fixed", async () => {
    reset();
    const co = await seedCompany();
    const dir = await director(co.companyId, { writingEntryId: co.textWriter, writingKeySecretId: co.openrouterKey });
    const broken = { type: "storyboard", storyboard: { scenes: [{ scene_title: "Dusk", shots: [{ camera_notes: "wide" }] }] } };
    queues.writer.push(textReply(`Here you go:\n\`\`\`json\n${JSON.stringify(broken)}\n\`\`\``), textReply(JSON.stringify({ type: "storyboard", storyboard: STORYBOARD })));
    const writer = videoStorylineWriterService(db, options);
    const session = await writer.write(
      co.companyId,
      co.storylineId,
      { directorId: dir.id, ideas: "Lighthouse.", targetSeconds: null, referenceUploadIds: [], useCastPictures: false, skipQuestions: true },
      ACTOR,
    );
    const writerCalls = sent.filter((s) => s.who === "writer");
    expect(writerCalls).toHaveLength(2);
    expect(writerCalls.every((c) => c.body.tools === undefined)).toBe(true);
    // The contract is in the instructions, and the second try carries the problems.
    expect(String(writerCalls[0]!.body.messages[0]!.content)).toContain('"type": "storyboard"');
    expect(JSON.stringify(writerCalls[1]!.body.messages)).toContain("Your answer could not be used");
    expect(JSON.stringify(writerCalls[1]!.body.messages)).toContain("prompt is missing or empty");
    // Without a helper, the server's own lookups went in.
    expect(JSON.stringify(writerCalls[0]!.body.messages)).toContain("LOOKED UP FOR YOU");
    expect(session.messages.find((m) => m.kind === "note")?.payload).toMatchObject({ mode: "text" });
    expect(await videoStorylineService(db).listShots(co.companyId, co.storylineId)).toHaveLength(3);
  });

  it("tool helper: a writer that can't use tools gets the helper's lookups, and the helper fixes what the writer could not", async () => {
    reset();
    const co = await seedCompany();
    const dir = await director(co.companyId, {
      writingEntryId: co.textWriter,
      writingKeySecretId: co.openrouterKey,
      helperEntryId: co.helperModel,
      helperKeySecretId: co.openaiKey,
    });
    queues.helper.push(toolReply("lookup_shots", {}), toolReply("hand_over_notes", { notes: "No shots yet. No cast saved. Keep it to 3 shots." }));
    const bad = textReply("I would love to write this! It starts at dusk...");
    queues.writer.push(bad, bad, bad);
    queues.repair.push(toolReply("submit_storyboard", { note: "Fixed.", storyboard: STORYBOARD }));
    const writer = videoStorylineWriterService(db, options);
    const session = await writer.write(
      co.companyId,
      co.storylineId,
      { directorId: dir.id, ideas: "Lighthouse.", targetSeconds: null, referenceUploadIds: [], useCastPictures: false, skipQuestions: true },
      ACTOR,
    );
    expect(sent.map((s) => s.who)).toEqual(["helper", "helper", "writer", "writer", "writer", "repair"]);
    const writerCalls = sent.filter((s) => s.who === "writer");
    expect(writerCalls.every((c) => c.body.tools === undefined)).toBe(true);
    expect(JSON.stringify(writerCalls[0]!.body.messages)).toContain("HELPER NOTES");
    expect(JSON.stringify(writerCalls[0]!.body.messages)).toContain("Keep it to 3 shots.");
    expect(sent[0]!.body.tools?.length).toBeGreaterThan(0);
    expect(session.messages.find((m) => m.kind === "note")?.payload).toMatchObject({ mode: "text_with_helper" });
    expect(await videoStorylineService(db).listShots(co.companyId, co.storylineId)).toHaveLength(3);
    const codes = (await db.select().from(costEvents).where(eq(costEvents.companyId, co.companyId))).map((c) => c.billingCode);
    expect(codes).toContain("video_storyline_writer_helper");
  });

  it("improvements come back as a list of changes; only the accepted ones are applied", async () => {
    reset();
    const co = await seedCompany();
    const dir = await director(co.companyId, { writingEntryId: co.toolWriter, writingKeySecretId: co.openaiKey });
    const writer = videoStorylineWriterService(db, options);
    queues.writer.push(toolReply("submit_storyboard", { storyboard: STORYBOARD }));
    await writer.write(co.companyId, co.storylineId, { directorId: dir.id, ideas: "Lighthouse.", targetSeconds: null, referenceUploadIds: [], useCastPictures: false, skipQuestions: true }, ACTOR);
    const before = (await videoStorylineService(db).listShots(co.companyId, co.storylineId)).sort((a, b) => a.orderIndex - b.orderIndex);

    queues.writer.push(
      toolReply("submit_changes", {
        note: "More drama, shorter.",
        changes: [
          { op: "update", shot: 2, prompt: "Ada races up the stairs as thunder cracks." , duration_seconds: 5 },
          { op: "add", after_shot: 1, prompt: "Lightning hits the sea.", camera_notes: null, duration_seconds: 5, cast: [] },
          { op: "remove", shot: 3 },
        ],
      }),
    );
    const reviewing = await writer.improve(co.companyId, co.storylineId, { request: "Make shot 2 more dramatic and shorten it" }, ACTOR);
    expect(reviewing.state).toBe("reviewing");
    const setMsg = reviewing.messages.find((m) => m.id === reviewing.pendingChangeSetId)!;
    const payload = setMsg.payload as { changes: Array<{ id: string; op: string; before: { prompt: string } | null; after: { prompt: string } | null }> };
    expect(payload.changes.map((c) => c.op)).toEqual(["update", "add", "remove"]);
    expect(payload.changes[0]!.before?.prompt).toBe(before[1]!.prompt);
    expect(payload.changes[0]!.after?.prompt).toBe("Ada races up the stairs as thunder cracks.");
    // Nothing changed yet.
    expect((await videoStorylineService(db).listShots(co.companyId, co.storylineId)).map((s) => s.prompt).sort()).toEqual(before.map((s) => s.prompt).sort());
    await expect(writer.improve(co.companyId, co.storylineId, { request: "again" }, ACTOR)).rejects.toThrow(/Accept or discard/);

    const accepted = await writer.acceptChanges(co.companyId, co.storylineId, setMsg.id, { changeIds: ["c1", "c2"] }, ACTOR);
    const after = (await videoStorylineService(db).listShots(co.companyId, co.storylineId)).sort((a, b) => a.orderIndex - b.orderIndex);
    expect(after.map((s) => s.prompt)).toEqual([before[0]!.prompt, "Lightning hits the sea.", "Ada races up the stairs as thunder cracks.", before[2]!.prompt]);
    const done = accepted.messages.find((m) => m.id === setMsg.id)!;
    expect(done.status).toBe("partly_applied");
    expect((done.payload as { changes: Array<{ status: string }> }).changes.map((c) => c.status)).toEqual(["accepted", "accepted", "rejected"]);
    expect(accepted.state).toBe("idle");
    await expect(writer.acceptChanges(co.companyId, co.storylineId, setMsg.id, {}, ACTOR)).rejects.toThrow(/already applied/);

    // A rewrite of a storyline that has shots is a change list too, and discarding it changes nothing.
    queues.writer.push(toolReply("submit_storyboard", { storyboard: STORYBOARD }));
    const rewrite = await writer.write(co.companyId, co.storylineId, { ideas: "Start over.", targetSeconds: null, referenceUploadIds: [], useCastPictures: false, skipQuestions: true }, ACTOR);
    expect(rewrite.state).toBe("reviewing");
    const discarded = await writer.discardChanges(co.companyId, co.storylineId, rewrite.pendingChangeSetId!, ACTOR);
    expect(discarded.state).toBe("idle");
    expect(await videoStorylineService(db).listShots(co.companyId, co.storylineId)).toHaveLength(4);
  });

  it("is company-scoped: another company's storyline, changes and directors are out of reach", async () => {
    reset();
    const a = await seedCompany();
    const b = await seedCompany();
    const writer = videoStorylineWriterService(db, options);
    const dirA = await director(a.companyId, { writingEntryId: a.toolWriter, writingKeySecretId: a.openaiKey });
    await expect(writer.getSession(b.companyId, a.storylineId)).rejects.toThrow(/not found/i);
    await expect(
      writer.write(b.companyId, b.storylineId, { directorId: dirA.id, ideas: "x", targetSeconds: null, referenceUploadIds: [], useCastPictures: false, skipQuestions: true }, ACTOR),
    ).rejects.toThrow(/not in this company/);
    queues.writer.push(toolReply("submit_storyboard", { storyboard: STORYBOARD }));
    await writer.write(a.companyId, a.storylineId, { directorId: dirA.id, ideas: "Lighthouse.", targetSeconds: null, referenceUploadIds: [], useCastPictures: false, skipQuestions: true }, ACTOR);
    queues.writer.push(toolReply("submit_changes", { changes: [{ op: "remove", shot: 1 }] }));
    const reviewing = await writer.improve(a.companyId, a.storylineId, { request: "Drop the first shot" }, ACTOR);
    await expect(writer.acceptChanges(b.companyId, b.storylineId, reviewing.pendingChangeSetId!, {}, ACTOR)).rejects.toThrow(/not in this storyline/);
    // Nobody in B ever got a model call.
    expect(sent.every((s) => s.body.model !== "never")).toBe(true);
  });

  it("estimates the writing and the video before anything runs", async () => {
    const co = await seedCompany();
    const dir = await director(co.companyId, { writingEntryId: co.toolWriter, writingKeySecretId: co.openaiKey, defaultShotSeconds: 5 });
    const estimate = await videoStorylineWriterService(db, options).estimate(co.companyId, co.storylineId, {
      directorId: dir.id,
      kind: "write",
      ideas: "A lighthouse.",
      targetSeconds: 30,
      pictureCount: 0,
    });
    expect(estimate.videoCents).toBeGreaterThan(0);
    expect(estimate.summary).toMatch(/Writing costs/);
    expect(estimate.blockedReason).toBeNull();
  });
});
