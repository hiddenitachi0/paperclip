// Sogni's live model and LoRA lists, and the checks a look's model, LoRAs and
// settings must pass. Everything here is a public read of api.sogni.ai that
// needs no key, except the account's own ("personal") LoRAs.
//
//   Models  GET /v1/model-catalog?mediaType=image&include=parameters     [model-discovery]
//           {data:{catalogVersion, updatedAt, count, models:[{id, sid, name, mediaType, tierId,
//           availableNetworks, workerCounts, tags, attribution, parameters}]}}
//   LoRAs   GET /v1/loras/comfy                                          [creative-agent-workflows]
//           {data:{loras:[{loraId, name, description, modelIds, restrictedModelIds?, ui:{min, max,
//           default, step, recommendedMin, recommendedMax, rangeLabels?, category, nsfw, creator,
//           sourceUrl}}], models:[...], constraints:{maxPerRequest, minStrength, maxStrength}}}
//           A LoRA works with the catalog model ids in modelIds, minus restrictedModelIds.
//           ui.nsfw: the LoRA needs the Sensitive Content Filter off.
//   Own     GET /v1/loras/personal/catalog (Bearer key; Unlimited plan, else 403) [personal-loras]
//           Same row shape; strength must be above 0 and at most 1.
//
// Both lists are kept in memory for 10 minutes (Sogni caches them for 30 s);
// when Sogni cannot be reached the last list is used, and with no list at all
// the small built-in list below is offered in the picker.

import type { FetchImpl } from "./providers.js";
import {
  SOGNI_API_BASE,
  SOGNI_DEFAULT_SIZE_BOUNDS,
  SOGNI_EDIT_TOOL_KEYS,
  SOGNI_GENERATE_TOOL_KEYS,
  SOGNI_MAX_LORAS,
  sogniCanonicalModelId,
  sogniSize,
  type SogniLoraPick,
  type SogniSizeBounds,
} from "./sogni.js";

export const SOGNI_CATALOG_TTL_MS = 10 * 60 * 1000;
/** After a failed read, wait this long before asking Sogni again (the old list, or the built-in one, is used meanwhile). */
const RETRY_AFTER_FAILURE_MS = 30 * 1000;
export const SOGNI_NEGATIVE_PROMPT_MAX = 1000;

export interface SogniRange {
  min: number;
  max: number;
  default: number;
  step?: number;
  decimals?: number;
}

/** One model as the picker and the checks need it. */
export interface SogniModelInfo {
  id: string;
  name: string;
  tags: string[];
  tier: string | null;
  /** Makes new pictures from a description (generate_image). */
  generates: boolean;
  /** Can make a picture from reference pictures (edit_image). */
  takesReferences: boolean;
  /** Workers connected right now (all networks); null when not known (built-in list). */
  workersOnline: number | null;
  /** "off-required": only works with the Sensitive Content Filter off. "mature": made for mature pictures. */
  contentFilter: "off-required" | "mature" | null;
  width: SogniRange | null;
  height: SogniRange | null;
  /** Shown for information only: a workflow step has no steps argument. */
  steps: SogniRange | null;
  /** Only when the model lets it change (min below max). */
  guidance: SogniRange | null;
  /** Present when the model uses "things to avoid" text; default is Sogni's own. */
  negativePrompt: { default: string } | null;
  /** Whether Sogni has public LoRAs for this model (null: not known). */
  hasLoras: boolean | null;
  creator: string | null;
  sourceUrl: string | null;
  /** An untagged build of another model (MLX, CoreML sizes...): hidden in the picker unless asked for. */
  variant: boolean;
}

