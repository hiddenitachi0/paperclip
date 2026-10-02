import { describe, expect, it } from "vitest";
import {
  LANE_A_MODELS,
  LANE_A_MODEL_CATALOGUE,
  LANE_A_PROVIDERS,
  LANE_A_MAX_TEMPERATURE,
  LANE_A_MIN_TEMPERATURE,
  LANE_A_PROVIDER_CATALOGUE,
  LANE_A_PROVIDER_ROUTING_MAX_ENTRIES,
  LANE_A_PROVIDER_SLUG_RE,
  LANE_A_TEMPERATURE_PRESETS,
  isLaneAModelForProvider,
  laneAProviderRoutingForCall,
  normalizeLaneAProviderRouting,
  parseLaneAProviderSlugList,
  laneAModelAcceptsTemperature,
  laneATemperatureForCall,
  laneAModelCostCents,
  laneAModelIssueForProvider,
  laneAProviderModelCostCents,
  laneATransformWorstCaseDailyCents,
  normalizeLaneAProvider,
  resolveLaneAModelForProvider,
} from "./lane-a-models.js";
import { QUICK_AGENT_FIELDS, createAgentSchema, laneAProviderModelIssue, updateAgentSchema } from "./validators/agent.js";

// DUR-3997: the per-provider catalogue. The Claude entries and prices must be
// what they were before this change (every existing quick agent has a null
// provider and keeps running on them), a model Paperclip has no price for is
// costed at 0 rather than silently at Sonnet's rate, and free-form model ids
// are accepted only where the provider is free-form.

