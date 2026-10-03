import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents } from "@paperclipai/db";
import { costService } from "./costs.js";
import { logger } from "../middleware/logger.js";

/**
 * DUR-4455: real Fal cost. Fal publishes a per-endpoint unit price
 * (GET https://api.fal.ai/v1/models/pricing?endpoint_id=..., response
 * { prices: [{ endpoint_id, unit_price, unit, currency }] }) and, for ADMIN
 * scope keys only, a billing report (GET https://api.fal.ai/v1/models/usage,
 * time_series[].results[].cost_total). Both take `Authorization: Key <key>`.
 *
 * The key is server-side only: it is passed to fetch headers and never put
 * in a cost row, log line, error message or return value here.
 */

type FetchImpl = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export const FAL_API_BASE = "https://api.fal.ai/v1";
export const FAL_PRICING_COST_SOURCE = "estimate";
export const FAL_PROVIDER_COST_SOURCE = "provider";
export const FAL_RECONCILIATION_BILLING_CODE = "fal_usage_reconciliation";

export interface FalUnitPrice {
  unit: string;
  unitPrice: number;
}

/** What one finished call consumed; whichever field matches the endpoint's billing unit is used. */
export interface FalUsage {
  images?: number;
  width?: number;
  height?: number;
  seconds?: number;
}

const UNIT_ALIASES: Record<string, "image" | "megapixel" | "second" | "request"> = {
  image: "image",
  images: "image",
  megapixel: "megapixel",
  megapixels: "megapixel",
  mp: "megapixel",
  second: "second",
  seconds: "second",
  video: "request",
  videos: "request",
  request: "request",
  requests: "request",
  unit: "request",
  units: "request",
};

/** Micro-USD for a call (1 micro-USD = 1e-6 USD), or null if the unit is unknown or the needed usage is missing. */
export function computeFalCostMicroUsd(price: FalUnitPrice, usage: FalUsage): number | null {
  if (!Number.isFinite(price.unitPrice) || price.unitPrice < 0) return null;
  const kind = UNIT_ALIASES[price.unit.trim().toLowerCase()];
  let quantity: number | null = null;
  if (kind === "image") quantity = usage.images ?? 1;
  else if (kind === "megapixel") {
    if (usage.width && usage.height && usage.width > 0 && usage.height > 0) {
      quantity = ((usage.width * usage.height) / 1_000_000) * (usage.images ?? 1);
    }
  } else if (kind === "second") quantity = usage.seconds !== undefined && usage.seconds > 0 ? usage.seconds : null;
  else if (kind === "request") quantity = 1;
  if (quantity === null || !(quantity > 0)) return null;
  return Math.max(1, Math.round(quantity * price.unitPrice * 1_000_000));
}

const microToCents = (micro: number) => Math.round(micro / 10_000);

const PRICE_TTL_MS = 6 * 60 * 60 * 1000;
const priceCache = new Map<string, { at: number; price: FalUnitPrice | null }>();

export function clearFalPriceCache(): void {
  priceCache.clear();
}

