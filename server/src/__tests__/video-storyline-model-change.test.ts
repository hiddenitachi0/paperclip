import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { approvals, companies, createDb, plugins, videoShotRenderJobs, videoShots, videoStorylines } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * DUR-4896: a model change in Render reaches every shot.
 *  - A render never pins its model on the shot; the model that really ran is
 *    on the render job, so changing the film's model reaches the next render.
 *  - A made clip keeps the length/trims/transition timing of the model that
 *    made it (its latest done job), whatever the film uses now.
 *  - Billing reads the job, not the storyline.
 *  - The estimate and the render share one target function.
 * Every provider is stubbed; nothing reaches Fal or Sogni.
 */

const storedObjects = vi.hoisted(() => new Map<string, { body: Buffer; contentType: string }>());
const falCostCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
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
    deleteObject: async (_companyId: string, objectKey: string) => {
      storedObjects.delete(objectKey);
    },
  }),
}));
vi.mock("../services/video-ffmpeg.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/video-ffmpeg.ts")>()),
  checkFfmpegAvailable: async () => true,
  extractLastFrameDataUri: async () => null,
  extractFirstFrameDataUri: async () => null,
}));
vi.mock("../services/fal-cost-events.ts", () => ({
  recordFalCostEvent: async (_db: unknown, _fetch: unknown, input: Record<string, unknown>) => {
    falCostCalls.push(input);
    return null;
  },
}));

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping storyline model-change tests: ${support.reason ?? "unsupported environment"}`);

const { videoStorylineRenderService } = await import("../services/video-storyline-render.ts");
const { resolveShotRenderTarget, resolveMadeClipTarget, estimateShotRenderCents } = await import("../services/video-storyline-shot-target.ts");
const { videoStorylineSettingsService } = await import("../services/video-storyline-settings.ts");
const { videoStorylineService } = await import("../services/video-storylines.ts");
const { videoStorylineClipsService } = await import("../services/video-storyline-clips.ts");
const { videoStorylineTransitionsService, buildStitchPlan } = await import("../services/video-storyline-transitions.ts");
type Provider = import("../services/video-provider-clients.ts").MediaJobProvider;

const ACTOR = { actorType: "user" as const, actorId: "filip", agentId: null };
const KLING_16 = "fal-ai/kling-video/v1.6/standard/image-to-video";

describe("resolving a shot's video target (pure)", () => {
  const film = { providerId: "sogni", model: "ltx25" };
  it("follows the film unless a person pinned the shot", () => {
    expect(resolveShotRenderTarget(film, { providerId: null, model: null })).toEqual({ providerId: "sogni", model: "ltx25" });
    expect(resolveShotRenderTarget(film, { providerId: "fal", model: KLING_16 })).toEqual({ providerId: "fal", model: KLING_16 });
  });
  it("never borrows the film's model for a shot pinned to another service", () => {
    expect(resolveShotRenderTarget(film, { providerId: "fal", model: null })).toEqual({ providerId: "fal", model: null });
    expect(resolveShotRenderTarget(film, { providerId: "sogni", model: null })).toEqual({ providerId: "sogni", model: "ltx25" });
  });
  it("treats the old made-up 'sogni-video' name as no model", () => {
    expect(resolveShotRenderTarget(film, { providerId: "sogni", model: "sogni-video" })).toEqual({ providerId: "sogni", model: "ltx25" });
    expect(resolveShotRenderTarget({ providerId: "sogni", model: null }, { providerId: null, model: null }).model).toBeNull();
  });
  it("reads a made clip from its job, a clip not made as a new render would", () => {
    const made = { provider: "fal", model: KLING_16 };
    expect(resolveMadeClipTarget(film, { status: "done", providerId: null, model: null }, made)).toEqual({ providerId: "fal", model: KLING_16 });
    expect(resolveMadeClipTarget(film, { status: "failed", providerId: null, model: null }, made)).toEqual({ providerId: "sogni", model: "ltx25" });
    expect(resolveMadeClipTarget(film, { status: "done", providerId: "fal", model: KLING_16 }, null)).toEqual({ providerId: "fal", model: KLING_16 });
  });
  it("prices a done shot at its job when asked, a new render at the target", () => {
    const shot = { providerId: null, model: null, durationSeconds: 7, status: "done" };
    const made = { provider: "fal", model: KLING_16 };
    // Kling snaps 7 s to 10 s at 50 cents a second; Sogni is 40 cents a second for the written 7 s.
    expect(estimateShotRenderCents(film, [{ ...shot, madeWith: made }]).estimatedTotalCents).toBe(500);
    expect(estimateShotRenderCents(film, [shot]).estimatedTotalCents).toBe(280);
  });
});

d("storyline model change", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-model-change");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    const manifest = { id: "paperclip.media-studio", apiVersion: 1, version: "1.0.0", displayName: "Media Studio", description: "x", author: "x", categories: ["automation"], capabilities: [], entrypoints: { worker: "dist/worker.js" } } as unknown as PaperclipPluginManifestV1;
    await db.insert(plugins).values({ pluginKey: "paperclip.media-studio", packageName: "@paperclipai/plugin-media-studio", version: "1.0.0", manifestJson: manifest, status: "ready" });
  }, 120_000);

  afterAll(async () => {
    await stopDb?.();
  });

  beforeEach(() => {
    falCostCalls.length = 0;
  });

  async function seed(opts: { providerId: "fal" | "sogni"; model: string | null; shots?: number; durationSeconds?: number }) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Film Co", issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const svc = videoStorylineService(db);
    const storyline = await svc.createStoryline(
      companyId,
      { title: "Test", projectId: null, providerId: opts.providerId, model: opts.model, budgetCapCents: 100_000, characterReferenceAssetIds: [], defaultTransition: "cut", defaultTransitionDurationMs: 500, musicAssetId: null, musicSourceKey: null, musicVolumeDb: -18 },
      ACTOR,
    );
    const scene = await svc.createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
    const shotIds: string[] = [];
    for (let i = 0; i < (opts.shots ?? 1); i += 1) {
      const shot = await svc.createShot(companyId, storyline.id, { sceneId: scene.id, orderIndex: i, prompt: `Shot ${i + 1}`, cameraNotes: null, durationSeconds: opts.durationSeconds ?? 5, lookReferenceAssetIds: [], transitionIn: null }, ACTOR);
      await db.update(videoShots).set({ storyboardStatus: "approved" }).where(eq(videoShots.id, shot.id));
      shotIds.push(shot.id);
    }
    return { companyId, storylineId: storyline.id, shotIds, svc };
  }

  /** A shot that was made by `provider`/`model` long ago: done, clip stored, one done render job. */
  async function markMadeBy(companyId: string, storylineId: string, shotId: string, provider: "fal" | "sogni", model: string) {
    const key = `${companyId}/clips/${shotId}.mp4`;
    storedObjects.set(key, { body: Buffer.from("clip"), contentType: "video/mp4" });
    await db.update(videoShots).set({ status: "done", attempt: 1, resultProvider: "local_disk", resultObjectKey: key, resultContentType: "video/mp4", resultSha256: `sha-${shotId}`, actualCostCents: 500 }).where(eq(videoShots.id, shotId));
    await db.insert(videoShotRenderJobs).values({ companyId, storylineId, shotId, attempt: 1, provider, model, externalId: `wf-${shotId}`, status: "done", completedAt: new Date() });
  }

  const shotRow = async (id: string) => (await db.select().from(videoShots).where(eq(videoShots.id, id)))[0]!;
  const storylineRow = async (id: string) => (await db.select().from(videoStorylines).where(eq(videoStorylines.id, id)))[0]!;
  const jobsOf = (shotId: string) => db.select().from(videoShotRenderJobs).where(eq(videoShotRenderJobs.shotId, shotId));

  /** A stand-in service that records what it was built and asked with. */
  function recordingService(answer: { model: string; provider: "fal" | "sogni"; done?: boolean; meta?: Record<string, unknown> }) {
    const built: Array<{ providerId: string; model: string | null }> = [];
    const started: Array<{ model?: string; durationSeconds?: number }> = [];
    const buildProvider = (providerId: string, _apiKey: string, model: string | null): Provider => {
      built.push({ providerId, model });
      return {
        name: providerId,
        start: async (input: { model?: string; durationSeconds?: number }) => {
          started.push({ model: input.model, durationSeconds: input.durationSeconds });
          return { externalId: `wf-${started.length}`, model: answer.model, provider: answer.provider };
        },
        poll: async () =>
          answer.done === false
            ? { status: "running" as const }
            : { status: "done" as const, result: { contentType: "video/mp4", dataUrl: `data:video/mp4;base64,${Buffer.from("made").toString("base64")}`, ...(answer.meta ? { meta: answer.meta } : {}) } },
        cancel: async () => undefined,
      } as unknown as Provider;
    };
    return { built, started, buildProvider };
  }

  it("(a) a done Kling 1.6 shot keeps its 10 s length, trims and transition timing when the film moves to Sogni", async () => {
    const { companyId, storylineId, shotIds, svc } = await seed({ providerId: "fal", model: KLING_16, shots: 2, durationSeconds: 7 });
    for (const id of shotIds) await markMadeBy(companyId, storylineId, id, "fal", KLING_16);
    await svc.updateStoryline(companyId, storylineId, { providerId: "sogni", model: "ltx25" }, ACTOR);

    const transitions = videoStorylineTransitionsService(db);
    const before = await transitions.strip(companyId, storylineId);
    for (const clip of before.clips) {
      expect(clip.sourceLengthMs).toBe(10_000);
      expect(clip.providerId).toBe("fal");
      expect(clip.model).toBe(KLING_16);
      expect(clip.pinned).toBe(false);
    }

    // Trims reach the full 10 s the clip really has, not Sogni's written 7 s.
    const clips = videoStorylineClipsService(db);
    await clips.updateClip(companyId, storylineId, shotIds[0]!, { trimInMs: 1_000, trimOutMs: 9_500 }, ACTOR);
    const strip = await transitions.strip(companyId, storylineId);
    const first = strip.clips.find((c) => c.shotId === shotIds[0])!;
    expect([first.playMs, first.sourceLengthMs]).toEqual([8_500, 10_000]);
    expect(strip.clips.find((c) => c.shotId === shotIds[1])!.playMs).toBe(10_000);

    const shots = await db.select().from(videoShots).where(eq(videoShots.storylineId, storylineId)).orderBy(videoShots.orderIndex);
    const plan = await buildStitchPlan(db, await storylineRow(storylineId), shots);
    expect(plan.items[0]!.normalize?.trimMs).toEqual({ startMs: 1_000, endMs: 9_500 });
    expect(plan.items[0]!.writtenSeconds).toBe(8.5);
    expect(plan.items[1]!.normalize?.trimMs).toBeUndefined();

    // The cached estimate prices the finished shots at what made them (Kling: 10 s x 50 cents).
    expect((await storylineRow(storylineId)).estimatedTotalCents).toBe(1000);
    // A new render of the same shot would use the film's model.
    expect(first.willUse).toEqual({ providerId: "sogni", model: "ltx25" });
  });

  it("splitting a made clip keeps the second part on the model that made it", async () => {
    const { companyId, storylineId, shotIds, svc } = await seed({ providerId: "fal", model: KLING_16, durationSeconds: 7 });
    await markMadeBy(companyId, storylineId, shotIds[0]!, "fal", KLING_16);
    await svc.updateStoryline(companyId, storylineId, { providerId: "sogni", model: "ltx25" }, ACTOR);
    const { shotId: second } = await videoStorylineClipsService(db).splitClip(companyId, storylineId, shotIds[0]!, { atMs: 4_000 }, ACTOR);
    // The model is not pinned on the shot; it follows the copied done job.
    expect([(await shotRow(second)).providerId, (await shotRow(second)).model]).toEqual([null, null]);
    expect((await jobsOf(second)).map((j) => [j.provider, j.model, j.status])).toEqual([["fal", KLING_16, "done"]]);
    const strip = await videoStorylineTransitionsService(db).strip(companyId, storylineId);
    expect(strip.clips.find((c) => c.shotId === second)!.sourceLengthMs).toBe(10_000);
  });

  it("(b) render with A, change the film to B, re-render: B is sent", async () => {
    const { companyId, storylineId, shotIds, svc } = await seed({ providerId: "sogni", model: "ltx23" });
    const first = recordingService({ model: "ltx23", provider: "sogni" });
    const render = videoStorylineRenderService(db, { buildProvider: first.buildProvider as never, resolveApiKey: async () => "key" });
    await render.startRender(companyId, storylineId, ACTOR, {});
    expect(first.built.at(-1)).toEqual({ providerId: "sogni", model: "ltx23" });
    // The shot does not remember the model it was made with; the job does.
    expect([(await shotRow(shotIds[0]!)).providerId, (await shotRow(shotIds[0]!)).model]).toEqual([null, null]);
    expect((await jobsOf(shotIds[0]!)).map((j) => [j.provider, j.model])).toEqual([["sogni", "ltx23"]]);
    await render.tick();
    expect((await shotRow(shotIds[0]!)).status).toBe("done");

    await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, storylineId));
    await svc.updateStoryline(companyId, storylineId, { model: "wan22" }, ACTOR);
    const second = recordingService({ model: "wan22", provider: "sogni" });
    const render2 = videoStorylineRenderService(db, { buildProvider: second.buildProvider as never, resolveApiKey: async () => "key" });
    await render2.reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR);
    expect(second.built.at(-1)).toEqual({ providerId: "sogni", model: "wan22" });
    expect(second.started.at(-1)?.model).toBe("wan22");
    expect((await jobsOf(shotIds[0]!)).map((j) => j.model).sort()).toEqual(["ltx23", "wan22"]);
  });

  it("(b) a shot a person pinned keeps its own model through a film change and a re-render; the reset puts it back", async () => {
    const { companyId, storylineId, shotIds, svc } = await seed({ providerId: "sogni", model: "ltx23", shots: 2 });
    await svc.updateShot(companyId, storylineId, shotIds[0]!, { providerId: "fal", model: KLING_16 }, ACTOR);
    expect(await svc.listShots(companyId, storylineId).then((r) => r.map((s) => [s.providerId, s.model]))).toEqual([["fal", KLING_16], [null, null]]);
    // The estimate prices the pin: Fal 5 s (Kling 5 s) + Sogni 5 s.
    expect((await storylineRow(storylineId)).estimatedTotalCents).toBe(250 + 200);

    await svc.updateStoryline(companyId, storylineId, { model: "wan22" }, ACTOR);
    const rec = recordingService({ model: KLING_16, provider: "fal" });
    const render = videoStorylineRenderService(db, { buildProvider: rec.buildProvider as never, resolveApiKey: async () => "key" });
    await render.startRender(companyId, storylineId, ACTOR, {});
    expect(rec.built.at(-1)).toEqual({ providerId: "fal", model: KLING_16 });

    await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, storylineId));
    expect(await svc.clearShotModelPins(companyId, storylineId, ACTOR)).toEqual({ cleared: 1 });
    expect(await svc.listShots(companyId, storylineId).then((r) => r.map((s) => [s.providerId, s.model]))).toEqual([[null, null], [null, null]]);
    // Pinning a model needs a service.
    const { updateVideoShotSchema } = await import("@paperclipai/shared");
    expect(updateVideoShotSchema.safeParse({ model: "ltx25" }).success).toBe(false);
    expect(updateVideoShotSchema.safeParse({ providerId: "sogni", model: "ltx25" }).success).toBe(true);
    expect(updateVideoShotSchema.safeParse({ providerId: null }).success).toBe(true);
  });

  it("(c) pause, change the provider, let the in-flight job finish: the cost is recorded under the job's provider", async () => {
    const { companyId, storylineId, shotIds, svc } = await seed({ providerId: "fal", model: KLING_16 });
    const rec = recordingService({ model: KLING_16, provider: "fal" });
    const render = videoStorylineRenderService(db, { buildProvider: rec.buildProvider as never, resolveApiKey: async () => "fal-key" });
    await render.startRender(companyId, storylineId, ACTOR, {});
    expect(rec.started).toHaveLength(1);

    // Paused storylines can still be edited: the film moves to Sogni while the Fal job runs.
    await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, storylineId));
    await svc.updateStoryline(companyId, storylineId, { providerId: "sogni", model: "ltx25" }, ACTOR);
    await render.tick();

    // (tick advances every running job in the shared test database; look at this company's only)
    const mine = falCostCalls.filter((c) => c.companyId === companyId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ companyId, apiKey: "fal-key", model: KLING_16, billingCode: "video-storyline-shot", usage: { seconds: 5 } });
    const done = await shotRow(shotIds[0]!);
    expect(done.status).toBe("done");
    // Priced as the Fal job it was (5 s x 50 cents), not as the film's new Sogni (5 s x 40).
    expect(done.actualCostCents).toBe(250);
  });

  it("(c) the same the other way: a Sogni job is not billed to Fal when the film moves to Fal", async () => {
    const { companyId, storylineId, shotIds, svc } = await seed({ providerId: "sogni", model: null });
    const rec = recordingService({ model: "ltx25", provider: "sogni" });
    const render = videoStorylineRenderService(db, { buildProvider: rec.buildProvider as never, resolveApiKey: async () => "key" });
    await render.startRender(companyId, storylineId, ACTOR, {});
    await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, storylineId));
    await svc.updateStoryline(companyId, storylineId, { providerId: "fal", model: KLING_16 }, ACTOR);
    await render.tick();
    expect(falCostCalls.filter((c) => c.companyId === companyId)).toHaveLength(0);
    expect((await shotRow(shotIds[0]!)).actualCostCents).toBe(200);
  });

  it("(d) no render ever stores 'sogni-video'; an old pin by that name is cleared by a re-render", async () => {
    const { companyId, storylineId, shotIds, svc } = await seed({ providerId: "sogni", model: "ltx25" });
    // An older render pinned the made-up name; the job also carries it.
    await markMadeBy(companyId, storylineId, shotIds[0]!, "sogni", "sogni-video");
    await db.update(videoShots).set({ providerId: "sogni", model: "sogni-video" }).where(eq(videoShots.id, shotIds[0]!));
    await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, storylineId));
    await svc.updateStoryline(companyId, storylineId, { model: "wan22" }, ACTOR);

    const rec = recordingService({ model: "wan22", provider: "sogni" });
    const render = videoStorylineRenderService(db, { buildProvider: rec.buildProvider as never, resolveApiKey: async () => "key" });
    await render.reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR);
    expect(rec.built.at(-1)).toEqual({ providerId: "sogni", model: "wan22" });
    const row = await shotRow(shotIds[0]!);
    expect([row.providerId, row.model]).toEqual([null, null]);
    // The pin API drops the placeholder too.
    await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, storylineId));
    const pinned = await svc.updateShot(companyId, storylineId, shotIds[0]!, { providerId: "sogni", model: "sogni-video" }, ACTOR);
    expect([pinned.providerId, pinned.model]).toEqual(["sogni", null]);
  });

  it("a re-render of a shot with an old 'sogni-video' pin is priced on the film's service, so the cap holds", async () => {
    // Film on Fal Kling (7 s shot bills the 10 s minimum: 500 cents); the old automatic pin says Sogni (7 s x 40 = 280).
    const { companyId, storylineId, shotIds } = await seed({ providerId: "fal", model: KLING_16, durationSeconds: 7 });
    await markMadeBy(companyId, storylineId, shotIds[0]!, "sogni", "sogni-video");
    await db.update(videoShots).set({ providerId: "sogni", model: "sogni-video" }).where(eq(videoShots.id, shotIds[0]!));
    // 400 cents: the Sogni price would pass, the Fal price must not.
    await db.update(videoStorylines).set({ budgetCapCents: 400, spentCents: 500 }).where(eq(videoStorylines.id, storylineId));
    const rec = recordingService({ model: KLING_16, provider: "fal" });
    const render = videoStorylineRenderService(db, { buildProvider: rec.buildProvider as never, resolveApiKey: async () => "fal-key" });
    await expect(render.reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR)).rejects.toThrow(/over the budget cap/);
    expect(rec.started).toHaveLength(0);
    const row = await shotRow(shotIds[0]!);
    expect(row.status).toBe("done");
    expect((await storylineRow(storylineId)).spentCents).toBe(500);
  });

  it("(e) the estimate and the render use the same target", async () => {
    const { companyId, storylineId, shotIds, svc } = await seed({ providerId: "sogni", model: "ltx25", shots: 2, durationSeconds: 7 });
    await svc.updateShot(companyId, storylineId, shotIds[1]!, { providerId: "fal", model: KLING_16 }, ACTOR);
    const storyline = await storylineRow(storylineId);
    const shots = await svc.listShots(companyId, storylineId);
    const targets = shots.map((s) => resolveShotRenderTarget(storyline, s));
    expect(targets).toEqual([{ providerId: "sogni", model: "ltx25" }, { providerId: "fal", model: KLING_16 }]);
    // The stored estimate is the sum of exactly those targets: Sogni 7 s x 40 + Fal Kling 10 s x 50.
    expect(storyline.estimatedTotalCents).toBe(280 + 500);
    expect(storyline.estimatedTotalCents).toBe(estimateShotRenderCents(storyline, shots).estimatedTotalCents);

    const rec = recordingService({ model: "ltx25", provider: "sogni" });
    const render = videoStorylineRenderService(db, { buildProvider: rec.buildProvider as never, resolveApiKey: async () => "key" });
    await render.startRender(companyId, storylineId, ACTOR, {});
    expect(rec.built[0]).toEqual(targets[0]);
    await render.tick();
    expect(rec.built.at(-1)).toEqual(targets[1]);
    expect(rec.started.at(-1)?.durationSeconds).toBe(10);
  });

  describe("spend cap on a single-shot re-render (DUR-4915)", () => {
    const shotStatuses = async (ids: string[]) => Promise.all(ids.map(async (id) => (await shotRow(id)).status));

    it("refuses to re-render a shot of a film with no budget cap, and starts nothing", async () => {
      const { companyId, storylineId, shotIds } = await seed({ providerId: "fal", model: KLING_16, shots: 3 });
      await db.update(videoStorylines).set({ budgetCapCents: null }).where(eq(videoStorylines.id, storylineId));
      const statusBefore = (await storylineRow(storylineId)).status;
      const rec = recordingService({ model: KLING_16, provider: "fal" });
      const render = videoStorylineRenderService(db, { buildProvider: rec.buildProvider as never, resolveApiKey: async () => "fal-key" });
      await expect(render.reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR)).rejects.toMatchObject({ status: 400 });
      expect(rec.started).toHaveLength(0);
      expect((await storylineRow(storylineId)).status).toBe(statusBefore);
      expect(await shotStatuses(shotIds)).toEqual(["draft", "draft", "draft"]);
    });

    it("re-rendering a shot of a film that was never started renders exactly that shot and leaves the film as it was", async () => {
      const { companyId, storylineId, shotIds } = await seed({ providerId: "fal", model: KLING_16, shots: 3 });
      const statusBefore = (await storylineRow(storylineId)).status;
      expect(["draft", "estimated"]).toContain(statusBefore);
      const rec = recordingService({ model: KLING_16, provider: "fal" });
      const render = videoStorylineRenderService(db, { buildProvider: rec.buildProvider as never, resolveApiKey: async () => "fal-key" });
      await render.reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR);
      expect((await storylineRow(storylineId)).status).toBe(statusBefore);
      await render.tick();
      await render.tick();
      expect(rec.started).toHaveLength(1);
      expect(await shotStatuses(shotIds)).toEqual(["done", "draft", "draft"]);
      const after = await storylineRow(storylineId);
      expect(after.status).toBe(statusBefore);
      expect(after.spentCents).toBe(250);
    });

    it("re-rendering a shot of a paused film does not resume the film either", async () => {
      const { companyId, storylineId, shotIds } = await seed({ providerId: "fal", model: KLING_16, shots: 2 });
      await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, storylineId));
      const rec = recordingService({ model: KLING_16, provider: "fal" });
      const render = videoStorylineRenderService(db, { buildProvider: rec.buildProvider as never, resolveApiKey: async () => "fal-key" });
      await render.reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR);
      await render.tick();
      await render.tick();
      expect(rec.started).toHaveLength(1);
      expect(await shotStatuses(shotIds)).toEqual(["done", "draft"]);
      expect((await storylineRow(storylineId)).status).toBe("paused");
    });

    it("a rendering film whose cap has gone does not start the next shot", async () => {
      const { companyId, storylineId, shotIds } = await seed({ providerId: "fal", model: KLING_16, shots: 3 });
      const rec = recordingService({ model: KLING_16, provider: "fal" });
      const render = videoStorylineRenderService(db, { buildProvider: rec.buildProvider as never, resolveApiKey: async () => "fal-key" });
      await render.startRender(companyId, storylineId, ACTOR, {});
      await db.update(videoStorylines).set({ budgetCapCents: null }).where(eq(videoStorylines.id, storylineId));
      await render.tick();
      expect(rec.started).toHaveLength(1);
      expect(await shotStatuses(shotIds)).toEqual(["done", "draft", "draft"]);
      const after = await storylineRow(storylineId);
      expect(after.status).toBe("paused");
      expect(after.errorMessage).toMatch(/No budget cap/);
    });
  });

  describe("approval threshold on a single-shot re-render (DUR-4915, security review)", () => {
    const shotStatuses = async (ids: string[]) => Promise.all(ids.map(async (id) => (await shotRow(id)).status));
    const cards = (companyId: string) => db.select().from(approvals).where(eq(approvals.companyId, companyId));

    function renderer() {
      const rec = recordingService({ model: KLING_16, provider: "fal" });
      return { rec, render: videoStorylineRenderService(db, { buildProvider: rec.buildProvider as never, resolveApiKey: async () => "fal-key" }) };
    }

    async function approvedCard(companyId: string, storylineId: string, estimatedTotalCents: number) {
      await db.insert(approvals).values({
        companyId,
        type: "request_board_approval",
        status: "approved",
        decidedAt: new Date(),
        payload: { kind: "video_render", storylineId, shotCount: 1, estimatedTotalCents, thresholdCents: 300, title: "Render", summary: "ok" },
      });
    }

    it("(a) an over-threshold re-render with no approval is refused, files a card, and starts nothing", async () => {
      const { companyId, storylineId, shotIds } = await seed({ providerId: "fal", model: KLING_16, shots: 2 });
      await videoStorylineSettingsService(db).setApprovalThresholdCents(companyId, 100);
      const { rec, render } = renderer();
      await expect(render.reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("approval threshold") });
      await expect(render.reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR)).rejects.toMatchObject({ status: 422 });
      expect(rec.started).toHaveLength(0);
      expect(await shotStatuses(shotIds)).toEqual(["draft", "draft"]);
      const filed = await cards(companyId);
      expect(filed).toHaveLength(1);
      expect(filed[0]).toMatchObject({ status: "pending", payload: expect.objectContaining({ kind: "video_render", storylineId, estimatedTotalCents: 250, thresholdCents: 100 }) });
      expect((await storylineRow(storylineId)).spentCents).toBe(0);
    });

    it("(b) with an approved card for that total, exactly one shot renders", async () => {
      const { companyId, storylineId, shotIds } = await seed({ providerId: "fal", model: KLING_16, shots: 2 });
      await videoStorylineSettingsService(db).setApprovalThresholdCents(companyId, 100);
      await approvedCard(companyId, storylineId, 250);
      const { rec, render } = renderer();
      await render.reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR);
      await render.tick();
      await render.tick();
      expect(rec.started).toHaveLength(1);
      expect(await shotStatuses(shotIds)).toEqual(["done", "draft"]);
    });

    it("an approved card for a different total does not clear the re-render", async () => {
      const { companyId, storylineId, shotIds } = await seed({ providerId: "fal", model: KLING_16, shots: 2 });
      await videoStorylineSettingsService(db).setApprovalThresholdCents(companyId, 100);
      await approvedCard(companyId, storylineId, 999);
      const { rec, render } = renderer();
      await expect(render.reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR)).rejects.toMatchObject({ status: 422 });
      expect(rec.started).toHaveLength(0);
    });

    it("(c) a re-render within the threshold still works and files no card", async () => {
      const { companyId, storylineId, shotIds } = await seed({ providerId: "fal", model: KLING_16, shots: 2 });
      await videoStorylineSettingsService(db).setApprovalThresholdCents(companyId, 300);
      const { rec, render } = renderer();
      await render.reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR);
      await render.tick();
      await render.tick();
      expect(rec.started).toHaveLength(1);
      expect(await shotStatuses(shotIds)).toEqual(["done", "draft"]);
      expect(await cards(companyId)).toHaveLength(0);
    });

    it("(d) re-rendering the shots of a 4-shot film one at a time stops before spend passes the threshold", async () => {
      const { companyId, storylineId, shotIds } = await seed({ providerId: "fal", model: KLING_16, shots: 4 });
      await videoStorylineSettingsService(db).setApprovalThresholdCents(companyId, 300);
      const { rec, render } = renderer();
      await render.reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR);
      await render.tick();
      await render.tick();
      expect((await storylineRow(storylineId)).spentCents).toBe(250);
      for (const id of shotIds.slice(1)) {
        await expect(render.reRenderShot(companyId, storylineId, id, ACTOR)).rejects.toMatchObject({ status: 422 });
      }
      await render.tick();
      expect(rec.started).toHaveLength(1);
      expect(await shotStatuses(shotIds)).toEqual(["done", "draft", "draft", "draft"]);
      const after = await storylineRow(storylineId);
      expect(after.spentCents).toBeLessThanOrEqual(300);
      expect(await cards(companyId)).toHaveLength(1);
    });

    it("a film that is already rendering (a run startRender cleared) is not gated again", async () => {
      const { companyId, storylineId, shotIds } = await seed({ providerId: "fal", model: KLING_16, shots: 2 });
      await videoStorylineSettingsService(db).setApprovalThresholdCents(companyId, 100);
      await approvedCard(companyId, storylineId, 500);
      const { render } = renderer();
      await render.startRender(companyId, storylineId, ACTOR, {});
      await render.tick();
      await db.update(videoShots).set({ status: "failed" }).where(eq(videoShots.id, shotIds[0]!));
      await db.update(videoStorylines).set({ status: "rendering" }).where(eq(videoStorylines.id, storylineId));
      await render.reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR);
      expect(await cards(companyId)).toHaveLength(1);
    });
  });
});
