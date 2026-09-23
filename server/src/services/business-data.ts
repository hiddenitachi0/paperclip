import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import type { DataReadChannel, DataReadOutcome } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { AuthorizationActor } from "./authorization.js";
import { instanceSettingsService } from "./instance-settings.js";
import { dataConnectionService, type DataConnectionServiceDeps } from "./data-connections.js";
import { countDataReadEvents, DATA_READ_FACTS_MAX_BYTES, recordDataReadEvent } from "./data-read-audit.js";
import {
  checkSalesInvariants,
  isKronerOnlyRefusal,
  KRONER_NOT_ENABLED_MESSAGE,
  periodTokenSchema,
  SALES_GROUP_BY,
  salesResultSchema,
  type DataLookupAudit,
  type DataRefusalCode,
  type SalesResult,
} from "./data-sources/contract.js";
import { periodRange, renderCatalogAnswerCard, renderSalesAnswerCard, renderSourceFooter } from "./data-sources/answer-card.js";
import { createShopifySalesAdapter, nearestValues, normalizeForMatch, PRODUCT_TYPES_QUERY } from "./data-sources/shopify-adapter.js";
import { scrubSecrets, ShopifyClientError } from "./data-sources/shopify-client.js";
import { zonedDayStart, zonedParts } from "./data-sources/zoned-time.js";

/**
 * DUR-3972 slice S4: the business-data query service -- the ONE place an
 * agent's question about company sales becomes numbers.
 *
 * Fixed order, every step before the next:
 *   1. the company comes from the caller's server-side context, never from input
 *   2. the "sales" source is looked up for that company only
 *   3. the connection must be active (and the instance switch on)
 *   4. the input is validated strictly; kroner is refused
 *   5. the limits, all COUNTED FROM data_read_events (so they survive a
 *      restart): per run (signed run id only), per agent per minute, per
 *      company per minute, and the company's daily cap by Oslo day
 *   6. the key is resolved (inside openReadContext; never returned here)
 *   7. the S3 engine is called (periods are tokens it resolves on the server)
 *   8. the result is re-validated and the consistency checks run again
 *   9. the answer is capped at 8 KB -- too big is a refusal, never a cut-off
 *  10. the answer is scrubbed of any key value
 *  11. the fixed Norwegian answer card is rendered, with the lookup id
 *  12. the audit row is written -- for refusals too. An answer whose audit row
 *      cannot be written is not given.
 *
 * Units only. "No data" stays distinct from zero (the engine's `no_data`).
 */

export const BUSINESS_DATA_DATASET = "sales" as const;

export const BUSINESS_DATA_LIMITS = {
  /** Filip, 19 Sep: "at most 15 lookups per run" -- the brake on a looping agent. */
  perRun: 15,
  perAgentPerMinute: 6,
  perCompanyPerMinute: 20,
} as const;

/** The whole lookup must finish in this time (the plan's tool timeout). */
export const BUSINESS_DATA_LOOKUP_TIMEOUT_MS = 25_000;
/** Budget for reading the catalog's product types before a filtered lookup. */
const PRODUCT_TYPE_READ_BUDGET = { maxRequests: 10, deadlineMs: 8_000 };
/** Room left in the 8 KB facts column for the JSON wrapper around the answer. */
const ANSWER_MAX_BYTES = DATA_READ_FACTS_MAX_BYTES - 512;
const LIMIT_DAY_TIMEZONE = "Europe/Oslo";

/** Rows that do not count towards any limit: a refusal for being over a limit. */
const NOT_COUNTED_OUTCOMES: DataReadOutcome[] = ["rate_limited"];

/**
 * The input a quick agent's tool call may carry. Strict: an unknown field (a
 * shop address, a connection id, a company) is refused, never ignored.
 */
export const readBusinessDataInputSchema = z
  .object({
    action: z.enum(["catalog", "sales"]),
    periods: z.array(periodTokenSchema).min(1).max(2).optional(),
    measure: z.array(z.string().max(40)).max(5).optional(),
    product_type_query: z.string().trim().min(1).max(120).optional(),
    product_types: z.array(z.string().trim().min(1).max(255)).min(1).max(20).optional(),
    group_by: z.enum(SALES_GROUP_BY).optional(),
  })
  .strict();
