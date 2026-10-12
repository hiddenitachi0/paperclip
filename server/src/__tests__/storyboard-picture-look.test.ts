import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createDb, companies, pluginConfig, pluginState, plugins, videoShots } from "@paperclipai/db";
import { assemblePrompt as pluginAssemblePrompt } from "../../../packages/plugins/media-studio/src/look-prompt.js";
import { parseSogniVideoCatalog, SogniCatalog, SOGNI_OFFLINE_VIDEO_MODELS } from "../../../packages/plugins/media-studio/src/sogni-catalog.js";
import { assemblePrompt as serverAssemblePrompt } from "../services/media-studio-look-prompt.ts";
import { SogniImageProvider } from "../services/image-provider-clients.ts";
import {
  effectiveLookId,
  loadStoryboardLooks,
  normalizeStoryboardLook,
  resolveStoryboardPictureTarget,
  sogniEditModelOrDefault,
  sogniStepModel,
  storyboardPrompt,
  storyboardReferences,
  type StoryboardLook,
} from "../services/storyboard-picture-look.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.ts";
import { videoStorylineStillsService } from "../services/video-storyline-stills.ts";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.ts";

/**
 * Storyboard pictures with a picture service, model and Media Studio look
 * (step 2's "Pictures" settings), plus Sogni's video model catalogue for the
 * Storylines video model picker. No real Fal/Sogni call is made anywhere here.
 */

function look(over: Partial<StoryboardLook> = {}): StoryboardLook {
  return {
    id: "look-1",
    name: "Hero",
    style: "warm cinematic film still",
    model: null,
    provider: null,
    seed: null,
    referenceFileIds: [],
    referenceRoles: [],
    sheet: {},
    loras: [],
    guidance: null,
    negativePrompt: null,
    safeContentFilter: true,
    ...over,
  };
}

