import { readFileSync } from "node:fs";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { estimateMediaStudioEditCostCents, mediaStudioEditActionProvider, MEDIA_STUDIO_LORA_TRAINING_STEPS } from "@paperclipai/shared";
import plugin, { prepareGeneration } from "../../../packages/plugins/media-studio/src/worker.js";
import manifest from "../../../packages/plugins/media-studio/src/manifest.js";
import { anchorSeams } from "../../../packages/plugins/media-studio/src/anchors.js";
import {
  CONSENT_ADULT_TEXT,
  LORA_TRAINING_STEPS,
  assertTrainingMove,
  identitiesMentionedIn,
  loraTrainingCostCents,
  normalizeIdentity,
  planIdentityReferences,
  sheetWithIdentity,
  type Identity,
} from "../../../packages/plugins/media-studio/src/identity.js";
import { ANALYSIS_SYSTEM_PROMPT, parseAnalysis } from "../../../packages/plugins/media-studio/src/vision-analysis.js";
import { crc32, zipStore } from "../../../packages/plugins/media-studio/src/lora-training.js";
import { AGE_CHECK_SYSTEM_PROMPT, parseAgeCheck, sha256Of } from "../../../packages/plugins/media-studio/src/age-check.js";
import { HiggsfieldClient, HiggsfieldProvider, readHiggsfieldCredentials, soulSize } from "../../../packages/plugins/media-studio/src/higgsfield.js";

/**
 * Identity anchors (people), rooms and LoRA training in Media Studio. Every
 * outside service (the analysis model, Sogni, Fal.ai, Hugging Face) is faked
 * here; nothing paid is ever called.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ORIGINAL = "66666666-6666-4666-8666-666666666666";
const FACE = "77777777-7777-4777-8777-777777777777";
const BODY = "88888888-8888-4888-8888-888888888888";
const OUTFIT = "99999999-9999-4999-8999-999999999999";
const LOOKREF1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOOKREF2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROOM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MASK = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SOFA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FOREIGN = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const EXTRA = "abcdefab-abcd-4bcd-8bcd-abcdefabcdef";
const SECRET = "12345678-1234-4234-8234-123456789012";
const HF_SECRET = "12345678-1234-4234-8234-123456789013";
const SOGNI_REF = "12345678-1234-4234-8234-123456789014";
const FAL_REF = "12345678-1234-4234-8234-123456789015";

const owner = { actor: { type: "user" as const, userId: "owner-1", canManageCompany: true }, companyId: COMPANY };
const member = { actor: { type: "user" as const, userId: "member-1", canManageCompany: false }, companyId: COMPANY };
const otherOwner = { actor: { type: "user" as const, userId: "owner-2", canManageCompany: true }, companyId: OTHER };

const CATALOG = JSON.parse(readFileSync(new URL("./fixtures/sogni/model-catalog-image.json", import.meta.url), "utf8"));
CATALOG.data.models.push({ ...CATALOG.data.models.find((m: { id: string }) => m.id === "qwen_image_edit_2511_fp8_lightning"), id: "qwen_image_edit_2511_fp8", name: "Qwen Image Edit 2511" });
const LORA_CATALOG = JSON.parse(readFileSync(new URL("./fixtures/sogni/loras-comfy.json", import.meta.url), "utf8"));

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function solid(width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
}

let PICTURE: Buffer;
let RED: Buffer;
let LEFT_HALF_MASK: Buffer;

function file(id: string, bytes: Buffer, companyId = COMPANY, contentType = "image/png") {
  const contentPath = `/api/attachments/${id}/content`;
  return {
    id,
    companyId,
    issueId: null,
    contentType,
    byteSize: bytes.length,
    originalFilename: `${id.slice(0, 4)}.png`,
    createdByAgentId: null,
    contentPath,
    openPath: contentPath,
    downloadPath: `${contentPath}?download=1`,
    createdAt: new Date(),
    contentBase64: bytes.toString("base64"),
  } as never;
}

type Call = { url: string; method: string; body: any; headers: Record<string, string> };

interface Fake {
  calls: Call[];
  bytes: Call[];
  analysisAnswer: string;
  workflowArtifacts: number;
  editedPicture: Buffer;
  falStatus: string;
}

async function setup(config: Record<string, unknown> = {}): Promise<{ harness: TestHarness; fake: Fake }> {
  PICTURE ??= await solid(200, 100, [10, 120, 200]);
  RED ??= await solid(200, 100, [255, 0, 0]);
  LEFT_HALF_MASK ??= await sharp(
    Buffer.from(Array.from({ length: 200 * 100 }, (_, i) => (i % 200 < 100 ? 255 : 0))),
    { raw: { width: 200, height: 100, channels: 1 } },
  )
    .png()
    .toBuffer();
  const harness = createTestHarness({
    manifest,
    config: { provider: "sogni", sogniKeySecretRef: SOGNI_REF, falKeySecretRef: FAL_REF, ...config },
  });
  harness.seed({
    companyFiles: [
      file(ORIGINAL, PICTURE),
      file(FACE, PICTURE),
      file(BODY, PICTURE),
      file(OUTFIT, PICTURE),
      file(LOOKREF1, PICTURE),
      file(LOOKREF2, PICTURE),
      file(ROOM, PICTURE),
      file(MASK, LEFT_HALF_MASK),
      file(SOFA, PICTURE),
      file(EXTRA, PICTURE),
      file(FOREIGN, PICTURE, OTHER),
    ],
  });
  await plugin.definition.setup(harness.ctx);
  const fake: Fake = { calls: [], bytes: [], analysisAnswer: "", workflowArtifacts: 2, editedPicture: RED, falStatus: "IN_PROGRESS" };
  harness.ctx.http.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    let body: any = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    fake.calls.push({ url, method, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const u = new URL(url);
    // The analysis model.
    if (u.host === "api.anthropic.com") return json(200, { content: [{ type: "text", text: fake.analysisAnswer }] });
    if (u.host === "openrouter.ai") return json(200, { choices: [{ message: { content: fake.analysisAnswer } }] });
    // Sogni.
    if (u.host === "api.sogni.ai") {
      const path = u.pathname;
      if (path === "/v1/model-catalog") return json(200, CATALOG);
      if (path === "/v1/loras/comfy") return json(200, LORA_CATALOG);
      if (path === "/v2/image/uploadUrl") return json(200, { data: { url: "https://bucket.s3-accelerate.amazonaws.com/up", fields: { key: "k" } } });
      if (path === "/v2/image/downloadUrl") return json(200, { data: { downloadUrl: `https://bucket.s3-accelerate.amazonaws.com/${u.searchParams.get("type")}` } });
      if (path === "/v1/creative-agent/workflows" && method === "POST") return json(201, { data: { workflow: { workflowId: "wf1", status: "queued" } } });
      if (path === "/v1/creative-agent/workflows/wf1") {
        const artifacts = Array.from({ length: fake.workflowArtifacts }, (_, i) => ({ url: `https://media.sogni.ai/out-${i + 1}.png` }));
        return json(200, { data: { workflow: { status: "completed", steps: [{ artifacts }] } } });
      }
      if (path === "/v1/loras/personal" && method === "POST") return json(202, { data: { id: "personal-abc", status: "queued" } });
      if (path === "/v1/loras/personal/personal-abc") return json(200, { data: { id: "personal-abc", status: "ready" } });
    }
    // Fal.ai.
    if (u.host === "rest.alpha.fal.ai") return json(200, { upload_url: "https://upload.fal.media/put/zip", file_url: "https://v3.fal.media/files/dataset.zip" });
    if (u.host === "queue.fal.run") {
      if (method === "POST") return json(200, { request_id: "req-1" });
      if (u.pathname.endsWith("/status")) return json(200, { status: fake.falStatus });
      return json(200, { lora_file: { url: "https://v3.fal.media/files/lora.safetensors" }, config_file: { url: "https://v3.fal.media/files/c.json" } });
    }
    if (u.host === "fal.run") return json(200, { images: [{ url: "https://v3.fal.media/files/placed.png", content_type: "image/png" }] });
    if (u.host === "v3.fal.media") return new Response(new Uint8Array(fake.editedPicture), { status: 200, headers: { "Content-Type": "image/png" } });
    // Hugging Face.
    if (u.host === "huggingface.co") {
      if (u.pathname === "/api/whoami-v2") return json(200, { name: "acme" });
      if (u.pathname === "/api/repos/create") return json(200, { url: "https://huggingface.co/acme/maja-lora" });
      if (u.pathname.endsWith("/info/lfs/objects/batch")) {
        return json(200, { objects: [{ oid: body.objects[0].oid, size: body.objects[0].size, actions: { upload: { href: "https://hf-hub-lfs-us-east-1.s3-accelerate.amazonaws.com/x", header: {} } } }] });
      }
      if (u.pathname.startsWith("/api/models/")) return json(200, { commitOid: "abc" });
    }
    return json(404, { message: `unexpected ${method} ${url}` });
  }) as typeof harness.ctx.http.fetch;
  const bytesFetch = vi.fn(async (url: string, init?: RequestInit) => {
    fake.bytes.push({ url, method: init?.method ?? "GET", body: init?.body ?? null, headers: (init?.headers ?? {}) as Record<string, string> });
    if ((init?.method ?? "GET") === "GET") {
      const out = url.includes("media.sogni.ai") ? fake.editedPicture : Buffer.from("SAFETENSORS-BYTES");
      return new Response(new Uint8Array(out), { status: 200, headers: { "Content-Type": url.includes("media.sogni.ai") ? "image/png" : "application/octet-stream" } });
    }
    return new Response(null, { status: url.includes("s3-accelerate") && init?.method === "POST" ? 204 : 200, headers: { etag: '"e1"' } });
  });
  anchorSeams.bytesFetch = bytesFetch as never;
  anchorSeams.sogniTransferFetch = bytesFetch as never;
  anchorSeams.sogniPollIntervalMs = 1;
  return { harness, fake };
}

const AGE_ENTRY = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";

/**
 * Picks an analysis model and stubs the server's analysis call. The age check
 * answers `answer` (default: clearly an adult) for every picture.
 */
async function ageModel(harness: TestHarness, answer: (fileId: string) => string = () => '{"apparentAdult": true}') {
  await harness.performAction("identitySettings.save", { analysis: { entryId: AGE_ENTRY, label: "Vision model", keySecretId: SECRET } }, owner);
  const analyseImage = vi.fn(async (_companyId: string, input: { fileId: string; systemPrompt: string }) => ({
    text: answer(input.fileId),
    entryName: "Vision model",
    provider: "anthropic",
    model: "claude-sonnet-5",
    costCents: 1,
  }));
  harness.ctx.models.analyseImage = analyseImage as never;
  return analyseImage;
}

