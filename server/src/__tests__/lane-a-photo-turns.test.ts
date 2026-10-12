import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  assets,
  companies,
  costEvents,
  createDb,
  issueAttachments,
  laneAConversations,
  laneAMessages,
  modelDirectoryEntries,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import { readLaneAPictureModelId, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";
import type { StorageService } from "../storage/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import {
  LANE_A_PICTURE_POOL_ID,
  resolveLaneARouting,
  withLaneAPhotoBase,
  withLaneAPictureModelStart,
  type LaneATargetAgent,
} from "../services/lane-a.ts";
import {
  buildLaneAPhotoFallbackLine,
  detectLaneAActionClaim,
  detectLaneAPhotoClaim,
  detectLaneAPhotoFollowUp,
  detectLaneAPictureEditRequest,
} from "../services/lane-a-action-claims.ts";

/**
 * 11 Oct, 01:16-01:20 UTC: Maja (a quick agent on a small local model) got a
 * second photo with "You left out my colleague, I want to see you and him
 * working together on the meat" and answered "here we are, working together
 * on the meat!" without calling any picture tool. Neither the edit-request
 * check nor the claim check matched, so the one forced retry never fired.
 * The model, the plugin worker and the file storage are fakes; nothing paid
 * is called.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FIRST_CAPTION = "I have a friend helping us in his kitchen, alter this image to show you helping him prepare the meat on the counter";
const SECOND_CAPTION = "You left out my colleague, I want to see you and him working together on the meat";
const FAKE_CLAIM = "here we are, working together on the meat!";
const PLUGIN_KEY = "paperclip.media-studio";
const PLUGIN_TOOL = "generate-image";
const PLUGIN_TOOL_NAMESPACED = `${PLUGIN_KEY}:${PLUGIN_TOOL}`;
const PLUGIN_TOOL_MODEL_NAME = "paperclip_media-studio__generate-image";

describe("photo turns (pure)", () => {
  it("the 11 Oct follow-up counts as a request to change the photo, and the reply as a claim", () => {
    expect(detectLaneAPictureEditRequest(SECOND_CAPTION)).toBe(true);
    // The strict claim check (used in every turn) still does not match it...
    expect(detectLaneAActionClaim(FAKE_CLAIM)).toBeNull();
    // ...the photo-turn check does.
    expect(detectLaneAPhotoClaim(FAKE_CLAIM)).toMatchObject({ family: "media" });
    expect(detectLaneAPhotoClaim("I've added myself next to him at the counter.")).toMatchObject({ family: "media" });
    expect(detectLaneAPhotoClaim("Her er vi, sammen på kjøkkenet!")).toMatchObject({ family: "media" });
    expect(detectLaneAPhotoClaim("Who is your colleague?")).toBeNull();
    // A memory claim is not a picture claim.
    expect(detectLaneAPhotoClaim("I've remembered that.")).toBeNull();
  });

  it("knows a follow-up about the photo from ordinary chat", () => {
    expect(detectLaneAPhotoFollowUp(SECOND_CAPTION)).toBe(true);
    expect(detectLaneAPhotoFollowUp("make it darker")).toBe(true);
    expect(detectLaneAPhotoFollowUp("where is my colleague?")).toBe(true);
    expect(detectLaneAPhotoFollowUp("du glemte kollegaen min")).toBe(true);
    expect(detectLaneAPhotoFollowUp("thanks!")).toBe(false);
    expect(detectLaneAPhotoFollowUp("what time is it in Oslo?")).toBe(false);
  });

  it("puts the photo first in a Generate image call that left it out, and only there", () => {
    const photo = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(withLaneAPhotoBase({ prompt: "x" }, PLUGIN_TOOL_NAMESPACED, photo, [photo])).toEqual({ prompt: "x", referenceFileIds: [photo] });
    expect(withLaneAPhotoBase({ prompt: "x", referenceFileIds: ["other"] }, PLUGIN_TOOL_NAMESPACED, photo, [photo])).toEqual({
      prompt: "x",
      referenceFileIds: [photo, "other"],
    });
    // Already there (any of the conversation's photos): unchanged.
    const already = { prompt: "x", referenceFileIds: [photo.toUpperCase()] };
    expect(withLaneAPhotoBase(already, PLUGIN_TOOL_NAMESPACED, photo, [photo])).toBe(already);
    // Another tool, or no photo this turn: unchanged.
    expect(withLaneAPhotoBase({ prompt: "x" }, `${PLUGIN_KEY}:quick-picture`, photo, [photo])).toEqual({ prompt: "x" });
    expect(withLaneAPhotoBase({ prompt: "x" }, PLUGIN_TOOL_NAMESPACED, null, [])).toEqual({ prompt: "x" });
  });

  it("a picture turn starts at the picture model, then the usual chain", () => {
    const base = resolveLaneARouting(
      {
        laneAProvider: "local",
        laneAModel: "huihui_ai/qwen3-abliterated:14b",
        laneABackupModels: [{ id: "b1", provider: "openrouter", model: "x/y", baseUrl: "https://openrouter.ai/api/v1" }],
        laneANoAnswerChainIds: ["b1"],
      },
      "hello",
    );
    const pool = new Map(base.pool).set(LANE_A_PICTURE_POOL_ID, { id: LANE_A_PICTURE_POOL_ID, provider: "anthropic", model: "claude-sonnet-5" });
    const routed = withLaneAPictureModelStart({ ...base, pool }, true);
    expect(routed.start).toBe(LANE_A_PICTURE_POOL_ID);
    expect(routed.startRule).toBe("picture_model");
    expect(routed.noAnswerChain).toEqual([LANE_A_PICTURE_POOL_ID, "main", "b1"]);
    // Not a picture turn, or no picture model: unchanged.
    expect(withLaneAPictureModelStart({ ...base, pool }, false).start).toBe("main");
    expect(withLaneAPictureModelStart(base, true)).toBe(base);
  });

  it("the honest line says no picture was made, and why", () => {
    expect(buildLaneAPhotoFallbackLine(null)).toBe("No picture was made: the picture tool was not started this time. Ask me again to try once more.");
    expect(buildLaneAPhotoFallbackLine("That did not work: Daily image limit (5) reached for this agent today.")).toBe(
      "No picture was made: Daily image limit (5) reached for this agent today. Ask me again to try once more.",
    );
  });

  it("reads the picture model setting defensively", () => {
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect(readLaneAPictureModelId({ laneA: { pictureModelId: id } })).toBe(id);
    expect(readLaneAPictureModelId({ laneA: { pictureModelId: "not-an-id" } })).toBeNull();
    expect(readLaneAPictureModelId({ laneA: {} })).toBeNull();
    expect(readLaneAPictureModelId(null)).toBeNull();
  });
});

describeEmbeddedPostgres("lane A: turns about a photo the person sent", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let JPEG: Buffer;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("lane-a-photo-turns");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    JPEG = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 180, g: 120, b: 90 } } }).jpeg().toBuffer();
  }, 30_000);

  afterEach(async () => {
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(modelDirectoryEntries);
    await db.delete(agents);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedMaja(companyId: string, adapterConfig: Record<string, unknown> = {}): Promise<LaneATargetAgent> {
    const created = await agentService(db).create(companyId, {
      name: "Maja",
      role: "general",
      status: "active",
      adapterType: "claude_local",
      adapterConfig,
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db.update(agents).set({ laneAEnabled: true, laneAModel: "claude-haiku-4-5" }).where(eq(agents.id, created.id));
    await agentService(db).syncPluginToolGrants(created.id, [PLUGIN_TOOL_NAMESPACED]);
    return { id: created.id, companyId, name: created.name, laneAEnabled: true };
  }

  async function seedFile(companyId: string, contentType = "image/jpeg", filename = "chat-photo-20261011-011600.jpg") {
    const [asset] = await db
      .insert(assets)
      .values({ companyId, provider: "local_disk", objectKey: `mem/${randomUUID()}`, contentType, byteSize: JPEG.length, sha256: "x", originalFilename: filename })
      .returning();
    const [file] = await db.insert(issueAttachments).values({ companyId, issueId: null, assetId: asset!.id }).returning();
    return file!.id;
  }

  function memoryStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: vi.fn(),
      getObject: vi.fn(async () => ({ stream: Readable.from([JPEG]), contentType: "image/jpeg", contentLength: JPEG.length }) as never),
      headObject: vi.fn(),
      deleteObject: vi.fn(),
    } as unknown as StorageService;
  }

  async function seedMediaStudio() {
    const manifest = {
      id: PLUGIN_KEY,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Media Studio",
      description: "Pictures",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["agent.tools.register"],
      entrypoints: { worker: "dist/worker.js" },
      tools: [
        {
          name: PLUGIN_TOOL,
          displayName: "Generate image",
          description: "Make a picture.",
          parametersSchema: {
            type: "object",
            properties: { prompt: { type: "string" }, referenceFileIds: { type: "array", items: { type: "string" } } },
            required: ["prompt"],
          },
        },
      ],
    } as unknown as PaperclipPluginManifestV1;
    const [plugin] = await db
      .insert(plugins)
      .values({ pluginKey: PLUGIN_KEY, packageName: "@paperclipai/plugin-media-studio", version: "1.0.0", manifestJson: manifest, status: "ready" })
      .returning();
    const pluginDbId = plugin!.id;
    const call = vi.fn(async (_id: string, _method: string, _params: unknown): Promise<unknown> => ({ content: "x" }));
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginDbId),
      call,
      startWorker: vi.fn(),
      stopWorker: vi.fn(),
      getWorker: vi.fn(),
      stopAll: vi.fn(),
      diagnostics: vi.fn(() => []),
    } as unknown as PluginWorkerManager;
    const dispatcher = createPluginToolDispatcher({ workerManager });
    dispatcher.registerPluginTools(PLUGIN_KEY, manifest, pluginDbId);
    return { dispatcher, call };
  }

  function mockAnthropic(mockCreate: ReturnType<typeof vi.fn>) {
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
  }

  const toolTurn = (input: Record<string, unknown>) => ({
    content: [{ type: "tool_use", id: `call_${randomUUID().slice(0, 6)}`, name: PLUGIN_TOOL_MODEL_NAME, input }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "tool_use",
  });
  const textTurn = (text: string) => ({
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "end_turn",
  });

  const userText = (call: unknown[]) => {
    const last = (call[0] as { messages: Array<{ role: string; content: unknown }> }).messages.at(-1)!;
    return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  };

  it("message 2 replayed: photo + 'you left out my colleague' + a reply that only claims -> the retry forces Generate image with the photo first", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const maja = await seedMaja(companyId);
    const photoId = await seedFile(companyId);
    const madeId = await seedFile(companyId, "image/png", "generated.png");
    const { dispatcher, call } = await seedMediaStudio();
    call.mockResolvedValue({ content: "Made the picture.", data: { fileId: madeId, seed: 3 } });
    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce(textTurn(FAKE_CLAIM))
      // The forced call, from a small model that leaves out the photo.
      .mockResolvedValueOnce(toolTurn({ prompt: "Maja and the colleague working together on the meat" }))
      .mockResolvedValueOnce(textTurn("Here we are, working together on the meat!"));
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService } = await import("../services/lane-a.ts");

    const result = await laneAService(db, { pluginToolDispatcher: dispatcher, attachmentStorage: memoryStorage }).sendMessage({
      companyId,
      targetAgent: maja,
      requester: { userId: "user-1", agentId: null },
      message: SECOND_CAPTION,
      attachmentFileIds: [photoId],
    });

    expect(mockCreate.mock.calls[1]![0].tool_choice).toEqual({ type: "tool", name: PLUGIN_TOOL_MODEL_NAME });
    expect(userText(mockCreate.mock.calls[1]!)).toContain(`referenceFileIds ["${photoId}"]`);
    // The photo went into the call anyway, first.
    expect((call.mock.calls[0]![2] as { parameters: Record<string, unknown> }).parameters).toEqual({
      prompt: "Maja and the colleague working together on the meat",
      referenceFileIds: [photoId],
    });
    expect(result.actions[0]?.image?.fileId).toBe(madeId);
    expect(result.actions.find((a) => a.tool === "action_claim_check")?.ok).toBe(true);
  });

  it("a follow-up with no new photo refers to the earlier one; when the retry still makes nothing, the reply says so plainly", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const maja = await seedMaja(companyId);
    const photoId = await seedFile(companyId);
    const { dispatcher, call } = await seedMediaStudio();
    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce(textTurn("Who is in the photo?"))
      .mockResolvedValueOnce(textTurn(FAKE_CLAIM))
      // The forced retry is ignored (as Ollama ignores tool_choice): words again.
      .mockResolvedValueOnce(textTurn("Here we are again, side by side!"));
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService } = await import("../services/lane-a.ts");
    const svc = laneAService(db, { pluginToolDispatcher: dispatcher, attachmentStorage: memoryStorage });
    const first = await svc.sendMessage({
      companyId,
      targetAgent: maja,
      requester: { userId: "user-1", agentId: null },
      message: "who is this?",
      attachmentFileIds: [photoId],
    });
    const second = await svc.sendMessage({
      companyId,
      targetAgent: maja,
      requester: { userId: "user-1", agentId: null },
      message: SECOND_CAPTION,
      conversationId: first.conversationId,
    });

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockCreate.mock.calls[2]![0].tool_choice).toEqual({ type: "tool", name: PLUGIN_TOOL_MODEL_NAME });
    expect(userText(mockCreate.mock.calls[2]!)).toContain(photoId);
    expect(call).not.toHaveBeenCalled();
    expect(second.response).toBe("No picture was made: the picture tool was not started this time. Ask me again to try once more.");
    expect(second.actions.find((a) => a.tool === "action_claim_check")?.ok).toBe(false);
  });

  it("a picture call that was refused is not forced again; the reply says why", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const maja = await seedMaja(companyId);
    const photoId = await seedFile(companyId);
    const { dispatcher, call } = await seedMediaStudio();
    call.mockResolvedValue({ error: "I can't change this photo, and it was not sent anywhere: it is not clear that everyone in it is an adult." });
    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce(toolTurn({ prompt: "Maja helping him", referenceFileIds: [photoId] }))
      .mockResolvedValueOnce(textTurn(FAKE_CLAIM));
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService } = await import("../services/lane-a.ts");

    const result = await laneAService(db, { pluginToolDispatcher: dispatcher, attachmentStorage: memoryStorage }).sendMessage({
      companyId,
      targetAgent: maja,
      requester: { userId: "user-1", agentId: null },
      message: FIRST_CAPTION,
      attachmentFileIds: [photoId],
    });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.response).toMatch(/^No picture was made: .*not clear that everyone in it is an adult/);
  });

  it("'Use this model for picture requests': a turn with a photo goes to the chosen saved model, other turns stay on the agent's own", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const [entry] = await db
      .insert(modelDirectoryEntries)
      .values({ companyId, name: "Claude Opus (pictures)", provider: "anthropic", model: "claude-opus-5" })
      .returning();
    const maja = await seedMaja(companyId, { laneA: { pictureModelId: entry!.id } });
    const photoId = await seedFile(companyId);
    const madeId = await seedFile(companyId, "image/png", "generated.png");
    const { dispatcher, call } = await seedMediaStudio();
    call.mockResolvedValue({ content: "Made the picture.", data: { fileId: madeId, seed: 3 } });
    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce(textTurn("Hi!"))
      .mockResolvedValueOnce(toolTurn({ prompt: "Maja helping him", referenceFileIds: [photoId] }))
      .mockResolvedValueOnce(textTurn("Done."));
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService } = await import("../services/lane-a.ts");
    const svc = laneAService(db, { pluginToolDispatcher: dispatcher, attachmentStorage: memoryStorage });

    const hello = await svc.sendMessage({ companyId, targetAgent: maja, requester: { userId: "user-1", agentId: null }, message: "hello" });
    const photo = await svc.sendMessage({
      companyId,
      targetAgent: maja,
      requester: { userId: "user-1", agentId: null },
      message: FIRST_CAPTION,
      attachmentFileIds: [photoId],
      conversationId: hello.conversationId,
    });

    expect(mockCreate.mock.calls[0]![0].model).toBe("claude-haiku-4-5");
    expect(mockCreate.mock.calls[1]![0].model).toBe("claude-opus-5");
    expect(mockCreate.mock.calls[2]![0].model).toBe("claude-opus-5");
    expect(photo.actions[0]?.image?.fileId).toBe(madeId);
    const rows = await db.select().from(laneAMessages).where(eq(laneAMessages.role, "assistant"));
    const photoRow = rows.find((row) => row.content === "Done.");
    expect(photoRow?.answeredBy).toBe("picture_model");
    expect(photoRow?.attempts?.[0]).toMatchObject({ model: "claude-opus-5", rule: "picture_model", outcome: "answered" });
  });
});
