import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createDb, companies, plugins, videoShots } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.ts";
import { videoStorylineStillsService } from "../services/video-storyline-stills.ts";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.ts";

/**
 * DUR-4317/DUR-4320: approve/drop/edit-resets-to-pending for the
 * storyboard-of-stills gate. generateStill itself needs a real
 * image-generation provider call, so these tests seed a shot's still_*
 * columns directly (same "set exactly what the real call would have
 * persisted" posture video-storyline-render-storyboard-gate.test.ts uses)
 * rather than mocking Fal's HTTP API -- the point here is approve/drop/
 * edit's own state machine, not the generation call.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping video storyline stills service tests: ${support.reason ?? "unsupported environment"}`);
}

const ACTOR: VideoStorylineActor = { actorType: "agent", actorId: "agent-1", agentId: null };

d("videoStorylineStillsService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-stills-service");
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
    await db.insert(plugins).values({
      pluginKey: "paperclip.media-studio",
      packageName: "@paperclipai/plugin-media-studio",
      version: "1.0.0",
      manifestJson: manifest,
      status: "ready",
    });
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompanyWithShot() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Stills Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const storylines = videoStorylineService(db);
    const storyline = await storylines.createStoryline(
      companyId,
      {
        title: "T",
        projectId: null,
        providerId: "fal",
        model: null,
        budgetCapCents: 100_000,
        characterReferenceAssetIds: [],
        defaultTransition: "cut",
        defaultTransitionDurationMs: 500,
        musicAssetId: null,
        musicSourceKey: null,
        musicVolumeDb: -18,
      },
      ACTOR,
    );
    const scene = await storylines.createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
    const shot = await storylines.createShot(
      companyId,
      storyline.id,
      { sceneId: scene.id, orderIndex: 0, prompt: "A shot", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null },
      ACTOR,
    );
    return { companyId, storylineId: storyline.id, shotId: shot.id };
  }

  async function giveShotAStill(shotId: string) {
    await db
      .update(videoShots)
      .set({ stillObjectKey: "stills/fake.jpg", stillProvider: "local", stillContentType: "image/jpeg", stillEstimatedCostCents: 2, stillActualCostCents: 2 })
      .where(eq(videoShots.id, shotId));
  }

  it("defaults a new shot's storyboardStatus to 'pending'", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot();
    const shot = await videoStorylineService(db).getShotRow(companyId, storylineId, shotId);
    expect(shot.storyboardStatus).toBe("pending");
  });

  it("refuses to approve a shot with no generated still yet", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot();

    await expect(
      videoStorylineStillsService(db).approveShot(companyId, storylineId, shotId, ACTOR),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("approves a shot once it has a still", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot();
    await giveShotAStill(shotId);

    const result = await videoStorylineStillsService(db).approveShot(companyId, storylineId, shotId, ACTOR);
    expect(result.storyboardStatus).toBe("approved");
  });

  it("drops a shot regardless of whether it has a still", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot();

    const result = await videoStorylineStillsService(db).dropShot(companyId, storylineId, shotId, ACTOR);
    expect(result.storyboardStatus).toBe("dropped");
  });

  it("refuses to approve a dropped shot", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot();
    await giveShotAStill(shotId);
    await videoStorylineStillsService(db).dropShot(companyId, storylineId, shotId, ACTOR);

    await expect(
      videoStorylineStillsService(db).approveShot(companyId, storylineId, shotId, ACTOR),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("editing a shot's prompt resets an approved shot back to 'pending' and clears its still", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot();
    await giveShotAStill(shotId);
    await videoStorylineStillsService(db).approveShot(companyId, storylineId, shotId, ACTOR);

    const updated = await videoStorylineService(db).updateShot(companyId, storylineId, shotId, { prompt: "A different shot now" }, ACTOR);
    expect(updated.storyboardStatus).toBe("pending");
    expect(updated.stillObjectKey).toBeNull();
    expect(updated.stillEstimatedCostCents).toBeNull();
  });

  it("editing a shot's camera notes also resets storyboardStatus to 'pending'", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot();
    await giveShotAStill(shotId);
    await videoStorylineStillsService(db).approveShot(companyId, storylineId, shotId, ACTOR);

    const updated = await videoStorylineService(db).updateShot(companyId, storylineId, shotId, { cameraNotes: "Wider lens" }, ACTOR);
    expect(updated.storyboardStatus).toBe("pending");
  });

  it("editing only durationSeconds leaves an approved shot's storyboardStatus untouched", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot();
    await giveShotAStill(shotId);
    await videoStorylineStillsService(db).approveShot(companyId, storylineId, shotId, ACTOR);

    const updated = await videoStorylineService(db).updateShot(companyId, storylineId, shotId, { durationSeconds: 8 }, ACTOR);
    expect(updated.storyboardStatus).toBe("approved");
    expect(updated.stillObjectKey).not.toBeNull();
  });

  it("getStoryboardSummary reports allApproved only once every non-dropped shot is approved", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot();

    const before = await videoStorylineStillsService(db).getStoryboardSummary(companyId, storylineId);
    expect(before.allApproved).toBe(false);

    await giveShotAStill(shotId);
    await videoStorylineStillsService(db).approveShot(companyId, storylineId, shotId, ACTOR);
    const after = await videoStorylineStillsService(db).getStoryboardSummary(companyId, storylineId);
    expect(after.allApproved).toBe(true);
    expect(after.stillTotalCents).toBe(2);
  });

  it("getStoryboardSummary excludes a dropped shot from allApproved and the cost total", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot();
    await videoStorylineStillsService(db).dropShot(companyId, storylineId, shotId, ACTOR);

    const summary = await videoStorylineStillsService(db).getStoryboardSummary(companyId, storylineId);
    expect(summary.allApproved).toBe(false);
    expect(summary.stillTotalCents).toBe(0);
  });
});