const identitiesKey = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: "identities" };

async function makeIdentity(harness: TestHarness, extra: Record<string, unknown> = {}) {
  const res = await harness.performAction<{ identity: Identity }>(
    "identities.save",
    {
      name: "Maja Berg",
      nickname: "Maja",
      originalFileId: ORIGINAL,
      sheet: { hair: "long blonde hair", face: "oval face", marks: "a small mole on the left cheek" },
      crops: [
        { role: "face", fileId: FACE, sourceFileId: ORIGINAL, box: { x: 0.3, y: 0.05, w: 0.3, h: 0.3 } },
        { role: "body", fileId: BODY, sourceFileId: ORIGINAL, box: { x: 0.2, y: 0, w: 0.6, h: 1 } },
        { role: "outfit", fileId: OUTFIT, sourceFileId: ORIGINAL, box: { x: 0.2, y: 0.3, w: 0.6, h: 0.5 } },
      ],
      consentLikeness: true,
      consentAdult: true,
      ...extra,
    },
    owner,
  );
  return res.identity;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  delete anchorSeams.bytesFetch;
  delete anchorSeams.sogniTransferFetch;
  delete anchorSeams.sogniPollIntervalMs;
});

// ─── Creating an identity ─────────────────────────────────────────────────────

describe("creating an identity: consent and age safeguards", () => {
  it("refuses without both confirmations, and stores them with the identity", async () => {
    const { harness } = await setup();
    const base = { name: "Maja", originalFileId: ORIGINAL };
    await expect(harness.performAction("identities.save", base, owner)).rejects.toThrow(/Tick both boxes/);
    await expect(harness.performAction("identities.save", { ...base, consentLikeness: true }, owner)).rejects.toThrow(CONSENT_ADULT_TEXT);
    await expect(harness.performAction("identities.save", { ...base, consentAdult: true }, owner)).rejects.toThrow(/written consent/);
    // Truthy but not true is not a tick.
    await expect(harness.performAction("identities.save", { ...base, consentLikeness: "yes", consentAdult: 1 }, owner)).rejects.toThrow(/Tick both boxes/);
    expect(harness.getState(identitiesKey)).toBeUndefined();

    const identity = await makeIdentity(harness);
    expect(identity.consent).toMatchObject({ likeness: true, adult: true, confirmedBy: "owner-1" });
    expect(identity.preferredModels).toEqual({ sogni: "krea-identity-edit", sogniExtraSlot: "qwen", fal: null });
    // An edit keeps the original confirmations (no need to tick again).
    const edited = await harness.performAction<{ identity: Identity }>("identities.save", { id: identity.id, name: "Maja Berg", originalFileId: ORIGINAL }, owner);
    expect(edited.identity.consent.confirmedAt).toBe(identity.consent.confirmedAt);
  });

  it("an identity stored without both confirmations is never read back", () => {
    expect(normalizeIdentity({ id: "x", name: "X", consent: { likeness: true, adult: false } })).toBeNull();
    expect(normalizeIdentity({ id: "x", name: "X" })).toBeNull();
  });

  it("only an owner or admin can create one; another company sees none and cannot use this company's files", async () => {
    const { harness } = await setup();
    await expect(
      harness.performAction("identities.save", { name: "M", originalFileId: ORIGINAL, consentLikeness: true, consentAdult: true }, member),
    ).rejects.toThrow(/owner or an admin/);
    await makeIdentity(harness);
    const list = await harness.performAction<{ identities: unknown[] }>("identities.list", {}, otherOwner);
    expect(list.identities).toHaveLength(0);
    await expect(
      harness.performAction("identities.save", { name: "M", originalFileId: ORIGINAL, consentLikeness: true, consentAdult: true }, otherOwner),
    ).rejects.toThrow(/not in this company's Files/);
    await expect(
      harness.performAction("identities.save", { name: "M", originalFileId: FOREIGN, consentLikeness: true, consentAdult: true }, owner),
    ).rejects.toThrow(/not in this company's Files/);
  });
});

// ─── Analysis ─────────────────────────────────────────────────────────────────

const GOOD_ANALYSIS = {
  refused: false,
  apparentAdult: "yes",
  sheet: { hair: "long straight blonde hair", face: "oval face, high cheekbones", eyes: "blue almond eyes", body: "slim, tall", skin: "fair", marks: "" },
  crops: { face: { x: 0.35, y: 0.05, w: 0.3, h: 0.3 }, body: { x: 0.2, y: 0, w: 0.6, h: 1 }, outfit: null },
};

describe("analysis answers are checked strictly", () => {
  it("accepts the documented JSON (also inside a json fence)", () => {
    const ok = parseAnalysis(JSON.stringify(GOOD_ANALYSIS));
    expect(ok).toMatchObject({ ok: true, result: { sheet: { hair: "long straight blonde hair" }, crops: { outfit: null } } });
    expect(parseAnalysis("```json\n" + JSON.stringify(GOOD_ANALYSIS) + "\n```").ok).toBe(true);
  });

  it("refuses extra fields, a name, boxes outside the picture, long text and prose", () => {
    expect(parseAnalysis(JSON.stringify({ ...GOOD_ANALYSIS, name: "Somebody Famous" }))).toMatchObject({ ok: false, kind: "unreadable" });
    expect(parseAnalysis(JSON.stringify({ ...GOOD_ANALYSIS, sheet: { ...GOOD_ANALYSIS.sheet, identity: "x" } }))).toMatchObject({ ok: false });
    expect(parseAnalysis(JSON.stringify({ ...GOOD_ANALYSIS, crops: { face: { x: 0.8, y: 0, w: 0.5, h: 0.2 } } }))).toMatchObject({ ok: false });
    expect(parseAnalysis(JSON.stringify({ ...GOOD_ANALYSIS, sheet: { hair: "x".repeat(400) } }))).toMatchObject({ ok: false });
    expect(parseAnalysis("Here is the description: blonde hair.")).toMatchObject({ ok: false, kind: "unreadable" });
  });

  it("a refusal (JSON or prose) becomes a plain message suggesting another model", () => {
    const a = parseAnalysis('{"refused": true, "reason": "no"}');
    expect(a).toMatchObject({ ok: false, kind: "refused" });
    expect((a as { message: string }).message).toMatch(/another analysis model/);
    expect(parseAnalysis("I'm sorry, I can't help with identifying people.")).toMatchObject({ ok: false, kind: "refused" });
  });

  it("anything but a clear adult blocks the picture", () => {
    for (const v of ["no", "unsure"]) expect(parseAnalysis(JSON.stringify({ ...GOOD_ANALYSIS, apparentAdult: v }))).toMatchObject({ ok: false, kind: "not-adult" });
    expect(parseAnalysis(JSON.stringify({ ...GOOD_ANALYSIS, apparentAdult: true }))).toMatchObject({ ok: false });
  });

  it("the instructions forbid naming or guessing who the person is", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/Never say or guess who the person is/);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/adult \(18 or older\)/);
  });
});

describe("Analyse picture (the server calls the model; stubbed here)", () => {
  const ENTRY = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";

  async function withSettings(harness: TestHarness, fake: Fake) {
    await harness.performAction("identitySettings.save", { analysis: { entryId: ENTRY, label: "Claude Sonnet", keySecretId: SECRET }, hfTokenSecretId: HF_SECRET }, owner);
    const analyseImage = vi.fn(async (_companyId: string, _input: Record<string, unknown>) => ({
      text: fake.analysisAnswer,
      entryName: "Claude Sonnet",
      provider: "anthropic",
      model: "claude-sonnet-5",
      costCents: 1,
    }));
    harness.ctx.models.analyseImage = analyseImage as never;
    return analyseImage;
  }

  it("needs a chosen analysis model; settings are owner/admin only", async () => {
    const { harness } = await setup();
    await expect(harness.performAction("identities.analyse", { fileId: ORIGINAL }, owner)).rejects.toThrow(/Pick an analysis model/);
    await expect(harness.performAction("identitySettings.save", { analysis: { entryId: ENTRY } }, member)).rejects.toThrow(/owner or an admin/);
    await expect(harness.performAction("identitySettings.save", { hfTokenSecretId: "not-a-secret" }, owner)).rejects.toThrow(/Secrets/);
  });

  it("the analysis model can only be a saved model: a typed-in service, model or address is refused, and an old typed-in setting is ignored", async () => {
    const { harness } = await setup();
    await expect(
      harness.performAction("identitySettings.save", { analysis: { source: "custom", provider: "local", model: "llava", baseUrl: "http://100.64.0.5:11434/v1" } }, owner),
    ).rejects.toThrow(/saved models/);
    await expect(harness.performAction("identitySettings.save", { analysis: { entryId: "http://evil.example/v1" } }, owner)).rejects.toThrow(/saved models/);
    // A setting saved before this change (typed-in model and address) reads back as "not set".
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: "identitySettings" },
      { analysis: { source: "custom", provider: "local", model: "llava", baseUrl: "http://100.64.0.5:11434/v1", keySecretId: null } },
    );
    const got = await harness.performAction<any>("identitySettings.get", {}, owner);
    expect(got.settings.analysis).toBeNull();
    // What is stored for a saved model: its id, its label and the key's secret id. No address, provider or model name.
    const saved = await harness.performAction<any>("identitySettings.save", { analysis: { entryId: ENTRY, label: "Local llava", keySecretId: null, baseUrl: "http://x" } }, owner);
    expect(saved.settings.analysis).toEqual({ entryId: ENTRY, label: "Local llava", keySecretId: null });
  });

  it("asks the server to analyse the picture with the saved model, the key's secret id and the fixed instructions; no address leaves the plugin", async () => {
    const { harness, fake } = await setup();
    const analyseImage = await withSettings(harness, fake);
    fake.analysisAnswer = JSON.stringify(GOOD_ANALYSIS);
    const res = await harness.performAction<any>("identities.analyse", { fileId: ORIGINAL }, owner);
    expect(res).toMatchObject({ ok: true, sheet: { eyes: "blue almond eyes" }, crops: { face: { x: 0.35 } }, model: "Claude Sonnet" });
    expect(analyseImage).toHaveBeenCalledTimes(1);
    const [companyId, input] = analyseImage.mock.calls[0]!;
    expect(companyId).toBe(COMPANY);
    expect(input).toEqual({
      entryId: ENTRY,
      fileId: ORIGINAL,
      keySecretId: SECRET,
      systemPrompt: ANALYSIS_SYSTEM_PROMPT,
      userPrompt: expect.any(String),
      maxOutputTokens: 900,
    });
    // The worker itself calls no model service any more.
    expect(fake.calls.filter((c) => /anthropic|openrouter|11434/.test(c.url))).toEqual([]);
  });

  it("a picture of another company is refused before the server is asked", async () => {
    const { harness, fake } = await setup();
    const analyseImage = await withSettings(harness, fake);
    await expect(harness.performAction("identities.analyse", { fileId: FOREIGN }, owner)).rejects.toThrow(/not in this company's Files/);
    await expect(harness.performAction("identities.analyse", { fileId: ORIGINAL }, member)).rejects.toThrow(/owner or an admin/);
    expect(analyseImage).not.toHaveBeenCalled();
  });

  it("a refusal (prose) is a plain message; the strict check still applies to the server's answer", async () => {
    const { harness, fake } = await setup();
    await withSettings(harness, fake);
    fake.analysisAnswer = "I can't describe people in pictures.";
    const res = await harness.performAction<any>("identities.analyse", { fileId: ORIGINAL }, owner);
    expect(res).toMatchObject({ ok: false, blocked: false });
    expect(res.message).toMatch(/Try another analysis model/);
    fake.analysisAnswer = JSON.stringify({ ...GOOD_ANALYSIS, name: "Somebody Famous" });
    expect(await harness.performAction<any>("identities.analyse", { fileId: ORIGINAL }, owner)).toMatchObject({ ok: false, blocked: false });
  });

  it("an answer that cannot confirm an adult blocks the picture for analysis, crops and saving", async () => {
    const { harness, fake } = await setup();
    const analyseImage = await withSettings(harness, fake);
    fake.analysisAnswer = JSON.stringify({ ...GOOD_ANALYSIS, apparentAdult: "unsure" });
    const res = await harness.performAction<any>("identities.analyse", { fileId: ORIGINAL }, owner);
    expect(res).toMatchObject({ ok: false, blocked: true });
    expect(res.message).toMatch(/adult/);
    await expect(
      harness.performAction("identities.crop", { fileId: ORIGINAL, boxes: [{ role: "face", box: { x: 0, y: 0, w: 0.5, h: 0.5 } }] }, owner),
    ).rejects.toThrow(/under 18/);
    await expect(makeIdentity(harness)).rejects.toThrow(/under 18/);
    // The block holds even with a model that would now say "yes" -- and the model is not asked again.
    fake.analysisAnswer = JSON.stringify(GOOD_ANALYSIS);
    expect(await harness.performAction<any>("identities.analyse", { fileId: ORIGINAL }, owner)).toMatchObject({ ok: false, blocked: true });
    expect(analyseImage).toHaveBeenCalledTimes(1);
  });
});

