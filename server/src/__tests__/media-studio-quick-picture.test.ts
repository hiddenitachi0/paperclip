import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../../../packages/plugins/media-studio/src/worker.js";
import manifest, { TOOL_GENERATE, TOOL_QUICK_PICTURE } from "../../../packages/plugins/media-studio/src/manifest.js";
import {
  FAL_QUICK_MODEL,
  QUICK_PICTURE_TIMEOUT_MS,
  QUICK_PICTURE_TIMEOUT_SENTENCE,
  quickPictureSize,
  showDuration,
} from "../../../packages/plugins/media-studio/src/quick-picture.js";
import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";
import { checkPluginToolGrant } from "../services/plugin-tool-execution.js";

/**
 * Media Studio's Quick picture tool: the fastest, cheapest path (small size,
 * the service's fastest model, no reference pictures, no LoRAs), the content
 * filter kept on unless a look is named, the daily picture limit, and its
 * own 30-second limit. Fal and Sogni are faked; nothing real is called.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const MAJA = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const REF_A = "66666666-6666-4666-8666-666666666666";
const runCtx = { agentId: MAJA, runId: RUN, companyId: COMPANY, projectId: "" };

const looksKey = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: "looks" };
const defaultsKey = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: "lookDefaults" };
const rulesKey = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: "lookRules" };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
const ARTIFACT_URL = "https://complete-images.s3-accelerate.amazonaws.com/q/picture.png?X-Amz-Signature=abc";
const WORKFLOW_ID = "wf_quick_1";

function look(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, style: `${name.toLowerCase()} style`, model: null, seed: null, referenceFileIds: [], updatedAt: "2026-09-28T00:00:00.000Z", ...extra };
}

/** A look an owner saved with the content filter off, with a model, LoRAs, a seed and a reference picture. */
const AFTER_DARK = look("look-dark", "After dark", {
  provider: "sogni",
  model: "dark_beast_z_image_turbo_v9_bf16",
  loras: [{ id: "z-detail", name: "Detail", strength: 0.8 }],
  seed: 777,
  referenceFileIds: [REF_A],
  safeContentFilter: false,
  contentFilterOffBy: "owner-1",
});
const CATALOGUE = look("look-cat", "Catalogue", { model: "fal-ai/flux/dev", seed: 4242, referenceFileIds: [REF_A] });

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function companyFile(id: string) {
  return {
    id,
    companyId: COMPANY,
    issueId: null,
    contentType: "image/png",
    byteSize: PNG.length,
    originalFilename: "ref.png",
    createdByAgentId: null,
    contentPath: `/api/attachments/${id}/content`,
    openPath: `/api/attachments/${id}/content`,
    createdAt: new Date("2026-09-28T00:00:00.000Z"),
    contentBase64: PNG.toString("base64"),
  } as never;
}

type Call = { url: string; method: string; body: any };

async function setup(config: Record<string, unknown>, state: { looks?: unknown[]; defaults?: Record<string, string>; rules?: unknown } = {}) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    agents: [{ id: MAJA, companyId: COMPANY, name: "Maja", title: null, status: "idle" } as never],
    companyFiles: [companyFile(REF_A)],
  });
  await plugin.definition.setup(harness.ctx);
  if (state.looks) await harness.ctx.state.set(looksKey, state.looks);
  if (state.defaults) await harness.ctx.state.set(defaultsKey, state.defaults);
  if (state.rules) await harness.ctx.state.set(rulesKey, state.rules);
  return harness;
}

