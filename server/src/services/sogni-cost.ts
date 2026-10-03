import type { Db } from "@paperclipai/db";
import { costService } from "./costs.js";
import { logger } from "../middleware/logger.js";

/**
 * DUR-4456: Sogni bills in its own credit unit (capacity units / Spark), not
 * USD. The owner sets "Sogni credit price" (USD per credit, plugin config key
 * sogniCreditPriceUsd) from what they actually paid; recorded credits are
 * converted with it to cost_micro_usd and tagged cost_source =
 * "converted_from_credits" -- never "provider"/exact. A missing or zero price
 * records nothing (a 0-cost row would be a silent lie) and says so.
 */

export const SOGNI_CREDIT_PRICE_CONFIG_KEY = "sogniCreditPriceUsd";
export const SOGNI_COST_SOURCE = "converted_from_credits";

type Json = Record<string, unknown>;
const asRecord = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const positive = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

const ACTUAL_KEYS = ["actualCapacityUnits", "actual_capacity_units", "actualCost", "actual_cost", "totalCost", "total_cost", "costCredits"] as const;

function readActual(node: Json | null): number | null {
  if (!node) return null;
  for (const key of ACTUAL_KEYS) {
    const n = positive(node[key]);
    if (n !== null) return n;
  }
  const cost = node.cost;
  const direct = positive(cost);
  if (direct !== null) return direct;
  const nested = asRecord(cost);
  return nested ? (positive(nested.actual) ?? positive(nested.total) ?? positive(nested.credits)) : null;
}

/**
 * Credits Sogni reports for a finished workflow, or null when it reports none.
 * ASSUMPTION (field names unconfirmed in Sogni's public docs, which only name
 * estimated_capacity_units): the workflow, or its steps summed, carry an
 * actual-cost field. Estimates are deliberately never read as actuals.
 */
export function readSogniWorkflowCredits(workflow: unknown): number | null {
  const wf = asRecord(workflow);
  if (!wf) return null;
  const top = readActual(wf) ?? readActual(asRecord(wf.usage));
  if (top !== null) return top;
  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  let sum = 0;
  let any = false;
  for (const step of steps) {
    const n = readActual(asRecord(step));
    if (n !== null) {
      sum += n;
      any = true;
    }
  }
  return any ? sum : null;
}

/** Micro-USD for a credit count, or null when the price is unset/non-positive or credits are not positive. */
export function sogniCreditsToMicroUsd(credits: number, creditPriceUsd: unknown): number | null {
  const price = positive(creditPriceUsd);
  if (price === null || !(credits > 0)) return null;
  return Math.max(1, Math.round(credits * price * 1_000_000));
}

export type SogniCostOutcome =
  | { recorded: true; costMicroUsd: number }
  | { recorded: false; reason: "no_credits_reported" | "credit_price_not_set" };

export async function recordSogniCost(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    credits: number | null;
    creditPriceUsd: unknown;
    model: string;
    issueId?: string | null;
    heartbeatRunId?: string | null;
    billingCode?: string | null;
  },
): Promise<SogniCostOutcome> {
  if (input.credits === null || !(input.credits > 0)) return { recorded: false, reason: "no_credits_reported" };
  const micro = sogniCreditsToMicroUsd(input.credits, input.creditPriceUsd);
  if (micro === null) {
    // Never log keys or bodies; only the fact that pricing is missing.
    logger.warn({ companyId: input.companyId, model: input.model }, "Sogni spend not recorded: Sogni credit price is not set");
    return { recorded: false, reason: "credit_price_not_set" };
  }
  await costService(db).createEvent(input.companyId, {
    agentId: input.agentId,
    issueId: input.issueId ?? null,
    heartbeatRunId: input.heartbeatRunId ?? null,
    billingCode: input.billingCode ?? null,
    provider: "sogni",
    biller: "sogni",
    billingType: "credits",
    model: input.model,
    inputTokens: 0,
    outputTokens: 0,
    costCents: Math.round(micro / 10_000),
    costMicroUsd: micro,
    costSource: SOGNI_COST_SOURCE,
    occurredAt: new Date(),
  });
  return { recorded: true, costMicroUsd: micro };
}