// ─── Crops ────────────────────────────────────────────────────────────────────

describe("crops", () => {
  it("cuts several boxes out of the same picture at the right size", async () => {
    const { harness } = await setup();
    const res = await harness.performAction<{ crops: Array<{ role: string; imageDataUrl: string; width: number; height: number }> }>(
      "identities.crop",
      {
        fileId: ORIGINAL,
        boxes: [
          { role: "face", box: { x: 0.25, y: 0, w: 0.25, h: 0.5 } },
          { role: "body", box: { x: 0, y: 0, w: 1, h: 1 } },
        ],
      },
      owner,
    );
    expect(res.crops.map((c) => [c.role, c.width, c.height])).toEqual([
      ["face", 50, 50],
      ["body", 200, 100],
    ]);
    const meta = await sharp(Buffer.from(res.crops[0]!.imageDataUrl.split(",")[1]!, "base64")).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([50, 50, "png"]);
  });

  it("refuses boxes outside the picture, unknown roles, members and other companies' pictures", async () => {
    const { harness } = await setup();
    const call = (boxes: unknown, ctx = owner, fileId = ORIGINAL) => harness.performAction("identities.crop", { fileId, boxes }, ctx);
    await expect(call([{ role: "face", box: { x: 0.9, y: 0, w: 0.5, h: 0.5 } }])).rejects.toThrow(/inside the picture/);
    await expect(call([{ role: "hat", box: { x: 0, y: 0, w: 0.5, h: 0.5 } }])).rejects.toThrow(/role/);
    await expect(call([{ role: "face", box: { x: 0, y: 0, w: 0.5, h: 0.5 } }], member)).rejects.toThrow(/owner or an admin/);
    await expect(call([{ role: "face", box: { x: 0, y: 0, w: 0.5, h: 0.5 } }], owner, FOREIGN)).rejects.toThrow(/not in this company's Files/);
  });

  it("saved crops keep their role, picture and box", async () => {
    const { harness } = await setup();
    const identity = await makeIdentity(harness);
    expect(identity.crops.map((c) => [c.role, c.fileId, c.sourceFileId])).toEqual([
      ["face", FACE, ORIGINAL],
      ["body", BODY, ORIGINAL],
      ["outfit", OUTFIT, ORIGINAL],
    ]);
    expect(identity.crops[0]!.box).toEqual({ x: 0.3, y: 0.05, w: 0.3, h: 0.3 });
  });
});

// ─── Generation with an identity ──────────────────────────────────────────────

function identityFixture(over: Partial<Identity> = {}): Identity {
  return normalizeIdentity({
    id: "id-1",
    name: "Maja Berg",
    nickname: "Maja",
    originalFileId: ORIGINAL,
    sheet: { hair: "blonde", face: "oval", marks: "mole" },
    crops: [
      { role: "face", fileId: FACE, sourceFileId: ORIGINAL, box: null },
      { role: "body", fileId: BODY, sourceFileId: ORIGINAL, box: null },
      { role: "outfit", fileId: OUTFIT, sourceFileId: ORIGINAL, box: null },
    ],
    consent: { likeness: true, adult: true, confirmedBy: "u", confirmedAt: "t" },
    ...over,
  })!;
}

describe("which pictures an identity puts first", () => {
  it("face is picture 1 and body picture 2; the look's pictures fill what is left; its face pictures are dropped", () => {
    const plan = planIdentityReferences({
      identity: identityFixture(),
      lookFileIds: [LOOKREF1, LOOKREF2],
      lookRoles: ["face", "background"],
      sameOutfit: false,
      service: "sogni",
      fixedModel: null,
      fixedSlots: 16,
    });
    // face + body + one background = 3: more than krea-identity-edit's 2, so the extra-slot model (qwen, 3).
    expect(plan.model).toBe("qwen");
    expect(plan.fileIds).toEqual([FACE, BODY, LOOKREF2]);
    expect(plan.roles).toEqual(["face", "body", "background"]);
    expect(plan.notes.join(" ")).toMatch(/face picture was left out/);
  });

  it("krea-identity-edit when face + body fit; the outfit only with 'same outfit'", () => {
    const base = { identity: identityFixture(), lookFileIds: [], lookRoles: [], service: "sogni", fixedModel: null, fixedSlots: 16 } as const;
    expect(planIdentityReferences({ ...base, sameOutfit: false })).toMatchObject({ model: "krea-identity-edit", fileIds: [FACE, BODY] });
    expect(planIdentityReferences({ ...base, sameOutfit: true })).toMatchObject({ model: "qwen", fileIds: [FACE, BODY, OUTFIT], roles: ["face", "body", "outfit"] });
  });

  it("respects a fixed model's slots: the face always goes first, the rest is cut with a note", () => {
    const plan = planIdentityReferences({
      identity: identityFixture(),
      lookFileIds: [LOOKREF1],
      lookRoles: ["style"],
      sameOutfit: false,
      service: "sogni",
      fixedModel: "krea-identity-edit",
      fixedSlots: 2,
    });
    expect(plan).toMatchObject({ model: null, fileIds: [FACE, BODY] });
    expect(plan.notes.join(" ")).toMatch(/takes 2 reference pictures.*1 of the look's picture/);
    const fal = planIdentityReferences({ identity: identityFixture(), lookFileIds: [LOOKREF1, LOOKREF2], lookRoles: ["style", "other"], sameOutfit: true, service: "fal", fixedModel: null, fixedSlots: 4 });
    expect(fal.fileIds).toEqual([FACE, BODY, OUTFIT, LOOKREF1]);
  });

  it("the identity's locked description wins over the look's sheet", () => {
    expect(sheetWithIdentity({ hair: "red", outfit: "suit" }, identityFixture())).toEqual({ hair: "blonde", outfit: "suit", face: "oval; distinguishing marks: mole" });
  });

  it("finds a person by name or nickname, whole words only", () => {
    const list = [identityFixture()];
    expect(identitiesMentionedIn("maja at the beach", list)).toHaveLength(1);
    expect(identitiesMentionedIn("Majaland poster", list)).toHaveLength(0);
  });

  it("a look with an identity sends the face crop first with the identity-lock wording (Sogni)", async () => {
    const { harness } = await setup();
    const identity = await makeIdentity(harness);
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "looks" }, [
      { id: "l1", name: "Beach", style: "sunny", model: null, seed: 42, referenceFileIds: [LOOKREF1], referenceRoles: ["background"], identityId: identity.id, updatedAt: "x" },
    ]);
    const prepared = await prepareGeneration(harness.ctx, COMPANY, { prompt: "reading a book", look: "Beach" });
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.referenceFileIds).toEqual([FACE, BODY, LOOKREF1]);
    expect(prepared.input.model).toBe("qwen_image_edit_2511_fp8");
    expect(prepared.input.prompt).toMatch(/Use the person from picture 1 as the final subject/);
    expect(prepared.input.prompt).toMatch(/Identity comes only from picture 1/);
    expect(prepared.input.prompt).toMatch(/distinguishing marks: a small mole/);
    expect(prepared.notes.join(" ")).toMatch(/A seed does not keep a person the same/);
    expect(prepared.input.referenceImages).toHaveLength(3);
  });

  it("naming the person in the request uses their identity without a look", async () => {
    const { harness } = await setup();
    await makeIdentity(harness);
    const prepared = await prepareGeneration(harness.ctx, COMPANY, { prompt: "Maja reading a book" });
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.referenceFileIds).toEqual([FACE, BODY]);
    expect(prepared.input.model).toBe("krea2_identity_edit_v1_2");
  });

  it("a look cannot point at an identity that does not exist", async () => {
    const { harness } = await setup();
    await expect(harness.performAction("looks.save", { name: "X", style: "", identityId: "nope" }, owner)).rejects.toThrow(/no longer exists/);
  });
});

// ─── Candidates ───────────────────────────────────────────────────────────────

