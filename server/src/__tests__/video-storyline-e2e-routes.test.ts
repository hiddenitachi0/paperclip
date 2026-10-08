import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  assets,
  companies,
  createDb,
  issueAttachments,
  createRequestScopedDb,
  pluginConfig,
  plugins,
  runInCompanyScopeBypass,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * The whole movie-generator flow over REAL HTTP requests through the REAL
 * request-scoped db wiring -- exactly how production builds it:
 * videoStorylineRoutes(rawDb) wraps every service in createRequestScopedDb
 * and every route in companyScopeFromParam (a reserved Postgres connection
 * per request), and the scheduler ticks run on createRequestScopedDb inside
 * runInCompanyScopeBypass (index.ts). Every older storyline test called the
 * services with the raw pooled db, which is why "POST .../shots ->
 * db.transaction() is not supported through the request-scoped proxy" (500
 * on every shot create in prod) slipped through.
 *
 * Nothing here reaches a paid provider: the Fal video/image clients, Fal's
 * pricing API and Anthropic are stubbed, and storage is in memory. ffmpeg
 * is real (tiny generated clips) when the host has it.
 */

// ─── In-memory storage ─────────────────────────────────────────────────────
const storedObjects = vi.hoisted(() => new Map<string, { body: Buffer; contentType: string }>());
vi.mock("../storage/index.ts", () => ({
  getStorageService: () => ({
    provider: "local_disk",
    putFile: async (input: { companyId: string; namespace: string; originalFilename: string | null; contentType: string; body: Buffer }) => {
      const objectKey = `${input.companyId}/${input.namespace}/${Math.random().toString(36).slice(2)}-${input.originalFilename ?? "file"}`;
      storedObjects.set(objectKey, { body: input.body, contentType: input.contentType });
      return {
        provider: "local_disk",
        objectKey,
        contentType: input.contentType,
        byteSize: input.body.byteLength,
        sha256: "test",
        originalFilename: input.originalFilename,
      };
    },
    getObject: async (_companyId: string, objectKey: string) => {
      const found = storedObjects.get(objectKey);
      if (!found) throw new Error(`no such object ${objectKey}`);
      return { stream: Readable.from(found.body), contentType: found.contentType, contentLength: found.body.byteLength };
    },
  }),
}));

// ─── Stub providers (never a real network call) ───────────────────────────
const media = vi.hoisted(() => ({
  clips: new Map<number, string>(),
  stillDataUrl: "",
  videoStarts: [] as Array<{ prompt: string; durationSeconds?: number; startImage?: string; model?: string; referenceImages?: string[] }>,
  imageCalls: [] as Array<{ prompt: string; referenceImages?: string[] }>,
}));
vi.mock("../services/video-provider-clients.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/video-provider-clients.ts")>();
  class StubVideoProvider {
    readonly name: string;
    constructor(name: string) {
      this.name = name;
    }
    async start(input: { prompt: string; durationSeconds?: number; startImage?: string; model?: string; referenceImages?: string[] }) {
      media.videoStarts.push(input);
      return { externalId: `job-${media.videoStarts.length}`, model: input.model ?? "fal-ai/kling-video/v1.6/standard/text-to-video", provider: this.name };
    }
    async poll(handle: { externalId: string }) {
      const start = media.videoStarts[Number(handle.externalId.replace("job-", "")) - 1]!;
      const clip = media.clips.get(start.durationSeconds ?? 5) ?? media.clips.get(5)!;
      return { status: "done" as const, result: { contentType: "video/mp4", dataUrl: clip } };
    }
    async cancel() {}
  }
  return {
    ...actual,
    FalVideoProvider: class extends StubVideoProvider {
      constructor() {
        super("fal");
      }
    },
    SogniVideoProvider: class extends StubVideoProvider {
      constructor() {
        super("sogni");
      }
    },
  };
});
vi.mock("../services/image-provider-clients.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/image-provider-clients.ts")>();
  return {
    ...actual,
    FalImageProvider: class {
      readonly name = "fal";
      async generate(input: { prompt: string; referenceImages?: string[] }) {
        media.imageCalls.push(input);
        return { provider: "fal", model: "fal-ai/flux/schnell", contentType: "image/jpeg", imageDataUrl: media.stillDataUrl };
      }
    },
  };
});
vi.mock("../services/fal-pricing.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/fal-pricing.ts")>();
  return { ...actual, falPricingClient: () => ({ priceCall: async () => null }) };
});

