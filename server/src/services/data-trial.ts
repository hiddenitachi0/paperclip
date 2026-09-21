import type { Db } from "@paperclipai/db";
import type { DataTrialCalculationResult, DataReadOutcome } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { countDataReadEvents, recordDataReadEvent } from "./data-read-audit.js";
import type { DataConnectionService } from "./data-connections.js";
import { renderSalesAnswerCard } from "./data-sources/answer-card.js";
import {
  checkSalesInvariants,
  salesResultSchema,
  type DataLookupAudit,
  type DataRefusalCode,
  type SalesResult,
} from "./data-sources/contract.js";
import { createShopifySalesAdapter } from "./data-sources/shopify-adapter.js";
import { scrubSecrets } from "./data-sources/shopify-client.js";
import { NORWEGIAN_MONTHS, parseMonthKey, zonedParts } from "./data-sources/zoned-time.js";

/**
 * DUR-3972 slice S2: "Prøveberegning" -- the trial calculation on the
 * Datakilder settings screen.
 *
 * The operator picks one or two calendar months; Paperclip counts units sold
 * through the company's own connection with the S3 engine, runs the same
 * consistency checks an agent answer gets, writes one audit row (channel
 * `settings_test`, refusals included), and hands back the fixed answer card so
 * it can be compared with Shopify Analytics BEFORE "Salg" is ticked.
 *
 * Rules this file keeps:
 *  - Company from the URL the board route already authorised; the connection
 *    is looked up within that company only (another company's id is "not
 *    found").
 *  - Complete or nothing. Any refusal from the engine, a failed consistency
 *    check, or an audit row that cannot be written means NO numbers, only a
 *    plain sentence: a wrong number is worse than no number.
 *  - Limits counted from data_read_events, so they survive a restart: a few
 *    trial runs per minute per company, and the connection's daily cap.
 *  - The key never leaves the server: every text going back is scrubbed of
 *    the values used for this lookup, and nothing about the key is logged.
 */

/** Trial runs and Tests per company per minute. A person clicking, not a script. */
export const TRIAL_PER_MINUTE_LIMIT = 6;

const FALLBACK_TIMEZONE = "Europe/Oslo";

const UNEXPECTED_MESSAGE = "Noe uventet gikk galt under prøveberegningen, så ingen tall vises. Prøv igjen om litt.";
const AUDIT_FAILED_MESSAGE =
  "Oppslaget kunne ikke skrives i loggen, så tallene vises ikke. Prøv igjen om litt.";
const INVARIANT_MESSAGE =
  "Tallene fra Shopify gikk ikke opp når de ble kontrollert, så de vises ikke. Prøv igjen; skjer det igjen, må det undersøkes før Salg slås på.";

/** Midnight today in `timeZone`, as a UTC instant. Same two-step correction as zonedMonthStart. */
export function zonedDayStart(now: Date, timeZone: string): Date {
  const offsetAt = (instant: Date) => {
    const p = zonedParts(instant, timeZone);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return wall - Math.floor(instant.getTime() / 1000) * 1000;
  };
  const p = zonedParts(now, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, p.day);
  let candidate = guess - offsetAt(now);
  candidate = guess - offsetAt(new Date(candidate));
  return new Date(candidate);
}

function monthLabel(key: string): string {
  const parsed = parseMonthKey(key);
  if (!parsed) return key;
  return `${NORWEGIAN_MONTHS[parsed.month - 1]} ${parsed.year}`;
}

/**
 * The engine's audit warnings are written for the log. The one kind worth
 * showing the operator -- Shopify's sales record and its refunds disagree on
 * returns -- is turned into a plain sentence; anything else is only counted.
 */
