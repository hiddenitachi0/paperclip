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

export const LANE_A_PROVIDERS = ["anthropic", "openai", "google", "openrouter", "huggingface", "local"] as const;
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
    label: "Fast and cheap",
    inputUsdPerMillion: 1.0,
    outputUsdPerMillion: 5.0,
  },
  "claude-sonnet-5": {
    label: "Standard",
    inputUsdPerMillion: 2.0,
    outputUsdPerMillion: 10.0,
  },
  "claude-opus-5": {
    label: "Best quality",
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
      "gpt-4.1-mini": { label: "Fast and cheap", inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 },
      "gpt-4.1": { label: "Standard", inputUsdPerMillion: 2.0, outputUsdPerMillion: 8.0 },
      "o4-mini": { label: "Reasoning", inputUsdPerMillion: 1.1, outputUsdPerMillion: 4.4 },
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
      "gemini-2.5-flash": { label: "Fast and cheap", inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 },
      "gemini-2.5-pro": { label: "Best quality", inputUsdPerMillion: 1.25, outputUsdPerMillion: 10.0 },
    },
  },
  openrouter: {
    label: "OpenRouter",
    freeForm: true,
    defaultModel: null,
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    baseUrlEditable: true,
    // DUR-4353: freeForm providers accept any model id typed in (see
    // laneAModelIssueForProvider below), but an id with no entry here prices
    // at 0 (laneAModelPricing), so a company's real OpenRouter spend reads as
    // free. Priced here are the ids Paperclip has actually been pointed at in
    // production; add more as they come up. Price is OpenRouter's lowest-cost
    // host for the model (2 Oct 2026: DeepInfra fp8), since that is the host
    // OpenRouter picks by default with no "model hosts" restriction set.
    models: {
      "mistralai/mistral-small-3.2-24b-instruct": {
        label: "Mistral Small 3.2 24B",
        inputUsdPerMillion: 0.075,
        outputUsdPerMillion: 0.2,
      },
    },
  },
  huggingface: {
    label: "Hugging Face",
    // The model id carries a provider/policy suffix the picker builds
    // (buildHuggingFaceModelId), so it is typed/assembled, not a fixed list.
    freeForm: true,
    // The operator must pick: there is no sensible default across ~100 hosts.
    defaultModel: null,
    // Fixed: Inference Providers is one router. Not operator-editable, so a
    // pasted token can never be sent to another host by editing the address.
    defaultBaseUrl: "https://router.huggingface.co/v1",
    baseUrlEditable: false,
    // Pricing comes from the live /v1/models catalogue (server
    // huggingface-catalogue.ts), per model AND per provider, not a static map.
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

export function laneACostCentsAtPricing(
  pricing: Pick<LaneAModelPricing, "inputUsdPerMillion" | "outputUsdPerMillion">,
  inputTokens: number,
  outputTokens: number,
): number {
  return costCentsAt({ label: "", ...pricing }, inputTokens, outputTokens);
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
 * "Creativity" (sampling temperature) per quick agent. Null = send nothing and
 * let the model host use its own default, which is what every quick agent did
 * before this setting existed. Some hosts' defaults (e.g. Mistral Small on
 * OpenRouter) make a playful chat persona flat and dry; this is the dial.
 *
 * 0-1.5 is the range the operator may store. OpenAI-compatible hosts accept up
 * to 2, but past ~1.5 most models drift into nonsense, so the store stops
 * there. Claude only accepts 0-1, so a Claude call is clamped to 1 instead of
 * refused.
 */
export const LANE_A_MIN_TEMPERATURE = 0;
export const LANE_A_MAX_TEMPERATURE = 1.5;
export const LANE_A_ANTHROPIC_MAX_TEMPERATURE = 1;

/** The named steps the quick-agent card offers. Plain words for the operator. */
export const LANE_A_TEMPERATURE_PRESETS = [
  { value: 0.2, label: "Precise" },
  { value: 0.6, label: "Balanced" },
  { value: 0.9, label: "Lively" },
  { value: 1.2, label: "Very lively" },
] as const;

/**
 * Claude models that still take a temperature. Claude Sonnet 5 and Opus 5
 * (and every newer Claude) removed sampling parameters: sending one is a 400,
 * which would turn "make it livelier" into "the chat stopped working". So
 * Claude is an allow-list, not a deny-list: a Claude model added later is
 * assumed to refuse until someone checks.
 */
const LANE_A_ANTHROPIC_TEMPERATURE_MODELS: ReadonlySet<string> = new Set(["claude-haiku-4-5"]);

/**
 * Whether this provider/model is known to accept a temperature. False means
 * the model decides for itself and the setting is not sent. OpenAI's
 * reasoning models (o-series, gpt-5) refuse anything but their default.
 * OpenRouter, Google and local servers accept it (OpenRouter drops a
 * parameter a model does not support); the call path still retries once
 * without it if a host refuses.
 */
export function laneAModelAcceptsTemperature(provider: unknown, model: unknown): boolean {
  const key = normalizeLaneAProvider(provider);
  const resolved = resolveLaneAModelForProvider(key, model);
  if (key === "anthropic") return resolved !== null && LANE_A_ANTHROPIC_TEMPERATURE_MODELS.has(resolved);
  if (key === "openai") return resolved === null || !/^(o\d|gpt-5)/i.test(resolved);
  return true;
}

/**
 * The temperature one call is actually made with, or null to send none.
 * Anything that is not a finite number in range is treated as "not set"
 * rather than forwarded (a bad value must never break a chat), and so is a
 * model known not to accept one. A Claude call is clamped to Claude's 0-1.
 */
export function laneATemperatureForCall(provider: unknown, model: unknown, temperature: unknown): number | null {
  if (typeof temperature !== "number" || !Number.isFinite(temperature)) return null;
  if (temperature < LANE_A_MIN_TEMPERATURE || temperature > LANE_A_MAX_TEMPERATURE) return null;
  if (!laneAModelAcceptsTemperature(provider, model)) return null;
  if (normalizeLaneAProvider(provider) === "anthropic") {
    return Math.min(temperature, LANE_A_ANTHROPIC_MAX_TEMPERATURE);
  }
  return temperature;
}

/**
 * DUR-4367: quick-agent "Thinking" (on / off / model default). Off asks the
 * model to skip its reasoning pass — for a local reasoning model (Ollama's
 * huihui_ai/qwen3-abliterated, for example) that is most of the latency: the
 * same one-line message measured 4.6s with thinking on and 0.3s with it off.
 * "model default" (null, the default for every quick agent that existed
 * before this setting) sends nothing and leaves the model's own behaviour
 * alone, exactly as before this setting existed. "on" is also a no-op on the
 * wire today: every model this reaches already thinks by default when it is
 * able to, so there is nothing additional to ask for yet.
 */
export const LANE_A_THINKING_MODES = ["on", "off"] as const;
export type LaneAThinkingMode = (typeof LANE_A_THINKING_MODES)[number];

/**
 * Models known to accept an OpenAI-style `reasoning_effort` field. This is an
 * allow-list, not a deny-list, on purpose: a strict host (plain OpenAI, for a
 * model that was never a reasoning model) answers an unrecognised field with
 * a 400, which would turn "turn thinking off" into "the chat stopped
 * working". OpenRouter and a local OpenAI-compatible server (Ollama, LM
 * Studio, llama.cpp, vLLM) are the cases this setting exists for. A local
 * server is the operator's own and this is exactly the field the qwen3 case
 * needs. OpenRouter is NOT reliably lenient about it, despite earlier belief
 * here: DUR-4391 (3 Oct) found DeepInfra's Mistral Small has no reasoning
 * parameter at all and OpenRouter answered 404 "No endpoints found that can
 * handle the requested parameters" rather than silently dropping it. This
 * function still returns true for every OpenRouter model -- it is still an
 * allow-list, just a wide one -- and the actual safety net is the call-site
 * retry in lane-a.ts's completeRound()/callTransformModel(), which drops
 * `reasoning_effort` (before temperature, and well before ever blaming tools)
 * on exactly that error. OpenAI's own reasoning models (o-series, gpt-5)
 * already take this field for their effort level, so "off" maps onto it too.
 * Hugging Face is deliberately NOT on this list either (DUR-4447): its
 * router fronts many hosts and the per-host support for reasoning_effort is
 * not in the catalogue, so nothing is sent until a model/host is known to take it.
 * Google's OpenAI-compatible shim is not on this list: unlike OpenRouter it is
 * not known to tolerate an extra field, so nothing is sent there until that is
 * checked. Anthropic never reaches this function (extended thinking is a
 * different, opt-in wire shape it does not use); see laneAThinkingForCall.
 */
export function laneAModelAcceptsReasoningEffort(provider: unknown, model: unknown): boolean {
  const key = normalizeLaneAProvider(provider);
  if (key === "openrouter" || key === "local") return true;
  if (key === "openai") {
    const resolved = resolveLaneAModelForProvider(key, model);
    return resolved !== null && /^(o\d|gpt-5)/i.test(resolved);
  }
  return false;
}

/**
 * The `reasoning_effort` value to send for this provider/model, or null to
 * send none. Only "off" ever sends anything: "model default" (null/absent)
 * and "on" both leave the model's own behaviour alone, and a model not known
 * to accept the field gets nothing regardless of the setting (a bad value
 * must never break a chat).
 */
export function laneAThinkingForCall(provider: unknown, model: unknown, thinking: unknown): "none" | null {
  if (thinking !== "off") return null;
  if (!laneAModelAcceptsReasoningEffort(provider, model)) return null;
  return "none";
}

/**
 * Quick-agent "model hosts" (OpenRouter only). OpenRouter can serve the same
 * model from several hosts ("providers" in its API, e.g. deepinfra, venice),
 * and not every host supports tools. The operator can pin the hosts a quick
 * agent's calls may use, the order to try them in, and hosts never to use.
 * Stored on agents.lane_a_provider_routing; null = OpenRouter picks, as before.
 */
export interface LaneAProviderRouting {
  /** Use only these hosts. */
  only?: string[];
  /** Try these hosts first, in this order. */
  order?: string[];
  /** Never use these hosts. */
  ignore?: string[];
  /** Whether OpenRouter may fall back to other hosts when the listed ones fail. */
  allowFallbacks?: boolean;
}

/** An OpenRouter host slug, lower case: "deepinfra", "mistral", "together", "novita". */
export const LANE_A_PROVIDER_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** At most this many hosts in any one list. */
export const LANE_A_PROVIDER_ROUTING_MAX_ENTRIES = 10;

const LANE_A_PROVIDER_ROUTING_LISTS = ["only", "order", "ignore"] as const;

function cleanSlugList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const slug = raw.trim().toLowerCase();
    if (!LANE_A_PROVIDER_SLUG_RE.test(slug) || out.includes(slug)) continue;
    out.push(slug);
    if (out.length >= LANE_A_PROVIDER_ROUTING_MAX_ENTRIES) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The stored routing, cleaned, or null when there is nothing to send.
 * Defensive on purpose: the column is jsonb, and a bad stored value must
 * never break a chat, so anything malformed is dropped rather than forwarded.
 */
export function normalizeLaneAProviderRouting(value: unknown): LaneAProviderRouting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const out: LaneAProviderRouting = {};
  for (const key of LANE_A_PROVIDER_ROUTING_LISTS) {
    const list = cleanSlugList(record[key]);
    if (list) out[key] = list;
  }
  if (typeof record.allowFallbacks === "boolean") out.allowFallbacks = record.allowFallbacks;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The routing one call is actually made with: OpenRouter only (every other
 * provider has one host, so there is nothing to choose), null otherwise.
 */
export function laneAProviderRoutingForCall(provider: unknown, routing: unknown): LaneAProviderRouting | null {
  if (normalizeLaneAProvider(provider) !== "openrouter") return null;
  return normalizeLaneAProviderRouting(routing);
}

/**
 * Split what an operator typed into a host field ("deepinfra, Mistral") into
 * slugs. `invalid` lists the entries that are not a host name, so the form
 * can say which one it did not understand instead of silently dropping it.
 */
export function parseLaneAProviderSlugList(text: string): { slugs: string[]; invalid: string[] } {
  const slugs: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[,\s]+/)) {
    const slug = part.trim().toLowerCase();
    if (slug.length === 0) continue;
    if (!LANE_A_PROVIDER_SLUG_RE.test(slug)) {
      invalid.push(part.trim());
      continue;
    }
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  return { slugs, invalid };
}