export type ReadBusinessDataInput = z.infer<typeof readBusinessDataInputSchema>;

/** Who is asking. Built by the server from the authenticated request, never from tool input. */
export interface BusinessDataCaller {
  companyId: string;
  channel: DataReadChannel;
  /** The quick agent doing the lookup (the per-agent limit). */
  agentId: string | null;
  userId: string | null;
  /** The run from a SIGNED agent token only (see signedRunIdFromActor). */
  runId: string | null;
  laneAConversationId: string | null;
}

export interface BusinessDataAnswer {
  ok: boolean;
  outcome: DataReadOutcome;
  refusalCode: string | null;
  /** The audit row id; null only when a refusal could not be audited. */
  lookupId: string | null;
  /** What the model (or the board user, for the trial) is shown. */
  text: string;
  /**
   * For a successful lookup: the lines the platform itself appends to the
   * reply when the model left them out (units, exact periods, source, lookup id).
   */
  footer: string | null;
}

/**
 * The per-run key. Since DUR-3992 the server trusts only the run named in a
 * SIGNED agent token (auth.ts sets actor.runId = claims.run_id for
 * source "agent_jwt" and ignores a differing x-paperclip-run-id header). A
 * board key, delegate key or service token copies the plain header into
 * actor.runId, and an agent API key's run comes from a header too; none of
 * those may name the run a limit is counted against.
 */
export function signedRunIdFromActor(actor: AuthorizationActor | undefined | null): string | null {
  if (!actor || actor.type !== "agent" || actor.source !== "agent_jwt") return null;
  return typeof actor.runId === "string" && actor.runId.length > 0 ? actor.runId : null;
}

export function notConnectedMessage(companyName: string): string {
  return `${companyName} has not connected its sales data. A board user can do that under Settings → Data sources.`;
}

const FEATURE_OFF_MESSAGE =
  "Data sources are switched off for this Paperclip installation, so I cannot read sales data right now. An administrator can switch them on.";
const UNEXPECTED_MESSAGE =
  "I could not fetch the figures because of an error, so I am not giving any figures. The error has been logged.";

