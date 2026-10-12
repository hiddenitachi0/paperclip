import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, companies, videoStorylines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { videoStorylineStitchService } from "../services/video-storyline-stitch.ts";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.ts";

/**
 * DUR-4127: the ground rule the ticket is explicit about -- a host without
 * ffmpeg must never be installed into or blocked on; it parks the storyline
 * with stitchBlockedReason set and moves on. ffmpeg availability is forced
 * to "missing" here so the test means the same on a host that does have it
 * (the real stitch path is covered by video-storyline-e2e-routes.test.ts).
 */
vi.mock("../services/video-ffmpeg.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/video-ffmpeg.ts")>()),
  checkFfmpegAvailable: async () => false,
}));
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping video storyline stitch service tests: ${support.reason ?? "unsupported environment"}`);
}

const ACTOR: VideoStorylineActor = { actorType: "agent", actorId: "agent-1", agentId: null };

d("videoStorylineStitchService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-stitch");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedReadyToStitchStoryline() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Stitch Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const storyline = await videoStorylineService(db).createStoryline(
      companyId,
      { title: "T", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] },
      ACTOR,
    );
    await db.update(videoStorylines).set({ status: "ready_to_stitch" }).where(eq(videoStorylines.id, storyline.id));
    return { companyId, storylineId: storyline.id };
  }

  it("parks a storyline with stitchBlockedReason set when ffmpeg is unavailable, without failing it", async () => {
    const { companyId, storylineId } = await seedReadyToStitchStoryline();

    const result = await videoStorylineStitchService(db).tick();
    expect(result.blocked).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const [row] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, storylineId));
    expect(row!.status).toBe("ready_to_stitch");
    expect(row!.stitchBlockedReason).toContain("ffmpeg");
    void companyId;
  });

  it("only picks up storylines that are ready_to_stitch", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Other Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const storyline = await videoStorylineService(db).createStoryline(
      companyId,
      { title: "Draft one", projectId: null, providerId: "fal", model: null, budgetCapCents: null, characterReferenceAssetIds: [] },
      ACTOR,
    );

    await videoStorylineStitchService(db).tick();

    const [row] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, storyline.id));
    expect(row!.status).toBe("draft");
    expect(row!.stitchBlockedReason).toBeNull();
  });
});
