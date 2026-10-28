import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { SogniLoraInfo } from "@paperclipai/plugin-sdk/media";
import { and, eq } from "drizzle-orm";
import { assets, createDb, companies, pluginConfig, pluginState, plugins, videoShots, videoStorylines } from "@paperclipai/db";
import { FalFlaggedError } from "@paperclipai/plugin-sdk/media";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * Storyboard pictures follow the same look rules as the Create tab: LoRAs are
 * checked against the model the picture really uses, a look's saved person
 * only appears in shots they are in, a Higgsfield look is refused (never turned
 * into Fal.ai), and what Sogni's picture editor ignores of the look is said in
 * the picture's notes. Every paid call is stubbed.
 */

const captured = vi.hoisted(() => ({
  pictures: [] as Array<{ provider: string; input: Record<string, unknown> }>,
  failWith: null as string | null,
  /** A Fal picture its own safety check flagged: the provider throws the typed error carrying the usage. */
  flagged: false,
  falCosts: [] as Array<Record<string, unknown>>,
}));

vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({
    getObject: async (_companyId: string, objectKey: string) => ({ stream: Readable.from([Buffer.from(objectKey)]) }),
    putFile: async (input: { contentType: string; body: Buffer }) => ({
      provider: "local",
      objectKey: `stills/${randomUUID()}.jpg`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: "0".repeat(64),
    }),
  }),
}));

vi.mock("../services/secrets.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/secrets.js")>();
  return { ...real, secretService: () => ({ resolveSecretValueForVideoRender: async () => "test-key" }) };
});

vi.mock("../services/fal-cost-events.js", () => ({
  recordFalCostEvent: async (_db: unknown, _fetch: unknown, params: Record<string, unknown>) => {
    captured.falCosts.push(params);
    return undefined;
  },
}));