/**
 * What a day of transform calls could cost this quick agent if every call ran
 * at the limit, in whole US cents.
 *
 * DUR-3977 review: "no monthly budget set" is the default, and it is the
 * default on the first thing that can spend Paperclip's money from outside
 * Paperclip. "Empty = no limit" is honest but it is not informative — this
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

// ─── DUR-4347: quick-agent backup models, fallback chains & keyword routing ──
//
// A quick agent's "main" model (laneAProvider/laneAModel/laneABaseUrl/
// laneATemperature) stays exactly as it was. These four fields add an
// optional pool of up to 5 backups plus two ordered fallback chains (tried
// when the main/current model does not answer, or when it refuses) and a set
// of keyword-routing rules (phrases that pick a different starting model).
// Every quick agent that existed before this has all four at their defaults
// ([]), i.e. today's single-model behaviour, unchanged.

/** At most this many backup models in one quick agent's pool. */
export const LANE_A_BACKUP_MODELS_MAX = 5;
/** At most this many phrases on one keyword-routing rule. */
export const LANE_A_KEYWORD_ROUTE_PHRASES_MAX = 20;
/** Longest a single keyword-routing phrase may be. */
export const LANE_A_KEYWORD_ROUTE_PHRASE_MAX_LENGTH = 80;
/**
 * At most this many keyword-routing rules. Not stated in the acceptance
 * criteria directly; bounded anyway so a jsonb column cannot be grown without
 * limit. Generous next to the 5-entry pool every rule routes into.
 */
