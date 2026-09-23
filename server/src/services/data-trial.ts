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
import { getDataSourceKind } from "./data-sources/registry.js";
import { scrubSecrets } from "./data-sources/shopify-client.js";
import { parseMonthKey, zonedParts } from "./data-sources/zoned-time.js";

/**
 * DUR-3972 slice S2: "Trial calculation" on the Data sources settings screen.
 *
 * The operator picks one or two calendar months; Paperclip counts units sold
 * through the company's own connection with the kind's sales adapter
 * (registry.ts; the Shopify engine today), runs the same
 * consistency checks an agent answer gets, writes one audit row (channel
 * `settings_test`, refusals included), and hands back the fixed answer card so
 * it can be compared with Shopify Analytics BEFORE "Sales" is ticked.
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

const UNEXPECTED_MESSAGE = "Something unexpected went wrong during the trial calculation, so no figures are shown. Try again in a moment.";
const AUDIT_FAILED_MESSAGE =
  "The lookup could not be written to the log, so the figures are not shown. Try again in a moment.";
const INVARIANT_MESSAGE =
  "The figures from Shopify did not add up when they were checked, so they are not shown. Try again; if it happens again, it must be looked into before Sales is switched on.";

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

const MONTH_NAME = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" });

/** "July 2026" for the key "2026-07". */
function monthLabel(key: string): string {
  const parsed = parseMonthKey(key);
  if (!parsed) return key;
  return `${MONTH_NAME.format(new Date(Date.UTC(parsed.year, parsed.month - 1, 1)))} ${parsed.year}`;
}

const units = (count: string) => (count === "1" || count === "-1" ? "unit" : "units");

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
    const where = bucket === "total" ? "all products" : `product type ${bucket}`;
    notes.push(
      `${monthLabel(month!)}, ${where}: Shopify's sales ledger shows ${ledger} returned ${units(ledger!)}, but the refunds show ${refunds} ${units(refunds!)}. ` +
        "The figures above use the sales ledger, as Shopify Analytics does. The difference should be explained before Sales is switched on.",
    );
  }
  if (other > 0) {
    notes.push(
      other === 1
        ? "1 other note from the calculation was saved in the log."
        : `${other} other notes from the calculation were saved in the log.`,
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
      `${TRIAL_PER_MINUTE_LIMIT} trial calculations or tests have been run in the last minute. Wait a minute and try again.`,
      "rate_limited",
    );
  }
  if (today >= row.dailyLookupCap) {
    return refuse(
      "rate_limited_day",
      `The company has used up today's ${row.dailyLookupCap} lookups. The company's owner can raise the limit under "Lookups per day" here in Data sources; otherwise it opens again at midnight.`,
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
            ? "The connection is not switched on. Press Test first, and switch it on if it is switched off; the trial calculation works once the test has passed."
            : error.message;
        return refuse(code, message, "refused");
      }
      throw error;
    }

    const source = getDataSourceKind(read.kind);
    if (!source.adapters.sales) {
      return refuse(
        "data_source_kind_unsupported",
        `${source.label} connections cannot calculate sales yet. The connection is saved and will be used once support is ready.`,
        "refused",
      );
    }
    const adapter = source.adapters.sales(read, deps.sleep ? { sleep: deps.sleep } : {});
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