export interface SogniLoraInfo {
  id: string;
  name: string;
  description: string;
  category: string | null;
  /** The account's own imported LoRA (id personal-...). */
  personal: boolean;
  /** Catalog model ids it works with. */
  modelIds: string[];
  min: number;
  max: number;
  default: number;
  step: number;
  recommendedMin: number;
  recommendedMax: number;
  rangeLabels: { min: string; max: string } | null;
  /** Sogni: "requires the artist to have the Sensitive Content Filter off". */
  needsFilterOff: boolean;
  creator: string | null;
  sourceUrl: string | null;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function httpsUrl(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

function range(value: unknown): SogniRange | null {
  const r = asRecord(value);
  const min = num(r?.min);
  const max = num(r?.max);
  if (min === null || max === null || min > max) return null;
  const def = num(r?.default);
  const out: SogniRange = { min, max, default: def !== null && def >= min && def <= max ? def : min };
  const step = num(r?.step);
  if (step !== null && step > 0) out.step = step;
  const decimals = num(r?.decimals);
  if (decimals !== null && decimals >= 0) out.decimals = decimals;
  return out;
}

const EDIT_MODEL_IDS = new Set(Object.values(SOGNI_EDIT_TOOL_KEYS));
const DARK_BEAST = /^dark[_-]?beast/i;

function contentFilterNeed(id: string, tags: string[]): SogniModelInfo["contentFilter"] {
  // Sogni says the Dark Beast community models only work with the filter off;
  // "spicy" is Sogni's tag for models made for mature pictures.
  if (DARK_BEAST.test(id)) return "off-required";
  return tags.includes("spicy") ? "mature" : null;
}

function parseModel(value: unknown): SogniModelInfo | null {
  const m = asRecord(value);
  const id = str(m?.id);
  if (!m || !id) return null;
  if (m.mediaType !== undefined && m.mediaType !== "image") return null;
  const p = asRecord(m.parameters) ?? {};
  // Background removal, upscaling and other one-job tools are not picture models.
  if (p.requiresStartingImage === true || p.isUpscale === true) return null;
  if (p.outputMedia !== undefined && p.outputMedia !== "image") return null;
  const tags = Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === "string") : [];
  const counts = asRecord(m.workerCounts);
  const workersOnline = counts ? Object.values(counts).reduce<number>((sum, n) => sum + (num(n) ?? 0), 0) : 0;
  const guidance = range(p.guidance);
  const negative = asRecord(p.negativePrompt);
  const attribution = asRecord(m.attribution);
  const editOnly = p.requiresContextImage === true;
  return {
    id,
    name: str(m.name) ?? id,
    tags,
    tier: str(m.tierId),
    generates: !editOnly,
    takesReferences: editOnly || EDIT_MODEL_IDS.has(id),
    workersOnline,
    contentFilter: contentFilterNeed(id, tags),
    width: range(p.width),
    height: range(p.height),
    steps: range(p.steps),
    guidance: guidance && guidance.min < guidance.max ? guidance : null,
    negativePrompt: negative ? { default: typeof negative.default === "string" ? negative.default : "" } : null,
    hasLoras: null,
    creator: str(attribution?.creator),
    sourceUrl: httpsUrl(attribution?.sourceUrl),
    variant: tags.length === 0,
  };
}

function byUsefulness(a: SogniModelInfo, b: SogniModelInfo): number {
  if (a.variant !== b.variant) return a.variant ? 1 : -1;
  const aOnline = (a.workersOnline ?? 1) > 0;
  const bOnline = (b.workersOnline ?? 1) > 0;
  if (aOnline !== bOnline) return aOnline ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Parse GET /v1/model-catalog; null when the answer is not a catalog. */
export function parseSogniModelCatalog(json: unknown): { updatedAt: string | null; models: SogniModelInfo[] } | null {
  const data = asRecord(asRecord(json)?.data);
  if (!data || !Array.isArray(data.models)) return null;
  const models = data.models.map(parseModel).filter((m): m is SogniModelInfo => m !== null);
  return { updatedAt: str(data.updatedAt), models: models.sort(byUsefulness) };
}

function parseLora(value: unknown, personal: boolean): SogniLoraInfo | null {
  const row = asRecord(value);
  const id = str(row?.loraId);
  const ui = asRecord(row?.ui);
  if (!row || !id || !ui) return null;
  const min = num(ui.min);
  const max = num(ui.max);
  if (min === null || max === null || min > max) return null;
  const restricted = new Set(Array.isArray(row.restrictedModelIds) ? row.restrictedModelIds : []);
  const modelIds = (Array.isArray(row.modelIds) ? row.modelIds : []).filter(
    (m): m is string => typeof m === "string" && !restricted.has(m),
  );
  const def = num(ui.default);
  const recMin = num(ui.recommendedMin);
  const recMax = num(ui.recommendedMax);
  const labels = asRecord(ui.rangeLabels);
  return {
    id,
    name: str(row.name) ?? str(ui.label) ?? id,
    description: str(row.description) ?? "",
    category: str(ui.category),
    personal,
    modelIds,
    min,
    max,
    default: def !== null && def >= min && def <= max ? def : Math.min(Math.max(1, min), max),
    step: num(ui.step) && (ui.step as number) > 0 ? (ui.step as number) : 0.05,
    recommendedMin: recMin !== null && recMin >= min && recMin <= max ? recMin : min,
    recommendedMax: recMax !== null && recMax >= min && recMax <= max ? recMax : max,
    rangeLabels: str(labels?.min) && str(labels?.max) ? { min: str(labels!.min)!, max: str(labels!.max)! } : null,
    needsFilterOff: ui.nsfw === true,
    creator: str(ui.creator),
    sourceUrl: httpsUrl(ui.sourceUrl),
  };
}

export interface SogniLoraCatalog {
  loras: SogniLoraInfo[];
  /** Every catalog model id that takes at least one LoRA. */
  models: string[];
  maxPerRequest: number;
}

/** Parse GET /v1/loras/comfy or /v1/loras/personal/catalog; null when the answer is not a LoRA list. */
export function parseSogniLoraCatalog(json: unknown, personal = false): SogniLoraCatalog | null {
  const data = asRecord(asRecord(json)?.data);
  if (!data || !Array.isArray(data.loras)) return null;
  const loras = data.loras.map((row) => parseLora(row, personal)).filter((l): l is SogniLoraInfo => l !== null);
  const constraint = num(asRecord(data.constraints)?.maxPerRequest);
  const models = Array.isArray(data.models)
    ? data.models.filter((m): m is string => typeof m === "string")
    : [...new Set(loras.flatMap((l) => l.modelIds))];
  return {
    loras,
    models,
    maxPerRequest: constraint !== null && constraint > 0 ? Math.min(constraint, SOGNI_MAX_LORAS) : SOGNI_MAX_LORAS,
  };
}

/** The LoRAs that work with one model, in Sogni's order. */
export function lorasForModel(catalog: SogniLoraCatalog | null, modelId: string): SogniLoraInfo[] {
  const id = sogniCanonicalModelId(modelId);
  return (catalog?.loras ?? []).filter((lora) => lora.modelIds.includes(id));
}

const OFFLINE_NAMES: Record<string, string> = {
  "z-turbo": "Z-Image Turbo",
  "z-image": "Z-Image",
  "krea-2-turbo": "Krea 2 Turbo",
  "dark-beast-krea2": "Dark Beast Krea 2",
  "dark-beast-z-turbo": "Dark Beast Z-Image Turbo v9",
  "chroma-v46-flash": "Chroma v.46 Flash",
  "chroma1-hd": "Chroma 1 HD",
  "chroma-detail": "Chroma Detail",
  "qwen-2512": "Qwen Image 2512",
  "qwen-2512-lightning": "Qwen Image 2512 Lightning",
  "gpt-image-2": "GPT Image 2",
  "gpt-image-2.5-sunburst": "GPT Image 2.5 Sunburst",
  "gpt-image-2.5-flare": "GPT Image 2.5 Flare",
  "qwen-lightning": "Qwen Image Edit 2511 Lightning",
  qwen: "Qwen Image Edit 2511",
  "krea-identity-edit": "Krea 2 Identity Edit",
  "dark-beast-krea2-identity-edit": "Dark Beast Krea 2 Identity Edit",
};

/**
 * The picker's list when Sogni's catalog cannot be reached and none was read
 * before: the models Sogni's docs name, by catalog id, with no live details.
 */
export const SOGNI_OFFLINE_MODELS: SogniModelInfo[] = Object.entries(OFFLINE_NAMES).map(([key, name]) => {
  const id = SOGNI_GENERATE_TOOL_KEYS[key] ?? SOGNI_EDIT_TOOL_KEYS[key] ?? key;
  const editOnly = key in SOGNI_EDIT_TOOL_KEYS && !(key in SOGNI_GENERATE_TOOL_KEYS);
  return {
    id,
    name,
    tags: [],
    tier: null,
    generates: !editOnly,
    takesReferences: EDIT_MODEL_IDS.has(id),
    workersOnline: null,
    contentFilter: contentFilterNeed(id, []),
    width: null,
    height: null,
    steps: null,
    guidance: null,
    negativePrompt: null,
    hasLoras: null,
    creator: null,
    sourceUrl: null,
    variant: false,
  };
});

export interface SogniModelList {
  models: SogniModelInfo[];
  /** true: Sogni's own list (maybe from the last 10 minutes); false: the built-in list. */
  live: boolean;
  updatedAt: string | null;
}

export type PersonalLoraStatus = "included" | "not-allowed" | "unavailable";

export interface SogniCatalogOptions {
  baseUrl?: string;
  ttlMs?: number;
  now?: () => number;
}

/** Sogni's model and LoRA lists, read through the host's fetch and kept in memory. */
export class SogniCatalog {
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private modelCache: { at: number; updatedAt: string | null; models: SogniModelInfo[] } | null = null;
  private modelFailedAt = -Infinity;
  private loraCache: { at: number; catalog: SogniLoraCatalog } | null = null;
  private loraFailedAt = -Infinity;

  constructor(
    private readonly fetchImpl: FetchImpl,
    options: SogniCatalogOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? SOGNI_API_BASE).replace(/\/$/, "");
    this.ttlMs = options.ttlMs ?? SOGNI_CATALOG_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  private async getJson(path: string, apiKey?: string): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "GET", headers });
    let body: unknown = null;
    try {
      body = JSON.parse(await res.text());
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  private fresh(at: number): boolean {
    return this.now() - at < this.ttlMs;
  }

  /** The image models: Sogni's list (fresh, or the last one read), else the built-in list. */
  async models(): Promise<SogniModelList> {
    const cached = this.modelCache;
    if (cached && this.fresh(cached.at)) return { models: cached.models, live: true, updatedAt: cached.updatedAt };
    if (this.now() - this.modelFailedAt >= RETRY_AFTER_FAILURE_MS) {
      try {
        const { status, body } = await this.getJson("/v1/model-catalog?mediaType=image&include=parameters");
        const parsed = status === 200 ? parseSogniModelCatalog(body) : null;
        if (parsed && parsed.models.length > 0) {
          this.modelCache = { at: this.now(), ...parsed };
          return { models: parsed.models, live: true, updatedAt: parsed.updatedAt };
        }
      } catch {
        // Unreachable: fall through to the last list.
      }
      this.modelFailedAt = this.now();
    }
    if (cached) return { models: cached.models, live: true, updatedAt: cached.updatedAt };
    return { models: SOGNI_OFFLINE_MODELS, live: false, updatedAt: null };
  }

  /** One model by catalog id or tool key. `live` false: Sogni's list could not be read, so the answer is unknown. */
  async model(idOrKey: string): Promise<{ model: SogniModelInfo | null; live: boolean }> {
    const list = await this.models();
    const id = sogniCanonicalModelId(idOrKey);
    const found =
      list.models.find((m) => m.id === id) ?? list.models.find((m) => m.id.toLowerCase() === id.toLowerCase()) ?? null;
    return { model: list.live ? found : null, live: list.live };
  }

  /** Without waiting: does the last list read include this model? */
  knows(idOrKey: string): boolean {
    const id = sogniCanonicalModelId(idOrKey).toLowerCase();
    return this.modelCache?.models.some((m) => m.id.toLowerCase() === id) ?? false;
  }

  /** Sogni's public LoRAs (all models); null when they could not be read and none were read before. */
  async publicLoras(): Promise<SogniLoraCatalog | null> {
    const cached = this.loraCache;
    if (cached && this.fresh(cached.at)) return cached.catalog;
    if (this.now() - this.loraFailedAt >= RETRY_AFTER_FAILURE_MS) {
      try {
        const { status, body } = await this.getJson("/v1/loras/comfy");
        const parsed = status === 200 ? parseSogniLoraCatalog(body) : null;
        if (parsed) {
          this.loraCache = { at: this.now(), catalog: parsed };
          return parsed;
        }
      } catch {
        // Unreachable: fall through to the last list.
      }
      this.loraFailedAt = this.now();
    }
    return cached?.catalog ?? null;
  }

  /**
   * The account's own ready LoRAs. Never kept (Sogni says so too). A 401 or
   * 403 means the account may not use them (they need an Unlimited plan).
   */
  async personalLoras(apiKey: string): Promise<{ loras: SogniLoraInfo[]; status: PersonalLoraStatus }> {
    try {
      const { status, body } = await this.getJson("/v1/loras/personal/catalog", apiKey);
      if (status === 401 || status === 403) return { loras: [], status: "not-allowed" };
      const parsed = status === 200 ? parseSogniLoraCatalog(body, true) : null;
      return parsed ? { loras: parsed.loras, status: "included" } : { loras: [], status: "unavailable" };
    } catch {
      return { loras: [], status: "unavailable" };
    }
  }
}

// ─── Checks (run by the worker on save and again before every picture) ────────

/** The sizes a model takes, from its catalog ranges; 256-2048 when the catalog gives none. */
export function sizeBoundsFor(model: SogniModelInfo | null): SogniSizeBounds {
  if (!model?.width || !model.height) return SOGNI_DEFAULT_SIZE_BOUNDS;
  return { minWidth: model.width.min, maxWidth: model.width.max, minHeight: model.height.min, maxHeight: model.height.max };
}

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** A readable number for sentences (no floating-point noise). */
export function showNumber(value: number): string {
  return String(roundTo(value, 3));
}

/**
 * Check LoRA picks for a model against Sogni's lists. Returns the first
 * problem as a plain sentence, or null when all is well.
 */
export function checkSogniLoras(
  model: Pick<SogniModelInfo, "id" | "name">,
  picks: SogniLoraPick[],
  known: SogniLoraInfo[],
  options: { maxPerRequest?: number; contentFilterOn: boolean },
): string | null {
  const max = Math.min(options.maxPerRequest ?? SOGNI_MAX_LORAS, SOGNI_MAX_LORAS);
  if (picks.length > max) return `A picture can use at most ${max} LoRAs; this has ${picks.length}. Remove some.`;
  const seen = new Set<string>();
  for (const pick of picks) {
    if (seen.has(pick.id)) return `The LoRA "${pick.id}" is in the list twice. Keep it once.`;
    seen.add(pick.id);
    const lora = known.find((l) => l.id === pick.id);
    if (!lora) return `Sogni has no LoRA called "${pick.id}" that this account can use. Pick LoRAs from the list.`;
    if (!lora.modelIds.includes(model.id)) {
      return `The LoRA "${lora.name}" does not work with the model ${model.name}. Pick LoRAs from the list for this model.`;
    }
    if (typeof pick.strength !== "number" || !Number.isFinite(pick.strength)) {
      return `Give the LoRA "${lora.name}" a strength.`;
    }
    if (lora.personal && (pick.strength <= 0 || pick.strength > 1)) {
      return `Your own LoRA "${lora.name}" takes a strength above 0 and at most 1 (it is ${showNumber(pick.strength)}).`;
    }
    if (pick.strength < lora.min || pick.strength > lora.max) {
      return `The strength of "${lora.name}" must be between ${showNumber(lora.min)} and ${showNumber(lora.max)} (it is ${showNumber(pick.strength)}).`;
    }
    if (lora.needsFilterOff && options.contentFilterOn) {
      return `The LoRA "${lora.name}" only works with the Sensitive content filter off. Turn the filter off for this look, or remove the LoRA.`;
    }
  }
  return null;
}

export interface SogniOverrides {
  guidance: number | null;
  negativePrompt: string | null;
  size: string | null;
}

/** Check a look's settings against what the model allows. Returns the first problem as a sentence, or null. */
export function checkSogniOverrides(model: SogniModelInfo, overrides: SogniOverrides): string | null {
  if (overrides.guidance !== null) {
    if (!model.guidance) return `The model ${model.name} does not let you change guidance. Leave it empty.`;
    if (!Number.isFinite(overrides.guidance) || overrides.guidance < model.guidance.min || overrides.guidance > model.guidance.max) {
      return `Guidance for ${model.name} must be between ${showNumber(model.guidance.min)} and ${showNumber(model.guidance.max)}.`;
    }
  }
  if (overrides.negativePrompt !== null) {
    if (!model.negativePrompt) return `The model ${model.name} does not use "things to avoid" text. Leave it empty.`;
    if (overrides.negativePrompt.length > SOGNI_NEGATIVE_PROMPT_MAX) {
      return `Keep the "things to avoid" text under ${SOGNI_NEGATIVE_PROMPT_MAX} characters.`;
    }
  }
  if (overrides.size !== null) {
    try {
      sogniSize(overrides.size, sizeBoundsFor(model));
    } catch (err) {
      return err instanceof Error ? err.message.replace("Sogni does not know", `${model.name} does not take`) : String(err);
    }
  }
  return null;
}
