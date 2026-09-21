import { and, eq, gte, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { dataReadEvents } from "@paperclipai/db";
import type { DataReadChannel, DataReadOutcome } from "@paperclipai/shared";
import { redactKnownLeakedSecretPatternsDeep, redactKnownSecretValues } from "../redaction.js";
import { logger } from "../middleware/logger.js";

/**
 * DUR-3972 S1: the business-data audit trail, and the counter every lookup
 * limit is computed from (so limits survive a restart).
 *
 * One row per lookup, refusals included. `params` is the normalised input and
 * `facts` the numbers handed back. Both are scrubbed of known key shapes and
 * of any exact secret value the caller passes, and `facts` is capped at 8 KB
 * (the database refuses more, too).
 */

export const DATA_READ_FACTS_MAX_BYTES = 8192;

export interface RecordDataReadEventInput {
  companyId: string;
  connectionId?: string | null;
  dataset: string;
  channel: DataReadChannel;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
  laneAConversationId?: string | null;
  params?: Record<string, unknown>;
  outcome: DataReadOutcome;
  refusalCode?: string | null;
  facts?: Record<string, unknown> | null;
  upstreamRequests?: number;
  costPoints?: number;
  durationMs?: number | null;
  /** Exact values that must never be stored (the key in use). */
  scrubValues?: string[];
}

function scrubJson(value: Record<string, unknown>, scrubValues: string[]): Record<string, unknown> {
  const patterned = redactKnownLeakedSecretPatternsDeep(value) as Record<string, unknown>;
  if (scrubValues.length === 0) return patterned;
  const text = redactKnownSecretValues(JSON.stringify(patterned), scrubValues);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A secret value that happened to split a JSON token: keep nothing rather
    // than something half-scrubbed.
    return { scrubbed: true };
  }
}

function capFacts(facts: Record<string, unknown>): Record<string, unknown> {
  const size = Buffer.byteLength(JSON.stringify(facts), "utf8");
  if (size <= DATA_READ_FACTS_MAX_BYTES - 64) return facts;
  return { truncated: true, originalBytes: size };
}

/**
 * Writes one audit row and returns its id (the "oppslag <id>" in an answer).
 * Throws on a database error: a lookup that cannot be audited must not be
 * answered, so callers treat a throw here as a refusal.
 */
export async function recordDataReadEvent(db: Db, input: RecordDataReadEventInput): Promise<string> {
  const scrubValues = (input.scrubValues ?? []).filter((value) => value && value.length >= 6);
  const params = scrubJson(input.params ?? {}, scrubValues);
  const facts = input.facts ? capFacts(scrubJson(input.facts, scrubValues)) : null;
  const [row] = await db
    .insert(dataReadEvents)
    .values({
      companyId: input.companyId,
      connectionId: input.connectionId ?? null,
      dataset: input.dataset,
      channel: input.channel,
      agentId: input.agentId ?? null,
      userId: input.userId ?? null,
      runId: input.runId ?? null,
      laneAConversationId: input.laneAConversationId ?? null,
      params,
      outcome: input.outcome,
      refusalCode: input.refusalCode ?? null,
      facts,
      upstreamRequests: Math.max(0, Math.round(input.upstreamRequests ?? 0)),
      costPoints: Math.max(0, Math.round(input.costPoints ?? 0)),
      durationMs: input.durationMs === undefined || input.durationMs === null ? null : Math.max(0, Math.round(input.durationMs)),
    })
    .returning({ id: dataReadEvents.id });
  return row!.id;
}

/**
 * Best-effort variant for places where the audit row is secondary to what the
 * user is doing (the settings Test). Logs and returns null instead of throwing.
 */
export async function tryRecordDataReadEvent(db: Db, input: RecordDataReadEventInput): Promise<string | null> {
  try {
    return await recordDataReadEvent(db, input);
  } catch (error) {
    logger.warn(
      { companyId: input.companyId, channel: input.channel, err: error instanceof Error ? error.message : String(error) },
      "data_read_events: could not write audit row",
    );
    return null;
  }
}

/**
 * How many lookups match, since a point in time. The single counter for every
 * limit (per agent per minute, per company per minute, per company per day).
 * Always scoped to one company.
 */
export async function countDataReadEvents(
  db: Db,
  filter: { companyId: string; since: Date; agentId?: string; runId?: string; channel?: DataReadChannel },
): Promise<number> {
  const conditions: SQL[] = [
    eq(dataReadEvents.companyId, filter.companyId),
    gte(dataReadEvents.createdAt, filter.since),
  ];
  if (filter.agentId) conditions.push(eq(dataReadEvents.agentId, filter.agentId));
  if (filter.runId) conditions.push(eq(dataReadEvents.runId, filter.runId));
  if (filter.channel) conditions.push(eq(dataReadEvents.channel, filter.channel));
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dataReadEvents)
    .where(and(...conditions));
  return row?.count ?? 0;
}