function upstreamLike(code: DataRefusalCode): boolean {
  return (
    code === "upstream_error" ||
    code === "throttled" ||
    code === "request_budget_exceeded" ||
    code === "time_budget_exceeded" ||
    code === "unexpected_shape"
  );
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** The normalised input for the audit row: known fields only, nothing free-form beyond the type query. */
function auditParams(raw: unknown): Record<string, unknown> {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  const clip = (value: unknown) => (typeof value === "string" ? value.slice(0, 120) : value);
  if (typeof input.action === "string") out.action = clip(input.action);
  if (Array.isArray(input.periods)) out.periods = input.periods.slice(0, 4).map(clip);
  if (Array.isArray(input.measure)) out.measure = input.measure.slice(0, 5).map(clip);
  if (typeof input.product_type_query === "string") out.productTypeQuery = clip(input.product_type_query);
  if (Array.isArray(input.product_types)) out.productTypes = input.product_types.slice(0, 20).map(clip);
  if (typeof input.group_by === "string") out.groupBy = clip(input.group_by);
  const unknown = Object.keys(input).filter(
    (key) => !["action", "periods", "measure", "product_type_query", "product_types", "group_by"].includes(key),
  );
  // Names only: the values of fields that should not be there are not kept.
  if (unknown.length > 0) out.rejectedFields = unknown.slice(0, 10).map((key) => key.slice(0, 60));
  return out;
}

/** "The figures are units (stk) ... Periods: ..." plus the source line. Appended by the platform. */
export function renderSalesFooter(result: SalesResult, lookupId: string): string {
  const periods = result.periods.map((period) => periodRange(period, result.timezone)).join("; ");
  return [
    `The figures are units (stk), not kroner. Periods: ${periods}.`,
    renderSourceFooter(result, lookupId),
  ].join("\n");
}

type ProductTypeMatch =
  | { kind: "one"; type: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none"; nearest: string[] };

/**
 * Matches the person's word against the catalog, ignoring case and accents.
 * More than one type containing it is ALWAYS ambiguous -- even when one of
 * them matches exactly ("sofa" vs Sofa, Hjørnesofa, Sovesofa, Sofabord) --
 * because "sofa" is exactly the word people mean differently.
 */
export function matchProductType(query: string, catalogTypes: string[]): ProductTypeMatch {
  const needle = normalizeForMatch(query);
  const candidates = catalogTypes.filter((type) => normalizeForMatch(type).includes(needle));
  if (candidates.length === 1) return { kind: "one", type: candidates[0]! };
  if (candidates.length > 1) {
    return { kind: "ambiguous", candidates: [...candidates].sort((a, b) => a.localeCompare(b, "nb")) };
  }
  return { kind: "none", nearest: nearestValues(query, catalogTypes, 3) };
}

export interface BusinessDataServiceDeps extends DataConnectionServiceDeps {}

export function businessDataService(db: Db, deps: BusinessDataServiceDeps = {}) {
  const connections = dataConnectionService(db, deps);
  const instanceSettings = instanceSettingsService(db);
  const nowMs = deps.now ?? Date.now;

  async function featureOn(): Promise<boolean> {
    const experimental = await instanceSettings.getExperimental();
    return experimental.enableBusinessData === true;
  }

  async function companyName(companyId: string): Promise<string> {
    const [row] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
    return row?.name ?? "Dette selskapet";
  }

  /** Whether the quick-agent tool should be offered to this company at all. */
  async function isAvailable(companyId: string): Promise<boolean> {
    return (await connections.getActiveDatasetSource(companyId, BUSINESS_DATA_DATASET)) !== null;
  }

  async function writeAudit(
    caller: BusinessDataCaller,
    input: {
      id?: string;
      connectionId: string | null;
      params: Record<string, unknown>;
      outcome: DataReadOutcome;
      refusalCode: string | null;
      facts?: Record<string, unknown> | null;
      audit?: Partial<DataLookupAudit>;
      startedAt: number;
      scrubValues?: string[];
    },
  ): Promise<string> {
    return recordDataReadEvent(db, {
      id: input.id,
      createdAt: new Date(nowMs()),
      companyId: caller.companyId,
      connectionId: input.connectionId,
      dataset: BUSINESS_DATA_DATASET,
      channel: caller.channel,
      agentId: caller.agentId,
      userId: caller.userId,
      runId: caller.runId,
      laneAConversationId: caller.laneAConversationId,
      params: input.params,
      outcome: input.outcome,
      refusalCode: input.refusalCode,
      facts: input.facts ?? null,
      upstreamRequests: input.audit?.upstreamRequests ?? 0,
      costPoints: input.audit?.costPoints ?? 0,
      durationMs: nowMs() - input.startedAt,
      scrubValues: input.scrubValues,
    });
  }

  /** A refusal (or ambiguity) with its audit row. The sentence is given even if the audit row fails. */
  async function refuse(
    caller: BusinessDataCaller,
    input: {
      connectionId: string | null;
      params: Record<string, unknown>;
      outcome: DataReadOutcome;
      code: string;
      message: string;
      detail?: Record<string, unknown>;
      audit?: Partial<DataLookupAudit>;
      startedAt: number;
      scrubValues?: string[];
    },
  ): Promise<BusinessDataAnswer> {
    let lookupId: string | null = null;
    try {
      lookupId = await writeAudit(caller, {
        connectionId: input.connectionId,
        params: input.params,
        outcome: input.outcome,
        refusalCode: input.code,
        facts: { answer: input.message, ...(input.detail ?? {}) },
        audit: input.audit,
        startedAt: input.startedAt,
        scrubValues: input.scrubValues,
      });
    } catch (error) {
      logger.warn(
        { companyId: caller.companyId, code: input.code, err: error instanceof Error ? error.message : String(error) },
        "business data: could not write the audit row for a refusal",
      );
    }
    return {
      ok: false,
      outcome: input.outcome,
      refusalCode: input.code,
      lookupId,
      text: input.message,
      footer: null,
    };
  }

  async function limitRefusal(
    caller: BusinessDataCaller,
    dailyCap: number,
    name: string,
  ): Promise<{ code: string; message: string } | null> {
    const now = new Date(nowMs());
    const minuteAgo = new Date(now.getTime() - 60_000);
    const base = {
      companyId: caller.companyId,
      dataset: BUSINESS_DATA_DATASET,
      excludeOutcomes: NOT_COUNTED_OUTCOMES,
    };
    if (caller.runId) {
      const used = await countDataReadEvents(db, { ...base, runId: caller.runId, since: new Date(0) });
      if (used >= BUSINESS_DATA_LIMITS.perRun) {
        return {
          code: "run_limit",
          message:
            `This run has already made ${BUSINESS_DATA_LIMITS.perRun} sales-data lookups, which is the limit per run. ` +
            "I am not making any more lookups now. The limit is fixed in Paperclip and can only be changed by whoever operates Paperclip.",
        };
      }
    }
    if (caller.agentId) {
      const used = await countDataReadEvents(db, { ...base, agentId: caller.agentId, since: minuteAgo });
      if (used >= BUSINESS_DATA_LIMITS.perAgentPerMinute) {
        return {
          code: "agent_minute_limit",
          message:
            `I have made ${BUSINESS_DATA_LIMITS.perAgentPerMinute} sales-data lookups in the last minute, which is the limit per agent. ` +
            "Wait a minute and ask again. The limit is fixed in Paperclip and can only be changed by whoever operates Paperclip.",
        };
      }
    }
    const companyMinute = await countDataReadEvents(db, { ...base, since: minuteAgo });
    if (companyMinute >= BUSINESS_DATA_LIMITS.perCompanyPerMinute) {
      return {
        code: "company_minute_limit",
        message:
          `${name} has made ${BUSINESS_DATA_LIMITS.perCompanyPerMinute} sales-data lookups in the last minute, which is the limit per company. ` +
          "Wait a minute and ask again. The limit is fixed in Paperclip and can only be changed by whoever operates Paperclip.",
      };
    }
    const today = zonedParts(now, LIMIT_DAY_TIMEZONE);
    const dayStart = zonedDayStart(today.year, today.month, today.day, LIMIT_DAY_TIMEZONE);
    const usedToday = await countDataReadEvents(db, { ...base, since: dayStart });
    if (usedToday >= dailyCap) {
      return {
        code: "daily_cap",
        message:
          `${name} has used all ${dailyCap} sales-data lookups for today, which is the daily limit. ` +
          "The limit resets at midnight (Norwegian time). A board user can raise it under Settings → Data sources.",
      };
    }
    return null;
  }

  /**
   * One lookup. Never throws for anything a person could cause: every path
   * ends in an answer, and every answer (refusals included) has an audit row.
   * `options.connectionId` is the board-only trial, which reads through a
   * named connection of the SAME company before "Salg" is ticked.
   */
  async function read(
    caller: BusinessDataCaller,
    rawInput: unknown,
    options: { connectionId?: string; allowLargeAnswer?: boolean } = {},
  ): Promise<BusinessDataAnswer> {
    const startedAt = nowMs();
    const params = auditParams(rawInput);
    let connectionId: string | null = null;
    let scrubValues: () => string[] = () => [];
    try {
      const name = await companyName(caller.companyId);

      // 1-3: the company's own source, active, with the instance switch on.
      if (!(await featureOn())) {
        return refuse(caller, {
          connectionId: null, params, outcome: "refused", code: "business_data_disabled",
          message: FEATURE_OFF_MESSAGE, startedAt,
        });
      }
      let row: Awaited<ReturnType<typeof connections.getActiveDatasetSource>>;
      if (options.connectionId) {
        row = await connections.getRow(caller.companyId, options.connectionId);
        if (row.status !== "active") {
          return refuse(caller, {
            connectionId: row.id, params, outcome: "refused", code: "data_connection_not_active",
            message: "The data connection is not switched on. Press Test first.", startedAt,
          });
        }
      } else {
        row = await connections.getActiveDatasetSource(caller.companyId, BUSINESS_DATA_DATASET);
      }
      if (!row) {
        return refuse(caller, {
          connectionId: null, params, outcome: "refused", code: "not_connected",
          message: notConnectedMessage(name), startedAt,
        });
      }
      connectionId = row.id;

      // 4: strict input; kroner refused before anything else is spent.
      const rawMeasure = (rawInput as { measure?: unknown } | null)?.measure;
      if (
        Array.isArray(rawMeasure) &&
        rawMeasure.every((entry) => typeof entry === "string") &&
        isKronerOnlyRefusal(rawMeasure as string[])
      ) {
        return refuse(caller, {
          connectionId, params, outcome: "refused", code: "kroner_not_enabled",
          message: KRONER_NOT_ENABLED_MESSAGE, startedAt,
        });
      }
      const parsed = readBusinessDataInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        const unknownKeys = parsed.error.issues.some((issue) => issue.code === "unrecognized_keys");
        const badPeriod = parsed.error.issues.some((issue) => issue.path[0] === "periods");
        return refuse(caller, {
          connectionId, params, outcome: "refused", code: "invalid_request",
          message: unknownKeys
            ? "The lookup had fields the tool does not accept. Use only action, periods, measure, product_type_query, product_types and group_by."
            : badPeriod
              ? "The period must be last_month, month_before_last, this_month_to_date or a month like 2026-07, and at most two periods."
              : "The question could not be turned into a valid lookup.",
          detail: { issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) },
          startedAt,
        });
      }
      const input = parsed.data;
      if (input.action === "sales" && !input.periods) {
        return refuse(caller, {
          connectionId, params, outcome: "refused", code: "invalid_request",
          message: "A sales lookup needs one or two periods, for example last_month.", startedAt,
        });
      }
      if (input.product_type_query && input.product_types) {
        return refuse(caller, {
          connectionId, params, outcome: "refused", code: "invalid_request",
          message: "Use either product_type_query or product_types, not both.", startedAt,
        });
      }

      // 5: limits, counted from the audit table.
      const limited = await limitRefusal(caller, row.dailyLookupCap, name);
      if (limited) {
        return refuse(caller, {
          connectionId, params, outcome: "rate_limited", code: limited.code, message: limited.message, startedAt,
        });
      }

      // 6: the read context (resolves the key lazily, inside the transport).
      let opened: Awaited<ReturnType<typeof connections.openReadContext>>;
      try {
        opened = await connections.openReadContext(
          caller.companyId,
          row.id,
          caller.agentId
            ? { actorType: "agent", actorId: caller.agentId }
            : { actorType: caller.userId ? "user" : "system", actorId: caller.userId ?? "business_data" },
          PRODUCT_TYPE_READ_BUDGET,
        );
      } catch (error) {
        if (error instanceof HttpError) {
          const code = (error.details as { code?: string } | undefined)?.code ?? "not_available";
          return refuse(caller, { connectionId, params, outcome: "refused", code, message: error.message, startedAt });
        }
        throw error;
      }
      const { read: context, knownSecrets } = opened;
      scrubValues = knownSecrets;

      // Product-type matching happens here, on the server, against the catalog.
      let productTypes: string[] | undefined = input.product_types;
      if (input.action === "sales" && input.product_type_query) {
        let catalogTypes: string[];
        try {
          catalogTypes = await readProductTypes(context.shopify);
        } catch (error) {
          const message =
            error instanceof ShopifyClientError
              ? `${error.message} So I am not giving any figures.`
              : "Shopify answered with an error, so I am not giving any figures. Try again later.";
          return refuse(caller, {
            connectionId, params, outcome: "upstream_error", code: "upstream_error", message, startedAt,
            audit: { upstreamRequests: context.shopify.stats().requests, costPoints: context.shopify.stats().costPoints },
            scrubValues: knownSecrets(),
          });
        }
        const match = matchProductType(input.product_type_query, catalogTypes);
        if (match.kind === "ambiguous") {
          return refuse(caller, {
            connectionId, params, outcome: "ambiguous", code: "ambiguous_product_type",
            message:
              `"${input.product_type_query}" matches several product types in Shopify: ${match.candidates.join(", ")}. ` +
              "Ask the person which of these to count, and call the tool again with product_types. Do not guess.",
            detail: { candidates: match.candidates },
            audit: { upstreamRequests: context.shopify.stats().requests },
            startedAt,
            scrubValues: knownSecrets(),
          });
        }
        if (match.kind === "none") {
          return refuse(caller, {
            connectionId, params, outcome: "refused", code: "unknown_product_type",
            message:
              `Could not find a product type matching "${input.product_type_query}" in Shopify.` +
              (match.nearest.length > 0 ? ` Closest: ${match.nearest.join(", ")}.` : ""),
            audit: { upstreamRequests: context.shopify.stats().requests },
            startedAt,
            scrubValues: knownSecrets(),
          });
        }
        productTypes = [match.type];
      }

      // 7: the engine, inside what is left of the lookup's time.
      const remainingMs = Math.max(1_000, BUSINESS_DATA_LOOKUP_TIMEOUT_MS - (nowMs() - startedAt));
      const adapter = createShopifySalesAdapter({
        client: context.shopifyTransport,
        limits: { maxDurationMs: remainingMs },
        clock: { now: context.now, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
      });
      const extraRequests = context.shopify.stats().requests;
      const lookupId = randomUUID();

      if (input.action === "catalog") {
        const outcome = await adapter.catalog({});
        const audit = { ...outcome.audit, upstreamRequests: outcome.audit.upstreamRequests + extraRequests };
        if (!outcome.ok) {
          return refuse(caller, {
            connectionId, params, outcome: upstreamLike(outcome.refusal.code) ? "upstream_error" : "refused",
            code: outcome.refusal.code, message: outcome.refusal.message,
            detail: { detail: outcome.refusal.detail ?? [] }, audit, startedAt, scrubValues: knownSecrets(),
          });
        }
        const card = scrubSecrets(renderCatalogAnswerCard(outcome.result, { lookupId }), knownSecrets());
        return finish(caller, {
          lookupId, connectionId, params, outcome: "ok", card,
          footer: renderSourceFooter(outcome.result, lookupId), audit, startedAt, scrubValues: knownSecrets(),
          allowLargeAnswer: options.allowLargeAnswer === true,
        });
      }

      const outcome = await adapter.sales({
        periods: input.periods!,
        measure: ["units"],
        ...(productTypes ? { productTypes } : {}),
        groupBy: input.group_by ?? "none",
      });
      const audit = {
        ...outcome.audit,
        upstreamRequests: outcome.audit.upstreamRequests + extraRequests,
      };
      if (!outcome.ok) {
        return refuse(caller, {
          connectionId, params, outcome: upstreamLike(outcome.refusal.code) ? "upstream_error" : "refused",
          code: outcome.refusal.code, message: outcome.refusal.message,
          detail: {
            detail: outcome.refusal.detail ?? [],
            invariantViolations: outcome.audit.invariantViolations,
          },
          audit, startedAt, scrubValues: knownSecrets(),
        });
      }

      // 8: re-validate and re-check before anything reaches the model.
      const checked = salesResultSchema.safeParse(outcome.result);
      const violations = checked.success ? checkSalesInvariants(checked.data) : ["result does not match the contract"];
      if (!checked.success || violations.length > 0) {
        return refuse(caller, {
          connectionId, params, outcome: "refused", code: "invariant_failed",
          message: "The figures from Shopify did not add up when I checked them, so I am not giving an answer. The error has been logged.",
          detail: { invariantViolations: violations.slice(0, 20) }, audit, startedAt, scrubValues: knownSecrets(),
        });
      }
      const result = checked.data;
      const card = scrubSecrets(renderSalesAnswerCard(result, { lookupId }), knownSecrets());
      const allNoData = result.periods.every((period) => period.dataState === "no_data");
      return finish(caller, {
        lookupId, connectionId, params: { ...params, resolvedProductTypes: productTypes ?? null },
        outcome: allNoData ? "no_data" : "ok", card,
        footer: renderSalesFooter(result, lookupId), audit, startedAt, scrubValues: knownSecrets(),
        warnings: outcome.audit.warnings,
        allowLargeAnswer: options.allowLargeAnswer === true,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404 && options.connectionId) throw error;
      logger.warn(
        {
          companyId: caller.companyId,
          err: scrubSecrets(error instanceof Error ? error.message : String(error), scrubValues()),
        },
        "business data: lookup failed unexpectedly",
      );
      return refuse(caller, {
        connectionId, params, outcome: "upstream_error", code: "unexpected_error",
        message: UNEXPECTED_MESSAGE, startedAt, scrubValues: scrubValues(),
      });
    }
  }

  async function finish(
    caller: BusinessDataCaller,
    input: {
      lookupId: string;
      connectionId: string;
      params: Record<string, unknown>;
      outcome: DataReadOutcome;
      card: string;
      footer: string;
      audit: Partial<DataLookupAudit>;
      startedAt: number;
      scrubValues: string[];
      warnings?: string[];
      allowLargeAnswer: boolean;
    },
  ): Promise<BusinessDataAnswer> {
    // 9: complete or nothing -- an answer too big for the audit row is not cut.
    const facts: Record<string, unknown> = { answer: input.card };
    if (input.warnings && input.warnings.length > 0) facts.warnings = input.warnings.slice(0, 10);
    if (byteLength(facts) > ANSWER_MAX_BYTES && !input.allowLargeAnswer) {
      return refuse(caller, {
        connectionId: input.connectionId, params: input.params, outcome: "refused", code: "answer_too_large",
        message: "The answer was too large to give in one go (too many product types). Ask for fewer product types or without grouping.",
        audit: input.audit, startedAt: input.startedAt, scrubValues: input.scrubValues,
      });
    }
    // 12: no audit row, no answer.
    try {
      await writeAudit(caller, {
        id: input.lookupId,
        connectionId: input.connectionId,
        params: input.params,
        outcome: input.outcome,
        refusalCode: null,
        facts,
        audit: input.audit,
        startedAt: input.startedAt,
        scrubValues: input.scrubValues,
      });
    } catch (error) {
      logger.warn(
        { companyId: caller.companyId, err: error instanceof Error ? error.message : String(error) },
        "business data: could not write the audit row; the answer is withheld",
      );
      return {
        ok: false,
        outcome: "refused",
        refusalCode: "audit_failed",
        lookupId: null,
        text: "The lookup could not be logged, so I am not giving any figures. Try again in a moment.",
        footer: null,
      };
    }
    return {
      ok: true,
      outcome: input.outcome,
      refusalCode: null,
      lookupId: input.lookupId,
      text: input.card,
      footer: input.footer,
    };
  }

  // The board's "Prøveberegning" is served by services/data-trial.ts (slice S2),
  // which runs the same S3 sales engine as read() above with the operator's own
  // choice of months. Moving it onto read() itself, so trial and agent answers
  // share one path end to end, is a tracked follow-up.
  return { featureOn, isAvailable, read, companyName };
}

async function readProductTypes(client: { query<T>(document: string, variables?: Record<string, unknown>): Promise<T> }) {
  const types = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 8; page += 1) {
    const data: { productTypes: { nodes: string[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null } =
      await client.query(PRODUCT_TYPES_QUERY, { first: 250, after });
    if (!data.productTypes) return [...types];
    for (const value of data.productTypes.nodes) {
      const type = typeof value === "string" ? value.trim() : "";
      if (type) types.add(type);
    }
    if (!data.productTypes.pageInfo.hasNextPage) return [...types];
    after = data.productTypes.pageInfo.endCursor;
  }
  // More product types than we read: a match against a partial list could be wrong.
  throw new Error("product type list longer than the read limit");
}

export type BusinessDataService = ReturnType<typeof businessDataService>;
