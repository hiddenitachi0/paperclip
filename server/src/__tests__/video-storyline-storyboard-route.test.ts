import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createDb, agents, companies, plugins, videoShots } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.ts";
import { videoStorylineRoutes } from "../routes/video-storylines.ts";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.ts";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.ts";

/**
 * DUR-4317/DUR-4320: company-scoping + board-only enforcement for the
 * storyboard-of-stills routes -- GET .../storyboard, POST .../approve,
 * POST .../drop, and the board-only approval-threshold settings route.
 * generate-still needs a real image-generation provider call, so it's
 * covered at the service layer (video-storyline-stills-service.test.ts),
 * not here.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping video storyline storyboard route tests: ${support.reason ?? "unsupported environment"}`);
}

const ACTOR: VideoStorylineActor = { actorType: "agent", actorId: "agent-1", agentId: null };

d("video-storylines storyboard routes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  let actorType: "agent" | "board" = "agent";
  let agentCompanyId = "";
  let httpAgentId = "";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-storyboard-route");
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

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor =
        actorType === "agent"
          ? { type: "agent", agentId: httpAgentId, companyId: agentCompanyId }
          : { type: "board", source: "local_implicit", userId: "board" };
      next();
    });
    app.use("/api", videoStorylineRoutes(db));
    app.use(errorHandler);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedEnabledCompanyWithShot() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Route Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    httpAgentId = randomUUID();
    await db.insert(agents).values({
      id: httpAgentId,
      companyId,
      name: "AgentOne",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const storylines = videoStorylineService(db);
    const storyline = await storylines.createStoryline(
      companyId,
      { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] },
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

  it("returns the storyboard summary for an agent of that company", async () => {
    actorType = "agent";
    const { companyId, storylineId } = await seedEnabledCompanyWithShot();
    agentCompanyId = companyId;

    const res = await request(app).get(`/api/companies/${companyId}/video-storylines/${storylineId}/storyboard`);
    expect(res.status).toBe(200);
    expect(res.body.storylineId).toBe(storylineId);
    expect(res.body.allApproved).toBe(false);
    expect(res.body.shots).toHaveLength(1);
  });

  it("404s the storyboard summary for a different company (company-scoping)", async () => {
    // A local-implicit board actor, same as video-storyline-content-route.test.ts --
    // it bypasses the company-membership check in assertCompanyAccess, so a
    // mismatch here can only come from the SERVICE's own company-scoped
    // lookup, which is the boundary this test is actually about.
    actorType = "board";
    const { storylineId } = await seedEnabledCompanyWithShot();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: `S${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await videoStorylineSettingsService(db).setEnabled(otherCompanyId, true);

    const res = await request(app).get(`/api/companies/${otherCompanyId}/video-storylines/${storylineId}/storyboard`);
    expect(res.status).toBe(404);
  });

  it("422s a shot approve request with no still yet", async () => {
    actorType = "agent";
    const { companyId, storylineId, shotId } = await seedEnabledCompanyWithShot();
    agentCompanyId = companyId;

    const res = await request(app).post(`/api/companies/${companyId}/video-storylines/${storylineId}/shots/${shotId}/approve`).send({});
    expect(res.status).toBe(422);
  });

  it("approves a shot that already has a still", async () => {
    actorType = "agent";
    const { companyId, storylineId, shotId } = await seedEnabledCompanyWithShot();
    agentCompanyId = companyId;
    await db.update(videoShots).set({ stillObjectKey: "stills/fake.jpg", stillProvider: "local", stillContentType: "image/jpeg" }).where(eq(videoShots.id, shotId));

    const res = await request(app).post(`/api/companies/${companyId}/video-storylines/${storylineId}/shots/${shotId}/approve`).send({});
    expect(res.status).toBe(200);
    expect(res.body.storyboardStatus).toBe("approved");
  });

  it("drops a shot in another company 404s instead of touching it (company-scoping)", async () => {
    actorType = "board";
    const { storylineId, shotId } = await seedEnabledCompanyWithShot();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co 2",
      issuePrefix: `S${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await videoStorylineSettingsService(db).setEnabled(otherCompanyId, true);

    const res = await request(app).post(`/api/companies/${otherCompanyId}/video-storylines/${storylineId}/shots/${shotId}/drop`).send({});
    expect(res.status).toBe(404);

    const [row] = await db.select().from(videoShots).where(eq(videoShots.id, shotId));
    expect(row!.storyboardStatus).toBe("pending");
  });

  it("rejects an agent setting the company's approval threshold (board-only)", async () => {
    actorType = "agent";
    const { companyId } = await seedEnabledCompanyWithShot();
    agentCompanyId = companyId;

    const res = await request(app)
      .patch(`/api/companies/${companyId}/video-storylines/settings/approval-threshold`)
      .send({ thresholdCents: 500 });
    expect(res.status).toBe(403);
  });

  it("lets the board set and read back the company's approval threshold", async () => {
    const { companyId } = await seedEnabledCompanyWithShot();
    actorType = "board";

    const patchRes = await request(app)
      .patch(`/api/companies/${companyId}/video-storylines/settings/approval-threshold`)
      .send({ thresholdCents: 500 });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.thresholdCents).toBe(500);

    const getRes = await request(app).get(`/api/companies/${companyId}/video-storylines/settings/approval-threshold`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.thresholdCents).toBe(500);
  });
});
