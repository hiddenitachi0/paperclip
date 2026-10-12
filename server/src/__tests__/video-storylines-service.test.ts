import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { validateVideoStorylineScript } from "@paperclipai/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, assets, companies, videoShots, videoStorylines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.ts";

/**
 * DUR-4127: videoStorylineService against a real Postgres with every
 * migration applied. Covers company isolation, the editable-status gate
 * (a shot mid-render must not be hand-editable, see assertStorylineEditable
 * in video-storylines.ts), and the shot/scene count ceilings the ticket
 * asks for so a 700-1400 clip storyline never silently balloons past them.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping video storyline service tests: ${support.reason ?? "unsupported environment"}`);
}

const ACTOR: VideoStorylineActor = { actorType: "agent", actorId: "agent-1", agentId: null };

d("videoStorylineService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storylines");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Storyline Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function service() {
    return videoStorylineService(db);
  }

  describe("listStorylines", () => {
    it("returns only the requesting company's storylines", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      await service().createStoryline(companyA, { title: "A", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] }, ACTOR);
      await service().createStoryline(companyB, { title: "B", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] }, ACTOR);

      const resultA = await service().listStorylines(companyA);
      expect(resultA).toHaveLength(1);
      expect(resultA[0]!.title).toBe("A");
    });
  });

  describe("getStoryline", () => {
    it("404s for a storyline in a different company", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const storyline = await service().createStoryline(companyB, { title: "B", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] }, ACTOR);

      await expect(service().getStoryline(companyA, storyline.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("createScene / createShot", () => {
    it("recomputes the cost estimate and flips draft -> estimated once a shot exists", async () => {
      const companyId = await seedCompany();
      const storyline = await service().createStoryline(companyId, { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] }, ACTOR);
      expect(storyline.status).toBe("draft");

      const scene = await service().createScene(companyId, storyline.id, { title: "Scene 1", notes: null, orderIndex: 0 }, ACTOR);
      const shot = await service().createShot(
        companyId,
        storyline.id,
        { sceneId: scene.id, orderIndex: 0, prompt: "A hero walks forward", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [] },
        ACTOR,
      );
      expect(shot.status).toBe("draft");

      const refreshed = await service().getStoryline(companyId, storyline.id);
      expect(refreshed.status).toBe("estimated");
      // fal is 50 cents/second (VIDEO_PROVIDER_COST_CENTS_PER_SECOND) x 5s.
      expect(refreshed.estimatedTotalCents).toBe(250);
      expect(refreshed.estimatedTotalSeconds).toBe(5);
    });

    it("refuses a shot for a scene in a different storyline", async () => {
      const companyId = await seedCompany();
      const storylineA = await service().createStoryline(companyId, { title: "A", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] }, ACTOR);
      const storylineB = await service().createStoryline(companyId, { title: "B", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] }, ACTOR);
      const sceneB = await service().createScene(companyId, storylineB.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);

      await expect(
        service().createShot(companyId, storylineA.id, { sceneId: sceneB.id, orderIndex: 0, prompt: "x", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [] }, ACTOR),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("conflicts on a duplicate orderIndex within the same storyline", async () => {
      const companyId = await seedCompany();
      const storyline = await service().createStoryline(companyId, { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] }, ACTOR);
      await service().createScene(companyId, storyline.id, { title: "First", notes: null, orderIndex: 0 }, ACTOR);

      await expect(
        service().createScene(companyId, storyline.id, { title: "Dup", notes: null, orderIndex: 0 }, ACTOR),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("assertStorylineEditable", () => {
    it("refuses to edit a storyline that is rendering", async () => {
      const companyId = await seedCompany();
      const storyline = await service().createStoryline(companyId, { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] }, ACTOR);
      await db.update(videoStorylines).set({ status: "rendering" }).where(eq(videoStorylines.id, storyline.id));

      await expect(
        service().updateStoryline(companyId, storyline.id, { title: "New title" }, ACTOR),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service().createScene(companyId, storyline.id, { title: "x", notes: null, orderIndex: 5 }, ACTOR),
      ).rejects.toMatchObject({ status: 409 });
      await expect(service().deleteStoryline(companyId, storyline.id, ACTOR)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("getProgress", () => {
    it("summarizes shot status counts and budget fields", async () => {
      const companyId = await seedCompany();
      const storyline = await service().createStoryline(companyId, { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: 10_000, characterReferenceAssetIds: [] }, ACTOR);
      const scene = await service().createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
      await service().createShot(companyId, storyline.id, { sceneId: scene.id, orderIndex: 0, prompt: "shot 1", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [] }, ACTOR);
      await service().createShot(companyId, storyline.id, { sceneId: scene.id, orderIndex: 1, prompt: "shot 2", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [] }, ACTOR);

      const progress = await service().getProgress(companyId, storyline.id);
      expect(progress.totalShots).toBe(2);
      expect(progress.doneShots).toBe(0);
      expect(progress.budgetCapCents).toBe(10_000);
      expect(progress.shots).toHaveLength(2);
    });
  });

  /**
   * DUR-4196: transitions/music on a storyline, transitionIn on a shot.
   * Covers the one correctness trap in updateStoryline's music fields: the
   * DB has a hard CHECK that musicAssetId/musicSourceKey are never both set
   * (video_storylines_music_source_exclusive_check), so setting one must
   * clear the other's EXISTING stored value, not just reject a payload that
   * sends both at once.
   */
  describe("transitions and music (round 2)", () => {
    it("persists defaultTransition/defaultTransitionDurationMs/music fields on create and update", async () => {
      const companyId = await seedCompany();
      const storyline = await service().createStoryline(
        companyId,
        { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [], defaultTransition: "fade", defaultTransitionDurationMs: 800 },
        ACTOR,
      );
      expect(storyline.defaultTransition).toBe("fade");
      expect(storyline.defaultTransitionDurationMs).toBe(800);
      expect(storyline.musicVolumeDb).toBe(-18);

      const updated = await service().updateStoryline(
        companyId,
        storyline.id,
        { defaultTransition: "dissolve", musicSourceKey: "stock-track-1" },
        ACTOR,
      );
      expect(updated.defaultTransition).toBe("dissolve");
      expect(updated.musicSourceKey).toBe("stock-track-1");
      expect(updated.musicAssetId).toBeNull();
    });

    it("clears musicSourceKey when musicAssetId is set on a later update, and vice versa", async () => {
      const companyId = await seedCompany();
      const storyline = await service().createStoryline(
        companyId,
        { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [], musicSourceKey: "stock-track-1" },
        ACTOR,
      );
      expect(storyline.musicSourceKey).toBe("stock-track-1");

      // A later update that only mentions musicAssetId must not leave the DB
      // with both columns set -- that would violate the exclusivity CHECK.
      const assetId = randomUUID();
      await db.insert(assets).values({
        id: assetId,
        companyId,
        provider: "local",
        objectKey: `music/${assetId}.mp3`,
        contentType: "audio/mpeg",
        byteSize: 1,
        sha256: "0".repeat(64),
        originalFilename: "music.mp3",
      });
      const updated = await service().updateStoryline(companyId, storyline.id, { musicAssetId: assetId }, ACTOR);
      expect(updated.musicAssetId).toBe(assetId);
      expect(updated.musicSourceKey).toBeNull();

      const revert = await service().updateStoryline(companyId, storyline.id, { musicSourceKey: "stock-track-2" }, ACTOR);
      expect(revert.musicSourceKey).toBe("stock-track-2");
      expect(revert.musicAssetId).toBeNull();
    });

    it("persists transitionIn on a shot, inheriting the storyline default when null", async () => {
      const companyId = await seedCompany();
      const storyline = await service().createStoryline(companyId, { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] }, ACTOR);
      const scene = await service().createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
      const shot = await service().createShot(
        companyId,
        storyline.id,
        { sceneId: scene.id, orderIndex: 0, prompt: "shot 1", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: "fade" },
        ACTOR,
      );
      expect(shot.transitionIn).toBe("fade");

      const updated = await service().updateShot(companyId, storyline.id, shot.id, { transitionIn: null }, ACTOR);
      expect(updated.transitionIn).toBeNull();
    });
  });

  describe("importScript replace (security review: check-then-write race)", () => {
    function parsed(script: unknown) {
      const result = validateVideoStorylineScript(script);
      if (!result.ok) throw new Error(result.errors.join("; "));
      return result.script;
    }

    async function seedWithShots() {
      const companyId = await seedCompany();
      const storyline = await service().createStoryline(companyId, { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] }, ACTOR);
      const scene = await service().createScene(companyId, storyline.id, { title: "S", notes: null, orderIndex: 0 }, ACTOR);
      const shot = await service().createShot(
        companyId,
        storyline.id,
        { sceneId: scene.id, orderIndex: 0, prompt: "keep me", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [] },
        ACTOR,
      );
      return { companyId, storylineId: storyline.id, shotId: shot.id };
    }

    /**
     * The service's db, except that right before the import's write
     * transaction opens, `between` runs on the real db -- i.e. paid work
     * starts after the import's up-front checks passed but before it writes.
     */
    function racingDb(between: () => Promise<void>) {
      let fired = false;
      return new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === "transaction") {
            return async (...args: unknown[]) => {
              if (!fired) {
                fired = true;
                await between();
              }
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }

    const replacement = { scenes: [{ scene_title: "New", shots: [{ prompt: "replacement" }] }] };

    it("refuses a replace when a render starts between the check and the write, and deletes nothing", async () => {
      const { companyId, storylineId } = await seedWithShots();
      const raced = videoStorylineService(
        racingDb(async () => {
          // What startRender's locked transaction does: flip the storyline to "rendering".
          await db.update(videoStorylines).set({ status: "rendering" }).where(eq(videoStorylines.id, storylineId));
        }),
      );
      await expect(raced.importScript(companyId, storylineId, parsed(replacement), "replace", ACTOR)).rejects.toMatchObject({ status: 409 });
      const shots = await db.select().from(videoShots).where(eq(videoShots.storylineId, storylineId));
      expect(shots.map((s) => s.prompt)).toEqual(["keep me"]);
    });

    it("refuses a replace when a still or re-render starts between the check and the write, and deletes nothing", async () => {
      const { companyId, storylineId, shotId } = await seedWithShots();
      const raced = videoStorylineService(
        racingDb(async () => {
          // What generateStill's locked transaction does before the paid image call.
          await db.update(videoShots).set({ stillEstimatedCostCents: 1 }).where(eq(videoShots.id, shotId));
        }),
      );
      await expect(raced.importScript(companyId, storylineId, parsed(replacement), "replace", ACTOR)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("can't be replaced"),
      });
      const shots = await db.select().from(videoShots).where(eq(videoShots.storylineId, storylineId));
      expect(shots.map((s) => s.prompt)).toEqual(["keep me"]);
    });

    it("still replaces when nothing started in between", async () => {
      const { companyId, storylineId } = await seedWithShots();
      await service().importScript(companyId, storylineId, parsed(replacement), "replace", ACTOR);
      const shots = await db.select().from(videoShots).where(eq(videoShots.storylineId, storylineId));
      expect(shots.map((s) => s.prompt)).toEqual(["replacement"]);
    });
  });
});
