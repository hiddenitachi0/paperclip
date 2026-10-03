import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createDb, companies, plugins, videoShots, videoStorylines } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { VideoStorylineActor } from "../services/video-storylines.ts";

/**
 * DUR-4170: GET .../final/content end to end -- a real embedded-postgres db
 * (so gatedScope's company/feature-flag checks are exercised for real)
 * with a mocked StorageService (so this stays independent of the real
 * storage subsystem's own config/bind validation, which is unrelated to
 * this route). Mirrors assets.ts's GET /assets/:id/content, which this
 * route was modeled on.
 */
const mockGetObject = vi.hoisted(() => vi.fn());
vi.mock("../storage/index.ts", () => ({
  getStorageService: () => ({ getObject: mockGetObject }),
}));

const { errorHandler } = await import("../middleware/index.ts");
const { videoStorylineRoutes } = await import("../routes/video-storylines.ts");
const { videoStorylineSettingsService } = await import("../services/video-storyline-settings.ts");
const { videoStorylineService } = await import("../services/video-storylines.ts");

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping video storyline content route tests: ${support.reason ?? "unsupported environment"}`);
}

const ACTOR: VideoStorylineActor = { actorType: "agent", actorId: "agent-1", agentId: null };

d("GET /companies/:companyId/video-storylines/:storylineId/final/content", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-content-route");
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
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "board" };
      next();
    });
    app.use("/api", videoStorylineRoutes(db));
    app.use(errorHandler);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedEnabledCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Content Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    return companyId;
  }

  it("404s when the storyline has no finished video yet", async () => {
    const companyId = await seedEnabledCompany();
    const storyline = await videoStorylineService(db).createStoryline(
      companyId,
      { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] },
      ACTOR,
    );

    const res = await request(app).get(`/api/companies/${companyId}/video-storylines/${storyline.id}/final/content`);
    expect(res.status).toBe(404);
    expect(mockGetObject).not.toHaveBeenCalled();
  });

  it("streams the stitched video with the right headers once finalObjectKey is set", async () => {
    const companyId = await seedEnabledCompany();
    const storyline = await videoStorylineService(db).createStoryline(
      companyId,
      { title: "My Film", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] },
      ACTOR,
    );
    const body = Buffer.from("fake mp4 bytes");
    await db
      .update(videoStorylines)
      .set({
        status: "done",
        finalProvider: "local_disk",
        finalObjectKey: "video-storylines/fake-key.mp4",
        finalContentType: "video/mp4",
        finalByteSize: body.byteLength,
      })
      .where(eq(videoStorylines.id, storyline.id));

    mockGetObject.mockResolvedValueOnce({
      stream: Readable.from(body),
      contentType: "video/mp4",
      contentLength: body.byteLength,
    });

    const res = await request(app).get(`/api/companies/${companyId}/video-storylines/${storyline.id}/final/content`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["content-disposition"]).toContain('filename="My Film.mp4"');
    expect(Buffer.compare(res.body as Buffer, body)).toBe(0);
    expect(mockGetObject).toHaveBeenCalledWith(companyId, "video-storylines/fake-key.mp4");
  });

  describe("GET .../shots/:shotId/still/content (DUR-4425)", () => {
    async function seedShot() {
      const companyId = await seedEnabledCompany();
      const svc = videoStorylineService(db);
      const storyline = await svc.createStoryline(
        companyId,
        { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] },
        ACTOR,
      );
      const scene = await svc.createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
      const shot = await svc.createShot(
        companyId,
        storyline.id,
        { sceneId: scene.id, orderIndex: 0, prompt: "A shot", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null },
        ACTOR,
      );
      return { companyId, storylineId: storyline.id, shotId: shot.id };
    }
    const url = (c: string, st: string, sh: string) => `/api/companies/${c}/video-storylines/${st}/shots/${sh}/still/content`;

    it("404s when the shot has no still yet", async () => {
      mockGetObject.mockClear();
      const { companyId, storylineId, shotId } = await seedShot();
      const res = await request(app).get(url(companyId, storylineId, shotId));
      expect(res.status).toBe(404);
      expect(mockGetObject).not.toHaveBeenCalled();
    });

    it("streams the still with its stored content type", async () => {
      const { companyId, storylineId, shotId } = await seedShot();
      const body = Buffer.from("fake jpeg bytes");
      await db
        .update(videoShots)
        .set({ stillProvider: "local_disk", stillObjectKey: "stills/k.jpg", stillContentType: "image/jpeg", stillByteSize: body.byteLength })
        .where(eq(videoShots.id, shotId));
      mockGetObject.mockResolvedValueOnce({ stream: Readable.from(body), contentType: "application/octet-stream", contentLength: body.byteLength });

      const res = await request(app).get(url(companyId, storylineId, shotId));
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/jpeg");
      expect(Buffer.compare(res.body as Buffer, body)).toBe(0);
      expect(mockGetObject).toHaveBeenCalledWith(companyId, "stills/k.jpg");
    });

    it("404s for another company's shot without reading storage", async () => {
      const { companyId, storylineId, shotId } = await seedShot();
      await db.update(videoShots).set({ stillObjectKey: "stills/k.jpg", stillContentType: "image/jpeg" }).where(eq(videoShots.id, shotId));
      const other = await seedEnabledCompany();
      mockGetObject.mockClear();
      const res = await request(app).get(url(other, storylineId, shotId));
      expect(res.status).toBe(404);
      expect(mockGetObject).not.toHaveBeenCalled();
      expect(companyId).not.toBe(other);
    });
  });
});
