import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1, VideoShotGenerationRecord } from "@paperclipai/shared";
import type { SogniLoraInfo } from "@paperclipai/plugin-sdk/media";
import { activityLog, createDb, companies, pluginConfig, pluginState, plugins, videoShots, videoStorylines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * DUR-4902: every storyboard picture and every clip writes a "How was this
 * made?" record into the activity log, with every field the card lists, and
 * no key material or picture bytes anywhere in it. Every paid call is stubbed.
 */

const KEY = "sk-FAKEKEYFORTESTS1234567890abcdef";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const captured = vi.hoisted(() => ({
  pictures: [] as Array<{ provider: string; input: Record<string, unknown> }>,
  stored: [] as Array<{ originalFilename: string; contentType: string }>,
}));

vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({
    getObject: async (_companyId: string, objectKey: string) => ({ stream: Readable.from([Buffer.from(objectKey)]), contentType: "image/png" }),
    putFile: async (input: { originalFilename: string; contentType: string; body: Buffer }) => {
      captured.stored.push({ originalFilename: input.originalFilename, contentType: input.contentType });
      return { provider: "local", objectKey: `x/${randomUUID()}`, contentType: input.contentType, byteSize: input.body.length, sha256: "0".repeat(64) };
    },
  }),
}));

vi.mock("../services/secrets.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/secrets.js")>();
  return { ...real, secretService: () => ({ resolveSecretValueForVideoRender: async () => "sk-FAKEKEYFORTESTS1234567890abcdef" }) };
});

vi.mock("../services/fal-cost-events.js", () => ({ recordFalCostEvent: async () => ({ costCents: 37 }) }));

vi.mock("../services/image-provider-clients.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/image-provider-clients.js")>();
  class Fake {
    constructor(readonly name: string) {}
    async generate(input: Record<string, unknown>) {
      captured.pictures.push({ provider: this.name, input });
      const edit = Array.isArray(input.referenceImages) && input.referenceImages.length > 0;
      return {
        provider: this.name,
        model: String(input.model ?? "default-model"),
        // The service says JPEG; the bytes are a PNG.
        contentType: "image/jpeg",
        imageDataUrl: `data:image/jpeg;base64,${PNG_BYTES.toString("base64")}`,
        sogniCredits: this.name === "sogni" ? 12 : null,
        sent:
          this.name === "sogni"
            ? {
                tool: edit ? "edit_image" : "generate_image",
                safety: { safe_content_filter: input.safeContentFilter !== false },
                contentFilterOn: input.safeContentFilter !== false,
                promptExpansion: "not supported by this tool",
                seed: edit ? "not supported by this tool" : 777,
                negativePrompt: edit ? null : ((input.negativePrompt as string | undefined) ?? null),
              }
            : { tool: null, safety: { enable_safety_checker: true }, contentFilterOn: null, promptExpansion: "not supported by this tool", seed: "not supported by this tool", negativePrompt: null },
      };
    }
  }
  return {
    ...real,
    FalImageProvider: class extends Fake {
      constructor() {
        super("fal");
      }
    },
    SogniImageProvider: class extends Fake {
      constructor() {
        super("sogni");
      }
    },
  };
});

