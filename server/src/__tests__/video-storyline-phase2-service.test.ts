import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assets,
  companies,
  costEvents,
  createDb,
  issueAttachments,
  pluginState,
  plugins,
  videoMediaSpend,
  videoShots,
  videoStorylines,
  videoTransitionTakes,
  videoTransitions,
  videoUploads,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedCompanyWriterModel } from "./helpers/storyline-writer-model.js";

/**
 * Storyline Simple editor, Phase 2: the company's own videos and photos as
 * clips -- upload limits, storage quota and company scoping; the age check
 * and consent before footage reaches any AI service; the "never send to
 * Sogni" setting and Fal no-store; the animate-a-photo spend (cost first,
 * storyline cap and monthly cap); reorder, picture shape, export settings
 * and the music lane; clean-up of unchosen versions. No paid call is made:
 * every provider and every ffmpeg step is stubbed.
 */

const storedObjects = vi.hoisted(() => new Map<string, { body: Buffer; contentType: string }>());
const deleted = vi.hoisted(() => [] as string[]);
/** D18: object keys that were streamed in from a file on disk (never passed through memory as a Buffer). */
const streamedFromDisk = vi.hoisted(() => [] as string[]);
vi.mock("../storage/index.ts", () => ({
  getStorageService: () => ({
    provider: "local_disk",
    putFile: async (input: { companyId: string; namespace: string; originalFilename: string | null; contentType: string; body: Buffer }) => {
      const objectKey = `${input.companyId}/${input.namespace}/${Math.random().toString(36).slice(2)}-${input.originalFilename ?? "file"}`;
      storedObjects.set(objectKey, { body: input.body, contentType: input.contentType });
      return { provider: "local_disk", objectKey, contentType: input.contentType, byteSize: input.body.byteLength, sha256: `sha-${objectKey}`, originalFilename: input.originalFilename };
    },
    // D18: big files (finished films, uploaded videos and their working copies) are streamed in from disk.
    putFileFromPath: async (input: { companyId: string; namespace: string; originalFilename: string | null; contentType: string; filePath: string }) => {
      const body = await (await import("node:fs/promises")).readFile(input.filePath);
      const objectKey = `${input.companyId}/${input.namespace}/${Math.random().toString(36).slice(2)}-${input.originalFilename ?? "file"}`;
      streamedFromDisk.push(objectKey);
      storedObjects.set(objectKey, { body, contentType: input.contentType });
      return { provider: "local_disk", objectKey, contentType: input.contentType, byteSize: body.byteLength, sha256: `sha-${objectKey}`, originalFilename: input.originalFilename };
    },
    getObject: async (_companyId: string, objectKey: string) => {
      const found = storedObjects.get(objectKey);
      if (!found) throw new Error(`no such object ${objectKey}`);
      return { stream: Readable.from(found.body), contentType: found.contentType, contentLength: found.body.byteLength };
    },
    deleteObject: async (_companyId: string, objectKey: string) => {
      deleted.push(objectKey);
      storedObjects.delete(objectKey);
    },
  }),
}));

