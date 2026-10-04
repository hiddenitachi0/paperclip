// DUR-4454: OpenRouter's public model list as a price source for a call whose
// response carried no `usage.cost` (e.g. a model released after Paperclip's
// static table was written). The /models endpoint is public: it is fetched
// WITHOUT any credential, so the key can never reach this request or its logs.
import { logger } from "../middleware/logger.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface OpenRouterModelPrice {
  /** USD per token, as OpenRouter publishes it. */
  promptUsdPerToken: number;
  completionUsdPerToken: number;
}

let cache: { fetchedAt: number; prices: Map<string, OpenRouterModelPrice> } | null = null;
let inflight: Promise<Map<string, OpenRouterModelPrice> | null> | null = null;

function parsePrice(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseOpenRouterModels(payload: unknown): Map<string, OpenRouterModelPrice> {
  const out = new Map<string, OpenRouterModelPrice>();
  const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : null;
  if (!Array.isArray(data)) return out;
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { id?: unknown; pricing?: unknown };
    if (typeof entry.id !== "string" || !entry.pricing || typeof entry.pricing !== "object") continue;
    const pricing = entry.pricing as { prompt?: unknown; completion?: unknown };
    const prompt = parsePrice(pricing.prompt);
    const completion = parsePrice(pricing.completion);
    if (prompt === null || completion === null) continue;
    out.set(entry.id, { promptUsdPerToken: prompt, completionUsdPerToken: completion });
  }
  return out;
}

async function loadCatalogue(fetchImpl: typeof fetch): Promise<Map<string, OpenRouterModelPrice> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(OPENROUTER_MODELS_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) return null;
    const prices = parseOpenRouterModels(JSON.parse(text));
    return prices.size > 0 ? prices : null;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "lane A: could not fetch the OpenRouter model price list");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Price for one OpenRouter model id, or null when the list is unavailable or
 * does not know the model. Cached for a day; a failed fetch is not cached
 * (the next call tries again) but concurrent calls share one request. A stale
 * cache is kept if a refresh fails.
 */
export async function openRouterCataloguePrice(
  model: string,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<OpenRouterModelPrice | null> {
  const now = opts.now ?? Date.now();
  if (!cache || now - cache.fetchedAt >= CATALOGUE_TTL_MS) {
    if (!inflight) {
      inflight = loadCatalogue(opts.fetchImpl ?? fetch)
        .then((prices) => {
          if (prices) cache = { fetchedAt: now, prices };
          return prices;
        })
        .finally(() => {
          inflight = null;
        });
    }
    await inflight;
  }
  return cache?.prices.get(model) ?? null;
}

export function resetOpenRouterCatalogueCacheForTests(): void {
  cache = null;
  inflight = null;
}
