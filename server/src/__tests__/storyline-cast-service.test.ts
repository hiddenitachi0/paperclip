import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { assets, createDb, companies, pluginConfig, pluginState, plugins, videoShots, videoStorylines, videoUploads } from "@paperclipai/db";
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
const { videoStorylineClipsService } = await import("../services/video-storyline-clips.ts");
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
    await storylines.setShotCast(companyId, storylineId, shotId, ["c1"], ACTOR);
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
    await storylines.setShotCast(companyId, storylineId, shotId, ["c1", "c2"], ACTOR);
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
    await videoStorylineService(db).setShotCast(companyId, storylineId, shotId, ["c1"], ACTOR);
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
    await storylines.setShotCast(companyId, storylineId, shotId, ["c1", "c2"], ACTOR);
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
  /** A second shot in the same storyline (approved still, so only the cast gate can stop its render). */
  async function addShot(companyId: string, storylineId: string, sceneId: string, orderIndex: number, prompt: string) {
    const shot = await videoStorylineService(db).createShot(
      companyId,
      storylineId,
      { sceneId, orderIndex, prompt, cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null },
      ACTOR,
    );
    return shot.id;
  }

  async function approve(shotId: string) {
    await db.update(videoShots).set({ storyboardStatus: "approved", stillObjectKey: "approved-still", stillProvider: "local", stillContentType: "image/png" }).where(eq(videoShots.id, shotId));
  }

  describe("confirmed cast gate", () => {
    it("refuses an unconfirmed shot at start (listing the shots) and at still generation, before any paid call", async () => {
      const { companyId, storylineId, shotId, sceneId } = await seed();
      const second = await addShot(companyId, storylineId, sceneId, 1, "Bo waits");
      const third = await addShot(companyId, storylineId, sceneId, 2, "Maja leaves");
      const maja = await savedPerson(companyId, "maja");
      await saveIdentities(companyId, [maja]);
      const storylines = videoStorylineService(db);
      await storylines.setCast(companyId, storylineId, { members: [{ name: "Maja", identityId: maja.id }] }, ACTOR);
      await Promise.all([shotId, second, third].map(approve));
      await storylines.setShotCast(companyId, storylineId, second, ["c1"], ACTOR);

      await expect(videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {})).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("Confirm who is in shots 1 and 3 first."),
      });
      expect(captured.videos).toHaveLength(0);
      const [row] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId));
      expect(row!.status).not.toBe("rendering");

      const stills = videoStorylineStillsService(db);
      await expect(stills.generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("Confirm who is in shot 1 first."),
      });
      expect(captured.pictures).toHaveLength(0);
      // The confirmed shot is not refused.
      await stills.generateStill(companyId, storylineId, second, ACTOR);
      expect(captured.pictures).toHaveLength(1);
      // "Nobody" is a confirmation too.
      await storylines.setShotCast(companyId, storylineId, shotId, [], ACTOR);
      await storylines.setShotCast(companyId, storylineId, third, ["c1"], ACTOR);
      await approve(second); // generating its still put it back to waiting for review
      await videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {});
      expect(captured.videos).toHaveLength(1);
    });

    it("re-render, preview and animate refuse an unconfirmed shot before any paid call", async () => {
      const { companyId, storylineId, shotId, sceneId } = await seed();
      const second = await addShot(companyId, storylineId, sceneId, 1, "Maja leaves");
      const maja = await savedPerson(companyId, "maja");
      await saveIdentities(companyId, [maja]);
      const storylines = videoStorylineService(db);
      await storylines.setCast(companyId, storylineId, { members: [{ name: "Maja", identityId: maja.id }] }, ACTOR);
      await Promise.all([shotId, second].map(approve));
      const render = videoStorylineRenderService(db);

      // The shot itself is unconfirmed.
      await expect(render.reRenderShot(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("Confirm who is in shot 1 first."),
      });
      // Only the target is checked: a re-render queues that one shot and does not start the film's chain (DUR-4915).
      await storylines.setShotCast(companyId, storylineId, shotId, ["c1"], ACTOR);

      // Preview needs the target shot confirmed, nothing else.
      await videoStorylineSettingsService(db).setAdvancedEnabled(companyId, true);
      await expect(render.renderPreview(companyId, storylineId, second, ACTOR)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("Confirm who is in shot 2 first."),
      });
      const [afterPreview] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId));
      expect(afterPreview!.spentCents).toBe(0);

      // A photo clip animated into an AI shot.
      const [upload] = await db
        .insert(videoUploads)
        .values({ companyId, storylineId, kind: "photo", status: "ready", sourceContentType: "image/png", objectKey: "photo-key", contentType: "image/png" })
        .returning();
      await db.update(videoShots).set({ clipKind: "still", sourceUploadId: upload!.id }).where(eq(videoShots.id, second));
      await expect(
        videoStorylineClipsService(db).animate(companyId, storylineId, second, { prompt: "Maja smiles", confirmCostCents: 100_000 }, ACTOR),
      ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("Confirm who is in shot 2 first.") });
      expect(captured.videos).toHaveLength(0);
      const [afterAnimate] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId));
      expect(afterAnimate!.spentCents).toBe(0);

      // Everything confirmed: the re-render goes through.
      await db.update(videoShots).set({ clipKind: "generated", sourceUploadId: null }).where(eq(videoShots.id, second));
      await storylines.setShotCast(companyId, storylineId, second, [], ACTOR);
      await render.reRenderShot(companyId, storylineId, shotId, ACTOR);
      expect(captured.videos).toHaveLength(1);
    });

    it("does not touch a film with no person linked to its cast", async () => {
      const { companyId, storylineId, shotId } = await seed({ prompt: "Maja opens the door" });
      await videoStorylineService(db).setCast(companyId, storylineId, { members: [{ name: "Maja" }] }, ACTOR);
      await approve(shotId);
      await videoStorylineStillsService(db).generateStill(companyId, storylineId, shotId, ACTOR);
      await approve(shotId); // generating the still put it back to waiting for review
      expect(String(captured.pictures[0]!.input.prompt)).not.toMatch(/Nobody else|these people|this person is/);
      await videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {});
      expect(String(captured.videos[0]!.input.prompt)).not.toMatch(/Nobody else|these people|this person is/);
    });

    it("a paused film with unconfirmed shots resumes, and beginShotRender never checks the cast", async () => {
      const { companyId, storylineId, shotId, sceneId } = await seed();
      const second = await addShot(companyId, storylineId, sceneId, 1, "Bo waits");
      const maja = await savedPerson(companyId, "maja");
      await saveIdentities(companyId, [maja]);
      await videoStorylineService(db).setCast(companyId, storylineId, { members: [{ name: "Maja", identityId: maja.id }] }, ACTOR);
      await Promise.all([shotId, second].map(approve));
      await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, storylineId));
      const render = videoStorylineRenderService(db);

      await render.startRender(companyId, storylineId, ACTOR, {});
      expect(captured.videos).toHaveLength(1);
      // The chain's own next-shot call (a film that was rendering at deploy time) goes through too.
      const storyline = await videoStorylineService(db).getStorylineRow(companyId, storylineId);
      const [next] = await db.select().from(videoShots).where(eq(videoShots.id, second));
      await render.beginShotRender(companyId, storyline, next!, "user-1");
      expect(captured.videos).toHaveLength(2);
    });

    it("a film started under the rule and paused since is checked again on resume (new shot, new link, re-render)", async () => {
      const { companyId, storylineId, shotId, sceneId } = await seed();
      const maja = await savedPerson(companyId, "maja");
      await saveIdentities(companyId, [maja]);
      const storylines = videoStorylineService(db);
      await storylines.setCast(companyId, storylineId, { members: [{ name: "Maja", identityId: maja.id }] }, ACTOR);
      await storylines.setShotCast(companyId, storylineId, shotId, ["c1"], ACTOR);
      await approve(shotId);
      const render = videoStorylineRenderService(db);
      await render.startRender(companyId, storylineId, ACTOR, {});
      expect(captured.videos).toHaveLength(1);
      // The settings the client sees never carry the marker, and the cast edits below keep it.
      expect((await storylines.getStoryline(companyId, storylineId)).pictureSettings).toEqual({});
      // The film pauses (budget cap, failed shot): its first shot is back to be rendered.
      await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, storylineId));
      await db.update(videoShots).set({ status: "draft" }).where(eq(videoShots.id, shotId));

      // A shot added and approved while paused has no pick: the resume is refused before any paid call.
      const added = await addShot(companyId, storylineId, sceneId, 1, "Maja waves goodbye");
      await approve(added);
      await expect(render.startRender(companyId, storylineId, ACTOR, {})).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("Confirm who is in shot 2 first."),
      });
      expect(captured.videos).toHaveLength(1);
      const [stillPaused] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId));
      expect(stillPaused!.status).toBe("paused");

      // Confirmed: it resumes.
      await storylines.setShotCast(companyId, storylineId, added, ["c1"], ACTOR);
      await render.startRender(companyId, storylineId, ACTOR, {});
      expect(captured.videos).toHaveLength(2);
    });

    it("a film with no linked person that links one while paused is checked on resume once it was started under the rule", async () => {
      const { companyId, storylineId, shotId } = await seed({ prompt: "Alice opens the door" });
      const storylines = videoStorylineService(db);
      await storylines.setCast(companyId, storylineId, { members: [{ name: "Alice" }] }, ACTOR);
      await approve(shotId);
      const render = videoStorylineRenderService(db);
      await render.startRender(companyId, storylineId, ACTOR, {});
      await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, storylineId));
      await db.update(videoShots).set({ status: "draft" }).where(eq(videoShots.id, shotId));
      const alice = await savedPerson(companyId, "alice");
      await saveIdentities(companyId, [alice]);
      await storylines.setCast(companyId, storylineId, { members: [{ name: "Alice", identityId: alice.id }] }, ACTOR);
      await expect(render.startRender(companyId, storylineId, ACTOR, {})).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("Confirm who is in shot 1 first."),
      });
      expect(captured.videos).toHaveLength(1);
    });

    it("a paused film from before the rule stays exempt however many times it resumes", async () => {
      const { companyId, storylineId, shotId, sceneId } = await seed();
      const maja = await savedPerson(companyId, "maja");
      await saveIdentities(companyId, [maja]);
      await videoStorylineService(db).setCast(companyId, storylineId, { members: [{ name: "Maja", identityId: maja.id }] }, ACTOR);
      await approve(shotId);
      const render = videoStorylineRenderService(db);
      await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, storylineId));
      await render.startRender(companyId, storylineId, ACTOR, {});
      // It pauses again (no marker was added), and is resumed again, even with a new unconfirmed shot.
      await db.update(videoStorylines).set({ status: "paused" }).where(eq(videoStorylines.id, storylineId));
      await db.update(videoShots).set({ status: "draft" }).where(eq(videoShots.id, shotId));
      await approve(await addShot(companyId, storylineId, sceneId, 1, "Maja leaves"));
      await render.startRender(companyId, storylineId, ACTOR, {});
      expect(captured.videos).toHaveLength(2);
    });

    it("stills and video prompts say only the confirmed people are in the shot", async () => {
      const { companyId, storylineId, shotId, sceneId } = await seed({ prompt: "Maja hands Bo the keys" });
      const empty = await addShot(companyId, storylineId, sceneId, 1, "An empty street");
      const maja = await savedPerson(companyId, "maja");
      await saveIdentities(companyId, [maja]);
      const storylines = videoStorylineService(db);
      await storylines.setCast(companyId, storylineId, { members: [{ name: "Maja", identityId: maja.id }, { name: "Bo" }] }, ACTOR);
      await storylines.setShotCast(companyId, storylineId, shotId, ["c1", "c2"], ACTOR);
      await storylines.setShotCast(companyId, storylineId, empty, [], ACTOR);
      await Promise.all([shotId, empty].map(approve));
      const stills = videoStorylineStillsService(db);

      await stills.generateStill(companyId, storylineId, shotId, ACTOR);
      expect(String(captured.pictures[0]!.input.prompt)).toContain("Only these people are in this shot: Maja and Bo. Nobody else.");
      await stills.generateStill(companyId, storylineId, empty, ACTOR);
      expect(String(captured.pictures[1]!.input.prompt)).toContain("No people appear in this shot.");
      await Promise.all([shotId, empty].map(approve));

      await videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {});
      expect(String(captured.videos[0]!.input.prompt)).toContain("Only these people are in this shot: Maja and Bo. Nobody else.");
    });
  });

  // ─── DUR-4935: the age check covers every picture sent, not only a person's ───

  async function saveLooks(companyId: string, looks: unknown[]) {
    await db.insert(pluginState).values({ pluginId, scopeKind: "company", scopeId: companyId, namespace: "default", stateKey: "looks", valueJson: looks });
  }

  async function flag(companyId: string, fileIds: string[]) {
    await db.insert(pluginState).values({ pluginId, scopeKind: "company", scopeId: companyId, namespace: "default", stateKey: "identityAgeBlocks", valueJson: fileIds });
  }

  async function assertNothingPaid(shotId: string) {
    expect(captured.pictures).toHaveLength(0);
    expect(captured.videos).toHaveLength(0);
    const [row] = await db.select().from(videoShots).where(eq(videoShots.id, shotId));
    expect(row!.stillEstimatedCostCents).toBeNull();
  }

  const REFUSED = { status: 422, message: expect.stringContaining("age check") };

  it("no cast: a flagged picture tagged style or background in the look is refused before any provider call, the look's person not being in the shot", async () => {
    for (const role of ["style", "background"]) {
      const { companyId, storylineId, shotId } = await seed({ providerId: "sogni", prompt: "a harbour at dusk" });
      const maja = await savedPerson(companyId, "maja");
      await saveIdentities(companyId, [maja]);
      // Maja's own age-flagged face file, tagged as a style/background picture of her look.
      const flagged = maja.crops[0]!.fileId;
      await flag(companyId, [flagged]);
      await saveLooks(companyId, [{ id: "look-1", name: "Harbour", style: "warm", provider: "sogni", identityId: maja.id, referenceFileIds: [flagged], referenceRoles: [role] }]);
      await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni", lookId: "look-1" } }, ACTOR);
      await expect(videoStorylineStillsService(db).generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject(REFUSED);
      await assertNothingPaid(shotId);
    }
  });

  it("no cast: a flagged picture in a look that shows nobody, or flagged by its bytes, is refused too", async () => {
    const { companyId, storylineId, shotId } = await seed({ providerId: "sogni", prompt: "a harbour at dusk" });
    const bytesFile = await file(companyId, "same-bytes-as-flagged");
    const hash = createHash("sha256").update("same-bytes-as-flagged").digest("hex");
    await db.insert(pluginState).values({ pluginId, scopeKind: "company", scopeId: companyId, namespace: "default", stateKey: "pictureAgeChecks", valueJson: { [hash]: { verdict: "under18" } } });
    await saveLooks(companyId, [{ id: "look-1", name: "Harbour", style: "warm", provider: "sogni", referenceFileIds: [bytesFile], referenceRoles: ["background"] }]);
    await videoStorylineService(db).updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "sogni", lookId: "look-1" } }, ACTOR);
    await expect(videoStorylineStillsService(db).generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject(REFUSED);
    await assertNothingPaid(shotId);
  });

  it("no cast: a flagged picture as the shot's or the storyline's character reference is refused before any provider call", async () => {
    const { companyId, storylineId, shotId } = await seed({ providerId: "sogni", prompt: "a harbour at dusk" });
    const flagged = await file(companyId, "flagged-ref");
    await flag(companyId, [flagged]);
    const storylines = videoStorylineService(db);
    await storylines.updateShot(companyId, storylineId, shotId, { lookReferenceAssetIds: [flagged] }, ACTOR);
    await expect(videoStorylineStillsService(db).generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject(REFUSED);
    await storylines.updateShot(companyId, storylineId, shotId, { lookReferenceAssetIds: [] }, ACTOR);
    await storylines.updateStoryline(companyId, storylineId, { characterReferenceAssetIds: [flagged] }, ACTOR);
    await expect(videoStorylineStillsService(db).generateStill(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject(REFUSED);
    await assertNothingPaid(shotId);
    // The same picture, not flagged, is sent as before.
    await db.update(pluginState).set({ valueJson: [] }).where(and(eq(pluginState.pluginId, pluginId), eq(pluginState.scopeId, companyId), eq(pluginState.stateKey, "identityAgeBlocks")));
    await videoStorylineStillsService(db).generateStill(companyId, storylineId, shotId, ACTOR);
    expect((captured.pictures[0]!.input.referenceImages as string[]).map(keyOf)).toEqual(["flagged-ref"]);
  });

  it("cast: a flagged style/background look picture, or shot or storyline character reference, is refused though nobody's own picture is flagged", async () => {
    for (const where of ["look", "shot", "storyline"] as const) {
      const { companyId, storylineId, shotId } = await seed({ providerId: "fal", prompt: "Bo walks the harbour" });
      // Bo has one picture, so a free slot is left for the one extra picture under test.
      const bo = await savedPerson(companyId, "bo");
    bo.crops = bo.crops.slice(0, 1); // face only, so the model has room for the other pictures
      bo.crops = bo.crops.slice(0, 1);
      await saveIdentities(companyId, [bo]);
      const pic = await file(companyId, `${where}-pic`);
      if (where === "look") await saveLooks(companyId, [{ id: "look-1", name: "Harbour", style: "warm", provider: "sogni", referenceFileIds: [pic], referenceRoles: ["background"] }]);
      const storylines = videoStorylineService(db);
      if (where === "look") await storylines.updateStoryline(companyId, storylineId, { pictureSettings: { providerId: "fal", lookId: "look-1" } }, ACTOR);
      await storylines.setCast(companyId, storylineId, { members: [{ name: "Bo", identityId: bo.id }] }, ACTOR);
      // A film with a cast needs each shot's cast confirmed (#672) before the age check is reached.
      await storylines.setShotCast(companyId, storylineId, shotId, ["c1"], ACTOR);
      if (where === "shot") await storylines.updateShot(companyId, storylineId, shotId, { lookReferenceAssetIds: [pic] }, ACTOR);
      if (where === "storyline") await storylines.updateStoryline(companyId, storylineId, { characterReferenceAssetIds: [pic] }, ACTOR);
      const run = () => videoStorylineStillsService(db).generateStill(companyId, storylineId, shotId, ACTOR);
      await flag(companyId, [pic]);
      await expect(run()).rejects.toMatchObject(REFUSED);
      await assertNothingPaid(shotId);
      await db.update(pluginState).set({ valueJson: [] }).where(and(eq(pluginState.pluginId, pluginId), eq(pluginState.scopeId, companyId), eq(pluginState.stateKey, "identityAgeBlocks")));
      await run();
      expect((captured.pictures[0]!.input.referenceImages as string[]).map(keyOf)).toContain(`${where}-pic`);
      captured.pictures.length = 0;
    }
  });

  it("video render and preview: a flagged shot or storyline reference picture refuses the render before any video provider call", async () => {
    const { companyId, storylineId, shotId } = await seed({ providerId: "sogni", prompt: "a harbour at dusk" });
    await videoStorylineSettingsService(db).setAdvancedEnabled(companyId, true);
    const flagged = await file(companyId, "flagged-ref");
    await flag(companyId, [flagged]);
    const storylines = videoStorylineService(db);
    await storylines.updateShot(companyId, storylineId, shotId, { lookReferenceAssetIds: [flagged] }, ACTOR);
    await db
      .update(videoShots)
      .set({ storyboardStatus: "approved", stillObjectKey: "approved-still", stillProvider: "local", stillContentType: "image/png" })
      .where(eq(videoShots.id, shotId));
    const render = videoStorylineRenderService(db);
    await expect(render.startRender(companyId, storylineId, ACTOR, {})).rejects.toMatchObject(REFUSED);
    // The preview (a short real clip) sends the same pictures, so it is refused too.
    await expect(render.renderPreview(companyId, storylineId, shotId, ACTOR)).rejects.toMatchObject(REFUSED);
    expect(captured.videos).toHaveLength(0);
    // Not flagged: the picture is sent as a reference as before.
    await db.update(pluginState).set({ valueJson: [] }).where(and(eq(pluginState.pluginId, pluginId), eq(pluginState.scopeId, companyId), eq(pluginState.stateKey, "identityAgeBlocks")));
    await render.startRender(companyId, storylineId, ACTOR, {});
    expect((captured.videos[0]!.input.referenceImages as string[]).map(keyOf)).toEqual(["flagged-ref"]);
  });
});
