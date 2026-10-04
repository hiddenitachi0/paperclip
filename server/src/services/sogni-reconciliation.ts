// DUR-4460: Sogni balance reconciliation (same idea as Fal's DUR-4455 daily
// check). Sogni's REST API exposes GET /v4/account/balance
// (data.spark.settled, a human-unit decimal string). Between two balance
// snapshots we compare the Spark drop with the credits we recorded as
// converted_from_credits spend, and surface a mismatch. It only reports --
// it never writes cost rows, because top-ups/refunds also move the balance
// and a silent adjustment would be a guess.
import { and, eq, gte, lt } from "drizzle-orm";
import { costEvents, type Db } from "@paperclipai/db";
import { sumMicroUsd } from "./cost-sql.js";
import { SOGNI_COST_SOURCE } from "./sogni-cost.js";

const SOGNI_API_BASE = "https://api.sogni.ai";
export type SogniFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export interface SogniBalanceSnapshot {
  /** Settled Spark balance. */
  spark: number;
  at: Date;
}

/** Settled Spark balance, or null when the key is rejected, the call fails or the shape is unexpected. Never logs the key. */
export async function fetchSogniBalance(fetchImpl: SogniFetch, apiKey: string, now: Date = new Date()): Promise<SogniBalanceSnapshot | null> {
  try {
    const res = await fetchImpl(`${SOGNI_API_BASE}/v4/account/balance`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { spark?: { settled?: unknown } } };
    const raw = body?.data?.spark?.settled;
    const spark = typeof raw === "string" ? Number(raw) : raw;
    return typeof spark === "number" && Number.isFinite(spark) ? { spark, at: now } : null;
  } catch {
    return null;
  }
}

export type SogniReconciliation =
  | { status: "skipped"; reason: "no_balance" | "credit_price_not_set" }
  /** First ever look: nothing to compare against yet, but the caller should store `next` as the baseline. */
  | { status: "skipped"; reason: "no_previous_snapshot"; next: SogniBalanceSnapshot }
  | { status: "confirmed" | "mismatch"; balanceDropCredits: number; recordedCredits: number; deltaCredits: number; next: SogniBalanceSnapshot };

/** Tolerance: 1% of the larger side, but never below 0.5 credit (rounding of per-render credits). */
function withinTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.5, 0.01 * Math.max(Math.abs(a), Math.abs(b)));
}

export async function reconcileSogniBalance(
  db: Db,
  fetchImpl: SogniFetch,
  params: { companyId: string; apiKey: string; creditPriceUsd: number; previous: SogniBalanceSnapshot | null; now?: Date },
): Promise<SogniReconciliation> {
  if (!(params.creditPriceUsd > 0)) return { status: "skipped", reason: "credit_price_not_set" };
  const current = await fetchSogniBalance(fetchImpl, params.apiKey, params.now);
  if (!current) return { status: "skipped", reason: "no_balance" };
  if (!params.previous) return { status: "skipped", reason: "no_previous_snapshot", next: current };

  const [row] = await db
    .select({ total: sumMicroUsd() })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, params.companyId),
        eq(costEvents.provider, "sogni"),
        eq(costEvents.costSource, SOGNI_COST_SOURCE),
        gte(costEvents.occurredAt, params.previous.at),
        lt(costEvents.occurredAt, current.at),
      ),
    );
  const recordedCredits = Number(row?.total ?? 0) / 1_000_000 / params.creditPriceUsd;
  const balanceDropCredits = params.previous.spark - current.spark;
  const deltaCredits = balanceDropCredits - recordedCredits;
  return {
    status: withinTolerance(balanceDropCredits, recordedCredits) ? "confirmed" : "mismatch",
    balanceDropCredits,
    recordedCredits,
    deltaCredits,
    next: current,
  };
}
