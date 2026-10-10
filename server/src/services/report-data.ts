import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  DATA_CONNECTION_KIND_LABELS,
  REPORT_DATASET_KINDS,
  REPORT_DATASET_LABELS,
  reportDataQuerySchema,
  reportPeriodSchema,
  resolveReportPeriod,
  type DataReadOutcome,
  type ReportDataItem,
  type ReportDataPreview,
  type ReportDataPreviewItem,
  type ReportDataQuery,
  type ResolvedReportPeriod,
} from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { dataConnectionService, type DataConnectionServiceDeps } from "./data-connections.js";
import { countDataReadEvents, recordDataReadEvent } from "./data-read-audit.js";
import { isPlainReadError, readReportDataItem } from "./data-sources/report-data-readers.js";
import { getDataSourceKind } from "./data-sources/registry.js";
import { scrubSecrets } from "./data-sources/shopify-client.js";
import { zonedDayStart, zonedParts } from "./data-sources/zoned-time.js";

/**
 * DUR-4072 PR3: a report template's data, fetched by the SERVER.
 *
 * Fixed order, every step before the next:
 *   1. the company comes from the caller's server-side context; the
 *      connection is looked up WITHIN that company only (another company's
 *      id is "not found", whatever the template row says)
 *   2. the query is re-validated, and every dataset must be one this
 *      connection's kind can give
 *   3. the connection's daily cap (the same `dailyLookupCap` agents' lookups
 *      count against) must have room for every dataset
 *   4. the read context is opened by dataConnectionService: it refuses while
 *      the instance switch "Business data sources" is off or the connection
 *      is not switched on, and it resolves the key lazily INSIDE the
 *      transport -- no key is ever returned here, so neither the agent nor
 *      the calculation script can see it
 *   5. each dataset is read under a request budget, a wall-clock deadline
 *      and a row cap; one data_read_events row per dataset, refusals
 *      included (facts: counts, bytes and digest -- never the data)
 *   6. the whole snapshot is capped in bytes and hashed (sha256 of exactly
 *      the JSON the script will get)
 *
 * No path here writes to a source: readers only read (report-data-readers.ts).
 */

export const REPORT_DATA_LIMITS = {
  /** Upstream requests for the whole fetch (all datasets). */
  maxRequests: 400,
  /** Wall-clock time for the whole fetch. */
  deadlineMs: 120_000,
  /** Rows one dataset may hold. */
  maxRowsPerDataset: 50_000,
  /** Bytes one file may have. */
  maxFileBytes: 5 * 1024 * 1024,
  /** Bytes of the whole input snapshot. */
  maxSnapshotBytes: 8 * 1024 * 1024,
  /** Rows a preview shows per dataset. */
  previewRows: 20,
} as const;

const PERIOD_TIMEZONE = "Europe/Oslo";

export interface ReportDataCaller {
  companyId: string;
  channel: "report_run" | "report_preview";
  agentId?: string | null;
  userId?: string | null;
  /** The heartbeat run, when an agent asked. */
  runId?: string | null;
  templateId?: string | null;
  reportRunId?: string | null;
}

/** The input snapshot the calculation script gets, stored on the report run. */
export interface ReportDataSnapshot {
  period: ResolvedReportPeriod;
  source: { kind: string; kindLabel: string; name: string };
  data: Record<string, unknown>;
  /** data_read_events row per dataset, for tracing a figure back to its read. */
  lookups: Record<string, string>;
}

interface FetchedItem extends ReportDataPreviewItem {
  data?: unknown;
  rows?: unknown[];
}

export class ReportDataFetchError extends Error {
  readonly code: string;
  readonly items: FetchedItem[];
  constructor(code: string, message: string, items: FetchedItem[] = []) {
    super(message);
    this.name = "ReportDataFetchError";
    this.code = code;
    this.items = items;
  }
}

/**
 * The same value with every object's keys in sorted order (arrays keep their
 * order). Postgres jsonb does not keep key order, so the snapshot is put in
 * this form BEFORE it is hashed and handed to the script: then the stored
 * row, re-serialised the same way, gives the same digest.
 */
export function canonicalizeJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = canonicalizeJson(entry);
    }
    return out as T;
  }
  return value;
}

export function sha256OfJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null), "utf8").digest("hex");
}

export type ReportDataServiceDeps = DataConnectionServiceDeps;

