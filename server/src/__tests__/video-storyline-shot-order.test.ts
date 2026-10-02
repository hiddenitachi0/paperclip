import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createDb, companies, plugins } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.ts";
import { videoStorylineService, type VideoStorylineActor } from "../services/video-storylines.ts";

/**
 * Filip, 2 Oct 2026: with 4 scenes drafted, adding the first shot to scene 2
 * failed with "A shot already exists at position 0." -- the board sent the
 * position within the scene, but positions are storyline-wide. The server now
 * places a new shot at the end of its own scene and renumbers in scene order.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const ACTOR: VideoStorylineActor = { actorType: "agent", actorId: "agent-1", agentId: null };

d("video storyline shot positions", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-shot-order");
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

  async function seed(sceneCount: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Shots Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await videoStorylineSettingsService(db).setEnabled(companyId, true);
    const storylines = videoStorylineService(db);
    const storyline = await storylines.createStoryline(
      companyId,
      {
        title: "Four scenes",
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
    const scenes = [];
    for (let i = 0; i < sceneCount; i += 1) {
      scenes.push(await storylines.createScene(companyId, storyline.id, { title: `Scene ${i + 1}`, notes: null, orderIndex: i }, ACTOR));
    }
    const add = (sceneIndex: number, prompt: string) =>
      storylines.createShot(
        companyId,
        storyline.id,
        // The board used to send the position within the scene: 0 for every first shot.
        { sceneId: scenes[sceneIndex]!.id, orderIndex: 0, prompt, cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null },
        ACTOR,
      );
    const order = async () =>
      (await storylines.listShots(companyId, storyline.id))
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map((shot) => shot.prompt);
    return { add, order };
  }

  it("adds the first shot of every scene without a position clash", async () => {
    const { add, order } = await seed(4);
    await add(0, "s1a");
    await add(1, "s2a");
    await add(2, "s3a");
    await add(3, "s4a");
    expect(await order()).toEqual(["s1a", "s2a", "s3a", "s4a"]);
  });

  it("keeps scene order when a shot is added to an earlier scene later", async () => {
    const { add, order } = await seed(3);
    await add(0, "s1a");
    await add(2, "s3a");
    await add(1, "s2a");
    await add(0, "s1b");
    await add(2, "s3b");
    expect(await order()).toEqual(["s1a", "s1b", "s2a", "s3a", "s3b"]);
  });
});