export function describeReconciliationWarnings(warnings: string[]): string[] {
  const notes: string[] = [];
  let other = 0;
  const pattern = /^refunds_cross_check (\d{4}-\d{2}) (.+): ledger returns (-?\d+), refund lines (-?\d+)$/;
  for (const warning of warnings) {
    const match = pattern.exec(warning);
    if (!match) {
      other += 1;
      continue;
    }
    const [, month, bucket, ledger, refunds] = match;
    const where = bucket === "total" ? "alle produkter" : `produkttypen ${bucket}`;
    notes.push(
      `${monthLabel(month!)}, ${where}: Shopifys salgslogg viser ${ledger} returnerte stk, men refusjonene viser ${refunds} stk. ` +
        "Tallene over bruker salgsloggen, som Shopify Analytics. Forskjellen bør forklares før Salg slås på.",
    );
  }
  if (other > 0) {
    notes.push(
      other === 1
        ? "1 annen merknad fra beregningen er lagret i loggen."
        : `${other} andre merknader fra beregningen er lagret i loggen.`,
    );
  }
  return notes;
}

function outcomeForRefusal(code: DataRefusalCode | string): DataReadOutcome {
  return code === "upstream_error" || code === "throttled" || code === "unexpected_shape"
    ? "upstream_error"
    : "refused";
}

function factsFor(result: SalesResult, warnings: string[]): Record<string, unknown> {
  return {
    periods: result.periods.map((period) => ({
      key: period.key,
      status: period.status,
      dataState: period.dataState,
      total: period.total,
    })),
    comparison: result.comparison,
    productTypesCounted: result.productTypesCounted,
    warnings: warnings.slice(0, 20),
  };
}

export interface TrialCalculationInput {
  companyId: string;
  connectionId: string;
  userId: string;
  periods: string[];
  groupBy: "none" | "product_type";
}

