import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../../../packages/plugins/media-studio/src/worker.js";
import manifest from "../../../packages/plugins/media-studio/src/manifest.js";
import { SOGNI_TOOLS, sogniToolParameters, type SogniToolDef } from "../../../packages/plugins/media-studio/src/sogni-tools.js";
import { sogniToolNames, sogniToolSchema, sogniVendorInfo } from "../../../packages/plugins/media-studio/src/sogni-schemas.js";
import { assertSupportedSchema, checkJsonSchema } from "../../../packages/plugins/media-studio/src/json-schema-check.js";
import { pluginManifestValidator } from "../services/plugin-manifest-validator.js";
import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";
import { checkPluginToolGrant } from "../services/plugin-tool-execution.js";

/**
 * Media Studio's Sogni tools (upscale, remove background, restore, change
 * angle, apply style, select objects, improve prompt), against a fake Sogni:
 * no real Sogni API is ever called. What must hold: each tool's parameters
 * come from Sogni's vendored schema; wrong or extra arguments, another
 * company's file and a missing key are refused before anything is spent; the
 * picture goes to Sogni's own storage (never a Paperclip address); the result
 * is stored and returned like Generate image's; the daily picture limit is
 * reserved for picture tools only; the content filter is always on.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const ISSUE = "55555555-5555-4555-8555-555555555555";
const PHOTO = "66666666-6666-4666-8666-666666666666";
const FOREIGN_PHOTO = "77777777-7777-4777-8777-777777777777";
const DOCUMENT = "88888888-8888-4888-8888-888888888888";
const VECTOR = "99999999-9999-4999-8999-999999999999";
const runCtx = { agentId: AGENT, runId: RUN, companyId: COMPANY, projectId: "" };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80, 0x00, 0x42]);
const SOURCE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x99]);
const ARTIFACT_URL = "https://complete-images.s3-accelerate.amazonaws.com/2026-09-27/wf1/result.png?X-Amz-Signature=abc";
const UPLOAD_URL = "https://uploads.s3-accelerate.amazonaws.com/";
const WORKFLOW_ID = "wf_tool_workflow_1";
const SOGNI_CONFIG = { provider: "fal", falKeySecretRef: "fal-ref", sogniKeySecretRef: "sogni-key-ref" };

const VENDOR_DIR = new URL("../../../packages/plugins/media-studio/vendor/sogni/", import.meta.url);

function vendoredSchema(tool: string): Record<string, any> {
  const info = JSON.parse(readFileSync(new URL("current.json", VENDOR_DIR), "utf8"));
  return JSON.parse(readFileSync(new URL(`${info.dir}/schemas/tools/${tool}.schema.json`, VENDOR_DIR), "utf8"));
}

function tool(name: string): SogniToolDef {
  const def = SOGNI_TOOLS.find((d) => d.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}

function companyFile(id: string, companyId: string, contentType = "image/jpeg", originalFilename = "old-photo.jpg") {
  const contentPath = `/api/attachments/${id}/content`;
  return {
    id,
    companyId,
    issueId: null,
    contentType,
    byteSize: SOURCE_BYTES.length,
    originalFilename,
    createdByAgentId: null,
    contentPath,
    openPath: contentPath,
    downloadPath: `${contentPath}?download=1`,
    createdAt: new Date(),
    contentBase64: SOURCE_BYTES.toString("base64"),
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeSogni(options: { artifacts?: number; executeResult?: Record<string, unknown> } = {}) {
  const api: Call[] = [];
  const transfers: Call[] = [];
  let polls = 0;
  const apiFetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? null);
    api.push({ url, method, headers: Object.fromEntries(new Headers(init?.headers as HeadersInit).entries()), body });
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (method === "POST" && path === "/v1/creative-agent/workflows") {
      return json(201, { status: "success", data: { workflow: { workflowId: WORKFLOW_ID, status: "queued" } } });
    }
    if (method === "GET" && path === `/v1/creative-agent/workflows/${WORKFLOW_ID}`) {
      polls += 1;
      if (polls < 2) return json(200, { status: "success", data: { workflow: { workflowId: WORKFLOW_ID, status: "running" } } });
      const artifacts = Array.from({ length: options.artifacts ?? 1 }, (_, i) => ({ url: i === 0 ? ARTIFACT_URL : `${ARTIFACT_URL}&n=${i}` }));
      return json(200, { status: "success", data: { workflow: { workflowId: WORKFLOW_ID, status: "completed", steps: [{ id: "picture", artifacts }] } } });
    }
    if (method === "POST" && path === "/v1/creative-agent/tools/execute") {
      const result = options.executeResult ?? {
        ok: true,
        success: true,
        tool: "enhance_prompt",
        prompt: "A cinematic portrait of a translucent glass robot, soft rim light.",
        message: "A cinematic portrait of a translucent glass robot, soft rim light.",
      };
      return json(200, { status: "success", data: { toolCallId: "direct_1", tool: "enhance_prompt", result, message: result.message } });
    }
    if (method === "GET" && path === "/v2/image/uploadUrl") {
      return json(200, { status: "success", data: { url: UPLOAD_URL, fields: { key: `refs/${parsed.searchParams.get("type")}`, Policy: "p" } } });
    }
    if (method === "GET" && path === "/v2/image/downloadUrl") {
      return json(200, {
        status: "success",
        data: { downloadUrl: `https://uploads.s3-accelerate.amazonaws.com/refs/${parsed.searchParams.get("type")}?X-Amz-Signature=d` },
      });
    }
    return json(404, { status: "error", message: `unexpected ${method} ${url}` });
  });
  const transferFetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    transfers.push({ url, method, headers: {}, body: init?.body ?? null });
    if (method === "POST") return new Response(null, { status: 204 });
    return new Response(PNG, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(PNG.length) } });
  });
  return { api, transfers, apiFetch, transferFetch };
}

function starts(fake: ReturnType<typeof fakeSogni>) {
  return fake.api.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/v1/creative-agent/workflows");
}

describe("Sogni's vendored schemas", () => {
  it("come from one recorded package and version, with its licence and a file list", () => {
    const info = sogniVendorInfo();
    expect(info).toMatchObject({ package: "@sogni-ai/sogni-protocol", version: "1.0.0-alpha.46", dir: "sogni-protocol@1.0.0-alpha.46" });
    const vendored = readFileSync(new URL(`${info.dir}/VENDORED.md`, VENDOR_DIR), "utf8");
    for (const file of info.files) expect(vendored).toContain(file);
    expect(readFileSync(new URL(`${info.dir}/LICENSE`, VENDOR_DIR), "utf8")).toContain("ISC License");
  });

  it("use only what the plugin's checker understands, and every tool is one of Sogni's hosted tools", () => {
    for (const def of SOGNI_TOOLS) {
      expect(() => assertSupportedSchema(vendoredSchema(def.sogniTool), def.sogniTool)).not.toThrow();
      expect(sogniToolNames().hosted).toContain(def.sogniTool);
    }
  });
});

describe("Sogni tools: parameters come from Sogni's schemas", () => {
  const cases: Array<[string, string, string[], string[]]> = [
    ["sogni-upscale-image", "upscale_image", ["fileId", "scale", "targetLongestEdge", "issueId"], ["fileId"]],
    ["sogni-remove-background", "remove_background", ["fileId", "applyMask", "issueId"], ["fileId"]],
    ["sogni-restore-photo", "restore_photo", ["fileId", "prompt", "quality", "scale", "aspectRatio", "issueId"], ["fileId", "prompt"]],
    ["sogni-change-angle", "change_angle", ["fileId", "description", "loraStrength", "aspectRatio", "issueId"], ["fileId", "description"]],
    ["sogni-apply-style", "apply_style", ["fileId", "prompt", "scale", "aspectRatio", "issueId"], ["fileId", "prompt"]],
    [
      "sogni-segment-image",
      "segment_image",
      ["fileId", "text", "points", "boxes", "maxInstances", "threshold", "applyMask", "issueId"],
      ["fileId"],
    ],
    [
      "sogni-enhance-prompt",
      "enhance_prompt",
      ["prompt", "target_output", "destination_model", "destination_tool", "style_prompt", "prompt_mode", "duration_seconds", "aspect_ratio", "constraints"],
      ["prompt"],
    ],
  ];

  it.each(cases)("%s offers Sogni's %s arguments with Sogni's own descriptions, minus addresses and indices", (name, sogniTool, names, required) => {
    const def = tool(name);
    expect(def.sogniTool).toBe(sogniTool);
    const params = sogniToolParameters(def) as any;
    expect(Object.keys(params.properties)).toEqual(names);
    expect(params.required).toEqual(required);
    expect(params.additionalProperties).toBe(false);
    const sogni = vendoredSchema(sogniTool);
    for (const arg of names) {
      if (arg === "fileId" || arg === "issueId") continue;
      const own = sogni.properties[arg];
      // Names, types, ranges and enums are Sogni's; the description is Sogni's (Paperclip only adds a default note).
      expect(params.properties[arg].type).toEqual(own.type);
      expect(params.properties[arg].enum).toEqual(own.enum);
      if (typeof own.description === "string") expect(params.properties[arg].description.startsWith(own.description)).toBe(true);
      else expect(typeof params.properties[arg].description).toBe("string"); // Paperclip fills in only what Sogni leaves blank
      if (own.items) expect(params.properties[arg].items).toEqual(own.items);
    }
    for (const dropped of ["sourceImageIndex", "source_image_url", "mask_image_url", "numberOfVariations", "multimask", "assets"]) {
      expect(params.properties).not.toHaveProperty(dropped);
    }
  });

  it("the display names say what they do, with Sogni named", () => {
    expect(SOGNI_TOOLS.map((d) => d.displayName)).toEqual([
      "Upscale picture (Sogni)",
      "Remove background (Sogni)",
      "Restore photo (Sogni)",
      "Change camera angle (Sogni)",
      "Apply style (Sogni)",
      "Select objects (Sogni)",
      "Improve picture prompt (Sogni)",
    ]);
  });
});

describe("Sogni tools in the manifest (the Tools tab lists them per agent)", () => {
  it("each Sogni tool is its own manifest tool, with the schema-derived parameters, and the manifest is valid", () => {
    const listed = manifest.tools ?? [];
    for (const def of SOGNI_TOOLS) {
      const entry = listed.find((t) => t.name === def.name);
      expect(entry).toBeDefined();
      expect(entry!.displayName).toBe(def.displayName);
      expect(entry!.parametersSchema).toEqual(sogniToolParameters(def));
    }
    expect(listed.map((t) => t.name)).toEqual(expect.arrayContaining(["generate-image", "list-looks"]));
    const parsed = pluginManifestValidator().parse(manifest);
    expect(parsed.success).toBe(true);
  });

  it("registers namespaced, and an operator can tick one Sogni tool for an agent without the others", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("paperclip.media-studio", manifest, "db-id-1");
    const names = registry.listTools().map((t) => t.namespacedName);
    for (const def of SOGNI_TOOLS) expect(names).toContain(`paperclip.media-studio:${def.name}`);
    const ticked = ["paperclip.media-studio:sogni-upscale-image"];
    expect(checkPluginToolGrant(ticked, "paperclip.media-studio:sogni-upscale-image", "ticked_only")).toBeNull();
    expect(checkPluginToolGrant(ticked, "paperclip.media-studio:sogni-remove-background", "ticked_only")).toContain("not granted");
  });
});

describe("the argument checker", () => {
  const schema = vendoredSchema("segment_image");
  it("answers in plain sentences", () => {
    expect(checkJsonSchema(schema, { points: [{ x: 2, y: 0.5, label: "positive" }] })).toBe("points item 1 x must be at most 1.");
    expect(checkJsonSchema(schema, { points: [{ x: 0.2, y: 0.5, label: "maybe" }] })).toBe(
      'points item 1 label must be one of "positive", "negative", not "maybe".',
    );
    expect(checkJsonSchema(schema, { maxInstances: 1.5 })).toBe("maxInstances must be a whole number, not a number.");
    expect(checkJsonSchema(schema, { text: "" })).toBe("text must not be empty.");
    expect(checkJsonSchema(schema, { points: [{ x: 0.1, y: 0.1 }] })).toBe("points item 1 label is required.");
    expect(checkJsonSchema(schema, "nope")).toBe("The arguments must be a set of named values, not text.");
    expect(checkJsonSchema(schema, { colour: "red" })).toMatch(/does not take "colour"/);
    expect(checkJsonSchema(schema, { text: "the sofa", threshold: 0.4 })).toBeNull();
  });

  it("refuses a schema keyword it does not understand instead of skipping it", () => {
    expect(() => assertSupportedSchema({ type: "object", properties: { a: { type: "string", pattern: "^x" } } })).toThrow(/pattern/);
    expect(() => assertSupportedSchema({ type: "object", oneOf: [] })).toThrow(/oneOf/);
  });
});

describe("media-studio Sogni tools in the worker", () => {
  let harness: TestHarness;
  let fake: ReturnType<typeof fakeSogni>;

  async function setup(config: Record<string, unknown> = SOGNI_CONFIG, fakeOptions: Parameters<typeof fakeSogni>[0] = {}) {
    harness = createTestHarness({ manifest, config });
    harness.seed({
      companyFiles: [
        companyFile(PHOTO, COMPANY),
        companyFile(FOREIGN_PHOTO, OTHER_COMPANY),
        companyFile(DOCUMENT, COMPANY, "application/pdf", "brief.pdf"),
        companyFile(VECTOR, COMPANY, "image/svg+xml", "logo.svg"),
      ],
    });
    await plugin.definition.setup(harness.ctx);
    fake = fakeSogni(fakeOptions);
    harness.ctx.http.fetch = vi.fn((url: string, init?: RequestInit) => fake.apiFetch(url, init)) as typeof harness.ctx.http.fetch;
    vi.stubGlobal("fetch", fake.transferFetch);
  }

  async function run(name: string, params: unknown) {
    const pending = harness.executeTool<any>(name, params, runCtx);
    await vi.runAllTimersAsync();
    return pending;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("upscales: uploads the picture to Sogni's storage, runs one upscale_image step, and stores the result like Generate image", async () => {
    await setup();
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    const createFile = vi.spyOn(harness.ctx.files, "createCompanyFile");

    const result = await run("sogni-upscale-image", { fileId: PHOTO, scale: 4 });

    expect(result.error).toBeUndefined();
    // The presigned flow: ask for an upload slot, post the bytes there, then ask for the address Sogni reads.
    const paths = fake.api.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(paths.slice(0, 3)).toEqual(["GET /v2/image/uploadUrl", "GET /v2/image/downloadUrl", "POST /v1/creative-agent/workflows"]);
    const upload = fake.transfers.find((t) => t.method === "POST")!;
    expect(upload.url).toBe(UPLOAD_URL);
    const form = upload.body as FormData;
    const sent = form.get("file") as Blob;
    expect(Buffer.from(await sent.arrayBuffer()).equals(SOURCE_BYTES)).toBe(true);

    const [start] = starts(fake);
    expect(start!.headers.authorization).toBe("Bearer resolved:sogni-key-ref");
    expect(start!.body).toEqual({
      input: { title: "Paperclip upscale_image", steps: [{ id: "picture", toolName: "upscale_image", arguments: { scale: 4, sourceImageIndex: -1 } }] },
      token_type: "auto",
      app_source: "paperclip-media-studio",
      safe_content_filter: true,
      media_references: [{ kind: "image", url: "https://uploads.s3-accelerate.amazonaws.com/refs/contextImage1?X-Amz-Signature=d" }],
    });

    // No Paperclip address or id ever leaves: not in any API call, not in any storage transfer.
    const outbound = JSON.stringify([fake.api.map((c) => [c.url, c.body]), fake.transfers.map((t) => t.url)]);
    expect(outbound).not.toContain("/api/attachments");
    expect(outbound).not.toContain(PHOTO);
    expect(outbound).not.toContain("paperclip.");

    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(COMPANY, { runId: RUN });
    const [input, companyId, options] = createFile.mock.calls[0]!;
    expect(companyId).toBe(COMPANY);
    expect(options).toEqual({ runId: RUN });
    expect(input).toMatchObject({ contentType: "image/png", filename: "upscaled-old-photo.png" });
    expect(Buffer.from(input.contentBase64, "base64").equals(PNG)).toBe(true);
    // The shape quick-agent chat and Telegram read to show the picture (fileId of an image in this company).
    expect(result.data).toMatchObject({
      fileId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      contentPath: expect.stringMatching(/^\/api\/attachments\/[0-9a-f-]+\/content$/),
      contentType: "image/png",
      issueId: null,
      seed: null,
      provider: "sogni",
      tool: "upscale_image",
      sourceFileId: PHOTO,
    });
    expect(result.content).toContain("saved it to the company's Files (not tied to a task)");
    expect(result.content).toContain(`File id: ${result.data.fileId}`);
  });

  it("with issueId, attaches the result to the task under the host's rules, and saves no company file", async () => {
    await setup();
    const attach = vi.spyOn(harness.ctx.issues, "createAttachment").mockResolvedValue({
      id: "abababab-abab-4bab-8bab-abababababab",
      contentPath: "/api/attachments/abababab-abab-4bab-8bab-abababababab/content",
    } as any);
    const createFile = vi.spyOn(harness.ctx.files, "createCompanyFile");

    const result = await run("sogni-remove-background", { fileId: PHOTO, issueId: ISSUE });

    expect(result.error).toBeUndefined();
    expect(createFile).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledWith(
      ISSUE,
      expect.objectContaining({ contentType: "image/png", filename: "no-background-old-photo.png" }),
      COMPANY,
      { authorAgentId: AGENT, runId: RUN },
    );
    expect(result.data).toMatchObject({
      attachmentId: "abababab-abab-4bab-8bab-abababababab",
      fileId: "abababab-abab-4bab-8bab-abababababab",
      issueId: ISSUE,
    });
    expect((starts(fake)[0]!.body as any).input.steps[0]).toEqual({
      id: "picture",
      toolName: "remove_background",
      arguments: { sourceImageIndex: -1 },
    });
  });

  it("sends each picture tool's arguments exactly as Sogni's schema names them", async () => {
    await setup();
    const sentFor = async (name: string, params: Record<string, unknown>) => {
      fake.api.length = 0;
      const result = await run(name, { fileId: PHOTO, ...params });
      expect(result.error).toBeUndefined();
      return (starts(fake)[0]!.body as any).input.steps[0];
    };
    // restore_photo's schema has no sourceImageIndex: it always works on the uploaded original.
    expect(await sentFor("sogni-restore-photo", { prompt: "Remove scratches and dust. Preserve all unmentioned details.", quality: "hq" })).toEqual({
      id: "picture",
      toolName: "restore_photo",
      arguments: { prompt: "Remove scratches and dust. Preserve all unmentioned details.", quality: "hq" },
    });
    expect(await sentFor("sogni-change-angle", { description: "left side view eye-level shot close-up", loraStrength: 0.7 })).toMatchObject({
      toolName: "change_angle",
      arguments: { description: "left side view eye-level shot close-up", loraStrength: 0.7, sourceImageIndex: -1 },
    });
    expect(await sentFor("sogni-apply-style", { prompt: "Van Gogh Starry Night style", aspectRatio: "1:1" })).toMatchObject({
      toolName: "apply_style",
      arguments: { prompt: "Van Gogh Starry Night style", aspectRatio: "1:1", sourceImageIndex: -1 },
    });
    // One picture back per call: Sogni's several-candidates option is always off.
    expect(await sentFor("sogni-segment-image", { points: [{ x: 0.4, y: 0.5, label: "positive" }] })).toEqual({
      id: "picture",
      toolName: "segment_image",
      arguments: { points: [{ x: 0.4, y: 0.5, label: "positive" }], sourceImageIndex: -1, multimask: false },
    });
  });

  it("refuses unknown or invalid arguments with a plain sentence, before the daily limit or Sogni", async () => {
    await setup();
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    expect((await run("sogni-upscale-image", { fileId: PHOTO, sourceImageIndex: 0 })).error).toBe(
      'The Upscale picture (Sogni) tool does not take "sourceImageIndex". It takes: fileId, scale, targetLongestEdge, issueId.',
    );
    expect((await run("sogni-remove-background", { fileId: PHOTO, source_image_url: "https://example.com/x.png" })).error).toMatch(
      /does not take "source_image_url"/,
    );
    expect((await run("sogni-upscale-image", { fileId: PHOTO, scale: 5 })).error).toBe("scale must be one of 2, 3, 4, not 5.");
    expect((await run("sogni-upscale-image", { fileId: PHOTO, targetLongestEdge: 100 })).error).toBe("targetLongestEdge must be at least 512.");
    expect((await run("sogni-upscale-image", {})).error).toBe("fileId is required.");
    expect((await run("sogni-restore-photo", { fileId: PHOTO })).error).toBe("prompt is required.");
    expect((await run("sogni-change-angle", { fileId: PHOTO, description: "left side view eye-level shot close-up", loraStrength: 3 })).error).toBe(
      "loraStrength must be from 0.1 to 1.0.",
    );
    expect((await run("sogni-segment-image", { fileId: PHOTO })).error).toMatch(/^Say what to select/);
    expect((await run("sogni-segment-image", { fileId: PHOTO, text: "sofa", points: [{ x: 0.5, y: 0.5, label: "positive" }] })).error).toMatch(
      /Points cannot be combined with text/,
    );
    expect((await run("sogni-enhance-prompt", { prompt: "a robot", target_output: "poem" })).error).toBe(
      'target_output must be one of "image_prompt", "video_prompt", "edit_prompt", "model_prompt", not "poem".',
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(fake.api).toHaveLength(0);
    expect(fake.transfers).toHaveLength(0);
  });

  it("never lets an agent turn the content filter off", async () => {
    await setup();
    for (const key of ["safe_content_filter", "safeContentFilter", "look"]) {
      const result = await run("sogni-apply-style", { fileId: PHOTO, prompt: "oil painting", [key]: false });
      expect(result.error).toMatch(new RegExp(`does not take "${key}"`));
    }
    expect(fake.api).toHaveLength(0);
    await run("sogni-apply-style", { fileId: PHOTO, prompt: "oil painting" });
    await run("sogni-enhance-prompt", { prompt: "a robot" });
    const bodies = fake.api.filter((c) => c.method === "POST").map((c) => c.body as any);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body.safe_content_filter).toBe(true);
  });

  it("refuses another company's file, a file that is not a picture, and a picture type Sogni cannot take", async () => {
    await setup();
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    expect((await run("sogni-upscale-image", { fileId: FOREIGN_PHOTO })).error).toBe(
      `The picture ${FOREIGN_PHOTO} is not in this company's Files, so it cannot be used. Pick a picture from this company's Files.`,
    );
    expect((await run("sogni-upscale-image", { fileId: DOCUMENT })).error).toBe('The file "brief.pdf" is not a picture.');
    expect((await run("sogni-upscale-image", { fileId: VECTOR })).error).toBe(
      'Sogni takes PNG, JPEG, WebP or GIF pictures, and "logo.svg" is image/svg+xml.',
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(fake.api).toHaveLength(0);
  });

  it("says where to set the Sogni key when none is picked, for every tool, before anything is spent", async () => {
    await setup({ provider: "sogni" });
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    for (const def of SOGNI_TOOLS) {
      const params = def.kind === "text" ? { prompt: "a robot" } : { fileId: PHOTO, ...(def.sogniTool === "segment_image" ? { text: "sofa" } : {}), ...(["restore_photo", "apply_style"].includes(def.sogniTool) ? { prompt: "x" } : {}), ...(def.sogniTool === "change_angle" ? { description: "front view eye-level shot medium shot" } : {}) };
      expect((await run(def.name, params)).error).toBe(
        `${def.displayName} needs a Sogni API key. An admin picks it in Media Studio's settings under "Sogni API key" (the key itself is saved in the company's Secrets).`,
      );
    }
    expect(reserve).not.toHaveBeenCalled();
    expect(fake.api).toHaveLength(0);
  });

  it("stops at the daily picture limit without calling Sogni", async () => {
    await setup();
    vi.spyOn(harness.ctx.personas, "reserveDailyGeneration").mockResolvedValue({ allowed: false, cap: 3, usedToday: 3 } as any);
    const result = await run("sogni-upscale-image", { fileId: PHOTO });
    expect(result.error).toBe("Daily image limit (3) reached for this agent today.");
    expect(fake.api).toHaveLength(0);
    expect(fake.transfers).toHaveLength(0);
  });

  it("keeps the first picture when Sogni sends several, and says so", async () => {
    await setup(SOGNI_CONFIG, { artifacts: 3 });
    const result = await run("sogni-segment-image", { fileId: PHOTO, text: "the chairs", maxInstances: 3 });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Sogni sent 3 pictures; the first one was kept.");
    expect(fake.transfers.filter((t) => t.method === "GET").map((t) => t.url)).toEqual([ARTIFACT_URL]);
  });

  it("improve prompt: runs on tools/execute with the settings' model and payment, returns text, and does not count as a picture", async () => {
    await setup({ ...SOGNI_CONFIG, sogniModel: "krea-2-turbo", sogniTokenType: "spark" });
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    const createFile = vi.spyOn(harness.ctx.files, "createCompanyFile");

    const result = await run("sogni-enhance-prompt", { prompt: "A cinematic portrait of a glass robot" });

    expect(result.error).toBeUndefined();
    expect(fake.api).toHaveLength(1);
    const [call] = fake.api;
    expect(call!.url).toBe("https://api.sogni.ai/v1/creative-agent/tools/execute");
    expect(call!.headers.authorization).toBe("Bearer resolved:sogni-key-ref");
    expect(call!.body).toEqual({
      tool: "enhance_prompt",
      arguments: { prompt: "A cinematic portrait of a glass robot", target_output: "image_prompt", destination_model: "krea-2-turbo" },
      token_type: "spark",
      app_source: "paperclip-media-studio",
      safe_content_filter: true,
    });
    expect(result.content).toBe(
      "Sogni's improved prompt for krea-2-turbo:\n\nA cinematic portrait of a translucent glass robot, soft rim light.",
    );
    expect(result.data).toMatchObject({ prompt: "A cinematic portrait of a translucent glass robot, soft rim light.", destinationModel: "krea-2-turbo" });
    expect(result.data.fileId).toBeUndefined();
    expect(reserve).not.toHaveBeenCalled();
    expect(createFile).not.toHaveBeenCalled();
    expect(fake.transfers).toHaveLength(0);
  });

  it("improve prompt: passes on Sogni's own refusal as a sentence", async () => {
    await setup(SOGNI_CONFIG, {
      executeResult: { ok: false, success: false, error_type: "unknown_model", message: "The destination model is not active.", retryable: false },
    });
    const result = await run("sogni-enhance-prompt", { prompt: "a robot", destination_model: "sd15-old" });
    expect(result.error).toBe("Sogni could not do that: The destination model is not active.");
  });
});