describe("lane A provider catalogue", () => {
  it("keeps the three Claude entries and their prices exactly", () => {
    expect(LANE_A_MODEL_CATALOGUE).toEqual({
      "claude-haiku-4-5": { label: "Fast and cheap", inputUsdPerMillion: 1.0, outputUsdPerMillion: 5.0 },
      "claude-sonnet-5": { label: "Standard", inputUsdPerMillion: 2.0, outputUsdPerMillion: 10.0 },
      "claude-opus-5": { label: "Best quality", inputUsdPerMillion: 5.0, outputUsdPerMillion: 25.0 },
    });
    expect(LANE_A_PROVIDER_CATALOGUE.anthropic.models).toBe(LANE_A_MODEL_CATALOGUE);
    expect(LANE_A_MODELS).toEqual(["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"]);
    // One million input tokens on Sonnet is $2.00 = 200 cents, as before.
    expect(laneAModelCostCents("claude-sonnet-5", 1_000_000, 0)).toBe(200);
    expect(laneAModelCostCents("claude-haiku-4-5", 1_000_000, 1_000_000)).toBe(600);
    expect(laneAModelCostCents("claude-opus-5", 0, 1_000_000)).toBe(2500);
  });

  it("has every provider, each with a plain label", () => {
    expect(LANE_A_PROVIDERS).toEqual(["anthropic", "openai", "google", "openrouter", "local"]);
    for (const provider of LANE_A_PROVIDERS) {
      expect(LANE_A_PROVIDER_CATALOGUE[provider].label.length).toBeGreaterThan(0);
    }
    expect(normalizeLaneAProvider(null)).toBe("anthropic");
    expect(normalizeLaneAProvider(undefined)).toBe("anthropic");
    expect(normalizeLaneAProvider("nonsense")).toBe("anthropic");
    expect(normalizeLaneAProvider("openai")).toBe("openai");
  });

  it("prices OpenAI and Google models per provider, never at another model's rate", () => {
    expect(laneAProviderModelCostCents("openai", "gpt-4.1-mini", 2_000_000, 500_000)).toEqual({
      costCents: 160,
      priced: true,
    });
    expect(laneAProviderModelCostCents("google", "gemini-2.5-pro", 1_000_000, 0)).toEqual({
      costCents: 125,
      priced: true,
    });
    // A Claude model id under the OpenAI provider is not a priced OpenAI model.
    expect(laneAProviderModelCostCents("openai", "claude-sonnet-5", 1_000_000, 0)).toEqual({
      costCents: 0,
      priced: false,
    });
  });

  it("costs an unknown model at 0 and says so — no silent Sonnet fall-back", () => {
    expect(laneAProviderModelCostCents("anthropic", "claude-9-ultra", 1_000_000, 0)).toEqual({
      costCents: 0,
      priced: false,
    });
    expect(laneAModelCostCents("claude-9-ultra", 1_000_000, 0)).toBe(0);
    expect(laneAProviderModelCostCents("openrouter", "meta-llama/llama-3.3-70b-instruct", 1_000_000, 0)).toEqual({
      costCents: 0,
      priced: false,
    });
    // A local model is free by definition: priced, at 0.
    expect(laneAProviderModelCostCents("local", "llama3.1", 1_000_000, 0)).toEqual({ costCents: 0, priced: true });
  });

  // DUR-4353: this OpenRouter model id had no catalogue entry, so a quick
  // agent pointed at it (a real production setup, 2 Oct 2026) recorded every
  // call's cost as 0 — real spend read as free. Freeform acceptance (above)
  // and a priced catalogue entry are independent; this pins that a free-form
  // id Paperclip actually knows the price of is priced, not just accepted.
  it("prices a known free-form OpenRouter model instead of recording its spend as 0", () => {
    expect(
      laneAProviderModelCostCents("openrouter", "mistralai/mistral-small-3.2-24b-instruct", 1_000_000, 1_000_000),
    ).toEqual({ costCents: 28, priced: true }); // 7.5 + 20 cents, rounded to the nearest whole cent
  });

  it("accepts a model only for the provider it belongs to; free-form only for OpenRouter and local", () => {
    expect(laneAModelIssueForProvider("anthropic", "claude-sonnet-5")).toBeNull();
    expect(laneAModelIssueForProvider(null, "claude-sonnet-5")).toBeNull();
    expect(laneAModelIssueForProvider("openai", "gpt-4.1")).toBeNull();
    expect(laneAModelIssueForProvider("google", "gemini-2.5-flash")).toBeNull();
    expect(laneAModelIssueForProvider("openai", "claude-sonnet-5")).toMatch(/not a OpenAI model/);
    expect(laneAModelIssueForProvider("anthropic", "gpt-4.1")).toMatch(/not a Claude model/);
    expect(laneAModelIssueForProvider("openrouter", "meta-llama/llama-3.3-70b-instruct")).toBeNull();
    expect(laneAModelIssueForProvider("local", "qwen2.5:7b")).toBeNull();
    expect(laneAModelIssueForProvider("local", "")).toMatch(/Pick a model/);
    expect(laneAModelIssueForProvider("local", "bad model id")).toMatch(/does not look like a model id/);
    expect(laneAModelIssueForProvider("openrouter", "x".repeat(201))).toMatch(/too long/);
    expect(isLaneAModelForProvider("openai", "o4-mini")).toBe(true);
    expect(isLaneAModelForProvider("openai", "o4-mini-nope")).toBe(false);
  });

  it("resolves the model a call runs on: the agent's own if it fits, else the provider default, else null", () => {
    expect(resolveLaneAModelForProvider(null, null)).toBe("claude-sonnet-5");
    expect(resolveLaneAModelForProvider("anthropic", "claude-haiku-4-5")).toBe("claude-haiku-4-5");
    // A model left over from another provider falls back to the new provider's default.
    expect(resolveLaneAModelForProvider("openai", "claude-haiku-4-5")).toBe("gpt-4.1-mini");
    expect(resolveLaneAModelForProvider("google", null)).toBe("gemini-2.5-flash");
    expect(resolveLaneAModelForProvider("openrouter", null)).toBeNull();
    expect(resolveLaneAModelForProvider("openrouter", "openai/gpt-4.1-mini")).toBe("openai/gpt-4.1-mini");
    expect(resolveLaneAModelForProvider("local", null)).toBeNull();
  });

  it("estimates the worst day per provider, and 0 when the price is unknown", () => {
    const claude = laneATransformWorstCaseDailyCents({ model: null, maxOutputTokens: null, dailyCallCap: null });
    expect(claude).toBeGreaterThan(0);
    expect(laneATransformWorstCaseDailyCents({ provider: "anthropic", model: "claude-sonnet-5" })).toBe(claude);
    const openai = laneATransformWorstCaseDailyCents({ provider: "openai", model: "gpt-4.1-mini" });
    expect(openai).toBeGreaterThan(0);
    expect(openai).toBeLessThan(claude);
    expect(laneATransformWorstCaseDailyCents({ provider: "openrouter", model: "vendor/model" })).toBe(0);
    expect(laneATransformWorstCaseDailyCents({ provider: "local", model: "llama3.1" })).toBe(0);
  });
});