/** Fal's published price for one endpoint, or null when it cannot be fetched (never throws; never logs the key). */
export async function fetchFalUnitPrice(fetchImpl: FetchImpl, apiKey: string, endpointId: string, now = Date.now()): Promise<FalUnitPrice | null> {
  const hit = priceCache.get(endpointId);
  if (hit && now - hit.at < PRICE_TTL_MS) return hit.price;
  let price: FalUnitPrice | null = null;
  try {
    const res = await fetchImpl(`${FAL_API_BASE}/models/pricing?endpoint_id=${encodeURIComponent(endpointId)}`, {
      method: "GET",
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (res.ok) {
      const body = (await res.json()) as { prices?: Array<{ endpoint_id?: string; unit_price?: unknown; unit?: unknown }> };
      const row = body.prices?.find((p) => p.endpoint_id === endpointId) ?? body.prices?.[0];
      if (row && typeof row.unit_price === "number" && typeof row.unit === "string") price = { unit: row.unit, unitPrice: row.unit_price };
    } else {
    
    }
  } catch {
    logger.warn({ endpointId }, "Fal pricing lookup failed");
  }
  if (price) priceCache.set(endpointId, { at: now, price });
  return price;
}

export interface FalActualCost {
  costCents: number;
  costMicroUsd: number;
  costSource: typeof FAL_PRICING_COST_SOURCE;
}

/**
 * Prices a finished call from Fal's published per-unit price. Returns null
 * when pricing is unavailable, so the caller keeps its estimate (and says so).
 */
export async function priceFalCall(fetchImpl: FetchImpl, apiKey: string, endpointId: string, usage: FalUsage): Promise<FalActualCost | null> {
  const price = await fetchFalUnitPrice(fetchImpl, apiKey, endpointId);
  if (!price) return null;

  const micro = computeFalCostMicroUsd(price, usage);
  if (micro === null) return null;
  return { costCents: microToCents(micro), costMicroUsd: micro, costSource: FAL_PRICING_COST_SOURCE };
}

/** Replaces a reservation's estimate on its cost event with the actual figure. */
export async function applyFalActualCost(db: Pick<Db, "update">, costEventId: string, actual: FalActualCost): Promise<void> {
  await db
    .update(costEvents)
    .set({ costCents: actual.costCents, costMicroUsd: actual.costMicroUsd, costSource: actual.costSource })
    .where(eq(costEvents.id, costEventId));
}

export interface FalReconciliationResult {
  status: "reconciled" | "skipped";
  reason?: "usage_api_unavailable";
  billedMicroUsd?: number;
  recordedMicroUsd?: number;
  adjustmentMicroUsd?: number;
}

/**
 * Daily reconciliation against Fal's usage API for [start, end). Needs an
 * ADMIN-scope key; a normal key gets 401/403 and the run is skipped (the
 * price-computed rows stay as the estimate). If Fal billed more than we
 * recorded for the window, one adjustment row (cost_source "provider") books
 * the difference so the total matches Fal's invoice; never a negative row.
 * Idempotent per window: an existing adjustment for the window is replaced.
 */
export async function reconcileFalUsage(
  db: Db,
  fetchImpl: FetchImpl,
  input: { companyId: string; adminApiKey: string; start: Date; end: Date },
): Promise<FalReconciliationResult> {
  let billedUsd = 0;
  try {
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams({ start: input.start.toISOString(), end: input.end.toISOString(), timeframe: "day", expand: "summary" });
      if (cursor) qs.set("cursor", cursor);
      const res = await fetchImpl(`${FAL_API_BASE}/models/usage?${qs.toString()}`, { method: "GET", headers: { Authorization: `Key ${input.adminApiKey}` } });
      if (!res.ok) {
        logger.warn({ status: res.status }, "Fal usage reconciliation skipped: usage API not available to this key");
        return { status: "skipped", reason: "usage_api_unavailable" };
      }
      const body = (await res.json()) as { summary?: Array<{ cost_total?: unknown }>; has_more?: boolean; next_cursor?: string | null };
      for (const row of body.summary ?? []) if (typeof row.cost_total === "number") billedUsd += row.cost_total;
      cursor = body.has_more && body.next_cursor ? body.next_cursor : null;
    } while (cursor);
  } catch {
    logger.warn("Fal usage reconciliation skipped: usage API request failed");
    return { status: "skipped", reason: "usage_api_unavailable" };
  }
  const billedMicroUsd = Math.round(billedUsd * 1_000_000);

  const window = and(
    eq(costEvents.companyId, input.companyId),
    eq(costEvents.provider, "fal"),
    gte(costEvents.occurredAt, input.start),
    lt(costEvents.occurredAt, input.end),
  );
  // Drop a previous adjustment for this window first so reruns do not double count.
  await db.delete(costEvents).where(and(window, eq(costEvents.billingCode, FAL_RECONCILIATION_BILLING_CODE), eq(costEvents.costSource, FAL_PROVIDER_COST_SOURCE)));
  const [row] = await db
    .select({ micro: sql<string>`coalesce(sum(coalesce(${costEvents.costMicroUsd}, ${costEvents.costCents} * 10000)), 0)` })
    .from(costEvents)
    .where(window);
  const recordedMicroUsd = Number(row?.micro ?? 0);
  const adjustmentMicroUsd = Math.max(0, billedMicroUsd - recordedMicroUsd);
  if (adjustmentMicroUsd > 0) {
    await costService(db).createEvent(input.companyId, {
      agentId: null,
      provider: "fal",
      biller: "fal",
      billingType: "metered_api",
      billingCode: FAL_RECONCILIATION_BILLING_CODE,
      model: "usage-reconciliation",
      inputTokens: 0,
      outputTokens: 0,
      costCents: microToCents(adjustmentMicroUsd),
      costMicroUsd: adjustmentMicroUsd,
      costSource: FAL_PROVIDER_COST_SOURCE,
      occurredAt: new Date(input.end.getTime() - 1),
    });
  }
  return { status: "reconciled", billedMicroUsd, recordedMicroUsd, adjustmentMicroUsd };
}