const video = vi.hoisted(() => ({ starts: [] as Array<Record<string, unknown>>, keys: [] as string[], failStart: false }));
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
      if (video.failStart) throw new Error("The video service is down.");
      video.starts.push(input);
      return { externalId: `job-${video.starts.length}`, model: String(input.model ?? "default"), provider: this.name };
    }
    async poll() {
      return { status: "done" as const, result: { contentType: "video/mp4", dataUrl: `data:video/mp4;base64,${Buffer.from("animated").toString("base64")}` } };
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

const ff = vi.hoisted(() => ({
  normalizeCalls: [] as Array<{ count: number; options: unknown[]; target: unknown }>,
  titles: [] as Array<{ text: string; params: unknown }>,
  music: [] as Array<Record<string, unknown>>,
  prepared: [] as Array<{ kind: string; args: unknown[] }>,
}));
vi.mock("../services/video-ffmpeg.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/video-ffmpeg.ts")>()),
  checkFfmpegAvailable: async () => true,
  extractLastFrameDataUri: async () => "data:image/jpeg;base64,TEFTVA==",
  extractFirstFrameDataUri: async () => "data:image/jpeg;base64,RklSU1Q=",
  buildClipContactSheet: async () => Buffer.from("sheet"),
  // D18: the upload is converted from a file on disk into files in the work folder.
  processUploadedVideoFile: async (_input: string, _opts: unknown, outDir: string) => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const files = { workingPath: join(outDir, "working.mp4"), previewPath: join(outDir, "preview.mp4"), posterPath: join(outDir, "poster.jpg") };
    await writeFile(files.workingPath, "working-video");
    await writeFile(files.previewPath, "preview-video");
    await writeFile(files.posterPath, "poster");
    return {
      ...files,
      media: { width: 1920, height: 1080, durationSeconds: 20, nominalFps: 30, averageFps: 29.5, colorTransfer: "arib-std-b67", hasDolbyVision: false, hasAudio: true, rotation: 0 },
      output: { width: 1920, height: 1080, durationSeconds: 20 },
      wasHdr: true,
      wasVariableFrameRate: true,
      note: null,
    };
  },
  prepareTrimmedClip: async (...args: unknown[]) => {
    ff.prepared.push({ kind: "trim", args: args.slice(1) });
    return Buffer.from("trimmed");
  },
  renderStillClip: async (...args: unknown[]) => {
    ff.prepared.push({ kind: "still", args: args.slice(1) });
    return Buffer.from("still-clip");
  },
  // D18: the film is made file to file in the stitch's work folder.
  normalizeClipFilesForStitch: async (paths: string[], options: unknown[], target: unknown, outDir: string) => {
    ff.normalizeCalls.push({ count: paths.length, options, target });
    const { copyFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const out: string[] = [];
    for (const [index, path] of paths.entries()) {
      const normalized = join(outDir, `norm-${index}.mp4`);
      await copyFile(path, normalized);
      out.push(normalized);
    }
    return { paths: out, durationsSeconds: paths.map(() => 2) };
  },
  renderTitleCard: async (text: string, params: unknown) => {
    ff.titles.push({ text, params });
    return Buffer.from("title");
  },
  stitchClipFiles: async (_paths: string[], outputPath: string) => {
    await (await import("node:fs/promises")).writeFile(outputPath, "film");
  },
  stitchClipFilesWithTransitions: async (_shots: unknown[], workDir: string) => {
    const outputPath = (await import("node:path")).join(workDir, "film-transitions.mp4");
    await (await import("node:fs/promises")).writeFile(outputPath, "film");
    return outputPath;
  },
  addMusicBedToFile: async (videoPath: string, music: Record<string, unknown>, outputPath: string) => {
    ff.music.push(music);
    await (await import("node:fs/promises")).copyFile(videoPath, outputPath);
  },
}));
vi.mock("../services/video-quality-check.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/video-quality-check.ts")>()),
  runVideoQualityCheck: async () => ({ passed: true, issues: [] }),
}));
vi.mock("../services/fal-cost-events.ts", () => ({ recordFalCostEvent: async () => null }));

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping phase 2 tests: ${support.reason ?? "unsupported environment"}`);

const { videoStorylineClipsService, sceneBlocksFor, checkTrim, uploadKindFor } = await import("../services/video-storyline-clips.ts");
const { videoStorylineFootageService } = await import("../services/video-storyline-footage.ts");
const { videoStorylineSettingsService } = await import("../services/video-storyline-settings.ts");
const { videoStorylineService } = await import("../services/video-storylines.ts");
const { videoStorylineTransitionsService } = await import("../services/video-storyline-transitions.ts");
const { videoStorylineRenderService } = await import("../services/video-storyline-render.ts");
const { videoStorylineStitchService } = await import("../services/video-storyline-stitch.ts");
const { secretService } = await import("../services/secrets.ts");
const { videoStorylineRoutes } = await import("../routes/video-storylines.ts");
const { errorHandler } = await import("../middleware/index.ts");

const ACTOR = { actorType: "user" as const, actorId: "filip", agentId: null };

/** A stub picture-reading model: answers the footage age check with `ageAnswer`. */
function fakeModel(ageAnswer = '{"peopleShown": false, "apparentAdult": null}') {
  const calls: Array<{ system: string; hasImage: boolean }> = [];
  const create = vi.fn(async (req: { system: string; messages: Array<{ content: unknown }> }) => {
    const content = req.messages[0]?.content;
    calls.push({ system: req.system, hasImage: Array.isArray(content) && content.some((p: { type?: string }) => p.type === "image") });
    const text = req.system.startsWith("You check") ? ageAnswer : "A quiet street.";
    return { content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 5 }, stop_reason: "end_turn" };
  });
  return { calls, createModelClient: () => ({ messages: { create } }) as never };
}

const photoBytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 100, b: 50 } } }).png().toBuffer();

d("storyline phase 2: clips, footage rules, spend, export, music", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let pluginId = "";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-phase2");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    const manifest = { id: "paperclip.media-studio", apiVersion: 1, version: "1.0.0", displayName: "Media Studio", description: "x", author: "x", categories: ["automation"], capabilities: [], entrypoints: { worker: "dist/worker.js" } } as unknown as PaperclipPluginManifestV1;
    const [plugin] = await db.insert(plugins).values({ pluginKey: "paperclip.media-studio", packageName: "@paperclipai/plugin-media-studio", version: "1.0.0", manifestJson: manifest, status: "ready" }).returning();
    pluginId = plugin!.id;
  }, 120_000);

  afterAll(async () => {
    await stopDb?.();
  });

  beforeEach(() => {
    video.starts.length = 0;
    video.keys.length = 0;
    video.failStart = false;
    ff.normalizeCalls.length = 0;
    ff.titles.length = 0;
    ff.music.length = 0;
    ff.prepared.length = 0;
  });

  async function seedCompany(name = "Clip Co"): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({ id, name, issuePrefix: `P${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const settings = videoStorylineSettingsService(db);
    await settings.setEnabled(id, true);
    await settings.setAdvancedEnabled(id, true);
    return id;
  }

  async function giveOwnKey(companyId: string, service: "fal" | "sogni" = "fal") {
    const secret = await secretService(db).create(companyId, { name: `${service} ${randomUUID().slice(0, 4)}`, provider: "local_encrypted", value: `own-${service}-${companyId.slice(0, 4)}` });
    await db.insert(pluginState).values({ pluginId, scopeKind: "company", scopeId: companyId, namespace: "default", stateKey: "serviceKeys", valueJson: { [service]: secret.id } });
  }

  async function seedStoryline(companyId: string, opts: { providerId?: "fal" | "sogni"; budgetCapCents?: number | null; withAiShot?: boolean } = {}) {
    const svc = videoStorylineService(db);
    const storyline = await svc.createStoryline(
      companyId,
      { title: "Mixed", projectId: null, providerId: opts.providerId ?? "fal", model: null, budgetCapCents: opts.budgetCapCents === undefined ? 1_000 : opts.budgetCapCents, characterReferenceAssetIds: [], defaultTransition: "cut", defaultTransitionDurationMs: 500, musicAssetId: null, musicSourceKey: null, musicVolumeDb: -18 },
      ACTOR,
    );
    let aiShotId: string | null = null;
    if (opts.withAiShot) {
      const scene = await svc.createScene(companyId, storyline.id, { title: "One", notes: null, orderIndex: 0 }, ACTOR);
      const shot = await svc.createShot(companyId, storyline.id, { sceneId: scene.id, orderIndex: 0, prompt: "Anna walks in", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null }, ACTOR);
      const key = `${companyId}/clips/${shot.id}.mp4`;
      storedObjects.set(key, { body: Buffer.from("ai-clip"), contentType: "video/mp4" });
      await db.update(videoShots).set({ status: "done", storyboardStatus: "approved", resultProvider: "local_disk", resultObjectKey: key, resultContentType: "video/mp4", resultSha256: "ai-sha", actualCostCents: 50 }).where(eq(videoShots.id, shot.id));
      aiShotId = shot.id;
    }
    return { storylineId: storyline.id, aiShotId };
  }

  const file = (kind: "video" | "photo", size?: number) =>
    kind === "photo"
      ? { buffer: photoBytes, originalName: "beach.png", contentType: "image/png", size: size ?? photoBytes.length }
      : { buffer: Buffer.from("raw-phone-video"), originalName: "phone.mov", contentType: "video/quicktime", size: size ?? 15 };
  const NO_PEOPLE = { showsPeople: false, consentLikeness: false, consentAdults: false };
  const PEOPLE_OK = { showsPeople: true, consentLikeness: true, consentAdults: true };

  it("has pure helpers for upload kinds, trims and keeping scenes in one block", () => {
    expect(uploadKindFor("video/quicktime", null)).toBe("video");
    expect(uploadKindFor("application/octet-stream", "IMG_1.HEIC")).toBe("photo");
    expect(uploadKindFor("text/html", "x.html")).toBeNull();
    expect(checkTrim(20_000, 0, 10_000)).toBeNull();
    expect(checkTrim(20_000, 5_000, 5_200)).toContain("half a second");
    expect(checkTrim(120_000, 0, 61_000)).toContain("at most 60 seconds");
    expect(checkTrim(20_000, 0, 25_000)).toContain("after the end");
    const scenes = new Map([["s1", 0], ["s2", 1]]);
    const blocks = sceneBlocksFor([{ id: "a", sceneId: "s1" }, { id: "c", sceneId: "s2" }, { id: "b", sceneId: "s1" }], scenes);
    expect([...blocks.values()]).toEqual(["s1", "s2", "s2"]);
  });

  it("enforces size limits, the storage quota, file types and consent, and keeps another company out", async () => {
    const companyId = await seedCompany();
    const { storylineId } = await seedStoryline(companyId);
    const clips = videoStorylineClipsService(db);
    const footage = videoStorylineFootageService(db);
    await footage.setSettings(companyId, { maxVideoMb: 1 });
    await expect(clips.createUpload(companyId, storylineId, file("video", 2 * 1024 * 1024), NO_PEOPLE, ACTOR)).rejects.toMatchObject({ status: 413 });
    await expect(clips.createUpload(companyId, storylineId, { ...file("video"), contentType: "text/html", originalName: "x.html" }, NO_PEOPLE, ACTOR)).rejects.toMatchObject({ status: 415 });
    await expect(clips.createUpload(companyId, storylineId, file("photo"), { showsPeople: true, consentLikeness: true, consentAdults: false }, ACTOR)).rejects.toMatchObject({ status: 422 });

    const photo = await clips.createUpload(companyId, storylineId, file("photo"), NO_PEOPLE, ACTOR);
    expect(photo).toMatchObject({ kind: "photo", status: "ready", width: 64, height: 48 });
    const used = await footage.storageUsedBytes(companyId);
    expect(used).toBe(photo.byteSize);
    // Quota: one more photo would go over.
    await footage.setSettings(companyId, { storageQuotaBytes: used + 10 });
    const before = storedObjects.size;
    await expect(clips.createUpload(companyId, storylineId, file("photo"), NO_PEOPLE, ACTOR)).rejects.toMatchObject({ status: 413 });
    expect(storedObjects.size).toBe(before); // the refused files were not left behind

    const other = await seedCompany("Other Co");
    const otherStoryline = await seedStoryline(other);
    await expect(clips.createClip(other, otherStoryline.storylineId, { uploadId: photo.id }, ACTOR)).rejects.toMatchObject({ status: 404 });
    await expect(clips.createUpload(other, storylineId, file("photo"), NO_PEOPLE, ACTOR)).rejects.toMatchObject({ status: 404 });
    await expect(footage.getUpload(other, photo.id)).rejects.toMatchObject({ status: 404 });
  });

  it("converts an uploaded video in the tick, adds trimmed and photo clips, prepares them for free and shows them on the strip", async () => {
    const companyId = await seedCompany();
    const { storylineId, aiShotId } = await seedStoryline(companyId, { withAiShot: true });
    const clips = videoStorylineClipsService(db);
    const upload = await clips.createUpload(companyId, storylineId, file("video"), PEOPLE_OK, ACTOR);
    expect(upload.status).toBe("processing");
    await expect(clips.createClip(companyId, storylineId, { uploadId: upload.id }, ACTOR)).rejects.toMatchObject({ status: 409 });
    expect(await clips.tick()).toMatchObject({ uploadsProcessed: 1 });
    const [row] = await db.select().from(videoUploads).where(eq(videoUploads.id, upload.id));
    expect(row).toMatchObject({ status: "ready", wasHdr: true, wasVariableFrameRate: true, durationMs: 20_000, rawObjectKey: null, rawByteSize: 0 });

    await expect(clips.createClip(companyId, storylineId, { uploadId: upload.id, trimInMs: 2_000, trimOutMs: 70_000 }, ACTOR)).rejects.toMatchObject({ status: 422 });
    const { shotId: videoClip } = await clips.createClip(companyId, storylineId, { uploadId: upload.id, trimInMs: 2_000, trimOutMs: 6_500 }, ACTOR);
    const photo = await clips.createUpload(companyId, storylineId, file("photo"), NO_PEOPLE, ACTOR);
    const { shotId: photoClip } = await clips.createClip(companyId, storylineId, { uploadId: photo.id, afterShotId: aiShotId, stillMotion: "slow_zoom", holdSeconds: 3 }, ACTOR);

    await clips.tick();
    expect(ff.prepared.map((p) => p.kind).sort()).toEqual(["still", "trim"]);
    expect(ff.prepared.find((p) => p.kind === "trim")!.args).toEqual([2_000, 4_500]);
    expect(ff.prepared.find((p) => p.kind === "still")!.args[0]).toMatchObject({ seconds: 3, motion: "slow_zoom", target: { width: 1920, height: 1080, fps: 30 } });

    const strip = await videoStorylineTransitionsService(db).strip(companyId, storylineId);
    expect(strip.clips.map((c) => [c.clipKind, c.status])).toEqual([
      ["generated", "done"],
      ["still", "done"],
      ["uploaded_video", "done"],
    ]);
    expect(strip.clips[1]!.animateQuoteCents).toBeGreaterThan(0);
    expect(strip.clips[2]).toMatchObject({ shotId: videoClip, trimInMs: 2_000, trimOutMs: 6_500, durationSeconds: 5, upload: { kind: "video", wasHdr: true, inUse: true } });
    expect(strip.storage.usedBytes).toBeGreaterThan(0);
    expect(strip.footage.neverSendUploadsToSogni).toBe(true);
    expect(strip.canCombineAgain).toBe(false); // the film was never combined (status estimated)

    // Reorder: the whole order, and refusal when it does not match.
    await clips.reorder(companyId, storylineId, { shotIds: [videoClip, aiShotId!, photoClip] }, ACTOR);
    const after = await videoStorylineTransitionsService(db).strip(companyId, storylineId);
    expect(after.clips.map((c) => c.shotId)).toEqual([videoClip, aiShotId, photoClip]);
    await expect(clips.reorder(companyId, storylineId, { shotIds: [videoClip, aiShotId!] }, ACTOR)).rejects.toMatchObject({ status: 409 });

    // Changing a trim queues the clip again; mute/volume do not.
    await clips.updateClip(companyId, storylineId, videoClip, { muted: true, volumeDb: -6 }, ACTOR);
    let [shot] = await db.select().from(videoShots).where(eq(videoShots.id, videoClip));
    expect(shot).toMatchObject({ clipMuted: true, clipVolumeDb: -6, status: "done" });
    await clips.updateClip(companyId, storylineId, videoClip, { trimOutMs: 9_000 }, ACTOR);
    [shot] = await db.select().from(videoShots).where(eq(videoShots.id, videoClip));
    expect(shot).toMatchObject({ status: "queued", sourceTrimOutMs: 9_000, durationSeconds: 7, resultObjectKey: null });
    // Timeline v3: a made AI clip is trimmed in place (applied when combining; nothing is re-made), but has no photo length.
    await clips.updateClip(companyId, storylineId, aiShotId!, { trimInMs: 500 }, ACTOR);
    [shot] = await db.select().from(videoShots).where(eq(videoShots.id, aiShotId!));
    expect(shot).toMatchObject({ status: "done", sourceTrimInMs: 500, sourceTrimOutMs: null });
    await expect(clips.updateClip(companyId, storylineId, aiShotId!, { holdSeconds: 3 }, ACTOR)).rejects.toMatchObject({ status: 422 });

    // A clip being prepared stops the film from being combined, in plain words.
    await db.update(videoStorylines).set({ status: "ready_to_stitch" }).where(eq(videoStorylines.id, storylineId));
    const [storyline] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId));
    expect(await videoStorylineStitchService(db).stitchOne(storyline!)).toBe("blocked");
    const [blocked] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId));
    expect(blocked!.stitchBlockedReason).toContain("Getting clip");
  });

  it("only a person can tick the consent boxes; an agent uploads with them unticked and its changes clear them (security review DUR-4745)", async () => {
    const companyId = await seedCompany();
    const { storylineId } = await seedStoryline(companyId);
    const clips = videoStorylineClipsService(db);
    const AGENT = { actorType: "agent" as const, actorId: "agent-1", agentId: null };
    await expect(clips.createUpload(companyId, storylineId, file("photo"), PEOPLE_OK, AGENT)).rejects.toMatchObject({ status: 403 });
    await expect(clips.createUpload(companyId, storylineId, file("photo"), { showsPeople: false, consentLikeness: false, consentAdults: true }, AGENT)).rejects.toMatchObject({ status: 403 });
    const byAgent = await clips.createUpload(companyId, storylineId, file("photo"), { showsPeople: true, consentLikeness: false, consentAdults: false }, AGENT);
    expect(byAgent).toMatchObject({ showsPeople: true, consentLikeness: false, consentAdults: false });
    // A person ticks them; an agent cannot tick them, and any change it makes clears them.
    await clips.updateConsent(companyId, storylineId, byAgent.id, PEOPLE_OK, ACTOR);
    await expect(clips.updateConsent(companyId, storylineId, byAgent.id, PEOPLE_OK, AGENT)).rejects.toMatchObject({ status: 403 });
    const cleared = await clips.updateConsent(companyId, storylineId, byAgent.id, { showsPeople: true, consentLikeness: false, consentAdults: false }, AGENT);
    expect(cleared).toMatchObject({ consentLikeness: false, consentAdults: false });
  });

  it("the picture-reading model never describes frames of people from your footage without both ticks, even when it was uploaded as no people (security review DUR-4745)", async () => {
    const companyId = await seedCompany();
    await seedCompanyWriterModel(db, companyId, { canSeePictures: true });
    const { storylineId, aiShotId } = await seedStoryline(companyId, { withAiShot: true });
    const clips = videoStorylineClipsService(db);
    const upload = await clips.createUpload(companyId, storylineId, file("photo"), NO_PEOPLE, ACTOR);
    const { shotId } = await clips.createClip(companyId, storylineId, { uploadId: upload.id }, ACTOR);
    await clips.tick();
    const systems: string[] = [];
    const create = vi.fn(async (req: { system: string }) => {
      systems.push(req.system);
      const text = req.system.startsWith("You check pictures")
        ? '{"peopleShown": true, "apparentAdult": true}'
        : req.system.startsWith("You describe")
          ? "Two colleagues at a desk."
          : JSON.stringify({ suggestedKind: "blend", reason: "x", aiStyle: null, plainLine: "Soft blend. 1 s.", prompt: "", durationSeconds: 3 });
      return { content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" };
    });
    const transitions = videoStorylineTransitionsService(db, { modelOptions: { createModelClient: () => ({ messages: { create } }) as never } });
    const gap = await transitions.suggest(companyId, storylineId, { fromShotId: aiShotId!, toShotId: shotId }, ACTOR);
    // The AI shot's end is described; the footage side is age-checked but never described.
    expect(systems.filter((x) => x.startsWith("You describe"))).toHaveLength(1);
    expect(gap.textOnlyReason).toContain("both consent ticks");
    const [footageShot] = await db.select().from(videoShots).where(eq(videoShots.id, shotId));
    expect((footageShot!.frameNotes as Record<string, unknown>).start).toBeUndefined();
    // Once a person ticks both boxes, the next suggestion may describe it.
    await clips.updateConsent(companyId, storylineId, upload.id, PEOPLE_OK, ACTOR);
    systems.length = 0;
    await transitions.suggest(companyId, storylineId, { fromShotId: aiShotId!, toShotId: shotId }, ACTOR);
    expect(systems.filter((x) => x.startsWith("You describe"))).toHaveLength(1);
  });

  it("music uploads are checked by their bytes and count in the storage limit (security review DUR-4745)", async () => {
    const companyId = await seedCompany();
    const clips = videoStorylineClipsService(db);
    const footage = videoStorylineFootageService(db);
    const fake = { buffer: Buffer.from("#EXTM3U\nfile:///etc/passwd\n"), originalName: "song.mp3", contentType: "audio/mpeg", size: 30 };
    await expect(clips.uploadMusic(companyId, fake, ACTOR)).rejects.toMatchObject({ status: 415 });
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(200)]);
    const choice = await clips.uploadMusic(companyId, { buffer: wav, originalName: "song.wav", contentType: "audio/wav", size: wav.length }, ACTOR);
    expect(choice.source).toBe("upload");
    expect(await footage.storageUsedBytes(companyId)).toBe(wav.length);
    await footage.setSettings(companyId, { storageQuotaBytes: wav.length + 10 });
    await expect(clips.uploadMusic(companyId, { buffer: wav, originalName: "again.wav", contentType: "audio/wav", size: wav.length }, ACTOR)).rejects.toMatchObject({ status: 413 });
  });

  it("an upload that is in use cannot be deleted; an unused one can", async () => {
    const companyId = await seedCompany();
    const { storylineId } = await seedStoryline(companyId);
    const clips = videoStorylineClipsService(db);
    const used = await clips.createUpload(companyId, storylineId, file("photo"), NO_PEOPLE, ACTOR);
    await clips.createClip(companyId, storylineId, { uploadId: used.id }, ACTOR);
    await expect(clips.deleteUpload(companyId, storylineId, used.id, ACTOR)).rejects.toMatchObject({ status: 409 });
    const spare = await clips.createUpload(companyId, storylineId, file("photo"), NO_PEOPLE, ACTOR);
    await clips.deleteUpload(companyId, storylineId, spare.id, ACTOR);
    expect(await db.select().from(videoUploads).where(eq(videoUploads.id, spare.id))).toHaveLength(0);
  });

  async function photoFilm(opts: { providerId?: "fal" | "sogni"; consent?: typeof NO_PEOPLE; vision?: boolean; budgetCapCents?: number | null; companyId?: string } = {}) {
    const companyId = opts.companyId ?? (await seedCompany());
    if (!opts.companyId) {
      await seedCompanyWriterModel(db, companyId, { canSeePictures: opts.vision ?? true });
      await giveOwnKey(companyId, opts.providerId ?? "fal");
    }
    const { storylineId } = await seedStoryline(companyId, { providerId: opts.providerId, budgetCapCents: opts.budgetCapCents });
    const clips0 = videoStorylineClipsService(db);
    const upload = await clips0.createUpload(companyId, storylineId, file("photo"), opts.consent ?? NO_PEOPLE, ACTOR);
    const { shotId } = await clips0.createClip(companyId, storylineId, { uploadId: upload.id }, ACTOR);
    await clips0.tick();
    const quote = (await videoStorylineTransitionsService(db).strip(companyId, storylineId)).clips[0]!.animateQuoteCents!;
    return { companyId, storylineId, shotId, uploadId: upload.id, quote };
  }

  it("animates a photo only after the age check, cost first, holding money against the film's budget and the monthly cap, with Fal no-store", async () => {
    const film = await photoFilm();
    const model = fakeModel('{"peopleShown": false, "apparentAdult": null}');
    const clips = videoStorylineClipsService(db, { modelOptions: { createModelClient: model.createModelClient } });
    await expect(clips.animate(film.companyId, film.storylineId, film.shotId, { prompt: "Waves roll in", confirmCostCents: film.quote - 1 }, ACTOR)).rejects.toMatchObject({ status: 409 });
    expect(video.starts).toHaveLength(0);

    const { reservedCents } = await clips.animate(film.companyId, film.storylineId, film.shotId, { prompt: "Waves roll in", confirmCostCents: film.quote }, ACTOR);
    expect(reservedCents).toBe(film.quote);
    // The age check looked at the photo itself (one call, cached for the render).
    expect(model.calls.filter((c) => c.system.startsWith("You check a picture"))).toHaveLength(1);
    expect(model.calls[0]!.hasImage).toBe(true);
    expect(video.starts).toHaveLength(1);
    expect(video.keys).toEqual([`own-fal-${film.companyId.slice(0, 4)}`]);
    expect(video.starts[0]).toMatchObject({ prompt: expect.stringContaining("Waves roll in"), storeIO: false, aspectRatio: "16:9" });
    expect(String(video.starts[0]!.startImage)).toMatch(/^data:image\/jpeg;base64,/);
    const [held] = await db.select().from(videoMediaSpend).where(eq(videoMediaSpend.shotId, film.shotId));
    expect(held).toMatchObject({ status: "reserved", reservedCents: film.quote, kind: "animate_photo" });
    const [storyline] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, film.storylineId));
    expect(storyline!.spentCents).toBe(film.quote);
    expect(await videoStorylineFootageService(db).monthlySpentCents(film.companyId)).toBe(film.quote);

    // The clip arrives: the hold is settled, not counted twice, and no other shot starts rendering.
    await videoStorylineRenderService(db).tick();
    const [settled] = await db.select().from(videoMediaSpend).where(eq(videoMediaSpend.shotId, film.shotId));
    expect(settled!.status).toBe("settled");
    expect(settled!.costCents).toBeGreaterThan(0);
    const [afterDone] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, film.storylineId));
    // Settled at the real cost: the hold is swapped for it, never added on top.
    expect(afterDone!.spentCents).toBe(settled!.costCents);
    const [shot] = await db.select().from(videoShots).where(eq(videoShots.id, film.shotId));
    expect(shot).toMatchObject({ clipKind: "generated", status: "done", sourceUploadId: film.uploadId });
  });

  it("refuses to animate past the film's budget or the company's monthly cap, and gives nothing away when the service fails to start", async () => {
    const tight = await photoFilm({ budgetCapCents: 1 });
    const clips = videoStorylineClipsService(db, { modelOptions: { createModelClient: fakeModel().createModelClient } });
    await expect(clips.animate(tight.companyId, tight.storylineId, tight.shotId, { prompt: "x", confirmCostCents: tight.quote }, ACTOR)).rejects.toMatchObject({ status: 422 });
    const capped = await photoFilm();
    await videoStorylineSettingsService(db).setMediaMonthlyCapCents(capped.companyId, capped.quote - 1);
    await expect(clips.animate(capped.companyId, capped.storylineId, capped.shotId, { prompt: "x", confirmCostCents: capped.quote }, ACTOR)).rejects.toThrow(/monthly limit/);
    expect(video.starts).toHaveLength(0);
    expect(await db.select().from(videoMediaSpend).where(eq(videoMediaSpend.companyId, capped.companyId))).toHaveLength(0);
  });

  it("an animated photo stays counted in the monthly limit after the clip is removed and the film deleted (security review DUR-4807)", async () => {
    const film = await photoFilm();
    await videoStorylineSettingsService(db).setMediaMonthlyCapCents(film.companyId, film.quote);
    const clips = videoStorylineClipsService(db, { modelOptions: { createModelClient: fakeModel('{"peopleShown": false, "apparentAdult": null}').createModelClient } });
    const footage = videoStorylineFootageService(db);
    await clips.animate(film.companyId, film.storylineId, film.shotId, { prompt: "Waves roll in", confirmCostCents: film.quote }, ACTOR);
    await videoStorylineRenderService(db).tick();
    expect(await footage.monthlySpentCents(film.companyId)).toBe(film.quote);
    // One ledger row, settled in place -- not a second "shot" row on top.
    const paid = (await db.select().from(costEvents).where(eq(costEvents.companyId, film.companyId))).filter((r) => r.billingCode?.startsWith("video-storyline"));
    expect(paid.map((r) => [r.billingCode?.split(":")[0], r.costCents])).toEqual([["video-storyline-animate-photo", film.quote]]);

    await clips.removeClip(film.companyId, film.storylineId, film.shotId, ACTOR);
    expect(await footage.monthlySpentCents(film.companyId)).toBe(film.quote);
    await videoStorylineService(db).deleteStoryline(film.companyId, film.storylineId, ACTOR);
    expect(await db.select().from(videoMediaSpend).where(eq(videoMediaSpend.companyId, film.companyId))).toHaveLength(0);
    expect(await footage.monthlySpentCents(film.companyId)).toBe(film.quote);

    // The limit is still used up: the next photo is refused before anything is sent.
    const next = await photoFilm({ companyId: film.companyId });
    const startsBefore = video.starts.length;
    await expect(clips.animate(next.companyId, next.storylineId, next.shotId, { prompt: "x", confirmCostCents: next.quote }, ACTOR)).rejects.toThrow(/monthly limit/);
    expect(video.starts).toHaveLength(startsBefore);
    // Another company is not affected.
    expect(await footage.monthlySpentCents((await photoFilm()).companyId)).toBe(0);
  });

  it("a photo the video service never started gives its hold back in the ledger too (DUR-4807)", async () => {
    const film = await photoFilm();
    const clips = videoStorylineClipsService(db, { modelOptions: { createModelClient: fakeModel('{"peopleShown": false, "apparentAdult": null}').createModelClient } });
    video.failStart = true;
    await expect(clips.animate(film.companyId, film.storylineId, film.shotId, { prompt: "x", confirmCostCents: film.quote }, ACTOR)).rejects.toThrow();
    const rows = (await db.select().from(costEvents).where(eq(costEvents.companyId, film.companyId))).filter((r) => r.billingCode?.startsWith("video-storyline"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costCents: 0, costMicroUsd: 0 });
    expect(await videoStorylineFootageService(db).monthlySpentCents(film.companyId)).toBe(0);
  });

  it("never sends a photo the age check did not clear, or one showing people without both consent ticks", async () => {
    const minor = await photoFilm();
    const strict = videoStorylineClipsService(db, { modelOptions: { createModelClient: fakeModel('{"peopleShown": true, "apparentAdult": null}').createModelClient } });
    await expect(strict.animate(minor.companyId, minor.storylineId, minor.shotId, { prompt: "x", confirmCostCents: minor.quote }, ACTOR)).rejects.toThrow(/age check/);
    // The refusal is stored and never gets milder, even with a friendlier answer later.
    const lenient = videoStorylineClipsService(db, { modelOptions: { createModelClient: fakeModel('{"peopleShown": true, "apparentAdult": true}').createModelClient } });
    await expect(lenient.animate(minor.companyId, minor.storylineId, minor.shotId, { prompt: "x", confirmCostCents: minor.quote }, ACTOR)).rejects.toThrow(/age check/);

    // People seen in a photo uploaded as "no people": consent is required before it leaves.
    const unticked = await photoFilm();
    await expect(lenient.animate(unticked.companyId, unticked.storylineId, unticked.shotId, { prompt: "x", confirmCostCents: unticked.quote }, ACTOR)).rejects.toThrow(/tick both boxes/);
    await lenient.updateConsent(unticked.companyId, unticked.storylineId, (await db.select().from(videoShots).where(eq(videoShots.id, unticked.shotId)))[0]!.sourceUploadId!, PEOPLE_OK, ACTOR);
    await lenient.animate(unticked.companyId, unticked.storylineId, unticked.shotId, { prompt: "x", confirmCostCents: unticked.quote }, ACTOR);
    expect(video.starts).toHaveLength(1);

    // No picture-reading model at all: nothing is sent, with a plain reason.
    const blind = await photoFilm({ vision: false });
    await expect(lenient.animate(blind.companyId, blind.storylineId, blind.shotId, { prompt: "x", confirmCostCents: blind.quote }, ACTOR)).rejects.toThrow(/checked for apparent age/);
    expect(video.starts).toHaveLength(1);
  });

  it("never sends uploaded footage to Sogni while the company setting is on (the default), for animation and AI bridges", async () => {
    const film = await photoFilm({ providerId: "sogni" });
    const clips = videoStorylineClipsService(db, { modelOptions: { createModelClient: fakeModel().createModelClient } });
    await expect(clips.animate(film.companyId, film.storylineId, film.shotId, { prompt: "x", confirmCostCents: film.quote }, ACTOR)).rejects.toThrow(/never sends uploaded footage to Sogni/);

    // An AI bridge next to the photo clip on Sogni is refused too; the money comes back.
    const svc = videoStorylineService(db);
    const scene = (await svc.listScenes(film.companyId, film.storylineId))[0]!;
    const ai = await svc.createShot(film.companyId, film.storylineId, { sceneId: scene.id, orderIndex: 9, prompt: "Sunset", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null }, ACTOR);
    storedObjects.set(`${film.companyId}/ai2.mp4`, { body: Buffer.from("ai2"), contentType: "video/mp4" });
    await db.update(videoShots).set({ status: "done", storyboardStatus: "approved", resultProvider: "local_disk", resultObjectKey: `${film.companyId}/ai2.mp4`, resultSha256: "ai2" }).where(eq(videoShots.id, ai.id));
    const transitions = videoStorylineTransitionsService(db, { modelOptions: { createModelClient: fakeModel().createModelClient } });
    const gap = await transitions.upsert(film.companyId, film.storylineId, { fromShotId: film.shotId, toShotId: ai.id, kind: "ai" }, ACTOR);
    await expect(transitions.generate(film.companyId, film.storylineId, gap.id!, {}, ACTOR)).rejects.toThrow(/never sends uploaded footage to Sogni/);
    expect(video.starts).toHaveLength(0);
    const [storyline] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, film.storylineId));
    expect(storyline!.spentCents).toBe(0);

    // Switched off by an owner/admin: the same bridge is made after the age check.
    await videoStorylineFootageService(db).setSettings(film.companyId, { neverSendUploadsToSogni: false });
    await transitions.generate(film.companyId, film.storylineId, gap.id!, {}, ACTOR);
    expect(video.starts).toHaveLength(1);
  });

  it("sends Fal bridges next to your footage with no-store, and AI-only bridges without it", async () => {
    const film = await photoFilm();
    const svc = videoStorylineService(db);
    const scene = (await svc.listScenes(film.companyId, film.storylineId))[0]!;
    const ai = await svc.createShot(film.companyId, film.storylineId, { sceneId: scene.id, orderIndex: 9, prompt: "Sunset", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null }, ACTOR);
    storedObjects.set(`${film.companyId}/ai3.mp4`, { body: Buffer.from("ai3"), contentType: "video/mp4" });
    await db.update(videoShots).set({ status: "done", storyboardStatus: "approved", resultProvider: "local_disk", resultObjectKey: `${film.companyId}/ai3.mp4`, resultSha256: "ai3" }).where(eq(videoShots.id, ai.id));
    const transitions = videoStorylineTransitionsService(db, { modelOptions: { createModelClient: fakeModel().createModelClient } });
    const gap = await transitions.upsert(film.companyId, film.storylineId, { fromShotId: film.shotId, toShotId: ai.id, kind: "ai" }, ACTOR);
    await transitions.generate(film.companyId, film.storylineId, gap.id!, {}, ACTOR);
    expect(video.starts[0]).toMatchObject({ storeIO: false });
  });

  it("chooses the picture shape before rendering, sends it to the models, and locks it after the first AI render", async () => {
    const companyId = await seedCompany();
    const { storylineId } = await seedStoryline(companyId);
    const clips = videoStorylineClipsService(db);
    await clips.setAspect(companyId, storylineId, "9:16", ACTOR);
    let strip = await videoStorylineTransitionsService(db).strip(companyId, storylineId);
    expect(strip).toMatchObject({ aspect: "9:16", aspectLocked: false, exportSettings: { preset: "reels_9_16" } });
    const withShot = await seedStoryline(companyId, { withAiShot: true });
    await expect(clips.setAspect(companyId, withShot.storylineId, "1:1", ACTOR)).rejects.toMatchObject({ status: 409 });
    strip = await videoStorylineTransitionsService(db).strip(companyId, withShot.storylineId);
    expect(strip.aspectLocked).toBe(true);
    // Exporting a 16:9 film as 9:16 with Fill warns how much is cropped.
    await clips.updateExportSettings(companyId, withShot.storylineId, { preset: "reels_9_16", fit: "fill" }, ACTOR);
    strip = await videoStorylineTransitionsService(db).strip(companyId, withShot.storylineId);
    expect(strip.exportWarnings[0]).toContain("about 68%");
  });

  it("exports again with new settings and no re-render: chosen size and fps at assembly, clean title text, music lane and per-clip sound", async () => {
    const companyId = await seedCompany();
    const { storylineId, aiShotId } = await seedStoryline(companyId, { withAiShot: true });
    await db.update(videoStorylines).set({ status: "done" }).where(eq(videoStorylines.id, storylineId));
    const clips = videoStorylineClipsService(db);
    // Music made in Media Studio is a company FILE id (an issue attachment): accepted and resolved to its asset.
    const [audio] = await db.insert(assets).values({ companyId, provider: "local_disk", objectKey: `${companyId}/music.mp3`, contentType: "audio/mpeg", byteSize: 5, sha256: "m", originalFilename: "theme.mp3" }).returning();
    storedObjects.set(`${companyId}/music.mp3`, { body: Buffer.from("music"), contentType: "audio/mpeg" });
    const [attachment] = await db.insert(issueAttachments).values({ companyId, assetId: audio!.id }).returning();
    await clips.updateMusicLane(companyId, storylineId, { musicFileId: attachment!.id, trimInMs: 1_000, trimOutMs: 9_000, offsetMs: 500, fadeInMs: 800, fadeOutMs: 1_500, volumeDb: -14, audioMode: "replace" }, ACTOR);
    await expect(clips.updateMusicLane(companyId, storylineId, { trimInMs: 9_500 }, ACTOR)).rejects.toMatchObject({ status: 422 });
    const [pic] = await db.insert(assets).values({ companyId, provider: "local_disk", objectKey: `${companyId}/pic.png`, contentType: "image/png", byteSize: 5, sha256: "p" }).returning();
    await expect(clips.updateMusicLane(companyId, storylineId, { musicFileId: pic!.id }, ACTOR)).rejects.toMatchObject({ status: 422 });
    const otherCompany = await seedCompany("Other");
    const [foreign] = await db.insert(assets).values({ companyId: otherCompany, provider: "local_disk", objectKey: `${otherCompany}/m.mp3`, contentType: "audio/mpeg", byteSize: 5, sha256: "f" }).returning();
    await expect(clips.updateMusicLane(companyId, storylineId, { musicFileId: foreign!.id }, ACTOR)).rejects.toMatchObject({ status: 404 });
    expect((await clips.musicChoices(companyId)).map((c) => [c.id, c.source])).toEqual([[attachment!.id, "media_studio"]]);
    await clips.updateClip(companyId, storylineId, aiShotId!, { volumeDb: 6 }, ACTOR);

    await clips.exportAgain(
      companyId,
      storylineId,
      {
        settings: {
          preset: "square_1_1",
          fps: 24,
          fit: "fill",
          quality: "high",
          opening: { text: "My \u0007film: 100% %{pts}", seconds: 3 },
          credits: { text: "Anna\nBen", seconds: 4 },
        },
      },
      ACTOR,
    );
    const [queued] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId));
    expect(queued!.status).toBe("ready_to_stitch");
    expect(await videoStorylineStitchService(db).stitchOne(queued!)).toBe("stitched");
    expect(video.starts).toHaveLength(0); // nothing re-rendered
    expect(ff.normalizeCalls[0]!.target).toEqual({ width: 1080, height: 1080, fps: 24, fit: "fill", quality: "high" });
    expect(ff.normalizeCalls[0]!.count).toBe(3); // title + shot + credits
    expect(ff.normalizeCalls[0]!.options[1]).toEqual({ audio: { gainDb: 6 } });
    expect(ff.titles.map((t) => t.text)).toEqual(["My film: 100% %{pts}", "Anna\nBen"]);
    expect(ff.music[0]).toMatchObject({ trimInMs: 1_000, trimOutMs: 9_000, offsetMs: 500, fadeInMs: 800, fadeOutMs: 1_500, volumeDb: -14, mode: "replace" });
  });

  it("the settings routes: anyone in the company reads them, only an owner or admin changes them; uploads go through multipart with the company's limit", async () => {
    const companyId = await seedCompany();
    const { storylineId } = await seedStoryline(companyId);
    const member = { type: "board", source: "session", userId: "member-1", isInstanceAdmin: false, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "member" }] };
    const owner = { ...member, userId: "owner-1", memberships: [{ companyId, status: "active", membershipRole: "owner" }] };
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
    const base = `/api/companies/${companyId}/video-storylines`;
    const read = await request(appFor(member)).get(`${base}/settings/footage`);
    expect(read.status).toBe(200);
    expect(read.body.settings.neverSendUploadsToSogni).toBe(true);
    expect(read.body.explanations.neverSendUploadsToSogni).toContain("never sent to Sogni");
    expect((await request(appFor(member)).patch(`${base}/settings/footage`).send({ neverSendUploadsToSogni: false })).status).toBe(403);
    const changed = await request(appFor(owner)).patch(`${base}/settings/footage`).send({ maxPhotoMb: 1, neverSendUploadsToSogni: false });
    expect(changed.status).toBe(200);
    expect(changed.body.settings).toMatchObject({ maxPhotoMb: 1, neverSendUploadsToSogni: false });

    const ok = await request(appFor(member)).post(`${base}/${storylineId}/uploads`).field("showsPeople", "false").attach("file", photoBytes, { filename: "a.png", contentType: "image/png" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ kind: "photo", status: "ready" });
    const big = Buffer.alloc(2 * 1024 * 1024, 1);
    const tooBig = await request(appFor(member)).post(`${base}/${storylineId}/uploads`).attach("file", big, { filename: "b.png", contentType: "image/png" });
    expect(tooBig.status).toBe(413);
    const noConsent = await request(appFor(member)).post(`${base}/${storylineId}/uploads`).field("showsPeople", "true").attach("file", photoBytes, { filename: "c.png", contentType: "image/png" });
    expect(noConsent.status).toBe(422);

    // D18: videos up to 2 GB by default, and a per-company limit for finished films and saved videos.
    expect(read.body.settings).toMatchObject({ maxVideoMb: 2048, maxVideoFileMb: 2048 });
    expect(read.body.hardLimits).toMatchObject({ maxVideoMb: 4096, maxVideoFileMb: 4096 });
    expect(read.body.explanations.maxVideoFileMb).toContain("finished film");
    const raised = await request(appFor(owner)).patch(`${base}/settings/footage`).send({ maxVideoFileMb: 3000 });
    expect(raised.status).toBe(200);
    expect(raised.body.settings.maxVideoFileMb).toBe(3000);
    expect((await request(appFor(owner)).patch(`${base}/settings/footage`).send({ maxVideoFileMb: 5000 })).status).toBe(400);
    expect((await request(appFor(member)).patch(`${base}/settings/footage`).send({ maxVideoFileMb: 100 })).status).toBe(403);
    // An uploaded video is streamed from its temp file into storage (the stored copy is byte for byte the upload).
    const video = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(300_000, 3)]);
    const uploaded = await request(appFor(member)).post(`${base}/${storylineId}/uploads`).field("showsPeople", "false").attach("file", video, { filename: "phone.mp4", contentType: "video/mp4" });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toMatchObject({ kind: "video", status: "processing", byteSize: video.length });
    const [rawRow] = await db.select().from(videoUploads).where(eq(videoUploads.id, uploaded.body.id));
    expect(streamedFromDisk).toContain(rawRow!.rawObjectKey);
    expect(Buffer.compare(storedObjects.get(rawRow!.rawObjectKey!)!.body, video)).toBe(0);
  });

  it("cleans up unused uploads and unpicked AI bridge versions after the company's days, keeping what is used", async () => {
    const companyId = await seedCompany();
    const { storylineId, aiShotId } = await seedStoryline(companyId, { withAiShot: true });
    const clips = videoStorylineClipsService(db);
    const used = await clips.createUpload(companyId, storylineId, file("photo"), NO_PEOPLE, ACTOR);
    const { shotId } = await clips.createClip(companyId, storylineId, { uploadId: used.id }, ACTOR);
    const unused = await clips.createUpload(companyId, storylineId, file("photo"), NO_PEOPLE, ACTOR);
    const old = new Date(Date.now() - 20 * 24 * 3600_000);
    await db.update(videoUploads).set({ updatedAt: old }).where(eq(videoUploads.storylineId, storylineId));
    const [transition] = await db.insert(videoTransitions).values({ companyId, storylineId, fromShotId: aiShotId!, toShotId: shotId, kind: "ai" }).returning();
    const takeRow = (id: string) => ({ id, companyId, storylineId, transitionId: transition!.id, status: "ready", provider: "fal", model: "m", anchorHash: "h", prompt: "p", durationMs: 3000, resultObjectKey: `${companyId}/take-${id}.mp4`, completedAt: old, updatedAt: old, createdAt: old });
    const chosenId = randomUUID();
    const spareId = randomUUID();
    await db.insert(videoTransitionTakes).values([takeRow(chosenId), takeRow(spareId)]);
    await db.update(videoTransitions).set({ chosenTakeId: chosenId }).where(eq(videoTransitions.id, transition!.id));

    const result = await clips.cleanup(true);
    expect(result.uploads).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(videoUploads).where(eq(videoUploads.id, unused.id))).toHaveLength(0);
    expect(await db.select().from(videoUploads).where(eq(videoUploads.id, used.id))).toHaveLength(1);
    const [chosen] = await db.select().from(videoTransitionTakes).where(eq(videoTransitionTakes.id, chosenId));
    const [spare] = await db.select().from(videoTransitionTakes).where(eq(videoTransitionTakes.id, spareId));
    expect(chosen!.resultObjectKey).not.toBeNull();
    expect(spare).toMatchObject({ resultObjectKey: null, error: expect.stringContaining("nobody picked it") });
    expect(deleted).toContain(`${companyId}/take-${spareId}.mp4`);
  });
});
