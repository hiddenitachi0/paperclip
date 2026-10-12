// Settings > Models, OpenRouter hosts: which hosts run one OpenRouter model and
// what each supports (tool calling, pictures, thinking, price, context). Read
// live from OpenRouter's public endpoint list, per model, because support
// differs per model AND per host. Same conventions as the price catalogue
// (lane-a-openrouter-catalogue.ts): fetched WITHOUT any credential, only from
// openrouter.ai, no redirects, a time limit and a body size cap.
import {
  isOpenRouterModelId,
  openRouterHostSlugFromTag,
  type OpenRouterHost,
  type OpenRouterHostsResult,
} from "@paperclipai/shared";
import { HttpError, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { OPENROUTER_MODELS_URL } from "./lane-a-openrouter-catalogue.js";

const OPENROUTER_HOSTNAME = "openrouter.ai";
export const OPENROUTER_HOSTS_TTL_MS = 10 * 60 * 1000;
/** "Refresh hosts" skips the cache, but not more often than this per model. */
export const OPENROUTER_HOSTS_MIN_REFRESH_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CACHE_MAX_MODELS = 300;

type CacheEntry = { fetchedAt: number; result: OpenRouterHostsResult };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<OpenRouterHostsResult>>();

/** The endpoint-list URL for one model id, or null when the id is not one (never anything but openrouter.ai). */
export function openRouterEndpointsUrl(model: string): string | null {
  if (!isOpenRouterModelId(model)) return null;
  const url = new URL(`${OPENROUTER_MODELS_URL}/${model}/endpoints`);
  if (url.protocol !== "https:" || url.hostname !== OPENROUTER_HOSTNAME) return null;
  if (url.pathname !== `/api/v1/models/${model}/endpoints`) return null;
  return url.toString();
}

function num(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

function perMillion(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.round(n * 1_000_000 * 10_000) / 10_000;
}

function text(value: unknown, max = 80): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** OpenRouter's endpoint list for one model, normalised. Bad rows are skipped, never forwarded. */
export function parseOpenRouterEndpoints(payload: unknown): { hosts: OpenRouterHost[] } | null {
  const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : null;
  if (!data || typeof data !== "object") return null;
  const record = data as { endpoints?: unknown; architecture?: unknown };
  if (!Array.isArray(record.endpoints)) return null;
  const architecture = record.architecture && typeof record.architecture === "object" ? record.architecture : {};
  const modalities = (architecture as { input_modalities?: unknown }).input_modalities;
  const supportsImages = Array.isArray(modalities) && modalities.includes("image");
  const hosts: OpenRouterHost[] = [];
  for (const raw of record.endpoints.slice(0, 200)) {
    if (!raw || typeof raw !== "object") continue;
    const endpoint = raw as Record<string, unknown>;
    // The tag is the routing name; the display name is never guessed into one.
    const slug = openRouterHostSlugFromTag(endpoint.tag);
    if (!slug) continue;
    const params = Array.isArray(endpoint.supported_parameters)
      ? endpoint.supported_parameters.filter((p): p is string => typeof p === "string")
      : [];
    const pricing = endpoint.pricing && typeof endpoint.pricing === "object" ? (endpoint.pricing as Record<string, unknown>) : {};
    const status = typeof endpoint.status === "number" ? (endpoint.status < 0 ? "degraded" : "ok") : "unknown";
    const uptime = num(endpoint.uptime_last_30m);
    hosts.push({
      slug,
      name: text(endpoint.provider_name) ?? slug,
      quantization: text(endpoint.quantization, 40),
      contextTokens: num(endpoint.context_length),
      maxOutputTokens: num(endpoint.max_completion_tokens),
      priceInPerM: perMillion(pricing.prompt),
      priceOutPerM: perMillion(pricing.completion),
      supportsTools: params.includes("tools"),
      supportsToolChoice: params.includes("tool_choice"),
      supportsReasoning: params.includes("reasoning") || params.includes("include_reasoning"),
      supportsImages,
      status,
      uptimeLast30m: uptime === null ? null : Math.min(100, Math.round(uptime * 10) / 10),
    });
  }
  return { hosts };
}

const unavailable = () =>
  new HttpError(502, "Could not read the host list from OpenRouter just now. Try again in a minute.");

async function loadHosts(model: string, url: string, fetchImpl: typeof fetch, now: number): Promise<OpenRouterHostsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    });
    if (res.status === 404) throw notFound(`OpenRouter does not know the model "${model}". Check the model id.`);
    if (!res.ok) throw unavailable();
    const body = await res.text();
    if (body.length > MAX_BODY_BYTES) throw unavailable();
    const parsed = parseOpenRouterEndpoints(JSON.parse(body));
    if (!parsed) throw unavailable();
    return { model, fetchedAt: new Date(now).toISOString(), hosts: parsed.hosts };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.warn({ err: err instanceof Error ? err.message : String(err), model }, "could not fetch OpenRouter hosts");
    throw unavailable();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The hosts that run one OpenRouter model. Cached ~10 minutes per model; a
 * failed fetch is not cached; concurrent calls for one model share a request.
 * `refresh` skips the cache when it is older than 30 seconds.
 */
export async function openRouterHostsForModel(
  model: string,
  opts: { fetchImpl?: typeof fetch; now?: number; refresh?: boolean } = {},
): Promise<OpenRouterHostsResult> {
  const id = model.trim();
  const url = openRouterEndpointsUrl(id);
  if (!url) {
    throw unprocessable('That is not an OpenRouter model id. It looks like "maker/model", e.g. "qwen/qwen3.8-27b".');
  }
  const key = id.toLowerCase();
  const now = opts.now ?? Date.now();
  const cached = cache.get(key);
  const maxAge = opts.refresh ? OPENROUTER_HOSTS_MIN_REFRESH_MS : OPENROUTER_HOSTS_TTL_MS;
  if (cached && now - cached.fetchedAt < maxAge) return cached.result;
  let pending = inflight.get(key);
  if (!pending) {
    pending = loadHosts(id, url, opts.fetchImpl ?? fetch, now)
      .then((result) => {
        if (cache.size >= CACHE_MAX_MODELS && !cache.has(key)) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, { fetchedAt: now, result });
        return result;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, pending);
  }
  return pending;
}

export function resetOpenRouterHostsCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
