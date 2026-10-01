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
 * DUR-4196: POST .../shots/:shotId/preview -- renderPreview's guard rails.
 * These never reach the Fal/Sogni HTTP call (resolveProviderApiKey runs
 * after every guard below), so no provider or secret mocking is needed --
 * same no-network-mocking posture as video-storyline-render-cancel.test.ts.
 * The provider-call plumbing itself (buildProvider/loadReferenceImages/
 * downloadResultBytes/extractLastFrameDataUri) is the same code path
 * beginShotRender already uses, so this file only covers what is new here:
 * the preview-specific guards and its preview_*-column side effect.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping video storyline preview tests: ${support.reason ?? "unsupported environment"}`);
}

const ACTOR: VideoStorylineActor = { actorType: "agent", actorId: "agent-1", agentId: null };

d("videoStorylineRenderService.renderPreview", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-preview");
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

  async function seedCompanyWithShot(opts: { advanced?: boolean; budgetCapCents?: number | null } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Preview Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const settings = videoStorylineSettingsService(db);
    await settings.setEnabled(companyId, true);
    if (opts.advanced !== false) await settings.setAdvancedEnabled(companyId, true);
    const storylines = videoStorylineService(db);
    const storyline = await storylines.createStoryline(
      companyId,
      {
        title: "T",
        projectId: null,
        providerId: "fal",
        model: null,
        budgetCapCents: opts.budgetCapCents === undefined ? 100_000 : opts.budgetCapCents,
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
      {
        sceneId: scene.id,
        orderIndex: 0,
        prompt: "A shot",
        cameraNotes: null,
        durationSeconds: 5,
        lookReferenceAssetIds: [],
        transitionIn: null,
      },
      ACTOR,
    );
    return { companyId, storylineId: storyline.id, shotId: shot.id };
  }

  it("refuses a storyline in a different company", async () => {
    const { storylineId, shotId } = await seedCompanyWithShot();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: `S${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // The other company must have round 1+2 switched on too, or
    // assertAdvancedEnabled's 422 would fire before the storyline lookup
    // ever runs -- this test is about company-scoping, not the flag.
    const otherSettings = videoStorylineSettingsService(db);
    await otherSettings.setEnabled(otherCompanyId, true);
    await otherSettings.setAdvancedEnabled(otherCompanyId, true);

    await expect(
      videoStorylineRenderService(db).renderPreview(otherCompanyId, storylineId, shotId, ACTOR),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses when the round-2 advanced flag is off (round 1 stays unaffected)", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot({ advanced: false });

    await expect(
      videoStorylineRenderService(db).renderPreview(companyId, storylineId, shotId, ACTOR),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("refuses while the storyline is actively stitching", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot();
    await db.update(videoStorylines).set({ status: "stitching" }).where(eq(videoStorylines.id, storylineId));

    await expect(
      videoStorylineRenderService(db).renderPreview(companyId, storylineId, shotId, ACTOR),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a shot that is already rendering", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot();
    await db.update(videoShots).set({ status: "rendering" }).where(eq(videoShots.id, shotId));

    await expect(
      videoStorylineRenderService(db).renderPreview(companyId, storylineId, shotId, ACTOR),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses when even a 1-second preview would exceed the budget cap", async () => {
    const { companyId, storylineId, shotId } = await seedCompanyWithShot({ budgetCapCents: 100_000 });
    await db.update(videoStorylines).set({ spentCents: 100_000 }).where(eq(videoStorylines.id, storylineId));

    await expect(
      videoStorylineRenderService(db).renderPreview(companyId, storylineId, shotId, ACTOR),
    ).rejects.toMatchObject({ status: 422 });

    const [row] = await db.select().from(videoShots).where(eq(videoShots.id, shotId));
    expect(row!.previewObjectKey).toBeNull();
  });
});
