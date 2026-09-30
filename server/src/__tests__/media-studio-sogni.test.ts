import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../../../packages/plugins/media-studio/src/worker.js";
import manifest, { TOOL_GENERATE } from "../../../packages/plugins/media-studio/src/manifest.js";
import { SogniProvider, assertSogniStorageUrl, sogniWorkflowModel } from "../../../packages/plugins/media-studio/src/sogni.js";
import {
  SOGNI_OFFLINE_MODELS,
  SogniCatalog,
  checkSogniLoras,
  checkSogniOverrides,
  lorasForModel,
  parseSogniLoraCatalog,
  parseSogniModelCatalog,
} from "../../../packages/plugins/media-studio/src/sogni-catalog.js";

/**
 * Media Studio's Sogni provider, against a fake Sogni (no real API is ever
 * called): start a workflow, poll it, download the picture from Sogni's
 * storage, and the ways that can go wrong. Then the worker: settings, looks
 * and the per-call choice pick Sogni, and a Sogni picture is stored like a
 * Fal one.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const REF_A = "66666666-6666-4666-8666-666666666666";
const REF_B = "77777777-7777-4777-8777-777777777777";
const REF_C = "99999999-9999-4999-8999-999999999999";
const REF_D = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runCtx = { agentId: AGENT, runId: RUN, companyId: COMPANY, projectId: "" };

/** A real-looking PNG head with bytes above 0x7f, so any text round-trip would show. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80, 0x00, 0x42]);
const ARTIFACT_URL = "https://complete-images.s3-accelerate.amazonaws.com/2026-09-27/wf1/picture.png?X-Amz-Signature=abc";
const UPLOAD_URL = "https://uploads.s3-accelerate.amazonaws.com/";
const WORKFLOW_ID = "wf_durable_workflow_1";

/**
 * Trimmed copies of Sogni's real public answers (read 2026-09-27 without a
 * key): GET /v1/model-catalog?mediaType=image&include=parameters and
 * GET /v1/loras/comfy (examples and file names left out).
 */
const MODEL_CATALOG = JSON.parse(readFileSync(new URL("./fixtures/sogni/model-catalog-image.json", import.meta.url), "utf8"));
const LORA_CATALOG = JSON.parse(readFileSync(new URL("./fixtures/sogni/loras-comfy.json", import.meta.url), "utf8"));
/** The id Sogni's catalog gives "Dark Beast Z-Image Turbo v9" (sogni.ai/models/dark-beast-z-image-turbo). */
const DARK_BEAST_V9 = "dark_beast_z_image_turbo_v9_bf16";
/** A personal LoRA row in the shape the personal-loras docs show. */
const PERSONAL_LORA_CATALOG = {
  status: "success",
  data: {
    loras: [
      {
        loraId: "personal-3f0c2b1a-0000-4000-8000-000000000001",
        slug: "personal-3f0c2b1a-0000-4000-8000-000000000001",
        name: "Our sofa range",
        description: "Your imported LoRA.",
        relatedLoraIds: [],
        modelIds: ["krea2_turbo_fp8_scaled", "krea2_identity_edit_v1_2"],
        ui: { category: "personal", label: "Our sofa range", min: 0, max: 1, default: 1, step: 0.05, recommendedMin: 0.5, recommendedMax: 1, nsfw: false, sexual: false, creator: "Imported by you", sourceUrl: "https://huggingface.co/example/sofa/resolve/main/sofa.safetensors" },
      },
    ],
  },
};

/**
 * The argument names Sogni's published tool schemas allow (both schemas say
 * additionalProperties: false, so any other name is a 400):
 * @sogni-ai/sogni-intelligence-client 4.6.2, schemas/tools/generate_image.schema.json
 * and edit_image.schema.json (creative-agent schema 2026-07-18.1).
 */
const GENERATE_IMAGE_ARGUMENTS = [
  "prompt", "model", "width", "height", "numberOfVariations", "negativePrompt", "starting_image_strength",
  "sourceImageIndex", "seed", "guidance", "gptImageQuality", "outputFormat", "aspectRatio", "gptImageBackground",
  "gptImageOutputCompression", "loras", "loraStrengths",
];
const EDIT_IMAGE_ARGUMENTS = [
  "prompt", "model", "sourceImageIndex", "numberOfVariations", "width", "height", "aspectRatio", "gptImageQuality",
  "outputFormat", "personaName", "gptImageBackground", "gptImageOutputCompression", "mask_image_url", "loras", "loraStrengths",
];
/** Start-body fields the workflows reference documents (snake_case wire names). */
const WORKFLOW_START_FIELDS = ["input", "token_type", "billing_mode", "app_source", "media_references", "safe_content_filter", "max_estimated_capacity_units", "confirm_cost"];

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

interface FakeSogniOptions {
  /** Status answers for each GET of the workflow, in order (the last repeats). */
  statuses?: Array<string | { status: number; headers?: Record<string, string>; body?: unknown }>;
  /** Answers for the start, in order (the last repeats). Default: 201 with the workflow id. */
  starts?: Array<{ status: number; headers?: Record<string, string>; body?: unknown }>;
  artifact?: Record<string, unknown>;
  waitingReason?: string;
  stepError?: string;
  /** Sogni's public model and LoRA lists: served (default) or unreachable. */
  catalog?: "ok" | "down";
  /** The answer to GET /v1/loras/personal/catalog (default: 403, no Unlimited plan). */
  personal?: { status: number; body?: unknown };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function headersOf(init?: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers as HeadersInit | undefined).entries());
}

function fakeSogni(options: FakeSogniOptions = {}) {
  const api: Call[] = [];
  const transfers: Call[] = [];
  let polls = 0;
  let starts = 0;
  const statuses = options.statuses ?? ["queued", "running", "completed"];
  const startAnswers = options.starts ?? [{ status: 201, body: { status: "success", data: { workflow: { workflowId: WORKFLOW_ID, status: "queued" } } } }];

  const apiFetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? null);
    api.push({ url, method, headers: headersOf(init), body });
    const path = new URL(url).pathname;
    if (method === "POST" && path === "/v1/creative-agent/workflows") {
      const answer = startAnswers[Math.min(starts++, startAnswers.length - 1)]!;
      return json(answer.status, answer.body ?? {}, answer.headers);
    }
    if (method === "POST" && path.endsWith("/cancel")) {
      return json(200, { status: "success", data: { workflow: { workflowId: WORKFLOW_ID, status: "cancelled" }, transitioned: true } });
    }
    if (method === "GET" && path === `/v1/creative-agent/workflows/${WORKFLOW_ID}`) {
      const answer = statuses[Math.min(polls++, statuses.length - 1)]!;
      if (typeof answer !== "string") return json(answer.status, answer.body ?? {}, answer.headers);
      const workflow: Record<string, unknown> = { workflowId: WORKFLOW_ID, status: answer };
      if (answer === "completed") {
        workflow.steps = [{ id: "picture", artifacts: [{ url: ARTIFACT_URL, ...(options.artifact ?? {}) }] }];
      }
      if (answer === "waiting_for_user") workflow.waitingReason = options.waitingReason ?? "other";
      if (answer === "failed") workflow.steps = [{ id: "picture", error: { message: options.stepError ?? "worker failed" } }];
      return json(200, { status: "success", data: { workflow } });
    }
    if (method === "GET" && path === "/v1/model-catalog") {
      return options.catalog === "down" ? json(503, { status: "error", message: "catalog unavailable" }) : json(200, MODEL_CATALOG);
    }
    if (method === "GET" && path === "/v1/loras/comfy") {
      return options.catalog === "down" ? json(503, { status: "error", message: "catalog unavailable" }) : json(200, LORA_CATALOG);
    }
    if (method === "GET" && path === "/v1/loras/personal/catalog") {
      const answer = options.personal ?? { status: 403, body: { status: "error", errorCode: 179, message: "Unlimited plan required" } };
      return json(answer.status, answer.body ?? {});
    }
    if (method === "GET" && path === "/v2/image/uploadUrl") {
      return json(200, {
        status: "success",
        data: { url: UPLOAD_URL, fields: { key: `refs/${new URL(url).searchParams.get("type")}`, Policy: "p", "X-Amz-Signature": "s" } },
      });
    }
    if (method === "GET" && path === "/v2/image/downloadUrl") {
      const type = new URL(url).searchParams.get("type");
      return json(200, { status: "success", data: { downloadUrl: `https://uploads.s3-accelerate.amazonaws.com/refs/${type}?X-Amz-Signature=d` } });
    }
    return json(404, { status: "error", message: `unexpected ${method} ${url}` });
  });

  const transferFetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    transfers.push({ url, method, headers: headersOf(init), body: init?.body ?? null });
    if (method === "POST") return new Response(null, { status: 204 });
    return new Response(PNG, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(PNG.length) } });
  });

  return { api, transfers, apiFetch, transferFetch };
}