describe("candidates (stubbed Sogni)", () => {
  it("one call makes 2 pictures with krea-identity-edit from the face and body crops; picking one sets the canonical picture", async () => {
    const { harness, fake } = await setup();
    const identity = await makeIdentity(harness);
    const reserve = vi.spyOn(harness.ctx.billing, "reserveMediaStudioDirectSpend");
    const res = await harness.performAction<any>("identities.candidates", { identityId: identity.id, kind: "portrait" }, owner);
    expect(res.candidates).toHaveLength(2);
    expect(res.candidates[0].imageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(reserve).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ action: "identity-pictures", userId: "owner-1" }));
    const start = fake.calls.find((c) => c.url.endsWith("/v1/creative-agent/workflows") && c.method === "POST")!;
    const args = start.body.input.steps[0].arguments;
    expect(args).toMatchObject({ model: "krea-identity-edit", numberOfVariations: 2, sourceImageIndex: -1 });
    expect(args.seed).toBeUndefined();
    expect(args.prompt).toMatch(/front-facing head-and-shoulders portrait/);
    expect(args.prompt).toMatch(/Body shape and proportions from picture 2/);
    expect(start.body.media_references).toHaveLength(2);
    expect(start.body.safe_content_filter).toBe(true);

    await expect(harness.performAction("identities.candidates", { identityId: identity.id, kind: "portrait" }, member)).rejects.toThrow(/owner or an admin/);

    const used = await harness.performAction<any>("identities.useCandidate", { identityId: identity.id, fileId: FACE, model: res.candidates[0].model, workflowId: "wf1", addAsReference: true }, owner);
    expect(used.identity).toMatchObject({ canonicalFileId: FACE, canonicalAsReference: true, provenance: { model: "krea-identity-edit", seed: null, workflowId: "wf1" } });
    expect(used.identity.seedExplanation).toMatch(/take no seed/);
  });

  it("a Sogni failure gives the reserved spend back", async () => {
    const { harness, fake } = await setup();
    const identity = await makeIdentity(harness);
    fake.workflowArtifacts = 0;
    const release = vi.spyOn(harness.ctx.billing, "releaseMediaStudioDirectSpend");
    await expect(harness.performAction("identities.candidates", { identityId: identity.id, kind: "full-body" }, owner)).rejects.toThrow(/no picture/);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

// ─── Rooms ────────────────────────────────────────────────────────────────────

describe("rooms: place a product through a zone mask", () => {
  async function saveRoom(harness: TestHarness) {
    return (
      await harness.performAction<any>(
        "rooms.save",
        {
          name: "Living room",
          photoFileId: ROOM,
          cameraNote: "eye level from the door, soft daylight",
          zones: [{ name: "Left wall", maskFileId: MASK }],
          products: [{ name: "Grey sofa", fileId: SOFA, cutoutFileId: null }],
        },
        owner,
      )
    ).room;
  }

  it("only an owner/admin saves rooms; members can place (paid, reserved first)", async () => {
    const { harness } = await setup();
    await expect(harness.performAction("rooms.save", { name: "R", photoFileId: ROOM }, member)).rejects.toThrow(/owner or an admin/);
    await expect(harness.performAction("rooms.save", { name: "R", photoFileId: FOREIGN }, owner)).rejects.toThrow(/not in this company's Files/);
    const room = await saveRoom(harness);
    expect((await harness.performAction<any>("rooms.list", {}, otherOwner)).rooms).toHaveLength(0);
    expect(room.zones[0].id).toBeTruthy();
  });

  it("Sogni (qwen): room is picture 1, product picture 2; outside the zone every pixel is the room photo's", async () => {
    const { harness, fake } = await setup();
    const room = await saveRoom(harness);
    fake.workflowArtifacts = 1;
    const reserve = vi.spyOn(harness.ctx.billing, "reserveMediaStudioDirectSpend");
    const res = await harness.performAction<any>("rooms.place", { roomId: room.id, zoneId: room.zones[0].id, productIds: [room.products[0].id] }, member);
    expect(reserve).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ action: "room-place" }));
    const start = fake.calls.find((c) => c.url.endsWith("/v1/creative-agent/workflows") && c.method === "POST")!;
    expect(start.body.input.steps[0].arguments.model).toBe("qwen");
    expect(start.body.input.steps[0].arguments.prompt).toMatch(/from picture 2 \("Grey sofa"\) into the room from picture 1, inside the area "Left wall"/);
    expect(start.body.media_references).toHaveLength(2);
    const { data, info } = await sharp(Buffer.from(res.imageDataUrl.split(",")[1], "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3));
    expect(px(20, 50)).toEqual([255, 0, 0]); // inside the zone: the service's picture
    expect(px(180, 50)).toEqual([10, 120, 200]); // outside: the room photo, unchanged
  });

  it("Fal works the same way through its edit model", async () => {
    const { harness, fake } = await setup();
    const room = await saveRoom(harness);
    const res = await harness.performAction<any>("rooms.place", { roomId: room.id, zoneId: room.zones[0].id, productIds: [room.products[0].id], service: "fal" }, member);
    expect(res.provider).toBe("fal");
    const call = fake.calls.find((c) => c.url.startsWith("https://fal.run/"))!;
    expect(call.body.image_urls).toHaveLength(2);
    expect(call.body.prompt).toMatch(/from image 2/);
  });
});

// ─── Training set ─────────────────────────────────────────────────────────────

const up = (fileId: string) => ({ fileId, provenance: { source: "upload" } });

describe("training set: generate anywhere, keep provenance, mix batches", () => {
  it("generates with Sogni (with a public LoRA) and with Fal, and each picture keeps how it was made", async () => {
    const { harness, fake } = await setup();
    const identity = await makeIdentity(harness);
    const options = await harness.performAction<any>("identities.generationOptions", {}, owner);
    expect(options.services).toEqual({ sogni: true, fal: true, higgsfield: false });
    expect(options.models.sogni[0]).toBe("krea-identity-edit");
    expect(options.models.fal).toContain("fal-ai/nano-banana-2/edit");

    const sogni = await harness.performAction<any>(
      "trainingSet.generate",
      { identityId: identity.id, service: "sogni", model: "krea-identity-edit", loras: [{ id: "lora-x", strength: 0.6 }], prompt: "three-quarter view, window light", count: 2 },
      owner,
    );
    expect(sogni.pictures).toHaveLength(2);
    expect(sogni.pictures[0]).toMatchObject({ service: "sogni", model: "krea-identity-edit", loras: [{ id: "lora-x", strength: 0.6 }], seed: null });
    const step = fake.calls.find((c) => c.url.endsWith("/v1/creative-agent/workflows") && c.method === "POST")!.body.input.steps[0].arguments;
    expect(step).toMatchObject({ loras: ["lora-x"], loraStrengths: [0.6], numberOfVariations: 2 });
    expect(step.prompt).toMatch(/three-quarter view, window light/);

    const reserve = vi.spyOn(harness.ctx.billing, "reserveMediaStudioDirectSpend");
    const fal = await harness.performAction<any>(
      "trainingSet.generate",
      { identityId: identity.id, service: "fal", model: "fal-ai/nano-banana-2/edit", prompt: "laughing, outdoors", count: 2 },
      owner,
    );
    expect(reserve).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ action: "identity-pictures-fal" }));
    const falCall = fake.calls.find((c) => c.url === "https://fal.run/fal-ai/nano-banana-2/edit")!;
    expect(falCall.body).toMatchObject({ num_images: 2 });
    expect(falCall.body.image_urls).toHaveLength(2);
    expect(fal.pictures[0]).toMatchObject({ service: "fal", model: "fal-ai/nano-banana-2/edit" });

    await expect(
      harness.performAction("trainingSet.generate", { identityId: identity.id, service: "fal", model: "fal-ai/nano-banana-2/edit", loras: [{ id: "x", strength: 1 }], prompt: "p" }, owner),
    ).rejects.toThrow(/take no LoRAs/);
    await expect(
      harness.performAction("trainingSet.generate", { identityId: identity.id, service: "sogni", loras: [{ id: "personal-1", strength: 1 }], prompt: "p" }, owner),
    ).rejects.toThrow(/content filter off/);
    await expect(harness.performAction("trainingSet.generate", { identityId: identity.id, service: "higgsfield", prompt: "p" }, owner)).rejects.toThrow(/Soul ID/);

    // Mix both batches and an own photo into one set.
    await harness.performAction("trainingSet.add", { identityId: identity.id, pictures: [{ fileId: LOOKREF1, provenance: sogni.pictures[0] }], batch: { service: "sogni", model: "krea-identity-edit", loras: [{ id: "lora-x", strength: 0.6 }], prompts: ["three-quarter view, window light"] } }, owner);
    await harness.performAction("trainingSet.add", { identityId: identity.id, pictures: [{ fileId: LOOKREF2, provenance: fal.pictures[0] }], batch: { service: "fal", model: "fal-ai/nano-banana-2/edit", prompts: ["laughing, outdoors"] } }, owner);
    const added = await harness.performAction<any>("trainingSet.add", { identityId: identity.id, pictures: [up(EXTRA)] }, owner);
    const set = added.identity.trainingSet;
    expect(set.pictures.map((p: any) => [p.fileId, p.source, p.service, p.model])).toEqual([
      [LOOKREF1, "generated", "sogni", "krea-identity-edit"],
      [LOOKREF2, "generated", "fal", "fal-ai/nano-banana-2/edit"],
      [EXTRA, "upload", null, null],
    ]);
    expect(set.pictures[0].loras).toEqual([{ id: "lora-x", strength: 0.6 }]);
    expect(set.batches.map((b: any) => b.service)).toEqual(["sogni", "fal"]);
    await expect(harness.performAction("trainingSet.add", { identityId: identity.id, pictures: [up(FOREIGN)] }, owner)).rejects.toThrow(/not in this company's Files/);
    await expect(harness.performAction("trainingSet.add", { identityId: identity.id, pictures: [up(SOFA)] }, member)).rejects.toThrow(/owner or an admin/);
  });

  it("candidates can use the chosen service and model too", async () => {
    const { harness, fake } = await setup();
    const identity = await makeIdentity(harness);
    const res = await harness.performAction<any>("identities.candidates", { identityId: identity.id, kind: "portrait", service: "fal", model: "fal-ai/flux-2-pro/edit" }, owner);
    expect(res.candidates[0]).toMatchObject({ service: "fal", model: "fal-ai/flux-2-pro/edit", kind: "portrait" });
    expect(fake.calls.some((c) => c.url === "https://fal.run/fal-ai/flux-2-pro/edit")).toBe(true);
  });

  it("downloads the ticked pictures as a zip with captions and a README of where each came from", async () => {
    const { harness } = await setup();
    await ageModel(harness);
    const identity = await makeIdentity(harness);
    await harness.performAction("trainingSet.add", { identityId: identity.id, pictures: [{ fileId: LOOKREF1, provenance: { service: "sogni", model: "qwen", prompt: "a walk", loras: [] } }, up(EXTRA)] }, owner);
    await expect(harness.performAction("trainingSet.download", { identityId: identity.id }, owner)).rejects.toThrow(/Tick/);
    await harness.performAction("trainingSet.select", { identityId: identity.id, fileIds: [LOOKREF1, EXTRA] }, owner);
    const res = await harness.performAction<any>("trainingSet.download", { identityId: identity.id, triggerWord: "majaberg" }, owner);
    expect(res.filename).toBe("maja-berg-training-set.zip");
    const zip = Buffer.from(res.contentBase64, "base64");
    const text = zip.toString("latin1");
    for (const name of ["001.png", "001.txt", "002.png", "002.txt", "README.md"]) expect(text).toContain(name);
    expect(text).toContain("majaberg, a walk");
    expect(text).toContain("002.png: own photo");
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(5);
  });
});