const anthropicCreate = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  const RealDefault = (actual as { default: typeof actual.default }).default;
  class FakeAnthropic {
    static AuthenticationError = RealDefault.AuthenticationError;
    static PermissionDeniedError = RealDefault.PermissionDeniedError;
    static RateLimitError = RealDefault.RateLimitError;
    static APIConnectionError = RealDefault.APIConnectionError;
    static APIError = RealDefault.APIError;
    messages = { create: anthropicCreate };
    constructor(_opts: unknown) {}
  }
  return { ...actual, default: FakeAnthropic };
});

const { errorHandler } = await import("../middleware/index.ts");
const { videoStorylineRoutes } = await import("../routes/video-storylines.ts");
const { videoStorylineRenderService } = await import("../services/video-storyline-render.ts");
const { videoStorylineStitchService } = await import("../services/video-storyline-stitch.ts");
const { secretService } = await import("../services/secrets.ts");
const { checkFfmpegAvailable } = await import("../services/video-ffmpeg.ts");

const support = await getEmbeddedPostgresTestSupport();
const ffmpegAvailable = await checkFfmpegAvailable(true);
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping video storyline end-to-end route tests: ${support.reason ?? "unsupported environment"}`);
}

function aiText(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function makeClipDataUrl(dir: string, seconds: number): string {
  const out = path.join(dir, `clip-${seconds}.mp4`);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=160x120:rate=10:duration=${seconds}`,
    "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", out,
  ]);
  return `data:video/mp4;base64,${readFileSync(out).toString("base64")}`;
}

function makeStillDataUrl(dir: string): string {
  const out = path.join(dir, "still.jpg");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", out]);
  return `data:image/jpeg;base64,${readFileSync(out).toString("base64")}`;
}

