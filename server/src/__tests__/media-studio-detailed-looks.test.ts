import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin, { lookReferenceLimit } from "../../../packages/plugins/media-studio/src/worker.js";
import manifest, { TOOL_GENERATE, TOOL_LIST_LOOKS, TOOL_QUICK_PICTURE } from "../../../packages/plugins/media-studio/src/manifest.js";
import {
  CHARACTER_INTRO,
  REFERENCE_ROLE_LABELS,
  SHEET_FIELDS,
  aspectsInRequest,
  assemblePrompt,
  normalizeRoles,
  normalizeSheet,
  roleInstructions,
} from "../../../packages/plugins/media-studio/src/look-prompt.js";
import { catalogMaxReferences, parseSogniModelCatalog } from "../../../packages/plugins/media-studio/src/sogni-catalog.js";
import { sogniMaxReferences } from "../../../packages/plugins/media-studio/src/sogni.js";

/**
 * Detailed looks: a role for each reference picture, a character sheet, the
 * prompt built from both (the request wins), the role sentences each service
 * gets, each Sogni model's own reference limit, older looks read as before,
 * and the looks page's "Preview prompt". Fal and Sogni are faked.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const MAJA = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const REFS = [
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888",
  "99999999-9999-4999-8999-999999999999",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
];
const runCtx = { agentId: MAJA, runId: RUN, companyId: COMPANY, projectId: "" };
const looksKey = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: "looks" };
const owner = { actor: { type: "user" as const, userId: "owner-1", canManageCompany: true }, companyId: COMPANY };
const member = { actor: { type: "user" as const, userId: "member-1", canManageCompany: false }, companyId: COMPANY };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
const ARTIFACT_URL = "https://complete-images.s3-accelerate.amazonaws.com/d/picture.png?X-Amz-Signature=abc";
const WORKFLOW_ID = "wf_detailed_1";

/**
 * Sogni's public model catalog (the trimmed test copy), with the two things
 * today's real catalog says about reference pictures (read 2026-09-28 without
 * a key): benchmark times for 1-2 context pictures on Krea 2 Identity Edit,
 * 1-3 on Qwen Image Edit Lightning, and maxContextImages 16 on GPT Image 2.5 Flare.
 */
function catalog() {
  const json = JSON.parse(readFileSync(new URL("./fixtures/sogni/model-catalog-image.json", import.meta.url), "utf8"));
  for (const model of json.data.models) {
    if (model.id === "krea2_identity_edit_v1_2") model.parameters.benchmark = { sec: 560, secContext1: 560, secContext2: 900 };
    if (model.id === "qwen_image_edit_2511_fp8_lightning") model.parameters.benchmark = { sec: 179, secContext1: 345, secContext2: 600, secContext3: 750 };
  }
  json.data.models.push({
    id: "gpt-image-2.5-flare",
    name: "GPT Image 2.5 Flare",
    mediaType: "image",
    tierId: null,
    tags: ["new", "premium"],
    workerCounts: { fast: 9 },
    parameters: { type: "image", maxContextImages: 16, steps: { min: 1, max: 1, default: 1 } },
  });
  return json;
}
const CATALOG = catalog();
const LORA_CATALOG = JSON.parse(readFileSync(new URL("./fixtures/sogni/loras-comfy.json", import.meta.url), "utf8"));

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function companyFile(id: string) {
  const contentPath = `/api/attachments/${id}/content`;
  return {
    id,
    companyId: COMPANY,
    issueId: null,
    contentType: "image/png",
    byteSize: PNG.length,
    originalFilename: `${id.slice(0, 4)}.png`,
    createdByAgentId: null,
    contentPath,
    openPath: contentPath,
    downloadPath: `${contentPath}?download=1`,
    createdAt: new Date(),
    contentBase64: PNG.toString("base64"),
  } as never;
}

type Call = { url: string; method: string; body: any };