describe("quick-agent validators (DUR-3997)", () => {
  const base = { name: "Front desk", adapterType: "claude_local" as const };

  it("lists the provider and address among the quick-agent fields", () => {
    expect(QUICK_AGENT_FIELDS).toContain("laneAProvider");
    expect(QUICK_AGENT_FIELDS).toContain("laneABaseUrl");
  });

  it("accepts a model that fits the provider and refuses one that does not", () => {
    expect(createAgentSchema.safeParse({ ...base, laneAModel: "claude-haiku-4-5" }).success).toBe(true);
    expect(createAgentSchema.safeParse({ ...base, laneAProvider: "openai", laneAModel: "gpt-4.1" }).success).toBe(true);
    expect(
      createAgentSchema.safeParse({ ...base, laneAProvider: "openrouter", laneAModel: "openai/gpt-4.1-mini" }).success,
    ).toBe(true);
    const wrong = createAgentSchema.safeParse({ ...base, laneAProvider: "openai", laneAModel: "claude-haiku-4-5" });
    expect(wrong.success).toBe(false);
    // Missing provider means Claude, so an OpenAI id alone is refused too.
    expect(createAgentSchema.safeParse({ ...base, laneAModel: "gpt-4.1" }).success).toBe(false);
    expect(createAgentSchema.safeParse({ ...base, laneAProvider: "nonsense" }).success).toBe(false);
    expect(laneAProviderModelIssue({ laneAProvider: null, laneAModel: null })).toBeNull();
  });

  it("takes only a full http(s) address", () => {
    expect(createAgentSchema.safeParse({ ...base, laneABaseUrl: "http://localhost:11434/v1" }).success).toBe(true);
    expect(createAgentSchema.safeParse({ ...base, laneABaseUrl: null }).success).toBe(true);
    expect(createAgentSchema.safeParse({ ...base, laneABaseUrl: "localhost:11434" }).success).toBe(false);
    expect(createAgentSchema.safeParse({ ...base, laneABaseUrl: "ftp://x/v1" }).success).toBe(false);
  });

  it("refuses a pasted key at adapterConfig.laneA.apiKey and accepts a saved-secret reference", () => {
    const secretId = "5b1f2f7e-3d2a-4c9e-9a4b-7c1d2e3f4a5b";
    expect(
      createAgentSchema.safeParse({
        ...base,
        adapterConfig: { laneA: { apiKey: { type: "secret_ref", secretId, version: "latest" } } },
      }).success,
    ).toBe(true);
    expect(createAgentSchema.safeParse({ ...base, adapterConfig: { laneA: { apiKey: null } } }).success).toBe(true);
    const pasted = createAgentSchema.safeParse({ ...base, adapterConfig: { laneA: { apiKey: "sk-live-abcdef" } } });
    expect(pasted.success).toBe(false);
    if (!pasted.success) {
      expect(pasted.error.issues.map((issue) => issue.message).join(" ")).toMatch(/cannot be typed in here/);
    }
    expect(
      createAgentSchema.safeParse({ ...base, adapterConfig: { laneA: { apiKey: { type: "plain", value: "x" } } } })
        .success,
    ).toBe(false);
  });
});

