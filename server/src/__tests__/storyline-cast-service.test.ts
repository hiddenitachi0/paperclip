import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { assets, createDb, companies, pluginConfig, pluginState, plugins, videoShots, videoStorylines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * Storyline Cast with a database: the cast is stored on the storyline,
 * company-scoped (a saved person of another company is refused), kept when
 * the picture settings change, filled from a script import; and storyboard
 * pictures and video clips send the cast's pictures in the right order.
 * Every paid call is stubbed: the picture and video clients, the key lookup
 * and the file storage are replaced below.
 */

const captured = vi.hoisted(() => ({
  pictures: [] as Array<{ provider: string; input: Record<string, unknown> }>,
  videos: [] as Array<{ provider: string; input: Record<string, unknown> }>,
}));

vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({
    // A stored object's bytes are its key, so a test can tell which picture went where.
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

vi.mock("../services/fal-cost-events.js", () => ({ recordFalCostEvent: async () => undefined }));

vi.mock("../services/image-provider-clients.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/image-provider-clients.js")>();
  class Fake {
    constructor(readonly name: string) {}
    async generate(input: Record<string, unknown>) {
      captured.pictures.push({ provider: this.name, input });
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

vi.mock("../services/video-provider-clients.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/video-provider-clients.js")>();
  class FakeVideo {
    constructor(readonly name: string) {}
    async start(input: Record<string, unknown>) {
      captured.videos.push({ provider: this.name, input });
      return { externalId: "job-1", model: String(input.model ?? "default"), provider: this.name };
    }
    async poll() {
      return { status: "running" as const };
    }
    async cancel() {}
  }
  return {
    ...real,
    FalVideoProvider: class extends FakeVideo {
      constructor() {
        super("fal");
      }
    },
    SogniVideoProvider: class extends FakeVideo {
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
const { validateVideoStorylineScript } = await import("@paperclipai/shared");

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping storyline cast DB tests: ${support.reason ?? "unsupported environment"}`);

const ACTOR = { actorType: "user" as const, actorId: "user-1", agentId: null };
const CONSENT = { likeness: true, adult: true, confirmedBy: "user-1", confirmedAt: "2026-10-01T00:00:00.000Z" };

/** The text inside a data: URI the fake storage made (the stored object's key). */
function keyOf(dataUri: unknown): string {
  return Buffer.from(String(dataUri).split(",")[1] ?? "", "base64").toString();
}

d("storyline cast (database)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let pluginId = "";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("storyline-cast");
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
    captured.videos.length = 0;
  });

  /** A company with a picture file per name (assets rows; the fake storage returns the key as bytes). */
  async function seed(opts: { prompt?: string; providerId?: "fal" | "sogni" } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cast Co", issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const storylines = videoStorylineService(db);
    const storyline = await storylines.createStoryline(
      companyId,
      { title: "T", projectId: null, providerId: opts.providerId ?? "fal", model: null, budgetCapCents: 100_000, characterReferenceAssetIds: [], defaultTransition: "cut", defaultTransitionDurationMs: 500, musicAssetId: null, musicSourceKey: null, musicVolumeDb: -18 },
      ACTOR,
    );
    const scene = await storylines.createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
    const shot = await storylines.createShot(
      companyId,
      storyline.id,
      { sceneId: scene.id, orderIndex: 0, prompt: opts.prompt ?? "Maja opens the door", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null },
      ACTOR,
    );
    return { companyId, storylineId: storyline.id, shotId: shot.id, sceneId: scene.id };
  }

  async function file(companyId: string, key: string): Promise<string> {
    const [row] = await db
      .insert(assets)
      .values({ companyId, provider: "local", objectKey: key, contentType: "image/png", byteSize: key.length, sha256: "0".repeat(64) })
      .returning();
    return row!.id;
  }

  async function saveIdentities(companyId: string, list: unknown[]) {
    await db.insert(pluginState).values({ pluginId, scopeKind: "company", scopeId: companyId, namespace: "default", stateKey: "identities", valueJson: list });
  }

  async function savedPerson(companyId: string, name: string, over: Record<string, unknown> = {}) {
    const face = await file(companyId, `${name}-face`);
    const body = await file(companyId, `${name}-body`);
    return {
      id: `id-${name}-${randomUUID().slice(0, 8)}`,
      name,
      crops: [
        { role: "face", fileId: face, sourceFileId: null, box: null },
        { role: "body", fileId: body, sourceFileId: null, box: null },
      ],
      consent: CONSENT,
      preferredModels: { sogni: "krea-identity-edit", sogniExtraSlot: "qwen", fal: null },
      ...over,
    };
  }

  it("stores the cast on the storyline and refuses a saved person of another company or without consent", async () => {
    const a = await seed();
    const b = await seed();
    const maja = await savedPerson(a.companyId, "maja");
    const other = await savedPerson(b.companyId, "other");
    const noConsent = { ...(await savedPerson(a.companyId, "nc")), consent: { likeness: true } };
    await saveIdentities(a.companyId, [maja, noConsent]);
    await saveIdentities(b.companyId, [other]);
    const storylines = videoStorylineService(db);

    const saved = await storylines.setCast(a.companyId, a.storylineId, { members: [{ name: "Maja", identityId: maja.id }, { name: "Bo" }] }, ACTOR);
    expect(saved.cast.members.map((m) => [m.id, m.name, m.identityId])).toEqual([
      ["c1", "Maja", maja.id],
      ["c2", "Bo", null],
    ]);
    expect(saved.pictureSettings).toEqual({});

    await expect(storylines.setCast(a.companyId, a.storylineId, { members: [{ name: "Maja", identityId: other.id }] }, ACTOR)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("not one of this company's identities"),
    });
    await expect(storylines.setCast(a.companyId, a.storylineId, { members: [{ name: "Nc", identityId: noConsent.id }] }, ACTOR)).rejects.toMatchObject({ status: 422 });
    // Another company cannot touch this storyline at all.
    await expect(storylines.setCast(b.companyId, a.storylineId, { members: [] }, ACTOR)).rejects.toMatchObject({ status: 404 });
    expect((await storylines.getStoryline(a.companyId, a.storylineId)).cast.members).toHaveLength(2);
  });

  it("keeps the cast when the picture settings change, and keeps the picture settings when the cast changes", async () => {
    const { companyId, storylineId, shotId } = await seed();
    const storylines = videoStorylineService(db);
    await storylines.setCast(companyId, storylineId, { members: [{ name: "Maja" }] }, ACTOR);
    await storylines.setShotCast(companyId, storylineId, shotId, ["c1"], ACTOR);
    const updated = await storylines.updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni", model: null, lookId: null } }, ACTOR);
    expect(updated.pictureSettings).toEqual({ providerId: "sogni", model: null, lookId: null });
    expect(updated.cast).toEqual({ members: [{ id: "c1", name: "Maja", nickname: null, description: null, identityId: null }], shotCast: { [shotId]: ["c1"] } });
    const recast = await storylines.setCast(companyId, storylineId, { members: [{ id: "c1", name: "Maja", nickname: "Mum" }] }, ACTOR);
    expect(recast.pictureSettings).toEqual({ providerId: "sogni", model: null, lookId: null });
    // Removing a member drops it from the shot picks; null goes back to the description.
    expect((await storylines.setCast(companyId, storylineId, { members: [] }, ACTOR)).cast.shotCast).toEqual({ [shotId]: [] });
    await storylines.setCast(companyId, storylineId, { members: [{ name: "Maja" }] }, ACTOR);
    expect((await storylines.setShotCast(companyId, storylineId, shotId, null, ACTOR)).cast.shotCast).toEqual({});
    await expect(storylines.setShotCast(companyId, storylineId, shotId, ["ghost"], ACTOR)).rejects.toMatchObject({ status: 422 });
  });

  it("a script import adds its characters to the cast", async () => {
    const { companyId, storylineId } = await seed();
    const parsed = validateVideoStorylineScript({
      characters: { Ada: "a woman in her 60s", Bo: "a border collie" },
      scenes: [{ scene_title: "One", shots: [{ prompt: "Ada walks Bo", duration_seconds: 5 }] }],
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    await videoStorylineService(db).importScript(companyId, storylineId, parsed.script, "append", ACTOR);
    const cast = (await videoStorylineService(db).getStoryline(companyId, storylineId)).cast;
    expect(cast.members.map((m) => [m.name, m.description, m.identityId])).toEqual([
      ["Ada", "a woman in her 60s", null],
      ["Bo", "a border collie", null],
    ]);
  });

  it("Sogni storyboard picture: the person's face then body first, identity model, identity-lock wording with their name", async () => {
    const { companyId, storylineId, shotId } = await seed({ prompt: "Maja opens the door" });
    const maja = await savedPerson(companyId, "maja", { sheet: { hair: "short red hair" } });
    await saveIdentities(companyId, [maja]);
    const storylines = videoStorylineService(db);
    await storylines.setCast(companyId, storylineId, { members: [{ name: "Maja", identityId: maja.id }] }, ACTOR);
    await storylines.updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni" } }, ACTOR);

    const result = await videoStorylineStillsService(db).generateStill(companyId, storylineId, shotId, ACTOR);
    const call = captured.pictures[0]!;
    expect(call.provider).toBe("sogni");
    expect(call.input.model).toBe("krea-identity-edit");
    expect((call.input.referenceImages as string[]).map(keyOf)).toEqual(["maja-face", "maja-body"]);
    expect(call.input.prompt).toContain("Maja is the person in picture 1.");
    expect(call.input.prompt).toContain("Use the person from picture 1 as the final subject");
    expect(call.input.prompt).toContain("Hair: short red hair.");
    expect(result.storyboardStatus).toBe("pending");
  });

  it("two people on Fal.ai: both faces first, FLUX.2 pro edit, a plain warning; nobody named means no cast pictures", async () => {
    const { companyId, storylineId, shotId } = await seed({ prompt: "Maja hands Bo the keys" });
    const maja = await savedPerson(companyId, "maja");
    const bo = await savedPerson(companyId, "bo");
    await saveIdentities(companyId, [maja, bo]);
    const storylines = videoStorylineService(db);
    await storylines.setCast(companyId, storylineId, { members: [{ name: "Maja", identityId: maja.id }, { name: "Bo", identityId: bo.id }] }, ACTOR);
    const stills = videoStorylineStillsService(db);

    const result = await stills.generateStill(companyId, storylineId, shotId, ACTOR);
    const call = captured.pictures[0]!;
    expect(call.provider).toBe("fal");
    expect(call.input.model).toBe("fal-ai/flux-2-pro/edit");
    expect((call.input.referenceImages as string[]).map(keyOf)).toEqual(["maja-face", "bo-face", "maja-body", "bo-body"]);
    expect(call.input.prompt).toContain("Maja is the person in image 1; Bo is the person in image 2.");
    expect(result.notes?.join(" ")).toMatch(/2 people are in this shot/);

    // A person's own pick: nobody in this shot.
    await storylines.setShotCast(companyId, storylineId, shotId, [], ACTOR);
    await stills.generateStill(companyId, storylineId, shotId, ACTOR);
    expect(captured.pictures[1]!.input.referenceImages).toBeUndefined();
  });

  it("refuses before any paid call when a cast picture was refused by the age check", async () => {
    const { companyId, storylineId, shotId } = await seed();
    const maja = await savedPerson(companyId, "maja");
    await saveIdentities(companyId, [maja]);
    await db.insert(pluginState).values({ pluginId, scopeKind: "company", scopeId: companyId, namespace: "default", stateKey: "identityAgeBlocks", valueJson: [maja.crops[0]!.fileId] });
    await videoStorylineService(db).setCast(companyId, storylineId, { members: [{ name: "Maja", identityId: maja.id }] }, ACTOR);
    await expect(videoStorylineStillsService(db).generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("age check"),
    });
    expect(captured.pictures).toHaveLength(0);
    const [row] = await db.select().from(videoShots).where(eq(videoShots.id, shotId));
    expect(row!.stillEstimatedCostCents).toBeNull();
  });

  it("video render: the approved picture is the start frame; the cast's pictures go first as references and per person", async () => {
    const { companyId, storylineId, shotId } = await seed({ prompt: "Maja and Bo dance" });
    const maja = await savedPerson(companyId, "maja", { canonicalFileId: await file(companyId, "maja-canon") });
    const bo = await savedPerson(companyId, "bo");
    await saveIdentities(companyId, [maja, bo]);
    const storylines = videoStorylineService(db);
    await storylines.setCast(companyId, storylineId, { members: [{ name: "Maja", identityId: maja.id }, { name: "Bo", identityId: bo.id }] }, ACTOR);
    await db
      .update(videoShots)
      .set({ storyboardStatus: "approved", stillObjectKey: "approved-still", stillProvider: "local", stillContentType: "image/png" })
      .where(eq(videoShots.id, shotId));

    await videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {});
    const call = captured.videos[0]!;
    expect(keyOf(call.input.startImage)).toBe("approved-still");
    expect((call.input.referenceImages as string[]).map(keyOf)).toEqual(["maja-face", "bo-face", "maja-canon", "bo-body"]);
    expect((call.input.characters as Array<{ name: string; images: string[] }>).map((c) => [c.name, c.images.map(keyOf)])).toEqual([
      ["Maja", ["maja-face", "maja-canon", "maja-body"]],
      ["Bo", ["bo-face", "bo-body"]],
    ]);
    const [storyline] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId));
    expect(storyline!.status).toBe("rendering");
  });
});