export interface TrialCalculationDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runTrialCalculation(
  db: Db,
  svc: DataConnectionService,
  input: TrialCalculationInput,
  deps: TrialCalculationDeps = {},
): Promise<DataTrialCalculationResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  // Throws 404 for a connection that is not this company's -- before anything else.
  const row = await svc.getRow(input.companyId, input.connectionId);
  const params = { action: "sales", periods: input.periods, groupBy: input.groupBy, measure: ["units"] };

  let knownSecrets: () => string[] = () => [];
  const clean = (text: string) => scrubSecrets(text, knownSecrets());

  async function refuse(
    code: string,
    message: string,
    outcome: DataReadOutcome,
    extra: { audit?: DataLookupAudit; facts?: Record<string, unknown> } = {},
  ): Promise<DataTrialCalculationResult> {
    let lookupId: string | null = null;
    try {
      lookupId = await recordDataReadEvent(db, {
        companyId: input.companyId,
        connectionId: row.id,
        dataset: "sales",
        channel: "settings_test",
        userId: input.userId,
        params,
        outcome,
        refusalCode: code,
        facts: extra.facts ?? (extra.audit ? { warnings: extra.audit.warnings.slice(0, 20), invariantViolations: extra.audit.invariantViolations.slice(0, 20) } : null),
        upstreamRequests: extra.audit?.upstreamRequests ?? 0,
        costPoints: extra.audit?.costPoints ?? 0,
        durationMs: now() - startedAt,
        scrubValues: knownSecrets(),
      });
    } catch (error) {
      logger.warn(
        { companyId: input.companyId, err: error instanceof Error ? error.name : "unknown" },
        "data trial: could not write refusal audit row",
      );
    }
    return { ok: false, lookupId, code, message: clean(message) };
  }

  // Limits, counted from the audit table.
  const nowDate = new Date(now());
  const timezone = (row.observed as { ianaTimezone?: string | null } | null)?.ianaTimezone || FALLBACK_TIMEZONE;
  let dayStart: Date;
  try {
    dayStart = zonedDayStart(nowDate, timezone);
  } catch {
    dayStart = zonedDayStart(nowDate, FALLBACK_TIMEZONE);
  }
  const [lastMinute, today] = await Promise.all([
    countDataReadEvents(db, {
      companyId: input.companyId,
      since: new Date(now() - 60_000),
      channel: "settings_test",
    }),
    countDataReadEvents(db, { companyId: input.companyId, since: dayStart }),
  ]);
  if (lastMinute >= TRIAL_PER_MINUTE_LIMIT) {
    return refuse(
      "rate_limited_minute",
      `Det er kjørt ${TRIAL_PER_MINUTE_LIMIT} prøveberegninger eller tester det siste minuttet. Vent et minutt og prøv igjen.`,
      "rate_limited",
    );
  }
  if (today >= row.dailyLookupCap) {
    return refuse(
      "rate_limited_day",
      `Selskapet har brukt opp dagens ${row.dailyLookupCap} oppslag. Eieren av selskapet kan øke grensen under «Oppslag per dag» her i Datakilder, ellers åpner det seg igjen ved midnatt.`,
      "rate_limited",
    );
  }

  try {
    let read: Awaited<ReturnType<DataConnectionService["openReadContext"]>>["read"];
    try {
      const opened = await svc.openReadContext(input.companyId, row.id, { actorType: "user", actorId: input.userId });
      read = opened.read;
      knownSecrets = opened.knownSecrets;
    } catch (error) {
      if (error instanceof HttpError && error.status === 422) {
        const code =
          error.details && typeof error.details === "object" && typeof (error.details as { code?: unknown }).code === "string"
            ? (error.details as { code: string }).code
            : "not_available";
        const message =
          code === "data_connection_not_active"
            ? "Koblingen er ikke slått på. Trykk Test først, og slå den på hvis den er slått av; prøveberegningen virker når testen har gått gjennom."
            : error.message;
        return refuse(code, message, "refused");
      }
      throw error;
    }

    const adapter = createShopifySalesAdapter({
      client: read.shopifyTransport,
      clock: { now: read.now, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
    });
    const outcome = await adapter.sales({ periods: input.periods, measure: ["units"], groupBy: input.groupBy });
    if (!outcome.ok) {
      return refuse(outcome.refusal.code, outcome.refusal.message, outcomeForRefusal(outcome.refusal.code), {
        audit: outcome.audit,
      });
    }

    // The engine checks itself; check again here, as S4 will, before anything is shown.
    const parsed = salesResultSchema.safeParse(outcome.result);
    const violations = parsed.success ? checkSalesInvariants(parsed.data) : ["result does not match the contract"];
    if (!parsed.success || violations.length > 0) {
      return refuse("invariant_failed", INVARIANT_MESSAGE, "refused", {
        audit: { ...outcome.audit, refusalCode: "invariant_failed", invariantViolations: violations },
      });
    }
    const result = parsed.data;
    const allNoData = result.periods.every((period) => period.dataState === "no_data");

    let lookupId: string;
    try {
      lookupId = await recordDataReadEvent(db, {
        companyId: input.companyId,
        connectionId: row.id,
        dataset: "sales",
        channel: "settings_test",
        userId: input.userId,
        params,
        outcome: allNoData ? "no_data" : "ok",
        refusalCode: null,
        facts: factsFor(result, outcome.audit.warnings),
        upstreamRequests: outcome.audit.upstreamRequests,
        costPoints: outcome.audit.costPoints,
        durationMs: now() - startedAt,
        scrubValues: knownSecrets(),
      });
    } catch (error) {
      // A lookup that cannot be audited is not answered.
      logger.warn(
        { companyId: input.companyId, err: error instanceof Error ? error.name : "unknown" },
        "data trial: could not write audit row; numbers withheld",
      );
      return { ok: false, lookupId: null, code: "audit_failed", message: AUDIT_FAILED_MESSAGE };
    }

    return {
      ok: true,
      lookupId,
      card: clean(renderSalesAnswerCard(result, { lookupId })),
      reconciliationNotes: describeReconciliationWarnings(outcome.audit.warnings).map(clean),
    };
  } catch (error) {
    logger.warn(
      { companyId: input.companyId, connectionId: row.id, err: error instanceof Error ? error.name : "unknown" },
      "data trial failed unexpectedly",
    );
    return refuse("unexpected", UNEXPECTED_MESSAGE, "upstream_error");
  }
}
