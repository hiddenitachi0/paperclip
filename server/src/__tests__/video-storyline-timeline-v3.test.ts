import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, plugins, videoShotRenderJobs, videoShots, videoStorylines, videoTransitions } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * Storyline timeline v3 (17 Oct): the failed-render fix and the timeline
 * editor's server side.
 *  - A render whose first shot cannot start (the Sogni 204 crash, a missing
 *    key, a refused upload) puts the storyline back where it was with a
 *    plain reason, and the shot shows its own reason -- never "rendering"
 *    with nothing running.
 *  - The tick releases storylines left "rendering" with nothing running.
 *  - Delete really deletes (also a finished film), and the list no longer
 *    shows it; it refuses only while something is being made.
 *  - Trim a made AI clip, split any clip, and free editing without Advanced.
 * Every provider is stubbed; nothing reaches Fal or Sogni.
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
vi.mock("../services/fal-cost-events.ts", () => ({ recordFalCostEvent: async () => null }));

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping storyline timeline v3 tests: ${support.reason ?? "unsupported environment"}`);

const { videoStorylineRenderService, STALLED_RENDER_GRACE_MS } = await import("../services/video-storyline-render.ts");
const { videoStorylineSettingsService } = await import("../services/video-storyline-settings.ts");
const { videoStorylineService } = await import("../services/video-storylines.ts");
const { videoStorylineClipsService } = await import("../services/video-storyline-clips.ts");
const { videoStorylineTransitionsService, buildStitchPlan } = await import("../services/video-storyline-transitions.ts");
const { videoStorylineRoutes } = await import("../routes/video-storylines.ts");
const { errorHandler } = await import("../middleware/index.ts");
type Provider = import("../services/video-provider-clients.ts").MediaJobProvider;

const ACTOR = { actorType: "user" as const, actorId: "filip", agentId: null };

/** A stand-in video service: `start` does whatever the test says. */
function stubProvider(start: (n: number) => Promise<{ externalId: string; model: string; provider: string }>, poll?: Provider["poll"]): { provider: Provider; starts: number } {
  const state = { starts: 0 };
  const provider: Provider = {
    name: "sogni",
    start: async () => {
      state.starts += 1;
      return start(state.starts);
    },
    poll: poll ?? (async () => ({ status: "running" as const })),
    cancel: async () => undefined,
  } as unknown as Provider;
  return Object.assign(state, { provider });
}

d("storyline timeline v3", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-timeline-v3");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    const manifest = { id: "paperclip.media-studio", apiVersion: 1, version: "1.0.0", displayName: "Media Studio", description: "x", author: "x", categories: ["automation"], capabilities: [], entrypoints: { worker: "dist/worker.js" } } as unknown as PaperclipPluginManifestV1;
    await db.insert(plugins).values({ pluginKey: "paperclip.media-studio", packageName: "@paperclipai/plugin-media-studio", version: "1.0.0", manifestJson: manifest, status: "ready" });
  }, 120_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed(opts: { shots?: number; advanced?: boolean; providerId?: "fal" | "sogni" } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Film Co", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const settings = videoStorylineSettingsService(db);
    await settings.setEnabled(companyId, true);
    if (opts.advanced) await settings.setAdvancedEnabled(companyId, true);
    const svc = videoStorylineService(db);
    const storyline = await svc.createStoryline(
      companyId,
      { title: "Test", projectId: null, providerId: opts.providerId ?? "sogni", model: null, budgetCapCents: 100_000, characterReferenceAssetIds: [], defaultTransition: "cut", defaultTransitionDurationMs: 500, musicAssetId: null, musicSourceKey: null, musicVolumeDb: -18 },
      ACTOR,
    );
    const scene = await svc.createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
    const shotIds: string[] = [];
    for (let i = 0; i < (opts.shots ?? 2); i += 1) {
      const shot = await svc.createShot(companyId, storyline.id, { sceneId: scene.id, orderIndex: i, prompt: `Shot ${i + 1}`, cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null }, ACTOR);
      // Approved on its description alone ("skip picture"): what makes a storyline of "draft" shots renderable.
      await db.update(videoShots).set({ storyboardStatus: "approved" }).where(eq(videoShots.id, shot.id));
      shotIds.push(shot.id);
    }
    return { companyId, storylineId: storyline.id, shotIds };
  }

  async function markMade(shotId: string, companyId: string) {
    const key = `${companyId}/clips/${shotId}.mp4`;
    storedObjects.set(key, { body: Buffer.from("clip"), contentType: "video/mp4" });
    await db.update(videoShots).set({ status: "done", resultProvider: "local_disk", resultObjectKey: key, resultContentType: "video/mp4", resultSha256: `sha-${shotId}`, actualCostCents: 40 }).where(eq(videoShots.id, shotId));
  }

  const storylineRow = async (id: string) => (await db.select().from(videoStorylines).where(eq(videoStorylines.id, id)))[0]!;
  const shotRow = async (id: string) => (await db.select().from(videoShots).where(eq(videoShots.id, id)))[0]!;

  describe("render start failure", () => {
    it("puts the storyline back with a plain reason when the video service crashes (the 204 bug), and the shot shows it too", async () => {
      const { companyId, storylineId, shotIds } = await seed();
      const stub = stubProvider(async () => {
        throw new TypeError("Response constructor: Invalid response status code 204");
      });
      const before = (await storylineRow(storylineId)).status;
      const render = videoStorylineRenderService(db, { buildProvider: () => stub.provider, resolveApiKey: async () => "key" });
      const err = await render.startRender(companyId, storylineId, ACTOR, {}).catch((e: unknown) => e as { status: number; message: string });
      expect(err.status).toBe(422);
      expect(err.message).toContain("The render did not start.");
      expect(err.message).toContain("Something went wrong on our side while sending shot 1 to Sogni");
      expect(err.message).toContain("Nothing was charged");
      expect(err.message).not.toContain("Response constructor");

      const row = await storylineRow(storylineId);
      expect(row.status).toBe(before);
      expect(["draft", "estimated"]).toContain(row.status);
      expect(row.errorMessage).toContain("Nothing was charged");
      const shot = await shotRow(shotIds[0]!);
      expect(shot.status).toBe("failed");
      expect(shot.errorMessage).toContain("Sogni");
      expect((await shotRow(shotIds[1]!)).status).toBe("draft");
      expect(await db.select().from(videoShotRenderJobs).where(eq(videoShotRenderJobs.storylineId, storylineId))).toHaveLength(0);

      // Starting again works once the service accepts it, and clears the old reason.
      const ok = stubProvider(async (n) => ({ externalId: `wf-${n}`, model: "ltx25", provider: "sogni" }));
      const again = await videoStorylineRenderService(db, { buildProvider: () => ok.provider, resolveApiKey: async () => "key" }).startRender(companyId, storylineId, ACTOR, {});
      expect(again.status).toBe("rendering");
      expect(again.errorMessage).toBeNull();
      expect((await shotRow(shotIds[0]!)).status).toBe("rendering");
    });

    it("says what the service refused (a picture upload Sogni would not take)", async () => {
      const { companyId, storylineId } = await seed();
      const stub = stubProvider(async () => {
        throw new Error("Sogni did not give a place to upload the starting frame (500).");
      });
      const render = videoStorylineRenderService(db, { buildProvider: () => stub.provider, resolveApiKey: async () => "key" });
      await expect(render.startRender(companyId, storylineId, ACTOR, {})).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("Sogni didn't accept shot 1: Sogni did not give a place to upload the starting frame (500). Nothing was charged."),
      });
      expect((await storylineRow(storylineId)).status).not.toBe("rendering");
    });

    it("never leaves the storyline rendering when there is no key", async () => {
      const { companyId, storylineId } = await seed();
      await expect(videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {})).rejects.toMatchObject({ status: 422, message: expect.stringContaining("Sogni API key") });
      const row = await storylineRow(storylineId);
      expect(row.status).not.toBe("rendering");
      expect(row.errorMessage).toContain("Sogni API key");
    });

    it("a re-render that cannot start pauses with the shot's reason", async () => {
      const { companyId, storylineId, shotIds } = await seed();
      await markMade(shotIds[0]!, companyId);
      await markMade(shotIds[1]!, companyId);
      await db.update(videoStorylines).set({ status: "done" }).where(eq(videoStorylines.id, storylineId));
      const stub = stubProvider(async () => {
        throw new Error("Sogni refused the video request (402): out of credit");
      });
      const render = videoStorylineRenderService(db, { buildProvider: () => stub.provider, resolveApiKey: async () => "key" });
      await expect(render.reRenderShot(companyId, storylineId, shotIds[1]!, ACTOR)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("enough credit") });
      expect((await storylineRow(storylineId)).status).toBe("paused");
      const shot = await shotRow(shotIds[1]!);
      expect(shot.status).toBe("failed");
      expect(shot.errorMessage).toContain("enough credit");
    });

    it("pauses (not stuck rendering) when the next shot in the chain cannot start", async () => {
      const { companyId, storylineId, shotIds } = await seed();
      let polls = 0;
      const stub = stubProvider(
        async (n) => {
          if (n === 1) return { externalId: "wf-1", model: "ltx25", provider: "sogni" };
          throw new Error("Sogni's storage did not take the starting frame (500).");
        },
        async () => {
          polls += 1;
          return { status: "done" as const, result: { contentType: "video/mp4", dataUrl: `data:video/mp4;base64,${Buffer.from("made").toString("base64")}` } };
        },
      );
      const render = videoStorylineRenderService(db, { buildProvider: () => stub.provider, resolveApiKey: async () => "key" });
      await render.startRender(companyId, storylineId, ACTOR, {});
      await render.tick();
      expect(polls).toBeGreaterThanOrEqual(1);
      const row = await storylineRow(storylineId);
      expect(row.status).toBe("paused");
      expect(row.errorMessage).toContain("Shot 2 could not start");
      expect((await shotRow(shotIds[0]!)).status).toBe("done");
      expect((await shotRow(shotIds[1]!)).errorMessage).toContain("storage did not take");
    });
  });

  describe("stalled renders", () => {
    it("releases a storyline left rendering with nothing running, after the grace period only", async () => {
      const old = await seed();
      const fresh = await seed();
      const busy = await seed();
      const long = new Date(Date.now() - STALLED_RENDER_GRACE_MS - 60_000);
      await db.update(videoStorylines).set({ status: "rendering", updatedAt: long }).where(eq(videoStorylines.id, old.storylineId));
      await db.update(videoShots).set({ status: "queued" }).where(eq(videoShots.id, old.shotIds[0]!));
      await db.update(videoStorylines).set({ status: "rendering" }).where(eq(videoStorylines.id, fresh.storylineId));
      await db.update(videoStorylines).set({ status: "rendering", updatedAt: long }).where(eq(videoStorylines.id, busy.storylineId));
      await db.insert(videoShotRenderJobs).values({ companyId: busy.companyId, storylineId: busy.storylineId, shotId: busy.shotIds[0]!, provider: "sogni", model: "m", externalId: "wf", status: "running" });

      await videoStorylineRenderService(db).releaseStalledRenders();
      const released = await storylineRow(old.storylineId);
      expect(released.status).toBe("paused");
      expect(released.errorMessage).toContain("The render stopped without finishing");
      expect((await shotRow(old.shotIds[0]!)).status).toBe("failed");
      expect((await storylineRow(fresh.storylineId)).status).toBe("rendering");
      expect((await storylineRow(busy.storylineId)).status).toBe("rendering");
    });

    describe("a shot stranded queued/rendering with no job (DUR-4938)", () => {
      const long = () => new Date(Date.now() - STALLED_RENDER_GRACE_MS - 60_000);

      for (const filmStatus of ["draft", "paused"] as const) {
        it(`is cleared by the sweep on a ${filmStatus} film, after which a render starts`, async () => {
          const film = await seed({ shots: 1 });
          await db.update(videoStorylines).set({ status: filmStatus }).where(eq(videoStorylines.id, film.storylineId));
          await db.update(videoShots).set({ status: "queued", updatedAt: long() }).where(eq(videoShots.id, film.shotIds[0]!));

          await videoStorylineRenderService(db).releaseStalledRenders();

          const shot = await shotRow(film.shotIds[0]!);
          expect(shot.status).toBe("failed");
          expect(shot.errorMessage).toContain("never started");
          expect((await storylineRow(film.storylineId)).status).toBe(filmStatus);

          const stub = stubProvider(async () => ({ externalId: "wf-1", model: "ltx25", provider: "sogni" }));
          const render = videoStorylineRenderService(db, { buildProvider: () => stub.provider, resolveApiKey: async () => "key" });
          await render.startRender(film.companyId, film.storylineId, ACTOR, {});
          expect(stub.starts).toBe(1);
          expect((await shotRow(film.shotIds[0]!)).status).toBe("rendering");
        });
      }

      it("leaves a fresh one, and one with a running job, alone", async () => {
        const film = await seed({ shots: 2 });
        await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, film.storylineId));
        await db.update(videoShots).set({ status: "queued" }).where(eq(videoShots.id, film.shotIds[0]!));
        await db.update(videoShots).set({ status: "rendering", updatedAt: long() }).where(eq(videoShots.id, film.shotIds[1]!));
        await db.insert(videoShotRenderJobs).values({ companyId: film.companyId, storylineId: film.storylineId, shotId: film.shotIds[1]!, provider: "sogni", model: "m", externalId: "wf", status: "running" });

        await videoStorylineRenderService(db).releaseStalledRenders();

        expect((await shotRow(film.shotIds[0]!)).status).toBe("queued");
        expect((await shotRow(film.shotIds[1]!)).status).toBe("rendering");
      });

      it("is cleared by cancel on a paused film", async () => {
        const film = await seed({ shots: 2 });
        await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, film.storylineId));
        await db.update(videoShots).set({ status: "queued" }).where(eq(videoShots.id, film.shotIds[0]!));

        const render = videoStorylineRenderService(db, { buildProvider: () => stubProvider(async () => ({ externalId: "x", model: "m", provider: "sogni" })).provider, resolveApiKey: async () => "key" });
        await render.cancelRender(film.companyId, film.storylineId, ACTOR);

        const shot = await shotRow(film.shotIds[0]!);
        expect(shot.status).toBe("failed");
        expect(shot.errorMessage).toContain("never started");
        expect((await storylineRow(film.storylineId)).status).toBe("cancelled");
      });
    });
  });

  describe("delete", () => {
    function appFor(companyId: string) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = { type: "board", source: "session", userId: "owner-1", isInstanceAdmin: false, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] } as unknown as typeof req.actor;
        next();
      });
      app.use("/api", videoStorylineRoutes(db));
      app.use(errorHandler);
      return app;
    }

    it("really deletes (a finished film too), and the list no longer shows it", async () => {
      const { companyId, storylineId } = await seed();
      const keep = await videoStorylineService(db).createStoryline(companyId, { title: "Keep", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] }, ACTOR);
      await db.update(videoStorylines).set({ status: "done" }).where(eq(videoStorylines.id, storylineId));
      const app = appFor(companyId);
      const url = `/api/companies/${companyId}/video-storylines/${storylineId}`;
      const del = await request(app).delete(url);
      // A real delete answers 204 with no body -- never 200 with the storyline in it.
      expect(del.status).toBe(204);
      expect(del.text).toBe("");
      expect(await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId))).toHaveLength(0);
      expect((await request(app).get(url)).status).toBe(404);
      const list = await request(app).get(`/api/companies/${companyId}/video-storylines`);
      expect(list.status).toBe(200);
      expect((list.body as Array<{ id: string }>).map((s) => s.id)).toEqual([keep.id]);
      const logged = await db.select().from(activityLog).where(and(eq(activityLog.entityId, storylineId), eq(activityLog.action, "video_storyline.deleted")));
      expect(logged).toHaveLength(1);
      expect(logged[0]!.details).toMatchObject({ title: "Test" });
      // Deleting it again, or one that never existed, is a plain 404.
      expect((await request(app).delete(url)).status).toBe(404);
      expect((await request(app).delete(`/api/companies/${companyId}/video-storylines/${randomUUID()}`)).status).toBe(404);
    });

    it("the 9 Oct symptom (200 with the storyline, nothing deleted, nothing logged) is what a PATCH with an empty body returns", async () => {
      // The on-box API helper sends any method it doesn't recognise as PATCH {}:
      // PATCH /video-storylines/:id with nothing to change answers 200 with the full
      // storyline and deletes nothing -- exactly what was seen for the smoke tests.
      const { companyId, storylineId } = await seed();
      const app = appFor(companyId);
      const res = await request(app).patch(`/api/companies/${companyId}/video-storylines/${storylineId}`).send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: storylineId, title: "Test" });
      expect(await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, storylineId), eq(activityLog.action, "video_storyline.deleted")))).toHaveLength(0);
    });

    it("refuses while clips are being made, and while the film is being put together", async () => {
      const { companyId, storylineId, shotIds } = await seed();
      await db.update(videoStorylines).set({ status: "rendering" }).where(eq(videoStorylines.id, storylineId));
      await db.insert(videoShotRenderJobs).values({ companyId, storylineId, shotId: shotIds[0]!, provider: "sogni", model: "m", externalId: "wf", status: "running" });
      await expect(videoStorylineService(db).deleteStoryline(companyId, storylineId, ACTOR)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Cancel the render first") });
      await db.update(videoShotRenderJobs).set({ status: "failed" }).where(eq(videoShotRenderJobs.storylineId, storylineId));
      await db.update(videoStorylines).set({ status: "stitching" }).where(eq(videoStorylines.id, storylineId));
      await expect(videoStorylineService(db).deleteStoryline(companyId, storylineId, ACTOR)).rejects.toMatchObject({ status: 409 });
      // Left "rendering" with nothing running (the stuck Test storyline): can be deleted.
      await db.update(videoStorylines).set({ status: "rendering" }).where(eq(videoStorylines.id, storylineId));
      await videoStorylineService(db).deleteStoryline(companyId, storylineId, ACTOR);
      expect(await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId))).toHaveLength(0);
    });
  });

  describe("timeline editing", () => {
    it("trims a made AI clip inside its length, shows it on the strip, and applies it when combining", async () => {
      const { companyId, storylineId, shotIds } = await seed();
      await markMade(shotIds[0]!, companyId);
      const clips = videoStorylineClipsService(db);
      await clips.updateClip(companyId, storylineId, shotIds[0]!, { trimInMs: 1_000, trimOutMs: 4_000 }, ACTOR);
      const shot = await shotRow(shotIds[0]!);
      expect([shot.sourceTrimInMs, shot.sourceTrimOutMs, shot.status]).toEqual([1_000, 4_000, "done"]);
      await expect(clips.updateClip(companyId, storylineId, shotIds[0]!, { trimOutMs: 9_000 }, ACTOR)).rejects.toMatchObject({ status: 422 });
      // Not made yet: nothing to trim.
      await expect(clips.updateClip(companyId, storylineId, shotIds[1]!, { trimInMs: 500 }, ACTOR)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("isn't made yet") });

      const strip = await videoStorylineTransitionsService(db).strip(companyId, storylineId);
      const first = strip.clips.find((c) => c.shotId === shotIds[0])!;
      expect([first.playMs, first.sourceLengthMs]).toEqual([3_000, 5_000]);
      expect(strip.clips.find((c) => c.shotId === shotIds[1])!.playMs).toBe(5_000);
      expect(strip.remainingRenderCents).toBeGreaterThan(0);
      expect(strip.advancedEnabled).toBe(false);

      await markMade(shotIds[1]!, companyId);
      const shots = await db.select().from(videoShots).where(eq(videoShots.storylineId, storylineId)).orderBy(videoShots.orderIndex);
      const plan = await buildStitchPlan(db, await storylineRow(storylineId), shots);
      expect(plan.items[0]!.normalize?.trimMs).toEqual({ startMs: 1_000, endMs: 4_000 });
      expect(plan.items[0]!.writtenSeconds).toBe(3);
      expect(plan.items[1]!.normalize?.trimMs).toBeUndefined();

      // Covering the whole clip again means "no trim".
      await clips.updateClip(companyId, storylineId, shotIds[0]!, { trimInMs: 0, trimOutMs: null }, ACTOR);
      expect([(await shotRow(shotIds[0]!)).sourceTrimInMs, (await shotRow(shotIds[0]!)).sourceTrimOutMs]).toEqual([null, null]);
    });

    it("splits a made AI clip into two trims of the same clip, keeping the join after it", async () => {
      const { companyId, storylineId, shotIds } = await seed();
      await markMade(shotIds[0]!, companyId);
      await markMade(shotIds[1]!, companyId);
      await videoStorylineTransitionsService(db).upsert(companyId, storylineId, { fromShotId: shotIds[0]!, toShotId: shotIds[1]!, kind: "fade" }, ACTOR);
      const { shotId: second } = await videoStorylineClipsService(db).splitClip(companyId, storylineId, shotIds[0]!, { atMs: 2_000 }, ACTOR);
      const shots = await db.select().from(videoShots).where(eq(videoShots.storylineId, storylineId)).orderBy(videoShots.orderIndex);
      expect(shots.map((s) => s.id)).toEqual([shotIds[0], second, shotIds[1]]);
      const [a, b] = [shots[0]!, shots[1]!];
      expect([a.sourceTrimInMs, a.sourceTrimOutMs]).toEqual([null, 2_000]);
      expect([b.sourceTrimInMs, b.sourceTrimOutMs, b.status, b.resultObjectKey, b.actualCostCents]).toEqual([2_000, null, "done", a.resultObjectKey, 0]);
      const joins = await db.select().from(videoTransitions).where(eq(videoTransitions.storylineId, storylineId));
      expect(joins.map((j) => [j.fromShotId, j.toShotId, j.kind])).toEqual([[second, shotIds[1], "fade"]]);
      await expect(videoStorylineClipsService(db).splitClip(companyId, storylineId, second, { atMs: 200 }, ACTOR)).rejects.toMatchObject({ status: 422 });
    });

    it("splits an AI shot that isn't made yet into two shorter shots in whole seconds", async () => {
      const { companyId, storylineId, shotIds } = await seed({ shots: 1 });
      const { shotId: second } = await videoStorylineClipsService(db).splitClip(companyId, storylineId, shotIds[0]!, { atMs: 2_400 }, ACTOR);
      expect((await shotRow(shotIds[0]!)).durationSeconds).toBe(2);
      const b = await shotRow(second);
      expect([b.durationSeconds, b.status, b.storyboardStatus, b.prompt]).toEqual([3, "draft", "approved", "Shot 1"]);
      await expect(videoStorylineClipsService(db).splitClip(companyId, storylineId, second, { atMs: 400 }, ACTOR)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("whole seconds") });
    });

    it("reorders and sets a cut or fade without Advanced features, but an AI bridge still needs them", async () => {
      const { companyId, storylineId, shotIds } = await seed();
      await videoStorylineClipsService(db).reorder(companyId, storylineId, { shotIds: [shotIds[1]!, shotIds[0]!] }, ACTOR);
      const order = (await db.select().from(videoShots).where(eq(videoShots.storylineId, storylineId)).orderBy(videoShots.orderIndex)).map((s) => s.id);
      expect(order).toEqual([shotIds[1], shotIds[0]]);
      const transitions = videoStorylineTransitionsService(db);
      const fade = await transitions.upsert(companyId, storylineId, { fromShotId: shotIds[1]!, toShotId: shotIds[0]!, kind: "fade", durationMs: 800 }, ACTOR);
      expect([fade.kind, fade.durationMs]).toEqual(["fade", 800]);
      await expect(transitions.upsert(companyId, storylineId, { fromShotId: shotIds[1]!, toShotId: shotIds[0]!, kind: "ai" }, ACTOR)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("switched off") });
    });
  });
});
