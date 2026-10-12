import { readFileSync } from "node:fs";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin, { prepareGeneration } from "../../../packages/plugins/media-studio/src/worker.js";
import manifest, { TOOL_GENERATE } from "../../../packages/plugins/media-studio/src/manifest.js";
import { normalizeIdentity } from "../../../packages/plugins/media-studio/src/identity.js";
import { FAL_REFERENCE_MODEL } from "../../../packages/plugins/media-studio/src/providers.js";
import {
  isFalEditModel,
  isSogniEditModel,
  planPhotoEditReferences,
  requestPutsAgentInPicture,
} from "../../../packages/plugins/media-studio/src/photo-edit.js";
import { assemblePhotoEditPrompt } from "../../../packages/plugins/media-studio/src/look-prompt.js";

/**
 * 11 Oct, 01:16 UTC: Filip sent Maja a photo of a colleague in his kitchen
 * ("alter this image to show you helping him prepare the meat on the
 * counter"). Media Studio put Maja's look pictures first and the photo after,
 * added the look's whole character sheet, and the result was a new picture
 * of Maja: the colleague and the kitchen were gone. A photo the person
 * attached is now edited: it goes first, an edit model makes the picture,
 * and the prompt keeps everyone already in it. Sogni, Fal.ai and the age
 * check are all fakes; nothing paid is called.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const MAJA = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const PHOTO = "55555555-5555-4555-8555-555555555555";
const FACE = "77777777-7777-4777-8777-777777777777";
const BODY = "88888888-8888-4888-8888-888888888888";
const ORIGINAL = "66666666-6666-4666-8666-666666666666";
const LOOKREF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = "12345678-1234-4234-8234-123456789012";
const AGE_ENTRY = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";

const KITCHEN_MESSAGE = "I have a friend helping us in his kitchen, alter this image to show you helping him prepare the meat on the counter";
const MAJA_PROMPT = "Maja helping her friend prepare the meat on the counter";

const owner = { actor: { type: "user" as const, userId: "owner-1", canManageCompany: true }, companyId: COMPANY };

const CATALOG = JSON.parse(readFileSync(new URL("./fixtures/sogni/model-catalog-image.json", import.meta.url), "utf8"));
CATALOG.data.models.push({
  ...CATALOG.data.models.find((m: { id: string }) => m.id === "qwen_image_edit_2511_fp8_lightning"),
  id: "qwen_image_edit_2511_fp8",
  name: "Qwen Image Edit 2511",
});

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

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function setup(config: Record<string, unknown>) {
  JPEG ??= await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 180, g: 120, b: 90 } } }).jpeg().toBuffer();
  const harness = createTestHarness({ manifest, config });
  const tagged = (tag: string) => Buffer.concat([JPEG, Buffer.from(tag)]);
  harness.seed({
    companyFiles: [
      companyFile(PHOTO, "chat-photo-20261011-011600.jpg", JPEG),
      companyFile(FACE, "maja-face.jpg", tagged("face")),
      companyFile(BODY, "maja-body.jpg", tagged("body")),
      companyFile(ORIGINAL, "maja.jpg", tagged("original")),
      companyFile(LOOKREF, "maja-look-background.jpg", tagged("look")),
    ],
    agents: [{ id: MAJA, companyId: COMPANY, name: "Maja", status: "idle" } as never],
  });
  await plugin.definition.setup(harness.ctx);
  const falCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  harness.ctx.http.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.host === "api.sogni.ai" && u.pathname === "/v1/model-catalog") return json(200, CATALOG);
    if (u.host === "fal.run") {
      falCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return json(200, { images: [{ url: "https://v3.fal.media/files/out.jpg", content_type: "image/jpeg" }], seed: 5 });
    }
    return new Response(new Uint8Array(JPEG), { status: 200, headers: { "Content-Type": "image/jpeg" } });
  }) as typeof harness.ctx.http.fetch;
  // The age check of the attached photo: clearly adults.
  await harness.performAction("identitySettings.save", { analysis: { entryId: AGE_ENTRY, label: "Vision model", keySecretId: SECRET } }, owner);
  harness.ctx.models.analyseImage = vi.fn(async () => ({
    text: '{"apparentAdult": true}',
    entryName: "Vision model",
    provider: "anthropic",
    model: "claude-sonnet-5",
    costCents: 1,
  })) as never;
  return { harness, falCalls };
}

const mayaIdentity = () =>
  normalizeIdentity({
    id: "id-maja",
    name: "Maja Berg",
    nickname: "Maja",
    originalFileId: ORIGINAL,
    sheet: { hair: "long blonde hair", face: "oval face" },
    crops: [
      { role: "face", fileId: FACE, sourceFileId: ORIGINAL, box: null },
      { role: "body", fileId: BODY, sourceFileId: ORIGINAL, box: null },
    ],
    consent: { likeness: true, adult: true, confirmedBy: "owner-1", confirmedAt: "2026-10-01T00:00:00Z" },
  })!;

async function saveMaja(harness: TestHarness, look: Record<string, unknown>) {
  await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "identities" }, [mayaIdentity()]);
  await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "looks" }, [
    {
      id: "l-normal",
      name: "Maja normal",
      style: "soft cinematic lighting, shallow depth of field",
      seed: null,
      referenceFileIds: [LOOKREF],
      referenceRoles: ["background"],
      identityId: "id-maja",
      sheet: { outfit: "white blouse", setting: "a sunny office", lighting: "golden hour" },
      updatedAt: "x",
      ...look,
    },
  ]);
  await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "lookDefaults" }, { [MAJA]: "l-normal" });
}

const kitchenOptions = { agentId: MAJA, runId: RUN, requesterMessage: KITCHEN_MESSAGE, attachedFileIds: [PHOTO] };

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("a photo the person attached is edited, not re-drawn (Sogni)", () => {
  it("photo first, Maja's face and body after it, an edit model instead of the look's text-to-picture model, a prompt that keeps the people", async () => {
    const { harness } = await setup({ provider: "sogni", sogniKeySecretRef: "sogni-ref" });
    await saveMaja(harness, { model: "z-turbo", provider: "sogni" });

    const prepared = await prepareGeneration(harness.ctx, COMPANY, { prompt: MAJA_PROMPT, referenceFileIds: [PHOTO] }, kitchenOptions);
    if ("error" in prepared) throw new Error(prepared.error);

    // The photo is picture 1; the look's background picture is left out (the scene is the photo's).
    expect(prepared.referenceFileIds).toEqual([PHOTO, FACE, BODY]);
    expect(prepared.input.referenceImages).toHaveLength(3);
    // Qwen Image Edit 2511 (3 pictures), never the look's text-to-picture model.
    expect(prepared.input.model).toBe("qwen_image_edit_2511_fp8");
    expect(prepared.input.prompt.startsWith(
      "Edit the first picture. Keep the scene and every person already in it, unchanged. Add Maja (from the other reference pictures) doing: helping her friend prepare the meat on the counter.",
    )).toBe(true);
    expect(prepared.input.prompt).toMatch(/Maja's face comes only from picture 2/);
    expect(prepared.input.prompt).toMatch(/Hair: long blonde hair\./);
    expect(prepared.input.prompt).toMatch(/Outfit: white blouse\./);
    // The look's scene, light and camera would re-draw the kitchen: left out.
    expect(prepared.input.prompt).not.toMatch(/sunny office|golden hour|cinematic/);
    expect(prepared.input.prompt).not.toMatch(/Character \(the same in every picture/);
    const notes = prepared.notes.join(" ");
    expect(notes).toMatch(/only makes new pictures, so this change to the person's photo was made with Qwen Image Edit 2511/);
    expect(notes).toMatch(/style\/background picture was left out: the scene comes from the photo/);
    expect(notes).toMatch(/style words were left out/);
  });

  it("a look whose model edits keeps it, and the photo still goes first within its slots (Krea Identity Edit: 2)", async () => {
    const { harness } = await setup({ provider: "sogni", sogniKeySecretRef: "sogni-ref" });
    await saveMaja(harness, { model: "krea-identity-edit", provider: "sogni" });

    const prepared = await prepareGeneration(harness.ctx, COMPANY, { prompt: MAJA_PROMPT, referenceFileIds: [PHOTO] }, kitchenOptions);
    if ("error" in prepared) throw new Error(prepared.error);

    expect(prepared.referenceFileIds).toEqual([PHOTO, FACE]);
    expect(prepared.input.model).toBe("krea2_identity_edit_v1_2");
    expect(prepared.notes.join(" ")).toMatch(/takes 2 pictures, so the photo went first and 1 of the agent's own picture was left out/);
    expect(prepared.notes.join(" ")).not.toMatch(/only makes new pictures/);
  });

  it("the Sogni default edit model from the settings is used when the look's model only draws", async () => {
    const { harness } = await setup({ provider: "sogni", sogniKeySecretRef: "sogni-ref", sogniModel: "qwen-lightning" });
    await saveMaja(harness, { model: "z-turbo", provider: "sogni" });
    const prepared = await prepareGeneration(harness.ctx, COMPANY, { prompt: MAJA_PROMPT, referenceFileIds: [PHOTO] }, kitchenOptions);
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.input.model).toBe("qwen_image_edit_2511_fp8_lightning");
    expect(prepared.referenceFileIds[0]).toBe(PHOTO);
  });

  it("a look without a model gets the default edit model, with no note about a model it never had", async () => {
    const { harness } = await setup({ provider: "sogni", sogniKeySecretRef: "sogni-ref" });
    await saveMaja(harness, { model: null, provider: "sogni" });
    const prepared = await prepareGeneration(harness.ctx, COMPANY, { prompt: MAJA_PROMPT, referenceFileIds: [PHOTO] }, kitchenOptions);
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.input.model).toBe("qwen_image_edit_2511_fp8");
    expect(prepared.referenceFileIds).toEqual([PHOTO, FACE, BODY]);
    expect(prepared.notes.join(" ")).not.toMatch(/only makes new pictures|null/);
  });

  it("'put a hat on him' changes only the photo: Maja's default look is not used", async () => {
    const { harness } = await setup({ provider: "sogni", sogniKeySecretRef: "sogni-ref" });
    await saveMaja(harness, { model: "z-turbo", provider: "sogni" });
    const prepared = await prepareGeneration(
      harness.ctx,
      COMPANY,
      { prompt: "a chef's hat on the man", referenceFileIds: [PHOTO] },
      { ...kitchenOptions, requesterMessage: "can you put a hat on him" },
    );
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.referenceFileIds).toEqual([PHOTO]);
    expect(prepared.look).toBeNull();
    expect(prepared.input.prompt.startsWith(
      "Edit the first picture. Keep the scene and every person already in it, unchanged, apart from this change: a chef's hat on the man.",
    )).toBe(true);
    expect(prepared.notes.join(" ")).toMatch(/The look "Maja normal" was not used: this changes the photo the person sent/);
  });

  it("a reference the host did not list as attached keeps today's rules (the look's pictures first)", async () => {
    const { harness } = await setup({ provider: "sogni", sogniKeySecretRef: "sogni-ref" });
    await saveMaja(harness, { model: null, provider: "sogni" });
    const prepared = await prepareGeneration(
      harness.ctx,
      COMPANY,
      { prompt: MAJA_PROMPT, referenceFileIds: [PHOTO] },
      { ...kitchenOptions, attachedFileIds: [] },
    );
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.referenceFileIds[0]).toBe(FACE);
    expect(prepared.input.prompt).not.toMatch(/^Edit the first picture/);
  });
});

describe("a photo the person attached is edited with FLUX Kontext (Fal.ai)", () => {
  it("the look's text-to-picture Fal model is replaced by Kontext, and the photo is the first image sent", async () => {
    const { harness, falCalls } = await setup({ provider: "fal", falKeySecretRef: "fal-ref" });
    await saveMaja(harness, { model: "fal-ai/flux/dev", provider: "fal" });

    const result = await harness.executeTool<any>(
      TOOL_GENERATE,
      { prompt: MAJA_PROMPT, referenceFileIds: [PHOTO] },
      { agentId: MAJA, runId: RUN, companyId: COMPANY, projectId: "", requesterMessage: KITCHEN_MESSAGE, attachedFileIds: [PHOTO] } as never,
    );

    expect(result.error).toBeUndefined();
    expect(falCalls).toHaveLength(1);
    expect(falCalls[0]!.url).toBe(`https://fal.run/${FAL_REFERENCE_MODEL}`);
    const images = falCalls[0]!.body.image_urls as string[];
    expect(images).toHaveLength(3);
    expect(images[0]).toBe(`data:image/jpeg;base64,${JPEG.toString("base64")}`);
    expect(String(falCalls[0]!.body.prompt)).toMatch(/^Edit the first image\. Keep the scene and every person already in it, unchanged\. Add Maja \(from the other reference images\)/);
    expect(result.content).toMatch(/only makes new pictures, so this change to the person's photo was made with fal-ai\/flux-pro\/kontext\/multi/);
  });
});

describe("photo-edit helpers", () => {
  it("knows which models edit", () => {
    expect(isSogniEditModel("qwen-lightning")).toBe(true);
    expect(isSogniEditModel("qwen_image_edit_2511_fp8")).toBe(true);
    expect(isSogniEditModel("krea-identity-edit")).toBe(true);
    expect(isSogniEditModel("z-turbo")).toBe(false);
    expect(isSogniEditModel("qwen-2512-lightning")).toBe(false);
    expect(isFalEditModel("fal-ai/flux-pro/kontext/multi")).toBe(true);
    expect(isFalEditModel("fal-ai/flux-pro/kontext")).toBe(true);
    expect(isFalEditModel("fal-ai/flux/dev")).toBe(false);
  });

  it("tells a request that puts the agent in the photo from one that only changes it", () => {
    const names = ["Maja"];
    expect(requestPutsAgentInPicture({ requesterMessage: KITCHEN_MESSAGE, request: "x", names })).toBe(true);
    expect(
      requestPutsAgentInPicture({ requesterMessage: "You left out my colleague, I want to see you and him working together on the meat", request: "x", names }),
    ).toBe(true);
    expect(requestPutsAgentInPicture({ requesterMessage: "lag et bilde av deg og ham", request: "x", names })).toBe(true);
    expect(requestPutsAgentInPicture({ requesterMessage: "make it brighter", request: "Maja cooking", names })).toBe(true);
    expect(requestPutsAgentInPicture({ requesterMessage: "can you put a hat on him", request: "a hat on the man", names })).toBe(false);
    expect(requestPutsAgentInPicture({ requesterMessage: "thank you! now make it darker", request: "darker", names })).toBe(false);
  });

  it("the photo is never left out, and the agent's pictures fill only the slots left", () => {
    const plan = planPhotoEditReferences({
      photoIds: [PHOTO],
      identity: mayaIdentity(),
      lookFileIds: [LOOKREF],
      lookRoles: ["other"],
      sameOutfit: false,
      extraIds: [],
      slots: 3,
    });
    expect(plan.fileIds).toEqual([PHOTO, FACE, BODY]);
    expect(plan.roles).toEqual(["other", "face", "body"]);
    expect(plan.facePositions).toEqual([2]);
    expect(plan.notes.join(" ")).toMatch(/1 of the agent's own picture was left out/);
  });

  it("without a picture of the agent, the prompt still says to keep everyone in the photo", () => {
    const { prompt } = assemblePhotoEditPrompt({
      request: "Maja is stirring the sauce",
      agentName: "Maja",
      agentPictures: 0,
      facePositions: [],
      photoCount: 1,
      service: "fal",
    });
    expect(prompt.startsWith("Edit the first image. Keep the scene and every person already in it, unchanged. Add Maja doing: stirring the sauce.")).toBe(true);
  });
});
