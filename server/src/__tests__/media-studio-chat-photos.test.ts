import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { CHAT_PHOTO_FILENAME_PREFIX as SHARED_PREFIX, chatPhotoFilename } from "@paperclipai/shared";
import plugin, { prepareGeneration } from "../../../packages/plugins/media-studio/src/worker.js";
import manifest, { TOOL_GENERATE } from "../../../packages/plugins/media-studio/src/manifest.js";
import {
  CHAT_PHOTO_FILENAME_PREFIX,
  CHAT_PHOTO_NO_MODEL_MESSAGE,
  CHAT_PHOTO_REFUSED_MESSAGE,
  isChatPhoto,
} from "../../../packages/plugins/media-studio/src/chat-photos.js";
import { AGE_CHECK_SYSTEM_PROMPT } from "../../../packages/plugins/media-studio/src/age-check.js";

/**
 * A photo someone sent a quick agent in Telegram ("alter this image to show
 * you helping him prepare the meat") is stored as a "chat-photo-" company
 * file. Before Media Studio sends it to any picture service it must pass the
 * age check; pictures that are not chat photos keep their own rules. Fal,
 * Sogni and the analysis model are all fakes; nothing paid is called.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const MAJA = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const PHOTO = "55555555-5555-4555-8555-555555555555";
const PRODUCT = "66666666-6666-4666-8666-666666666666";
const FACE = "77777777-7777-4777-8777-777777777777";
const AGE_ENTRY = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";
const SECRET = "12345678-1234-4234-8234-123456789012";

const majaRun = { agentId: MAJA, runId: RUN, companyId: COMPANY, projectId: "", requesterMessage: "alter this image to show you helping him" };
const owner = { actor: { type: "user" as const, userId: "owner-1", canManageCompany: true }, companyId: COMPANY };

let JPEG: Buffer;

function companyFile(id: string, filename: string, bytes: Buffer) {
  const contentPath = `/api/attachments/${id}/content`;
  return {
    id,
    companyId: COMPANY,
    issueId: null,
    contentType: "image/jpeg",
    byteSize: bytes.length,
    originalFilename: filename,
    createdByAgentId: null,
    contentPath,
    openPath: contentPath,
    downloadPath: `${contentPath}?download=1`,
    createdAt: new Date(),
    contentBase64: bytes.toString("base64"),
  } as never;
}

async function setup(config: Record<string, unknown> = { provider: "fal", falKeySecretRef: "fal-key-ref" }) {
  JPEG ??= await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 180, g: 120, b: 90 } } }).jpeg().toBuffer();
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    companyFiles: [
      companyFile(PHOTO, chatPhotoFilename("image/jpeg", new Date("2026-10-10T12:00:00Z")), JPEG),
      // A different photo's bytes, so its age check is kept apart.
      companyFile(PRODUCT, "sofa.jpg", Buffer.concat([JPEG, Buffer.from("product")])),
      companyFile(FACE, "maja-face.jpg", Buffer.concat([JPEG, Buffer.from("face")])),
    ],
  });
  await plugin.definition.setup(harness.ctx);
  const falCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  harness.ctx.http.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://fal.run/")) {
      falCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ images: [{ url: "https://v3.fal.media/files/out.jpg", content_type: "image/jpeg" }], seed: 5 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(new Uint8Array(JPEG), { status: 200, headers: { "Content-Type": "image/jpeg" } });
  }) as typeof harness.ctx.http.fetch;
  return { harness, falCalls };
}

/** Picks an analysis model and stubs the server's analysis call. */
async function ageModel(harness: TestHarness, answer = '{"apparentAdult": true}') {
  await harness.performAction("identitySettings.save", { analysis: { entryId: AGE_ENTRY, label: "Vision model", keySecretId: SECRET } }, owner);
  const analyseImage = vi.fn(async (_companyId: string, _input: Record<string, unknown>) => ({
    text: answer,
    entryName: "Vision model",
    provider: "anthropic",
    model: "claude-sonnet-5",
    costCents: 1,
  }));
  harness.ctx.models.analyseImage = analyseImage as never;
  return analyseImage;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("chat photos are recognised by their stored name", () => {
  it("the plugin's prefix is the server's (packages/shared)", () => {
    expect(CHAT_PHOTO_FILENAME_PREFIX).toBe(SHARED_PREFIX);
    expect(chatPhotoFilename("image/png", new Date("2026-10-10T14:22:33Z"))).toBe("chat-photo-20261010-142233.png");
    expect(isChatPhoto({ originalFilename: "chat-photo-20261010-142233.jpg" })).toBe(true);
    expect(isChatPhoto({ originalFilename: "Chat-Photo-x.webp" })).toBe(true);
    expect(isChatPhoto({ originalFilename: "sofa.jpg" })).toBe(false);
    expect(isChatPhoto({ originalFilename: null })).toBe(false);
  });
});

describe("Generate image with a chat photo as the reference", () => {
  it("a photo that clearly shows adults is age-checked once (inside the tool call's run) and then sent as the reference", async () => {
    const { harness, falCalls } = await setup();
    const analyseImage = await ageModel(harness);

    const result = await harness.executeTool<any>(
      TOOL_GENERATE,
      { prompt: "Maja helping the man prepare the meat on the kitchen counter", referenceFileIds: [PHOTO] },
      majaRun as never,
    );

    expect(result.error).toBeUndefined();
    expect(analyseImage).toHaveBeenCalledTimes(1);
    expect(analyseImage.mock.calls[0]![1]).toMatchObject({ fileId: PHOTO, systemPrompt: AGE_CHECK_SYSTEM_PROMPT, runId: RUN });
    expect(falCalls).toHaveLength(1);
    expect(JSON.stringify(falCalls[0]!.body)).toContain(`data:image/jpeg;base64,${JPEG.toString("base64").slice(0, 40)}`);

    // Checked once: the result is kept by the photo's content.
    await harness.executeTool<any>(TOOL_GENERATE, { prompt: "same, but darker", referenceFileIds: [PHOTO] }, majaRun as never);
    expect(analyseImage).toHaveBeenCalledTimes(1);
    expect(falCalls).toHaveLength(2);
  });

  it("an unclear photo is refused in one plain sentence and never reaches the picture service", async () => {
    const { harness, falCalls } = await setup();
    const analyseImage = await ageModel(harness, '{"apparentAdult": null}');

    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "put a hat on him", referenceFileIds: [PHOTO] }, majaRun as never);

    expect(result.error).toBe(CHAT_PHOTO_REFUSED_MESSAGE);
    expect(analyseImage).toHaveBeenCalledTimes(1);
    expect(falCalls).toHaveLength(0);
    // And it stays refused: no second analysis call, still nothing sent.
    const again = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "try again", referenceFileIds: [PHOTO] }, majaRun as never);
    expect(again.error).toBe(CHAT_PHOTO_REFUSED_MESSAGE);
    expect(analyseImage).toHaveBeenCalledTimes(1);
    expect(falCalls).toHaveLength(0);
  });

  it("a photo that may show someone under 18 is refused the same way", async () => {
    const { harness, falCalls } = await setup();
    await ageModel(harness, '{"apparentAdult": false}');
    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "x", referenceFileIds: [PHOTO] }, majaRun as never);
    expect(result.error).toBe(CHAT_PHOTO_REFUSED_MESSAGE);
    expect(falCalls).toHaveLength(0);
  });

  it("without an analysis model nothing is sent, and the sentence says who can fix it", async () => {
    const { harness, falCalls } = await setup();
    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "x", referenceFileIds: [PHOTO] }, majaRun as never);
    expect(result.error).toBe(CHAT_PHOTO_NO_MODEL_MESSAGE);
    expect(falCalls).toHaveLength(0);
  });

  it("a reference that is not a chat photo keeps today's rules: no age check", async () => {
    const { harness, falCalls } = await setup();
    const analyseImage = await ageModel(harness, '{"apparentAdult": null}');
    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "the sofa in blue", referenceFileIds: [PRODUCT] }, majaRun as never);
    expect(result.error).toBeUndefined();
    expect(analyseImage).not.toHaveBeenCalled();
    expect(falCalls).toHaveLength(1);
  });

  it("with Maja's look the photo goes after her own reference pictures, and only the photo is age-checked", async () => {
    const { harness } = await setup();
    const analyseImage = await ageModel(harness);
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "looks" }, [
      { id: "l1", name: "Maja Everyday", style: "warm daylight", model: null, seed: null, referenceFileIds: [FACE], updatedAt: "x" },
    ]);
    const prepared = await prepareGeneration(
      harness.ctx,
      COMPANY,
      { prompt: "Maja helping the man prepare the meat on the counter", look: "Maja Everyday", referenceFileIds: [PHOTO] },
      { agentId: MAJA, runId: RUN, requesterMessage: majaRun.requesterMessage },
    );
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.referenceFileIds).toEqual([FACE, PHOTO]);
    expect(prepared.input.referenceImages).toHaveLength(2);
    expect(analyseImage).toHaveBeenCalledTimes(1);
    expect(analyseImage.mock.calls[0]![1]).toMatchObject({ fileId: PHOTO });
  });
});

describe("Sogni picture tools with a chat photo", () => {
  it("an unclear photo is refused before anything is sent to Sogni", async () => {
    const { harness } = await setup({ provider: "fal", falKeySecretRef: "fal-ref", sogniKeySecretRef: "sogni-key-ref" });
    await ageModel(harness, '{"apparentAdult": null}');
    const fetch = vi.fn();
    harness.ctx.http.fetch = fetch as never;
    const result = await harness.executeTool<any>("sogni-upscale-image", { fileId: PHOTO, scale: 4 }, majaRun as never);
    expect(result.error).toBe(CHAT_PHOTO_REFUSED_MESSAGE);
    expect(fetch).not.toHaveBeenCalled();
  });
});
