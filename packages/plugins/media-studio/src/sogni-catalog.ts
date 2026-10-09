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
  SOGNI_EDIT_CATALOG_ONLY,
  SOGNI_EDIT_TOOL_KEYS,
  SOGNI_GENERATE_TOOL_KEYS,
  SOGNI_KREA_IDENTITY_EDIT_ALPHA,
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
  /**
   * How many reference pictures it takes, from the catalog: parameters.maxContextImages
   * (GPT Image 2.5: 16), else the most context pictures Sogni benchmarks it with
   * (parameters.benchmark.secContext1..N: Qwen Image Edit 3, Krea 2 Identity Edit 2).
   * Null when the catalog does not say.
   */
  maxReferences: number | null;
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

const EDIT_MODEL_IDS = new Set([...Object.values(SOGNI_EDIT_TOOL_KEYS), ...SOGNI_EDIT_CATALOG_ONLY]);
const DARK_BEAST = /^dark[_-]?beast/i;

function contentFilterNeed(id: string, tags: string[]): SogniModelInfo["contentFilter"] {
  // Sogni says the Dark Beast community models only work with the filter off;
  // "spicy" is Sogni's tag for models made for mature pictures.
  if (DARK_BEAST.test(id)) return "off-required";
  return tags.includes("spicy") ? "mature" : null;
}

/** See SogniModelInfo.maxReferences. */
export function catalogMaxReferences(parameters: Json): number | null {
  const declared = num(parameters.maxContextImages);
  if (declared !== null && declared >= 1) return Math.floor(declared);
  const benchmark = asRecord(parameters.benchmark);
  const benchmarked = Object.keys(benchmark ?? {})
    .map((key) => /^secContext(\d+)$/.exec(key))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  return benchmarked.length > 0 ? Math.max(...benchmarked) : null;
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
    maxReferences: catalogMaxReferences(p),
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
  [SOGNI_KREA_IDENTITY_EDIT_ALPHA]: "Sogni Krea 2 Identity Edit v0.3 Alpha",
};

/**
 * The picker's list when Sogni's catalog cannot be reached and none was read
 * before: the models Sogni's docs name, by catalog id, with no live details.
 */
