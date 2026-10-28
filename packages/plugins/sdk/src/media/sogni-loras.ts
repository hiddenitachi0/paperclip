// Sogni's public LoRA list, shared by the Media Studio plugin worker and the
// server. Pure TypeScript with no dependencies. The plugin UI does not import
// this (it cannot reach the SDK's worker-side code and keeps its own copy of
// the few types it renders).
//
//   GET https://api.sogni.ai/v1/loras/comfy                       (public, no key)
//   {data:{loras:[{loraId, name, description, modelIds, restrictedModelIds?,
//   ui:{min, max, default, step, recommendedMin, recommendedMax, rangeLabels?,
//   category, nsfw, sexual, creator, sourceUrl}}], models:[...],
//   constraints:{maxPerRequest, minStrength, maxStrength}}}
//
// A LoRA works with the catalog model ids in modelIds, minus restrictedModelIds.
// ui.nsfw: Sogni says the LoRA needs the Sensitive Content Filter off.
// ui.sexual: Sogni marks the LoRA as making sexual content.

/** The only address this module ever reads. */
export const SOGNI_LORA_CATALOG_URL = "https://api.sogni.ai/v1/loras/comfy";
export const SOGNI_LORA_CATALOG_TTL_MS = 10 * 60 * 1000;
/** After a failed read, wait this long before asking Sogni again (the old list is used meanwhile). */
export const SOGNI_LORA_CATALOG_RETRY_MS = 30 * 1000;
const SOGNI_LORA_CATALOG_TIMEOUT_MS = 15 * 1000;
const SOGNI_LORA_CATALOG_MAX_BYTES = 5 * 1024 * 1024;
/** Sogni takes at most this many LoRAs on one picture. */
export const SOGNI_MAX_LORAS = 8;

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
  /** Sogni (ui.nsfw): "requires the artist to have the Sensitive Content Filter off". */
  needsFilterOff: boolean;
  /** Sogni (ui.sexual): the LoRA makes sexual content. */
  sexual: boolean;
  creator: string | null;
  sourceUrl: string | null;
}

export interface SogniLoraCatalog {
  loras: SogniLoraInfo[];
  /** Every catalog model id that takes at least one LoRA. */
  models: string[];
  maxPerRequest: number;
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
    sexual: ui.sexual === true,
    creator: str(ui.creator),
    sourceUrl: httpsUrl(ui.sourceUrl),
  };
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

/** The LoRAs that work with one model (a catalog model id), in Sogni's order. */
export function lorasForModel(catalog: SogniLoraCatalog | null, catalogModelId: string): SogniLoraInfo[] {
  return (catalog?.loras ?? []).filter((lora) => lora.modelIds.includes(catalogModelId));
}

export type SogniFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface SogniLoraCatalogCacheOptions {
  /** Defaults to the global fetch. Only ever called with SOGNI_LORA_CATALOG_URL. */
  fetch?: SogniFetch;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Reads Sogni's public LoRA list and keeps it in memory for 10 minutes. Each
 * process (the plugin worker, the server) makes its own instance and keeps its
 * own copy. When Sogni cannot be reached the last list is used; with no list
 * at all the answer is null (callers must treat that as "unknown").
 */
export class SogniLoraCatalogCache {
  private readonly fetchImpl: SogniFetch;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cache: { at: number; catalog: SogniLoraCatalog } | null = null;
  private failedAt = -Infinity;
  private inflight: Promise<SogniLoraCatalog | null> | null = null;

  constructor(options: SogniLoraCatalogCacheOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.ttlMs = options.ttlMs ?? SOGNI_LORA_CATALOG_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Sogni's public LoRAs (all models); null when they could not be read and none were read before. */
  async get(): Promise<SogniLoraCatalog | null> {
    const cached = this.cache;
    if (cached && this.now() - cached.at < this.ttlMs) return cached.catalog;
    if (this.now() - this.failedAt < SOGNI_LORA_CATALOG_RETRY_MS) return cached?.catalog ?? null;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return (await this.inflight) ?? cached?.catalog ?? null;
  }

  /** The last list read, without waiting or asking Sogni. */
  peek(): SogniLoraCatalog | null {
    return this.cache?.catalog ?? null;
  }

  private async refresh(): Promise<SogniLoraCatalog | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Sogni LoRA catalog timed out"));
        }, SOGNI_LORA_CATALOG_TIMEOUT_MS);
      });
      const read = (async () => {
        // redirect: "error" keeps this to the one fixed address even with the default fetch.
        const res = await this.fetchImpl(SOGNI_LORA_CATALOG_URL, { method: "GET", headers: { Accept: "application/json" }, redirect: "error", signal: controller.signal });
        if (res.status !== 200) return null;
        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > SOGNI_LORA_CATALOG_MAX_BYTES) return null;
        const text = await res.text();
        if (text.length > SOGNI_LORA_CATALOG_MAX_BYTES) return null;
        return parseSogniLoraCatalog(JSON.parse(text));
      })();
      read.catch(() => undefined);
      const parsed = await Promise.race([read, timeout]);
      if (parsed) {
        this.cache = { at: this.now(), catalog: parsed };
        return parsed;
      }
    } catch {
      // Unreachable or not JSON: fall through to the last list.
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.failedAt = this.now();
    return null;
  }
}

// ─── LoRA fit check ───────────────────────────────────────────────────────────

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
 * Sort a look's LoRAs by whether they fit `model` (its catalog id, not a tool
 * key). `known` null: Sogni's LoRA list could not be read (every LoRA is
 * "unknown"). `modelNames` turns catalog ids into the names people know.
 */
export function classifyLoras(
  model: { id: string; name: string },
  picks: Array<{ id: string; name?: string }>,
  known: SogniLoraInfo[] | null,
  modelNames: Record<string, string> = {},
): LoraFitCheck[] {
  return picks.map((pick) => {
    const lora = known?.find((l) => l.id === pick.id) ?? null;
    const name = lora?.name ?? pick.name ?? pick.id;
    if (!lora) {
      const why = known === null ? "Sogni's list of LoRAs could not be read just now, so we" : "Sogni does not list this LoRA for this account any more, so we";
      return { id: pick.id, name, fit: "unknown", madeFor: [], warning: `${why} can't tell whether it works with ${model.name}.` };
    }
    if (lora.modelIds.includes(model.id)) return { id: pick.id, name, fit: "fits", madeFor: [], warning: null };
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
