import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createDb, companies, plugins, videoShotRenderJobs, videoShots, videoStorylines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { videoStorylineRenderService } from "../services/video-storyline-render.ts";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.ts";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.ts";

/**
 * DUR-4170: POST .../render/cancel -- the route's underlying service
 * method. Covers the status gate (only "rendering"/"paused" are
 * cancellable, "stitching" is explicitly refused rather than raced) and the
 * cleanup of any still-"running" video_shot_render_jobs row + its shot, no
 * network mocking needed since provider cancellation is best-effort (see
 * cancelRender's doc comment in video-storyline-render.ts).
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping video storyline render cancel tests: ${support.reason ?? "unsupported environment"}`);
}

const ACTOR: VideoStorylineActor = { actorType: "agent", actorId: "agent-1", agentId: null };

d("videoStorylineRenderService.cancelRender", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-render-cancel");
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

  async function seedEnabledCompanyWithShot() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Cancel Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const storylines = videoStorylineService(db);
    const storyline = await storylines.createStoryline(
      companyId,
      { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: 100_000, characterReferenceAssetIds: [] },
      ACTOR,
    );
    const scene = await storylines.createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
    const shot = await storylines.createShot(
      companyId,
      storyline.id,
      { sceneId: scene.id, orderIndex: 0, prompt: "A shot", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [] },
      ACTOR,
    );
    return { companyId, storylineId: storyline.id, shotId: shot.id };
  }

  it("refuses to cancel a storyline that never started rendering", async () => {
    const { companyId, storylineId } = await seedEnabledCompanyWithShot();

    await expect(
      videoStorylineRenderService(db).cancelRender(companyId, storylineId, ACTOR),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses to cancel while the storyline is actively stitching", async () => {
    const { companyId, storylineId } = await seedEnabledCompanyWithShot();
    await db.update(videoStorylines).set({ status: "stitching" }).where(eq(videoStorylines.id, storylineId));

    await expect(
      videoStorylineRenderService(db).cancelRender(companyId, storylineId, ACTOR),
    ).rejects.toMatchObject({ status: 409 });

    const [row] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId));
    expect(row!.status).toBe("stitching");
  });

  it("refuses to cancel an already-terminal storyline", async () => {
    const { companyId, storylineId } = await seedEnabledCompanyWithShot();
    await db.update(videoStorylines).set({ status: "done" }).where(eq(videoStorylines.id, storylineId));

    await expect(
      videoStorylineRenderService(db).cancelRender(companyId, storylineId, ACTOR),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("cancels a paused storyline with no running job cleanly", async () => {
    const { companyId, storylineId } = await seedEnabledCompanyWithShot();
    await db.update(videoStorylines).set({ status: "paused", errorMessage: "A shot failed" }).where(eq(videoStorylines.id, storylineId));

    const result = await videoStorylineRenderService(db).cancelRender(companyId, storylineId, ACTOR);
    expect(result.status).toBe("cancelled");
    expect(result.errorMessage).toBeNull();
  });

  it("cancels a rendering storyline, marking its running shot/job failed and provider-cancel best-effort", async () => {
    const { companyId, storylineId, shotId } = await seedEnabledCompanyWithShot();
    await db.update(videoStorylines).set({ status: "rendering" }).where(eq(videoStorylines.id, storylineId));
    await db.update(videoShots).set({ status: "rendering" }).where(eq(videoShots.id, shotId));
    const [job] = await db
      .insert(videoShotRenderJobs)
      .values({
        companyId,
        storylineId,
        shotId,
        attempt: 1,
        provider: "fal",
        model: "some-model",
        externalId: "ext-1",
        status: "running",
      })
      .returning();

    const result = await videoStorylineRenderService(db).cancelRender(companyId, storylineId, ACTOR);
    expect(result.status).toBe("cancelled");

    const [shotRow] = await db.select().from(videoShots).where(eq(videoShots.id, shotId));
    expect(shotRow!.status).toBe("failed");
    expect(shotRow!.errorMessage).toBe("Cancelled by user.");

    const [jobRow] = await db.select().from(videoShotRenderJobs).where(eq(videoShotRenderJobs.id, job!.id));
    expect(jobRow!.status).toBe("failed");
    expect(jobRow!.error).toBe("Cancelled by user.");
    expect(jobRow!.completedAt).not.toBeNull();
  });

  it("refuses to cancel a storyline in a different company", async () => {
    const { storylineId } = await seedEnabledCompanyWithShot();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: `S${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(
      videoStorylineRenderService(db).cancelRender(otherCompanyId, storylineId, ACTOR),
    ).rejects.toMatchObject({ status: 404 });
  });
});