describe("what the next storyboard picture is made with", () => {
  it("defaults to Fal.ai, its default model, no look", () => {
    expect(resolveStoryboardPictureTarget({}, null, [])).toEqual({ providerId: "fal", model: null, look: null, lookId: null });
  });

  it("uses the storyline's service and model", () => {
    expect(resolveStoryboardPictureTarget({ providerId: "sogni", model: "z_image_turbo_bf16" }, null, [])).toMatchObject({ providerId: "sogni", model: "z_image_turbo_bf16" });
  });

  it("a look brings its own service and model when the storyline names none", () => {
    const sogniLook = look({ provider: "sogni", model: "dark_beast_z_image_turbo_v9_bf16" });
    expect(resolveStoryboardPictureTarget({ lookId: "look-1" }, null, [sogniLook])).toMatchObject({ providerId: "sogni", model: "dark_beast_z_image_turbo_v9_bf16", look: sogniLook });
    // A look's model on another service is not used.
    expect(resolveStoryboardPictureTarget({ providerId: "fal", lookId: "look-1" }, null, [sogniLook])).toMatchObject({ providerId: "fal", model: null });
  });

  it("the shot's own look wins; 'none' turns the look off for that shot", () => {
    const a = look({ id: "a" });
    const b = look({ id: "b" });
    expect(effectiveLookId({ lookId: "a" }, null)).toBe("a");
    expect(effectiveLookId({ lookId: "a" }, "b")).toBe("b");
    expect(effectiveLookId({ lookId: "a" }, "none")).toBeNull();
    expect(resolveStoryboardPictureTarget({ lookId: "a" }, "b", [a, b]).look?.id).toBe("b");
    expect(resolveStoryboardPictureTarget({ lookId: "a" }, "none", [a, b]).look).toBeNull();
  });

  it("a deleted look is reported, not silently dropped", () => {
    expect(resolveStoryboardPictureTarget({ lookId: "gone" }, null, [])).toMatchObject({ lookId: "gone", look: null });
  });

  it("sends the look's pictures first with their roles, then the shot's and the storyline's, at most 4, once each", () => {
    const withRefs = look({ referenceFileIds: ["f1", "f2"], referenceRoles: ["face", "outfit"] });
    expect(storyboardReferences(withRefs, ["s1", "f1"], ["c1", "c2"], 4)).toEqual({ ids: ["f1", "f2", "s1", "c1"], roles: ["face", "outfit", "other", "other"] });
    expect(storyboardReferences(null, ["s1"], ["c1"], 4)).toEqual({ ids: ["s1", "c1"], roles: ["other", "other"] });
  });

  it("builds the look's prompt exactly like the plugin does", () => {
    const sheetLook = look({ sheet: { hair: "short red hair", outfit: "green raincoat", setting: "harbour town", lighting: "overcast", avoid: "text" } });
    for (const service of ["fal", "sogni"] as const) {
      for (const request of ["A woman walks along the pier", "A woman in a red dress on the beach at sunset"]) {
        const input = { request, style: sheetLook.style, sheet: sheetLook.sheet, roles: ["face", "other"] as const, service };
        expect(serverAssemblePrompt({ ...input, roles: [...input.roles] })).toEqual(pluginAssemblePrompt({ ...input, roles: [...input.roles] }));
      }
    }
    const prompt = storyboardPrompt("A woman walks along the pier", sheetLook, ["face"], "fal");
    expect(prompt).toContain("Style: warm cinematic film still");
    expect(prompt).toContain("Hair: short red hair.");
    expect(storyboardPrompt("Plain", null, [], "fal")).toBe("Plain");
  });

  it("keeps the plugin's look rules: content filter off only when saved off by someone", () => {
    expect(normalizeStoryboardLook({ id: "x", name: "X", style: "", referenceFileIds: [], safeContentFilter: false })?.safeContentFilter).toBe(true);
    expect(normalizeStoryboardLook({ id: "x", name: "X", style: "", referenceFileIds: [], safeContentFilter: false, contentFilterOffBy: "user-1" })?.safeContentFilter).toBe(false);
    expect(normalizeStoryboardLook({ id: "x", name: "X" })).toBeNull();
  });

  it("names Sogni models the way its workflow API expects", () => {
    expect(sogniStepModel("z_image_turbo_bf16", "generate_image")).toBe("z-turbo");
    expect(sogniStepModel("some_other_model_v1", "generate_image")).toBe("some_other_model_v1");
    expect(sogniEditModelOrDefault("qwen_image_edit_2511_fp8")).toBe("qwen");
    expect(sogniEditModelOrDefault("z_image_turbo_bf16")).toBe("qwen-lightning");
    // Sogni's v0.3 alpha has no tool key; it is sent by its catalog id.
    expect(sogniEditModelOrDefault("krea2_identity_edit_sogni_v0_3_alpha")).toBe("krea2_identity_edit_sogni_v0_3_alpha");
    expect(sogniEditModelOrDefault(null)).toBe("qwen-lightning");
  });
});

// ─── The server's Sogni picture client (stubbed HTTP) ──────────────────────

function sogniStub(opts: { statuses?: string[] } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const statuses = [...(opts.statuses ?? ["running", "completed"])];
  const apiFetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/creative-agent/workflows") && init?.method === "POST") {
      return new Response(JSON.stringify({ data: { workflow: { workflowId: "wf-1", status: "queued" } } }), { status: 201 });
    }
    if (url.includes("/v1/creative-agent/workflows/wf-1")) {
      const status = statuses.shift() ?? "completed";
      return new Response(
        JSON.stringify({ data: { workflow: { status, actualCost: 3, steps: status === "completed" ? [{ artifacts: [{ url: "https://media.sogni.ai/out.png" }] }] : [] } } }),
        { status: 200 },
      );
    }
    if (url.includes("/v2/image/uploadUrl")) return new Response(JSON.stringify({ data: { url: "https://bucket.s3-accelerate.amazonaws.com/up", fields: { key: "k" } } }));
    if (url.includes("/v2/image/downloadUrl")) return new Response(JSON.stringify({ data: { downloadUrl: "https://bucket.s3-accelerate.amazonaws.com/ref.png" } }));
    return new Response("{}", { status: 404 });
  };
  const transfers: string[] = [];
  const transferFetch = async (url: string, init?: RequestInit) => {
    transfers.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST") return new Response(null, { status: 204 });
    return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });
  };
  return { calls, transfers, apiFetch, transferFetch };
}

