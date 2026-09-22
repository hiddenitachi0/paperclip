/**
 * The models a quick agent (Lane A) may be pointed at, and what each one
 * costs. DUR-3977 made the model a per-agent setting, which means two things
 * that used to be hard-coded now have to move together:
 *
 *   1. which model ids are accepted, and
 *   2. what price the cost line is computed at.
 *
 * They are the same object here on purpose. Before this, `computeCostCents`
 * in server/src/services/lane-a.ts priced every call at Sonnet's rate because
 * Sonnet was the only model that could ever run — with a per-agent model that
 * would silently under- or over-bill the company as soon as an operator
 * picked something else, and the monthly budget in acceptance item 4 is
 * computed from exactly that number.
 *
 * DUR-3997 (Connections, slice 2): the catalogue is now per PROVIDER. A quick
 * agent picks a provider (Claude, OpenAI, Google, OpenRouter, a local model)
 * and a stored key for it; the Claude entries below are unchanged so every
 * quick agent that existed before this keeps its model and its price. Prices
 * are list prices in US dollars per million tokens.
 */

export const LANE_A_PROVIDERS = ["anthropic", "openai", "google", "openrouter", "local"] as const;
export type LaneAProvider = (typeof LANE_A_PROVIDERS)[number];

/** What a quick agent uses when the operator has not picked a provider (= today's behaviour). */
export const LANE_A_DEFAULT_PROVIDER: LaneAProvider = "anthropic";

/**
 * Where the per-agent provider key is bound inside adapter_config:
 * `adapterConfig.laneA.apiKey = { type: "secret_ref", secretId, version }`.
 * The binding row (company_secret_bindings) uses this same path, so the
 * server can resolve the key binding-gated and audited exactly like an MCP
 * server credential. Never a plain string: the validator refuses a literal.
 */
export const LANE_A_API_KEY_CONFIG_PATH = "laneA.apiKey";