async function setup(config: Record<string, unknown>, looks?: unknown[]) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ companyFiles: REFS.map(companyFile), agents: [{ id: MAJA, companyId: COMPANY, name: "Maja", title: null, status: "idle" } as never] });
  await plugin.definition.setup(harness.ctx);
  if (looks) await harness.ctx.state.set(looksKey, looks);
  const calls: Call[] = [];
  harness.ctx.http.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    if (url.startsWith("https://fal.run/")) {
      return json(200, { images: [{ url: "https://v3.fal.media/files/out.jpg", content_type: "image/jpeg" }], seed: 5 });
    }
    if (url.startsWith("https://v3.fal.media/")) return new Response(PNG, { status: 200, headers: { "Content-Type": "image/jpeg" } });
    const path = new URL(url).pathname;
    if (method === "GET" && path === "/v1/model-catalog") return json(200, CATALOG);
    if (method === "GET" && path === "/v1/loras/comfy") return json(200, LORA_CATALOG);
    if (method === "POST" && path === "/v1/creative-agent/workflows") {
      return json(201, { status: "success", data: { workflow: { workflowId: WORKFLOW_ID, status: "queued" } } });
    }
    if (method === "GET" && path === `/v1/creative-agent/workflows/${WORKFLOW_ID}`) {
      return json(200, { status: "success", data: { workflow: { workflowId: WORKFLOW_ID, status: "completed", steps: [{ id: "picture", artifacts: [{ url: ARTIFACT_URL }] }] } } });
    }
    if (method === "GET" && path === "/v2/image/uploadUrl") {
      return json(200, { status: "success", data: { url: "https://uploads.s3-accelerate.amazonaws.com/", fields: { key: "k" } } });
    }
    if (method === "GET" && path === "/v2/image/downloadUrl") {
      const type = new URL(url).searchParams.get("type");
      return json(200, { status: "success", data: { downloadUrl: `https://uploads.s3-accelerate.amazonaws.com/refs/${type}` } });
    }
    return json(404, { status: "error", message: `unexpected ${method} ${url}` });
  }) as typeof harness.ctx.http.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "POST"
        ? new Response(null, { status: 204 })
        : new Response(PNG, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(PNG.length) } }),
    ),
  );
  return { harness, calls };
}

const FAL = { provider: "fal", falKeySecretRef: "fal-key-ref" };
const SOGNI = { provider: "sogni", sogniKeySecretRef: "sogni-key-ref" };
const sogniStarts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/creative-agent/workflows"));
const falCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith("https://fal.run/"));

const MAJA_SHEET = {
  hair: "long, blonde",
  face: "small, petite nose, narrow eyes, red lips",
  outfit: "cream knit sweater",
  setting: "bright living room",
  lighting: "soft daylight",
  avoid: "text, watermarks",
};

