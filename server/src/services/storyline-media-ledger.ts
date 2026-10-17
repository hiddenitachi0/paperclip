import { and, eq, gte, like, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { costService } from "./costs.js";
import { SOGNI_COST_SOURCE, sogniCreditsToMicroUsd } from "./sogni-cost.js";

/**
 * The company's monthly limit for AI media in storylines (AI transitions and
 * "animate this photo") is counted from cost_events, the durable spend
 * ledger -- never from the storyline tables (security review DUR-4807 item 4).
 *
 * Takes and video_media_spend rows go with their storyline, transition or
 * shot when those are deleted, so a total summed from them dropped back
 * whenever a film was deleted or a clip at an AI join was removed, and the
 * same company could spend its monthly limit again and again. cost_events
 * rows have no such cascade.
 *
 * Each paid step writes one cost row the moment its money is held (inside the
 * same per-company lock as the limit check), under a billing code naming the
 * take or the hold. When the clip arrives the SAME row is settled to the real
 * cost; when it fails before anything could be charged it is released to 0.
 * The row itself is never deleted. Company and agent budgets therefore see the
 * money while it is being spent, and exactly once.
 */

/** Billing code of an AI transition take's spend row. */
export function storylineTransitionSpendCode(takeId: string): string {
  return `${STORYLINE_TRANSITION_SPEND_PREFIX}${takeId}`;
}

/** Billing code of an "animate this photo" hold's spend row (one per video_media_spend row). */
export function storylineAnimateSpendCode(mediaSpendId: string): string {
  return `${STORYLINE_ANIMATE_SPEND_PREFIX}${mediaSpendId}`;
}

export const STORYLINE_TRANSITION_SPEND_PREFIX = "video-storyline-transition:";
export const STORYLINE_ANIMATE_SPEND_PREFIX = "video-storyline-animate-photo:";
/** Rows written before the ledger held reservations: Fal transitions (one shared code) and Sogni transitions (per take). */
const LEGACY_FAL_TRANSITION_CODE = "video-storyline-transition";
const LEGACY_SOGNI_TRANSITION_PREFIX = "video\\_storyline\\_transition:";

function monthWindowUtc(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * This calendar month's (UTC, like every other monthly figure in Paperclip)
 * AI media spend for one company, from the durable ledger. Money still held
 * for a step that is being made counts at its held amount; a step that failed
 * before anything was charged counts 0.
 */
export async function companyMonthlyMediaSpendCents(executor: Pick<Db, "select">, companyId: string, now: Date): Promise<number> {
  const { start, end } = monthWindowUtc(now);
  const [row] = await executor
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, start),
        lt(costEvents.occurredAt, end),
        or(
          like(costEvents.billingCode, `${escapeLike(STORYLINE_TRANSITION_SPEND_PREFIX)}%`),
          like(costEvents.billingCode, `${escapeLike(STORYLINE_ANIMATE_SPEND_PREFIX)}%`),
          eq(costEvents.billingCode, LEGACY_FAL_TRANSITION_CODE),
          like(costEvents.billingCode, `${LEGACY_SOGNI_TRANSITION_PREFIX}%`),
        ),
      ),
    );
  return Number(row?.total ?? 0);
}

type Inserter = Pick<Db, "insert">;

/**
 * Writes the spend row for money being held. Must run inside the caller's
 * transaction, after the limit check and under the same lock, so the check
 * and the hold cannot be split by another request. Call refreshStorylineMediaSpend
 * after the transaction commits.
 */
export async function reserveStorylineMediaSpend(
  tx: Inserter,
  input: {
    companyId: string;
    billingCode: string;
    provider: string;
    model: string;
    cents: number;
    agentId: string | null;
    createdByUserId: string | null;
    occurredAt: Date;
  },
): Promise<typeof costEvents.$inferSelect> {
  const [row] = await tx
    .insert(costEvents)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      createdByUserId: input.createdByUserId,
      billingCode: input.billingCode,
      provider: input.provider,
      biller: input.provider,
      billingType: input.provider === "sogni" ? "credits" : "metered_api",
      model: input.model || "unknown",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costCents: Math.max(0, Math.round(input.cents)),
      costMicroUsd: Math.max(0, Math.round(input.cents)) * 10_000,
      // Only an estimate until the clip arrives and the row is settled.
      costSource: "estimate",
      occurredAt: input.occurredAt,
    })
    .returning();
  return row!;
}

/** Agent/company month totals and budget checks after a spend row changed. Never throws. */
export async function refreshStorylineMediaSpend(db: Db, event: typeof costEvents.$inferSelect | null | undefined): Promise<void> {
  if (!event) return;
  try {
    await costService(db).refreshAfterEvent(event);
  } catch (err) {
    logger.error({ err, costEventId: event.id }, "storyline media spend: could not refresh month totals");
  }
}

async function updateSpendRow(
  db: Db,
  companyId: string,
  billingCode: string,
  patch: Partial<Pick<typeof costEvents.$inferInsert, "costCents" | "costMicroUsd" | "costSource" | "model">>,
): Promise<typeof costEvents.$inferSelect | null> {
  const [row] = await db
    .update(costEvents)
    .set(patch)
    .where(and(eq(costEvents.companyId, companyId), eq(costEvents.billingCode, billingCode)))
    .returning();
  return row ?? null;
}

/**
 * Settles a held spend row to what the step really cost. Returns false when
 * there is no such row (a step started before the ledger held reservations);
 * the caller then records the cost the old way.
 */
export async function settleStorylineMediaSpend(
  db: Db,
  input: { companyId: string; billingCode: string; costCents: number; costMicroUsd?: number | null; costSource?: string; model?: string },
): Promise<boolean> {
  const cents = Math.max(0, Math.round(input.costCents));
  const row = await updateSpendRow(db, input.companyId, input.billingCode, {
    costCents: cents,
    costMicroUsd: input.costMicroUsd ?? cents * 10_000,
    costSource: input.costSource ?? "estimate",
    ...(input.model ? { model: input.model } : {}),
  });
  await refreshStorylineMediaSpend(db, row);
  return row !== null;
}

/** A step that failed before anything could be charged: its spend row counts 0 from now on (the row stays). */
export async function releaseStorylineMediaSpend(db: Db, companyId: string, billingCode: string): Promise<void> {
  const row = await updateSpendRow(db, companyId, billingCode, { costCents: 0, costMicroUsd: 0 });
  await refreshStorylineMediaSpend(db, row);
}

/**
 * Sogni reports credits, not dollars: the held row becomes credits x the
 * configured credit price. Without a price (or without credits) the held
 * estimate stands -- never 0. Returns false only when there is no held row.
 */
export async function settleSogniStorylineSpend(
  db: Db,
  input: { companyId: string; billingCode: string; credits: number | null; creditPriceUsd: unknown; model?: string },
): Promise<boolean> {
  const micro = input.credits === null ? null : sogniCreditsToMicroUsd(input.credits, input.creditPriceUsd);
  if (micro === null) {
    const [row] = await db
      .select({ id: costEvents.id })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, input.companyId), eq(costEvents.billingCode, input.billingCode)))
      .limit(1);
    return Boolean(row);
  }
  return settleStorylineMediaSpend(db, {
    companyId: input.companyId,
    billingCode: input.billingCode,
    costCents: Math.round(micro / 10_000),
    costMicroUsd: micro,
    costSource: SOGNI_COST_SOURCE,
    model: input.model,
  });
}