/**
 * DUR-4717: at most ONE report data fetch (run or preview) per company at a
 * time, in this server process. Without it, parallel starts could each pass
 * the daily-cap count before any of them wrote its audit rows (overshooting
 * `dailyLookupCap`) and hit Fiken in parallel, which Fiken does not allow.
 * A second fetch while one is running is refused with a plain sentence, not
 * queued. Module-level on purpose: every route builds its own service.
 * Paperclip runs one server process per instance; a second process would
 * need a database lock instead.
 */
const companiesFetching = new Set<string>();

export const REPORT_DATA_BUSY_MESSAGE =
  "Another report is reading this company's data right now. Try again when it has finished (usually within a minute or two).";

export function reportDataService(db: Db, deps: ReportDataServiceDeps = {}) {
  const connections = dataConnectionService(db, deps);
  const nowMs = deps.now ?? Date.now;

  function resolvePeriod(token: string): ResolvedReportPeriod {
    const parsed = reportPeriodSchema.safeParse(token);
    if (!parsed.success) throw unprocessable("The period is not one Paperclip understands (for example last_quarter, 2026-Q3 or 2026-07).");
    const today = zonedParts(new Date(nowMs()), PERIOD_TIMEZONE);
    const period = resolveReportPeriod(parsed.data, today);
    const todayText = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
    if (period.from > todayText) throw unprocessable(`${period.label} has not started yet.`, { code: "period_in_future" });
    return period;
  }

  async function audit(
    caller: ReportDataCaller,
    input: {
      connectionId: string | null;
      item: ReportDataItem | null;
      period: ResolvedReportPeriod | null;
      outcome: DataReadOutcome;
      refusalCode: string | null;
      facts: Record<string, unknown> | null;
      upstreamRequests: number;
      startedAt: number;
      scrubValues: string[];
    },
  ): Promise<string> {
    return recordDataReadEvent(db, {
      createdAt: new Date(nowMs()),
      companyId: caller.companyId,
      connectionId: input.connectionId,
      dataset: input.item ? `report:${input.item.dataset}` : "report",
      channel: caller.channel,
      agentId: caller.agentId ?? null,
      userId: caller.userId ?? null,
      runId: caller.runId ?? null,
      params: {
        ...(input.item ? { key: input.item.key, dataset: input.item.dataset } : {}),
        ...(input.item?.dataset === "file" ? { path: input.item.path.slice(0, 200), format: input.item.format } : {}),
        ...(input.period ? { period: input.period.token, from: input.period.from, to: input.period.to } : {}),
        ...(caller.templateId ? { templateId: caller.templateId } : {}),
        ...(caller.reportRunId ? { reportRunId: caller.reportRunId } : {}),
      },
      outcome: input.outcome,
      refusalCode: input.refusalCode,
      facts: input.facts,
      upstreamRequests: input.upstreamRequests,
      durationMs: nowMs() - input.startedAt,
      scrubValues: input.scrubValues,
    });
  }

  /**
   * Reads every dataset of `rawQuery` through the company's own connection.
   * Throws ReportDataFetchError (plain sentence, with what was read so far)
   * on any refusal; every read and refusal has its audit row first.
   */
  type FetchResult = { snapshot: ReportDataSnapshot; sha256: string; bytes: number; items: FetchedItem[] };

  async function fetch(caller: ReportDataCaller, connectionId: string, rawQuery: unknown, periodOverride?: string | null): Promise<FetchResult> {
    if (companiesFetching.has(caller.companyId)) {
      try {
        await audit(caller, {
          connectionId: null,
          item: null,
          period: null,
          outcome: "rate_limited",
          refusalCode: "fetch_in_progress",
          facts: { answer: REPORT_DATA_BUSY_MESSAGE },
          upstreamRequests: 0,
          startedAt: nowMs(),
          scrubValues: [],
        });
      } catch (error) {
        logger.warn({ companyId: caller.companyId, err: error instanceof Error ? error.message : String(error) }, "report data: could not audit a busy refusal");
      }
      throw new ReportDataFetchError("fetch_in_progress", REPORT_DATA_BUSY_MESSAGE);
    }
    companiesFetching.add(caller.companyId);
    try {
      return await fetchLocked(caller, connectionId, rawQuery, periodOverride);
    } finally {
      companiesFetching.delete(caller.companyId);
    }
  }

  async function fetchLocked(
    caller: ReportDataCaller,
    connectionId: string,
    rawQuery: unknown,
    periodOverride?: string | null,
  ): Promise<FetchResult> {
    const startedAt = nowMs();
    const parsedQuery = reportDataQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      throw new ReportDataFetchError("invalid_query", "The template's data settings are not valid. Open the template and choose the data again.");
    }
    const query: ReportDataQuery = parsedQuery.data;

    // 1: within the caller's company only (getRow filters on companyId).
    let row: Awaited<ReturnType<typeof connections.getRow>>;
    try {
      row = await connections.getRow(caller.companyId, connectionId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw new ReportDataFetchError("not_found", "The template's data connection was not found in this company.");
      }
      throw error;
    }
    const definition = getDataSourceKind(row.kind);
    const kindLabel = DATA_CONNECTION_KIND_LABELS[definition.kind];

    let period: ResolvedReportPeriod;
    try {
      period = resolvePeriod(periodOverride ?? query.period);
    } catch (error) {
      throw new ReportDataFetchError("invalid_period", error instanceof Error ? error.message : "The period is not valid.");
    }

    const refuseAll = async (code: string, message: string, outcome: DataReadOutcome = "refused"): Promise<never> => {
      try {
        await audit(caller, { connectionId: row.id, item: null, period, outcome, refusalCode: code, facts: { answer: message }, upstreamRequests: 0, startedAt, scrubValues: [] });
      } catch (error) {
        logger.warn({ companyId: caller.companyId, code, err: error instanceof Error ? error.message : String(error) }, "report data: could not audit a refusal");
      }
      throw new ReportDataFetchError(code, message);
    };

    // 2: every dataset must fit this kind of connection.
    for (const item of query.items) {
      if (!REPORT_DATASET_KINDS[item.dataset].includes(definition.kind)) {
        await refuseAll("dataset_not_offered", `${kindLabel} cannot give "${REPORT_DATASET_LABELS[item.dataset].label}".`);
      }
    }

    // 3: the connection's daily cap, counted from the audit table (Norwegian day).
    const today = zonedParts(new Date(nowMs()), PERIOD_TIMEZONE);
    const used = await countDataReadEvents(db, {
      companyId: caller.companyId,
      connectionId: row.id,
      since: zonedDayStart(today.year, today.month, today.day, PERIOD_TIMEZONE),
      excludeOutcomes: ["rate_limited"],
    });
    if (used + query.items.length > row.dailyLookupCap) {
      await refuseAll(
        "daily_cap",
        `The connection "${row.name}" has used ${used} of its ${row.dailyLookupCap} reads for today. The limit resets at midnight (Norwegian time); a board user can raise it under Settings → Data sources.`,
        "rate_limited",
      );
    }

    // 4: the read context -- refuses when switched off / not active; key stays inside.
    let opened: Awaited<ReturnType<typeof connections.openReadContext>>;
    try {
      opened = await connections.openReadContext(
        caller.companyId,
        row.id,
        caller.agentId ? { actorType: "agent", actorId: caller.agentId } : { actorType: caller.userId ? "user" : "system", actorId: caller.userId ?? "report_data" },
        { maxRequests: REPORT_DATA_LIMITS.maxRequests, deadlineMs: REPORT_DATA_LIMITS.deadlineMs },
      );
    } catch (error) {
      if (error instanceof HttpError) return refuseAll((error.details as { code?: string } | undefined)?.code ?? "not_available", error.message);
      throw error;
    }
    const { read: context, knownSecrets } = opened;

    // 5: one dataset at a time, each audited.
    const items: FetchedItem[] = [];
    const data: Record<string, unknown> = {};
    const lookups: Record<string, string> = {};
    try {
      for (const item of query.items) {
        const itemStartedAt = nowMs();
        const requestsBefore = context.stats().requests;
        const label = REPORT_DATASET_LABELS[item.dataset].label;
        const remainingMs = REPORT_DATA_LIMITS.deadlineMs - (itemStartedAt - startedAt);
        try {
          if (remainingMs <= 1_000) throw new ReportDataFetchError("time_budget_exceeded", "Reading the report's data took too long, so it was stopped.");
          const result = await readReportDataItem(context, item, period, {
            maxRows: REPORT_DATA_LIMITS.maxRowsPerDataset,
            maxFileBytes: REPORT_DATA_LIMITS.maxFileBytes,
            maxDurationMs: remainingMs,
            ...(deps.sleep ? { sleep: deps.sleep } : {}),
          });
          const itemJson = JSON.stringify(result.data ?? null);
          const lookupId = await audit(caller, {
            connectionId: row.id,
            item,
            period,
            outcome: result.rowCount === 0 ? "no_data" : "ok",
            refusalCode: null,
            facts: { rows: result.rowCount, bytes: Buffer.byteLength(itemJson, "utf8"), sha256: sha256OfJson(result.data) },
            upstreamRequests: context.stats().requests - requestsBefore,
            startedAt: itemStartedAt,
            scrubValues: knownSecrets(),
          });
          data[item.key] = result.data;
          lookups[item.key] = lookupId;
          items.push({ key: item.key, dataset: item.dataset, label, ok: true, rowCount: result.rowCount, sampleRows: [], message: null, lookupId, data: result.data, rows: result.rows });
        } catch (error) {
          const plain = isPlainReadError(error) || error instanceof ReportDataFetchError;
          const code = plain ? (error as { code: string }).code : "unexpected_error";
          const message = plain
            ? scrubSecrets((error as Error).message, knownSecrets())
            : `${kindLabel} could not be read because of an error, so no data was used. The error has been logged.`;
          if (!plain) {
            logger.warn({ companyId: caller.companyId, err: scrubSecrets(error instanceof Error ? error.message : String(error), knownSecrets()) }, "report data: read failed unexpectedly");
          }
          let lookupId: string | null = null;
          try {
            lookupId = await audit(caller, {
              connectionId: row.id,
              item,
              period,
              outcome: code === "too_many_rows" || code === "dataset_not_offered" ? "refused" : "upstream_error",
              refusalCode: code,
              facts: { answer: message },
              upstreamRequests: context.stats().requests - requestsBefore,
              startedAt: itemStartedAt,
              scrubValues: knownSecrets(),
            });
          } catch (auditError) {
            logger.warn({ companyId: caller.companyId, err: auditError instanceof Error ? auditError.message : String(auditError) }, "report data: could not audit a failed read");
          }
          items.push({ key: item.key, dataset: item.dataset, label, ok: false, rowCount: 0, sampleRows: [], message, lookupId });
          throw new ReportDataFetchError(code, `Could not read "${label}": ${message}`, items);
        }
      }
    } finally {
      if (context.kind === "ftp_file" || context.kind === "ftps_file" || context.kind === "sftp_file") {
        await context.files.close().catch(() => undefined);
      }
    }

    // 6: the snapshot, capped and hashed.
    const snapshot: ReportDataSnapshot = { period, source: { kind: definition.kind, kindLabel, name: row.name }, data, lookups };
    const json = JSON.stringify(snapshot);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > REPORT_DATA_LIMITS.maxSnapshotBytes) {
      throw new ReportDataFetchError(
        "snapshot_too_large",
        `The report's data is ${(bytes / 1024 / 1024).toFixed(1)} MB, more than the ${REPORT_DATA_LIMITS.maxSnapshotBytes / 1024 / 1024} MB a report may use. Choose a shorter period or fewer datasets.`,
        items,
      );
    }
    const canonical = canonicalizeJson(snapshot);
    return { snapshot: canonical, sha256: sha256OfJson(canonical), bytes, items };
  }

  /**
   * "Preview data" on the template page (owner/admin only, checked by the
   * route): the same audited fetch, answered with counts and the first rows.
   */
  async function preview(caller: ReportDataCaller, connectionId: string, rawQuery: unknown, periodOverride?: string | null): Promise<ReportDataPreview> {
    const row = await connections.getRow(caller.companyId, connectionId);
    const kindLabel = DATA_CONNECTION_KIND_LABELS[getDataSourceKind(row.kind).kind];
    const toPreview = (item: FetchedItem): ReportDataPreviewItem => ({
      key: item.key,
      dataset: item.dataset,
      label: item.label,
      ok: item.ok,
      rowCount: item.rowCount,
      sampleRows: (item.rows ?? []).slice(0, REPORT_DATA_LIMITS.previewRows),
      message: item.message,
      lookupId: item.lookupId,
    });
    try {
      const fetched = await fetch(caller, connectionId, rawQuery, periodOverride);
      return {
        connectionName: row.name,
        kindLabel,
        period: fetched.snapshot.period,
        items: fetched.items.map(toPreview),
        bytes: fetched.bytes,
        sha256: fetched.sha256,
      };
    } catch (error) {
      if (!(error instanceof ReportDataFetchError)) throw error;
      if (error.items.length === 0) throw unprocessable(error.message, { code: error.code });
      const query = reportDataQuerySchema.parse(rawQuery);
      return {
        connectionName: row.name,
        kindLabel,
        period: resolvePeriod(periodOverride ?? query.period),
        items: error.items.map(toPreview),
        bytes: 0,
        sha256: null,
      };
    }
  }

  return { fetch, preview, resolvePeriod };
}

export type ReportDataService = ReturnType<typeof reportDataService>;