// ─── Train with: Fal LoRA ─────────────────────────────────────────────────────

describe("LoRA training flow (stubbed Fal and Hugging Face)", () => {
  async function ready(harness: TestHarness) {
    await ageModel(harness);
    const identity = await makeIdentity(harness);
    const ids = [FACE, BODY, OUTFIT, LOOKREF1, LOOKREF2, ROOM, SOFA, ORIGINAL, MASK];
    await harness.performAction("trainingSet.add", { identityId: identity.id, pictures: ids.map(up) }, owner);
    return { identity, ids };
  }

  it("the price matches the shared constant and the host's reservation", () => {
    expect(LORA_TRAINING_STEPS).toBe(MEDIA_STUDIO_LORA_TRAINING_STEPS);
    expect(loraTrainingCostCents()).toBe(estimateMediaStudioEditCostCents("lora-training"));
    expect(loraTrainingCostCents()).toBe(300);
    expect(mediaStudioEditActionProvider("lora-training")).toBe("fal");
    expect(mediaStudioEditActionProvider("identity-pictures")).toBe("sogni");
    expect(mediaStudioEditActionProvider("identity-pictures-fal")).toBe("fal");
    expect(mediaStudioEditActionProvider("higgsfield-soul-id")).toBe("higgsfield");
  });

  it("the state machine only allows the documented moves", () => {
    expect(() => assertTrainingMove(null, "published")).toThrow(/cannot move/);
    expect(() => assertTrainingMove("training", "training")).toThrow(/cannot move/);
    expect(() => assertTrainingMove("trained", "published")).not.toThrow();
    expect(() => assertTrainingMove("failed", "training")).not.toThrow();
    expect(() => assertTrainingMove("published", "training")).not.toThrow();
  });

  it("tick (at least 10) -> confirm price -> train -> poll -> publish (public) -> import into Sogni", async () => {
    const { harness, fake } = await setup();
    const { identity, ids } = await ready(harness);
    await expect(harness.performAction("trainingSet.select", { identityId: identity.id, fileIds: [FOREIGN] }, owner)).rejects.toThrow(/Only pictures in this training set/);
    await harness.performAction("trainingSet.select", { identityId: identity.id, fileIds: ids }, owner);
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner)).rejects.toThrow(/at least 10/);
    await harness.performAction("trainingSet.add", { identityId: identity.id, pictures: [up(EXTRA)] }, owner);
    await harness.performAction("trainingSet.select", { identityId: identity.id, fileIds: [...ids, EXTRA] }, owner);
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg" }, owner)).rejects.toThrow(/\$3\.00/);
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, member)).rejects.toThrow(/owner or an admin/);
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "a", confirmCostCents: 300 }, owner)).rejects.toThrow(/trigger word/);

    const reserve = vi.spyOn(harness.ctx.billing, "reserveMediaStudioDirectSpend");
    const started = await harness.performAction<any>("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner);
    expect(reserve).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ action: "lora-training" }));
    expect(started.identity.training).toMatchObject({ status: "training", falRequestId: "req-1", triggerWord: "majaberg", steps: 1000 });
    expect(started.identity.training.trainedFileIds).toHaveLength(10);
    const zipPut = fake.bytes.find((b) => b.url === "https://upload.fal.media/put/zip")!;
    const zip = Buffer.from(zipPut.body as Uint8Array);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(10);
    const submit = fake.calls.find((c) => c.url === "https://queue.fal.run/fal-ai/krea-2-trainer" && c.method === "POST")!;
    expect(submit.body).toMatchObject({ images_data_url: "https://v3.fal.media/files/dataset.zip", trigger_phrase: "majaberg", steps: 1000 });
    expect(submit.headers.Authorization).toBe(`Key resolved:${FAL_REF}`);
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner)).rejects.toThrow(/cannot move/);

    expect((await harness.performAction<any>("lora.status", { identityId: identity.id }, member)).progress).toBe("training");
    fake.falStatus = "COMPLETED";
    const done = await harness.performAction<any>("lora.status", { identityId: identity.id }, member);
    expect(done.identity.training).toMatchObject({ status: "trained", resultUrl: "https://v3.fal.media/files/lora.safetensors" });
    expect(done.identity.trainedIdentities).toEqual([expect.objectContaining({ provider: "fal-lora", ref: "https://v3.fal.media/files/lora.safetensors", status: "ready" })]);

    await expect(harness.performAction("lora.publish", { identityId: identity.id, repoName: "maja-lora" }, owner)).rejects.toThrow(/PUBLIC/);
    await expect(harness.performAction("lora.publish", { identityId: identity.id, repoName: "maja-lora", confirmPublic: true }, owner)).rejects.toThrow(/Hugging Face token/);
    await harness.performAction("identitySettings.save", { hfTokenSecretId: HF_SECRET }, owner);
    await expect(harness.performAction("lora.publish", { identityId: identity.id, repoName: "maja-lora", confirmPublic: true }, member)).rejects.toThrow(/owner or an admin/);
    const published = await harness.performAction<any>("lora.publish", { identityId: identity.id, repoName: "maja-lora", confirmPublic: true }, owner);
    expect(published.identity.lora).toMatchObject({
      source: "huggingface",
      visibility: "public",
      url: "https://huggingface.co/acme/maja-lora/resolve/main/maja-lora.safetensors",
      triggerWord: "majaberg",
      repo: "acme/maja-lora",
    });
    expect(published.identity.trainedIdentities[0].url).toBe(published.identity.lora.url);
    expect(published.identity.training.status).toBe("published");
    const create = fake.calls.find((c) => c.url === "https://huggingface.co/api/repos/create")!;
    expect(create.body).toMatchObject({ type: "model", name: "maja-lora", private: false });
    expect(create.headers.Authorization).toBe(`Bearer resolved:${HF_SECRET}`);
    const lfsPut = fake.bytes.find((b) => b.url.startsWith("https://hf-hub-lfs"))!;
    expect(Buffer.from(lfsPut.body as Uint8Array).toString()).toBe("SAFETENSORS-BYTES");
    const commit = fake.calls.find((c) => c.url === "https://huggingface.co/api/models/acme/maja-lora/commit/main")!;
    expect(String(commit.body).split("\n").map((l) => JSON.parse(l).key)).toEqual(["header", "lfsFile", "file"]);

    const imported = await harness.performAction<any>("lora.importSogni", { identityId: identity.id }, owner);
    expect(imported.identity.trainedIdentities[1]).toMatchObject({ provider: "sogni-lora", ref: "personal-abc", status: "queued", triggerWord: "majaberg" });
    const importCall = fake.calls.find((c) => c.url === "https://api.sogni.ai/v1/loras/personal")!;
    expect(importCall.body).toMatchObject({ url: published.identity.lora.url, modelId: "krea2_identity_edit_v1_2", rightsConfirmed: true });
    const checked = await harness.performAction<any>("trained.status", { identityId: identity.id }, owner);
    expect(checked.identity.trainedIdentities[1].status).toBe("ready");
  });

  it("a failed training gives the reservation back and can be retried", async () => {
    const { harness, fake } = await setup();
    const { identity, ids } = await ready(harness);
    await harness.performAction("trainingSet.add", { identityId: identity.id, pictures: [up(EXTRA)] }, owner);
    await harness.performAction("trainingSet.select", { identityId: identity.id, fileIds: [...ids, EXTRA] }, owner);
    await harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner);
    const release = vi.spyOn(harness.ctx.billing, "releaseMediaStudioDirectSpend");
    fake.falStatus = "ERROR";
    const failed = await harness.performAction<any>("lora.status", { identityId: identity.id }, owner);
    expect(failed.identity.training).toMatchObject({ status: "failed", reservationId: null });
    expect(release).toHaveBeenCalledTimes(1);
    fake.falStatus = "IN_QUEUE";
    const again = await harness.performAction<any>("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner);
    expect(again.identity.training.status).toBe("training");
  });

  async function tickTen(harness: TestHarness) {
    const { identity, ids } = await ready(harness);
    await harness.performAction("trainingSet.add", { identityId: identity.id, pictures: [up(EXTRA)] }, owner);
    await harness.performAction("trainingSet.select", { identityId: identity.id, fileIds: [...ids, EXTRA] }, owner);
    return { identity, ids: [...ids, EXTRA] };
  }

  it("two starts at once (double click, two tabs) start and pay for ONE training", async () => {
    const { harness, fake } = await setup();
    const { identity } = await tickTen(harness);
    const reserve = vi.spyOn(harness.ctx.billing, "reserveMediaStudioDirectSpend");
    const args = { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 };
    const [a, b] = await Promise.allSettled([harness.performAction<any>("lora.train", args, owner), harness.performAction<any>("lora.train", args, owner)]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already being started|cannot move/);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fake.calls.filter((c) => c.url === "https://queue.fal.run/fal-ai/krea-2-trainer" && c.method === "POST")).toHaveLength(1);
    const stored = (await harness.ctx.state.get(identitiesKey)) as Identity[];
    expect(stored[0]!.training).toMatchObject({ status: "training", falRequestId: "req-1" });
  });

  it("two status checks at once settle the finished training once, with one trained LoRA", async () => {
    const { harness, fake } = await setup();
    const { identity } = await tickTen(harness);
    await harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner);
    fake.falStatus = "COMPLETED";
    const settle = vi.spyOn(harness.ctx.billing, "settleMediaStudioDirectSpend");
    await Promise.all([harness.performAction<any>("lora.status", { identityId: identity.id }, owner), harness.performAction<any>("lora.status", { identityId: identity.id }, owner)]);
    const after = await harness.performAction<any>("lora.status", { identityId: identity.id }, owner);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(after.identity.training.status).toBe("trained");
    expect(after.identity.trainedIdentities.filter((t: any) => t.provider === "fal-lora")).toHaveLength(1);
  });

  it("marks the training as started before paying, and puts it back when the start is refused", async () => {
    const { harness, fake } = await setup();
    const { identity } = await tickTen(harness);
    const reserve = vi.spyOn(harness.ctx.billing, "reserveMediaStudioDirectSpend").mockResolvedValueOnce({ allowed: false, message: "Over the company's budget.", reason: "company_budget" } as never);
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner)).rejects.toThrow(/Over the company's budget/);
    expect(fake.calls.some((c) => c.url.startsWith("https://queue.fal.run/"))).toBe(false);
    expect(((await harness.ctx.state.get(identitiesKey)) as Identity[])[0]!.training).toBeNull();
    reserve.mockRestore();
    const again = await harness.performAction<any>("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner);
    expect(again.identity.training).toMatchObject({ status: "training", falRequestId: "req-1" });
  });

  it("a start that never reached Fal (worker restarted mid-start) can be cleared; a real training cannot", async () => {
    const { harness } = await setup();
    const { identity } = await tickTen(harness);
    const stored = (await harness.ctx.state.get(identitiesKey)) as Identity[];
    const stuck = { status: "training", trainedFileIds: [], triggerWord: "majaberg", steps: 1000, estimatedCostCents: 300, falModel: "fal-ai/krea-2-trainer", falRequestId: null, reservationId: null, resultUrl: null, error: null, startedBy: "owner-1", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await harness.ctx.state.set(identitiesKey, stored.map((i) => ({ ...i, training: stuck })));
    const reset = await harness.performAction<any>("lora.reset", { identityId: identity.id }, owner);
    expect(reset.identity.training).toBeNull();
    await harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner);
    await expect(harness.performAction("lora.reset", { identityId: identity.id }, owner)).rejects.toThrow(/being trained/);
  });

  it("a picture flagged as possibly under 18 after it was added cannot be ticked, downloaded, trained on or sent to Higgsfield", async () => {
    const { harness, fake } = await setup({ higgsfieldKeySecretRef: "12345678-1234-4234-8234-123456789016" });
    const { identity, ids } = await tickTen(harness);
    // Flagged later (e.g. analysed after it was put in the set).
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "identityAgeBlocks" }, [EXTRA]);
    const reserve = vi.spyOn(harness.ctx.billing, "reserveMediaStudioDirectSpend");
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner)).rejects.toThrow(/under 18/);
    await expect(harness.performAction("trainingSet.download", { identityId: identity.id }, owner)).rejects.toThrow(/under 18/);
    await expect(harness.performAction("trainingSet.select", { identityId: identity.id, fileIds: [ids[0], EXTRA] }, owner)).rejects.toThrow(/under 18/);
    await harness.performAction("trainingSet.select", { identityId: identity.id, fileIds: [FACE, BODY, OUTFIT, LOOKREF1, LOOKREF2] }, owner);
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "identityAgeBlocks" }, [LOOKREF2]);
    await expect(harness.performAction("higgsfield.soulId", { identityId: identity.id }, owner)).rejects.toThrow(/under 18/);
    expect(reserve).not.toHaveBeenCalled();
    expect(fake.calls.some((c) => c.url.startsWith("https://queue.fal.run/") || c.url.startsWith("https://api.higgsfield.ai/"))).toBe(false);
    expect(fake.bytes).toHaveLength(0);
    // Without the flagged picture it goes ahead.
    await harness.performAction("trainingSet.remove", { identityId: identity.id, fileIds: [LOOKREF2] }, owner);
    expect((await harness.performAction<any>("trainingSet.select", { identityId: identity.id, fileIds: ids.filter((id) => id !== EXTRA && id !== LOOKREF2) }, owner)).identity.trainingSet.selectedFileIds).toHaveLength(8);
  });

  it("a ready Sogni LoRA rides along only with a filter-off look and a Krea model; a look can pick which one", async () => {
    const { harness } = await setup();
    const identity = await makeIdentity(harness);
    await harness.performAction("lora.attach", { identityId: identity.id, sogniLoraId: "personal-old", strength: 0.5, triggerWord: "oldword" }, owner);
    const attached = await harness.performAction<any>("lora.attach", { identityId: identity.id, sogniLoraId: "personal-abc", strength: 0.7, triggerWord: "majaberg" }, owner);
    const oldId = attached.identity.trainedIdentities[0].id;
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "looks" }, [
      { id: "on", name: "Filtered", style: "", model: null, seed: null, referenceFileIds: [], identityId: identity.id, updatedAt: "x" },
      { id: "off", name: "Open", style: "", model: null, seed: null, referenceFileIds: [], identityId: identity.id, safeContentFilter: false, contentFilterOffBy: "owner-1", updatedAt: "x" },
      { id: "old", name: "Old", style: "", model: null, seed: null, referenceFileIds: [], identityId: identity.id, identityTrained: { sogni: oldId }, safeContentFilter: false, contentFilterOffBy: "owner-1", updatedAt: "x" },
    ]);
    const filtered = await prepareGeneration(harness.ctx, COMPANY, { prompt: "a walk", look: "Filtered" });
    if ("error" in filtered) throw new Error(filtered.error);
    expect(filtered.input.loras ?? []).toHaveLength(0);
    expect(filtered.notes.join(" ")).toMatch(/LoRA of "Maja Berg" was not used/);
    const open = await prepareGeneration(harness.ctx, COMPANY, { prompt: "a walk", look: "Open" });
    if ("error" in open) throw new Error(open.error);
    expect(open.input.loras).toEqual([{ id: "personal-abc", strength: 0.7 }]);
    expect(open.input.prompt.startsWith("majaberg, a walk")).toBe(true);
    const old = await prepareGeneration(harness.ctx, COMPANY, { prompt: "a walk", look: "Old" });
    if ("error" in old) throw new Error(old.error);
    expect(old.input.loras).toEqual([{ id: "personal-old", strength: 0.5 }]);
  });
});

