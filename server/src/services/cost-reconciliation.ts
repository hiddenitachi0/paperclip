// DUR-4462: the daily Fal + Sogni billing reconciliation job.
//
// Once per UTC day per company (the tick may run hourly; run rows make it
// idempotent) it
//  - checks yesterday's recorded Fal spend against Fal's usage API
//    (reconcileFalDay) using a separate ADMIN-scope key, Media Studio config
//    key falAdminKeySecretRef -- never the generation key, whose scope is
//    unverified and which must not be widened;
//  - compares the Sogni Spark balance drop since the last stored snapshot
//    with the credits we recorded (reconcileSogniBalance), then stores the new
//    snapshot;
//  - files the owner notice through the existing budget soft-incident path
//    when a mismatch reaches the company's `cost_reconciliation_mismatch_cents`
//    budget policy threshold.
// Missing prerequisites (no key, no credit price, provider error) write
// nothing and are retried on the next tick, so fixing the config takes effect
// within the hour. Keys are resolved through the secrets service (audited) and
// never logged or stored.
import { and, eq } from "drizzle-orm";
import { companySecrets, costReconciliationRuns, sogniBalanceSnapshots, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { budgetService } from "./budgets.js";
import { reconcileFalDay } from "./fal-cost-events.js";
import type { FalFetchImpl } from "./fal-pricing.js";
import { reconcileSogniBalance, type SogniFetch } from "./sogni-reconciliation.js";
import { SOGNI_CREDIT_PRICE_CONFIG_KEY } from "./sogni-cost.js";

export const FAL_ADMIN_KEY_CONFIG_KEY = "falAdminKeySecretRef";

export interface CostReconciliationDeps {
  getConfig: () => Promise<Record<string, unknown>>;
  resolveSecret: (companyId: string, secretId: string) => Promise<string>;
  falFetch: FalFetchImpl;
  sogniFetch: SogniFetch;
  now?: () => Date;
}

export type CostReconciliationOutcome = {
  companyId: string;
  fal: "reconciled" | "already_done" | "no_admin_key" | "skipped";
  sogni: "reconciled" | "baseline" | "already_done" | "no_key" | "skipped";
};

const dayString = (d: Date) => d.toISOString().slice(0, 10);
const asRef = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The company that owns a secret id, or null. A ref owned by another company is never resolved for this one. */
async function secretOwner(db: Db, secretId: string): Promise<string | null> {
  const [row] = await db.select({ companyId: companySecrets.companyId }).from(companySecrets).where(eq(companySecrets.id, secretId));
  return row?.companyId ?? null;
}

async function alreadyRan(db: Db, companyId: string, provider: string, day: string): Promise<boolean> {
  const [row] = await db
    .select({ id: costReconciliationRuns.id })
    .from(costReconciliationRuns)
    .where(and(eq(costReconciliationRuns.companyId, companyId), eq(costReconciliationRuns.provider, provider), eq(costReconciliationRuns.day, day)));
  return Boolean(row);
}

async function recordRun(db: Db, companyId: string, provider: string, day: string, status: string, mismatchCents: number) {
  await db
    .insert(costReconciliationRuns)
    .values({ companyId, provider, day, status, mismatchCents })
    .onConflictDoNothing();
}

export async function runDailyCostReconciliation(db: Db, deps: CostReconciliationDeps): Promise<CostReconciliationOutcome[]> {
  const now = deps.now?.() ?? new Date();
  const config = await deps.getConfig();
  const falAdminRef = asRef(config[FAL_ADMIN_KEY_CONFIG_KEY]);
  const sogniRef = asRef(config.sogniKeySecretRef);
  const creditPriceUsd = typeof config[SOGNI_CREDIT_PRICE_CONFIG_KEY] === "number" ? (config[SOGNI_CREDIT_PRICE_CONFIG_KEY] as number) : 0;
  const falOwner = falAdminRef ? await secretOwner(db, falAdminRef) : null;
  const sogniOwner = sogniRef ? await secretOwner(db, sogniRef) : null;

  const companyIds = new Set<string>([falOwner, sogniOwner].filter((c): c is string => Boolean(c)));
  const yesterday = dayString(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const today = dayString(now);
  const outcomes: CostReconciliationOutcome[] = [];

  for (const companyId of companyIds) {
    const outcome: CostReconciliationOutcome = { companyId, fal: "no_admin_key", sogni: "no_key" };
    try {
      if (falOwner === companyId) {
        if (await alreadyRan(db, companyId, "fal", yesterday)) outcome.fal = "already_done";
        else {
          const adminKey = await deps.resolveSecret(companyId, falAdminRef);
          const r = await reconcileFalDay(db, deps.falFetch, { companyId, adminKey, day: new Date(`${yesterday}T00:00:00Z`) });
          if (r.status === "skipped") outcome.fal = "skipped";
          else {
            await recordRun(db, companyId, "fal", yesterday, r.status, Math.round(Math.abs(r.deltaMicroUsd) / 10_000));
            outcome.fal = "reconciled";
          }
        }
      }
      if (sogniOwner === companyId) {
        if (await alreadyRan(db, companyId, "sogni", today)) outcome.sogni = "already_done";
        else {
          const apiKey = await deps.resolveSecret(companyId, sogniRef);
          const [snap] = await db.select().from(sogniBalanceSnapshots).where(eq(sogniBalanceSnapshots.companyId, companyId));
          const r = await reconcileSogniBalance(db, deps.sogniFetch, {
            companyId,
            apiKey,
            creditPriceUsd,
            previous: snap ? { spark: snap.spark, at: snap.observedAt } : null,
            now,
          });
          if (r.status === "skipped" && r.reason !== "no_previous_snapshot") outcome.sogni = "skipped";
          else {
            const next = r.next;
            await db
              .insert(sogniBalanceSnapshots)
              .values({ companyId, spark: next.spark, observedAt: next.at })
              .onConflictDoUpdate({ target: sogniBalanceSnapshots.companyId, set: { spark: next.spark, observedAt: next.at } });
            if (r.status === "skipped") {
              await recordRun(db, companyId, "sogni", today, "baseline", 0);
              outcome.sogni = "baseline";
            } else {
              await recordRun(db, companyId, "sogni", today, r.status, Math.round(Math.abs(r.deltaCredits) * creditPriceUsd * 100));
              outcome.sogni = "reconciled";
            }
          }
        }
      }
      await budgetService(db).evaluateReconciliationMismatch(companyId);
    } catch (err) {
      // Never includes the key; one company's failure must not stop the others.
      logger.warn({ err: err instanceof Error ? err.message : "unknown", companyId }, "daily cost reconciliation failed for a company");
    }
    outcomes.push(outcome);
  }
  return outcomes;
}
