import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, companies, pluginConfig, pluginState, plugins, videoShots, videoStorylines, videoTransitionTakes, videoTransitions } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedCompanyWriterModel } from "./helpers/storyline-writer-model.js";

/**
 * Storyline strip, Phase 1: transitions keyed by shot pair -- CRUD and
 * company scoping, out-of-date logic and the stitch refusal, budget and the
 * monthly media cap, company-only keys (decision 15), the context packet
 * (age check before a cloud picture reader, text-only fallback, caching),
 * and the provider payload of an AI bridge. Every network call is stubbed:
 * no paid call is ever made.
 */

const storedObjects = vi.hoisted(() => new Map<string, { body: Buffer; contentType: string }>());
vi.mock("../storage/index.ts", () => ({
  getStorageService: () => ({
    provider: "local_disk",
    putFile: async (input: { companyId: string; namespace: string; originalFilename: string | null; contentType: string; body: Buffer }) => {
      const objectKey = `${input.companyId}/${input.namespace}/${Math.random().toString(36).slice(2)}-${input.originalFilename ?? "file"}`;
      storedObjects.set(objectKey, { body: input.body, contentType: input.contentType });
      return { provider: "local_disk", objectKey, contentType: input.contentType, byteSize: input.body.byteLength, sha256: `sha-${objectKey}`, originalFilename: input.originalFilename };
    },
    getObject: async (_companyId: string, objectKey: string) => {
      const found = storedObjects.get(objectKey);
      if (!found) throw new Error(`no such object ${objectKey}`);
      return { stream: Readable.from(found.body), contentType: found.contentType, contentLength: found.body.byteLength };
    },
  }),
}));

