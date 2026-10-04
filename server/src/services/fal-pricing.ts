// DUR-4455: Fal actual-cost pricing. Fal publishes a per-endpoint price
// (GET https://api.fal.ai/v1/models/pricing?endpoint_id=...) as a unit price
// plus the unit it is charged in (images, megapixels, seconds, ...). The
// actual cost of a call is unit_price * the quantity in that unit.
//
// Security: the Fal key is only ever sent as the Authorization header to the
// fixed api.fal.ai host and is never part of a thrown message, log line or
// returned value from this module.

export type FalFetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export const FAL_API_BASE = "https://api.fal.ai";
const FAL_ENDPOINT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i;
const PRICE_CACHE_TTL_MS = 60 * 60 * 1000;
const MICRO_USD_PER_USD = 1_000_000;

export type FalPriceUnit = "images" | "megapixels" | "seconds" | "units";

export interface FalEndpointPrice {
  endpointId: string;
  unitPrice: number;
  /** Fal's own unit label, verbatim (for audit). */
  rawUnit: string;
  unit: FalPriceUnit | null;
}

/** What a finished Fal call produced, in each unit Fal might bill by. */
export interface FalUsage {
  images?: number;
  megapixels?: number;
  seconds?: number;
  units?: number;
}

/** Normalizes Fal's free-form unit label ("image", "megapixels", "video seconds", ...). Unknown labels return null (caller falls back to the estimate). */
export function normalizeFalUnit(raw: string): FalPriceUnit | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("megapixel") || s === "mp") return "megapixels";
  if (s.includes("image")) return "images";
  if (s.includes("second") || s === "s" || s === "sec") return "seconds";
  if (s === "unit" || s === "units" || s === "request" || s === "requests" || s === "call" || s === "calls") return "units";
  return null;
}

/** Exact cost in micro-USD (rounded to the nearest micro-dollar), or null when the usage does not cover the endpoint's billing unit. */
export function computeFalCostMicroUsd(price: Pick<FalEndpointPrice, "unitPrice" | "unit">, usage: FalUsage): number | null {
  if (!price.unit || !Number.isFinite(price.unitPrice) || price.unitPrice < 0) return null;
  const quantity = price.unit === "units" ? (usage.units ?? 1) : usage[price.unit];
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0) return null;
  return Math.round(price.unitPrice * quantity * MICRO_USD_PER_USD);
}

/** Megapixels of one image from its pixel size (Fal bills image models per megapixel, rounded up to a whole megapixel for most endpoints -- we use the exact figure, matching the usage API's quantity). */
export function megapixelsOf(width: number, height: number): number {
  return (width * height) / 1_000_000;
}

export function microUsdToCents(micro: number): number {
  // Conservative whole-cent figure for the legacy integer cost_cents column: never under-counts a non-zero cost.
  return micro <= 0 ? 0 : Math.ceil(micro / 10_000);
}

export function falPricingClient(fetchImpl: FalFetchImpl, now: () => number = Date.now) {
  const cache = new Map<string, { price: FalEndpointPrice; at: number }>();

  async function getPrice(apiKey: string, endpointId: string, cacheScope: string): Promise<FalEndpointPrice | null> {
    const id = endpointId.trim();
    if (!FAL_ENDPOINT_ID_PATTERN.test(id) || id.includes("..") || id.length > 200) return null;
    // Prices can be account-specific (custom pricing), so the cache is scoped per company, never shared across them.
    const cacheKey = `${cacheScope}:${id}`;
    const hit = cache.get(cacheKey);
    if (hit && now() - hit.at < PRICE_CACHE_TTL_MS) return hit.price;
    try {
      const res = await fetchImpl(`${FAL_API_BASE}/v1/models/pricing?endpoint_id=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { prices?: Array<{ endpoint_id?: string; unit_price?: number; unit?: string; currency?: string }> };
      const row = data.prices?.find((p) => p.endpoint_id === id);
      if (!row || typeof row.unit_price !== "number" || typeof row.unit !== "string") return null;
      if (row.currency && row.currency.toUpperCase() !== "USD") return null;
      const price: FalEndpointPrice = { endpointId: id, unitPrice: row.unit_price, rawUnit: row.unit, unit: normalizeFalUnit(row.unit) };
      cache.set(cacheKey, { price, at: now() });
      return price;
    } catch {
      return null;
    }
  }

  /** Actual cost for a finished call, or null when Fal's price/unit is unavailable (caller records the estimate instead). */
  async function priceCall(apiKey: string, endpointId: string, usage: FalUsage, cacheScope: string): Promise<{ costMicroUsd: number; price: FalEndpointPrice } | null> {
    const price = await getPrice(apiKey, endpointId, cacheScope);
    if (!price) return null;
    const costMicroUsd = computeFalCostMicroUsd(price, usage);
    return costMicroUsd === null ? null : { costMicroUsd, price };
  }

  return { getPrice, priceCall };
}

export interface FalUsageSummary {
  /** Total billed USD for the window, after discounts. */
  totalMicroUsd: number;
}

/**
 * Daily billing reconciliation input: Fal's usage API (GET /v1/models/usage)
 * needs an ADMIN-scoped key. Returns null when the key lacks that scope
 * (401/403) or the call fails -- reconciliation is then skipped, not an error.
 */
export async function fetchFalUsageSummary(
  fetchImpl: FalFetchImpl,
  adminKey: string,
  window: { start: Date; end: Date },
): Promise<FalUsageSummary | null> {
  let totalMicroUsd = 0;
  let cursor: string | null = null;
  try {
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ start: window.start.toISOString(), end: window.end.toISOString(), expand: "summary", limit: "50" });
      if (cursor) qs.set("cursor", cursor);
      const res = await fetchImpl(`${FAL_API_BASE}/v1/models/usage?${qs.toString()}`, { headers: { Authorization: `Key ${adminKey}` } });
      if (!res.ok) return null;
      const data = (await res.json()) as { summary?: Array<{ cost_total?: number; currency?: string }>; has_more?: boolean; next_cursor?: string | null };
      for (const row of data.summary ?? []) {
        if (typeof row.cost_total === "number" && (!row.currency || row.currency.toUpperCase() === "USD")) {
          totalMicroUsd += Math.round(row.cost_total * MICRO_USD_PER_USD);
        }
      }
      if (!data.has_more || !data.next_cursor) return { totalMicroUsd };
      cursor = data.next_cursor;
    }
    return null;
  } catch {
    return null;
  }
}