export const LANE_A_KEYWORD_ROUTES_MAX = 50;
/** Longest a pool entry's or keyword-route's own `id` may be (nanoid-shaped). */
export const LANE_A_BACKUP_ID_MAX_LENGTH = 64;

/**
 * One entry in a quick agent's backup-model pool. `id` is stable across edits
 * (assigned once, e.g. nanoid) so chain-id arrays and keyword routes can keep
 * referencing it after the operator reorders or edits other entries.
 * Resolved through the same credential/settings path as the main model
 * (resolveLaneASettings in server/src/services/lane-a.ts) -- a backup is
 * never a second, looser set of rules, only a second set of coordinates.
 */
export interface LaneABackupModelConfig {
  id: string;
  provider: LaneAProvider;
  model: string;
  baseUrl?: string | null;
  temperature?: number | null;
  /**
   * DUR-4418: when set, the id of a company model-directory entry this backup
   * points at. At call time the entry's provider/model/address/creativity win
   * over the inline fields above (which stay as the last-known copy so an
   * entry deleted later degrades to the saved coordinates, not to a broken
   * backup).
   */
  directoryEntryId?: string | null;
}

/**
 * One keyword-routing rule: the first whole-word, case-insensitive match
 * against any of `phrases` in the person's message picks `backupId` (a pool
 * entry id) as the starting model for that turn, before either fallback chain
 * is even built. Rules are tried in order; the first match wins.
 */
