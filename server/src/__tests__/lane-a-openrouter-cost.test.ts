import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromOpenAiCompletion } from "../services/lane-a-providers.js";
import {
  resetOpenRouterCatalogueCacheForTests,
  openRouterCataloguePrice,
} from "../services/lane-a-openrouter-catalogue.js";
import { priceLaneACall } from "../services/lane-a.js";

const body = (usage: Record<string, unknown>) => ({
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1000, completion_tokens: 500, ...usage },
});

const modelsResponse = (pricing: Record<string, string>) =>
  new Response(JSON.stringify({ data: [{ id: "new/model-x", pricing }] }), { status: 200 });

describe("OpenRouter usage.cost parsing", () => {
  it("reads usage.cost for openrouter", () => {
    expect(fromOpenAiCompletion(body({ cost: 0.000123 }), "openrouter").usage.costUsd).toBe(0.000123);
  });
  it("keeps zero as a real cost", () => {
    expect(fromOpenAiCompletion(body({ cost: 0 }), "openrouter").usage.costUsd).toBe(0);
  });
  it("is null when cost is missing", () => {
    expect(fromOpenAiCompletion(body({}), "openrouter").usage.costUsd).toBeNull();
  });
  it("falls back to upstream_inference_cost when cost is absent", () => {
    expect(
      fromOpenAiCompletion(body({ cost_details: { upstream_inference_cost: 0.5 } }), "openrouter").usage.costUsd,
    ).toBe(0.5);
  });
  it("ignores cost from other providers", () => {
    expect(fromOpenAiCompletion(body({ cost: 9 }), "openai").usage.costUsd).toBeUndefined();
  });
});

describe("priceLaneACall", () => {
  beforeEach(() => resetOpenRouterCatalogueCacheForTests());

  it("uses the provider's cost, sub-cent exact", async () => {
    const fetchImpl = vi.fn();
    const r = await priceLaneACall({
      provider: "openrouter", model: "a/b", inputTokens: 10, outputTokens: 10, providerCostUsd: 0.000123, fetchImpl,
    });
    expect(r).toEqual({ costCents: 0, costMicroUsd: 123, costSource: "provider" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records provider zero as provider, not a fallback", async () => {
    const fetchImpl = vi.fn();
    const r = await priceLaneACall({ provider: "openrouter", model: "a/b", inputTokens: 1, outputTokens: 1, providerCostUsd: 0, fetchImpl });
    expect(r).toEqual({ costCents: 0, costMicroUsd: 0, costSource: "provider" });
  });

  it("prices an unknown model from the public catalogue, without credentials", async () => {
    const fetchImpl = vi.fn(async () => modelsResponse({ prompt: "0.000001", completion: "0.000002" }));
    const r = await priceLaneACall({
      provider: "openrouter", model: "new/model-x", inputTokens: 1000, outputTokens: 500, providerCostUsd: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ costCents: 0, costMicroUsd: 2000, costSource: "catalogue" });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|bearer/i);
  });

  it("caches the catalogue for a day", async () => {
    const fetchImpl = vi.fn(async () => modelsResponse({ prompt: "0.000001", completion: "0.000001" }));
    const f = fetchImpl as unknown as typeof fetch;
    await openRouterCataloguePrice("new/model-x", { fetchImpl: f, now: 1_000 });
    await openRouterCataloguePrice("new/model-x", { fetchImpl: f, now: 2_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls to the static table when the catalogue is unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const r = await priceLaneACall({
      provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct", inputTokens: 1_000_000, outputTokens: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.costSource).toBe("static_table");
    expect(r.costMicroUsd).toBe(r.costCents * 10_000);
  });

  it("uses the static table for non-openrouter providers without fetching", async () => {
    const fetchImpl = vi.fn();
    const r = await priceLaneACall({ provider: "openai", model: "gpt-4.1-mini", inputTokens: 2_000_000, outputTokens: 500_000, fetchImpl });
    expect(r.costSource).toBe("static_table");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