export const LANE_A_FREE_FORM_MODEL_MAX_LENGTH = 200;
export const LANE_A_BASE_URL_MAX_LENGTH = 500;
/** Free-form model ids (OpenRouter, local): vendor/name, dots, dashes, colons. */
export const LANE_A_FREE_FORM_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export interface LaneAModelPricing {
  label: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface LaneAProviderDescriptor {
  /** Plain-English name shown to the operator. */
  label: string;
  /** Whether the operator may type any model id (OpenRouter, local) instead of picking one. */
  freeForm: boolean;
  /** The model used when the agent has none set, or none that fits this provider. Null = operator must pick. */
  defaultModel: string | null;
  /** The OpenAI-compatible endpoint used when the agent sets no base URL. Null = the agent must set one. */
  defaultBaseUrl: string | null;
  /** Whether the operator may (or must) set a base URL for this provider. */
  baseUrlEditable: boolean;
  /** Priced, pickable models. Empty for free-form providers. */
  models: Record<string, LaneAModelPricing>;
}

/**
 * The three Claude entries and their prices are byte-for-byte the pre-DUR-3997
 * catalogue: existing quick agents (all of which have a null provider) must
 * keep both the model they run on and the price their cost rows are computed
 * at.
 */
export const LANE_A_MODEL_CATALOGUE = {
  "claude-haiku-4-5": {
    label: "Rask og billig",
    inputUsdPerMillion: 1.0,
    outputUsdPerMillion: 5.0,
  },
  "claude-sonnet-5": {
    label: "Standard",
    inputUsdPerMillion: 2.0,
    outputUsdPerMillion: 10.0,
  },
  "claude-opus-5": {
    label: "Best kvalitet",
    inputUsdPerMillion: 5.0,
    outputUsdPerMillion: 25.0,
  },
} as const satisfies Record<string, LaneAModelPricing>;

export type LaneAModel = keyof typeof LANE_A_MODEL_CATALOGUE;

export const LANE_A_PROVIDER_CATALOGUE: Record<LaneAProvider, LaneAProviderDescriptor> = {
  anthropic: {
    label: "Claude",
    freeForm: false,
    defaultModel: "claude-sonnet-5",
    defaultBaseUrl: null,
    baseUrlEditable: false,
    models: LANE_A_MODEL_CATALOGUE,
  },
  openai: {
    label: "OpenAI",
    freeForm: false,
    defaultModel: "gpt-4.1-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    baseUrlEditable: false,
    models: {
      "gpt-4.1-mini": { label: "Rask og billig", inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 },
      "gpt-4.1": { label: "Standard", inputUsdPerMillion: 2.0, outputUsdPerMillion: 8.0 },
      "o4-mini": { label: "Resonnering", inputUsdPerMillion: 1.1, outputUsdPerMillion: 4.4 },
    },
  },
  google: {
    label: "Google",
    freeForm: false,
    defaultModel: "gemini-2.5-flash",
    // Google's OpenAI-compatible endpoint, so one client shape covers it.
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    baseUrlEditable: false,
    models: {
      "gemini-2.5-flash": { label: "Rask og billig", inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 },
      "gemini-2.5-pro": { label: "Best kvalitet", inputUsdPerMillion: 1.25, outputUsdPerMillion: 10.0 },
    },
  },
  openrouter: {
    label: "OpenRouter",
    freeForm: true,
    defaultModel: null,
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    baseUrlEditable: true,
    models: {},
  },
  local: {
    label: "Local model",
    freeForm: true,
    defaultModel: null,
    defaultBaseUrl: null,
    baseUrlEditable: true,
    models: {},
  },
};

export function isLaneAProvider(value: unknown): value is LaneAProvider {
  return typeof value === "string" && (LANE_A_PROVIDERS as readonly string[]).includes(value);
}

/** Null, undefined and anything unknown all mean "Claude via Paperclip's own key" — today's behaviour. */
export function normalizeLaneAProvider(value: unknown): LaneAProvider {
  return isLaneAProvider(value) ? value : LANE_A_DEFAULT_PROVIDER;
}

export function laneAProviderLabel(provider: unknown): string {
  return LANE_A_PROVIDER_CATALOGUE[normalizeLaneAProvider(provider)].label;
}

/** The pickable model ids for a provider (empty for free-form providers). */
export function laneAModelsForProvider(provider: unknown): string[] {
  return Object.keys(LANE_A_PROVIDER_CATALOGUE[normalizeLaneAProvider(provider)].models);
}

/**
 * Why a model id cannot be used with a provider, in plain words, or null when
 * it can. Free-form ids are accepted only where the provider is free-form.
 */
export function laneAModelIssueForProvider(provider: unknown, model: unknown): string | null {
  const key = normalizeLaneAProvider(provider);
  const descriptor = LANE_A_PROVIDER_CATALOGUE[key];
  if (typeof model !== "string" || model.trim().length === 0) {
    return `Pick a model for ${descriptor.label}.`;
  }
  if (Object.hasOwn(descriptor.models, model)) return null;
  if (!descriptor.freeForm) {
    return `"${model}" is not a ${descriptor.label} model Paperclip knows. Pick one of: ${Object.keys(descriptor.models).join(", ")}.`;
  }
  if (model.length > LANE_A_FREE_FORM_MODEL_MAX_LENGTH) {
    return `The model id is too long (max ${LANE_A_FREE_FORM_MODEL_MAX_LENGTH} characters).`;
  }
  if (!LANE_A_FREE_FORM_MODEL_RE.test(model)) {
    return `"${model}" does not look like a model id (letters, digits, dots, dashes, colons and slashes only).`;
  }
  return null;
}

export function isLaneAModelForProvider(provider: unknown, model: unknown): model is string {
  return laneAModelIssueForProvider(provider, model) === null;
}

/**
 * The model a quick agent actually runs on: its own when that fits the
 * provider, else the provider default, else null (free-form provider with
 * nothing picked — the server refuses the call and says so).
 */
export function resolveLaneAModelForProvider(provider: unknown, model: unknown): string | null {
  if (isLaneAModelForProvider(provider, model)) return model;
  return LANE_A_PROVIDER_CATALOGUE[normalizeLaneAProvider(provider)].defaultModel;
}

/** The price line for a model on a provider, or null when Paperclip knows none. */
export function laneAModelPricing(provider: unknown, model: unknown): LaneAModelPricing | null {
  if (typeof model !== "string") return null;
  const descriptor = LANE_A_PROVIDER_CATALOGUE[normalizeLaneAProvider(provider)];
  return Object.hasOwn(descriptor.models, model) ? descriptor.models[model]! : null;
}

/**
 * Derived from the catalogue rather than written out again, so the accepted
 * ids and the priced ids cannot drift apart — the exact failure mode this
 * week keeps producing when two lists have to agree and nothing enforces it.
 */
export const LANE_A_MODELS = Object.keys(LANE_A_MODEL_CATALOGUE) as [LaneAModel, ...LaneAModel[]];

/** What a quick agent uses when the operator has not picked a model. */
export const LANE_A_DEFAULT_MODEL: LaneAModel = "claude-sonnet-5";

export function isLaneAModel(value: unknown): value is LaneAModel {
  return typeof value === "string" && Object.hasOwn(LANE_A_MODEL_CATALOGUE, value);
}

function costCentsAt(pricing: LaneAModelPricing, inputTokens: number, outputTokens: number): number {
  const usd =
    (Math.max(0, inputTokens) / 1_000_000) * pricing.inputUsdPerMillion +
    (Math.max(0, outputTokens) / 1_000_000) * pricing.outputUsdPerMillion;
  return Math.max(0, Math.round(usd * 100));
}

/**
 * Cost in whole cents for one Lane A call on a provider. Rounds to the
 * nearest cent, the same way the Sonnet-only version did, so existing cost
 * rows stay comparable with new ones.
 *
 * `priced` is false when Paperclip has no price for the model: the cost is
 * then 0 and the CALLER logs it. A local model is free by definition, so it
 * is reported as priced at 0 rather than unknown. There is deliberately no
 * silent fall-back to another model's price: a wrong number in a budget is
 * worse than a known gap.
 */
export function laneAProviderModelCostCents(
  provider: unknown,
  model: string,
  inputTokens: number,
  outputTokens: number,
): { costCents: number; priced: boolean } {
  const key = normalizeLaneAProvider(provider);
  if (key === "local") return { costCents: 0, priced: true };
  const pricing = laneAModelPricing(key, model);
  if (!pricing) return { costCents: 0, priced: false };
  return { costCents: costCentsAt(pricing, inputTokens, outputTokens), priced: true };
}

/**
 * Cost in whole cents for one Lane A call on Claude (the pre-DUR-3997 entry
 * point, kept for callers that only ever priced Claude). Unknown model = 0.
 */
export function laneAModelCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  return laneAProviderModelCostCents("anthropic", model, inputTokens, outputTokens).costCents;
}