/** A clock that only moves when the provider sleeps. */
function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

function provider(fake: ReturnType<typeof fakeSogni>, clock = fakeClock(), extra: Partial<ConstructorParameters<typeof SogniProvider>[0]> = {}) {
  let id = 0;
  return new SogniProvider({
    apiKey: "sogni-test-key",
    apiFetch: fake.apiFetch,
    transferFetch: fake.transferFetch,
    sleep: clock.sleep,
    now: clock.now,
    newId: () => `id-${++id}`,
    ...extra,
  });
}

function starts(fake: ReturnType<typeof fakeSogni>) {
  return fake.api.filter((call) => call.method === "POST" && new URL(call.url).pathname === "/v1/creative-agent/workflows");
}

function cancels(fake: ReturnType<typeof fakeSogni>) {
  return fake.api.filter((call) => call.url.endsWith(`/v1/creative-agent/workflows/${WORKFLOW_ID}/cancel`));
}

describe("Sogni provider", () => {
  it("starts a workflow, polls queued -> running -> completed every 2 s, downloads the picture and reports the seed", async () => {
    const fake = fakeSogni();
    const clock = fakeClock();
    const result = await provider(fake, clock).generate({ prompt: "a green sofa", seed: 123 });

    const [start] = starts(fake);
    expect(start!.url).toBe("https://api.sogni.ai/v1/creative-agent/workflows");
    expect(start!.headers.authorization).toBe("Bearer sogni-test-key");
    expect(start!.headers["idempotency-key"]).toBe("id-1");
    expect(start!.body).toEqual({
      input: {
        title: "Paperclip picture",
        steps: [
          {
            id: "picture",
            toolName: "generate_image",
            arguments: { prompt: "a green sofa", model: "z-turbo", seed: 123, numberOfVariations: 1, width: 1024, height: 768 },
          },
        ],
      },
      token_type: "auto",
      app_source: "paperclip-media-studio",
      safe_content_filter: true,
    });
    const polls = fake.api.filter((call) => call.method === "GET");
    expect(polls).toHaveLength(3);
    expect(polls.every((call) => call.url === `https://api.sogni.ai/v1/creative-agent/workflows/${WORKFLOW_ID}`)).toBe(true);
    expect(clock.sleeps).toEqual([2000, 2000, 2000]);
    expect(fake.transfers).toEqual([expect.objectContaining({ url: ARTIFACT_URL, method: "GET" })]);
    expect(cancels(fake)).toHaveLength(0);

    expect(result.provider).toBe("sogni");
    expect(result.model).toBe("z-turbo");
    expect(result.contentType).toBe("image/png");
    expect(result.imageUrl).toBeUndefined();
    expect(result.imageDataUrl).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(result.seed).toBe(123);
    expect(result.meta).toMatchObject({ seed: 123, workflowId: WORKFLOW_ID });
  });

  it("always sends a seed so it can be reused, and prefers the seed Sogni reports", async () => {
    const withoutSeed = fakeSogni();
    const made = await provider(withoutSeed).generate({ prompt: "a sofa" });
    const sent = (starts(withoutSeed)[0]!.body as any).input.steps[0].arguments.seed;
    expect(Number.isInteger(sent)).toBe(true);
    expect(made.seed).toBe(sent);

    const reported = fakeSogni({ artifact: { seed: 555 } });
    expect((await provider(reported).generate({ prompt: "a sofa", seed: 1 })).seed).toBe(555);
  });

  it("uses the configured model, token type and size", async () => {
    const fake = fakeSogni();
    await provider(fake, fakeClock(), { defaultModel: "qwen-2512-lightning", tokenType: "spark" }).generate({
      prompt: "a sofa",
      imageSize: "portrait_16_9",
    });
    const body = starts(fake)[0]!.body as any;
    expect(body.token_type).toBe("spark");
    expect(body.input.steps[0].arguments).toMatchObject({ model: "qwen-2512-lightning", width: 576, height: 1024 });

    const exact = fakeSogni();
    await provider(exact).generate({ prompt: "a sofa", imageSize: "1280x720", model: "krea-2-turbo" });
    expect((starts(exact)[0]!.body as any).input.steps[0].arguments).toMatchObject({ model: "krea-2-turbo", width: 1280, height: 720 });

    await expect(provider(fakeSogni()).generate({ prompt: "a sofa", imageSize: "huge" })).rejects.toThrow(
      /Sogni does not know the picture size "huge"/,
    );
  });

  it("waits out a 429 on the start for its Retry-After and resends with the same Idempotency-Key", async () => {
    const fake = fakeSogni({
      starts: [
        { status: 429, headers: { "Retry-After": "7" }, body: { status: "error", errorCode: 126, retryAfter: 7 } },
        { status: 201, body: { status: "success", data: { workflow: { workflowId: WORKFLOW_ID, status: "queued" } } } },
      ],
    });
    const clock = fakeClock();
    const result = await provider(fake, clock).generate({ prompt: "a sofa", seed: 9 });

    const sent = starts(fake);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers["idempotency-key"]).toBe(sent[1]!.headers["idempotency-key"]);
    expect(clock.sleeps[0]).toBe(7000);
    expect(result.seed).toBe(9);
  });

  it("honours a 429 while polling, and uses the body's retryAfter when there is no header", async () => {
    const fake = fakeSogni({
      statuses: ["queued", { status: 429, body: { error: "Too Many Requests", retryAfter: 5 } }, "completed"],
    });
    const clock = fakeClock();
    await provider(fake, clock).generate({ prompt: "a sofa" });
    expect(clock.sleeps).toEqual([2000, 2000, 5000]);
  });

  it("gives up on a 429 whose wait is longer than the time left, without starting anything", async () => {
    const fake = fakeSogni({ starts: [{ status: 429, headers: { "Retry-After": "1837" }, body: {} }] });
    await expect(provider(fake).generate({ prompt: "a sofa" })).rejects.toThrow(
      "Sogni is getting too many requests right now, try again in a minute.",
    );
    expect(starts(fake)).toHaveLength(1);
  });

  it("answers a 409 (too many active pictures) with a plain sentence and does not poll", async () => {
    const fake = fakeSogni({
      starts: [{ status: 409, body: { status: "error", message: "Too many active workflows", details: { activeWorkflowCount: 10, activeWorkflowLimit: 10 } } }],
    });
    await expect(provider(fake).generate({ prompt: "a sofa" })).rejects.toThrow(
      "Sogni is busy with other pictures on this account, try again in a minute.",
    );
    expect(fake.api.filter((call) => call.method === "GET")).toHaveLength(0);
    expect(fake.transfers).toHaveLength(0);
  });

  it("says plainly when the key is refused or the account is out of credit", async () => {
    await expect(provider(fakeSogni({ starts: [{ status: 401, body: {} }] })).generate({ prompt: "x" })).rejects.toThrow(
      "Sogni did not accept the API key. Check the Sogni key picked in Media Studio settings.",
    );
    await expect(provider(fakeSogni({ starts: [{ status: 402, body: {} }] })).generate({ prompt: "x" })).rejects.toThrow(
      /does not have enough credit/,
    );
  });

  it("reports a failed workflow with Sogni's reason and fetches nothing", async () => {
    const fake = fakeSogni({ statuses: ["running", "failed"], stepError: "The model could not render this prompt" });
    await expect(provider(fake).generate({ prompt: "a sofa" })).rejects.toThrow(
      "Sogni could not make the picture: The model could not render this prompt.",
    );
    expect(fake.transfers).toHaveLength(0);
  });

  it("stops a picture that is not done after 120 seconds: cancels the workflow and says so", async () => {
    const fake = fakeSogni({ statuses: ["queued", "running"] });
    const clock = fakeClock();
    await expect(provider(fake, clock).generate({ prompt: "a sofa" })).rejects.toThrow(
      "Sogni took longer than 120 seconds to make the picture, so it was stopped. Try again in a minute.",
    );
    expect(cancels(fake)).toHaveLength(1);
    expect(cancels(fake)[0]!.method).toBe("POST");
    expect(cancels(fake)[0]!.headers.authorization).toBe("Bearer sogni-test-key");
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(120_000);
    expect(fake.transfers).toHaveLength(0);
  });

  it("cancels a paused workflow (content filter) instead of leaving it waiting", async () => {
    const fake = fakeSogni({ statuses: ["running", "waiting_for_user"], waitingReason: "safety_review_required" });
    await expect(provider(fake).generate({ prompt: "a sofa" })).rejects.toThrow("Sogni's content filter stopped this picture.");
    expect(cancels(fake)).toHaveLength(1);
  });

  it("refuses a picture address that is not on Sogni's storage host, and never fetches it", async () => {
    for (const url of [
      "https://evil.example.com/picture.png",
      "http://complete-images.s3-accelerate.amazonaws.com/picture.png",
      "https://s3-accelerate.amazonaws.com.evil.example/picture.png",
      "https://127.0.0.1/picture.png",
    ]) {
      const fake = fakeSogni({ artifact: { url } });
      await expect(provider(fake).generate({ prompt: "a sofa" })).rejects.toThrow(/which is not Sogni's picture storage, so it was not used/);
      expect(fake.transfers).toHaveLength(0);
    }
    expect(() => assertSogniStorageUrl("https://user:pw@b.s3-accelerate.amazonaws.com/x")).toThrow(/not Sogni's picture storage/);
    expect(assertSogniStorageUrl(ARTIFACT_URL).hostname).toBe("complete-images.s3-accelerate.amazonaws.com");
  });

  it("uploads reference pictures to Sogni's storage and sends only Sogni's presigned addresses to edit_image", async () => {
    const fake = fakeSogni();
    const refA = `data:image/png;base64,${PNG.toString("base64")}`;
    const refB = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0x01]).toString("base64")}`;
    const result = await provider(fake).generate({ prompt: "the same chair in a garden", referenceImages: [refA, refB], seed: 42 });

    const uploadSlots = fake.api.filter((call) => new URL(call.url).pathname === "/v2/image/uploadUrl").map((call) => new URL(call.url).searchParams);
    expect(uploadSlots.map((q) => [q.get("type"), q.get("contentType")])).toEqual([
      ["contextImage1", "image/png"],
      ["contextImage2", "image/jpeg"],
    ]);
    expect(uploadSlots[0]!.get("jobId")).toMatch(/^paperclip-/);

    const posts = fake.transfers.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.url).toBe(UPLOAD_URL);
    const form = posts[0]!.body as FormData;
    expect([...form.keys()]).toEqual(["key", "Policy", "X-Amz-Signature", "file"]);
    const file = form.get("file") as Blob;
    expect(file.type).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);

    const body = starts(fake)[0]!.body as any;
    expect(body.media_references).toEqual([
      { kind: "image", url: "https://uploads.s3-accelerate.amazonaws.com/refs/contextImage1?X-Amz-Signature=d" },
      { kind: "image", url: "https://uploads.s3-accelerate.amazonaws.com/refs/contextImage2?X-Amz-Signature=d" },
    ]);
    expect(body.input.steps[0]).toEqual({
      id: "picture",
      toolName: "edit_image",
      arguments: { prompt: "the same chair in a garden", model: "qwen-lightning", sourceImageIndex: -1, numberOfVariations: 1 },
    });
    const sent = JSON.stringify(body);
    expect(sent).not.toContain("data:");
    expect(sent).not.toContain("/api/attachments");
    // edit_image takes no seed: nothing is claimed about one.
    expect(result.seed).toBeNull();
    expect(result.meta).toMatchObject({ seedNotUsed: true });
  });

  it("refuses an upload address that is not Sogni's storage", async () => {
    const fake = fakeSogni();
    fake.apiFetch.mockImplementationOnce(async () => json(200, { data: { url: "https://attacker.example/upload", fields: {} } }));
    await expect(
      provider(fake).generate({ prompt: "x", referenceImages: [`data:image/png;base64,${PNG.toString("base64")}`] }),
    ).rejects.toThrow(/not Sogni's picture storage/);
    expect(fake.transfers).toHaveLength(0);
  });
});

// ─── The worker: choosing Sogni, and storing its picture ─────────────────────

function companyFile(id: string, contentType = "image/png") {
  const contentPath = `/api/attachments/${id}/content`;
  return {
    id,
    companyId: COMPANY,
    issueId: null,
    contentType,
    byteSize: PNG.length,
    originalFilename: `${id.slice(0, 4)}.png`,
    createdByAgentId: null,
    contentPath,
    openPath: contentPath,
    downloadPath: `${contentPath}?download=1`,
    createdAt: new Date(),
    contentBase64: PNG.toString("base64"),
  };
}

const SOGNI_CONFIG = { provider: "sogni", sogniKeySecretRef: "sogni-key-ref" };
const FAL_CONFIG = { provider: "fal", falKeySecretRef: "fal-key-ref" };
const looksKey = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: "looks" };

describe("media-studio worker with Sogni", () => {
  let harness: TestHarness;
  let fake: ReturnType<typeof fakeSogni>;
  let falCalls: string[];

  async function setup(config: Record<string, unknown>) {
    harness = createTestHarness({ manifest, config });
    harness.seed({ companyFiles: [companyFile(REF_A), companyFile(REF_B), companyFile(REF_C), companyFile(REF_D)] });
    await plugin.definition.setup(harness.ctx);
    fake = fakeSogni();
    falCalls = [];
    // API calls go through the host's gated fetch; the picture bytes through the guarded transfer fetch.
    harness.ctx.http.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://fal.run/")) {
        falCalls.push(url);
        return json(200, { images: [{ url: "https://v3.fal.media/files/out.png", content_type: "image/png" }], seed: 1 });
      }
      if (url.startsWith("https://v3.fal.media/")) return new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } });
      return fake.apiFetch(url, init);
    }) as typeof harness.ctx.http.fetch;
    vi.stubGlobal("fetch", fake.transferFetch);
  }

  /** Run a tool call while fake timers drive the 2-second polling. */
  async function run(params: Record<string, unknown>) {
    const pending = harness.executeTool<any>(TOOL_GENERATE, params, runCtx);
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

  it("makes the picture with Sogni and stores the exact bytes as a company file, with the seed", async () => {
    await setup(SOGNI_CONFIG);
    const resolve = vi.spyOn(harness.ctx.secrets, "resolve");
    const createFile = vi.spyOn(harness.ctx.files, "createCompanyFile");

    const result = await run({ prompt: "a green sofa", seed: 31337 });

    expect(result.error).toBeUndefined();
    expect(resolve).toHaveBeenCalledWith("sogni-key-ref");
    expect(starts(fake)[0]!.headers.authorization).toBe("Bearer resolved:sogni-key-ref");
    expect(fake.transfers.map((call) => call.url)).toEqual([ARTIFACT_URL]);
    const [input, companyId] = createFile.mock.calls[0]!;
    expect(companyId).toBe(COMPANY);
    expect(input).toMatchObject({ contentType: "image/png", filename: "image-seed-31337.png" });
    expect(Buffer.from(input.contentBase64, "base64").equals(PNG)).toBe(true);
    expect(result.data).toMatchObject({ provider: "sogni", model: "z-turbo", seed: 31337, issueId: null });
    expect(result.content).toContain("Seed: 31337");
    expect(falCalls).toHaveLength(0);
  });

  it("uses the Sogni model and payment from settings", async () => {
    await setup({ ...SOGNI_CONFIG, sogniModel: "chroma-v46-flash", sogniTokenType: "spark" });
    await run({ prompt: "a sofa" });
    const body = starts(fake)[0]!.body as any;
    expect(body.token_type).toBe("spark");
    expect(body.input.steps[0].arguments.model).toBe("chroma-v46-flash");
  });

  it("says which setting is missing when no Sogni key is picked", async () => {
    await setup({ provider: "sogni" });
    const result = await run({ prompt: "a sofa" });
    expect(result.error).toBe("Pick the Sogni API key in Media Studio settings (it comes from the company's Secrets).");
    expect(fake.api).toHaveLength(0);
  });

  it("lets one call pick Sogni or Fal regardless of settings", async () => {
    await setup({ ...FAL_CONFIG, sogniKeySecretRef: "sogni-key-ref" });
    const viaSogni = await run({ prompt: "a sofa", provider: "sogni" });
    expect(viaSogni.data.provider).toBe("sogni");
    expect(starts(fake)).toHaveLength(1);
    expect(falCalls).toHaveLength(0);

    await setup({ ...SOGNI_CONFIG, falKeySecretRef: "fal-key-ref" });
    const viaFal = await run({ prompt: "a sofa", provider: "fal" });
    expect(viaFal.data.provider).toBe("fal");
    expect(falCalls).toEqual(["https://fal.run/fal-ai/flux/schnell"]);
    expect(starts(fake)).toHaveLength(0);
  });

  it("refuses an unknown service, or a model from the other service, before using up the day's limit", async () => {
    await setup(SOGNI_CONFIG);
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    expect((await run({ prompt: "x", provider: "midjourney" })).error).toBe(
      '"midjourney" is not a picture service. Use fal (Fal.ai) or sogni (Sogni), or leave it out.',
    );
    expect((await run({ prompt: "x", provider: "sogni", model: "fal-ai/flux/dev" })).error).toBe(
      "The model fal-ai/flux/dev is a Fal.ai model, not a Sogni one. Leave out the model, or use Fal.ai.",
    );
    expect((await run({ prompt: "x", imageSize: "enormous" })).error).toMatch(/Sogni does not know the picture size "enormous"/);
    expect(reserve).not.toHaveBeenCalled();
    expect(fake.api).toHaveLength(0);
  });

  it("a model name picks its own service", async () => {
    await setup({ ...FAL_CONFIG, sogniKeySecretRef: "sogni-key-ref" });
    const result = await run({ prompt: "a sofa", model: "qwen-2512-lightning" });
    expect(result.data.provider).toBe("sogni");
    expect((starts(fake)[0]!.body as any).input.steps[0].arguments.model).toBe("qwen-2512-lightning");
    expect(falCalls).toHaveLength(0);
  });

  it("a look can pick Sogni (by its service, or by a Sogni model) while settings say Fal", async () => {
    await setup({ ...FAL_CONFIG, sogniKeySecretRef: "sogni-key-ref" });
    await harness.ctx.state.set(looksKey, [
      { id: "l1", name: "Catalogue", style: "soft daylight", model: null, provider: "sogni", seed: 777, referenceFileIds: [], updatedAt: "x" },
      { id: "l2", name: "Poster", style: "bold", model: "krea-2-turbo", seed: null, referenceFileIds: [], updatedAt: "x" },
    ]);

    const catalogue = await run({ prompt: "a sofa", look: "Catalogue" });
    expect(catalogue.error).toBeUndefined();
    expect(catalogue.data).toMatchObject({ provider: "sogni", seed: 777, look: "Catalogue" });
    expect((starts(fake)[0]!.body as any).input.steps[0].arguments).toMatchObject({
      prompt: "a sofa\n\nStyle: soft daylight",
      model: "z-turbo",
      seed: 777,
    });

    const poster = await run({ prompt: "a sofa", look: "Poster" });
    expect(poster.data.provider).toBe("sogni");
    expect((starts(fake)[1]!.body as any).input.steps[0].arguments.model).toBe("krea-2-turbo");
    expect(falCalls).toHaveLength(0);

    // Asking for Fal explicitly drops the look's Sogni model and uses Fal's normal one.
    const onFal = await run({ prompt: "a sofa", look: "Poster", provider: "fal" });
    expect(onFal.data.provider).toBe("fal");
    expect(falCalls).toEqual(["https://fal.run/fal-ai/flux/schnell"]);
  });

  it("sends a look's and the call's reference pictures to Sogni via upload, never as Paperclip addresses", async () => {
    await setup(SOGNI_CONFIG);
    await harness.ctx.state.set(looksKey, [
      { id: "l1", name: "Chair", style: "", model: null, provider: "sogni", seed: null, referenceFileIds: [REF_A], updatedAt: "x" },
    ]);
    const result = await run({ prompt: "the same chair in a garden", look: "Chair", referenceFileIds: [REF_B] });

    expect(result.error).toBeUndefined();
    const posted = fake.transfers.filter((call) => call.method === "POST");
    expect(posted).toHaveLength(2);
    const body = starts(fake)[0]!.body as any;
    expect(body.input.steps[0].toolName).toBe("edit_image");
    expect(body.media_references).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("/api/attachments");
    expect(JSON.stringify(fake.api)).not.toContain("/api/attachments");
  });

  it("refuses more reference pictures than Sogni's edit model takes, before spending anything", async () => {
    await setup(SOGNI_CONFIG);
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    const result = await run({ prompt: "x", referenceFileIds: [REF_A, REF_B, REF_C, REF_D] });
    expect(result.error).toBe("Sogni's qwen-lightning model takes at most 3 reference pictures (this asked for 4).");
    expect(reserve).not.toHaveBeenCalled();
    expect(fake.api).toHaveLength(0);
  });

  it("says plainly that a seed cannot be applied to a Sogni picture made from reference pictures", async () => {
    await setup(SOGNI_CONFIG);
    const result = await run({ prompt: "the same chair", referenceFileIds: [REF_A], seed: 12 });
    expect(result.error).toBeUndefined();
    expect(result.data.seed).toBeNull();
    expect(result.content).toContain("Sogni does not use a seed when it works from reference pictures");
  });

  it("passes on Sogni's 409 as a plain sentence", async () => {
    await setup(SOGNI_CONFIG);
    fake.apiFetch.mockImplementationOnce(async () => json(409, { status: "error", message: "too many" }));
    const result = await run({ prompt: "a sofa" });
    expect(result.error).toBe("Sogni is busy with other pictures on this account, try again in a minute.");
  });

  it("saves a look's service, and refuses a model from the other service", async () => {
    await setup(SOGNI_CONFIG);
    const owner = { actor: { type: "user" as const, userId: "u1", canManageCompany: true }, companyId: COMPANY };
    await expect(
      harness.performAction("looks.save", { name: "A", style: "", provider: "sogni", model: "fal-ai/flux/dev", seed: null, referenceFileIds: [] }, owner),
    ).rejects.toThrow('"fal-ai/flux/dev" is a Fal.ai model. Pick Fal.ai as the service, or another model.');
    const saved = await harness.performAction<any>(
      "looks.save",
      { name: "A", style: "", provider: "sogni", model: "z-turbo", seed: null, referenceFileIds: [] },
      owner,
    );
    // A tool key is saved as the catalog model it names.
    expect(saved.looks[0]).toMatchObject({ name: "A", provider: "sogni", model: "z_image_turbo_bf16", modelName: "Z-Image Turbo" });
    const listed = await harness.executeTool<any>("list-looks", {}, runCtx);
    expect(listed.content).toContain("- A (made with Sogni; model Z-Image Turbo (z_image_turbo_bf16))");
  });
});

// ─── Models and LoRAs from Sogni's catalog ───────────────────────────────────

describe("Sogni's model and LoRA catalog", () => {
  function catalogFetch(answers: { models?: () => Response; loras?: () => Response } = {}) {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      const path = new URL(url).pathname;
      if (path === "/v1/model-catalog") return answers.models ? answers.models() : json(200, MODEL_CATALOG);
      if (path === "/v1/loras/comfy") return answers.loras ? answers.loras() : json(200, LORA_CATALOG);
      return json(404, {});
    });
    return { calls, fetchImpl };
  }

  it("reads the image models: names, tags, workers online, parameter ranges, and leaves out one-job tools", () => {
    const parsed = parseSogniModelCatalog(MODEL_CATALOG)!;
    const ids = parsed.models.map((m) => m.id);
    expect(ids).not.toContain("birefnet_image_background_removal_fp16");
    const darkBeast = parsed.models.find((m) => m.id === DARK_BEAST_V9)!;
    expect(darkBeast).toMatchObject({
      name: "Dark Beast Z-Image Turbo v9",
      tags: ["fast", "new", "spicy", "standard", "uncensored"],
      generates: true,
      takesReferences: false,
      workersOnline: 85,
      contentFilter: "off-required",
      width: { min: 512, max: 2048, default: 1024, step: 16 },
      steps: { min: 4, max: 12, default: 8 },
      // Guidance is fixed at 1 for this model, so it cannot be changed.
      guidance: null,
      creator: "AiMetatron",
      variant: false,
    });
    expect(parsed.models.find((m) => m.id === "qwen_image_edit_2511_fp8_lightning")).toMatchObject({ generates: false, takesReferences: true });
    expect(parsed.models.find((m) => m.id === "chroma1-hd_fp8_scaled")).toMatchObject({
      guidance: { min: 1, max: 8, default: 3.8 },
      negativePrompt: { default: expect.stringContaining("low quality") },
    });
    // Untagged builds of other models sort last and are marked, so the picker can hide them.
    expect(parsed.models.find((m) => m.id === "z_image_turbo_4bit")).toMatchObject({ variant: true, workersOnline: 0 });
    expect(ids.indexOf("z_image_turbo_4bit")).toBe(ids.length - 1);
    expect(parseSogniModelCatalog({ status: "error" })).toBeNull();
  });

  it("keeps the list for 10 minutes, keeps using the last list when Sogni cannot be reached, and waits 30 s before asking again", async () => {
    let now = 0;
    let down = false;
    const { calls, fetchImpl } = catalogFetch({ models: () => (down ? json(503, {}) : json(200, MODEL_CATALOG)) });
    const catalog = new SogniCatalog(fetchImpl, { now: () => now });

    expect((await catalog.models()).live).toBe(true);
    now += 9 * 60 * 1000;
    await catalog.models();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://api.sogni.ai/v1/model-catalog?mediaType=image&include=parameters");

    now += 2 * 60 * 1000;
    down = true;
    const stale = await catalog.models();
    expect(calls).toHaveLength(2);
    expect(stale.live).toBe(true);
    expect(stale.models.some((m) => m.id === DARK_BEAST_V9)).toBe(true);
    now += 10 * 1000;
    await catalog.models();
    expect(calls).toHaveLength(2);
    now += 30 * 1000;
    await catalog.models();
    expect(calls).toHaveLength(3);
  });

  it("offers the built-in list when Sogni's catalog was never read, and then knows nothing for sure", async () => {
    const { fetchImpl } = catalogFetch({ models: () => { throw new Error("network down"); } });
    const catalog = new SogniCatalog(fetchImpl);
    const list = await catalog.models();
    expect(list.live).toBe(false);
    expect(list.models).toBe(SOGNI_OFFLINE_MODELS);
    expect(list.models.map((m) => m.id)).toContain(DARK_BEAST_V9);
    expect(await catalog.model(DARK_BEAST_V9)).toEqual({ model: null, live: false });
  });

  it("finds a model by its catalog id or by its tool key", async () => {
    const catalog = new SogniCatalog(catalogFetch().fetchImpl);
    expect((await catalog.model("dark-beast-z-turbo")).model?.id).toBe(DARK_BEAST_V9);
    expect((await catalog.model(DARK_BEAST_V9)).model?.name).toBe("Dark Beast Z-Image Turbo v9");
    expect(await catalog.model("no-such-model")).toEqual({ model: null, live: true });
    expect(catalog.knows("krea-2-turbo")).toBe(true);
  });

  it("reads LoRAs with their strength ranges, and knows which models take them", () => {
    const parsed = parseSogniLoraCatalog(LORA_CATALOG)!;
    expect(parsed.maxPerRequest).toBe(8);
    const detail = parsed.loras.find((l) => l.id === "krea2-detail-enhancer")!;
    expect(detail).toMatchObject({
      name: "Detail Enhancer",
      min: -5,
      max: 5,
      default: 1,
      recommendedMin: -2,
      recommendedMax: 5,
      needsFilterOff: false,
      creator: "alcaitiff",
      sourceUrl: "https://civitai.com/models/2729908?modelVersionId=3068874",
    });
    expect(parsed.loras.find((l) => l.id === "krea2-realism-engine")!.needsFilterOff).toBe(true);
    expect(lorasForModel(parsed, "krea-2-turbo").map((l) => l.id)).toEqual([
      "krea2-detail-enhancer",
      "krea2-warm-light",
      "krea2-candid",
      "krea2-realism-engine",
    ]);
    // Sogni has no public LoRAs for Dark Beast Z-Image Turbo v9 (read 2026-09-27).
    expect(lorasForModel(parsed, DARK_BEAST_V9)).toEqual([]);
    expect(parsed.models).toContain("dark_beast_krea2_fp8");
    expect(parsed.models).not.toContain(DARK_BEAST_V9);
    const personal = parseSogniLoraCatalog(PERSONAL_LORA_CATALOG, true)!;
    expect(personal.loras[0]).toMatchObject({ personal: true, min: 0, max: 1 });
  });

  it("refuses LoRAs that do not fit: too many, the wrong model, strength out of range, filter needed off, twice", () => {
    const known = [...parseSogniLoraCatalog(LORA_CATALOG)!.loras, ...parseSogniLoraCatalog(PERSONAL_LORA_CATALOG, true)!.loras];
    const krea = { id: "krea2_turbo_fp8_scaled", name: "Krea 2 Turbo" };
    const on = { contentFilterOn: true };
    expect(checkSogniLoras(krea, [{ id: "krea2-detail-enhancer", strength: 3 }, { id: "krea2-warm-light", strength: -2 }], known, on)).toBeNull();
    expect(
      checkSogniLoras(krea, Array.from({ length: 9 }, (_, i) => ({ id: `l${i}`, strength: 1 })), known, on),
    ).toBe("A picture can use at most 8 LoRAs; this has 9. Remove some.");
    expect(checkSogniLoras({ id: "z_image_turbo_bf16", name: "Z-Image Turbo" }, [{ id: "krea2-detail-enhancer", strength: 1 }], known, on)).toBe(
      'The LoRA "Detail Enhancer" does not work with the model Z-Image Turbo. Pick LoRAs from the list for this model.',
    );
    expect(checkSogniLoras(krea, [{ id: "krea2-detail-enhancer", strength: 5.5 }], known, on)).toBe(
      'The strength of "Detail Enhancer" must be between -5 and 5 (it is 5.5).',
    );
    expect(checkSogniLoras(krea, [{ id: "krea2-realism-engine", strength: 0.8 }], known, on)).toBe(
      'The LoRA "Realism Engine v3" only works with the Sensitive content filter off. Turn the filter off for this look, or remove the LoRA.',
    );
    expect(checkSogniLoras(krea, [{ id: "krea2-realism-engine", strength: 0.8 }], known, { contentFilterOn: false })).toBeNull();
    expect(checkSogniLoras(krea, [{ id: "personal-3f0c2b1a-0000-4000-8000-000000000001", strength: 0 }], known, on)).toBe(
      'Your own LoRA "Our sofa range" takes a strength above 0 and at most 1 (it is 0).',
    );
    expect(checkSogniLoras(krea, [{ id: "krea2-candid", strength: 3 }, { id: "krea2-candid", strength: 4 }], known, on)).toBe(
      'The LoRA "krea2-candid" is in the list twice. Keep it once.',
    );
    expect(checkSogniLoras(krea, [{ id: "made-up", strength: 1 }], known, on)).toMatch(/Sogni has no LoRA called "made-up"/);
  });

  it("checks guidance, things-to-avoid text and size against what the model allows", () => {
    const models = parseSogniModelCatalog(MODEL_CATALOG)!.models;
    const chroma = models.find((m) => m.id === "chroma1-hd_fp8_scaled")!;
    const darkBeast = models.find((m) => m.id === DARK_BEAST_V9)!;
    expect(checkSogniOverrides(chroma, { guidance: 4, negativePrompt: "blurry", size: "1024x1024" })).toBeNull();
    expect(checkSogniOverrides(chroma, { guidance: 9, negativePrompt: null, size: null })).toBe("Guidance for Chroma1-HD must be between 1 and 8.");
    expect(checkSogniOverrides(darkBeast, { guidance: 2, negativePrompt: null, size: null })).toBe(
      "The model Dark Beast Z-Image Turbo v9 does not let you change guidance. Leave it empty.",
    );
    expect(checkSogniOverrides(darkBeast, { guidance: null, negativePrompt: "blurry", size: null })).toMatch(/does not use "things to avoid" text/);
    expect(checkSogniOverrides(darkBeast, { guidance: null, negativePrompt: null, size: "320x320" })).toMatch(
      /Dark Beast Z-Image Turbo v9 does not take the picture size "320x320".*each side 512 to 2048/,
    );
  });
});

describe("Sogni provider: LoRAs, model settings and the content filter", () => {
  it("sends LoRAs, strengths, guidance and things-to-avoid as generate_image arguments Sogni's schema allows", async () => {
    const fake = fakeSogni();
    await provider(fake).generate({
      prompt: "a sofa",
      model: "krea2_turbo_fp8_scaled",
      loras: [
        { id: "krea2-detail-enhancer", strength: 3 },
        { id: "krea2-warm-light", strength: -2 },
      ],
      guidance: 2.5,
      negativePrompt: "blurry, text",
    });
    const body = starts(fake)[0]!.body as any;
    const args = body.input.steps[0].arguments;
    expect(body.input.steps[0].toolName).toBe("generate_image");
    expect(args).toMatchObject({
      model: "krea-2-turbo",
      loras: ["krea2-detail-enhancer", "krea2-warm-light"],
      loraStrengths: [3, -2],
      guidance: 2.5,
      negativePrompt: "blurry, text",
    });
    expect(Object.keys(args).filter((k) => !GENERATE_IMAGE_ARGUMENTS.includes(k))).toEqual([]);
    expect(Object.keys(body).filter((k) => !WORKFLOW_START_FIELDS.includes(k))).toEqual([]);
    // The filter is said out loud, and is on unless asked otherwise.
    expect(body.safe_content_filter).toBe(true);
  });

  it("sends LoRAs on edit_image (no guidance there), with the catalog's edit model", async () => {
    const fake = fakeSogni();
    await provider(fake).generate({
      prompt: "the same person in a garden",
      model: "krea2_identity_edit_v1_2",
      modelTakesReferences: true,
      referenceImages: [`data:image/png;base64,${PNG.toString("base64")}`],
      loras: [{ id: "krea2-candid", strength: 4 }],
      guidance: 3,
      negativePrompt: "text",
    });
    const step = (starts(fake)[0]!.body as any).input.steps[0];
    expect(step.toolName).toBe("edit_image");
    expect(step.arguments).toEqual({
      prompt: "the same person in a garden",
      model: "krea-identity-edit",
      sourceImageIndex: -1,
      numberOfVariations: 1,
      loras: ["krea2-candid"],
      loraStrengths: [4],
    });
    expect(Object.keys(step.arguments).filter((k) => !EDIT_IMAGE_ARGUMENTS.includes(k))).toEqual([]);
  });

  it("turns the filter off for the whole workflow only when told to, and sends a catalog id with no tool key as it is", async () => {
    const off = fakeSogni();
    await provider(off).generate({ prompt: "x", model: DARK_BEAST_V9, safeContentFilter: false });
    const body = starts(off)[0]!.body as any;
    expect(body.safe_content_filter).toBe(false);
    expect(body.input.steps[0].arguments.model).toBe("dark-beast-z-turbo");
    expect(JSON.stringify(body.input)).not.toContain("safe");

    const raw = fakeSogni();
    await provider(raw).generate({ prompt: "x", model: "coreml-sogniXLturbo_alpha1_ad" });
    expect((starts(raw)[0]!.body as any).input.steps[0].arguments.model).toBe("coreml-sogniXLturbo_alpha1_ad");
    expect(sogniWorkflowModel("qwen_image_edit_2511_fp8_lightning", "edit_image")).toBe("qwen-lightning");
  });
});

describe("media-studio looks with Sogni models and LoRAs", () => {
  let harness: TestHarness;
  let fake: ReturnType<typeof fakeSogni>;
  const owner = { actor: { type: "user" as const, userId: "owner-1", canManageCompany: true }, companyId: COMPANY };
  const member = { actor: { type: "user" as const, userId: "member-1", canManageCompany: false }, companyId: COMPANY };

  async function setup(options: FakeSogniOptions = {}, config: Record<string, unknown> = SOGNI_CONFIG) {
    harness = createTestHarness({ manifest, config });
    harness.seed({ companyFiles: [companyFile(REF_A)] });
    await plugin.definition.setup(harness.ctx);
    fake = fakeSogni(options);
    harness.ctx.http.fetch = vi.fn((url: string, init?: RequestInit) => fake.apiFetch(url, init)) as typeof harness.ctx.http.fetch;
    vi.stubGlobal("fetch", fake.transferFetch);
  }

  async function run(params: Record<string, unknown>) {
    const pending = harness.executeTool<any>(TOOL_GENERATE, params, runCtx);
    await vi.runAllTimersAsync();
    return pending;
  }

  function save(fields: Record<string, unknown>, context = owner) {
    return harness.performAction<any>("looks.save", { style: "", seed: null, referenceFileIds: [], provider: "sogni", ...fields }, context);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lists Sogni's models for the picker, with LoRA availability, and the LoRAs for one model", async () => {
    await setup();
    const models = await harness.performAction<any>("sogni.models", {}, member);
    expect(models.live).toBe(true);
    expect(models.maxLoras).toBe(8);
    expect(models.models.find((m: any) => m.id === DARK_BEAST_V9)).toMatchObject({
      name: "Dark Beast Z-Image Turbo v9",
      workersOnline: 85,
      contentFilter: "off-required",
      hasLoras: false,
    });
    expect(models.models.find((m: any) => m.id === "krea2_turbo_fp8_scaled").hasLoras).toBe(true);

    const loras = await harness.performAction<any>("sogni.loras", { modelId: "krea2_turbo_fp8_scaled" }, owner);
    expect(loras.loras.map((l: any) => l.id)).toEqual(["krea2-detail-enhancer", "krea2-warm-light", "krea2-candid", "krea2-realism-engine"]);
    // No Unlimited plan: only Sogni's public LoRAs, and a note saying why.
    expect(loras.personal).toBe("not-allowed");
    expect(loras.note).toBe("Your own LoRAs are not shown: they need an active Sogni Unlimited plan.");
    const personalCall = fake.api.find((c) => c.url.endsWith("/v1/loras/personal/catalog"))!;
    expect(personalCall.headers.authorization).toBe("Bearer resolved:sogni-key-ref");
    // The public lists are read without the key.
    expect(fake.api.filter((c) => !c.url.endsWith("/personal/catalog")).every((c) => !c.headers.authorization)).toBe(true);

    const none = await harness.performAction<any>("sogni.loras", { modelId: DARK_BEAST_V9 }, member);
    expect(none.loras).toEqual([]);
    expect(none.personal).toBe("owners-only");
  });

  it("adds the account's own LoRAs for an owner when the plan allows them", async () => {
    await setup({ personal: { status: 200, body: PERSONAL_LORA_CATALOG } });
    const loras = await harness.performAction<any>("sogni.loras", { modelId: "krea-2-turbo" }, owner);
    expect(loras.personal).toBe("included");
    expect(loras.loras.at(-1)).toMatchObject({ id: "personal-3f0c2b1a-0000-4000-8000-000000000001", personal: true });
  });

  it("saves a Dark Beast Z-Image Turbo v9 look with the filter off, and its pictures are made with the filter off", async () => {
    await setup();
    const saved = await save({ name: "After dark", style: "moody", model: DARK_BEAST_V9, safeContentFilter: false });
    expect(saved.looks[0]).toMatchObject({
      model: DARK_BEAST_V9,
      modelName: "Dark Beast Z-Image Turbo v9",
      loras: [],
      safeContentFilter: false,
      contentFilterOffBy: "owner-1",
    });

    const result = await run({ prompt: "a sofa at night", look: "After dark" });
    expect(result.error).toBeUndefined();
    const body = starts(fake)[0]!.body as any;
    expect(body.safe_content_filter).toBe(false);
    expect(body.input.steps[0].arguments).toMatchObject({ model: "dark-beast-z-turbo", prompt: "a sofa at night\n\nStyle: moody" });

    const listed = await harness.executeTool<any>("list-looks", {}, runCtx);
    expect(listed.content).toContain("model Dark Beast Z-Image Turbo v9 (dark_beast_z_image_turbo_v9_bf16)");
    expect(listed.content).toContain("content filter off (pictures can be explicit)");
    expect(listed.data.looks[0]).toMatchObject({ modelName: "Dark Beast Z-Image Turbo v9", contentFilter: "off" });
  });

  // DUR-4133: a trusted caller's `safeForWork: true` (the morning report's
  // pictures, which nobody reviews before they go out) must win over even a
  // look an owner/admin saved with the filter off — forcing the filter ON is
  // never a privilege escalation, unlike a look forcing it off.
  it("safeForWork forces the content filter back on and adds the safety negative prompt, even for a look saved with the filter off", async () => {
    await setup();
    // chroma1-hd_fp8_scaled (unlike Dark Beast) is not "off-required", and it
    // supports "things to avoid" text, so the negative-prompt assertion below
    // exercises the real API field, not the prompt-text fallback.
    await save({ name: "After dark", style: "moody", model: "chroma1-hd_fp8_scaled", safeContentFilter: false });

    const result = await run({ prompt: "a sofa at night", look: "After dark", safeForWork: true });
    expect(result.error).toBeUndefined();
    const body = starts(fake)[0]!.body as any;
    expect(body.safe_content_filter).toBe(true);
    expect(body.input.steps[0].arguments.negativePrompt).toContain("nudity");
  });

  it("saves a Krea 2 Turbo look with LoRAs and sends them, in order, with their strengths", async () => {
    await setup();
    await save({
      name: "Catalogue",
      model: "krea2_turbo_fp8_scaled",
      loras: [
        { id: "krea2-detail-enhancer", strength: 3 },
        { id: "krea2-warm-light", strength: "-2" },
      ],
      size: "1280x720",
    });
    const result = await run({ prompt: "a green sofa", look: "Catalogue" });
    expect(result.error).toBeUndefined();
    const body = starts(fake)[0]!.body as any;
    expect(body.safe_content_filter).toBe(true);
    expect(body.input.steps[0].arguments).toMatchObject({
      model: "krea-2-turbo",
      loras: ["krea2-detail-enhancer", "krea2-warm-light"],
      loraStrengths: [3, -2],
      width: 1280,
      height: 720,
    });

    const listed = await harness.executeTool<any>("list-looks", {}, runCtx);
    expect(listed.content).toContain("LoRAs: Detail Enhancer at 3, Warm Light at -2");
    expect(listed.data.looks[0].loras).toEqual([
      { name: "Detail Enhancer", id: "krea2-detail-enhancer", strength: 3 },
      { name: "Warm Light", id: "krea2-warm-light", strength: -2 },
    ]);
  });

  it("refuses to save an unknown model, a LoRA for another model, more than 8 LoRAs, a strength out of range, or a filter-off LoRA with the filter on", async () => {
    await setup();
    await expect(save({ name: "A", model: "made-up-model" })).rejects.toThrow('Sogni has no picture model called "made-up-model". Pick one from the list.');
    await expect(save({ name: "A", model: "z_image_turbo_bf16", loras: [{ id: "krea2-detail-enhancer", strength: 1 }] })).rejects.toThrow(
      'The LoRA "Detail Enhancer" does not work with the model Z-Image Turbo. Pick LoRAs from the list for this model.',
    );
    await expect(
      save({ name: "A", model: "krea2_turbo_fp8_scaled", loras: Array.from({ length: 9 }, (_, i) => ({ id: `krea2-x${i}`, strength: 1 })) }),
    ).rejects.toThrow("A look can use at most 8 LoRAs; this has 9. Remove some.");
    await expect(save({ name: "A", model: "krea2_turbo_fp8_scaled", loras: [{ id: "krea2-warm-light", strength: 11 }] })).rejects.toThrow(
      'The strength of "Warm Light" must be between -10 and 10 (it is 11).',
    );
    await expect(save({ name: "A", model: "krea2_turbo_fp8_scaled", loras: [{ id: "krea2-realism-engine", strength: 0.8 }] })).rejects.toThrow(
      /only works with the Sensitive content filter off/,
    );
    await expect(save({ name: "A", model: DARK_BEAST_V9, guidance: 3 })).rejects.toThrow(/does not let you change guidance/);
    await expect(save({ name: "A", provider: "fal", loras: [{ id: "krea2-candid", strength: 3 }] })).rejects.toThrow(/are Sogni settings/);
    await expect(save({ name: "A", provider: "fal", safeContentFilter: false })).rejects.toThrow(/are Sogni settings/);
    // Only an owner/admin can save at all (and so turn the filter off).
    await expect(save({ name: "A", model: DARK_BEAST_V9, safeContentFilter: false }, member)).rejects.toThrow(
      "Only the company's owner or an admin can change looks.",
    );
    const agent = { actor: { type: "agent" as const, agentId: AGENT, canManageCompany: false }, companyId: COMPANY };
    await expect(save({ name: "A", model: DARK_BEAST_V9, safeContentFilter: false }, agent as any)).rejects.toThrow(/Only the company's owner/);
    expect(await harness.ctx.state.get(looksKey)).toBeNull();
  });

  it("never lets an agent turn the content filter off, and ignores a look marked off without the owner flag", async () => {
    await setup();
    await harness.ctx.state.set(looksKey, [
      { id: "l1", name: "Forged", style: "", model: DARK_BEAST_V9, provider: "sogni", seed: null, referenceFileIds: [], safeContentFilter: false, updatedAt: "x" },
    ]);
    await run({ prompt: "a sofa", safeContentFilter: false, safe_content_filter: false, contentFilter: "off" } as any);
    await run({ prompt: "a sofa", look: "Forged" });
    expect(starts(fake).map((call) => (call.body as any).safe_content_filter)).toEqual([true, true]);
  });

  it("a default look turns the filter off exactly as the same saved look does, and nothing more", async () => {
    await setup();
    await save({ name: "After dark", style: "moody", model: DARK_BEAST_V9, safeContentFilter: false });
    await save({ name: "Daylight", model: DARK_BEAST_V9 });
    const looks = (await harness.ctx.state.get(looksKey)) as Array<{ id: string; name: string }>;
    const afterDark = looks.find((l) => l.name === "After dark")!;
    const defaultsKey = { ...looksKey, stateKey: "lookDefaults" };
    const OTHER_AGENT = "34343434-3434-4343-8343-343434343434";

    // The saved-off look as this agent's default: the filter is off, as with look: "After dark".
    await harness.ctx.state.set(defaultsKey, { [AGENT]: afterDark.id });
    expect((await run({ prompt: "a sofa at night" })).data).toMatchObject({ look: "After dark", lookReason: "agent-default" });
    // A look named in the request wins, and its own filter setting (on) is what counts.
    expect((await run({ prompt: "a sofa in look daylight" })).data).toMatchObject({ look: "Daylight", lookReason: "named-in-request" });
    // Another agent's run does not get this agent's default; nothing it sends turns the filter off.
    const other = harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", safeContentFilter: false } as any, { ...runCtx, agentId: OTHER_AGENT });
    await vi.runAllTimersAsync();
    expect((await other).data.look).toBeNull();
    // A default pointing at a look marked off without the owner flag keeps the filter on.
    await harness.ctx.state.set(looksKey, [
      ...looks,
      { id: "forged", name: "Forged", style: "", model: DARK_BEAST_V9, provider: "sogni", seed: null, referenceFileIds: [], safeContentFilter: false, updatedAt: "x" },
    ]);
    await harness.ctx.state.set(defaultsKey, { [AGENT]: "forged" });
    expect((await run({ prompt: "a sofa" })).data).toMatchObject({ look: "Forged", lookReason: "agent-default" });

    expect(starts(fake).map((call) => (call.body as any).safe_content_filter)).toEqual([false, true, true, true]);
  });

  it("refuses an agent's model that is not in Sogni's catalog, before using up the day's limit", async () => {
    await setup();
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    const result = await run({ prompt: "a sofa", provider: "sogni", model: "not-a-sogni-model" });
    expect(result.error).toBe('Sogni has no picture model called "not-a-sogni-model". Leave out the model, or use a saved look.');
    expect(reserve).not.toHaveBeenCalled();
    expect(starts(fake)).toHaveLength(0);

    // Any catalog model works per call, by id or tool key.
    const ok = await run({ prompt: "a sofa", model: DARK_BEAST_V9 });
    expect(ok.error).toBeUndefined();
    expect((starts(fake)[0]!.body as any).input.steps[0].arguments.model).toBe("dark-beast-z-turbo");
    expect((starts(fake)[0]!.body as any).safe_content_filter).toBe(true);

    // A catalog model with no tool key picks Sogni even when settings say Fal.
    await setup({}, { ...FAL_CONFIG, sogniKeySecretRef: "sogni-key-ref" });
    const sdxl = await run({ prompt: "a sofa", model: "coreml-sogniXLturbo_alpha1_ad" });
    expect(sdxl.data.provider).toBe("sogni");
    expect((starts(fake)[0]!.body as any).input.steps[0].arguments.model).toBe("coreml-sogniXLturbo_alpha1_ad");
  });

  it("when Sogni's catalog cannot be reached, still uses a look's saved model and LoRAs, but refuses other models", async () => {
    await setup({ catalog: "down" });
    await harness.ctx.state.set(looksKey, [
      {
        id: "l1",
        name: "Catalogue",
        style: "",
        model: "krea2_turbo_fp8_scaled",
        provider: "sogni",
        seed: null,
        referenceFileIds: [],
        loras: [{ id: "krea2-detail-enhancer", name: "Detail Enhancer", strength: 3 }],
        updatedAt: "x",
      },
    ]);
    const viaLook = await run({ prompt: "a sofa", look: "Catalogue" });
    expect(viaLook.error).toBeUndefined();
    expect((starts(fake)[0]!.body as any).input.steps[0].arguments).toMatchObject({ model: "krea-2-turbo", loras: ["krea2-detail-enhancer"] });

    const other = await run({ prompt: "a sofa", model: DARK_BEAST_V9 });
    expect(other.error).toBe(
      `Sogni's list of models could not be reached just now, so the model "${DARK_BEAST_V9}" could not be checked. Try again in a minute, or use a saved look.`,
    );
    await expect(save({ name: "New", model: DARK_BEAST_V9 })).rejects.toThrow(
      "Sogni's list of models could not be reached just now, so the model could not be checked. Try again in a minute.",
    );
    const offline = await harness.performAction<any>("sogni.models", {}, member);
    expect(offline.live).toBe(false);
    expect(offline.note).toMatch(/only a few well-known models are shown/);
  });

  it("checks a look's LoRAs again before each picture: one that no longer fits its model is refused before spending", async () => {
    await setup();
    await harness.ctx.state.set(looksKey, [
      {
        id: "l1",
        name: "Stale",
        style: "",
        model: "krea2_turbo_fp8_scaled",
        provider: "sogni",
        seed: null,
        referenceFileIds: [],
        loras: [{ id: "krea2-warm-light", name: "Warm Light", strength: 40 }],
        updatedAt: "x",
      },
    ]);
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    const result = await run({ prompt: "a sofa", look: "Stale" });
    expect(result.error).toBe('The look "Stale" cannot be used as saved: The strength of "Warm Light" must be between -10 and 10 (it is 40).');
    expect(reserve).not.toHaveBeenCalled();
    expect(starts(fake)).toHaveLength(0);
  });

  it("leaves a look's LoRAs out, and says so, when the agent picks another model or the picture needs the editing model", async () => {
    await setup();
    await save({ name: "Catalogue", model: "krea2_turbo_fp8_scaled", loras: [{ id: "krea2-candid", strength: 4 }] });

    const otherModel = await run({ prompt: "a sofa", look: "Catalogue", model: "z-turbo" });
    expect(otherModel.content).toContain(`The look's LoRAs and model settings were left out, because this picture uses a different model than the look "Catalogue".`);
    expect((starts(fake)[0]!.body as any).input.steps[0].arguments.loras).toBeUndefined();

    // Naming the look's own model is still the look.
    const sameModel = await run({ prompt: "a sofa", look: "Catalogue", model: "krea-2-turbo" });
    expect(sameModel.content).not.toContain("left out");
    expect((starts(fake)[1]!.body as any).input.steps[0].arguments.loras).toEqual(["krea2-candid"]);

    const withRefs = await run({ prompt: "the same sofa", look: "Catalogue", referenceFileIds: [REF_A] });
    expect(withRefs.error).toBeUndefined();
    expect(withRefs.content).toContain("pictures made from reference pictures use Sogni's picture-editing model");
    const step = (starts(fake)[2]!.body as any).input.steps[0];
    expect(step).toMatchObject({ toolName: "edit_image", arguments: { model: "qwen-lightning" } });
    expect(step.arguments.loras).toBeUndefined();
  });

  it("an edit-model look applies its LoRAs to edit_image, and refuses to run without reference pictures", async () => {
    await setup();
    await save({
      name: "Same person",
      model: "krea2_identity_edit_v1_2",
      referenceFileIds: [REF_A],
      loras: [{ id: "krea2-candid", strength: 4 }],
    });
    const result = await run({ prompt: "in a garden", look: "Same person" });
    expect(result.error).toBeUndefined();
    const step = (starts(fake)[0]!.body as any).input.steps[0];
    expect(step).toMatchObject({ toolName: "edit_image", arguments: { model: "krea-identity-edit", loras: ["krea2-candid"], loraStrengths: [4] } });

    await save({ name: "Editor only", model: "qwen_image_edit_2511_fp8_lightning" });
    expect((await run({ prompt: "x", look: "Editor only" })).error).toBe(
      "Qwen Image Edit 2511 Lightning changes existing pictures, so it needs reference pictures. Add reference pictures (to the look or to this picture), or pick another model.",
    );
  });

  it("keeps an older look working: no LoRAs, filter on, model as saved", async () => {
    await setup();
    await harness.ctx.state.set(looksKey, [
      { id: "l1", name: "Old", style: "", model: "krea-2-turbo", provider: "sogni", seed: 5, referenceFileIds: [], updatedAt: "x" },
    ]);
    const looks = await harness.performAction<any>("looks.list", {}, member);
    expect(looks.looks[0]).toMatchObject({ loras: [], safeContentFilter: true, contentFilterOffBy: null, guidance: null });
    const result = await run({ prompt: "a sofa", look: "Old" });
    expect(result.error).toBeUndefined();
    expect((starts(fake)[0]!.body as any).input.steps[0].arguments).toMatchObject({ model: "krea-2-turbo", seed: 5 });
  });
});