d("video storylines end to end through the real request-scoped db", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  let mediaDir = "";
  const secretsDir = path.join(os.tmpdir(), `paperclip-video-e2e-secrets-${randomUUID()}`);
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const companyId = randomUUID();
  let base = "";

  beforeAll(async () => {
    mkdirSync(secretsDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsDir, "master.key");
    process.env.ANTHROPIC_API_KEY = "test-key";
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-e2e-routes");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    // The scheduler's bypass pool needs this role, same as in production.
    await db.execute(sql`GRANT paperclip_app_bypass TO CURRENT_USER`);

    await db.insert(companies).values({
      id: companyId,
      name: "Film Co",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const secret = await secretService(db).create(companyId, { name: `fal-${randomUUID()}`, provider: "local_encrypted", value: "fal-test-key" });
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
    const [plugin] = await db
      .insert(plugins)
      .values({ pluginKey: "paperclip.media-studio", packageName: "@paperclipai/plugin-media-studio", version: "1.0.0", manifestJson: manifest, status: "ready" })
      .returning();
    await db.insert(pluginConfig).values({ pluginId: plugin!.id, configJson: { falKeySecretRef: secret.id } });

    if (ffmpegAvailable) {
      mediaDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-video-e2e-media-"));
      media.clips.set(5, makeClipDataUrl(mediaDir, 5));
      media.clips.set(10, makeClipDataUrl(mediaDir, 10));
      media.stillDataUrl = makeStillDataUrl(mediaDir);
    } else {
      media.stillDataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==";
    }

    app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "board" } as typeof req.actor;
      next();
    });
    app.use("/api", videoStorylineRoutes(db));
    app.use(errorHandler);
    base = `/api/companies/${companyId}/video-storylines`;
  }, 120_000);

  afterAll(async () => {
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    await stopDb?.();
    rmSync(secretsDir, { recursive: true, force: true });
    if (mediaDir) rmSync(mediaDir, { recursive: true, force: true });
  });

  /** One scheduler tick, wired exactly like index.ts: request-scoped proxy inside runInCompanyScopeBypass. */
  async function renderTick() {
    const service = videoStorylineRenderService(createRequestScopedDb(db));
    return runInCompanyScopeBypass(db, { reason: "test render tick", actorType: "scheduler", route: "heartbeat-scheduler:videoStorylineRender" }, () => service.tick());
  }
  async function stitchTick() {
    const service = videoStorylineStitchService(createRequestScopedDb(db));
    return runInCompanyScopeBypass(db, { reason: "test stitch tick", actorType: "scheduler", route: "heartbeat-scheduler:videoStorylineStitch" }, () => service.tick());
  }

  async function listShots(storylineId: string) {
    const res = await request(app).get(`${base}/${storylineId}/shots`);
    expect(res.status).toBe(200);
    return res.body as Array<{ id: string; sceneId: string; orderIndex: number; prompt: string; durationSeconds: number }>;
  }

  let storylineId = "";
  let sceneA = "";
  let sceneB = "";

  it("turns the feature on and creates a storyline with two scenes", async () => {
    expect((await request(app).patch(`${base}/settings`).send({ enabled: true })).status).toBe(200);
    expect((await request(app).patch(`${base}/settings/advanced`).send({ enabled: true })).status).toBe(200);
    const settings = await request(app).get(`${base}/settings`);
    expect(settings.body).toEqual({ enabled: true, ffmpegAvailable });

    const created = await request(app).post(base).send({ title: "Lighthouse", providerId: "fal" });
    expect(created.status).toBe(201);
    storylineId = created.body.id;

    const a = await request(app).post(`${base}/${storylineId}/scenes`).send({ title: "Storm", orderIndex: 0 });
    const b = await request(app).post(`${base}/${storylineId}/scenes`).send({ title: "Morning", orderIndex: 1 });
    expect([a.status, b.status]).toEqual([201, 201]);
    sceneA = a.body.id;
    sceneB = b.body.id;
  });

  it("adds shots over HTTP (the request-scoped transaction that used to 500) in scene order", async () => {
    const first = await request(app).post(`${base}/${storylineId}/shots`).send({ sceneId: sceneB, orderIndex: 0, prompt: "B1 sunrise over the sea", durationSeconds: 5 });
    expect(first.status).toBe(201);
    const second = await request(app).post(`${base}/${storylineId}/shots`).send({ sceneId: sceneA, orderIndex: 0, prompt: "A1 lighthouse in the storm", durationSeconds: 5 });
    expect(second.status).toBe(201);
    const third = await request(app).post(`${base}/${storylineId}/shots`).send({ sceneId: sceneA, orderIndex: 1, prompt: "A2 keeper wipes the lens", durationSeconds: 7 });
    expect(third.status).toBe(201);

    const shots = await listShots(storylineId);
    expect(shots.map((s) => [s.prompt.slice(0, 2), s.orderIndex])).toEqual([["A1", 0], ["A2", 1], ["B1", 2]]);
  });

  it("updates, reorders, moves between scenes and deletes shots, keeping positions 0..n-1", async () => {
    let shots = await listShots(storylineId);
    const a2 = shots.find((s) => s.prompt.startsWith("A2"))!;
    const edited = await request(app).patch(`${base}/${storylineId}/shots/${a2.id}`).send({ prompt: "A2 keeper wipes the brass lens" });
    expect(edited.status).toBe(200);
    expect(edited.body.prompt).toBe("A2 keeper wipes the brass lens");

    // Move A2 to the front of the storyline.
    const moved = await request(app).patch(`${base}/${storylineId}/shots/${a2.id}`).send({ orderIndex: 0 });
    expect(moved.status).toBe(200);
    shots = await listShots(storylineId);
    expect(shots.map((s) => s.prompt.slice(0, 2))).toEqual(["A2", "A1", "B1"]);

    // Move B1 into scene A (lands at the end of scene A).
    const b1 = shots.find((s) => s.prompt.startsWith("B1"))!;
    expect((await request(app).patch(`${base}/${storylineId}/shots/${b1.id}`).send({ sceneId: sceneA })).status).toBe(200);
    shots = await listShots(storylineId);
    expect(shots.map((s) => [s.prompt.slice(0, 2), s.sceneId === sceneA, s.orderIndex])).toEqual([["A2", true, 0], ["A1", true, 1], ["B1", true, 2]]);

    // Move it back, then delete it: positions close up again.
    expect((await request(app).patch(`${base}/${storylineId}/shots/${b1.id}`).send({ sceneId: sceneB })).status).toBe(200);
    const extra = await request(app).post(`${base}/${storylineId}/shots`).send({ sceneId: sceneA, orderIndex: 0, prompt: "XX throwaway" });
    expect(extra.status).toBe(201);
    expect((await request(app).delete(`${base}/${storylineId}/shots/${extra.body.id}`)).status).toBe(204);
    shots = await listShots(storylineId);
    expect(shots.map((s) => [s.prompt.slice(0, 2), s.orderIndex])).toEqual([["A2", 0], ["A1", 1], ["B1", 2]]);
  });

  it("serves the script-writer instructions", async () => {
    const res = await request(app).get(`${base}/script-instructions`);
    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain("Return **JSON only**");
    expect(res.body.markdown).toContain("5 or 10");
    expect(res.body.example.scenes.length).toBeGreaterThan(0);
  });

  it("refuses a broken script with plain per-item messages", async () => {
    const res = await request(app)
      .post(`${base}/${storylineId}/import`)
      .send({
        mode: "append",
        script: {
          scenes: [
            { scene_title: "ok", shots: [{ prompt: "fine" }] },
            {
              scene_title: "bad",
              shots: [{ prompt: "fine" }, { prompt: "x" }, { prompt: "y".repeat(4001), duration_seconds: 99, transition_in: "wipe", camera_note: "typo" }],
            },
          ],
        },
      });
    expect(res.status).toBe(422);
    expect(res.body.details.errors).toEqual(
      expect.arrayContaining([
        'Scene 2, shot 3: unknown field "camera_note" (allowed: prompt, camera_notes, duration_seconds, transition_in).',
        "Scene 2, shot 3: prompt is longer than 4,000 characters.",
        "Scene 2, shot 3: duration_seconds must be between 1 and 60.",
        "Scene 2, shot 3: transition_in must be one of cut, fade, dissolve.",
      ]),
    );
    expect(res.body.error).toMatch(/^The script has 4 problems/);
  });

  it("imports a script (dry run first, then append) in one go", async () => {
    const script = {
      title: "ignored for append",
      characters: { Ada: "a woman in her 60s with silver hair and a yellow scarf" },
      scenes: [
        {
          scene_title: "Night watch",
          scene_notes: "Inside the lamp room.",
          shots: [
            { prompt: "C1 Ada, a woman in her 60s with silver hair and a yellow scarf, lights a lantern.", camera_notes: "close-up", duration_seconds: 7, transition_in: "fade" },
            { prompt: "C2 the lantern glows in the window.", duration_seconds: 5 },
          ],
        },
      ],
    };
    const dry = await request(app).post(`${base}/${storylineId}/import`).send({ mode: "append", script, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, sceneCount: 1, shotCount: 2, totalSeconds: 12, billedSeconds: 15, characterCount: 1 });
    expect(dry.body.estimatedCostCents).toBe(15 * 50);
    expect(await listShots(storylineId)).toHaveLength(3);

    const real = await request(app).post(`${base}/${storylineId}/import`).send({ mode: "append", script });
    expect(real.status).toBe(200);
    const shots = await listShots(storylineId);
    expect(shots.map((s) => s.prompt.slice(0, 2))).toEqual(["A2", "A1", "B1", "C1", "C2"]);
    expect(shots.map((s) => s.orderIndex)).toEqual([0, 1, 2, 3, 4]);
    const scenes = (await request(app).get(`${base}/${storylineId}/scenes`)).body as Array<{ title: string; notes: string | null }>;
    expect(scenes.at(-1)).toMatchObject({ title: "Night watch" });
    expect(scenes.at(-1)!.notes).toContain("Characters:\n- Ada: a woman in her 60s");
    expect(scenes.at(-1)!.notes).toContain("Inside the lamp room.");
  });

  it("creates a whole new storyline from a script, and lets 'replace' swap it while nothing is paid", async () => {
    const script = { title: "Short film", scenes: [{ scene_title: "One", shots: [{ prompt: "a" }, { prompt: "b" }] }] };
    const created = await request(app).post(`${base}/import`).send({ script, budgetCapCents: 5000 });
    expect(created.status).toBe(201);
    expect(created.body.storyline).toMatchObject({ title: "Short film", budgetCapCents: 5000 });
    const newId = created.body.storyline.id as string;
    expect(await listShots(newId)).toHaveLength(2);

    const replaced = await request(app)
      .post(`${base}/${newId}/import`)
      .send({ mode: "replace", script: { scenes: [{ scene_title: "Two", shots: [{ prompt: "only one" }] }] } });
    expect(replaced.status).toBe(200);
    const shots = await listShots(newId);
    expect(shots.map((s) => [s.prompt, s.orderIndex])).toEqual([["only one", 0]]);

    const untitled = await request(app).post(`${base}/import`).send({ script: { scenes: [{ scene_title: "x", shots: [{ prompt: "y" }] }] } });
    expect(untitled.status).toBe(400);
    expect(untitled.body.error).toContain("title");
  });

  it("drafts shots with the AI director and approves them into the storyline", async () => {
    anthropicCreate.mockResolvedValueOnce(aiText({ shots: [{ prompt: "D1 gulls circle the tower", cameraNotes: null, durationSeconds: 5, castInView: [] }] }));
    const draft = await request(app).post(`${base}/${storylineId}/director/draft`).send({ sceneId: sceneB, idea: "Gulls at dawn", shotCount: 1 });
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("ready_for_review");
    const approved = await request(app).post(`${base}/${storylineId}/director/runs/${draft.body.id}/approve`).send({});
    expect(approved.status).toBe(200);
    const shots = await listShots(storylineId);
    expect(shots.map((s) => s.prompt.slice(0, 2))).toEqual(["A2", "A1", "B1", "D1", "C1", "C2"]);
  });

  it("runs a director review and applies its proposal", async () => {
    const shots = await listShots(storylineId);
    const target = shots.find((s) => s.prompt.startsWith("B1"))!;
    anthropicCreate
      .mockResolvedValueOnce(aiText({ summary: "Mostly fine.", shotFindings: [{ shotId: target.id, issues: ["Time of day unclear"] }], contradictions: [], continuityRisks: [] }))
      .mockResolvedValueOnce(aiText({ doneAsking: true, questions: [] }))
      .mockResolvedValueOnce(aiText({ proposals: [{ shotId: target.id, proposedPrompt: "B1 golden sunrise over a calm sea", proposedCameraNotes: "wide", proposedDurationSeconds: 5, proposedTransitionIn: null, rationale: "time of day" }] }));
    const review = await request(app).post(`${base}/${storylineId}/director/review`).send({});
    expect(review.status).toBe(201);
    const accepted = await request(app).post(`${base}/${storylineId}/director/proposals/${target.id}/accept`).send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body.prompt).toBe("B1 golden sunrise over a calm sea");
  });

  it("explains a failing AI director in plain words instead of a 500", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropicCreate.mockRejectedValueOnce(new (Anthropic as unknown as { RateLimitError: new (...args: unknown[]) => Error }).RateLimitError(429, { error: { message: "slow down" } }, "slow down", new Headers()));
    const res = await request(app).post(`${base}/${storylineId}/director/review`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("busy");
  });

  it("estimates the cost with the clip lengths Fal really renders", async () => {
    const res = await request(app).post(`${base}/${storylineId}/estimate`).send({});
    expect(res.status).toBe(200);
    // A2 7s -> 10s, C1 7s -> 10s, the other four 5s each.
    expect(res.body.estimatedTotalSeconds).toBe(40);
    expect(res.body.estimatedTotalCents).toBe(40 * 50);
  });

  it.skipIf(!ffmpegAvailable)("renders a still-frame preview of one shot (stub provider)", async () => {
    const shots = await listShots(storylineId);
    const res = await request(app).post(`${base}/${storylineId}/shots/${shots[0]!.id}/preview`).send({});
    expect(res.status).toBe(200);
    expect(res.body.previewObjectKey).toBeTruthy();
    // Kling refuses 1-second clips; the preview asks for the shortest length it accepts.
    expect(media.videoStarts.at(-1)!.durationSeconds).toBe(5);
  });

  it("uses a Look's character picture (a company FILE id, not an asset id) in stills and renders", async () => {
    // What Media Studio's Looks hand the editor: issue_attachments ids.
    const objectKey = `${companyId}/looks/ada.jpg`;
    storedObjects.set(objectKey, { body: Buffer.from(media.stillDataUrl.split(",")[1]!, "base64"), contentType: "image/jpeg" });
    const [asset] = await db
      .insert(assets)
      .values({ companyId, provider: "local_disk", objectKey, contentType: "image/jpeg", byteSize: 10, sha256: "x" })
      .returning();
    const [file] = await db.insert(issueAttachments).values({ companyId, issueId: null, assetId: asset!.id, issueCommentId: null }).returning();
    const res = await request(app).patch(`${base}/${storylineId}`).send({ characterReferenceAssetIds: [file!.id] });
    expect(res.status).toBe(200);
  });

  it("asks for a budget, then renders every approved shot and stitches the film", async () => {
    let shots = await listShots(storylineId);
    // Storyboard: a picture for every shot but one, which is approved on its text alone.
    for (const [index, shot] of shots.entries()) {
      if (index === shots.length - 1) {
        const ok = await request(app).post(`${base}/${storylineId}/shots/${shot.id}/approve`).send({ withoutStill: true });
        expect(ok.status).toBe(200);
        continue;
      }
      const still = await request(app).post(`${base}/${storylineId}/shots/${shot.id}/still`).send({});
      expect(still.status).toBe(200);
      const ok = await request(app).post(`${base}/${storylineId}/shots/${shot.id}/approve`).send({});
      expect(ok.status).toBe(200);
    }
    expect(media.imageCalls.length).toBe(shots.length - 1);
    expect(media.imageCalls.every((call) => call.referenceImages?.length === 1)).toBe(true);

    // A paid-for storyboard means "replace" must now refuse.
    const replace = await request(app).post(`${base}/${storylineId}/import`).send({ mode: "replace", script: { scenes: [{ scene_title: "x", shots: [{ prompt: "y" }] }] } });
    expect(replace.status).toBe(409);
    expect(replace.body.error).toContain("can't be replaced");

    const noBudget = await request(app).post(`${base}/${storylineId}/render/start`).send({});
    expect(noBudget.status).toBe(400);
    expect(noBudget.body.error).toContain("Set a budget cap");

    const tooSmall = await request(app).post(`${base}/${storylineId}/render/start`).send({ confirmBudgetCapCents: 100 });
    expect(tooSmall.status).toBe(422);
    expect(tooSmall.body.error).toContain("Raise the budget cap to at least");

    const startsBefore = media.videoStarts.length;
    const started = await request(app).post(`${base}/${storylineId}/render/start`).send({ confirmBudgetCapCents: 100_000 });
    expect(started.status).toBe(200);
    expect(started.body.status).toBe("rendering");

    if (!ffmpegAvailable) return;
    for (let i = 0; i < 20; i += 1) {
      await renderTick();
      const progress = await request(app).get(`${base}/${storylineId}/progress`);
      if (progress.body.status !== "rendering") break;
    }
    const progress = await request(app).get(`${base}/${storylineId}/progress`);
    expect(progress.body).toMatchObject({ status: "ready_to_stitch", doneShots: 6, failedShots: 0 });
    const renderStarts = media.videoStarts.slice(startsBefore);
    expect(renderStarts).toHaveLength(6);
    // 7-second shots were sent as 10 (what Kling accepts), 5-second ones as 5.
    shots = await listShots(storylineId);
    expect(renderStarts.map((s) => s.durationSeconds)).toEqual(shots.map((s) => (s.durationSeconds === 7 ? 10 : 5)));
    expect(renderStarts.every((s) => s.referenceImages?.length === 1)).toBe(true);
    // Every shot after the first starts from a picture (approved still or the previous clip's last frame).
    expect(renderStarts.slice(1).every((s) => typeof s.startImage === "string" && s.startImage.startsWith("data:image/"))).toBe(true);

    const stitch = await stitchTick();
    expect(stitch).toMatchObject({ failed: 0, blocked: 0 });
    const done = await request(app).get(`${base}/${storylineId}`);
    expect(done.body.errorMessage).toBeNull();
    expect(done.body.status).toBe("done");
    expect(done.body.finalDurationSeconds).toBeGreaterThanOrEqual(39);
    expect(done.body.finalDurationSeconds).toBeLessThanOrEqual(41);

    const film = await request(app).get(`${base}/${storylineId}/final/content`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(film.status).toBe(200);
    expect(film.headers["content-type"]).toBe("video/mp4");
    expect((film.body as Buffer).byteLength).toBeGreaterThan(1000);
  }, 180_000);

  it("gates script transitions behind the advanced setting on both import routes, dry run included (security review)", async () => {
    const plainCompanyId = randomUUID();
    await db.insert(companies).values({
      id: plainCompanyId,
      name: "Plain Co",
      issuePrefix: `P${plainCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const plainBase = `/api/companies/${plainCompanyId}/video-storylines`;
    expect((await request(app).patch(`${plainBase}/settings`).send({ enabled: true })).status).toBe(200);

    const withTransition = { title: "Fades", scenes: [{ scene_title: "One", shots: [{ prompt: "a", transition_in: "fade" }, { prompt: "b" }] }] };
    const plain = { title: "Cuts", scenes: [{ scene_title: "One", shots: [{ prompt: "a" }, { prompt: "b", transition_in: null }] }] };

    // Advanced off + a transition: refused on both routes, dry run or not, with the same plain message shot edits get.
    for (const dryRun of [true, false]) {
      const refused = await request(app).post(`${plainBase}/import`).send({ script: withTransition, dryRun });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toContain("transitions and music are switched off");
    }
    expect((await request(app).get(plainBase)).body).toHaveLength(0);

    // Advanced off, no transitions: fine.
    const created = await request(app).post(`${plainBase}/import`).send({ script: plain });
    expect(created.status).toBe(201);
    const plainStorylineId = created.body.storyline.id as string;
    const appended = await request(app).post(`${plainBase}/${plainStorylineId}/import`).send({ mode: "append", script: plain });
    expect(appended.status).toBe(200);

    for (const dryRun of [true, false]) {
      const refused = await request(app).post(`${plainBase}/${plainStorylineId}/import`).send({ mode: "append", script: withTransition, dryRun });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toContain("transitions and music are switched off");
    }
    const shotsRes = await request(app).get(`${plainBase}/${plainStorylineId}/shots`);
    expect(shotsRes.body).toHaveLength(4);

    // Advanced on: transitions import fine on both routes.
    expect((await request(app).patch(`${plainBase}/settings/advanced`).send({ enabled: true })).status).toBe(200);
    expect((await request(app).post(`${plainBase}/import`).send({ script: withTransition })).status).toBe(201);
    expect((await request(app).post(`${plainBase}/${plainStorylineId}/import`).send({ mode: "append", script: withTransition })).status).toBe(200);
  });
});
