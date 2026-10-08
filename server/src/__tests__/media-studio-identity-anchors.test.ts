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

describe("Analyse picture (stubbed model)", () => {
  async function withSettings(harness: TestHarness, provider = "anthropic") {
    await harness.performAction(
      "identitySettings.save",
      { analysis: { source: "custom", provider, model: provider === "anthropic" ? "claude-sonnet-5" : "qwen/qwen2.5-vl-72b-instruct", keySecretId: SECRET }, hfTokenSecretId: HF_SECRET },
      owner,
    );
  }

  it("needs a chosen analysis model; settings are owner/admin only", async () => {
    const { harness } = await setup();
    await expect(harness.performAction("identities.analyse", { fileId: ORIGINAL }, owner)).rejects.toThrow(/Pick an analysis model/);
    await expect(
      harness.performAction("identitySettings.save", { analysis: { provider: "anthropic", model: "x" } }, member),
    ).rejects.toThrow(/owner or an admin/);
    await expect(harness.performAction("identitySettings.save", { hfTokenSecretId: "not-a-secret" }, owner)).rejects.toThrow(/Secrets/);
  });

  it("sends the picture to the chosen model with the key from the company secret and returns the checked result", async () => {
    const { harness, fake } = await setup();
    await withSettings(harness);
    fake.analysisAnswer = JSON.stringify(GOOD_ANALYSIS);
    const res = await harness.performAction<any>("identities.analyse", { fileId: ORIGINAL }, owner);
    expect(res).toMatchObject({ ok: true, sheet: { eyes: "blue almond eyes" }, crops: { face: { x: 0.35 } } });
    const call = fake.calls.find((c) => c.url === "https://api.anthropic.com/v1/messages")!;
    expect(call.headers["x-api-key"]).toBe(`resolved:${SECRET}`);
    expect(call.body.system).toBe(ANALYSIS_SYSTEM_PROMPT);
    expect(call.body.messages[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg" } });
  });

  it("works with an OpenAI-compatible model too, and a refusal is a plain message", async () => {
    const { harness, fake } = await setup();
    await withSettings(harness, "openrouter");
    fake.analysisAnswer = "I can't describe people in pictures.";
    const res = await harness.performAction<any>("identities.analyse", { fileId: ORIGINAL }, owner);
    expect(res).toMatchObject({ ok: false, blocked: false });
    expect(res.message).toMatch(/Try another analysis model/);
    const call = fake.calls.find((c) => c.url === "https://openrouter.ai/api/v1/chat/completions")!;
    expect(call.headers.authorization).toBe(`Bearer resolved:${SECRET}`);
    expect(call.body.messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("an answer that cannot confirm an adult blocks the picture for analysis, crops and saving", async () => {
    const { harness, fake } = await setup();
    await withSettings(harness);
    fake.analysisAnswer = JSON.stringify({ ...GOOD_ANALYSIS, apparentAdult: "unsure" });
    const res = await harness.performAction<any>("identities.analyse", { fileId: ORIGINAL }, owner);
    expect(res).toMatchObject({ ok: false, blocked: true });
    expect(res.message).toMatch(/adult/);
    await expect(
      harness.performAction("identities.crop", { fileId: ORIGINAL, boxes: [{ role: "face", box: { x: 0, y: 0, w: 0.5, h: 0.5 } }] }, owner),
    ).rejects.toThrow(/under 18/);
    await expect(makeIdentity(harness)).rejects.toThrow(/under 18/);
    // The block holds even with a model that would now say "yes".
    fake.analysisAnswer = JSON.stringify(GOOD_ANALYSIS);
    expect(await harness.performAction<any>("identities.analyse", { fileId: ORIGINAL }, owner)).toMatchObject({ ok: false, blocked: true });
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

// ─── LoRA training ────────────────────────────────────────────────────────────

describe("LoRA training flow (stubbed Fal and Hugging Face)", () => {
  async function ready(harness: TestHarness) {
    const identity = await makeIdentity(harness);
    const ids = [FACE, BODY, OUTFIT, LOOKREF1, LOOKREF2, ROOM, SOFA, ORIGINAL, MASK];
    await harness.performAction("lora.addPictures", { identityId: identity.id, fileIds: ids }, owner);
    return { identity, ids };
  }

  it("the price matches the shared constant and the host's reservation", () => {
    expect(LORA_TRAINING_STEPS).toBe(MEDIA_STUDIO_LORA_TRAINING_STEPS);
    expect(loraTrainingCostCents()).toBe(estimateMediaStudioEditCostCents("lora-training"));
    expect(loraTrainingCostCents()).toBe(300);
    expect(mediaStudioEditActionProvider("lora-training")).toBe("fal");
    expect(mediaStudioEditActionProvider("identity-pictures")).toBe("sogni");
  });

  it("the state machine only allows the documented moves", () => {
    expect(() => assertTrainingMove("collecting", "published")).toThrow(/cannot move/);
    expect(() => assertTrainingMove("training", "collecting")).toThrow(/cannot move/);
    expect(() => assertTrainingMove("trained", "published")).not.toThrow();
    expect(() => assertTrainingMove("failed", "training")).not.toThrow();
  });

  it("training pictures come from the face crop with varied requests", async () => {
    const { harness, fake } = await setup();
    const identity = await makeIdentity(harness);
    const res = await harness.performAction<any>("lora.pictures", { identityId: identity.id, index: 4 }, owner);
    expect(res.pictures).toHaveLength(2);
    const start = fake.calls.find((c) => c.url.endsWith("/v1/creative-agent/workflows") && c.method === "POST")!;
    expect(start.body.input.steps[0].arguments.prompt).toMatch(/walking on a city street/);
  });

  it("collect -> tick (at least 10) -> confirm price -> train -> poll -> publish (public) -> import into Sogni", async () => {
    const { harness, fake } = await setup();
    const { identity, ids } = await ready(harness);
    await expect(harness.performAction("lora.select", { identityId: identity.id, fileIds: [FOREIGN] }, owner)).rejects.toThrow(/Only pictures made for this training/);
    await harness.performAction("lora.select", { identityId: identity.id, fileIds: ids }, owner);
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner)).rejects.toThrow(/at least 10/);
    // Ten ticked pictures (one more added).
    await harness.performAction("lora.addPictures", { identityId: identity.id, fileIds: [EXTRA] }, owner);
    const all = [...ids, EXTRA];
    await harness.performAction("lora.select", { identityId: identity.id, fileIds: all }, owner);
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg" }, owner)).rejects.toThrow(/\$3\.00/);
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, member)).rejects.toThrow(/owner or an admin/);
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "a", confirmCostCents: 300 }, owner)).rejects.toThrow(/trigger word/);

    const reserve = vi.spyOn(harness.ctx.billing, "reserveMediaStudioDirectSpend");
    const started = await harness.performAction<any>("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner);
    expect(reserve).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ action: "lora-training" }));
    expect(started.identity.training).toMatchObject({ status: "training", falRequestId: "req-1", triggerWord: "majaberg", steps: 1000 });
    const zipPut = fake.bytes.find((b) => b.url === "https://upload.fal.media/put/zip")!;
    const zip = Buffer.from(zipPut.body as Uint8Array);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(10); // ten pictures
    const submit = fake.calls.find((c) => c.url === "https://queue.fal.run/fal-ai/krea-2-trainer" && c.method === "POST")!;
    expect(submit.body).toMatchObject({ images_data_url: "https://v3.fal.media/files/dataset.zip", trigger_phrase: "majaberg", steps: 1000 });
    expect(submit.headers.Authorization).toBe(`Key resolved:${FAL_REF}`);
    await expect(harness.performAction("lora.train", { identityId: identity.id, triggerWord: "majaberg", confirmCostCents: 300 }, owner)).rejects.toThrow(/cannot move/);

    // Still training.
    expect((await harness.performAction<any>("lora.status", { identityId: identity.id }, member)).progress).toBe("training");
    fake.falStatus = "COMPLETED";
    const done = await harness.performAction<any>("lora.status", { identityId: identity.id }, member);
    expect(done.identity.training).toMatchObject({ status: "trained", resultUrl: "https://v3.fal.media/files/lora.safetensors" });

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
      sogniLoraId: null,
    });
    expect(published.identity.training.status).toBe("published");
    const create = fake.calls.find((c) => c.url === "https://huggingface.co/api/repos/create")!;
    expect(create.body).toMatchObject({ type: "model", name: "maja-lora", private: false });
    expect(create.headers.Authorization).toBe(`Bearer resolved:${HF_SECRET}`);
    const lfsPut = fake.bytes.find((b) => b.url.startsWith("https://hf-hub-lfs"))!;
    expect(Buffer.from(lfsPut.body as Uint8Array).toString()).toBe("SAFETENSORS-BYTES");
    const commit = fake.calls.find((c) => c.url === "https://huggingface.co/api/models/acme/maja-lora/commit/main")!;
    expect(String(commit.body).split("\n").map((l) => JSON.parse(l).key)).toEqual(["header", "lfsFile", "file"]);

    const imported = await harness.performAction<any>("lora.importSogni", { identityId: identity.id }, owner);
    expect(imported.identity.lora).toMatchObject({ sogniLoraId: "personal-abc", sogniStatus: "queued" });
    const importCall = fake.calls.find((c) => c.url === "https://api.sogni.ai/v1/loras/personal")!;
    expect(importCall.body).toMatchObject({ url: published.identity.lora.url, modelId: "krea2_identity_edit_v1_2", rightsConfirmed: true });
    const checked = await harness.performAction<any>("lora.sogniStatus", { identityId: identity.id }, owner);
    expect(checked.identity.lora.sogniStatus).toBe("ready");
  });

  it("a failed training gives the reservation back and can be retried", async () => {
    const { harness, fake } = await setup();
    const { identity, ids } = await ready(harness);
    await harness.performAction("lora.addPictures", { identityId: identity.id, fileIds: [EXTRA] }, owner);
    await harness.performAction("lora.select", { identityId: identity.id, fileIds: [...ids, EXTRA] }, owner);
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

  it("a ready Sogni LoRA rides along only with a filter-off look and a Krea model", async () => {
    const { harness } = await setup();
    const identity = await makeIdentity(harness, {
      lora: { source: "huggingface", url: "https://huggingface.co/acme/m/resolve/main/m.safetensors", triggerWord: "majaberg", strength: 0.7, sogniLoraId: "personal-abc", sogniStatus: "ready" },
    });
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "looks" }, [
      { id: "on", name: "Filtered", style: "", model: null, seed: null, referenceFileIds: [], identityId: identity.id, updatedAt: "x" },
      { id: "off", name: "Open", style: "", model: null, seed: null, referenceFileIds: [], identityId: identity.id, safeContentFilter: false, contentFilterOffBy: "owner-1", updatedAt: "x" },
    ]);
    const filtered = await prepareGeneration(harness.ctx, COMPANY, { prompt: "a walk", look: "Filtered" });
    if ("error" in filtered) throw new Error(filtered.error);
    expect(filtered.input.loras ?? []).toHaveLength(0);
    expect(filtered.notes.join(" ")).toMatch(/LoRA of "Maja Berg" was not used/);
    const open = await prepareGeneration(harness.ctx, COMPANY, { prompt: "a walk", look: "Open" });
    if ("error" in open) throw new Error(open.error);
    expect(open.input.loras).toEqual([{ id: "personal-abc", strength: 0.7 }]);
    expect(open.input.prompt.startsWith("majaberg, a walk")).toBe(true);
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