describe("prompt assembly", () => {
  it("builds the prompt from the request, the sheet and the style words, always the same way", () => {
    const out = assemblePrompt({ request: "reading a book by the window", style: "calm, Scandinavian", sheet: MAJA_SHEET, service: "fal" });
    expect(out.prompt).toBe(
      [
        "reading a book by the window",
        `${CHARACTER_INTRO}: Hair: long, blonde. Face: small, petite nose, narrow eyes, red lips. Outfit: cream knit sweater.`,
        "Setting: bright living room.",
        "Style: calm, Scandinavian",
        "Lighting: soft daylight.",
        "Keep out of the picture: text, watermarks.",
      ].join("\n\n"),
    );
    expect(out.leftOut).toEqual([]);
    expect(assemblePrompt({ request: "reading", style: "calm", sheet: MAJA_SHEET, service: "fal" })).toEqual(
      assemblePrompt({ request: "reading", style: "calm", sheet: MAJA_SHEET, service: "fal" }),
    );
  });

  it("lets the request win: an outfit or place the request names leaves the sheet's out", () => {
    const out = assemblePrompt({ request: "wearing a red dress at the beach", sheet: MAJA_SHEET, service: "sogni" });
    expect(out.requestAspects).toEqual(expect.arrayContaining(["outfit", "setting"]));
    expect(out.leftOut).toEqual(["outfit", "setting"]);
    expect(out.prompt).not.toContain("cream knit sweater");
    expect(out.prompt).not.toContain("bright living room");
    // Identity stays: face and hair are kept.
    expect(out.prompt).toContain("Face: small, petite nose, narrow eyes, red lips.");
    expect(out.prompt).toContain("Hair: long, blonde.");
    // Words inside other words do not count.
    expect(aspectsInRequest("a dressmaker's shop sign")).not.toContain("outfit");
  });

  it("keeps an older look's prompt exactly as before (no sheet, no roles)", () => {
    expect(assemblePrompt({ request: "a sofa", style: "catalogue style", sheet: {}, roles: ["other", "other"], service: "fal" }).prompt).toBe(
      "a sofa\n\nStyle: catalogue style",
    );
    expect(assemblePrompt({ request: "a sofa", service: "sogni" }).prompt).toBe("a sofa");
  });

  it("sends Always avoid as the model's own things-to-avoid text when it takes one", () => {
    const out = assemblePrompt({ request: "a sofa", sheet: { avoid: "text." }, service: "sogni", avoidAsNegative: true });
    expect(out.prompt).toBe("a sofa");
    expect(out.avoid).toBe("text.");
  });
});

describe("what each reference picture is for", () => {
  it("tells Sogni in its own words: picture N, identity from one picture, anatomy line", () => {
    expect(roleInstructions(["face", "body", "style"], "sogni")).toBe(
      "Use the person from picture 1 as the final subject and preserve their exact facial likeness: face structure, eye shape, nose shape, mouth shape, jawline, skin tone, hairline, apparent age and overall recognizability. " +
        "Body shape and proportions from picture 2. Style, colour palette and aesthetic from picture 3 only. " +
        "Identity comes only from picture 1. Do not borrow identity from pictures 2 and 3. " +
        "Maintain realistic anatomy, perspective, and lighting integration.",
    );
  });

  it("tells Fal in Black Forest Labs' words: image N, the same person, named subject", () => {
    expect(roleInstructions(["face", "outfit", "background", "other"], "fal")).toBe(
      "Keep the same person as in image 1, maintaining the same facial features, hairstyle and apparent age. " +
        "Dress the person in the outfit from image 2. Use the background and setting from image 3. Use image 4 as a general reference. " +
        "Only the person in image 1 is the subject; do not take anyone's face from images 2, 3 and 4.",
    );
    expect(roleInstructions(["face", "face"], "fal")).toBe(
      "Keep the same person as in images 1 and 2, maintaining the same facial features, hairstyle and apparent age.",
    );
  });

  it("says nothing when every picture is Other, and lets the request win over an outfit picture", () => {
    expect(roleInstructions(["other", "other"], "sogni")).toBe("");
    expect(roleInstructions(["face", "outfit"], "sogni", ["outfit"])).toContain("The outfit comes from the request, not from picture 2.");
    expect(roleInstructions(["face", "outfit"], "fal", ["outfit"])).toContain("Take the outfit from the request, not from image 2.");
  });
});

describe("older looks", () => {
  it("read with every picture as Other and an empty sheet", () => {
    expect(normalizeRoles(undefined, 3)).toEqual(["other", "other", "other"]);
    expect(normalizeRoles(["face", "nonsense"], 3)).toEqual(["face", "other", "other"]);
    expect(normalizeSheet({ hair: "  long ", nonsense: "x", face: "" })).toEqual({ hair: "long" });
    expect(Object.keys(REFERENCE_ROLE_LABELS)).toEqual(["face", "body", "outfit", "style", "background", "other"]);
    expect(SHEET_FIELDS.map((f) => f.label)).toEqual([
      "Hair", "Face", "Eyes", "Body", "Skin", "Outfit", "Accessories", "Expression/pose defaults", "Setting/background", "Art style", "Lighting", "Camera/framing", "Always avoid",
    ]);
  });
});

