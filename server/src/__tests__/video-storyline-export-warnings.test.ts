import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, plugins, videoShots, videoStorylines } from "@paperclipai/db";
import type { PaperclipPluginManifestV1, VideoStorylineQualityIssue } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * Storyline export fix (18 Oct): Filip's "Test" film was made and stitched,
 * but the automatic check's "the audio peaks at -0.2 dB" put it on
 * "needs_attention", and Export re-made it, the check flagged the same
 * thing, and it went straight back -- nothing to download.
 *  - Warnings never block: a film with only warnings is "done" and can be
 *    downloaded; a legacy warning-only film can be accepted in one click.
 *  - Every export evens out the sound (loudnorm + limiter), so a loud film
 *    no longer trips the clipping check at all.
 *  - A real problem (wrong length, no picture, a stitch that keeps
 *    failing) still blocks, and the recovery action still works.
 * Storage is in memory; ffmpeg is real (tiny generated clips).
 */

const execFileAsync = promisify(execFile);

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

/** Lets a test force the check's answer (e.g. a blocking finding) without making a broken film. */
const forcedCheck = vi.hoisted(() => ({ issues: null as null | VideoStorylineQualityIssue[] }));
vi.mock("../services/video-quality-check.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/video-quality-check.ts")>();
  return {
    ...actual,
    runVideoQualityCheck: async (...args: Parameters<typeof actual.runVideoQualityCheck>) => {
      if (forcedCheck.issues) {
        const issues = forcedCheck.issues;
        return { passed: issues.length === 0, blocking: issues.some((i) => i.severity === "blocking"), issues };
      }
      return actual.runVideoQualityCheck(...args);
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();
const { checkFfmpegAvailable } = await import("../services/video-ffmpeg.ts");
const ffmpegAvailable = await checkFfmpegAvailable(true);
const d = support.supported && ffmpegAvailable ? describe : describe.skip;
if (!support.supported || !ffmpegAvailable) console.warn("Skipping storyline export warning tests: needs embedded Postgres and ffmpeg.");

const { videoStorylineSettingsService } = await import("../services/video-storyline-settings.ts");
const { videoStorylineService } = await import("../services/video-storylines.ts");
const { videoStorylineStitchService } = await import("../services/video-storyline-stitch.ts");
const { videoStorylineRoutes } = await import("../routes/video-storylines.ts");
const { errorHandler } = await import("../middleware/index.ts");

const ACTOR = { actorType: "user" as const, actorId: "filip", agentId: null };

/** A short moving clip whose sound peaks right at full scale -- what tripped "the audio peaks at -0.2 dB". */
async function loudClip(seconds: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-export-fix-clip-"));
  try {
    const out = join(dir, "loud.mp4");
    await execFileAsync("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc=size=160x120:rate=10:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds},volume=18dB,alimiter=limit=1:level=0,volume=0.5dB`,
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function maxVolumeDb(film: Buffer): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-export-fix-probe-"));
  try {
    const path = join(dir, "film.mp4");
    await writeFile(path, film);
    const { stderr } = await execFileAsync("ffmpeg", ["-hide_banner", "-i", path, "-af", "volumedetect", "-vn", "-f", "null", "-"]);
    return Number.parseFloat(/max_volume:\s*(-?[\d.]+)/.exec(stderr)![1]!);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CLIPPED_LEGACY_ISSUE = { code: "clipped_audio", message: "The audio track peaks at -0.2 dB, which indicates clipping.", shotIndex: null, timeSeconds: null };

d("storyline export: warnings never block, the sound is evened out, real problems still block", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let clip!: Buffer;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-export-warnings");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    const manifest = { id: "paperclip.media-studio", apiVersion: 1, version: "1.0.0", displayName: "Media Studio", description: "x", author: "x", categories: ["automation"], capabilities: [], entrypoints: { worker: "dist/worker.js" } } as unknown as PaperclipPluginManifestV1;
    await db.insert(plugins).values({ pluginKey: "paperclip.media-studio", packageName: "@paperclipai/plugin-media-studio", version: "1.0.0", manifestJson: manifest, status: "ready" });
    clip = await loudClip(2);
  }, 120_000);

  afterAll(async () => {
    await stopDb?.();
  });

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

  /** A storyline whose two shots are made (loud clips), sitting where the test says. */
  async function seed(state: { status: string; finalFilm?: Buffer; issues?: unknown[]; errorMessage?: string | null; clipBody?: Buffer }) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Film Co", issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const svc = videoStorylineService(db);
    const storyline = await svc.createStoryline(
      companyId,
      { title: "Test", projectId: null, providerId: "sogni", model: null, budgetCapCents: 100_000, characterReferenceAssetIds: [], defaultTransition: "cut", defaultTransitionDurationMs: 500, musicAssetId: null, musicSourceKey: null, musicVolumeDb: -18 },
      ACTOR,
    );
    const scene = await svc.createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
    for (let i = 0; i < 2; i += 1) {
      const shot = await svc.createShot(companyId, storyline.id, { sceneId: scene.id, orderIndex: i, prompt: `Shot ${i + 1}`, cameraNotes: null, durationSeconds: 2, lookReferenceAssetIds: [], transitionIn: null }, ACTOR);
      const key = `${companyId}/clips/${shot.id}.mp4`;
      storedObjects.set(key, { body: state.clipBody ?? clip, contentType: "video/mp4" });
      await db
        .update(videoShots)
        .set({ storyboardStatus: "approved", status: "done", resultProvider: "local_disk", resultObjectKey: key, resultContentType: "video/mp4", resultSha256: `sha-${shot.id}`, actualCostCents: 40 })
        .where(eq(videoShots.id, shot.id));
    }
    let finalObjectKey: string | null = null;
    if (state.finalFilm) {
      finalObjectKey = `${companyId}/final/${storyline.id}.mp4`;
      storedObjects.set(finalObjectKey, { body: state.finalFilm, contentType: "video/mp4" });
    }
    await db
      .update(videoStorylines)
      .set({
        status: state.status,
        finalProvider: finalObjectKey ? "local_disk" : null,
        finalObjectKey,
        finalContentType: finalObjectKey ? "video/mp4" : null,
        finalByteSize: state.finalFilm?.byteLength ?? null,
        finalDurationSeconds: finalObjectKey ? 4 : null,
        qualityCheckIssues: (state.issues ?? []) as never,
        qualityCheckedAt: state.issues ? new Date() : null,
        errorMessage: state.errorMessage ?? null,
      })
      .where(eq(videoStorylines.id, storyline.id));
    return { companyId, storylineId: storyline.id, base: `/api/companies/${companyId}/video-storylines/${storyline.id}` };
  }

  const row = async (id: string) => (await db.select().from(videoStorylines).where(eq(videoStorylines.id, id)))[0]!;
  const download = (app: express.Express, path: string) =>
    request(app)
      .get(path)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

  it("Filip's film: a warning-only film on needs_attention reads as a warning and finishes with one click, still downloadable", async () => {
    const { companyId, storylineId, base } = await seed({
      status: "needs_attention",
      finalFilm: clip,
      issues: [CLIPPED_LEGACY_ISSUE],
      errorMessage: "Automatic quality check found 1 issue(s):\n- The audio track peaks at -0.2 dB, which indicates clipping.",
    });
    const app = appFor(companyId);

    const before = await request(app).get(base);
    expect(before.body.qualityCheckIssues).toEqual([expect.objectContaining({ code: "clipped_audio", severity: "warning" })]);

    const accepted = await request(app).post(`${base}/stitch/accept-warnings`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe("done");
    expect(accepted.body.errorMessage).toBeNull();
    // The warning stays visible next to Download.
    expect(accepted.body.qualityCheckIssues).toEqual([expect.objectContaining({ code: "clipped_audio", severity: "warning" })]);
    expect((await row(storylineId)).status).toBe("done");

    const film = await download(app, `${base}/final/content`);
    expect(film.status).toBe(200);
    expect((film.body as Buffer).byteLength).toBe(clip.byteLength);

    // Pressing it again is harmless.
    expect((await request(app).post(`${base}/stitch/accept-warnings`)).status).toBe(200);
  });

  it("Export from needs_attention makes a film with even sound that lands on done and downloads (no loop back)", async () => {
    const { companyId, storylineId, base } = await seed({ status: "needs_attention", finalFilm: clip, issues: [CLIPPED_LEGACY_ISSUE] });
    const app = appFor(companyId);
    // The loud source really would trip the clipping check.
    expect(await maxVolumeDb(clip)).toBeGreaterThanOrEqual(-0.3);

    const exported = await request(app).post(`${base}/export`).send({});
    expect(exported.status).toBe(202);
    expect((await row(storylineId)).status).toBe("ready_to_stitch");

    const tick = await videoStorylineStitchService(db).tick();
    expect(tick).toMatchObject({ stitched: 1, needsAttention: 0, failed: 0 });

    const after = await request(app).get(base);
    expect(after.body.status).toBe("done");
    expect(after.body.errorMessage).toBeNull();
    expect((after.body.qualityCheckIssues as Array<{ code: string }>).map((i) => i.code)).not.toContain("clipped_audio");

    const film = await download(app, `${base}/final/content`);
    expect(film.status).toBe(200);
    expect(film.headers["content-type"]).toBe("video/mp4");
    expect(await maxVolumeDb(film.body as Buffer)).toBeLessThanOrEqual(-0.9);

    // A second tick finds nothing to do: the film stays done.
    expect(await videoStorylineStitchService(db).tick()).toMatchObject({ stitched: 0, needsAttention: 0 });
    expect((await row(storylineId)).status).toBe("done");
  }, 120_000);

  it("a film whose check finds only warnings is done (warnings kept), not needs_attention", async () => {
    const { storylineId } = await seed({ status: "ready_to_stitch" });
    forcedCheck.issues = [{ code: "silent_audio", message: "shot #2 has about 1.6s of silence starting at 2.0s.", shotIndex: 1, timeSeconds: 2, severity: "warning" }];
    try {
      const tick = await videoStorylineStitchService(db).tick();
      expect(tick).toMatchObject({ stitched: 1, needsAttention: 0 });
    } finally {
      forcedCheck.issues = null;
    }
    const stored = await row(storylineId);
    expect(stored.status).toBe("done");
    expect(stored.errorMessage).toBeNull();
    expect(stored.finalObjectKey).not.toBeNull();
    expect(stored.qualityCheckIssues.map((i) => i.code)).toEqual(["silent_audio"]);
  }, 120_000);

  it("a real problem (wrong length) still blocks, cannot be accepted, and Combine again still re-queues it", async () => {
    const { companyId, storylineId, base } = await seed({ status: "ready_to_stitch" });
    forcedCheck.issues = [{ code: "duration_mismatch", message: "The final video is 1.0s long, but the shot plan calls for about 4.0s.", shotIndex: null, timeSeconds: 1, severity: "blocking" }];
    try {
      expect(await videoStorylineStitchService(db).tick()).toMatchObject({ stitched: 0, needsAttention: 1 });
    } finally {
      forcedCheck.issues = null;
    }
    const stored = await row(storylineId);
    expect(stored.status).toBe("needs_attention");
    expect(stored.errorMessage).toContain("stop this film from being finished");
    expect(stored.errorMessage).toContain("shot plan calls for");

    const app = appFor(companyId);
    const refused = await request(app).post(`${base}/stitch/accept-warnings`);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain("real problem");
    expect((await row(storylineId)).status).toBe("needs_attention");

    // The existing recovery action still works.
    expect((await request(app).post(`${base}/stitch/retry`)).status).toBe(200);
    expect((await row(storylineId)).status).toBe("ready_to_stitch");
    expect(await videoStorylineStitchService(db).tick()).toMatchObject({ stitched: 1 });
    expect((await row(storylineId)).status).toBe("done");
  }, 120_000);

  it("a stitch that fails retries once, then stops on needs_attention in plain words instead of looping", async () => {
    const { companyId, storylineId, base } = await seed({ status: "ready_to_stitch", clipBody: Buffer.from("not a video at all") });
    const stitch = videoStorylineStitchService(db);

    expect(await stitch.tick()).toMatchObject({ failed: 1 });
    let stored = await row(storylineId);
    expect(stored.status).toBe("ready_to_stitch");
    expect(stored.errorMessage).toMatch(/^Putting the film together did not work \(.+\)\. Trying once more automatically\.$/);
    expect(stored.errorMessage).not.toContain("Command failed");

    expect(await stitch.tick()).toMatchObject({ failed: 1 });
    stored = await row(storylineId);
    expect(stored.status).toBe("needs_attention");
    expect(stored.qualityCheckIssues).toEqual([expect.objectContaining({ code: "stitch_failed" })]);
    expect(stored.errorMessage).toContain("Combine again");

    // No more automatic attempts.
    expect(await stitch.tick()).toMatchObject({ stitched: 0, failed: 0 });
    // It is a real problem: it cannot be accepted, only combined again.
    const app = appFor(companyId);
    expect((await request(app).post(`${base}/stitch/accept-warnings`)).status).toBe(409);
    expect((await request(app).post(`${base}/stitch/retry`)).status).toBe(200);
    expect((await row(storylineId)).errorMessage).toBeNull();
  }, 120_000);
});
