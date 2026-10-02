import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createDb, companies, plugins, videoShots, videoStorylines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { videoStorylineRenderService } from "../services/video-storyline-render.ts";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.ts";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.ts";

/**
 * DUR-4127: the budget-cap gate in startRender/reRenderShot -- the ticket's
 * hard requirement that a render never starts (or continues) past its cap
 * without an explicit confirmBudgetCapCents. These paths all throw before
 * ever reaching a real Fal/Sogni provider call, so they need no network
 * mocking to exercise -- see beginShotRender in video-storyline-render.ts
 * for where a real provider call would happen instead.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping video storyline render budget tests: ${support.reason ?? "unsupported environment"}`);
}

const ACTOR: VideoStorylineActor = { actorType: "agent", actorId: "agent-1", agentId: null };

d("videoStorylineRenderService budget gate", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-render-budget");
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

  async function seedEnabledCompanyWithShot(budgetCapCents: number | null) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Render Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const storylines = videoStorylineService(db);
    const storyline = await storylines.createStoryline(
      companyId,
      { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents, characterReferenceAssetIds: [] },
      ACTOR,
    );
    const scene = await storylines.createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
    const shot = await storylines.createShot(
      companyId,
      storyline.id,
      { sceneId: scene.id, orderIndex: 0, prompt: "A shot", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [] },
      ACTOR,
    );
    // These tests are about the budget-cap gate, not the separate
    // DUR-4317/DUR-4320 storyboard-approval gate -- pre-approve the shot
    // (bypassing the real still-generation flow, which has its own
    // dedicated tests) so startRender/reRenderShot reach the budget checks.
    await db.update(videoShots).set({ storyboardStatus: "approved" }).where(eq(videoShots.id, shot.id));
    return { companyId, storylineId: storyline.id };
  }

  it("refuses to start a render for a company with the feature switched off", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Off Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const storylines = videoStorylineService(db);
    const storyline = await storylines.createStoryline(
      companyId,
      { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: 100_000, characterReferenceAssetIds: [] },
      ACTOR,
    );

    await expect(
      videoStorylineRenderService(db).startRender(companyId, storyline.id, ACTOR, {}),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("refuses to start without a budget cap and no confirmBudgetCapCents", async () => {
    const { companyId, storylineId } = await seedEnabledCompanyWithShot(null);

    await expect(
      videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {}),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to start when the estimate exceeds the budget cap", async () => {
    // fal is 50 cents/second x 5s = 250 cents; cap it at 100.
    const { companyId, storylineId } = await seedEnabledCompanyWithShot(100);

    await expect(
      videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {}),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("refuses to start when there are no shots yet", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Empty Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const storyline = await videoStorylineService(db).createStoryline(
      companyId,
      { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: 100_000, characterReferenceAssetIds: [] },
      ACTOR,
    );

    await expect(
      videoStorylineRenderService(db).startRender(companyId, storyline.id, ACTOR, {}),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("refuses to re-render a shot that is already rendering", async () => {
    const { companyId, storylineId } = await seedEnabledCompanyWithShot(100_000);
    const shots = await videoStorylineService(db).listShots(companyId, storylineId);
    const shotId = shots[0]!.id;
    await db.update(videoShots).set({ status: "rendering" }).where(eq(videoShots.id, shotId));

    await expect(
      videoStorylineRenderService(db).reRenderShot(companyId, storylineId, shotId, ACTOR),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses to re-render a shot when it would push spend over the budget cap", async () => {
    // fal is 50 cents/second x 5s = 250 cents; cap it at 100 so any re-render is over budget.
    const { companyId, storylineId } = await seedEnabledCompanyWithShot(100);
    const shots = await videoStorylineService(db).listShots(companyId, storylineId);
    const shotId = shots[0]!.id;
    await db.update(videoShots).set({ status: "failed" }).where(eq(videoShots.id, shotId));

    await expect(
      videoStorylineRenderService(db).reRenderShot(companyId, storylineId, shotId, ACTOR),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("refuses to re-render a shot while the storyline is actively stitching", async () => {
    const { companyId, storylineId } = await seedEnabledCompanyWithShot(100_000);
    const shots = await videoStorylineService(db).listShots(companyId, storylineId);
    const shotId = shots[0]!.id;
    await db.update(videoShots).set({ status: "failed" }).where(eq(videoShots.id, shotId));
    await db.update(videoStorylines).set({ status: "stitching" }).where(eq(videoStorylines.id, storylineId));

    await expect(
      videoStorylineRenderService(db).reRenderShot(companyId, storylineId, shotId, ACTOR),
    ).rejects.toMatchObject({ status: 409 });
  });
});