/** Fake Fal (fal.run + its CDN) and fake Sogni (api + storage) behind the host fetch. */
function fakeServices(harness: TestHarness, options: { falHangs?: boolean; sogniStatus?: string } = {}) {
  const calls: Call[] = [];
  harness.ctx.http.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    if (url.startsWith("https://fal.run/")) {
      if (options.falHangs) return new Promise<Response>(() => undefined);
      return json(200, { images: [{ url: "https://v3.fal.media/files/quick.jpg", content_type: "image/jpeg" }], seed: 9 });
    }
    if (url.startsWith("https://v3.fal.media/")) return new Response(PNG, { status: 200, headers: { "Content-Type": "image/jpeg" } });
    const path = new URL(url).pathname;
    if (method === "POST" && path === "/v1/creative-agent/workflows") {
      return json(201, { status: "success", data: { workflow: { workflowId: WORKFLOW_ID, status: "queued" } } });
    }
    if (method === "POST" && path.endsWith("/cancel")) return json(200, { status: "success" });
    if (method === "GET" && path === `/v1/creative-agent/workflows/${WORKFLOW_ID}`) {
      const status = options.sogniStatus ?? "completed";
      const workflow: Record<string, unknown> = { workflowId: WORKFLOW_ID, status };
      if (status === "completed") workflow.steps = [{ id: "picture", seed: 55, artifacts: [{ url: ARTIFACT_URL }] }];
      return json(200, { status: "success", data: { workflow } });
    }
    return json(404, { status: "error", message: `unexpected ${method} ${url}` });
  }) as typeof harness.ctx.http.fetch;
  const transfers: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      transfers.push(url);
      return new Response(PNG, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(PNG.length) } });
    }),
  );
  return { calls, transfers };
}

const falCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith("https://fal.run/"));
const sogniStarts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/creative-agent/workflows"));

const FAL = { provider: "fal", falKeySecretRef: "fal-key-ref", falModel: "fal-ai/flux/dev" };
const SOGNI = { provider: "sogni", sogniKeySecretRef: "sogni-key-ref", sogniModel: "chroma1-hd" };

describe("quick picture sizes and helpers", () => {
  it("is 512 on the long side, and 512 on the short side for Sogni's Z-Image Turbo", () => {
    expect(quickPictureSize("square", "fal")).toMatchObject({ imageSize: "512x512" });
    expect(quickPictureSize("landscape", "fal")).toMatchObject({ imageSize: "512x384" });
    expect(quickPictureSize("portrait", "fal")).toMatchObject({ imageSize: "384x512" });
    expect(quickPictureSize("square", "sogni")).toMatchObject({ imageSize: "512x512" });
    expect(quickPictureSize("landscape", "sogni")).toMatchObject({ imageSize: "688x512" });
    expect(quickPictureSize("portrait", "sogni")).toMatchObject({ imageSize: "512x688" });
    expect(showDuration(850)).toBe("850 ms");
    expect(showDuration(3240)).toBe("3.2 s");
  });
});