describe("quick-agent creativity (sampling temperature)", () => {
  const base = { name: "Front desk", adapterType: "claude_local" as const };

  it("is a board-only quick-agent field", () => {
    expect(QUICK_AGENT_FIELDS).toContain("laneATemperature");
  });

  it("accepts 0-1.5 and null (model default) on create and on PATCH", () => {
    for (const value of [0, 0.2, 0.6, 0.9, 1.2, 1.5, null]) {
      expect(createAgentSchema.safeParse({ ...base, laneATemperature: value }).success, String(value)).toBe(true);
      expect(updateAgentSchema.safeParse({ laneATemperature: value }).success, String(value)).toBe(true);
    }
    // Left out entirely: nothing is changed.
    expect(updateAgentSchema.parse({})).not.toHaveProperty("laneATemperature");
  });

  it("refuses anything outside 0-1.5, and anything that is not a number", () => {
    for (const value of [-0.1, 1.51, 2, Number.POSITIVE_INFINITY, Number.NaN, "0.9", true]) {
      expect(createAgentSchema.safeParse({ ...base, laneATemperature: value }).success, String(value)).toBe(false);
      expect(updateAgentSchema.safeParse({ laneATemperature: value }).success, String(value)).toBe(false);
    }
    const tooHigh = updateAgentSchema.safeParse({ laneATemperature: 2 });
    expect(tooHigh.success).toBe(false);
    expect(JSON.stringify(tooHigh.error?.issues)).toContain("Creativity must be between 0 and 1.5.");
  });

  it("offers four plain-language steps, all inside the stored range", () => {
    expect(LANE_A_TEMPERATURE_PRESETS.map((p) => p.label)).toEqual(["Precise", "Balanced", "Lively", "Very lively"]);
    for (const preset of LANE_A_TEMPERATURE_PRESETS) {
      expect(preset.value).toBeGreaterThanOrEqual(LANE_A_MIN_TEMPERATURE);
      expect(preset.value).toBeLessThanOrEqual(LANE_A_MAX_TEMPERATURE);
    }
  });

  it("knows which models take a temperature: Claude Haiku yes, Sonnet 5 / Opus 5 no, OpenAI reasoning models no", () => {
    expect(laneAModelAcceptsTemperature("anthropic", "claude-haiku-4-5")).toBe(true);
    // Null provider/model = Claude on the default model (Sonnet 5).
    expect(laneAModelAcceptsTemperature(null, null)).toBe(false);
    expect(laneAModelAcceptsTemperature("anthropic", "claude-sonnet-5")).toBe(false);
    expect(laneAModelAcceptsTemperature("anthropic", "claude-opus-5")).toBe(false);
    expect(laneAModelAcceptsTemperature("openai", "gpt-4.1-mini")).toBe(true);
    expect(laneAModelAcceptsTemperature("openai", "o4-mini")).toBe(false);
    expect(laneAModelAcceptsTemperature("google", "gemini-2.5-flash")).toBe(true);
    expect(laneAModelAcceptsTemperature("openrouter", "mistralai/mistral-small-3.2-24b-instruct")).toBe(true);
    expect(laneAModelAcceptsTemperature("local", "llama3.1")).toBe(true);
  });

  it("resolves the value a call is made with: clamped for Claude, dropped where refused or invalid", () => {
    expect(laneATemperatureForCall("openrouter", "mistralai/mistral-small-3.2-24b-instruct", 1.2)).toBe(1.2);
    expect(laneATemperatureForCall("openrouter", "x/y", null)).toBeNull();
    expect(laneATemperatureForCall("openrouter", "x/y", undefined)).toBeNull();
    expect(laneATemperatureForCall("openrouter", "x/y", 0)).toBe(0);
    expect(laneATemperatureForCall("anthropic", "claude-haiku-4-5", 1.2)).toBe(1);
    expect(laneATemperatureForCall("anthropic", "claude-haiku-4-5", 0.6)).toBe(0.6);
    expect(laneATemperatureForCall("anthropic", "claude-sonnet-5", 0.6)).toBeNull();
    expect(laneATemperatureForCall("openai", "o4-mini", 0.6)).toBeNull();
    // A value that somehow got past validation is never forwarded.
    expect(laneATemperatureForCall("local", "llama3.1", 3)).toBeNull();
    expect(laneATemperatureForCall("local", "llama3.1", -1)).toBeNull();
    expect(laneATemperatureForCall("local", "llama3.1", Number.NaN)).toBeNull();
  });
});

