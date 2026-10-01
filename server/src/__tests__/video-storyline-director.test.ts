import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createDb, companies, plugins, videoShots } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.ts";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.ts";

/**
 * DUR-4196: "idea -> AI prompts -> human approval -> render". draftShots is
 * one cheap, tool-less Anthropic call (same mocking shape as
 * mail-secretary-classifier.test.ts); approveRun/rejectRun are plain DB
 * state machines with no network involved.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping video storyline director tests: ${support.reason ?? "unsupported environment"}`);
}

const ACTOR: VideoStorylineActor = { actorType: "agent", actorId: "agent-1", agentId: null };
const previousApiKey = process.env.ANTHROPIC_API_KEY;

function mockAnthropicCreate(impl: (...args: unknown[]) => unknown) {
  const mockCreate = vi.fn(impl);
  vi.doMock("@anthropic-ai/sdk", async () => {
    const actual = await vi.importActual<typeof import("@anthropic-ai/sdk")>("@anthropic-ai/sdk");
    const RealDefault = (actual as { default: typeof actual.default }).default;
    class FakeAnthropic {
      static AuthenticationError = RealDefault.AuthenticationError;
      static RateLimitError = RealDefault.RateLimitError;
      static APIError = RealDefault.APIError;
      messages = { create: mockCreate };
      constructor(_opts: unknown) {}
    }
    return { ...actual, default: FakeAnthropic };
  });
  return mockCreate;
}

function draftedShotsResponse(count: number) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          shots: Array.from({ length: count }, (_, i) => ({
            prompt: `Shot ${i + 1}`,
            cameraNotes: null,
            durationSeconds: 5,
            castInView: ["Hero"],
          })),
        }),
      },
    ],
  };
}

d("videoStorylineDirectorService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-director");
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

  afterEach(() => {
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
    if (previousApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  });

  async function freshDirectorService() {
    const { videoStorylineDirectorService } = await import("../services/video-storyline-director.ts");
    return videoStorylineDirectorService(db);
  }

  async function seedStorylineAndScene(opts: { advanced?: boolean } = {}) {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Director Co",
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
        title: "Space Opera",
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
    const scene = await storylines.createScene(companyId, storyline.id, { title: "Bridge", notes: "The ship's bridge", orderIndex: 0 }, ACTOR);
    return { companyId, storylineId: storyline.id, sceneId: scene.id };
  }

  it("drafts shots from an idea and stores a ready_for_review run", async () => {
    const { companyId, storylineId, sceneId } = await seedStorylineAndScene();
    const mockCreate = mockAnthropicCreate((args: unknown) => {
      const call = args as { messages: Array<{ content: string }> };
      expect(call.messages[0]?.content).toContain("Captain orders a jump to hyperspace");
      expect(call.messages[0]?.content).toContain("no prior shots yet");
      return draftedShotsResponse(2);
    });
    const director = await freshDirectorService();

    const run = await director.draftShots(
      companyId,
      storylineId,
      { sceneId, idea: "Captain orders a jump to hyperspace", shotCount: 2 },
      ACTOR,
    );

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(run.status).toBe("ready_for_review");
    expect(run.draftedShots).toHaveLength(2);
    expect(run.draftedShots[0]).toMatchObject({ prompt: "Shot 1", durationSeconds: 5, castInView: ["Hero"] });
    expect(run.errorMessage).toBeNull();
  });

  it("includes recent shots as continuity context", async () => {
    const { companyId, storylineId, sceneId } = await seedStorylineAndScene();
    const storylines = videoStorylineService(db);
    await storylines.createShot(
      companyId,
      storylineId,
      { sceneId, orderIndex: 0, prompt: "The crew braces at their stations", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null },
      ACTOR,
    );
    mockAnthropicCreate((args: unknown) => {
      const call = args as { messages: Array<{ content: string }> };
      expect(call.messages[0]?.content).toContain("The crew braces at their stations");
      return draftedShotsResponse(1);
    });
    const director = await freshDirectorService();

    const run = await director.draftShots(companyId, storylineId, { sceneId, idea: "They jump", shotCount: 1 }, ACTOR);
    expect(run.status).toBe("ready_for_review");
  });

  it("stores a failed run (not a thrown error) when the model returns unparseable JSON", async () => {
    const { companyId, storylineId, sceneId } = await seedStorylineAndScene();
    mockAnthropicCreate(() => ({ content: [{ type: "text", text: "not json at all" }] }));
    const director = await freshDirectorService();

    const run = await director.draftShots(companyId, storylineId, { sceneId, idea: "Idea", shotCount: 1 }, ACTOR);

    expect(run.status).toBe("failed");
    expect(run.draftedShots).toEqual([]);
    expect(run.errorMessage).toBeTruthy();
  });

  it("refuses to draft when the round-2 advanced flag is off", async () => {
    const { companyId, storylineId, sceneId } = await seedStorylineAndScene({ advanced: false });
    mockAnthropicCreate(() => draftedShotsResponse(1));
    const director = await freshDirectorService();

    await expect(
      director.draftShots(companyId, storylineId, { sceneId, idea: "Idea", shotCount: 1 }, ACTOR),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("404s for a scene belonging to a different storyline", async () => {
    const { companyId, storylineId } = await seedStorylineAndScene();
    const storylines = videoStorylineService(db);
    const otherStoryline = await storylines.createStoryline(
      companyId,
      {
        title: "Other",
        projectId: null,
        providerId: "fal",
        model: null,
        budgetCapCents: 1000,
        characterReferenceAssetIds: [],
        defaultTransition: "cut",
        defaultTransitionDurationMs: 500,
        musicAssetId: null,
        musicSourceKey: null,
        musicVolumeDb: -18,
      },
      ACTOR,
    );
    const otherScene = await storylines.createScene(companyId, otherStoryline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
    mockAnthropicCreate(() => draftedShotsResponse(1));
    const director = await freshDirectorService();

    await expect(
      director.draftShots(companyId, storylineId, { sceneId: otherScene.id, idea: "Idea", shotCount: 1 }, ACTOR),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("approveRun copies selected drafted shots into real video_shots rows, continuing orderIndex", async () => {
    const { companyId, storylineId, sceneId } = await seedStorylineAndScene();
    const storylines = videoStorylineService(db);
    await storylines.createShot(
      companyId,
      storylineId,
      { sceneId, orderIndex: 0, prompt: "Existing shot", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null },
      ACTOR,
    );
    mockAnthropicCreate(() => draftedShotsResponse(3));
    const director = await freshDirectorService();
    const run = await director.draftShots(companyId, storylineId, { sceneId, idea: "Idea", shotCount: 3 }, ACTOR);

    const approved = await director.approveRun(companyId, storylineId, run.id, { selectedIndexes: [0, 2] }, ACTOR);

    expect(approved.status).toBe("approved");
    const shots = await storylines.listShots(companyId, storylineId);
    expect(shots).toHaveLength(3); // the pre-existing shot + 2 newly approved
    const newShots = shots.filter((s) => s.prompt !== "Existing shot").sort((a, b) => a.orderIndex - b.orderIndex);
    expect(newShots.map((s) => s.prompt)).toEqual(["Shot 1", "Shot 3"]);
    expect(newShots.map((s) => s.orderIndex)).toEqual([1, 2]);
  });

  it("approveRun defaults to every drafted shot when selectedIndexes is omitted", async () => {
    const { companyId, storylineId, sceneId } = await seedStorylineAndScene();
    mockAnthropicCreate(() => draftedShotsResponse(2));
    const director = await freshDirectorService();
    const run = await director.draftShots(companyId, storylineId, { sceneId, idea: "Idea", shotCount: 2 }, ACTOR);

    await director.approveRun(companyId, storylineId, run.id, {}, ACTOR);

    const storylines = videoStorylineService(db);
    const shots = await storylines.listShots(companyId, storylineId);
    expect(shots).toHaveLength(2);
  });

  it("refuses to approve a run that is not ready_for_review", async () => {
    const { companyId, storylineId, sceneId } = await seedStorylineAndScene();
    mockAnthropicCreate(() => draftedShotsResponse(1));
    const director = await freshDirectorService();
    const run = await director.draftShots(companyId, storylineId, { sceneId, idea: "Idea", shotCount: 1 }, ACTOR);
    await director.rejectRun(companyId, storylineId, run.id, ACTOR);

    await expect(
      director.approveRun(companyId, storylineId, run.id, {}, ACTOR),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejectRun marks a ready_for_review run rejected and leaves no shots behind", async () => {
    const { companyId, storylineId, sceneId } = await seedStorylineAndScene();
    mockAnthropicCreate(() => draftedShotsResponse(1));
    const director = await freshDirectorService();
    const run = await director.draftShots(companyId, storylineId, { sceneId, idea: "Idea", shotCount: 1 }, ACTOR);

    const rejected = await director.rejectRun(companyId, storylineId, run.id, ACTOR);

    expect(rejected.status).toBe("rejected");
    const shotRows = await db.select().from(videoShots).where(eq(videoShots.storylineId, storylineId));
    expect(shotRows).toHaveLength(0);
  });
});