vi.mock("../services/image-provider-clients.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/image-provider-clients.js")>();
  class Fake {
    constructor(readonly name: string) {}
    async generate(input: Record<string, unknown>) {
      captured.pictures.push({ provider: this.name, input });
      if (captured.failWith) throw new Error(captured.failWith);
      if (captured.flagged) throw new FalFlaggedError(String(input.model ?? "fal-ai/flux/schnell"), { images: 1, megapixels: 0.5 });
      return { provider: this.name, model: String(input.model ?? "default"), contentType: "image/png", imageDataUrl: "data:image/png;base64,aGk=" };
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
const { videoStorylineService } = await import("../services/video-storylines.ts");
const {
  HIGGSFIELD_LOOK_REFUSAL,
  editImageDropsNote,
  falIgnoresNote,
  fitLorasToModel,
  lookForShot,
  normalizeStoryboardLook,
  resolveStoryboardPictureTarget,
} = await import("../services/storyboard-picture-look.ts");
type StoryboardLook = NonNullable<ReturnType<typeof normalizeStoryboardLook>>;

function look(over: Record<string, unknown> = {}): StoryboardLook {
  return normalizeStoryboardLook({ id: "look-1", name: "Hero", style: "warm film still", referenceFileIds: [], ...over })!;
}

function lora(id: string, modelIds: string[]): SogniLoraInfo {
  return {
    id,
    name: `LoRA ${id}`,
    description: "",
    category: null,
    personal: false,
    modelIds,
    min: 0,
    max: 1,
    default: 0.8,
    step: 0.05,
    recommendedMin: 0.5,
    recommendedMax: 1,
    rangeLabels: null,
    needsFilterOff: false,
    sexual: false,
    creator: null,
    sourceUrl: null,
  };
}

const Z_TURBO = "z_image_turbo_bf16";
const QWEN_LIGHTNING_EDIT = "qwen_image_edit_2511_fp8_lightning";
const KNOWN = [
  lora("krea2-detail-enhancer", [Z_TURBO]),
  lora("krea2-realism", [QWEN_LIGHTNING_EDIT, Z_TURBO]),
  lora("krea2-breast", [Z_TURBO, QWEN_LIGHTNING_EDIT]),
  lora("krea2-filter-bypass-3", [Z_TURBO, QWEN_LIGHTNING_EDIT]),
];

describe("1. LoRAs are checked against the model the picture really uses", () => {
  it("leaves out a LoRA made for another model, with a note naming it", () => {
    const l = look({ loras: [{ id: "krea2-detail-enhancer", strength: 0.8 }, { id: "krea2-realism", strength: 0.5 }] });
    const fit = fitLorasToModel(l, "qwen-lightning", KNOWN);
    expect(fit.loras).toEqual([{ id: "krea2-realism", strength: 0.5 }]);
    expect(fit.note).toContain('"LoRA krea2-detail-enhancer"');
    expect(fit.note).toContain("Qwen Image Edit 2511 Lightning");
    expect(fitLorasToModel(l, "z-turbo", KNOWN)).toEqual({ loras: l.loras, note: null });
  });

  it("sends them as saved, and says so, when Sogni's list cannot be read; keeps the account's own LoRAs", () => {
    const l = look({ loras: [{ id: "krea2-detail-enhancer", strength: 0.8 }] });
    const unchecked = fitLorasToModel(l, "qwen-lightning", null);
    expect(unchecked.loras).toHaveLength(1);
    expect(unchecked.note).toMatch(/not checked/);
    const own = look({ loras: [{ id: "personal-abc", strength: 0.8 }, { id: "gone", strength: 0.8 }] });
    const fit = fitLorasToModel(own, "z-turbo", KNOWN);
    expect(fit.loras.map((x) => x.id)).toEqual(["personal-abc"]);
    expect(fit.note).toContain("does not list it any more");
    expect(unchecked.note).toContain('the LoRAs of the look "Hero"');
  });
});

describe("2. the look's person only appears in shots they are in", () => {
  const person = look({
    identityId: "id-maja",
    sheet: { hair: "long blonde", outfit: "red coat", setting: "a harbour", artStyle: "oil paint" },
    referenceFileIds: ["face-1", "body-1", "bg-1"],
    referenceRoles: ["face", "body", "background"],
  });

  it("keeps only style and setting, and the non-person pictures, when the person is not in the shot", () => {
    const shot = lookForShot(person, new Set(["id-bo"]));
    expect(shot.look!.sheet).toEqual({ setting: "a harbour", artStyle: "oil paint" });
    expect(shot.look!.referenceFileIds).toEqual(["bg-1"]);
    expect(shot.look!.referenceRoles).toEqual(["background"]);
    expect(shot.note).toContain("not in this shot");
  });

  it("also leaves out pictures tagged outfit or other (the default tag), and says how to get the person back", () => {
    const untagged = look({
      identityId: "id-maja",
      sheet: { hair: "long blonde" },
      referenceFileIds: ["face-photo", "coat", "harbour", "palette"],
      referenceRoles: ["other", "outfit", "style", "other"],
    });
    const shot = lookForShot(untagged, new Set(["id-bo"]), "Maja");
    expect(shot.look!.referenceFileIds).toEqual(["harbour"]);
    expect(shot.look!.sheet).toEqual({});
    expect(shot.note).toContain("(Maja)");
    expect(shot.note).toContain("add them to the cast in step 1");
    // A look whose pictures are all untagged and which has no character fields still says so.
    const onlyPhotos = look({ identityId: "id-maja", referenceFileIds: ["face-photo"] });
    expect(lookForShot(onlyPhotos, new Set()).look!.referenceFileIds).toEqual([]);
    expect(lookForShot(onlyPhotos, new Set()).note).not.toBeNull();
  });

  it("changes nothing when the person is in the shot, or the look shows nobody", () => {
    expect(lookForShot(person, new Set(["id-maja"]))).toEqual({ look: person, note: null });
    const nobody = look({ sheet: { hair: "long blonde" } });
    expect(lookForShot(nobody, new Set())).toEqual({ look: nobody, note: null });
  });
});

describe("3. a Higgsfield look is refused, never turned into Fal.ai", () => {
  it("returns the plain refusal for a Higgsfield look, even when the storyline names Fal.ai, and for an older save with model soul", () => {
    expect(HIGGSFIELD_LOOK_REFUSAL).toBe("Higgsfield can't make storyboard pictures yet; pick a Sogni or Fal look.");
    const hf = look({ provider: "higgsfield" });
    expect(resolveStoryboardPictureTarget({ lookId: "look-1", providerId: "fal" }, null, [hf]).refusal).toBe(HIGGSFIELD_LOOK_REFUSAL);
    const soul = look({ model: "soul" });
    const target = resolveStoryboardPictureTarget({ lookId: "look-1" }, null, [soul]);
    expect(target.refusal).toBe(HIGGSFIELD_LOOK_REFUSAL);
    expect(target.model).toBeNull();
    expect(resolveStoryboardPictureTarget({ lookId: "look-1" }, null, [look({ provider: "sogni", model: "z-turbo" })]).refusal).toBeNull();
  });
});

describe("Fal.ai ignores the look's LoRAs, seed, guidance and things to avoid, and the note says so", () => {
  it("names what the look set and nothing else", () => {
    expect(falIgnoresNote(look({ loras: [{ id: "a", strength: 1 }, { id: "b", strength: 1 }], seed: 3 }))).toMatch(/not its LoRAs and seed, so they were left out/);
    expect(falIgnoresNote(look({ guidance: 2 }))).toMatch(/not guidance, so it was left out/);
    expect(falIgnoresNote(look())).toBeNull();
  });
});

describe("5. Sogni's picture editor drops the look's seed and negative prompt, and the note says so", () => {
  it("names what the look set and nothing else", () => {
    expect(editImageDropsNote(look({ seed: 7, negativePrompt: "blur" }))).toMatch(/seed and "things to avoid" text.*not used/);
    expect(editImageDropsNote(look({ seed: 7 }))).toMatch(/look's seed, so it was not used/);
    expect(editImageDropsNote(look())).toBeNull();
  });
});

// ─── Through the service (database) ──────────────────────────────────────

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping storyboard look rules DB tests: ${support.reason ?? "unsupported environment"}`);

const ACTOR = { actorType: "user" as const, actorId: "user-1", agentId: null };
const CONSENT = { likeness: true, adult: true, confirmedBy: "user-1", confirmedAt: "2026-10-01T00:00:00.000Z" };

function keyOf(dataUri: unknown): string {
  return Buffer.from(String(dataUri).split(",")[1] ?? "", "base64").toString();
}

d("storyboard stills apply the look rules (database)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let pluginId = "";
  const stills = () => videoStorylineStillsService(db, { loraCatalog: { get: async () => ({ loras: KNOWN, models: [Z_TURBO, QWEN_LIGHTNING_EDIT], maxPerRequest: 8 }) } });

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("storyboard-look-rules");
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
    await db.insert(pluginConfig).values({ pluginId, configJson: { falKeySecretRef: "fal-ref", sogniKeySecretRef: "sogni-ref" } });
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  beforeEach(() => {
    captured.pictures.length = 0;
    captured.failWith = null;
    captured.flagged = false;
    captured.falCosts.length = 0;
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Look Co", issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const storylines = videoStorylineService(db);
    const storyline = await storylines.createStoryline(
      companyId,
      { title: "T", projectId: null, providerId: "sogni", model: null, budgetCapCents: 100_000, characterReferenceAssetIds: [], defaultTransition: "cut", defaultTransitionDurationMs: 500, musicAssetId: null, musicSourceKey: null, musicVolumeDb: -18 },
      ACTOR,
    );
    const scene = await storylines.createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
    const shot = await storylines.createShot(
      companyId,
      storyline.id,
      { sceneId: scene.id, orderIndex: 0, prompt: "Someone walks along the harbour", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null },
      ACTOR,
    );
    return { companyId, storylineId: storyline.id, shotId: shot.id };
  }

  async function file(companyId: string, key: string): Promise<string> {
    const [row] = await db
      .insert(assets)
      .values({ companyId, provider: "local", objectKey: key, contentType: "image/png", byteSize: key.length, sha256: "0".repeat(64) })
      .returning();
    return row!.id;
  }

  async function saveState(companyId: string, stateKey: "looks" | "identities", list: unknown[]) {
    await db.insert(pluginState).values({ pluginId, scopeKind: "company", scopeId: companyId, namespace: "default", stateKey, valueJson: list });
  }

  async function savedMaja(companyId: string) {
    return {
      id: `id-maja-${randomUUID().slice(0, 8)}`,
      name: "maja",
      crops: [
        { role: "face", fileId: await file(companyId, "maja-face"), sourceFileId: null, box: null },
        { role: "body", fileId: await file(companyId, "maja-body"), sourceFileId: null, box: null },
      ],
      consent: CONSENT,
      preferredModels: { sogni: "krea-identity-edit", sogniExtraSlot: "qwen", fal: null },
    };
  }

  it("2. a shot without the look's person gets no character block and no face picture; a shot with them does", async () => {
    const { companyId, storylineId, shotId } = await seed();
    const maja = await savedMaja(companyId);
    await saveState(companyId, "identities", [maja]);
    const lookFace = await file(companyId, "look-face");
    const lookBackground = await file(companyId, "look-harbour");
    await saveState(companyId, "looks", [
      {
        id: "look-maja",
        name: "Maja at the harbour",
        style: "warm film still",
        provider: "sogni",
        identityId: maja.id,
        sheet: { hair: "long blonde", setting: "a harbour at dusk" },
        referenceFileIds: [lookFace, lookBackground],
        referenceRoles: ["face", "background"],
      },
    ]);
    const storylines = videoStorylineService(db);
    await storylines.updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni", lookId: "look-maja" } }, ACTOR);

    // Nobody is in the shot.
    const result = await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    const without = captured.pictures[0]!.input;
    expect(String(without.prompt)).not.toContain("Character");
    expect(String(without.prompt)).not.toContain("long blonde");
    expect(String(without.prompt)).toContain("a harbour at dusk");
    expect((without.referenceImages as string[]).map(keyOf)).toEqual(["look-harbour"]);
    expect(result.notes?.join(" ")).toContain("not in this shot");

    // Maja is in the shot: her face and body come first, the look's character fields are used.
    const cast = await storylines.setCast(companyId, storylineId, { members: [{ name: "Maja", identityId: maja.id }] }, ACTOR);
    await storylines.setShotCast(companyId, storylineId, shotId, [cast.cast.members[0]!.id], ACTOR);
    await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    const withMaja = captured.pictures[1]!.input;
    expect((withMaja.referenceImages as string[]).map(keyOf)[0]).toBe("maja-face");
    expect(String(withMaja.prompt)).toContain("a harbour at dusk");
    expect(String(withMaja.prompt)).toContain("Hair:");
  });

  it("1 and 5. the fallback editing model gets only the LoRAs that fit it, and the note says what the editor ignored", async () => {
    const { companyId, storylineId, shotId } = await seed();
    const background = await file(companyId, "look-harbour");
    await saveState(companyId, "looks", [
      {
        id: "look-lora",
        name: "Harbour",
        style: "warm film still",
        provider: "sogni",
        model: "z_image_turbo_bf16",
        seed: 42,
        negativePrompt: "blurry",
        loras: [{ id: "krea2-detail-enhancer", strength: 0.8 }, { id: "krea2-realism", strength: 0.6 }],
        referenceFileIds: [background],
        referenceRoles: ["background"],
      },
    ]);
    await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni", lookId: "look-lora" } }, ACTOR);

    const result = await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    const sent = captured.pictures[0]!.input;
    expect(sent.model).toBe("qwen-lightning");
    expect(sent.loras).toEqual([{ id: "krea2-realism", strength: 0.6 }]);
    // The editor ignores them, so they are not even set (the note and the code cannot drift apart).
    expect(sent.seed).toBeUndefined();
    expect(sent.negativePrompt).toBeUndefined();
    const notes = result.notes!.join(" ");
    expect(notes).toContain('"LoRA krea2-detail-enhancer"');
    expect(notes).toContain("Qwen Image Edit 2511 Lightning");
    expect(notes).toMatch(/seed and "things to avoid" text/);

    // Text only, on the look's own model: both LoRAs fit, no note about them.
    await db.delete(pluginState);
    await saveState(companyId, "looks", [{ id: "look-lora", name: "Harbour", style: "warm", provider: "sogni", model: "z_image_turbo_bf16", seed: 42, loras: [{ id: "krea2-detail-enhancer", strength: 0.8 }], referenceFileIds: [] }]);
    const plain = await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    expect(captured.pictures[1]!.input).toMatchObject({ model: "z-turbo", seed: 42, loras: [{ id: "krea2-detail-enhancer", strength: 0.8 }] });
    expect(plain.notes).toBeUndefined();
  });

  it("3. a Higgsfield look makes no picture on any service, and nothing is paid for", async () => {
    const { companyId, storylineId, shotId } = await seed();
    await saveState(companyId, "looks", [{ id: "look-hf", name: "Soul", style: "film", provider: "higgsfield", model: "soul", referenceFileIds: [] }]);
    await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "fal", lookId: "look-hf" } }, ACTOR);
    const costOf = async () => (await db.select({ cents: videoShots.stillEstimatedCostCents }).from(videoShots).where(eq(videoShots.id, shotId)))[0]!.cents;
    const costBefore = await costOf();
    await expect(stills().generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({
      status: 422,
      message: "Higgsfield can't make storyboard pictures yet; pick a Sogni or Fal look.",
    });
    expect(captured.pictures).toHaveLength(0);
    expect(await costOf()).toBe(costBefore);
  });

  it("2. a shot that names the look's person keeps them even when the storyline has no cast; an untagged face picture stays out of other shots", async () => {
    const { companyId, storylineId, shotId } = await seed();
    const maja = await savedMaja(companyId);
    await saveState(companyId, "identities", [maja]);
    const facePhoto = await file(companyId, "look-face-photo");
    await saveState(companyId, "looks", [
      {
        id: "look-maja",
        name: "Maja look",
        style: "warm film still",
        provider: "sogni",
        identityId: maja.id,
        sheet: { hair: "long blonde" },
        referenceFileIds: [facePhoto],
        referenceRoles: ["other"],
      },
    ]);
    const storylines = videoStorylineService(db);
    await storylines.updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni", lookId: "look-maja" } }, ACTOR);

    // Nobody named: the untagged ("other") face picture and the hair line stay out, and the note says how to bring her back.
    const without = await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    expect(captured.pictures[0]!.input.referenceImages).toBeUndefined();
    expect(String(captured.pictures[0]!.input.prompt)).not.toContain("long blonde");
    expect(without.notes?.join(" ")).toContain("add them to the cast in step 1");

    // The shot names her (no cast at all): the look applies as it always did.
    await storylines.updateShot(companyId, storylineId, shotId, { prompt: "maja walks along the harbour" }, ACTOR);
    const named = await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    const sent = captured.pictures[1]!.input;
    expect((sent.referenceImages as string[]).map(keyOf)).toEqual(["look-face-photo"]);
    expect(String(sent.prompt)).toContain("Hair:");
    expect(named.notes?.join(" ") ?? "").not.toContain("not in this shot");
  });

  it("naming the look's person in the shot does not get around the age check: their flagged picture is refused, nothing is paid", async () => {
    const { companyId, storylineId, shotId } = await seed();
    const maja = await savedMaja(companyId);
    await saveState(companyId, "identities", [maja]);
    const flagged = maja.crops[0]!.fileId;
    const flaggedOther = await file(companyId, "look-photo-flagged");
    await saveState(companyId, "looks", [
      { id: "look-maja", name: "Maja look", style: "warm film still", provider: "sogni", identityId: maja.id, sheet: {}, referenceFileIds: [flagged, flaggedOther], referenceRoles: ["face", "other"] },
    ]);
    await db.insert(pluginState).values({ pluginId, scopeKind: "company", scopeId: companyId, namespace: "default", stateKey: "identityAgeBlocks", valueJson: [flagged, flaggedOther] });
    const storylines = videoStorylineService(db);
    await storylines.updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni", lookId: "look-maja" } }, ACTOR);
    await storylines.updateShot(companyId, storylineId, shotId, { prompt: "maja walks along the harbour" }, ACTOR);

    // No cast: the name in the shot text brings the look's pictures in, and the age check still applies.
    await expect(stills().generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("age check") });
    expect(captured.pictures).toHaveLength(0);

    // A cast that holds somebody else (the look's face picture is dropped there, its flagged "other" picture is not): same refusal on the cast path.
    const bo = {
      ...maja,
      id: `id-bo-${randomUUID().slice(0, 8)}`,
      name: "bo",
      crops: [{ role: "face", fileId: await file(companyId, "bo-face"), sourceFileId: null, box: null }],
    };
    await db.update(pluginState).set({ valueJson: [maja, bo] }).where(and(eq(pluginState.pluginId, pluginId), eq(pluginState.scopeId, companyId), eq(pluginState.stateKey, "identities")));
    await storylines.setCast(companyId, storylineId, { members: [{ name: "Bo", identityId: bo.id }] }, ACTOR);
    await storylines.updateShot(companyId, storylineId, shotId, { prompt: "maja and Bo walk along the harbour" }, ACTOR);
    await expect(stills().generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("age check") });
    expect(captured.pictures).toHaveLength(0);
  });

  it("Fal.ai: a Sogni look's LoRAs are left out of a Fal.ai picture with a note", async () => {
    const { companyId, storylineId, shotId } = await seed();
    await saveState(companyId, "looks", [{ id: "look-l", name: "Harbour", style: "warm", provider: "sogni", loras: [{ id: "z-only", strength: 0.8 }], referenceFileIds: [] }]);
    await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "fal", lookId: "look-l" } }, ACTOR);
    const result = await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    expect(captured.pictures[0]).toMatchObject({ provider: "fal" });
    expect(captured.pictures[0]!.input.loras).toBeUndefined();
    expect(result.notes?.join(" ")).toMatch(/Fal\.ai pictures use only the style words.*not its LoRA, so it was left out/);
  });

  // ─── DUR-4898: safe for work unless the owner says otherwise ───────────

  async function setRating(storylineId: string, contentRating: "sfw" | "mature") {
    await db.update(videoStorylines).set({ contentRating }).where(eq(videoStorylines.id, storylineId));
  }
  const filterOffLook = (over: Record<string, unknown> = {}) => ({
    id: "look-off",
    name: "Unfiltered",
    style: "warm film still",
    provider: "sogni",
    model: "z_image_turbo_bf16",
    safeContentFilter: false,
    contentFilterOffBy: "owner-1",
    referenceFileIds: [],
    ...over,
  });
  async function useLook(companyId: string, storylineId: string, saved: Record<string, unknown>) {
    await saveState(companyId, "looks", [saved]);
    await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni", lookId: String(saved.id) } }, ACTOR);
  }

  it("4898. a filter-off look still sends the content filter ON in a safe-for-work film, and says so; a mature film follows the look", async () => {
    const { companyId, storylineId, shotId } = await seed();
    await useLook(companyId, storylineId, filterOffLook());
    const sfw = await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    expect(captured.pictures[0]!.input.safeContentFilter).toBe(true);
    expect(sfw.notes?.join(" ")).toContain("this film is safe for work, so the filter stayed on");

    await setRating(storylineId, "mature");
    await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    expect(captured.pictures[1]!.input.safeContentFilter).toBe(false);
  });

  it("4898. a film with no look sends the filter on too", async () => {
    const { companyId, storylineId, shotId } = await seed();
    await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni" } }, ACTOR);
    await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    expect(captured.pictures[0]!.input.safeContentFilter).toBe(true);
  });

  it("4898. a filter-bypass LoRA is refused in a safe-for-work film and in a mature film, and nothing is paid for", async () => {
    const { companyId, storylineId, shotId } = await seed();
    await useLook(companyId, storylineId, {
      id: "look-bypass", name: "Bypass", style: "film", provider: "sogni", model: "z_image_turbo_bf16",
      loras: [{ id: "krea2-filter-bypass-3", strength: 0.8 }], referenceFileIds: [],
    });
    for (const rating of ["sfw", "mature"] as const) {
      await setRating(storylineId, rating);
      await expect(stills().generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("never allowed") });
    }
    expect(captured.pictures).toHaveLength(0);
  });

  it("4898. an anatomy slider is dropped in a safe-for-work film with a note, and kept in a mature one", async () => {
    const { companyId, storylineId, shotId } = await seed();
    await useLook(companyId, storylineId, {
      id: "look-slider", name: "Slider", style: "film", provider: "sogni", model: "z_image_turbo_bf16",
      loras: [{ id: "krea2-detail-enhancer", strength: 0.8 }, { id: "krea2-breast", strength: 0.5 }], referenceFileIds: [],
    });
    const sfw = await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    expect(captured.pictures[0]!.input.loras).toEqual([{ id: "krea2-detail-enhancer", strength: 0.8 }]);
    expect(sfw.notes?.join(" ")).toContain('The LoRA "LoRA krea2-breast" changes body anatomy');

    await setRating(storylineId, "mature");
    await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    expect(captured.pictures[1]!.input.loras).toEqual([{ id: "krea2-detail-enhancer", strength: 0.8 }, { id: "krea2-breast", strength: 0.5 }]);
  });

  it("4898. a spicy or uncensored model is refused in a safe-for-work film", async () => {
    const { companyId, storylineId, shotId } = await seed();
    await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni", model: "dark-beast-krea2" } }, ACTOR);
    await expect(stills().generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("made for mature pictures") });
    expect(captured.pictures).toHaveLength(0);
    await setRating(storylineId, "mature");
    await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    expect(captured.pictures).toHaveLength(1);
  });

  it("4898. safe-for-work words: 'things to avoid' for a text picture, the prompt for a picture made from references", async () => {
    const { companyId, storylineId, shotId } = await seed();
    await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni" } }, ACTOR);
    await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    const text = captured.pictures[0]!.input;
    expect(String(text.prompt)).toContain("Fully clothed.");
    expect(String(text.prompt)).not.toContain("Keep out of the picture");
    expect(String(text.negativePrompt)).toContain("nudity");

    const reference = await file(companyId, "ref-1");
    await db.update(videoShots).set({ lookReferenceAssetIds: [reference] }).where(eq(videoShots.id, shotId));
    await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    const edit = captured.pictures[1]!.input;
    expect(String(edit.prompt)).toContain("Fully clothed.");
    expect(String(edit.prompt)).toContain("Keep out of the picture: nudity");
    expect(edit.negativePrompt).toBeUndefined();

    await setRating(storylineId, "mature");
    await stills().generateStill(companyId, storylineId, shotId, ACTOR);
    expect(String(captured.pictures[2]!.input.prompt)).not.toContain("Fully clothed");
  });

  it("4898. a picture the service refused or flagged is never stored, so it can't be approved", async () => {
    const { companyId, storylineId, shotId } = await seed();
    captured.failWith = "Fal's own safety check flagged this picture, so it was thrown away.";
    await expect(stills().generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({ status: 422 });
    const [row] = await db.select().from(videoShots).where(eq(videoShots.id, shotId));
    expect(row!.stillObjectKey).toBeNull();
    await expect(stills().approveShot(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({ status: 422 });
  });

  it("4898 F1. a Fal picture flagged by Fal's own check is never stored or approved, but its cost is recorded before the refusal", async () => {
    const { companyId, storylineId, shotId } = await seed();
    await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "fal" } }, ACTOR);
    captured.flagged = true;
    await expect(stills().generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("safety check flagged") });
    const [row] = await db.select().from(videoShots).where(eq(videoShots.id, shotId));
    expect(row!.stillObjectKey).toBeNull();
    await expect(stills().approveShot(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({ status: 422 });
    // Fal still bills a flagged picture: the cost event carries its usage.
    expect(captured.falCosts).toHaveLength(1);
    expect(captured.falCosts[0]).toMatchObject({ companyId, billingCode: "video-storyline-still", usage: { images: 1, megapixels: 0.5 } });
  });

});