describe("SogniImageProvider (server copy)", () => {
  it("makes a text-only picture with the look's LoRAs, seed and filter setting, and reports credits", async () => {
    const stub = sogniStub();
    const provider = new SogniImageProvider({ apiKey: "k", apiFetch: stub.apiFetch, transferFetch: stub.transferFetch, sleep: async () => {}, pollIntervalMs: 1 });
    const result = await provider.generate({ prompt: "A pier", model: "z-turbo", loras: [{ id: "lora-a", strength: 0.7 }], seed: 42, safeContentFilter: false });
    const start = JSON.parse(String(stub.calls.find((c) => c.init?.method === "POST")!.init!.body));
    expect(start.safe_content_filter).toBe(false);
    expect(start.input.steps[0]).toMatchObject({ toolName: "generate_image", arguments: { prompt: "A pier", model: "z-turbo", seed: 42, loras: ["lora-a"], loraStrengths: [0.7] } });
    expect(result).toMatchObject({ provider: "sogni", model: "z-turbo", contentType: "image/png", sogniCredits: 3 });
    expect(result.imageDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("uploads reference pictures to Sogni's storage and uses edit_image", async () => {
    const stub = sogniStub();
    const provider = new SogniImageProvider({ apiKey: "k", apiFetch: stub.apiFetch, transferFetch: stub.transferFetch, sleep: async () => {}, pollIntervalMs: 1 });
    await provider.generate({ prompt: "Same person", model: "qwen-lightning", referenceImages: ["data:image/png;base64,iVBORw0KGgo="] });
    const start = JSON.parse(String(stub.calls.find((c) => c.url.endsWith("/workflows") && c.init?.method === "POST")!.init!.body));
    expect(start.input.steps[0]).toMatchObject({ toolName: "edit_image", arguments: { sourceImageIndex: -1, model: "qwen-lightning" } });
    expect(start.media_references).toEqual([{ kind: "image", url: "https://bucket.s3-accelerate.amazonaws.com/ref.png" }]);
    expect(stub.transfers[0]).toBe("POST https://bucket.s3-accelerate.amazonaws.com/up");
  });

  it("explains a content-filter stop in plain words", async () => {
    const stub = sogniStub({ statuses: ["waiting_for_user"] });
    const apiFetch = async (url: string, init?: RequestInit) => {
      if (url.includes("/workflows/wf-1") && !url.endsWith("/cancel")) {
        return new Response(JSON.stringify({ data: { workflow: { status: "waiting_for_user", waitingReason: "safety_review_required" } } }));
      }
      return stub.apiFetch(url, init);
    };
    const provider = new SogniImageProvider({ apiKey: "k", apiFetch, transferFetch: stub.transferFetch, sleep: async () => {}, pollIntervalMs: 1 });
    await expect(provider.generate({ prompt: "x" })).rejects.toThrow(/content filter stopped this picture/);
  });
});

// ─── Sogni's video model catalogue (Storylines video model picker) ─────────

const VIDEO_CATALOG = {
  status: "ok",
  data: {
    updatedAt: "2026-10-08T21:51:12.418Z",
    models: [
      { id: "flashvsr_v1.1_tiny_long_bf16", name: "FlashVSR v1.1 Video Upscale", mediaType: "video", tags: [], workerCounts: { fast: 62 }, parameters: { task: "video-upscale", requiresReferenceVideo: true } },
      { id: "ltx23-22b-fp8_v2v_distilled", name: "LTX V2V", mediaType: "video", tags: [], workerCounts: { fast: 3 }, parameters: { frames: { min: 25, max: 505 }, fps: { default: 24 } } },
      {
        id: "seedance-2-0-fast",
        name: "Seedance 2.0 Fast",
        mediaType: "video",
        tags: ["fast", "popular", "premium"],
        workerCounts: { fast: 9 },
        parameters: { durations: [4, 5, 6, 10], acceptInputImage: true, referenceLimits: { images: 9 }, supports: { textToVideo: true, imageToVideo: true }, costPerBaseRenderInUSD: "0.0069", premiumOnly: true },
      },
      { id: "ltx23-22b-fp8_i2v_distilled", name: "LTX-2.3 22B I2V Distilled", mediaType: "video", tags: ["popular"], workerCounts: { fast: 58 }, parameters: { frames: { min: 25, max: 505 }, fps: { min: 1, max: 60, default: 24 }, costPerBaseRenderInUSD: "0.194" } },
      { id: "wan_v2.2-14b-fp8_t2v_lightx2v", name: "WAN2.2 t2v", mediaType: "video", tags: [], workerCounts: { fast: 0 }, parameters: { frames: { min: 17, max: 161 }, fps: { allowed: [16, 32], default: 16 } } },
      { id: "minimax-h3-ref2va-fp8_r2v_turbo", name: "MiniMax H3 Turbo Reference", mediaType: "video", tags: [], workerCounts: { fast: 1 }, parameters: { inputMode: "multi-reference", frames: { min: 124, max: 362 }, fps: { allowed: [24], default: 24 }, referenceLimits: { images: 9 } } },
    ],
  },
};

describe("Sogni video model catalogue", () => {
  it("keeps only models that make a clip from a description, with lengths, pictures and price", () => {
    const parsed = parseSogniVideoCatalog(VIDEO_CATALOG)!;
    const byId = Object.fromEntries(parsed.models.map((m) => [m.id, m]));
    expect(Object.keys(byId).sort()).toEqual(["ltx23-22b-fp8_i2v_distilled", "minimax-h3-ref2va-fp8_r2v_turbo", "seedance-2-0-fast", "wan_v2.2-14b-fp8_t2v_lightx2v"]);
    expect(byId["seedance-2-0-fast"]).toMatchObject({ clipSeconds: { values: [4, 5, 6, 10] }, takesStartImage: true, needsStartImage: false, maxReferences: 9, premium: true, usdPerBaseRender: 0.0069 });
    expect(byId["ltx23-22b-fp8_i2v_distilled"]).toMatchObject({ clipSeconds: { min: 2, max: 21 }, takesStartImage: true, needsStartImage: true, maxReferences: 0 });
    expect(byId["wan_v2.2-14b-fp8_t2v_lightx2v"]).toMatchObject({ clipSeconds: { min: 2, max: 10 }, takesStartImage: false, workersOnline: 0 });
    expect(byId["minimax-h3-ref2va-fp8_r2v_turbo"]).toMatchObject({ maxReferences: 9, clipSeconds: { min: 6, max: 15 } });
    // Models with no workers online go last.
    expect(parsed.models.at(-1)!.id).toBe("wan_v2.2-14b-fp8_t2v_lightx2v");
  });

  it("reads the public catalogue once per 10 minutes and falls back to the dated built-in list", async () => {
    let now = 0;
    let reads = 0;
    let fail = false;
    const catalog = new SogniCatalog(
      async (url) => {
        expect(url).toBe("https://api.sogni.ai/v1/model-catalog?mediaType=video&include=parameters");
        reads += 1;
        if (fail) throw new Error("down");
        return new Response(JSON.stringify(VIDEO_CATALOG));
      },
      { now: () => now },
    );
    expect((await catalog.videoModels()).live).toBe(true);
    await catalog.videoModels();
    expect(reads).toBe(1);

    const offline = new SogniCatalog(async () => {
      throw new Error("down");
    });
    const list = await offline.videoModels();
    expect(list).toMatchObject({ live: false, updatedAt: "2026-10-08" });
    expect(list.models).toBe(SOGNI_OFFLINE_VIDEO_MODELS);
    fail = true;
    now = 11 * 60 * 1000;
    // Sogni down after a good read: the last list is kept.
    expect((await catalog.videoModels()).live).toBe(true);
  });
});

// ─── With a database: looks from the plugin's state, settings, summary ─────

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping storyboard picture DB tests: ${support.reason ?? "unsupported environment"}`);

const ACTOR: VideoStorylineActor = { actorType: "user", actorId: "user-1", agentId: null };

d("storyboard picture settings (database)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let pluginId = "";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("storyboard-picture-look");
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
    const [row] = await db
      .insert(plugins)
      .values({ pluginKey: "paperclip.media-studio", packageName: "@paperclipai/plugin-media-studio", version: "1.0.0", manifestJson: manifest, status: "ready" })
      .returning();
    pluginId = row!.id;
    // Only a Sogni key is set up.
    await db.insert(pluginConfig).values({ pluginId, configJson: { sogniKeySecretRef: "secret-ref" } });
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pictures Co", issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const storylines = videoStorylineService(db);
    const storyline = await storylines.createStoryline(
      companyId,
      { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: 10_000, characterReferenceAssetIds: [], defaultTransition: "cut", defaultTransitionDurationMs: 500, musicAssetId: null, musicSourceKey: null, musicVolumeDb: -18 },
      ACTOR,
    );
    const scene = await storylines.createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
    const shot = await storylines.createShot(companyId, storyline.id, { sceneId: scene.id, orderIndex: 0, prompt: "A shot", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null }, ACTOR);
    return { companyId, storylineId: storyline.id, shotId: shot.id };
  }

  async function saveLooks(companyId: string, looks: unknown[]) {
    await db.insert(pluginState).values({ pluginId, scopeKind: "company", scopeId: companyId, namespace: "default", stateKey: "looks", valueJson: looks });
  }

  it("reads a company's looks from the plugin's state, never another company's", async () => {
    const a = await seed();
    const b = await seed();
    await saveLooks(a.companyId, [{ id: "look-a", name: "A", style: "noir", referenceFileIds: [], provider: "sogni", loras: [{ id: "l1", strength: 0.5 }] }]);
    await saveLooks(b.companyId, [{ id: "look-b", name: "B", style: "pastel", referenceFileIds: [] }]);
    expect((await loadStoryboardLooks(db, pluginId, a.companyId)).map((l) => l.id)).toEqual(["look-a"]);
    expect((await loadStoryboardLooks(db, pluginId, b.companyId)).map((l) => l.id)).toEqual(["look-b"]);
    expect(await loadStoryboardLooks(db, null, a.companyId)).toEqual([]);
  });

  it("saves picture settings and a shot's own look without clearing its picture", async () => {
    const { companyId, storylineId, shotId } = await seed();
    const storylines = videoStorylineService(db);
    const updated = await storylines.updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni", model: "z_image_turbo_bf16", lookId: "look-x" } }, ACTOR);
    expect(updated.pictureSettings).toEqual({ providerId: "sogni", model: "z_image_turbo_bf16", lookId: "look-x" });
    await db.update(videoShots).set({ stillObjectKey: "stills/a.jpg", stillProvider: "local", stillContentType: "image/jpeg", storyboardStatus: "approved" }).where(eq(videoShots.id, shotId));
    const shot = await storylines.updateShot(companyId, storylineId, shotId, { pictureLookId: "none" }, ACTOR);
    expect(shot).toMatchObject({ pictureLookId: "none", stillObjectKey: "stills/a.jpg", storyboardStatus: "approved" });
  });

  it("the storyboard summary says which services have a key and what the next picture uses", async () => {
    const { companyId, storylineId } = await seed();
    await saveLooks(companyId, [{ id: "look-s", name: "S", style: "noir", referenceFileIds: [], provider: "sogni", model: "dark_beast_z_image_turbo_v9_bf16" }]);
    await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { lookId: "look-s" } }, ACTOR);
    const summary = await videoStorylineStillsService(db).getStoryboardSummary(companyId, storylineId);
    expect(summary.pictureServices).toEqual({ fal: false, sogni: true });
    expect(summary.picture).toEqual({ providerId: "sogni", model: "dark_beast_z_image_turbo_v9_bf16", lookId: "look-s", costPerPictureCents: 1 });
  });

  it("refuses before any paid call when the picked look was deleted or the service has no key", async () => {
    const { companyId, storylineId, shotId } = await seed();
    const stills = videoStorylineStillsService(db);
    await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { lookId: "deleted-look" } }, ACTOR);
    await expect(stills.generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("no longer exists") });

    await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "fal" } }, ACTOR);
    await expect(stills.generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("no Fal.ai API key") });
    // Nothing was marked as being paid for.
    const [row] = await db.select().from(videoShots).where(eq(videoShots.id, shotId));
    expect(row!.stillEstimatedCostCents).toBeNull();
  });
});