export interface LaneAKeywordRoute {
  id: string;
  phrases: string[];
  backupId: string;
}

/**
 * Why a backup-pool entry cannot be used, in plain words, or null when it can.
 * Mirrors the main model's own provider/model fit check
 * (laneAModelIssueForProvider) plus the one thing the main model only
 * enforces at call time (assertLaneASettingsRunnable in lane-a.ts, a 503): a
 * free-form provider (OpenRouter, local) needs a base URL, checked eagerly
 * here because a backup pool entry is structured data the operator fills in
 * once, not a per-call runtime fallback message.
 */
export function laneABackupModelEntryIssue(entry: {
  provider: unknown;
  model: unknown;
  baseUrl?: string | null;
}): string | null {
  const modelIssue = laneAModelIssueForProvider(entry.provider, entry.model);
  if (modelIssue) return modelIssue;
  const provider = normalizeLaneAProvider(entry.provider);
  const descriptor = LANE_A_PROVIDER_CATALOGUE[provider];
  if (descriptor.baseUrlEditable && !descriptor.defaultBaseUrl) {
    const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
    if (baseUrl.length === 0) {
      return `Add an address for ${descriptor.label.toLowerCase()} (for example http://localhost:11434/v1).`;
    }
  }
  return null;
}

export const HUGGINGFACE_ROUTER_BASE_URL = "https://router.huggingface.co/v1";
export const HUGGINGFACE_POLICY_SUFFIXES = ["cheapest", "fastest", "preferred"] as const;
export type HuggingFacePolicySuffix = (typeof HUGGINGFACE_POLICY_SUFFIXES)[number];

/**
 * The model id sent to Hugging Face Inference Providers from a picker choice.
 * `selection` is a specific provider ("deepinfra") or a routing policy
 * ("cheapest" | "fastest" | "preferred"); empty/null means plain model id
 * (HF then routes with the account's own provider preference). A suffix the
 * model id already carries is replaced, never doubled.
 * ("Qwen/Qwen3-14B", "deepinfra") -> "Qwen/Qwen3-14B:deepinfra".
 */
export function buildHuggingFaceModelId(model: string, selection?: string | null): string {
  const base = model.trim().replace(/:[^/:]*$/, "");
  const suffix = (selection ?? "").trim().replace(/^:/, "").toLowerCase();
  return suffix.length > 0 ? `${base}:${suffix}` : base;
}

/** Splits "Qwen/Qwen3-14B:deepinfra" into the model and its provider/policy suffix (null when none). */
export function splitHuggingFaceModelId(id: string): { model: string; suffix: string | null } {
  const match = /^(.*[^:]):([^/:]+)$/.exec(id.trim());
  return match ? { model: match[1]!, suffix: match[2]! } : { model: id.trim(), suffix: null };
}
