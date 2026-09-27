import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../../../packages/plugins/media-studio/src/worker.js";
import manifest, { TOOL_GENERATE } from "../../../packages/plugins/media-studio/src/manifest.js";
import { SogniProvider, assertSogniStorageUrl } from "../../../packages/plugins/media-studio/src/sogni.js";

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

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

interface FakeSogniOptions {
  /** Status answers for each GET of the workflow, in order (the last repeats). */
  statuses?: Array<string | { status: number; headers?: Record<string, string>; body?: unknown }>;
  /** Answers for the start, in order (the last repeats). Default: 201 with the workflow id. */
  starts?: Array<{ status: number; headers?: Record<string, string>; body?: unknown }>;
  artifact?: Record<string, unknown>;
  waitingReason?: string;
  stepError?: string;
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
    expect(saved.looks[0]).toMatchObject({ name: "A", provider: "sogni", model: "z-turbo" });
    const listed = await harness.executeTool<any>("list-looks", {}, runCtx);
    expect(listed.content).toContain("- A (made with Sogni; model z-turbo)");
  });
});
