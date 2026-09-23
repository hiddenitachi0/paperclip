import { describe, expect, it } from "vitest";
import {
  LANE_A_MODELS,
  LANE_A_MODEL_CATALOGUE,
  LANE_A_PROVIDERS,
  LANE_A_PROVIDER_CATALOGUE,
  isLaneAModelForProvider,
  laneAModelCostCents,
  laneAModelIssueForProvider,
  laneAProviderModelCostCents,
  laneATransformWorstCaseDailyCents,
  normalizeLaneAProvider,
  resolveLaneAModelForProvider,
} from "./lane-a-models.js";
import { QUICK_AGENT_FIELDS, createAgentSchema, laneAProviderModelIssue } from "./validators/agent.js";

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