describe("media-studio quick picture", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function run(harness: TestHarness, params: Record<string, unknown>) {
    const pending = harness.executeTool<any>(TOOL_QUICK_PICTURE, params, runCtx);
    await vi.runAllTimersAsync();
    return pending;
  }

  it("asks Fal for FLUX schnell, small, few steps, no reference pictures, whatever the settings' model", async () => {
    const harness = await setup(FAL);
    const { calls } = fakeServices(harness);
    const createFile = vi.spyOn(harness.ctx.files, "createCompanyFile");

    const result = await run(harness, { prompt: "a cosy autumn morning", shape: "landscape" });

    expect(result.error).toBeUndefined();
    const [call] = falCalls(calls);
    expect(call!.url).toBe(`https://fal.run/${FAL_QUICK_MODEL}`);
    expect(call!.body).toEqual({
      prompt: "a cosy autumn morning",
      image_size: { width: 512, height: 384 },
      num_images: 1,
      enable_safety_checker: true,
      num_inference_steps: 2,
    });
    expect(createFile.mock.calls[0]![0]).toMatchObject({ filename: "quick-picture-seed-9.jpeg", contentType: "image/jpeg" });
    expect(result.data).toMatchObject({ quick: true, provider: "fal", model: FAL_QUICK_MODEL, width: 512, height: 384, seed: 9, issueId: null, look: null });
    expect(typeof result.data.durationMs).toBe("number");
    expect(result.content).toMatch(/^Made a quick picture \(Fal\.ai, 512x384, \d+ ms\) and saved it to the company's Files/);
    // Its own record says it was a quick one and how long it took.
    const record = (await harness.ctx.state.get({ scopeKind: "company", scopeId: COMPANY, stateKey: `image:${result.data.fileId}` })) as any;
    expect(record).toMatchObject({ quick: true, provider: "fal", model: FAL_QUICK_MODEL, referenceFileIds: [] });
    expect(typeof record.durationMs).toBe("number");
  });

  it("asks Sogni for Z-Image Turbo at 512, no LoRAs or reference pictures, content filter on", async () => {
    const harness = await setup(SOGNI);
    const { calls, transfers } = fakeServices(harness);

    const result = await run(harness, { prompt: "rain on a window" });

    expect(result.error).toBeUndefined();
    const [start] = sogniStarts(calls);
    expect(start!.body.safe_content_filter).toBe(true);
    expect(start!.body.media_references).toBeUndefined();
    const step = start!.body.input.steps[0];
    expect(step.toolName).toBe("generate_image");
    expect(step.arguments).toMatchObject({ prompt: "rain on a window", model: "z-turbo", width: 512, height: 512, numberOfVariations: 1 });
    expect(step.arguments.loras).toBeUndefined();
    expect(transfers).toEqual([ARTIFACT_URL]);
    expect(result.data).toMatchObject({ quick: true, provider: "sogni", model: "z-turbo", width: 512, height: 512 });
  });

  it("does not use the agent's default look or an automatic look, so a filter-off look is never inherited", async () => {
    const rules = {
      [`agent:${MAJA}`]: { timezone: "Europe/Oslo", rules: [{ id: "r1", lookId: AFTER_DARK.id, enabled: true, keywords: ["rain"] }] },
    };
    const harness = await setup(SOGNI, { looks: [AFTER_DARK], defaults: { [MAJA]: AFTER_DARK.id }, rules });
    const { calls } = fakeServices(harness);

    // Generate image would pick the filter-off look here (keyword rule, default look, and the name in the text).
    const result = await run(harness, { prompt: "rain on a window, in look after dark" });

    expect(result.error).toBeUndefined();
    const [start] = sogniStarts(calls);
    expect(start!.body.safe_content_filter).toBe(true);
    expect(start!.body.input.steps[0].arguments).toMatchObject({ model: "z-turbo", prompt: "rain on a window, in look after dark" });
    expect(result.data.look).toBeNull();
  });

  it("uses a look only when it is named as look: its style words and its content filter, not its model, LoRAs, seed or pictures", async () => {
    const harness = await setup(SOGNI, { looks: [AFTER_DARK] });
    const { calls } = fakeServices(harness);

    const result = await run(harness, { prompt: "a sofa at night", look: "after dark" });

    expect(result.error).toBeUndefined();
    const [start] = sogniStarts(calls);
    expect(start!.body.safe_content_filter).toBe(false);
    expect(start!.body.media_references).toBeUndefined();
    const args = start!.body.input.steps[0].arguments;
    expect(args).toMatchObject({ model: "z-turbo", prompt: "a sofa at night\n\nStyle: after dark style", width: 512, height: 512 });
    expect(args.loras).toBeUndefined();
    expect(args.seed).not.toBe(777);
    expect(result.data.look).toBe("After dark");
    expect(result.content).toContain('Used the saved look "After dark" (its style words and character sheet only).');
  });

  it("a named Fal look adds its style but keeps schnell and no reference pictures", async () => {
    const harness = await setup(FAL, { looks: [CATALOGUE] });
    const { calls } = fakeServices(harness);
    const result = await run(harness, { prompt: "a sofa", look: "Catalogue" });
    expect(result.error).toBeUndefined();
    const [call] = falCalls(calls);
    expect(call!.url).toBe(`https://fal.run/${FAL_QUICK_MODEL}`);
    expect(call!.body.prompt).toBe("a sofa\n\nStyle: catalogue style");
    expect(call!.body.image_urls).toBeUndefined();
    expect(call!.body.seed).toBeUndefined();
  });

  it("refuses an unknown look or shape before anything is spent", async () => {
    const harness = await setup(FAL, { looks: [CATALOGUE] });
    const { calls } = fakeServices(harness);
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    const missing = await run(harness, { prompt: "a sofa", look: "Nope" });
    expect(missing.error).toBe('There is no saved look called "Nope". Saved looks: Catalogue.');
    const shape = await run(harness, { prompt: "a sofa", shape: "round" });
    expect(shape.error).toBe('"round" is not a shape. Use square, landscape or portrait, or leave it out.');
    const empty = await run(harness, { prompt: "  " });
    expect(empty.error).toBe("prompt is required");
    expect(reserve).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("counts toward the daily picture limit and stops once it is reached, before calling the service", async () => {
    const harness = await setup(FAL);
    const { calls } = fakeServices(harness);
    const reserve = vi
      .spyOn(harness.ctx.personas, "reserveDailyGeneration")
      .mockResolvedValueOnce({ allowed: true, cap: 2, usedToday: 1 })
      .mockResolvedValueOnce({ allowed: false, cap: 2, usedToday: 2 });

    const first = await run(harness, { prompt: "sunrise" });
    const second = await run(harness, { prompt: "sunset" });

    expect(first.error).toBeUndefined();
    expect(second.error).toBe("Daily image limit (2) reached for this agent today.");
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledWith(COMPANY, { runId: RUN });
    expect(falCalls(calls)).toHaveLength(1);
  });

  it("gives up after 30 seconds with a plain sentence when Fal does not answer", async () => {
    const harness = await setup(FAL);
    fakeServices(harness, { falHangs: true });
    const createFile = vi.spyOn(harness.ctx.files, "createCompanyFile");
    const started = Date.now();

    const result = await run(harness, { prompt: "sunrise" });

    expect(result.error).toBe(QUICK_PICTURE_TIMEOUT_SENTENCE);
    expect(Date.now() - started).toBe(QUICK_PICTURE_TIMEOUT_MS);
    expect(createFile).not.toHaveBeenCalled();
  });

  it("gives up with the same sentence when Sogni is still busy, and stops Sogni's job", async () => {
    const harness = await setup(SOGNI);
    const { calls } = fakeServices(harness, { sogniStatus: "running" });
    const started = Date.now();

    const result = await run(harness, { prompt: "sunrise" });

    expect(result.error).toBe(QUICK_PICTURE_TIMEOUT_SENTENCE);
    expect(Date.now() - started).toBeLessThanOrEqual(QUICK_PICTURE_TIMEOUT_MS);
    expect(calls.some((c) => c.url.endsWith(`/v1/creative-agent/workflows/${WORKFLOW_ID}/cancel`))).toBe(true);
  });

  it("passes on the service's own plain sentence for other failures", async () => {
    const harness = await setup({ provider: "sogni" });
    fakeServices(harness);
    const result = await run(harness, { prompt: "sunrise" });
    expect(result.error).toBe(
      "The quick picture could not be made. Pick the Sogni API key in Media Studio settings (it comes from the company's Secrets).",
    );
  });

  it("uses the mock picture when Media Studio is set to mock", async () => {
    const harness = await setup({ provider: "mock" });
    const { calls } = fakeServices(harness);
    const result = await run(harness, { prompt: "sunrise" });
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ provider: "mock", quick: true });
    expect(calls).toHaveLength(0);
  });

  it("is its own tool next to Generate image, so an operator can tick one without the other", () => {
    const listed = manifest.tools ?? [];
    const quick = listed.find((t) => t.name === TOOL_QUICK_PICTURE)!;
    const full = listed.find((t) => t.name === TOOL_GENERATE)!;
    expect(quick.displayName).toBe("Quick picture");
    expect(quick.description).toContain("use generate-image instead");
    expect(full.description).toContain("use quick-picture instead");
    expect(Object.keys((quick.parametersSchema as any).properties)).toEqual(["prompt", "shape", "look", "issueId"]);
    const registry = createPluginToolRegistry();
    registry.registerPlugin("paperclip.media-studio", manifest, "db-id-1");
    const ticked = ["paperclip.media-studio:quick-picture"];
    expect(checkPluginToolGrant(ticked, "paperclip.media-studio:quick-picture", "ticked_only")).toBeNull();
    expect(checkPluginToolGrant(ticked, "paperclip.media-studio:generate-image", "ticked_only")).toContain("not granted");
  });
});