export const SOGNI_OFFLINE_MODELS: SogniModelInfo[] = Object.entries(OFFLINE_NAMES).map(([key, name]) => {
  const id = SOGNI_GENERATE_TOOL_KEYS[key] ?? SOGNI_EDIT_TOOL_KEYS[key] ?? key;
  const editOnly = (key in SOGNI_EDIT_TOOL_KEYS || SOGNI_EDIT_CATALOG_ONLY.includes(key)) && !(key in SOGNI_GENERATE_TOOL_KEYS);
  return {
    id,
    name,
    tags: [],
    tier: null,
    generates: !editOnly,
    takesReferences: EDIT_MODEL_IDS.has(id),
    maxReferences: null,
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
  private videoCache: { at: number; updatedAt: string | null; models: SogniVideoModelInfo[] } | null = null;
  private videoFailedAt = -Infinity;
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

  /** The video models (Storylines' video model picker): Sogni's list (fresh, or the last one read), else the built-in list. */
  async videoModels(): Promise<SogniVideoModelList> {
    const cached = this.videoCache;
    if (cached && this.fresh(cached.at)) return { models: cached.models, live: true, updatedAt: cached.updatedAt };
    if (this.now() - this.videoFailedAt >= RETRY_AFTER_FAILURE_MS) {
      try {
        const { status, body } = await this.getJson("/v1/model-catalog?mediaType=video&include=parameters");
        const parsed = status === 200 ? parseSogniVideoCatalog(body) : null;
        if (parsed && parsed.models.length > 0) {
          this.videoCache = { at: this.now(), ...parsed };
          return { models: parsed.models, live: true, updatedAt: parsed.updatedAt };
        }
      } catch {
        // Unreachable: fall through to the last list.
      }
      this.videoFailedAt = this.now();
    }
    if (cached) return { models: cached.models, live: true, updatedAt: cached.updatedAt };
    return { models: SOGNI_OFFLINE_VIDEO_MODELS, live: false, updatedAt: SOGNI_OFFLINE_VIDEO_MODELS_DATE };
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

// ─── Video models (for the Storylines video model picker) ─────────────────────
//
//   GET /v1/model-catalog?mediaType=video&include=parameters   (public, no key)
//   Same envelope as the image catalog. Per model, parameters may carry:
//     durations: [4, 5, ...]                    exact clip lengths (seconds), or
//     frames {min,max,default} + fps {default|allowed}   a range of lengths;
//     acceptInputImage / supports.imageToVideo  takes a start picture;
//     referenceLimits.images                    how many reference pictures;
//     costPerBaseRenderInUSD                    Sogni's own list price per base render;
//     task / requiresReferenceVideo             upscalers and video-to-video tools.
//
// Only models that make a clip from a description (optionally with a start or
// reference picture) are offered: upscalers, video-to-video, audio-to-video and
// animate tools need inputs a storyline shot does not have.

export interface SogniVideoModelInfo {
  id: string;
  name: string;
  tags: string[];
  /** Sogni marks it premium (paid tier only). */
  premium: boolean;
  workersOnline: number | null;
  /** Clip lengths it makes: an exact list, or a min-max range in whole seconds. Null: not published. */
  clipSeconds: { values: number[] } | { min: number; max: number } | null;
  /** Can start from a picture (the shot's approved picture, or the previous clip's last frame). */
  takesStartImage: boolean;
  /** Needs a start picture: without one the shot cannot be made with this model. */
  needsStartImage: boolean;
  /** How many reference (character) pictures it takes; 0 = none. */
  maxReferences: number;
  /** Sogni's own list price per base render, in US dollars (directional; real cost depends on length and size). */
  usdPerBaseRender: number | null;
  creator: string | null;
}

const VIDEO_UNUSABLE = /(^|[_-])(v2v|a2v|ia2v|s2v|flfa2v)($|[_-])|animate-|upscale/i;

function parseVideoModel(value: unknown): SogniVideoModelInfo | null {
  const row = asRecord(value);
  const id = str(row?.id);
  if (!row || !id) return null;
  if (str(row.mediaType) && str(row.mediaType) !== "video") return null;
  const parameters = asRecord(row.parameters) ?? {};
  if (str(parameters.task) || parameters.requiresReferenceVideo === true || VIDEO_UNUSABLE.test(id)) return null;
  const tags = Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [];

  let clipSeconds: SogniVideoModelInfo["clipSeconds"] = null;
  const durations = Array.isArray(parameters.durations) ? parameters.durations.filter((d): d is number => typeof d === "number" && d > 0) : [];
  if (durations.length > 0) {
    clipSeconds = { values: [...new Set(durations)].sort((a, b) => a - b) };
  } else {
    const frames = asRecord(parameters.frames);
    const fps = asRecord(parameters.fps);
    const fpsValue = num(fps?.default) ?? (Array.isArray(fps?.allowed) ? num(fps!.allowed[0]) : null);
    const minFrames = num(frames?.min);
    const maxFrames = num(frames?.max);
    if (fpsValue && fpsValue > 0 && minFrames !== null && maxFrames !== null && maxFrames >= minFrames) {
      const min = Math.max(1, Math.ceil(minFrames / fpsValue));
      const max = Math.max(min, Math.floor(maxFrames / fpsValue));
      clipSeconds = { min, max };
    }
  }

  const supports = asRecord(parameters.supports);
  const referenceImages = num(asRecord(parameters.referenceLimits)?.images) ?? 0;
  const imageInId = /(^|[_-])(i2v|flf2v)($|[_-])/i.test(id) || /-i2v$/i.test(id);
  const referenceInId = /(^|[_-])r2v($|[_-])/i.test(id);
  const takesStartImage = imageInId || parameters.acceptInputImage === true || supports?.imageToVideo === true;
  const textOnlyInId = /(^|[_-])t2v($|[_-])/i.test(id);
  const needsStartImage = imageInId && !textOnlyInId && supports?.textToVideo !== true;
  const maxReferences = referenceInId || str(parameters.inputMode) === "multi-reference" ? Math.max(1, referenceImages) : referenceImages > 1 ? referenceImages : 0;
  const price = Number(parameters.costPerBaseRenderInUSD);
  const workerCounts = asRecord(row.workerCounts);
  const workers = workerCounts ? Object.values(workerCounts).reduce<number>((sum, n) => sum + (num(n) ?? 0), 0) : null;
  return {
    id,
    name: str(row.name) ?? id,
    tags,
    premium: tags.includes("premium") || parameters.premiumOnly === true,
    workersOnline: workers,
    clipSeconds,
    takesStartImage,
    needsStartImage,
    maxReferences,
    usdPerBaseRender: Number.isFinite(price) && price > 0 ? price : null,
    creator: str(asRecord(row.attribution)?.creator),
  };
}

function videoByUsefulness(a: SogniVideoModelInfo, b: SogniVideoModelInfo): number {
  const aOnline = (a.workersOnline ?? 1) > 0;
  const bOnline = (b.workersOnline ?? 1) > 0;
  if (aOnline !== bOnline) return aOnline ? -1 : 1;
  const aPopular = a.tags.includes("popular");
  const bPopular = b.tags.includes("popular");
  if (aPopular !== bPopular) return aPopular ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Parse GET /v1/model-catalog?mediaType=video; null when the answer is not a catalog. */
export function parseSogniVideoCatalog(json: unknown): { updatedAt: string | null; models: SogniVideoModelInfo[] } | null {
  const data = asRecord(asRecord(json)?.data);
  if (!data || !Array.isArray(data.models)) return null;
  const models = data.models.map(parseVideoModel).filter((m): m is SogniVideoModelInfo => m !== null);
  return { updatedAt: str(data.updatedAt), models: models.sort(videoByUsefulness) };
}

/** When the built-in video list below was copied from Sogni's live catalog. */
export const SOGNI_OFFLINE_VIDEO_MODELS_DATE = "2026-10-08";

/**
 * Offered when Sogni's catalog cannot be reached and none was read before: a
 * few of the video models Sogni's live catalog listed on
 * SOGNI_OFFLINE_VIDEO_MODELS_DATE, with no prices or worker counts.
 */
export const SOGNI_OFFLINE_VIDEO_MODELS: SogniVideoModelInfo[] = [
  { id: "seedance-2-0-fast", name: "Seedance 2.0 Fast", premium: true, clip: { values: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] }, start: true, needs: false, refs: 9 },
  { id: "seedance-2-0", name: "Seedance 2.0", premium: true, clip: { values: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] }, start: true, needs: false, refs: 9 },
  { id: "ltx23-22b-fp8_t2v_distilled", name: "LTX-2.3 22B T2V Distilled", premium: false, clip: { min: 2, max: 21 }, start: false, needs: false, refs: 0 },
  { id: "ltx23-22b-fp8_i2v_distilled", name: "LTX-2.3 22B I2V Distilled", premium: false, clip: { min: 2, max: 21 }, start: true, needs: true, refs: 0 },
  { id: "wan_v2.2-14b-fp8_t2v_lightx2v", name: "WAN2.2 14B FP8 t2v LightX2V", premium: false, clip: { min: 2, max: 10 }, start: false, needs: false, refs: 0 },
  { id: "wan_v2.2-14b-fp8_i2v_lightx2v", name: "WAN2.2 14B FP8 i2v LightX2V", premium: false, clip: { min: 2, max: 10 }, start: true, needs: true, refs: 0 },
  { id: "minimax-h3-ref2va-fp8_r2v_turbo", name: "MiniMax H3 Turbo Reference", premium: false, clip: { min: 6, max: 15 }, start: false, needs: false, refs: 9 },
].map((m) => ({
  id: m.id,
  name: m.name,
  tags: m.premium ? ["premium"] : [],
  premium: m.premium,
  workersOnline: null,
  clipSeconds: m.clip,
  takesStartImage: m.start,
  needsStartImage: m.needs,
  maxReferences: m.refs,
  usdPerBaseRender: null,
  creator: null,
}));

export interface SogniVideoModelList {
  models: SogniVideoModelInfo[];
  live: boolean;
  updatedAt: string | null;
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
  options: { maxPerRequest?: number; contentFilterOn: boolean; allowOtherModels?: boolean },
): string | null {
  const max = Math.min(options.maxPerRequest ?? SOGNI_MAX_LORAS, SOGNI_MAX_LORAS);
  if (picks.length > max) return `A picture can use at most ${max} LoRAs; this has ${picks.length}. Remove some.`;
  const seen = new Set<string>();
  for (const pick of picks) {
    if (seen.has(pick.id)) return `The LoRA "${pick.id}" is in the list twice. Keep it once.`;
    seen.add(pick.id);
    const lora = known.find((l) => l.id === pick.id);
    if (!lora) return `Sogni has no LoRA called "${pick.id}" that this account can use. Pick LoRAs from the list.`;
    if (!options.allowOtherModels && !lora.modelIds.includes(sogniCanonicalModelId(model.id))) {
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

/**
 * Whether one LoRA on a look fits the look's model:
 *   "fits"         Sogni lists the model among the LoRA's models.
 *   "other-models" Sogni lists the LoRA, but only for other models (madeFor).
 *   "unknown"      Sogni's LoRA list could not be read, or Sogni does not list
 *                  this LoRA (any more) for this account, so nobody can tell.
 * Sogni's catalog has no "family" field: a LoRA's family is the set of
 * catalog models it lists (modelIds minus restrictedModelIds), so the
 * models' own names are what the owner sees ("Made for Krea 2 Turbo, ...").
 */
export type LoraFit = "fits" | "other-models" | "unknown";

export interface LoraFitCheck {
  id: string;
  name: string;
  fit: LoraFit;
  /** Names of the models Sogni lists for the LoRA (catalog ids where the name is not known). Empty for "unknown". */
  madeFor: string[];
  /** One plain sentence for the owner, or null when the LoRA fits. */
  warning: string | null;
}

/** "A, B and C", or "A, B, C and 2 more" for long lists. */
export function madeForText(names: string[], show = 3): string {
  if (names.length === 0) return "no model Sogni offers right now";
  if (names.length > show) return `${names.slice(0, show).join(", ")} and ${names.length - show} more`;
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Sort a look's LoRAs by whether they fit `model`. `known` null: Sogni's LoRA
 * list could not be read (every LoRA is "unknown"). `modelNames` turns
 * catalog ids into the names people know.
 */
export function classifyLoras(
  model: Pick<SogniModelInfo, "id" | "name">,
  picks: Array<{ id: string; name?: string }>,
  known: SogniLoraInfo[] | null,
  modelNames: Record<string, string> = {},
): LoraFitCheck[] {
  const modelId = sogniCanonicalModelId(model.id);
  return picks.map((pick) => {
    const lora = known?.find((l) => l.id === pick.id) ?? null;
    const name = lora?.name ?? pick.name ?? pick.id;
    if (!lora) {
      const why = known === null ? "Sogni's list of LoRAs could not be read just now, so we" : "Sogni does not list this LoRA for this account any more, so we";
      return { id: pick.id, name, fit: "unknown", madeFor: [], warning: `${why} can't tell whether it works with ${model.name}.` };
    }
    if (lora.modelIds.includes(modelId)) return { id: pick.id, name, fit: "fits", madeFor: [], warning: null };
    const madeFor = [...new Set(lora.modelIds.map((id) => modelNames[id] ?? id))];
    return {
      id: pick.id,
      name,
      fit: "other-models",
      madeFor,
      warning: `Made for ${madeForText(madeFor)}; ${model.name} may ignore it or give odd results.`,
    };
  });
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