const video = vi.hoisted(() => ({
  starts: [] as Array<Record<string, unknown>>,
  keys: [] as string[],
  outcome: { status: "done" } as { status: "done" | "failed" | "running"; error?: string },
}));
vi.mock("../services/video-provider-clients.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/video-provider-clients.ts")>();
  class Stub {
    constructor(
      readonly name: string,
      apiKey: string,
    ) {
      video.keys.push(apiKey);
    }
    async start(input: Record<string, unknown>) {
      video.starts.push(input);
      return { externalId: `job-${video.starts.length}`, model: String(input.model), provider: this.name };
    }
    async poll() {
      if (video.outcome.status === "done") return { status: "done" as const, result: { contentType: "video/mp4", dataUrl: `data:video/mp4;base64,${Buffer.from("bridge").toString("base64")}` } };
      if (video.outcome.status === "failed") return { status: "failed" as const, error: video.outcome.error ?? "nope" };
      return { status: "running" as const };
    }
    async cancel() {}
  }
  return {
    ...actual,
    FalVideoProvider: class extends Stub {
      constructor(apiKey: string) {
        super("fal", apiKey);
      }
    },
    SogniVideoProvider: class extends Stub {
      constructor(opts: { apiKey: string }) {
        super("sogni", opts.apiKey);
      }
    },
  };
});
vi.mock("../services/video-ffmpeg.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/video-ffmpeg.ts")>()),
  extractLastFrameDataUri: async () => "data:image/jpeg;base64,TEFTVA==",
  extractFirstFrameDataUri: async () => "data:image/jpeg;base64,RklSU1Q=",
  buildClipContactSheet: async (_clip: Buffer, side: string) => Buffer.from(`sheet-${side}`),
}));
vi.mock("../services/fal-cost-events.ts", () => ({ recordFalCostEvent: async () => null }));

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping transitions tests: ${support.reason ?? "unsupported environment"}`);

const { videoStorylineTransitionsService, buildStitchPlan, transitionAnchorHash, parseTransitionSuggestion, parseFrameAgeCheck, NO_READER_MESSAGE, AGE_REFUSED_MESSAGE } = await import(
  "../services/video-storyline-transitions.ts"
);
const { videoStorylineSettingsService } = await import("../services/video-storyline-settings.ts");
const { videoStorylineService } = await import("../services/video-storylines.ts");
const { videoStorylineStitchService } = await import("../services/video-storyline-stitch.ts");
const { secretService } = await import("../services/secrets.ts");
const { storylineCompanyModel } = await import("../services/video-storyline-company-model.ts");
const { videoStorylineRoutes } = await import("../routes/video-storylines.ts");
const { errorHandler } = await import("../middleware/index.ts");

const ACTOR = { actorType: "user" as const, actorId: "filip", agentId: null };

/** A stub Claude: answers the age check, the frame reader and the writer by their system prompt. */
function fakeModel(opts: { ageAnswer?: string } = {}) {
  const calls: Array<{ system: string; hasImage: boolean }> = [];
  const create = vi.fn(async (req: { system: string; messages: Array<{ content: unknown }> }) => {
    const content = req.messages[0]?.content;
    const hasImage = Array.isArray(content) && content.some((p: { type?: string }) => p.type === "image");
    calls.push({ system: req.system, hasImage });
    let text: string;
    if (req.system.startsWith("You check pictures")) text = opts.ageAnswer ?? '{"peopleShown": true, "apparentAdult": true}';
    else if (req.system.startsWith("You describe a strip")) text = "A woman in a red coat walks left toward a door; warm light; frame 3 is sharpest.";
    else
      text = JSON.stringify({
        suggestedKind: "ai",
        reason: "Same place, she keeps moving, so a camera follow hides the join.",
        aiStyle: "follow_character",
        plainLine: "The camera follows Anna out through the door into the rain. 3 s.",
        prompt: "Continuous shot, no cut. Anna pushes open the door and walks out into the rain; the camera follows at shoulder height.",
        durationSeconds: 3,
      });
    return { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "end_turn" };
  });
  return { calls, create, createModelClient: () => ({ messages: { create } }) as never };
}

d("storyline strip transitions", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let pluginId = "";
  let ownerCompanyId = "";
  let instanceSecretId = "";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-transitions");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    const manifest = { id: "paperclip.media-studio", apiVersion: 1, version: "1.0.0", displayName: "Media Studio", description: "x", author: "x", categories: ["automation"], capabilities: [], entrypoints: { worker: "dist/worker.js" } } as unknown as PaperclipPluginManifestV1;
    const [plugin] = await db.insert(plugins).values({ pluginKey: "paperclip.media-studio", packageName: "@paperclipai/plugin-media-studio", version: "1.0.0", manifestJson: manifest, status: "ready" }).returning();
    pluginId = plugin!.id;
    // The instance's Fal key belongs to the instance owner's company.
    ownerCompanyId = await seedCompany("Owner Co");
    instanceSecretId = (await secretService(db).create(ownerCompanyId, { name: "instance fal", provider: "local_encrypted", value: "instance-fal-key" })).id;
    await db.insert(pluginConfig).values({ pluginId, configJson: { falKeySecretRef: instanceSecretId } });
  }, 120_000);

  afterAll(async () => {
    await stopDb?.();
  });

  beforeEach(() => {
    video.starts.length = 0;
    video.keys.length = 0;
    video.outcome = { status: "done" };
  });

  async function seedCompany(name: string): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({ id, name, issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    return id;
  }

  async function giveOwnFalKey(companyId: string) {
    const secret = await secretService(db).create(companyId, { name: `fal ${randomUUID().slice(0, 4)}`, provider: "local_encrypted", value: `own-fal-${companyId.slice(0, 4)}` });
    await db.insert(pluginState).values({ pluginId, scopeKind: "company", scopeId: companyId, namespace: "default", stateKey: "serviceKeys", valueJson: { fal: secret.id } });
    return secret;
  }

  /** A finished two-shot film on Fal. */
  async function seedFilm(opts: { ownKey?: boolean; vision?: boolean; budgetCapCents?: number | null } = {}) {
    const companyId = await seedCompany("Film Co");
    const settings = videoStorylineSettingsService(db);
    await settings.setEnabled(companyId, true);
    await settings.setAdvancedEnabled(companyId, true);
    await seedCompanyWriterModel(db, companyId, { canSeePictures: opts.vision ?? false });
    if (opts.ownKey !== false) await giveOwnFalKey(companyId);
    const svc = videoStorylineService(db);
    const storyline = await svc.createStoryline(
      companyId,
      { title: "Rainy Café", projectId: null, providerId: "fal", model: null, budgetCapCents: opts.budgetCapCents === undefined ? 1_000 : opts.budgetCapCents, characterReferenceAssetIds: [], defaultTransition: "cut", defaultTransitionDurationMs: 500, musicAssetId: null, musicSourceKey: null, musicVolumeDb: -18 },
      ACTOR,
    );
    const scene = await svc.createScene(companyId, storyline.id, { title: "Café", notes: "Evening", orderIndex: 0 }, ACTOR);
    const shotIds: string[] = [];
    for (const [i, prompt] of ["Anna drinks coffee by the window", "Anna steps into the rainy street"].entries()) {
      const shot = await svc.createShot(companyId, storyline.id, { sceneId: scene.id, orderIndex: i, prompt, cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null }, ACTOR);
      const key = `${companyId}/clips/${shot.id}.mp4`;
      storedObjects.set(key, { body: Buffer.from(`clip-${i}`), contentType: "video/mp4" });
      await db
        .update(videoShots)
        .set({ status: "done", storyboardStatus: "approved", resultProvider: "local_disk", resultObjectKey: key, resultContentType: "video/mp4", resultSha256: `clip-sha-${i}`, actualCostCents: 0 })
        .where(eq(videoShots.id, shot.id));
      shotIds.push(shot.id);
    }
    await db.update(videoStorylines).set({ status: "done" }).where(eq(videoStorylines.id, storyline.id));
    return { companyId, storylineId: storyline.id, a: shotIds[0]!, b: shotIds[1]! };
  }

  it("parses the writer's JSON strictly and the age check with a no-people outcome", () => {
    const model = { minSeconds: 3, maxSeconds: 15 };
    expect(parseTransitionSuggestion('x {"suggestedKind":"blend","reason":"dialogue","plainLine":"Soft blend. 0.5 s.","prompt":"","durationSeconds":1} y', model)).toMatchObject({ suggestedKind: "blend", durationSeconds: 3 });
    expect(() => parseTransitionSuggestion("HACKED", model)).toThrow();
    expect(() => parseTransitionSuggestion('{"suggestedKind":"rm -rf","plainLine":"x"}', model)).toThrow();
    expect(parseFrameAgeCheck('{"peopleShown": false, "apparentAdult": null}')).toBe("no_people");
    expect(parseFrameAgeCheck('{"peopleShown": true, "apparentAdult": true}')).toBe("adult");
    expect(parseFrameAgeCheck('{"peopleShown": true, "apparentAdult": false}')).toBe("under18");
    expect(parseFrameAgeCheck('{"peopleShown": true, "apparentAdult": null}')).toBe("unclear");
    expect(parseFrameAgeCheck("I cannot help")).toBeNull();
  });

  it("shows every gap, upserts by shot pair, snaps AI lengths to the model and keeps another company out", async () => {
    const film = await seedFilm();
    const svc = videoStorylineTransitionsService(db);
    const strip = await svc.strip(film.companyId, film.storylineId);
    expect(strip.clips.map((c) => c.shotId)).toEqual([film.a, film.b]);
    expect(strip.gaps).toHaveLength(1);
    expect(strip.gaps[0]).toMatchObject({ id: null, kind: "cut", state: "default" });
    expect(strip.models.map((m) => m.model)).toEqual(["fal-ai/kling-video/v3/standard/image-to-video"]);
    expect(strip.monthly).toMatchObject({ capCents: 2_000, spentCents: 0 });
    expect(strip.writerProblem).toBeNull();
    expect(strip.readerProblem).toBe(NO_READER_MESSAGE);

    const ai = await svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, kind: "ai" }, ACTOR);
    // Kling 3.0's shortest clip is 3 s; no AI sound on Kling.
    expect(ai).toMatchObject({ kind: "ai", durationMs: 3_000, audioMode: "bed_only", state: "needs_making" });
    const longer = await svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, durationMs: 30_000 }, ACTOR);
    expect(longer.durationMs).toBe(15_000);
    const blend = await svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, kind: "blend" }, ACTOR);
    expect(blend).toMatchObject({ kind: "blend", durationMs: 500, state: "ready" });
    const rows = await db.select().from(videoTransitions).where(eq(videoTransitions.storylineId, film.storylineId));
    expect(rows).toHaveLength(1);

    // Not neighbours (reversed) -> refused.
    await expect(svc.upsert(film.companyId, film.storylineId, { fromShotId: film.b, toShotId: film.a, kind: "cut" }, ACTOR)).rejects.toMatchObject({ status: 409 });
    // Another company cannot see or change this storyline.
    const other = await seedCompany("Other Co");
    await videoStorylineSettingsService(db).setEnabled(other, true);
    await videoStorylineSettingsService(db).setAdvancedEnabled(other, true);
    await expect(svc.strip(other, film.storylineId)).rejects.toMatchObject({ status: 404 });
    await expect(svc.upsert(other, film.storylineId, { fromShotId: film.a, toShotId: film.b, kind: "cut" }, ACTOR)).rejects.toMatchObject({ status: 404 });
    await expect(svc.generate(other, film.storylineId, rows[0]!.id, {}, ACTOR)).rejects.toMatchObject({ status: 404 });

    // Locked: nothing but unlocking changes it.
    await svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, locked: true }, ACTOR);
    await expect(svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, kind: "cut" }, ACTOR)).rejects.toMatchObject({ status: 409 });
    const unlocked = await svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, locked: false }, ACTOR);
    expect(unlocked.locked).toBe(false);
  });

  it("writes a suggestion from the script only, in plain words, when the company has no picture-reading model", async () => {
    const film = await seedFilm({ vision: false });
    const model = fakeModel();
    const svc = videoStorylineTransitionsService(db, { modelOptions: { createModelClient: model.createModelClient } });
    const gap = await svc.suggest(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b }, ACTOR);
    expect(gap).toMatchObject({ suggestedKind: "ai", aiStyle: "follow_character", textOnlyReason: NO_READER_MESSAGE, suggestionOutdated: false });
    expect(gap.plainLine).toContain("follows Anna");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.hasImage).toBe(false);
  });

  it("age-checks frames before a cloud reader describes them, caches the reading, and falls back on a refusal", async () => {
    const film = await seedFilm({ vision: true });
    const model = fakeModel();
    const svc = videoStorylineTransitionsService(db, { modelOptions: { createModelClient: model.createModelClient } });
    const gap = await svc.suggest(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b }, ACTOR);
    expect(gap.textOnlyReason).toBeNull();
    // Per side: age check, then description (4 picture calls), then the writer.
    expect(model.calls.map((c) => c.system.split(" ").slice(0, 2).join(" "))).toEqual(["You check", "You describe", "You check", "You describe", "You plan"]);
    expect(model.calls.slice(0, 4).every((c) => c.hasImage)).toBe(true);
    const [shotA] = await db.select().from(videoShots).where(eq(videoShots.id, film.a));
    expect((shotA!.frameNotes as Record<string, { text: string; verdict: string }>).end).toMatchObject({ verdict: "adult" });
    const [row] = await db.select().from(videoTransitions).where(eq(videoTransitions.storylineId, film.storylineId));
    expect(JSON.stringify(row!.context)).toContain("red coat");

    // Asking again reads nothing again (cached by clip hash): only the writer is called.
    model.calls.length = 0;
    await svc.suggest(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, plainLine: "Slower, no camera spin." }, ACTOR);
    expect(model.calls).toHaveLength(1);

    // A refused age check never gets its frames described.
    const refusedFilm = await seedFilm({ vision: true });
    const strict = fakeModel({ ageAnswer: '{"peopleShown": true, "apparentAdult": null}' });
    const refused = await videoStorylineTransitionsService(db, { modelOptions: { createModelClient: strict.createModelClient } }).suggest(
      refusedFilm.companyId,
      refusedFilm.storylineId,
      { fromShotId: refusedFilm.a, toShotId: refusedFilm.b },
      ACTOR,
    );
    expect(refused.textOnlyReason).toBe(AGE_REFUSED_MESSAGE);
    expect(strict.calls.filter((c) => c.system.startsWith("You describe a strip"))).toHaveLength(0);
  });

  it("generates an AI bridge on the company's own key: cost reserved first, real frames as start and end, sound off", async () => {
    const film = await seedFilm();
    const svc = videoStorylineTransitionsService(db);
    const gap = await svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, kind: "ai", prompt: "Continuous shot, no cut. Anna walks out." }, ACTOR);
    const quoteCents = Math.ceil(3 * 8.4);
    await expect(svc.generate(film.companyId, film.storylineId, gap.id!, { confirmCostCents: quoteCents - 1 }, ACTOR)).rejects.toMatchObject({ status: 409 });
    const started = await svc.generate(film.companyId, film.storylineId, gap.id!, { confirmCostCents: quoteCents }, ACTOR);
    expect(started.state).toBe("generating");
    expect(video.keys).toEqual([`own-fal-${film.companyId.slice(0, 4)}`]);
    expect(video.starts[0]).toMatchObject({
      model: "fal-ai/kling-video/v3/standard/image-to-video",
      startImage: "data:image/jpeg;base64,TEFTVA==",
      endImage: "data:image/jpeg;base64,RklSU1Q=",
      durationSeconds: 3,
      generateAudio: false,
      promptRewrite: false,
    });
    expect(String(video.starts[0]!.prompt)).toContain("Anna walks out");
    const [reserved] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, film.storylineId));
    expect(reserved!.spentCents).toBe(quoteCents);
    await expect(svc.generate(film.companyId, film.storylineId, gap.id!, {}, ACTOR)).rejects.toMatchObject({ status: 409 });

    await svc.tick();
    const strip = await svc.strip(film.companyId, film.storylineId);
    expect(strip.gaps[0]).toMatchObject({ state: "ready" });
    expect(strip.gaps[0]!.chosenTakeId).toBe(strip.gaps[0]!.takes[0]!.id);
    expect(strip.monthly.spentCents).toBe(quoteCents);
    expect(strip.canCombineAgain).toBe(true);

    // The film plan inserts the take between the shots, edge frames dropped, sound stripped.
    const [storyline] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, film.storylineId));
    const shots = await db.select().from(videoShots).where(eq(videoShots.storylineId, film.storylineId)).orderBy(videoShots.orderIndex);
    const plan = await buildStitchPlan(db, storyline!, shots);
    expect(plan.problems).toEqual([]);
    expect(plan.items.map((i) => (i.takeId ? "bridge" : "shot"))).toEqual(["shot", "bridge", "shot"]);
    expect(plan.items[1]!.normalize).toEqual({ trimEdgeFrames: true, audio: "strip" });
  });

  it("goes out of date when a neighbouring shot changes, even locked; combining is refused until it is redone or switched to a blend", async () => {
    const film = await seedFilm();
    const svc = videoStorylineTransitionsService(db);
    const gap = await svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, kind: "ai" }, ACTOR);
    await svc.generate(film.companyId, film.storylineId, gap.id!, {}, ACTOR);
    await svc.tick();
    await svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, locked: true }, ACTOR);

    // Shot B is re-rendered: its clip changes.
    await db.update(videoShots).set({ resultSha256: "clip-sha-new" }).where(eq(videoShots.id, film.b));
    const strip = await svc.strip(film.companyId, film.storylineId);
    expect(strip.gaps[0]).toMatchObject({ state: "out_of_date", locked: true });
    expect(strip.combineProblems[0]).toContain("out of date");
    expect(strip.canCombineAgain).toBe(false);
    await expect(videoStorylineStitchService(db).retryStitch(film.companyId, film.storylineId)).rejects.toMatchObject({ status: 422 });

    await svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, locked: false, kind: "blend" }, ACTOR);
    const after = await svc.strip(film.companyId, film.storylineId);
    expect(after.combineProblems).toEqual([]);
    // "Combine again" works on a finished film.
    await videoStorylineStitchService(db).retryStitch(film.companyId, film.storylineId);
    const [row] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, film.storylineId));
    expect(row!.status).toBe("ready_to_stitch");
  });

  it("refuses over the storyline budget or the company's monthly cap before anything is sent; a failed take gives its money back", async () => {
    const film = await seedFilm({ budgetCapCents: 10 });
    const svc = videoStorylineTransitionsService(db);
    const gap = await svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, kind: "ai" }, ACTOR);
    await expect(svc.generate(film.companyId, film.storylineId, gap.id!, {}, ACTOR)).rejects.toThrow(/budget/);
    expect(video.starts).toHaveLength(0);

    await db.update(videoStorylines).set({ budgetCapCents: 10_000 }).where(eq(videoStorylines.id, film.storylineId));
    await videoStorylineSettingsService(db).setMediaMonthlyCapCents(film.companyId, 5);
    await expect(svc.generate(film.companyId, film.storylineId, gap.id!, {}, ACTOR)).rejects.toThrow(/monthly limit/);
    expect(video.starts).toHaveLength(0);

    await videoStorylineSettingsService(db).setMediaMonthlyCapCents(film.companyId, 2_000);
    video.outcome = { status: "failed", error: "Kling refused the frames." };
    await svc.generate(film.companyId, film.storylineId, gap.id!, {}, ACTOR);
    await svc.tick();
    const [storyline] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, film.storylineId));
    expect(storyline!.spentCents).toBe(0);
    const [take] = await db.select().from(videoTransitionTakes).where(eq(videoTransitionTakes.transitionId, gap.id!));
    expect(take).toMatchObject({ status: "failed", reservedCents: 0, error: "Kling refused the frames." });
    expect((await svc.strip(film.companyId, film.storylineId)).monthly.spentCents).toBe(0);
  });

  it("never uses the instance key for transitions, and the render fallback can never reach another company's key", async () => {
    const film = await seedFilm({ ownKey: false });
    const svc = videoStorylineTransitionsService(db);
    const gap = await svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, kind: "ai" }, ACTOR);
    await expect(svc.generate(film.companyId, film.storylineId, gap.id!, {}, ACTOR)).rejects.toThrow(/own Fal\.ai key/);
    expect(video.starts).toHaveLength(0);
    const [storyline] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, film.storylineId));
    expect(storyline!.spentCents).toBe(0);

    // The instance key is a secret of the owner's company: no other company can ever resolve it.
    await expect(secretService(db).resolveSecretValueForVideoRender(film.companyId, instanceSecretId, { actorId: "x" })).rejects.toMatchObject({ status: 422 });
    expect(await secretService(db).resolveSecretValueForVideoRender(ownerCompanyId, instanceSecretId, { actorId: "x" })).toBe("instance-fal-key");
    const { videoStorylineRenderService } = await import("../services/video-storyline-render.ts");
    await expect(videoStorylineRenderService(db).resolveProviderApiKey(film.companyId, "fal", "x")).rejects.toMatchObject({ status: 422 });
  });

  it("the anchor hash changes with either neighbour and with a reorder", () => {
    const storyline = { pictureSettings: {}, characterReferenceAssetIds: [] };
    const shot = (id: string, clip: string) => ({ id, resultSha256: clip, resultObjectKey: "k", stillSha256: null, stillObjectKey: null, prompt: "p", cameraNotes: null, lookReferenceAssetIds: [] });
    const base = transitionAnchorHash(storyline, shot("a", "1"), shot("b", "2"));
    expect(transitionAnchorHash(storyline, shot("a", "1"), shot("b", "2"))).toBe(base);
    expect(transitionAnchorHash(storyline, shot("a", "9"), shot("b", "2"))).not.toBe(base);
    expect(transitionAnchorHash(storyline, shot("a", "1"), shot("c", "2"))).not.toBe(base);
    expect(transitionAnchorHash(storyline, shot("b", "2"), shot("a", "1"))).not.toBe(base);
  });
  it("only an owner or admin may change the spend controls: a plain member gets 403 on all three (DUR-4711)", async () => {
    const film = await seedFilm();
    const member = { type: "board", source: "session", userId: "member-1", isInstanceAdmin: false, companyIds: [film.companyId], memberships: [{ companyId: film.companyId, status: "active", membershipRole: "member" }] };
    const owner = { ...member, userId: "owner-1", memberships: [{ companyId: film.companyId, status: "active", membershipRole: "owner" }] };
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
    const base = `/api/companies/${film.companyId}/video-storylines/settings`;
    const calls: Array<[string, Record<string, unknown>]> = [
      ["media-cap", { capCents: 10_000_000 }],
      ["approval-threshold", { thresholdCents: null }],
      ["advanced", { enabled: false }],
    ];
    for (const [path, body] of calls) {
      const res = await request(appFor(member)).patch(`${base}/${path}`).send(body);
      expect(res.status, path).toBe(403);
      expect(res.body.error).toContain("owner or an admin");
    }
    expect(await videoStorylineSettingsService(db).getMediaMonthlyCapCents(film.companyId)).toBe(2_000);
    expect(await videoStorylineSettingsService(db).isAdvancedEnabled(film.companyId)).toBe(true);
    const ok = await request(appFor(owner)).patch(`${base}/media-cap`).send({ capCents: 3_000 });
    expect(ok.status).toBe(200);
    expect(ok.body.capCents).toBe(3_000);
  });

  it("two simultaneous generates make one take, and the monthly cap can't be overshot across two storylines (DUR-4711)", async () => {
    const film = await seedFilm();
    const svc = videoStorylineTransitionsService(db);
    const gap = await svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, kind: "ai" }, ACTOR);
    const both = await Promise.allSettled([svc.generate(film.companyId, film.storylineId, gap.id!, {}, ACTOR), svc.generate(film.companyId, film.storylineId, gap.id!, {}, ACTOR)]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(videoTransitionTakes).where(eq(videoTransitionTakes.transitionId, gap.id!))).toHaveLength(1);

    // A second film in another company-wide race: cap = exactly one take (26 cents).
    const one = await seedFilm();
    const svc2 = videoStorylineTransitionsService(db);
    const second = await videoStorylineService(db).createStoryline(
      one.companyId,
      { title: "Second", projectId: null, providerId: "fal", model: null, budgetCapCents: 1_000, characterReferenceAssetIds: [], defaultTransition: "cut", defaultTransitionDurationMs: 500, musicAssetId: null, musicSourceKey: null, musicVolumeDb: -18 },
      ACTOR,
    );
    const scene = await videoStorylineService(db).createScene(one.companyId, second.id, { title: "S", notes: null, orderIndex: 0 }, ACTOR);
    const ids: string[] = [];
    for (const i of [0, 1]) {
      const shot = await videoStorylineService(db).createShot(one.companyId, second.id, { sceneId: scene.id, orderIndex: i, prompt: `P${i}`, cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null }, ACTOR);
      const key = `${one.companyId}/clips2/${shot.id}.mp4`;
      storedObjects.set(key, { body: Buffer.from(`c${i}`), contentType: "video/mp4" });
      await db.update(videoShots).set({ status: "done", storyboardStatus: "approved", resultProvider: "local_disk", resultObjectKey: key, resultContentType: "video/mp4", resultSha256: `s2-${i}` }).where(eq(videoShots.id, shot.id));
      ids.push(shot.id);
    }
    await videoStorylineSettingsService(db).setMediaMonthlyCapCents(one.companyId, Math.ceil(3 * 8.4));
    const g1 = await svc2.upsert(one.companyId, one.storylineId, { fromShotId: one.a, toShotId: one.b, kind: "ai" }, ACTOR);
    const g2 = await svc2.upsert(one.companyId, second.id, { fromShotId: ids[0]!, toShotId: ids[1]!, kind: "ai" }, ACTOR);
    const race = await Promise.allSettled([
      svc2.generate(one.companyId, one.storylineId, g1.id!, {}, ACTOR),
      svc2.generate(one.companyId, second.id, g2.id!, {}, ACTOR),
    ]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = race.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason?.message)).toContain("monthly limit");
    expect(await svc2.monthlySpentCents(one.companyId)).toBe(Math.ceil(3 * 8.4));
  });

  it("a take that timed out with a provider job keeps its cost counted; the writer's prompts are masked (DUR-4711)", async () => {
    const film = await seedFilm();
    let now = new Date();
    const svc = videoStorylineTransitionsService(db, { now: () => now });
    const gap = await svc.upsert(film.companyId, film.storylineId, { fromShotId: film.a, toShotId: film.b, kind: "ai" }, ACTOR);
    await svc.generate(film.companyId, film.storylineId, gap.id!, {}, ACTOR);
    video.outcome = { status: "running" };
    now = new Date(now.getTime() + 31 * 60_000);
    await svc.tick();
    const [take] = await db.select().from(videoTransitionTakes).where(eq(videoTransitionTakes.transitionId, gap.id!));
    expect(take).toMatchObject({ status: "failed", costCents: 26, reservedCents: 26 });
    expect(take!.error).toContain("may still charge");
    const [storyline] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, film.storylineId));
    expect(storyline!.spentCents).toBe(26);
    expect(await svc.monthlySpentCents(film.companyId)).toBe(26);

    const model = fakeModel();
    await storylineCompanyModel(db, { createModelClient: model.createModelClient }).write(film.companyId, ACTOR, {
      system: "Rules. Never echo sk-ant-api03-SYSTEMSECRET123456.",
      user: "Shot text: the key is sk-proj-USERSECRET987654321 ok",
      maxTokens: 50,
    });
    const sent = model.create.mock.calls[0]![0] as { system: string; messages: Array<{ content: unknown }> };
    expect(sent.system).not.toContain("SYSTEMSECRET");
    expect(JSON.stringify(sent.messages)).not.toContain("USERSECRET");
    expect(JSON.stringify(sent.messages)).toContain("[hidden]");
  });
});
