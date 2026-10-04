// DUR-4455: records one cost event for a finished agent/tool-driven Fal call
// (storyboard stills, video shots) at its actual price. Never throws -- a
// cost-recording failure must not fail a generation that already succeeded
// and was paid for; it is logged (without the key) instead.
import { and, eq, gte, lt } from "drizzle-orm";
import { costEvents, type Db } from "@paperclipai/db";
import { sumMicroUsd } from "./cost-sql.js";
import { logger } from "../middleware/logger.js";
import { costService } from "./costs.js";
import { falPricingClient, fetchFalUsageSummary, microUsdToCents, type FalFetchImpl, type FalUsage } from "./fal-pricing.js";

/** Casts a drizzle transaction handle to Db so services written against Db (e.g. costService) can run inside it. */
function asTxDb(tx: unknown): Db {
  return tx as Db;
}

export async function recordFalCostEvent(
  db: Db,
  fetchImpl: FalFetchImpl,
  params: {
    companyId: string;
    apiKey: string;
    agentId: string | null;
    createdByUserId?: string | null;
    model: string;
    usage: FalUsage;
    /** Used when Fal's price is unavailable (cost_source "estimate" either way: only Fal's billing reconciliation upgrades a row to "provider"). */
    estimateCents: number;
    billingCode: string;
    occurredAt?: Date;
  },
): Promise<{ costCents: number; costMicroUsd: number } | null> {
  try {
    const priced = await falPricingClient(fetchImpl).priceCall(params.apiKey, params.model, params.usage, params.companyId);
    const costMicroUsd = priced?.costMicroUsd ?? params.estimateCents * 10_000;
    const costCents = priced ? microUsdToCents(priced.costMicroUsd) : params.estimateCents;
    await costService(db).createEvent(params.companyId, {
      agentId: params.agentId,
      createdByUserId: params.createdByUserId ?? null,
      provider: "fal",
      biller: "fal",
      billingType: "metered_api",
      billingCode: params.billingCode,
      model: params.model,
      costCents,
      costMicroUsd,
      costSource: "estimate",
      occurredAt: params.occurredAt ?? new Date(),
    });
    return { costCents, costMicroUsd };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : "unknown", model: params.model }, "fal cost event could not be recorded");
    return null;
  }
}

export const FAL_RECONCILIATION_BILLING_CODE = "fal-reconciliation";
/** Within this drift (1 cent) our recorded total is considered confirmed by Fal's billing. */
const RECONCILIATION_TOLERANCE_MICRO_USD = 10_000;

/**
 * Daily reconciliation of one UTC day's Fal cost events against Fal's usage
 * API (needs an ADMIN-scoped key; without it this is a no-op returning
 * "skipped"). Idempotent per (company, day): re-running replaces the
 * previous adjustment row.
 *  - within tolerance: that day's Fal rows are marked cost_source "provider".
 *  - Fal billed more than recorded (beyond tolerance): one adjustment row
 *    (billing_code fal-reconciliation, cost_source "provider") brings the
 *    day's total up to Fal's billed figure, written through costService so
 *    spentMonthlyCents and budget caps are re-evaluated immediately.
 *  - Fal billed less than recorded (beyond tolerance): never auto-decreases
 *    tracked spend -- an empty/incomplete usage response must not be able to
 *    zero out a day's real cost and silently lift a budget cap. No
 *    adjustment row is written; the mismatch is still returned so the daily
 *    job can still alert the owner through the soft-incident path.
 */
export async function reconcileFalDay(
  db: Db,
  fetchImpl: FalFetchImpl,
  params: { companyId: string; adminKey: string; day: Date },
): Promise<{ status: "skipped" } | { status: "confirmed" | "adjusted"; billedMicroUsd: number; recordedMicroUsd: number; deltaMicroUsd: number }> {
  const start = new Date(Date.UTC(params.day.getUTCFullYear(), params.day.getUTCMonth(), params.day.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const usage = await fetchFalUsageSummary(fetchImpl, params.adminKey, { start, end });
  if (!usage) return { status: "skipped" };

  const dayCode = `${FAL_RECONCILIATION_BILLING_CODE}:${start.toISOString().slice(0, 10)}`;
  return db.transaction(async (tx) => {
    await tx.delete(costEvents).where(and(eq(costEvents.companyId, params.companyId), eq(costEvents.billingCode, dayCode)));
    const [row] = await tx
      .select({ total: sumMicroUsd() })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, params.companyId), eq(costEvents.provider, "fal"), gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end)));
    const recordedMicroUsd = Math.round(Number(row?.total ?? 0));
    const deltaMicroUsd = usage.totalMicroUsd - recordedMicroUsd;
    if (Math.abs(deltaMicroUsd) <= RECONCILIATION_TOLERANCE_MICRO_USD) {
      await tx
        .update(costEvents)
        .set({ costSource: "provider" })
        .where(and(eq(costEvents.companyId, params.companyId), eq(costEvents.provider, "fal"), gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end)));
      return { status: "confirmed" as const, billedMicroUsd: usage.totalMicroUsd, recordedMicroUsd, deltaMicroUsd };
    }
    if (deltaMicroUsd > 0) {
      // Only ever top up recorded spend to match Fal's billed figure. A
      // negative delta (Fal billed less, e.g. an empty usage page) is never
      // written as a cost row -- see reconcileFalDay's doc comment.
      await costService(asTxDb(tx)).createEvent(params.companyId, {
        agentId: null,
        provider: "fal",
        biller: "fal",
        billingType: "metered_api",
        billingCode: dayCode,
        model: "reconciliation",
        costCents: Math.round(deltaMicroUsd / 10_000),
        costMicroUsd: deltaMicroUsd,
        costSource: "provider",
        occurredAt: new Date(end.getTime() - 1),
      });
    }
    return { status: "adjusted" as const, billedMicroUsd: usage.totalMicroUsd, recordedMicroUsd, deltaMicroUsd };
  });
}