describe("quick-agent model hosts (OpenRouter provider routing)", () => {
  const base = { name: "Front desk", adapterType: "claude_local" as const };

  it("is a board-only quick-agent field", () => {
    expect(QUICK_AGENT_FIELDS).toContain("laneAProviderRouting");
  });

  it("accepts host lists, the fallback switch and null on create and on PATCH, lower-casing the hosts", () => {
    const routing = { only: [" DeepInfra "], order: ["deepinfra", "mistral"], ignore: ["venice"], allowFallbacks: false };
    expect(createAgentSchema.parse({ ...base, laneAProviderRouting: routing }).laneAProviderRouting).toEqual({
      only: ["deepinfra"],
      order: ["deepinfra", "mistral"],
      ignore: ["venice"],
      allowFallbacks: false,
    });
    expect(updateAgentSchema.parse({ laneAProviderRouting: { only: ["deepinfra"] } }).laneAProviderRouting).toEqual({
      only: ["deepinfra"],
    });
    expect(updateAgentSchema.safeParse({ laneAProviderRouting: null }).success).toBe(true);
    expect(updateAgentSchema.parse({})).not.toHaveProperty("laneAProviderRouting");
  });

  it("refuses hosts that are not a slug, too many hosts, and unknown keys", () => {
    for (const value of [
      { only: ["deep infra"] },
      { only: ["-deepinfra"] },
      { only: [""] },
      { only: ["a".repeat(65)] },
      { ignore: Array.from({ length: LANE_A_PROVIDER_ROUTING_MAX_ENTRIES + 1 }, (_, i) => `host${i}`) },
      { only: "deepinfra" },
      { allowFallbacks: "no" },
      { sort: "price" },
      ["deepinfra"],
    ]) {
      expect(updateAgentSchema.safeParse({ laneAProviderRouting: value }).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("cleans a stored value defensively: bad entries dropped, duplicates removed, nothing left = null", () => {
    expect(normalizeLaneAProviderRouting(null)).toBeNull();
    expect(normalizeLaneAProviderRouting({})).toBeNull();
    expect(normalizeLaneAProviderRouting({ only: [] })).toBeNull();
    expect(normalizeLaneAProviderRouting("deepinfra")).toBeNull();
    expect(
      normalizeLaneAProviderRouting({
        only: ["DeepInfra", "deepinfra", "not a host", 7],
        ignore: ["venice"],
        allowFallbacks: true,
      }),
    ).toEqual({ only: ["deepinfra"], ignore: ["venice"], allowFallbacks: true });
    expect(LANE_A_PROVIDER_SLUG_RE.test("deepinfra")).toBe(true);
    expect(LANE_A_PROVIDER_SLUG_RE.test("DeepInfra")).toBe(false);
  });

  it("applies only to OpenRouter", () => {
    const routing = { only: ["deepinfra"] };
    expect(laneAProviderRoutingForCall("openrouter", routing)).toEqual(routing);
    for (const provider of [null, "anthropic", "openai", "google", "local"]) {
      expect(laneAProviderRoutingForCall(provider, routing), String(provider)).toBeNull();
    }
  });

  it("splits what an operator typed into hosts, and names what it did not understand", () => {
    expect(parseLaneAProviderSlugList("DeepInfra, mistral,,  venice")).toEqual({
      slugs: ["deepinfra", "mistral", "venice"],
      invalid: [],
    });
    expect(parseLaneAProviderSlugList("")).toEqual({ slugs: [], invalid: [] });
    expect(parseLaneAProviderSlugList("deepinfra, deepinfra")).toEqual({ slugs: ["deepinfra"], invalid: [] });
    expect(parseLaneAProviderSlugList("deepinfra, Infra!")).toEqual({ slugs: ["deepinfra"], invalid: ["Infra!"] });
  });
});