// ─── Train with: Higgsfield Soul ID ───────────────────────────────────────────

describe("Higgsfield (stubbed): Soul ID from the training set, and pictures with it", () => {
  const HF_KEY = "12345678-1234-4234-8234-123456789016";

  function higgsfieldFake(harness: TestHarness, fake: Fake) {
    const base = harness.ctx.http.fetch;
    harness.ctx.http.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.host !== "api.higgsfield.ai" && u.host !== "cdn.higgsfield.ai") return base(url, init);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      fake.calls.push({ url, method: init?.method ?? "GET", body, headers: (init?.headers ?? {}) as Record<string, string> });
      if (u.host === "cdn.higgsfield.ai") return new Response(new Uint8Array(PICTURE), { status: 200, headers: { "Content-Type": "image/png" } });
      if (u.pathname === "/files/generate-upload-url") return json(200, { upload_url: "https://uploads.higgsfield.ai/put/1", public_url: "https://cdn.higgsfield.ai/in/1.png", upload_headers: { "Content-Type": "image/png" } });
      if (u.pathname === "/v1/custom-references") return json(200, { id: "soul-1", name: "Maja Berg", status: "queued" });
      if (u.pathname === "/v1/custom-references/soul-1") return json(200, { id: "soul-1", status: "completed" });
      if (u.pathname === "/v1/text2image/soul") return json(200, { id: "set-1", jobs: [{ id: "j1", status: "queued" }] });
      if (u.pathname === "/v1/job-sets/set-1") {
        const done = (n: number) => ({ id: `j${n}`, status: "completed", results: { raw: { url: `https://cdn.higgsfield.ai/out/${n}.png` }, min: { url: `https://cdn.higgsfield.ai/out/${n}.png` } } });
        return json(200, { id: "set-1", jobs: [done(1), done(2), done(3), done(4)] });
      }
      return json(404, { detail: "unexpected" });
    }) as typeof harness.ctx.http.fetch;
  }

  it("makes a Soul ID from 5-20 ticked pictures, polls it ready, then generates training pictures and agent pictures with it", async () => {
    const { harness, fake } = await setup({ higgsfieldKeySecretRef: HF_KEY });
    higgsfieldFake(harness, fake);
    await ageModel(harness);
    const identity = await makeIdentity(harness);
    await harness.performAction("trainingSet.add", { identityId: identity.id, pictures: [FACE, BODY, OUTFIT, LOOKREF1].map(up) }, owner);
    await harness.performAction("trainingSet.select", { identityId: identity.id, fileIds: [FACE, BODY, OUTFIT, LOOKREF1] }, owner);
    await expect(harness.performAction("higgsfield.soulId", { identityId: identity.id }, owner)).rejects.toThrow(/5 to 20/);
    await harness.performAction("trainingSet.add", { identityId: identity.id, pictures: [up(LOOKREF2)] }, owner);
    await harness.performAction("trainingSet.select", { identityId: identity.id, fileIds: [FACE, BODY, OUTFIT, LOOKREF1, LOOKREF2] }, owner);
    await expect(harness.performAction("higgsfield.soulId", { identityId: identity.id }, member)).rejects.toThrow(/owner or an admin/);
    const reserve = vi.spyOn(harness.ctx.billing, "reserveMediaStudioDirectSpend");
    const made = await harness.performAction<any>("higgsfield.soulId", { identityId: identity.id, variant: "soul-cinematic" }, owner);
    expect(reserve).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ action: "higgsfield-soul-id" }));
    expect(made.identity.trainedIdentities).toEqual([expect.objectContaining({ provider: "higgsfield-soul", ref: "soul-1", variant: "soul-cinematic", status: "queued" })]);
    const create = fake.calls.find((c) => c.url === "https://api.higgsfield.ai/v1/custom-references")!;
    // The harness resolves a secret to "resolved:<ref>", which has the id:secret shape.
    expect(create.headers.Authorization).toBe(`Key resolved:${HF_KEY}`);
    expect(create.body).toEqual({ name: "Maja Berg", input_images: Array.from({ length: 5 }, () => ({ type: "image_url", image_url: "https://cdn.higgsfield.ai/in/1.png" })) });
    // Pictures went to Higgsfield's storage with the upload headers, never with the key.
    const puts = fake.bytes.filter((b) => b.url === "https://uploads.higgsfield.ai/put/1");
    expect(puts).toHaveLength(5);
    expect(puts[0]!.headers).toEqual({ "Content-Type": "image/png" });

    const ready = await harness.performAction<any>("trained.status", { identityId: identity.id }, owner);
    expect(ready.identity.trainedIdentities[0].status).toBe("completed");

    // Training pictures on Higgsfield: Soul with the Soul ID, no reference pictures.
    const pics = await harness.performAction<any>("trainingSet.generate", { identityId: identity.id, service: "higgsfield", model: "soul", prompt: "profile view", count: 2 }, owner);
    expect(pics.pictures).toHaveLength(2);
    expect(pics.pictures[0]).toMatchObject({ service: "higgsfield", model: "soul", workflowId: "set-1" });
    expect(typeof pics.pictures[0].seed).toBe("number");
    const gen = fake.calls.find((c) => c.url === "https://api.higgsfield.ai/v1/text2image/soul")!;
    expect(gen.body.params).toMatchObject({ custom_reference_id: "soul-1", custom_reference_strength: 1, batch_size: 4, quality: "1080p" });
    expect(gen.body.params.prompt).toMatch(/profile view/);

    // An agent picture with provider higgsfield: the person's Soul ID, no reference pictures.
    const prepared = await prepareGeneration(harness.ctx, COMPANY, { prompt: "Maja on a beach", provider: "higgsfield" });
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.input.customReferenceId).toBe("soul-1");
    expect(prepared.input.referenceImages ?? []).toHaveLength(0);
    expect(prepared.notes.join(" ")).toMatch(/Higgsfield takes no reference pictures/);
  });

  it("an agent's Higgsfield picture is budget-checked before the call and its cost recorded after (an estimate)", async () => {
    const { harness, fake } = await setup({ higgsfieldKeySecretRef: HF_KEY });
    higgsfieldFake(harness, fake);
    const run = { agentId: "agent-maja", companyId: COMPANY, runId: "run-1" };
    const soulCalls = () => fake.calls.filter((c) => c.url === "https://api.higgsfield.ai/v1/text2image/soul");

    const check = vi.spyOn(harness.ctx.billing, "checkAgentMediaSpend").mockResolvedValueOnce({ allowed: false, message: "This agent is over its monthly budget.", reason: "agent_budget" });
    const record = vi.spyOn(harness.ctx.billing, "recordAgentMediaCost");
    const refused = await harness.executeTool<any>("generate-image", { prompt: "a sofa", provider: "higgsfield" }, run);
    expect(refused.error).toMatch(/over its monthly budget/);
    expect(check).toHaveBeenCalledWith(COMPANY, { runId: "run-1", kind: "image", provider: "higgsfield", usage: { images: 1 } });
    expect(soulCalls()).toHaveLength(0);
    expect(record).not.toHaveBeenCalled();

    const made = await harness.executeTool<any>("generate-image", { prompt: "a sofa", provider: "higgsfield" }, run);
    expect(made.error).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(2);
    expect(soulCalls()).toHaveLength(1);
    expect(check.mock.invocationCallOrder[1]!).toBeLessThan(record.mock.invocationCallOrder[0]!);
    expect(record).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ runId: "run-1", kind: "image", provider: "higgsfield", model: "soul", usage: { images: 1 } }));

  });

  it("refuses a key that is not id:secret, and says plainly that Soul takes no reference pictures", async () => {
    expect(() => readHiggsfieldCredentials("just-a-key")).toThrow(/id:secret/);
    const provider = new HiggsfieldProvider(new HiggsfieldClient({ credentials: "a:b", apiFetch: vi.fn() as never, bytesFetch: vi.fn() as never }));
    await expect(provider.generate({ prompt: "x", referenceImages: ["data:image/png;base64,AA=="] })).rejects.toThrow(/does not take reference pictures/);
    expect(soulSize("portrait_16_9")).toBe("1152x2048");
    expect(soulSize("1280x720")).toBe("2048x1152");
  });
});

