import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHuggingFaceModelId, splitHuggingFaceModelId } from "@paperclipai/shared";
import {
  filterHuggingFaceModels,
  getHuggingFaceCatalogue,
  huggingFacePricingForModelId,
  parseHuggingFaceModels,
  resetHuggingFaceCatalogueCache,
  primeHuggingFaceCatalogueCache,
  validateHuggingFaceToken,
} from "../services/huggingface-catalogue.js";
import { computeCostCents } from "../services/lane-a.js";
import { probeSecretKind } from "../services/secret-kind-probes.js";
import { buildOpenAiCompatibleBody } from "../services/lane-a-providers.js";

const BODY = {
  object: "list",
  data: [
    {
      id: "Qwen/Qwen3-14B",
      providers: [
        { provider: "deepinfra", status: "live", context_length: 40960, pricing: { input: 0.06, output: 0.24 }, supports_tools: true, supports_structured_output: true, throughput: 50, first_token_latency_ms: 300 },
        { provider: "novita", status: "live", context_length: 32768, pricing: { input: 0.1, output: 0.4 }, supports_tools: false, throughput: 120 },
        { provider: "dead", status: "offline", pricing: { input: 0.01, output: 0.01 }, supports_tools: true },
      ],
    },
    { id: "no/providers" },
    { nope: true },
  ],
};

const TOKEN = "hf_abcdefghijklmnopqrstuvwxyz0123";
const ok = (body: unknown = BODY) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

afterEach(() => resetHuggingFaceCatalogueCache());

describe("model id builder", () => {
  it("builds plain, explicit-provider and policy ids", () => {
    expect(buildHuggingFaceModelId("Qwen/Qwen3-14B")).toBe("Qwen/Qwen3-14B");
    expect(buildHuggingFaceModelId("Qwen/Qwen3-14B", "deepinfra")).toBe("Qwen/Qwen3-14B:deepinfra");
    for (const p of ["cheapest", "fastest", "preferred"]) {
      expect(buildHuggingFaceModelId("Qwen/Qwen3-14B", p)).toBe(`Qwen/Qwen3-14B:${p}`);
    }
  });
  it("replaces an existing suffix instead of doubling it", () => {
    expect(buildHuggingFaceModelId("Qwen/Qwen3-14B:novita", "fastest")).toBe("Qwen/Qwen3-14B:fastest");
    expect(splitHuggingFaceModelId("Qwen/Qwen3-14B:deepinfra")).toEqual({ model: "Qwen/Qwen3-14B", suffix: "deepinfra" });
    expect(splitHuggingFaceModelId("Qwen/Qwen3-14B")).toEqual({ model: "Qwen/Qwen3-14B", suffix: null });
  });
});

describe("catalogue parsing and filtering", () => {
  it("normalises providers and drops malformed rows", () => {
    const models = parseHuggingFaceModels(BODY);
    expect(models.map((m) => m.id)).toEqual(["Qwen/Qwen3-14B", "no/providers"]);
    expect(models[0]!.providers[0]).toEqual({
      provider: "deepinfra", status: "live", supportsTools: true, supportsStructuredOutput: true,
      contextLength: 40960, inputUsdPerMillion: 0.06, outputUsdPerMillion: 0.24, firstTokenLatencyMs: 300, throughput: 50,
    });
    expect(parseHuggingFaceModels(null)).toEqual([]);
  });
  it("filters to tool-capable and live hosts, dropping models left with none", () => {
    const models = parseHuggingFaceModels(BODY);
    const tools = filterHuggingFaceModels(models, { toolsOnly: true });
    expect(tools).toHaveLength(1);
    expect(tools[0]!.providers.map((p) => p.provider)).toEqual(["deepinfra", "dead"]);
    const live = filterHuggingFaceModels(models, { toolsOnly: true, liveOnly: true });
    expect(live[0]!.providers.map((p) => p.provider)).toEqual(["deepinfra"]);
  });
});

describe("token validation", () => {
  it("accepts a good token and sends it only as a bearer to the router", async () => {
    const fetchImpl = ok();
    expect(await validateHuggingFaceToken(TOKEN, { fetchImpl })).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://router.huggingface.co/v1/models");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });
  it("rejects a 401 with a plain sentence that never contains the token", async () => {
    const fetchImpl = vi.fn(async () => new Response(`bad ${TOKEN}`, { status: 401 }));
    const v = await validateHuggingFaceToken(TOKEN, { fetchImpl });
    expect(v).toMatchObject({ ok: false, reason: "rejected" });
    expect(JSON.stringify(v)).not.toContain(TOKEN);
  });
  it("reports network failure distinctly", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`ECONNREFUSED ${TOKEN}`); });
    const v = await validateHuggingFaceToken(TOKEN, { fetchImpl });
    expect(v).toMatchObject({ ok: false, reason: "unreachable" });
    expect((v as { message: string }).message).toMatch(/Couldn't reach Hugging Face/);
    expect(JSON.stringify(v)).not.toContain(TOKEN);
  });
  it("backs the Test button too", async () => {
    const res = await probeSecretKind("huggingface_api_key", TOKEN, { fetchImpl: ok() });
    expect(res.ok).toBe(true);
  });
});

describe("cache", () => {
  it("fetches once within the hour and again after it", async () => {
    const fetchImpl = ok();
    let now = 1_000;
    await getHuggingFaceCatalogue(TOKEN, { fetchImpl, now: () => now });
    await getHuggingFaceCatalogue(TOKEN, { fetchImpl, now: () => now + 59 * 60_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 61 * 60_000;
    await getHuggingFaceCatalogue(TOKEN, { fetchImpl, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("pricing and cost", () => {
  const models = parseHuggingFaceModels(BODY);
  it("prices explicit hosts and policies", () => {
    expect(huggingFacePricingForModelId(models, "Qwen/Qwen3-14B:novita")).toEqual({ inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 });
    expect(huggingFacePricingForModelId(models, "Qwen/Qwen3-14B:cheapest")).toEqual({ inputUsdPerMillion: 0.06, outputUsdPerMillion: 0.24 });
    expect(huggingFacePricingForModelId(models, "Qwen/Qwen3-14B:fastest")).toEqual({ inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 });
    expect(huggingFacePricingForModelId(models, "Qwen/Qwen3-14B:preferred")).toEqual({ inputUsdPerMillion: 0.06, outputUsdPerMillion: 0.24 });
    expect(huggingFacePricingForModelId(models, "Qwen/Qwen3-14B:nobody")).toBeNull();
    expect(huggingFacePricingForModelId(models, "unknown/model")).toBeNull();
  });
  it("bills Lane A calls at the fetched price, and 0 when unpriced", () => {
    primeHuggingFaceCatalogueCache(models);
    // 10M in * $0.06 + 5M out * $0.24 = $1.80 = 180 cents
    expect(computeCostCents("huggingface", "Qwen/Qwen3-14B:deepinfra", 10_000_000, 5_000_000)).toBe(180);
    expect(computeCostCents("huggingface", "unknown/model", 10_000_000, 5_000_000)).toBe(0);
  });
});

describe("request body", () => {
  it("sends no OpenRouter routing field and no reasoning_effort", () => {
    const body = buildOpenAiCompatibleBody("huggingface", {
      model: "Qwen/Qwen3-14B:fastest", system: "s", messages: [], maxTokens: 100,
      tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    } as never);
    expect(body.provider).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBe(100);
  });
});