describe("per-model reference limits", () => {
  it("reads each model's limit from Sogni's catalog", () => {
    const models = parseSogniModelCatalog(CATALOG)!.models;
    const byId = (id: string) => models.find((m) => m.id === id)!;
    expect(byId("krea2_identity_edit_v1_2").maxReferences).toBe(2);
    expect(byId("qwen_image_edit_2511_fp8_lightning").maxReferences).toBe(3);
    expect(byId("gpt-image-2.5-flare").maxReferences).toBe(16);
    expect(catalogMaxReferences({})).toBeNull();
    expect(lookReferenceLimit("krea2_identity_edit_v1_2", byId("krea2_identity_edit_v1_2"))).toBe(2);
    expect(lookReferenceLimit("gpt-image-2.5-flare", byId("gpt-image-2.5-flare"))).toBe(16);
    // A model that only makes new pictures: reference pictures go to Sogni's default editor (3).
    expect(lookReferenceLimit("z_image_turbo_bf16", byId("z_image_turbo_bf16"))).toBe(3);
    expect(sogniMaxReferences("z-turbo", false, 16)).toBe(3);
  });
});

describe("media-studio detailed looks in the worker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function run(harness: TestHarness, tool: string, params: Record<string, unknown>) {
    const pending = harness.executeTool<any>(tool, params, runCtx);
    await vi.runAllTimersAsync();
    return pending;
  }
  async function act(harness: TestHarness, key: string, params: Record<string, unknown>, context: typeof owner | typeof member = owner) {
    const pending = harness.performAction<any>(key, params, context);
    await vi.runAllTimersAsync();
    return pending;
  }

  it("saves roles and a sheet, and a Fal picture gets the role sentences and the sheet", async () => {
    const { harness, calls } = await setup(FAL);
    const saved = await act(harness, "looks.save", {
      name: "Maja",
      style: "calm",
      seed: null,
      provider: "fal",
      referenceFileIds: [REFS[0], REFS[1]],
      referenceRoles: ["face", "outfit"],
      sheet: { ...MAJA_SHEET, unknown: "dropped" },
    });
    expect(saved.looks[0]).toMatchObject({ referenceRoles: ["face", "outfit"], sheet: MAJA_SHEET });

    const result = await run(harness, TOOL_GENERATE, { prompt: "drinking coffee", look: "Maja" });
    expect(result.error).toBeUndefined();
    const [call] = falCalls(calls);
    expect(call!.url).toBe("https://fal.run/fal-ai/flux-pro/kontext/multi");
    expect(call!.body.image_urls).toHaveLength(2);
    expect(call!.body.prompt).toBe(
      [
        "drinking coffee",
        "Keep the same person as in image 1, maintaining the same facial features, hairstyle and apparent age. Dress the person in the outfit from image 2. Only the person in image 1 is the subject; do not take anyone's face from image 2.",
        `${CHARACTER_INTRO}: Hair: long, blonde. Face: small, petite nose, narrow eyes, red lips. Outfit: cream knit sweater.`,
        "Setting: bright living room.",
        "Style: calm",
        "Lighting: soft daylight.",
        "Keep out of the picture: text, watermarks.",
      ].join("\n\n"),
    );
  });

  it("with Sogni: role sentences in picture-N words for the editor; the request's outfit wins and the agent hears why", async () => {
    const { harness, calls } = await setup(SOGNI);
    await act(harness, "looks.save", {
      name: "Maja",
      style: "",
      seed: null,
      provider: "sogni",
      referenceFileIds: [REFS[0], REFS[1]],
      referenceRoles: ["face", "outfit"],
      sheet: MAJA_SHEET,
    });
    const result = await run(harness, TOOL_GENERATE, { prompt: "wearing a red dress", look: "Maja" });
    expect(result.error).toBeUndefined();
    const [start] = sogniStarts(calls);
    expect(start!.body.media_references).toHaveLength(2);
    const step = start!.body.input.steps[0];
    expect(step.toolName).toBe("edit_image");
    expect(step.arguments.prompt).toContain("Use the person from picture 1 as the final subject");
    expect(step.arguments.prompt).toContain("The outfit comes from the request, not from picture 2.");
    expect(step.arguments.prompt).toContain("Identity comes only from picture 1. Do not borrow identity from picture 2.");
    expect(step.arguments.prompt).not.toContain("cream knit sweater");
    expect(result.content).toContain("The look's outfit was left out, because the request describes it.");
  });

  it("with a Sogni model that takes things-to-avoid text, Always avoid goes there (after the look's own)", async () => {
    const { harness, calls } = await setup(SOGNI);
    await act(harness, "looks.save", {
      name: "Chroma",
      style: "",
      seed: null,
      provider: "sogni",
      model: "chroma1-hd_fp8_scaled",
      negativePrompt: "blurry",
      referenceFileIds: [],
      sheet: { avoid: "text, watermarks" },
    });
    await run(harness, TOOL_GENERATE, { prompt: "a sofa", look: "Chroma" });
    const args = sogniStarts(calls)[0]!.body.input.steps[0].arguments;
    expect(args.negativePrompt).toBe("blurry, text, watermarks");
    expect(args.prompt).toBe("a sofa");
  });

  it("keeps each Sogni model to its own reference limit, and Fal to 4", async () => {
    const { harness, calls } = await setup(SOGNI);
    const base = { style: "", seed: null, provider: "sogni" };
    await expect(
      act(harness, "looks.save", { ...base, name: "Krea", model: "krea2_identity_edit_v1_2", referenceFileIds: REFS.slice(0, 3) }),
    ).rejects.toThrow("Sogni's Krea 2 Identity Edit model takes at most 2 reference pictures; this look has 3.");
    await expect(act(harness, "looks.save", { ...base, name: "Plain", referenceFileIds: REFS.slice(0, 4) })).rejects.toThrow(
      "Sogni's qwen-lightning model takes at most 3 reference pictures; this look has 4.",
    );
    const flare = await act(harness, "looks.save", { ...base, name: "Flare", model: "gpt-image-2.5-flare", referenceFileIds: REFS });
    expect(flare.looks[0].referenceFileIds).toHaveLength(6);
    const result = await run(harness, TOOL_GENERATE, { prompt: "a family photo", look: "Flare" });
    expect(result.error).toBeUndefined();
    expect(sogniStarts(calls)[0]!.body.media_references).toHaveLength(6);

    const fal = await setup(FAL);
    await expect(
      act(fal.harness, "looks.save", { name: "Five", style: "", seed: null, provider: "fal", referenceFileIds: REFS.slice(0, 5) }),
    ).rejects.toThrow("Pick at most 4 reference pictures");
    const models = await act(harness, "sogni.models", {}, member);
    expect(models.models.find((m: any) => m.id === "krea2_identity_edit_v1_2").referenceLimit).toBe(2);
    expect(models.models.find((m: any) => m.id === "z_image_turbo_bf16").referenceLimit).toBe(3);
  });

  it("refuses an unknown role or an over-long sheet field", async () => {
    const { harness } = await setup(FAL);
    const base = { name: "X", style: "", seed: null, provider: "fal", referenceFileIds: [REFS[0]] };
    await expect(act(harness, "looks.save", { ...base, referenceRoles: ["hands"] })).rejects.toThrow(
      "Pick what each reference picture is for (face, body, outfit, style, background or other).",
    );
    await expect(act(harness, "looks.save", { ...base, sheet: { hair: "x".repeat(301) } })).rejects.toThrow('Keep "Hair" under 300 characters.');
  });

  it("reads an older look (no roles, no sheet) and makes the same picture as before", async () => {
    const old = { id: "look-old", name: "Catalogue", style: "catalogue style", model: null, seed: null, referenceFileIds: [REFS[0]], updatedAt: "2026-09-01T00:00:00.000Z" };
    const { harness, calls } = await setup(FAL, [old]);
    const listed = await act(harness, "looks.list", {}, member);
    expect(listed.looks[0]).toMatchObject({ referenceRoles: ["other"], sheet: {} });
    await run(harness, TOOL_GENERATE, { prompt: "a sofa", look: "Catalogue" });
    expect(falCalls(calls)[0]!.body.prompt).toBe("a sofa\n\nStyle: catalogue style");
  });

  it("list-looks tells the agent about roles and the sheet", async () => {
    const look = { id: "l1", name: "Maja", style: "", model: null, seed: 7, referenceFileIds: [REFS[0], REFS[1]], referenceRoles: ["face", "body"], sheet: { hair: "long" }, updatedAt: "2026-09-28T00:00:00.000Z" };
    const { harness } = await setup(FAL, [look]);
    const result = await run(harness, TOOL_LIST_LOOKS, {});
    expect(result.content).toContain("2 reference pictures (face, body)");
    expect(result.content).toContain("character sheet: hair");
    expect(result.data.looks[0]).toMatchObject({ referenceRoles: ["face", "body"], sheet: { hair: "long" } });
  });

  it("a named look's sheet is used by Quick picture too, without its pictures", async () => {
    const look = { id: "l1", name: "Maja", style: "", model: null, seed: null, referenceFileIds: [REFS[0]], referenceRoles: ["face"], sheet: { hair: "long, blonde" }, updatedAt: "2026-09-28T00:00:00.000Z" };
    const { harness, calls } = await setup(FAL, [look]);
    await run(harness, TOOL_QUICK_PICTURE, { prompt: "good morning", look: "Maja" });
    const [call] = falCalls(calls);
    expect(call!.body.prompt).toBe(`good morning\n\n${CHARACTER_INTRO}: Hair: long, blonde.`);
    expect(call!.body.image_urls).toBeUndefined();
  });

  it("previews the exact prompt for a sample request, for anyone in the company, without making anything", async () => {
    const { harness, calls } = await setup(SOGNI);
    const preview = await act(
      harness,
      "looks.previewPrompt",
      {
        style: "calm",
        provider: "sogni",
        model: "",
        referenceFileIds: [REFS[0], REFS[1]],
        referenceRoles: ["face", "background"],
        sheet: MAJA_SHEET,
        request: "at the beach",
      },
      member,
    );
    expect(preview).toMatchObject({
      request: "at the beach",
      service: "sogni",
      model: "qwen-lightning",
      negativePrompt: null,
      references: [
        { position: 1, role: "face", label: "Face" },
        { position: 2, role: "background", label: "Background" },
      ],
      leftOut: ["Setting/background"],
    });
    expect(preview.prompt).toBe(
      assemblePrompt({ request: "at the beach", style: "calm", sheet: MAJA_SHEET, roles: ["face", "background"], service: "sogni" }).prompt,
    );
    expect(preview.prompt).toContain("The setting comes from the request, not from picture 2.");

    const plain = await act(harness, "looks.previewPrompt", { provider: "sogni", model: "chroma1-hd_fp8_scaled", negativePrompt: "blurry", sheet: { avoid: "text" } }, member);
    expect(plain).toMatchObject({ request: "reading a book by the window", model: "chroma1-hd_fp8_scaled", negativePrompt: "blurry, text", prompt: "reading a book by the window" });
    expect(sogniStarts(calls)).toHaveLength(0);
  });
});
