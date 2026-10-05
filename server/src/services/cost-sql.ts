import { sql } from "drizzle-orm";
import { costEvents } from "@paperclipai/db";

/** 1 USD = 1,000,000 micro-USD; 1 cent = 10,000 micro-USD. */
export const MICRO_USD_PER_CENT = 10_000;

/**
 * Per-row effective micro-USD: the exact figure when present, otherwise the
 * legacy cost_cents scaled up (older rows only carry cents).
 */
export const effectiveMicroUsdExpr = sql`coalesce(${costEvents.costMicroUsd}, ${costEvents.costCents}::bigint * ${MICRO_USD_PER_CENT})`;

/** Sum of effective micro-USD, as a JS-safe number. */
export function sumMicroUsd() {
  return sql<number>`coalesce(sum(${effectiveMicroUsdExpr}), 0)::double precision`;
}

/**
 * Sum expressed in (possibly fractional) cents, so existing `costCents`
 * consumers keep their unit while gaining sub-cent precision.
 */
export function sumCostCents() {
  return sql<number>`(coalesce(sum(${effectiveMicroUsdExpr}), 0)::double precision / ${MICRO_USD_PER_CENT})`;
}
