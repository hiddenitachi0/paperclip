import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { activityLog, agents, companies, createDb, plugins, videoStorylines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.ts";
import { videoStorylineRoutes } from "../routes/video-storylines.ts";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.ts";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.ts";

/**
 * DUR-4898: a film is safe for work until its owner switches it. Only the
 * owner (until D1 is answered) can switch it to mature, with an explicit
 * confirmation, logged with actor and time; an admin may only go back to safe
 * for work; agents are always refused.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping content-rating route tests: ${support.reason ?? "unsupported environment"}`);

const SEED_ACTOR: VideoStorylineActor = { actorType: "user", actorId: "seed", agentId: null };

type Who = "agent" | "owner" | "admin" | "operator" | "local";

d("video-storylines content rating route", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  let who: Who = "owner";
  let companyId = "";
  let agentId = "";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-content-rating");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    const manifest = {
      id: "paperclip.media-studio", apiVersion: 1, version: "1.0.0", displayName: "Media Studio", description: "Media generation",
      author: "Paperclip", categories: ["automation"], capabilities: [], entrypoints: { worker: "dist/worker.js" },
    } as unknown as PaperclipPluginManifestV1;
    await db.insert(plugins).values({ pluginKey: "paperclip.media-studio", packageName: "@paperclipai/plugin-media-studio", version: "1.0.0", manifestJson: manifest, status: "ready" });

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (who === "agent") req.actor = { type: "agent", agentId, companyId };
      else if (who === "local") req.actor = { type: "board", source: "local_implicit", userId: "board" };
      else {
        const role = who === "owner" ? "owner" : who === "admin" ? "admin" : "operator";
        req.actor = {
          type: "board", source: "session", userId: `user-${who}`, isInstanceAdmin: false, companyIds: [companyId],
          memberships: [{ companyId, status: "active", membershipRole: role }],
        } as typeof req.actor;
      }
      next();
    });
    app.use("/api", videoStorylineRoutes(db));
    app.use(errorHandler);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Rating Co", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "AgentOne", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const storyline = await videoStorylineService(db).createStoryline(
      companyId,
      { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] },
      SEED_ACTOR,
    );
    return storyline.id;
  }

  const url = (storylineId: string) => `/api/companies/${companyId}/video-storylines/${storylineId}/content-rating`;
  const rowOf = async (storylineId: string) => (await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId)))[0]!;

  it("a new film is safe for work, with nobody recorded as having set it", async () => {
    who = "owner";
    const id = await seed();
    const res = await request(app).get(`/api/companies/${companyId}/video-storylines/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ contentRating: "sfw", contentRatingSetBy: null, contentRatingSetAt: null });
  });

  it("the rating cannot be set through create or update", async () => {
    who = "owner";
    const id = await seed();
    const patch = await request(app).patch(`/api/companies/${companyId}/video-storylines/${id}`).send({ contentRating: "mature" });
    expect(patch.status).toBe(400);
    const create = await request(app).post(`/api/companies/${companyId}/video-storylines`).send({ title: "X", contentRating: "mature" });
    expect(create.status).toBe(400);
    expect((await rowOf(id)).contentRating).toBe("sfw");
  });

  it("an agent is always refused, for mature and for sfw", async () => {
    const id = await seed();
    who = "agent";
    for (const contentRating of ["mature", "sfw"]) {
      const res = await request(app).put(url(id)).send({ contentRating, confirmed: true });
      expect(res.status).toBe(403);
    }
    expect((await rowOf(id)).contentRating).toBe("sfw");
  });

  it("an admin and an operator cannot switch a film to mature (owner only until D1)", async () => {
    const id = await seed();
    for (const person of ["admin", "operator"] as const) {
      who = person;
      const res = await request(app).put(url(id)).send({ contentRating: "mature", confirmed: true });
      expect(res.status).toBe(403);
    }
    const row = await rowOf(id);
    expect(row.contentRating).toBe("sfw");
    expect(row.contentRatingSetBy).toBeNull();
  });

  it("the owner needs the confirmation, then switches; actor and time are kept and logged", async () => {
    const id = await seed();
    who = "owner";
    const unconfirmed = await request(app).put(url(id)).send({ contentRating: "mature" });
    expect(unconfirmed.status).toBe(422);
    expect((await rowOf(id)).contentRating).toBe("sfw");

    const before = Date.now();
    const res = await request(app).put(url(id)).send({ contentRating: "mature", confirmed: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ contentRating: "mature", contentRatingSetBy: "user-owner" });
    expect(new Date(res.body.contentRatingSetAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    const row = await rowOf(id);
    expect(row).toMatchObject({ contentRating: "mature", contentRatingSetBy: "user-owner" });

    const [log] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, id), eq(activityLog.action, "video_storyline.content_rating_changed")));
    expect(log).toBeTruthy();
    expect(log!.actorId).toBe("user-owner");
    expect(log!.details).toMatchObject({ from: "sfw", to: "mature", setBy: "user-owner" });
  });

  it("an admin may put a mature film back to safe for work; an agent may not", async () => {
    const id = await seed();
    who = "owner";
    await request(app).put(url(id)).send({ contentRating: "mature", confirmed: true }).expect(200);
    who = "agent";
    await request(app).put(url(id)).send({ contentRating: "sfw" }).expect(403);
    who = "operator";
    await request(app).put(url(id)).send({ contentRating: "sfw" }).expect(403);
    who = "admin";
    const res = await request(app).put(url(id)).send({ contentRating: "sfw" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ contentRating: "sfw", contentRatingSetBy: "user-admin" });
  });

  it("the local single-user board (the owner of its own machine) may switch", async () => {
    const id = await seed();
    who = "local";
    const res = await request(app).put(url(id)).send({ contentRating: "mature", confirmed: true });
    expect(res.status).toBe(200);
  });

  it("rejects a value that is neither sfw nor mature", async () => {
    const id = await seed();
    who = "owner";
    expect((await request(app).put(url(id)).send({ contentRating: "adult", confirmed: true })).status).toBe(400);
  });
});