describe("the zip writer", () => {
  it("writes a valid stored zip with correct CRCs", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    const zip = zipStore([{ name: "a.txt", bytes: Buffer.from("hello") }]);
    expect(zip.readUInt32LE(14)).toBe(crc32(Buffer.from("hello")));
    expect(zip.subarray(30, 35).toString()).toBe("a.txt");
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });
});

// ─── Each company's own service keys ──────────────────────────────────────────

describe("each company's own service keys (Sogni, Fal.ai, Higgsfield)", () => {
  const COMPANY_FAL = "12345678-1234-4234-8234-123456789020";
  const COMPANY_HIGGS = "12345678-1234-4234-8234-123456789021";
  const UNREADABLE = "12345678-1234-4234-8234-123456789022";

  it("without its own keys a company uses the instance's, and the page says so in plain words", async () => {
    const { harness } = await setup();
    const res = await harness.performAction<any>("serviceKeys.get", {}, member);
    expect(res.canManage).toBe(false);
    expect(res.keys.map((k: any) => [k.service, k.source, k.sourceText, k.companySecretId])).toEqual([
      ["sogni", "instance", "Using the instance's key (set by the instance admin)", null],
      ["fal", "instance", "Using the instance's key (set by the instance admin)", null],
      ["higgsfield", "none", expect.stringMatching(/^No key yet/), null],
    ]);
    for (const k of res.keys) expect(k.help.length).toBeGreaterThan(40);
  });

  it("only the company's owner or an admin can pick keys, and only secrets the company can read", async () => {
    const { harness } = await setup();
    await expect(harness.performAction("serviceKeys.save", { fal: COMPANY_FAL }, member)).rejects.toThrow(/owner or an admin/);
    await expect(harness.performAction("serviceKeys.save", { fal: "sk-live-not-a-secret-id" }, owner)).rejects.toThrow(/company's Secrets/);
    const realResolve = harness.ctx.secrets.resolve.bind(harness.ctx.secrets);
    harness.ctx.secrets.resolve = vi.fn(async (ref: string) => {
      if (ref === UNREADABLE) throw new Error("Secret not found");
      return realResolve(ref);
    }) as never;
    await expect(harness.performAction("serviceKeys.save", { fal: UNREADABLE }, owner)).rejects.toThrow(/could not be read/);
    expect((await harness.performAction<any>("serviceKeys.get", {}, owner)).keys[1]).toMatchObject({ service: "fal", source: "instance" });
  });

  it("the company's own key wins for that company only; clearing it goes back to the instance's key", async () => {
    const { harness, fake } = await setup();
    const saved = await harness.performAction<any>("serviceKeys.save", { fal: COMPANY_FAL, higgsfield: COMPANY_HIGGS }, owner);
    expect(saved.keys.map((k: any) => [k.service, k.source, k.companySecretId])).toEqual([
      ["sogni", "instance", null],
      ["fal", "company", COMPANY_FAL],
      ["higgsfield", "company", COMPANY_HIGGS],
    ]);
    expect(saved.keys[1].sourceText).toBe("This company's own key");
    // Another company still sees (and would use) the instance's keys.
    expect((await harness.performAction<any>("serviceKeys.get", {}, otherOwner)).keys.map((k: any) => k.source)).toEqual(["instance", "instance", "none"]);
    expect((await harness.performAction<any>("identities.generationOptions", {}, owner)).services).toEqual({ sogni: true, fal: true, higgsfield: true });
    expect((await harness.performAction<any>("identities.generationOptions", {}, otherOwner)).services).toEqual({ sogni: true, fal: true, higgsfield: false });
    expect(await harness.performAction<any>("edit.capabilities", {}, owner)).toEqual({ sogni: true, fal: true, higgsfield: true });

    // A real Fal call for this company is made with the company's key.
    const identity = await makeIdentity(harness);
    await harness.performAction<any>("identities.candidates", { identityId: identity.id, kind: "portrait", service: "fal", model: "fal-ai/flux-2-pro/edit" }, owner);
    const call = fake.calls.find((c) => c.url === "https://fal.run/fal-ai/flux-2-pro/edit")!;
    expect(call.headers.Authorization).toBe(`Key resolved:${COMPANY_FAL}`);

    // Cleared: back to the instance's key.
    const cleared = await harness.performAction<any>("serviceKeys.save", { fal: null }, owner);
    expect(cleared.keys.map((k: any) => k.source)).toEqual(["instance", "instance", "company"]);
    fake.calls.length = 0;
    await harness.performAction<any>("identities.candidates", { identityId: identity.id, kind: "portrait", service: "fal", model: "fal-ai/flux-2-pro/edit" }, owner);
    expect(fake.calls.find((c) => c.url === "https://fal.run/fal-ai/flux-2-pro/edit")!.headers.Authorization).toBe(`Key resolved:${FAL_REF}`);
  });

  it("no key reaches the browser: the page only gets secret ids and where each key comes from", async () => {
    const { harness } = await setup();
    await harness.performAction("serviceKeys.save", { fal: COMPANY_FAL }, owner);
    const text = JSON.stringify(await harness.performAction<any>("serviceKeys.get", {}, owner));
    expect(text).not.toContain("resolved:");
    expect(text).not.toContain(FAL_REF);
  });
});


// ─── Age check before pictures leave Paperclip ────────────────────────────────

describe("age check: every picture must be clearly of an adult before it leaves Paperclip", () => {
  const HIGGS_KEY = "12345678-1234-4234-8234-123456789016";
  const P = Array.from({ length: 10 }, (_, i) => `a${i}a${i}a${i}a${i}-0000-4000-8000-00000000000${i}`);
  const COPY = "c0c0c0c0-0000-4000-8000-00000000c0c0";
  const OTHER_COPY = "d0d0d0d0-0000-4000-8000-00000000d0d0";
  const GENERATED = "e0e0e0e0-0000-4000-8000-00000000e0e0";
  const ageKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: "pictureAgeChecks" });
  let BYTES: Buffer[];

  async function world(config: Record<string, unknown> = {}) {
    const { harness, fake } = await setup(config);
    BYTES ??= await Promise.all(Array.from({ length: 11 }, (_, i) => solid(20, 20, [i * 20, 255 - i * 20, 7])));
    harness.seed({
      companyFiles: [
        ...P.map((id, i) => ({ ...(file(id, BYTES[i]!) as object), originalFilename: `photo-${i + 1}.png` }) as never),
        // The same bytes as photo-1, uploaded again under a new file id.
        file(COPY, BYTES[0]!),
        // The same bytes in another company.
        file(OTHER_COPY, BYTES[0]!, OTHER),
        // A newly generated picture (new content).
        file(GENERATED, BYTES[10]!),
      ],
    });
    return { harness, fake };
  }

  async function tickedSet(harness: TestHarness, ids: string[]) {
    const identity = await makeIdentity(harness);
    await harness.performAction("trainingSet.add", { identityId: identity.id, pictures: ids.map(up) }, owner);
    await harness.performAction("trainingSet.select", { identityId: identity.id, fileIds: ids }, owner);
    return identity;
  }

  const ageCalls = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter((c) => (c[1] as { systemPrompt: string }).systemPrompt === AGE_CHECK_SYSTEM_PROMPT);
  const outsideCalls = (fake: Fake) =>
    fake.calls.filter((c) => /queue\.fal\.run|rest\.alpha\.fal\.ai|huggingface\.co|api\.higgsfield\.ai/.test(c.url)).length + fake.bytes.length;

  it("reads the model's answer strictly: only true is an adult", () => {
    expect(parseAgeCheck('{"apparentAdult": true}')).toBe("adult");
    expect(parseAgeCheck('```json\n{"apparentAdult": true}\n```')).toBe("adult");
    expect(parseAgeCheck('{"apparentAdult": false}')).toBe("under18");
    expect(parseAgeCheck('{"apparentAdult": null}')).toBe("unclear");
    expect(parseAgeCheck("I can't help with judging people's ages.")).toBe("unclear");
    expect(parseAgeCheck('{"refused": true}')).toBe("unclear");
    expect(parseAgeCheck('{"apparentAdult": "yes"}')).toBe("unreadable");
    expect(parseAgeCheck('{"apparentAdult": true, "age": 30}')).toBe("unreadable");
    expect(parseAgeCheck("maybe")).toBe("unreadable");
  });

  it("keeps the result by the picture's content: a re-uploaded copy (new file id) is not checked again", async () => {
    const { harness } = await world();
    const analyse = await ageModel(harness);
    const first = await harness.performAction<any>("ageCheck.run", { fileIds: [P[0]] }, owner);
    expect(first.pictures).toEqual([expect.objectContaining({ fileId: P[0], verdict: "adult" })]);
    expect(ageCalls(analyse)).toHaveLength(1);
    expect(analyse.mock.calls[0]![1]).toMatchObject({ entryId: AGE_ENTRY, fileId: P[0], keySecretId: SECRET });
    const stored = (await harness.ctx.state.get(ageKey(COMPANY))) as Record<string, any>;
    const hash = sha256Of(BYTES[0]!);
    expect(stored[hash]).toEqual({ sha256: hash, verdict: "adult", modelEntryId: AGE_ENTRY, checkedAt: expect.any(String) });
    const copy = await harness.performAction<any>("ageCheck.status", { fileIds: [COPY] }, member);
    expect(copy.pictures[0]).toMatchObject({ fileId: COPY, verdict: "adult" });
    expect(copy.explanation).toBe("Every picture is checked for apparent age before it leaves Paperclip. Pictures that are not clearly of an adult are never sent.");
    expect(copy.costNote).toMatch(/one call each/);
    await harness.performAction("ageCheck.run", { fileIds: [COPY] }, owner);
    expect(ageCalls(analyse)).toHaveLength(1);
    await expect(harness.performAction("ageCheck.run", { fileIds: [P[1]] }, member)).rejects.toThrow(/owner or an admin/);
  });

  it("checks pictures not checked yet automatically (one call each) before training, then never again", async () => {
    const { harness, fake } = await world();
    const analyse = await ageModel(harness);
    const identity = await tickedSet(harness, P);
    expect(ageCalls(analyse)).toHaveLength(0);
    const started = await harness.performAction<any>("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner);
    expect(started.identity.training.status).toBe("training");
    expect(ageCalls(analyse).map((c) => (c[1] as { fileId: string }).fileId).sort()).toEqual([...P].sort());
    expect(ageCalls(analyse).every((c) => c[0] === COMPANY)).toBe(true);
    // The download of the same pictures needs no new check.
    await harness.performAction("trainingSet.download", { identityId: identity.id }, owner);
    expect(ageCalls(analyse)).toHaveLength(10);
    expect(fake.calls.some((c) => c.url === "https://queue.fal.run/fal-ai/krea-2-trainer")).toBe(true);
  });

  it("refuses unclear and under-18 pictures, lists them, and sends nothing anywhere (Fal, Higgsfield, zip, Hugging Face)", async () => {
    const { harness, fake } = await world({ higgsfieldKeySecretRef: HIGGS_KEY });
    const answers: Record<string, string> = { [P[3]!]: '{"apparentAdult": null}', [P[7]!]: '{"apparentAdult": false}' };
    const analyse = await ageModel(harness, (id) => answers[id] ?? '{"apparentAdult": true}');
    const identity = await tickedSet(harness, P);
    const reserve = vi.spyOn(harness.ctx.billing, "reserveMediaStudioDirectSpend");
    const err = await harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner).catch((e) => e as Error);
    expect(String(err)).toMatch(/Nothing was sent: 2 pictures are not clearly of an adult/);
    expect(String(err)).toContain("photo-4.png (not clearly an adult)");
    expect(String(err)).toContain("photo-8.png (may be under 18)");
    await expect(harness.performAction("trainingSet.download", { identityId: identity.id }, owner)).rejects.toThrow(/not clearly of an adult/);
    await harness.performAction("trainingSet.select", { identityId: identity.id, fileIds: P.slice(0, 5) }, owner);
    await expect(harness.performAction("higgsfield.soulId", { identityId: identity.id }, owner)).rejects.toThrow(/photo-4\.png/);
    expect(reserve).not.toHaveBeenCalled();
    expect(outsideCalls(fake)).toBe(0);
    expect(((await harness.ctx.state.get(identitiesKey)) as Identity[])[0]!.training).toBeNull();
    // The verdicts are kept: a later "adult" answer cannot change them, and no new call is made.
    const before = ageCalls(analyse).length;
    delete answers[P[3]!];
    await expect(harness.performAction("higgsfield.soulId", { identityId: identity.id }, owner)).rejects.toThrow(/photo-4\.png/);
    expect(ageCalls(analyse)).toHaveLength(before);
    // A copy of a refused picture cannot even join a training set, and Analyse refuses it without a call.
    const stored = (await harness.ctx.state.get(ageKey(COMPANY))) as Record<string, any>;
    expect(stored[sha256Of(BYTES[7]!)].verdict).toBe("under18");
    expect(stored[sha256Of(BYTES[3]!)].verdict).toBe("unclear");
  });

  it("an unreadable answer is not stored and sends nothing; no analysis model means nothing is sent", async () => {
    const { harness, fake } = await world();
    const identity = await tickedSet(harness, P);
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner)).rejects.toThrow(/Pick an analysis model/);
    await expect(harness.performAction("trainingSet.download", { identityId: identity.id }, owner)).rejects.toThrow(/Pick an analysis model/);
    const analyse = await ageModel(harness, () => "The person is wearing a blue shirt.");
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner)).rejects.toThrow(/could not be read/);
    expect(ageCalls(analyse)).toHaveLength(1);
    expect(await harness.ctx.state.get(ageKey(COMPANY))).toBeFalsy();
    expect(outsideCalls(fake)).toBe(0);
  });

  it("a newly generated picture added to the set is new content and is checked before it is sent", async () => {
    const { harness } = await world();
    const analyse = await ageModel(harness);
    const identity = await tickedSet(harness, P);
    await harness.performAction("trainingSet.download", { identityId: identity.id }, owner);
    expect(ageCalls(analyse)).toHaveLength(10);
    await harness.performAction(
      "trainingSet.add",
      { identityId: identity.id, pictures: [{ fileId: GENERATED, provenance: { service: "sogni", model: "krea-identity-edit", prompt: "profile view", loras: [] } }] },
      owner,
    );
    await harness.performAction("trainingSet.select", { identityId: identity.id, fileIds: [...P, GENERATED] }, owner);
    await harness.performAction("trainingSet.download", { identityId: identity.id }, owner);
    expect(ageCalls(analyse)).toHaveLength(11);
    expect((ageCalls(analyse).at(-1)![1] as { fileId: string }).fileId).toBe(GENERATED);
  });

  it("a copy of a refused picture is refused when added, and by Analyse, without asking the model", async () => {
    const { harness } = await world();
    const analyse = await ageModel(harness, () => '{"apparentAdult": false}');
    await harness.performAction("ageCheck.run", { fileIds: [P[0]] }, owner);
    expect(analyse).toHaveBeenCalledTimes(1);
    const identity = await makeIdentity(harness);
    await expect(harness.performAction("trainingSet.add", { identityId: identity.id, pictures: [up(COPY)] }, owner)).rejects.toThrow(/may be under 18/);
    expect(await harness.performAction<any>("identities.analyse", { fileId: COPY }, owner)).toMatchObject({ ok: false, blocked: true });
    expect(analyse).toHaveBeenCalledTimes(1);
  });

  it("a Hugging Face publish checks the pictures the LoRA was trained on", async () => {
    const { harness, fake } = await world();
    await ageModel(harness);
    const identity = await tickedSet(harness, P);
    await harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner);
    fake.falStatus = "COMPLETED";
    await harness.performAction("lora.status", { identityId: identity.id }, owner);
    await harness.performAction("identitySettings.save", { analysis: { entryId: AGE_ENTRY, keySecretId: SECRET }, hfTokenSecretId: HF_SECRET }, owner);
    // Found later to be not clearly adult (e.g. checked again by Analyse with a stricter model).
    const hash = sha256Of(BYTES[2]!);
    const stored = (await harness.ctx.state.get(ageKey(COMPANY))) as Record<string, any>;
    await harness.ctx.state.set(ageKey(COMPANY), { ...stored, [hash]: { ...stored[hash], verdict: "unclear" } });
    await expect(harness.performAction("lora.publish", { identityId: identity.id, repoName: "maja-lora", confirmPublic: true }, owner)).rejects.toThrow(/photo-3\.png/);
    expect(fake.calls.some((c) => c.url.startsWith("https://huggingface.co/"))).toBe(false);
    expect(fake.bytes.some((b) => b.url.startsWith("https://hf-hub-lfs"))).toBe(false);
  });

  it("results are kept per company: another company's copy of the same picture is checked on its own", async () => {
    const { harness } = await world();
    const analyse = await ageModel(harness, () => '{"apparentAdult": false}');
    await harness.performAction("ageCheck.run", { fileIds: [P[0]] }, owner);
    // The other company has the same bytes but no result of its own.
    await harness.performAction("identitySettings.save", { analysis: { entryId: AGE_ENTRY, keySecretId: SECRET } }, otherOwner);
    expect((await harness.performAction<any>("ageCheck.status", { fileIds: [OTHER_COPY] }, otherOwner)).pictures[0].verdict).toBeNull();
    await expect(harness.performAction("ageCheck.status", { fileIds: [P[0]] }, otherOwner)).rejects.toThrow(/not in this company's Files/);
    analyse.mockImplementation(async () => ({ text: '{"apparentAdult": true}', entryName: "x", provider: "anthropic", model: "m", costCents: 1 }));
    const other = await harness.performAction<any>("ageCheck.run", { fileIds: [OTHER_COPY] }, otherOwner);
    expect(other.pictures[0].verdict).toBe("adult");
    expect(analyse.mock.calls.at(-1)![0]).toBe(OTHER);
    expect(((await harness.ctx.state.get(ageKey(COMPANY))) as Record<string, any>)[sha256Of(BYTES[0]!)].verdict).toBe("under18");
    expect(((await harness.ctx.state.get(ageKey(OTHER))) as Record<string, any>)[sha256Of(BYTES[0]!)].verdict).toBe("adult");
  });
});