const { videoStorylineSettingsService } = await import("../services/video-storyline-settings.ts");
const { videoStorylineStillsService } = await import("../services/video-storyline-stills.ts");
const { videoStorylineRenderService } = await import("../services/video-storyline-render.ts");
const { videoStorylineService } = await import("../services/video-storylines.ts");
const { readShotGenerationRecords } = await import("../services/generation-record.ts");

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping generation record DB tests: ${support.reason ?? "unsupported environment"}`);

const ACTOR = { actorType: "user" as const, actorId: "user-1", agentId: null };

function lora(id: string, modelIds: string[]): SogniLoraInfo {
  return { id, name: `LoRA ${id}`, description: "", category: null, personal: false, modelIds, min: 0, max: 1, default: 0.8, step: 0.05, recommendedMin: 0.5, recommendedMax: 1, rangeLabels: null, needsFilterOff: false, sexual: false, creator: null, sourceUrl: null };
}
const Z_TURBO = "z_image_turbo_bf16";
const QWEN_EDIT = "qwen_image_edit_2511_fp8_lightning";
const KNOWN = [lora("z-only", [Z_TURBO]), lora("edit-ok", [QWEN_EDIT, Z_TURBO])];

const RECORD_FIELDS: Array<keyof VideoShotGenerationRecord> = [
  "version", "kind", "madeAt", "promptSent", "negativePromptSent", "provider", "model", "editModel", "tool", "loras", "lorasDropped",
  "contentRating", "contentFilterOn", "providerSafety", "promptExpansion", "references", "referencesNotSent", "seed",
  "estimatedCostCents", "actualCostCents", "providerCredits", "notes",
];

function expectEveryField(record: VideoShotGenerationRecord | null): asserts record is VideoShotGenerationRecord {
  expect(record).not.toBeNull();
  for (const field of RECORD_FIELDS) expect(record, `field ${field}`).toHaveProperty(field);
}

d("how-was-this-made records (database)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let pluginId = "";
  const stills = () => videoStorylineStillsService(db, { loraCatalog: { get: async () => ({ loras: KNOWN, models: [Z_TURBO, QWEN_EDIT], maxPerRequest: 8 }) } });

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-generation-record");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    const manifest = { id: "paperclip.media-studio", apiVersion: 1, version: "1.0.0", displayName: "Media Studio", description: "Media generation", author: "Paperclip", categories: ["automation"], capabilities: [], entrypoints: { worker: "dist/worker.js" } } as unknown as PaperclipPluginManifestV1;
    const [row] = await db.insert(plugins).values({ pluginKey: "paperclip.media-studio", packageName: "@paperclipai/plugin-media-studio", version: "1.0.0", manifestJson: manifest, status: "ready" }).returning();
    pluginId = row!.id;
    await db.insert(pluginConfig).values({ pluginId, configJson: { falKeySecretRef: "fal-ref", sogniKeySecretRef: "sogni-ref" } });
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  beforeEach(() => {
    captured.pictures.length = 0;
    captured.stored.length = 0;
  });

  async function seed(providerId: "fal" | "sogni", prompt = "Someone walks along the harbour") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Record Co", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const storylines = videoStorylineService(db);
    const storyline = await storylines.createStoryline(
      companyId,
      { title: "T", projectId: null, providerId, model: null, budgetCapCents: 100_000, characterReferenceAssetIds: [], defaultTransition: "cut", defaultTransitionDurationMs: 500, musicAssetId: null, musicSourceKey: null, musicVolumeDb: -18 },
      ACTOR,
    );
    const scene = await storylines.createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
    const shot = await storylines.createShot(companyId, storyline.id, { sceneId: scene.id, orderIndex: 0, prompt, cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null }, ACTOR);
    return { companyId, storylineId: storyline.id, shotId: shot.id };
  }

  async function allDetailsText(companyId: string): Promise<string> {
    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    return JSON.stringify(rows);
  }

  it("a Sogni picture made from a reference picture records every field, the LoRA left out and why, and the real cost", async () => {
    const { companyId, storylineId, shotId } = await seed("sogni", `Someone walks along the harbour. My key is ${KEY}`);
    const { assets } = await import("@paperclipai/db");
    const [ref] = await db.insert(assets).values({ companyId, provider: "local", objectKey: "look-harbour", contentType: "image/png", byteSize: 4, sha256: "0".repeat(64) }).returning();
    await db.insert(pluginState).values({
      pluginId,
      scopeKind: "company",
      scopeId: companyId,
      namespace: "default",
      stateKey: "looks",
      valueJson: [{ id: "look-lora", name: "Harbour", style: "warm film still", provider: "sogni", model: Z_TURBO, seed: 42, negativePrompt: "blurry", loras: [{ id: "z-only", strength: 0.8 }, { id: "edit-ok", strength: 0.6 }], referenceFileIds: [ref!.id], referenceRoles: ["background"] }],
    });
    await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni", lookId: "look-lora" } }, ACTOR);
    // A mature film, so the only rule that leaves a LoRA out is the model fit (the rating rules have their own tests).
    await db.update(videoStorylines).set({ contentRating: "mature" }).where(eq(videoStorylines.id, storylineId));

    await stills().generateStill(companyId, storylineId, shotId, ACTOR);

    const { still, clip } = await readShotGenerationRecords(db, companyId, shotId);
    expect(clip).toBeNull();
    expectEveryField(still);
    expect(still).toMatchObject({
      version: 1,
      kind: "still",
      provider: "sogni",
      model: "z_image_turbo_bf16",
      editModel: "qwen-lightning",
      tool: "edit_image",
      loras: [{ id: "edit-ok", strength: 0.6 }],
      contentRating: "mature",
      contentFilterOn: true,
      providerSafety: { safe_content_filter: true },
      promptExpansion: "not supported by this tool",
      references: [{ fileId: ref!.id, role: "background" }],
      referencesNotSent: 0,
      seed: "not supported by this tool",
      estimatedCostCents: 1,
      actualCostCents: 1,
      providerCredits: 12,
    });
    expect(still.lorasDropped).toHaveLength(1);
    expect(still.lorasDropped[0]).toMatchObject({ id: "z-only" });
    expect(still.lorasDropped[0]!.reason).toMatch(/Made for .*not for Qwen/);
    // The prompt is what the provider was sent (minus any key-shaped text).
    expect(still.promptSent).toContain("Someone walks along the harbour");
    expect(String(captured.pictures[0]!.input.prompt)).toContain("Someone walks along the harbour");
    // No key material, no picture bytes, anywhere in anything logged for this company.
    const everything = await allDetailsText(companyId);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("FAKEKEYFORTESTS");
    expect(everything).not.toContain("base64");
    expect(everything).not.toContain("data:image");
  });

  it("a Fal picture records the provider's safety fields and a seed it does not support", async () => {
    const { companyId, storylineId, shotId } = await seed("fal");
    await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    const { still } = await readShotGenerationRecords(db, companyId, shotId);
    expectEveryField(still);
    expect(still).toMatchObject({
      provider: "fal",
      editModel: null,
      loras: [],
      lorasDropped: [],
      contentFilterOn: null,
      providerSafety: { enable_safety_checker: true },
      seed: "not supported by this tool",
      references: [],
    });
  });

  it("stores the picture with the type and extension its bytes really have (PNG bytes were saved as .jpg)", async () => {
    const { companyId, storylineId, shotId } = await seed("fal");
    await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    expect(captured.stored).toEqual([{ originalFilename: "shot-000000-still.png", contentType: "image/png" }]);
    const [shot] = await db.select().from(videoShots).where(eq(videoShots.id, shotId));
    expect(shot!.stillContentType).toBe("image/png");
  });

  it("a clip records what it was started with, then its real cost when it finishes", async () => {
    const { companyId, storylineId, shotId } = await seed("fal", "A boat leaves the harbour");
    await db.update(videoShots).set({ storyboardStatus: "approved", stillObjectKey: "stills/fake.png", stillProvider: "local", stillContentType: "image/png" }).where(eq(videoShots.id, shotId));
    const started: Array<Record<string, unknown>> = [];
    const provider = {
      name: "fal",
      start: async (input: Record<string, unknown>) => {
        started.push(input);
        return {
          externalId: "job-1",
          model: "fal-ai/kling-video/v3/standard/image-to-video",
          provider: "fal",
          sent: { tool: null, safety: { enable_safety_checker: true }, contentFilterOn: null, promptExpansion: "not supported by this tool", seed: "not sent (the service chose one)", negativePrompt: null },
        };
      },
      poll: async () => ({ status: "done" as const, result: { contentType: "video/mp4", dataUrl: "data:video/mp4;base64,AAAA" } }),
      cancel: async () => undefined,
    };
    const render = videoStorylineRenderService(db, { resolveApiKey: async () => KEY, buildProvider: () => provider });
    await render.startRender(companyId, storylineId, ACTOR, {});

    const afterStart = await readShotGenerationRecords(db, companyId, shotId);
    expectEveryField(afterStart.clip);
    expect(afterStart.clip).toMatchObject({ kind: "clip", provider: "fal", model: "fal-ai/kling-video/v3/standard/image-to-video", contentRating: "sfw", actualCostCents: null, seed: "not sent (the service chose one)" });
    expect(afterStart.clip.promptSent).toContain("A boat leaves the harbour");
    expect(afterStart.clip.estimatedCostCents).toBeGreaterThan(0);

    await render.tick();
    const { clip } = await readShotGenerationRecords(db, companyId, shotId);
    expectEveryField(clip);
    expect(clip.actualCostCents).toBe(37);
    expect(clip.promptSent).toBe(afterStart.clip.promptSent);
    const everything = await allDetailsText(companyId);
    expect(everything).not.toContain("FAKEKEYFORTESTS");
    expect(everything).not.toContain("data:video");
  });
});
