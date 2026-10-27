import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, plugins, videoShots, videoStorylines } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * DUR-4898: the film's rating reaches the video render. A safe-for-work film
 * says "Fully clothed." and what to keep out in every clip's prompt and
 * refuses a mature/uncensored model before the service is called; a mature
 * film sends its prompt as written. Providers are stubbed; nothing is paid.
 */
vi.mock("../services/fal-cost-events.ts", () => ({ recordFalCostEvent: async () => null }));

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping content-rating render tests: ${support.reason ?? "unsupported environment"}`);

const { videoStorylineRenderService } = await import("../services/video-storyline-render.ts");
const { videoStorylineSettingsService } = await import("../services/video-storyline-settings.ts");
const { videoStorylineService } = await import("../services/video-storylines.ts");
type Provider = import("../services/video-provider-clients.ts").MediaJobProvider;
type StartInput = Parameters<Provider["start"]>[0];

const ACTOR = { actorType: "user" as const, actorId: "filip", agentId: null };

function capturingProvider(): { provider: Provider; starts: StartInput[] } {
  const starts: StartInput[] = [];
  const provider = {
    name: "sogni",
    start: async (input: StartInput) => {
      starts.push(input);
      return { externalId: `wf-${starts.length}`, model: "ltx25", provider: "sogni" };
    },
    poll: async () => ({ status: "running" as const }),
    cancel: async () => undefined,
  } as unknown as Provider;
  return { provider, starts };
}

d("content rating reaches the video render", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-content-rating-render");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    const manifest = { id: "paperclip.media-studio", apiVersion: 1, version: "1.0.0", displayName: "Media Studio", description: "x", author: "x", categories: ["automation"], capabilities: [], entrypoints: { worker: "dist/worker.js" } } as unknown as PaperclipPluginManifestV1;
    await db.insert(plugins).values({ pluginKey: "paperclip.media-studio", packageName: "@paperclipai/plugin-media-studio", version: "1.0.0", manifestJson: manifest, status: "ready" });
  }, 120_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed(opts: { rating?: "sfw" | "mature"; model?: string | null } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Film Co", issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const settings = videoStorylineSettingsService(db);
    await settings.setEnabled(companyId, true);
    await settings.setAdvancedEnabled(companyId, true);
    const svc = videoStorylineService(db);
    const storyline = await svc.createStoryline(
      companyId,
      { title: "T", projectId: null, providerId: "sogni", model: opts.model ?? null, budgetCapCents: 100_000, characterReferenceAssetIds: [], defaultTransition: "cut", defaultTransitionDurationMs: 500, musicAssetId: null, musicSourceKey: null, musicVolumeDb: -18 },
      ACTOR,
    );
    if (opts.rating) await db.update(videoStorylines).set({ contentRating: opts.rating }).where(eq(videoStorylines.id, storyline.id));
    const scene = await svc.createScene(companyId, storyline.id, { title: "", notes: null, orderIndex: 0 }, ACTOR);
    const shot = await svc.createShot(companyId, storyline.id, { sceneId: scene.id, orderIndex: 0, prompt: "A woman walks on a beach", cameraNotes: null, durationSeconds: 5, lookReferenceAssetIds: [], transitionIn: null }, ACTOR);
    await db.update(videoShots).set({ storyboardStatus: "approved" }).where(eq(videoShots.id, shot.id));
    return { companyId, storylineId: storyline.id, shotId: shot.id };
  }

  const render = (p: Provider) => videoStorylineRenderService(db, { buildProvider: () => p, resolveApiKey: async () => "key" });

  it("a safe-for-work film's clip prompt carries 'Fully clothed.' and what to keep out", async () => {
    const { companyId, storylineId } = await seed();
    const cap = capturingProvider();
    await render(cap.provider).startRender(companyId, storylineId, ACTOR, {});
    expect(cap.starts).toHaveLength(1);
    expect(cap.starts[0]!.prompt).toContain("A woman walks on a beach");
    expect(cap.starts[0]!.prompt).toContain("Fully clothed. Keep out of the picture: nudity");
  });

  it("a mature film's prompt goes as written", async () => {
    const { companyId, storylineId } = await seed({ rating: "mature" });
    const cap = capturingProvider();
    await render(cap.provider).startRender(companyId, storylineId, ACTOR, {});
    expect(cap.starts[0]!.prompt).not.toContain("Fully clothed");
  });

  it("a safe-for-work film refuses a spicy or uncensored video model before the service is called; a mature film may use it", async () => {
    const sfw = await seed({ model: "wan3.0-spicy-video" });
    const cap = capturingProvider();
    await expect(render(cap.provider).startRender(sfw.companyId, sfw.storylineId, ACTOR, {})).rejects.toMatchObject({ status: 422, message: expect.stringContaining("made for mature pictures") });
    expect(cap.starts).toHaveLength(0);
    expect((await db.select().from(videoStorylines).where(eq(videoStorylines.id, sfw.storylineId)))[0]!.status).not.toBe("rendering");

    const mature = await seed({ rating: "mature", model: "wan3.0-spicy-video" });
    await render(cap.provider).startRender(mature.companyId, mature.storylineId, ACTOR, {});
    expect(cap.starts).toHaveLength(1);
  });
});