/** Default output-token ceiling for a quick agent that has not set one. */
export const LANE_A_DEFAULT_MAX_OUTPUT_TOKENS = 2048;
/** Bounds the operator may choose between for the per-agent output ceiling. */
export const LANE_A_MIN_MAX_OUTPUT_TOKENS = 64;
export const LANE_A_MAX_MAX_OUTPUT_TOKENS = 8192;

/**
 * Default per-agent daily cap on transform calls (acceptance item 4). It is
 * deliberately NOT the 200-turn chat cap: Nordstrand's first run is ~1400
 * descriptions for one vendor in one day, which the chat cap would stop at
 * turn 200. 2000/day leaves room for one full vendor run plus retries, and
 * the operator can lower or raise it per agent.
 */
export const LANE_A_DEFAULT_TRANSFORM_DAILY_CALL_CAP = 2000;
export const LANE_A_MIN_TRANSFORM_DAILY_CALL_CAP = 1;
export const LANE_A_MAX_TRANSFORM_DAILY_CALL_CAP = 100_000;

/**
 * What a day of transform calls could cost this quick agent if every call ran
 * at the limit, in whole US cents.
 *
 * DUR-3977 review: "no monthly budget set" is the default, and it is the
 * default on the first thing that can spend Paperclip's money from outside
 * Paperclip. "Tomt = ingen grense" is honest but it is not informative — this
 * turns it into a number the operator can react to. Worst case means: every
 * call carries the maximum payload the validator allows
 * (LANE_A_TRANSFORM_MAX_TOTAL_CHARS, at the usual ~4 characters per token),
 * every call produces the agent's full output ceiling, and the agent uses its
 * whole daily call cap.
 *
 * Deliberately an over-estimate. A real product-description call is an order
 * of magnitude smaller on both sides; the point of the number is that the
 * ceiling is knowable before the first run, not that it is likely.
 *
 * A model Paperclip has no price for (free-form OpenRouter ids, a local
 * model) gives 0: the UI says the price is unknown rather than inventing one.
 */
export function laneATransformWorstCaseDailyCents(input: {
  provider?: string | null;
  model?: string | null;
  maxOutputTokens?: number | null;
  dailyCallCap?: number | null;
  /** Defaults to LANE_A_TRANSFORM_MAX_TOTAL_CHARS; injectable so the bound lives in one place. */
  maxTotalInputChars?: number;
}): number {
  const provider = normalizeLaneAProvider(input.provider);
  const model = resolveLaneAModelForProvider(provider, input.model);
  const pricing = model ? laneAModelPricing(provider, model) : null;
  if (!pricing) return 0;
  const inputTokens = Math.ceil((input.maxTotalInputChars ?? 24_000) / 4);
  const outputTokens =
    typeof input.maxOutputTokens === "number" && input.maxOutputTokens > 0
      ? input.maxOutputTokens
      : LANE_A_DEFAULT_MAX_OUTPUT_TOKENS;
  const calls =
    typeof input.dailyCallCap === "number" && input.dailyCallCap > 0
      ? input.dailyCallCap
      : LANE_A_DEFAULT_TRANSFORM_DAILY_CALL_CAP;
  const usdPerCall =
    (inputTokens / 1_000_000) * pricing.inputUsdPerMillion +
    (outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
  return Math.round(usdPerCall * calls * 100);
}

/**
 * The billing code stamped on every cost row a transform call produces. Three
 * separate things read it: the daily call cap counts rows carrying it, the
 * `lane_a_transform_cents` budget metric sums their cost, and the per-agent
 * usage read-out shows them. Never change it without a backfill — old rows
 * would fall out of all three at once.
 */
export const LANE_A_TRANSFORM_BILLING_CODE = "lane_a_transform";
