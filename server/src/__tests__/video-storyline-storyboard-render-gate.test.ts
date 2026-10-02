import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { approvals as approvalsTable, createDb, companies, plugins, videoShots, videoStorylines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { approvalService } from "../services/approvals.ts";
import { videoStorylineRenderService } from "../services/video-storyline-render.ts";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.ts";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.ts";

/**
 * DUR-4317/DUR-4320: the storyboard-of-stills approval gate in
 * video-storyline-render.ts -- startRender/beginShotRender must refuse a
 * shot whose storyboardStatus isn't 'approved' BEFORE ever reaching
 * resolveProviderApiKey/the real Fal/Sogni call, and the company threshold
 * gate must file (and wait on) a kind:"video_render" board approval. No
 * media-studio plugin config (falKeySecretRef) is seeded in these tests --
 * same no-provider-mocking posture as video-storyline-render-budget.test.ts
 * and video-storyline-preview.test.ts -- so if the storyboard/threshold
 * gates did NOT fire first, the call would instead fail with a distinct
 * "No Fal.ai API key is configured" error, which these tests check against
 * to prove the gate -- not a missing API key -- is what stopped it.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping video storyline storyboard render-gate tests: ${support.reason ?? "unsupported environment"}`);
}

const ACTOR: VideoStorylineActor = { actorType: "agent", actorId: "agent-1", agentId: null };

d("videoStorylineRenderService storyboard-of-stills gate", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-storyboard-gate");
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

  async function seedCompanyWithShot(opts: { shotCount?: number; thresholdCents?: number | null } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Storyboard Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const settings = videoStorylineSettingsService(db);
    await settings.setEnabled(companyId, true);
    if (opts.thresholdCents !== undefined) {
      await settings.setApprovalThresholdCents(companyId, opts.thresholdCents);
    }
    const storylines = videoStorylineService(db);
    const storyline = await storylines.createStoryline(
      companyId,
      {
        title: "T",
        projectId: null,
        providerId: "fal",
        model: null,
        budgetCapCents: 1_000_000,
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
    const shotIds: string[] = [];
    for (let i = 0; i < (opts.shotCount ?? 1); i += 1) {
      const shot = await storylines.createShot(
        companyId,
        storyline.id,
        { sceneId: scene.id, orderIndex: i, prompt: `Shot ${i}`, cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null },
        ACTOR,
      );
      shotIds.push(shot.id);
    }
    return { companyId, storylineId: storyline.id, shotIds };
  }

  async function approveShotDirectly(shotId: string) {
    // Bypasses generateStill (which needs a real image-generation provider)
    // -- sets exactly what approveShot itself would persist after a still
    // exists, so these render-gate tests don't need network mocking either.
    await db.update(videoShots).set({ storyboardStatus: "approved", stillObjectKey: "stills/fake.jpg", stillProvider: "local", stillContentType: "image/jpeg" }).where(eq(videoShots.id, shotId));
  }

  it("refuses to start a render when a shot's storyboard still has not been approved", async () => {
    const { companyId, storylineId } = await seedCompanyWithShot();

    await expect(
      videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {}),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("storyboard") });
  });

  it("never reaches the video provider for a shot stuck at the default 'pending' storyboard status", async () => {
    const { companyId, storylineId } = await seedCompanyWithShot();

    // No falKeySecretRef is configured anywhere in this test file -- if the
    // code reached resolveProviderApiKey, the error would be "No Fal.ai API
    // key is configured" instead. Getting the storyboard-specific message
    // proves the provider call was never attempted.
    await expect(
      videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {}),
    ).rejects.toMatchObject({ message: expect.not.stringContaining("Fal.ai API key") });
  });

  it("lets a render proceed past the storyboard gate once every shot is approved (and then fails for the unrelated reason of no configured provider key)", async () => {
    const { companyId, storylineId, shotIds } = await seedCompanyWithShot();
    await approveShotDirectly(shotIds[0]!);

    await expect(
      videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {}),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("Fal.ai API key") });
  });

  it("excludes a dropped shot from the storyboard gate and the render queue", async () => {
    const { companyId, storylineId, shotIds } = await seedCompanyWithShot({ shotCount: 2 });
    await approveShotDirectly(shotIds[0]!);
    await db.update(videoShots).set({ storyboardStatus: "dropped" }).where(eq(videoShots.id, shotIds[1]!));

    // Shot 1 is dropped (never needs approval); shot 0 is approved -- so
    // this should clear the storyboard gate and fail only on the
    // unconfigured provider key, same as the all-approved case above.
    await expect(
      videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {}),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("Fal.ai API key") });
  });

  it("refuses to re-render a dropped shot", async () => {
    const { companyId, storylineId, shotIds } = await seedCompanyWithShot();
    await db.update(videoShots).set({ storyboardStatus: "dropped" }).where(eq(videoShots.id, shotIds[0]!));

    await expect(
      videoStorylineRenderService(db).reRenderShot(companyId, storylineId, shotIds[0]!, ACTOR),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("files a kind:\"video_render\" board approval and refuses to start once the estimate crosses the company's threshold", async () => {
    const { companyId, storylineId, shotIds } = await seedCompanyWithShot({ thresholdCents: 100 });
    await approveShotDirectly(shotIds[0]!);
    // fal is 50 cents/second x 5s = 250 cents > the 100-cent threshold.

    await expect(
      videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {}),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("threshold") });

    const rows = await db.select().from(approvalsTable);
    const filed = rows.find((a) => a.companyId === companyId && (a.payload as Record<string, unknown>)?.kind === "video_render");
    expect(filed).toBeDefined();
    expect((filed!.payload as Record<string, unknown>).storylineId).toBe(storylineId);
    expect((filed!.payload as Record<string, unknown>).estimatedTotalCents).toBe(250);
    expect(filed!.status).toBe("pending");

    // Calling startRender again must not file a second card for the same estimate.
    await expect(
      videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {}),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("threshold") });
    const rowsAfterRetry = await db.select().from(approvalsTable);
    expect(rowsAfterRetry.filter((a) => a.companyId === companyId).length).toBe(1);
  });

  it("lets startRender proceed once the board approves the filed video_render card for the exact same estimate", async () => {
    const { companyId, storylineId, shotIds } = await seedCompanyWithShot({ thresholdCents: 100 });
    await approveShotDirectly(shotIds[0]!);

    await expect(videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {})).rejects.toMatchObject({ status: 422 });

    const approvals = approvalService(db);
    const open = await approvals.findOpenVideoRenderApproval(companyId, storylineId);
    expect(open).not.toBeNull();
    await approvals.approve(open!.id, "board-user-1");

    // Now past the threshold gate too -- fails only on the unconfigured provider key.
    await expect(
      videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {}),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("Fal.ai API key") });
  });

  it("does not gate on the threshold at all when no threshold is configured", async () => {
    const { companyId, storylineId, shotIds } = await seedCompanyWithShot();
    await approveShotDirectly(shotIds[0]!);

    await expect(
      videoStorylineRenderService(db).startRender(companyId, storylineId, ACTOR, {}),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("Fal.ai API key") });
  });
});
