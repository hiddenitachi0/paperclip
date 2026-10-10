import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
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
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";
import type { StorageService } from "../storage/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { buildLaneAAttachmentNote, type LaneATargetAgent } from "../services/lane-a.ts";
import { detectLaneAPictureEditRequest } from "../services/lane-a-action-claims.ts";
import { PLUGIN_TOOL_CALL_TIMEOUT_MS } from "../services/plugin-tool-registry.js";

/**
 * 10 Oct: a photo sent to Maja's Telegram bot reaches her quick-agent turn as
 * an attachment. The model reads a note naming the photo's file id (and,
 * when it can see pictures, the photo itself), so "alter this image to show
 * you helping him" becomes a call to Media Studio's Generate image with the
 * photo as a reference. The model, the plugin worker and the file storage are
 * all fakes; nothing paid is called.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const CAPTION = "I have a friend helping us in his kitchen, alter this image to show you helping him prepare the meat on the counter";
const PLUGIN_KEY = "paperclip.media-studio";
const PLUGIN_TOOL = "generate-image";
const PLUGIN_TOOL_NAMESPACED = `${PLUGIN_KEY}:${PLUGIN_TOOL}`;
const PLUGIN_TOOL_MODEL_NAME = "paperclip_media-studio__generate-image";

describe("attachment note and edit requests (pure)", () => {
  it("names each picture's file id and how to use it", () => {
    const note = buildLaneAAttachmentNote({ fileIds: ["f1"], pictureToolName: PLUGIN_TOOL_MODEL_NAME, shownToModel: true });
    expect(note).toBe(
      "[The person attached a picture to this message: file id f1. It is saved in the company's Files. You can see it with this message. " +
        `To change it or make a new picture from it, call ${PLUGIN_TOOL_MODEL_NAME} with this file id in referenceFileIds and describe the change in the prompt.]`,
    );
    const blind = buildLaneAAttachmentNote({ fileIds: ["f1", "f2"], pictureToolName: null, shownToModel: false });
    expect(blind).toContain("2 pictures to this message: file ids f1, f2");
    expect(blind).toContain("You cannot see pictures");
    expect(blind).toContain("You have no picture tool");
  });

  it("recognises a request to change the attached picture, not a question about it", () => {
    expect(detectLaneAPictureEditRequest(CAPTION)).toBe(true);
    expect(detectLaneAPictureEditRequest("put a chef's hat on him")).toBe(true);
    expect(detectLaneAPictureEditRequest("make it black and white")).toBe(true);
    expect(detectLaneAPictureEditRequest("legg til en hund på bildet")).toBe(true);
    expect(detectLaneAPictureEditRequest("What do you think of this?")).toBe(false);
    expect(detectLaneAPictureEditRequest("Who is this?")).toBe(false);
    expect(detectLaneAPictureEditRequest("nice kitchen")).toBe(false);
  });
});

describeEmbeddedPostgres("lane A: pictures attached to a message", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let JPEG: Buffer;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("lane-a-attachments");
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

  async function seedCompany(name = "Paperclip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedMaja(companyId: string): Promise<LaneATargetAgent> {
    const created = await agentService(db).create(companyId, {
      name: "Maja",
      role: "general",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db.update(agents).set({ laneAEnabled: true }).where(eq(agents.id, created.id));
    await agentService(db).syncPluginToolGrants(created.id, [PLUGIN_TOOL_NAMESPACED]);
    return { id: created.id, companyId, name: created.name, laneAEnabled: true };
  }

  async function seedFile(companyId: string, contentType = "image/jpeg", filename = "chat-photo-20261010-120000.jpg") {
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

  async function seedMediaStudio(result: { content?: string; data?: unknown }) {
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
    const call = vi.fn(async (_id: string, _method: string, _params: unknown) => result);
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
    return { dispatcher, call, pluginDbId };
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
    content: [{ type: "tool_use", id: "call_1", name: PLUGIN_TOOL_MODEL_NAME, input }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "tool_use",
  });
  const textTurn = (text: string) => ({
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "end_turn",
  });

  it("the photo reaches the model (note + the picture itself) and Generate image gets it as a reference", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const maja = await seedMaja(companyId);
    const photoId = await seedFile(companyId);
    const madeId = await seedFile(companyId, "image/png", "generated.png");
    const { dispatcher, call, pluginDbId } = await seedMediaStudio({ content: "Made the picture.", data: { fileId: madeId, seed: 77 } });
    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce(toolTurn({ prompt: "Maja helping the man prepare the meat on the counter", referenceFileIds: [photoId] }))
      .mockResolvedValueOnce(textTurn("Here we are, cooking together!"));
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService } = await import("../services/lane-a.ts");

    const result = await laneAService(db, { pluginToolDispatcher: dispatcher, attachmentStorage: memoryStorage }).sendMessage({
      companyId,
      targetAgent: maja,
      requester: { userId: "user-1", agentId: null },
      message: CAPTION,
      attachmentFileIds: [photoId],
    });

    // What the model read: the picture first, then the person's words and the note.
    const lastUser = mockCreate.mock.calls[0]![0].messages.at(-1);
    expect(lastUser.role).toBe("user");
    expect(lastUser.content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg" } });
    expect(lastUser.content[1].text).toBe(
      `${CAPTION}\n\n${buildLaneAAttachmentNote({ fileIds: [photoId], pictureToolName: PLUGIN_TOOL_MODEL_NAME, shownToModel: true })}`,
    );
    // The tool got the photo as its reference; the person's own words (not the note) as the requester message.
    expect(call).toHaveBeenCalledWith(
      pluginDbId,
      "executeTool",
      expect.objectContaining({
        toolName: PLUGIN_TOOL,
        parameters: { prompt: "Maja helping the man prepare the meat on the counter", referenceFileIds: [photoId] },
        runContext: expect.objectContaining({ requesterMessage: CAPTION }),
      }),
      PLUGIN_TOOL_CALL_TIMEOUT_MS,
    );
    expect(result.response).toBe("Here we are, cooking together!");
    expect(result.actions[0]?.image?.fileId).toBe(madeId);

    // The stored message keeps the file id, so "make it darker" next time still finds the photo.
    const rows = await db.select().from(laneAMessages).orderBy(asc(laneAMessages.createdAt));
    expect(rows[0]!.content).toContain(CAPTION);
    expect(rows[0]!.content).toContain(`file id ${photoId}`);
    expect(rows[0]!.content).toContain("You cannot see pictures");
  });

  it("asked to change the photo but answering in words only: the one retry forces Generate image", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const maja = await seedMaja(companyId);
    const photoId = await seedFile(companyId);
    const madeId = await seedFile(companyId, "image/png", "generated.png");
    const { dispatcher } = await seedMediaStudio({ content: "Made the picture.", data: { fileId: madeId, seed: 1 } });
    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce(textTurn("Sounds fun! Your friend's kitchen looks great."))
      .mockResolvedValueOnce(toolTurn({ prompt: "Maja helping at the counter", referenceFileIds: [photoId] }))
      .mockResolvedValueOnce(textTurn("Done!"));
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService } = await import("../services/lane-a.ts");

    const result = await laneAService(db, { pluginToolDispatcher: dispatcher, attachmentStorage: memoryStorage }).sendMessage({
      companyId,
      targetAgent: maja,
      requester: { userId: "user-1", agentId: null },
      message: CAPTION,
      attachmentFileIds: [photoId],
    });

    expect(mockCreate.mock.calls[1]![0].tool_choice).toEqual({ type: "tool", name: PLUGIN_TOOL_MODEL_NAME });
    expect(result.actions[0]?.image?.fileId).toBe(madeId);
  });

  it("refuses a picture of another company, a file that is not a picture, or too many, before any model call", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany("Other");
    const maja = await seedMaja(companyId);
    const foreign = await seedFile(otherCompanyId);
    const text = await seedFile(companyId, "text/plain", "notes.txt");
    const { dispatcher } = await seedMediaStudio({ content: "x" });
    const mockCreate = vi.fn();
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService } = await import("../services/lane-a.ts");
    const svc = laneAService(db, { pluginToolDispatcher: dispatcher, attachmentStorage: memoryStorage });
    const send = (attachmentFileIds: string[]) =>
      svc.sendMessage({ companyId, targetAgent: maja, requester: { userId: "user-1", agentId: null }, message: CAPTION, attachmentFileIds });

    await expect(send([foreign])).rejects.toMatchObject({ status: 422, details: { code: "LANE_A_ATTACHMENT_NOT_FOUND" } });
    await expect(send([randomUUID()])).rejects.toMatchObject({ status: 422, details: { code: "LANE_A_ATTACHMENT_NOT_FOUND" } });
    await expect(send([text])).rejects.toMatchObject({ status: 422, details: { code: "LANE_A_ATTACHMENT_NOT_PICTURE" } });
    await expect(send([1, 2, 3, 4, 5].map(() => randomUUID()))).rejects.toMatchObject({ status: 422, details: { code: "LANE_A_ATTACHMENT_COUNT" } });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await db.select().from(laneAMessages)).toHaveLength(0);
  });

  it("a photo that cannot be read for the model still goes as a file id the tool can use", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const maja = await seedMaja(companyId);
    const photoId = await seedFile(companyId);
    const { dispatcher } = await seedMediaStudio({ content: "x" });
    const mockCreate = vi.fn().mockResolvedValueOnce(textTurn("I can't see it, what is in the photo?"));
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService } = await import("../services/lane-a.ts");
    const broken = (): StorageService =>
      ({ ...memoryStorage(), getObject: vi.fn(async () => ({ stream: Readable.from([Buffer.from("not a picture")]) }) as never) }) as unknown as StorageService;

    await laneAService(db, { pluginToolDispatcher: dispatcher, attachmentStorage: broken }).sendMessage({
      companyId,
      targetAgent: maja,
      requester: { userId: "user-1", agentId: null },
      message: "who is this?",
      attachmentFileIds: [photoId],
    });
    const lastUser = mockCreate.mock.calls[0]![0].messages.at(-1);
    expect(typeof lastUser.content).toBe("string");
    expect(lastUser.content).toContain(`file id ${photoId}`);
    expect(lastUser.content).toContain("You cannot see pictures");
  });
});
