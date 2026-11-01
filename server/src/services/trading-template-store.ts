import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tradingBacktestHoldoutReads, tradingBacktestTrials, tradingEligibilityMatrices, tradingTemplateReports, tradingTemplateTrials } from "@paperclipai/db";
import {
  TRADING_BACKTEST_COSTS,
  TRADING_BACKTEST_LIMITS,
  TRADING_ELIGIBILITY_MATRIX_V1,
  TRADING_EXCLUDED_STYLES,
  TRADING_START_GATE,
  TRADING_TEMPLATE_LIBRARY_VERSION,
  canonicalTradingJson,
  findTradingTemplate,
  tradingEligibilityMatrixSchema,
  tradingTemplateLabel,
  tradingTemplateProblems,
  tradingTemplateStartingValues,
  tradingTemplates,
  type HoldoutRead,
  type TradingEligibilityMatrix,
  type TradingTemplate,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import type { BacktestOutcome, BacktestRunParams } from "./trading-backtest-run.js";
import { specVariantDigest } from "./trading-backtest-run.js";

/**
 * DUR-5014: the database side of the strategy template library.
 *
 * Library data, not company data (no company_id): reading goes through the
 * instance-admin-only routes until the legal check of decision 19 is done;
 * writing is the bypass connection's job (boot seeding, the report queue and the
 * worker), never a request's. The verdict (`gate_passed`) is only ever written by
 * `finishReport` from the worker's own computation, and the database makes a
 * finished report final.
 *
 * Lineage: a template's report reads the holdout like a gate run does, so those
 * reads and the variants it tried count toward every strategy created from the
 * template (see trading-backtest-store.ts), and the other way round: what a
 * strategy of this template read counts against the template's next report.
 */

export type TradingTemplateReportRow = typeof tradingTemplateReports.$inferSelect;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function templateSpecDigest(template: TradingTemplate): string {
  return specVariantDigest(template.spec);
}

export function matrixDigest(matrix: TradingEligibilityMatrix): string {
  return sha256(canonicalTradingJson(matrix));
}

/** Every matrix version the code knows. Add the next version here, never edit an old one: the table refuses edits. */
export const KNOWN_ELIGIBILITY_MATRICES: readonly TradingEligibilityMatrix[] = [TRADING_ELIGIBILITY_MATRIX_V1];

export interface TemplateReportActor {
  type: "user" | "agent" | "system";
  id: string;
}

export interface TradingTemplateStoreDeps {
  now?: () => Date;
}

export function tradingTemplateStore(db: Db, deps: TradingTemplateStoreDeps = {}) {
  const nowOf = () => deps.now?.() ?? new Date();

  /** Write every known matrix version that is not stored yet. A stored version whose content differs from the code is an error, not an overwrite. */
  async function seedMatrices(): Promise<{ inserted: number }> {
    let inserted = 0;
    for (const matrix of KNOWN_ELIGIBILITY_MATRICES) {
      const digest = matrixDigest(matrix);
      const rows = await db
        .insert(tradingEligibilityMatrices)
        .values({ version: matrix.version, matrix: matrix as unknown as Record<string, unknown>, digest, note: matrix.note })
        .onConflictDoNothing()
        .returning({ version: tradingEligibilityMatrices.version });
      inserted += rows.length;
      if (rows.length === 0) {
        const [stored] = await db.select({ digest: tradingEligibilityMatrices.digest }).from(tradingEligibilityMatrices).where(eq(tradingEligibilityMatrices.version, matrix.version));
        if (stored && stored.digest !== digest) throw new Error(`Eligibility matrix version ${matrix.version} is stored with different content than the code. Matrix versions never change: add a new version.`);
      }
    }
    return { inserted };
  }

  async function listMatrices() {
    const rows = await db.select().from(tradingEligibilityMatrices).orderBy(desc(tradingEligibilityMatrices.version));
    return rows.map((r) => ({ version: r.version, digest: r.digest, note: r.note, createdAt: r.createdAt, matrix: tradingEligibilityMatrixSchema.safeParse(r.matrix).success ? (r.matrix as unknown as TradingEligibilityMatrix) : null }));
  }

  async function latestMatrix(): Promise<{ version: number; digest: string; matrix: TradingEligibilityMatrix }> {
    const all = await listMatrices();
    const latest = all.find((m) => m.matrix !== null);
    if (!latest || !latest.matrix) throw unprocessable("The eligibility matrix has not been stored yet.", { code: "trading_matrix_missing" });
    return { version: latest.version, digest: latest.digest, matrix: latest.matrix };
  }

  /** The newest report of every template version (any status). */
  async function latestReports(): Promise<Map<string, TradingTemplateReportRow>> {
    const rows = await db.select().from(tradingTemplateReports).orderBy(desc(tradingTemplateReports.createdAt));
    const out = new Map<string, TradingTemplateReportRow>();
    for (const row of rows) {
      const key = `${row.templateKey}@${row.templateVersion}`;
      if (!out.has(key)) out.set(key, row);
    }
    return out;
  }

  function reportSummary(row: TradingTemplateReportRow | undefined, template: TradingTemplate) {
    const status = row ? (row.status === "queued" || row.status === "running" ? null : row.status) : null;
    const current = row ? row.specDigest === templateSpecDigest(template) : false;
    const label = tradingTemplateLabel({
      family: template.spec.meta.family,
      reportStatus: current ? (status as "succeeded" | "failed" | "not_testable" | null) : null,
      gatePassed: current ? (row?.gatePassed ?? null) : null,
      missingData: template.requiresData,
    });
    const gate = (row?.gate ?? null) as { summary?: string; passed?: boolean } | null;
    return {
      label: label.label,
      passedPastDataChecks: label.passed,
      report: row
        ? {
            id: row.id,
            status: row.status,
            /** False when the template's rules changed after this report was made. */
            matchesCurrentRules: current,
            matrixVersion: row.matrixVersion,
            gatePassed: row.gatePassed,
            summary: gate?.summary ?? row.error ?? null,
            variantsTried: row.variantsTried,
            holdoutSeenCount: row.holdoutSeenCount,
            createdAt: row.createdAt,
            finishedAt: row.finishedAt,
          }
        : null,
    };
  }

  /** The library as the page shows it: templates (with their latest report summary), controls, the excluded styles and the matrix. */
  async function library() {
    // Read-only: the matrix is stored by the report queue's own connection (see `prepare`), never by a request.
    const matrix = await latestMatrix().catch(() => ({ version: TRADING_ELIGIBILITY_MATRIX_V1.version, digest: matrixDigest(TRADING_ELIGIBILITY_MATRIX_V1), matrix: TRADING_ELIGIBILITY_MATRIX_V1, stored: false }));
    const reports = await latestReports();
    return {
      libraryVersion: TRADING_TEMPLATE_LIBRARY_VERSION,
      matrix: { ...matrix.matrix, digest: matrix.digest, stored: "stored" in matrix ? matrix.stored : true },
      matrixVersions: (await listMatrices()).map((m) => ({ version: m.version, digest: m.digest, note: m.note, createdAt: m.createdAt })),
      templates: tradingTemplates().map((template) => ({
        key: template.key,
        templateVersion: template.templateVersion,
        wave: template.wave,
        style: template.style,
        name: template.spec.meta.name,
        family: template.spec.meta.family,
        thesis: template.spec.meta.thesis,
        commonMistakes: template.spec.meta.commonMistakes,
        worksWhen: template.worksWhen,
        failsWhen: template.failsWhen,
        allowedWeather: template.allowedWeather,
        startingValues: tradingTemplateStartingValues(template),
        requiresData: template.requiresData,
        controlKind: template.controlKind ?? null,
        simplifications: template.simplifications,
        guidelines: template.guidelines,
        decisionTimeframe: template.spec.universe.decisionTimeframe,
        assets: template.spec.universe.assets,
        problems: tradingTemplateProblems(template, matrix.matrix),
        ...reportSummary(reports.get(`${template.key}@${template.templateVersion}`), template),
      })),
      excluded: TRADING_EXCLUDED_STYLES,
    };
  }

  async function getTemplate(key: string) {
    const template = findTradingTemplate(key);
    if (!template) throw notFound("Template not found.");
    const history = await db.select().from(tradingTemplateReports).where(eq(tradingTemplateReports.templateKey, key)).orderBy(desc(tradingTemplateReports.createdAt)).limit(20);
    const lib = await library();
    return { template, summary: lib.templates.find((t) => t.key === key)!, reports: history.map((r) => ({ ...r, params: undefined })), matrix: lib.matrix };
  }

  async function getReport(key: string, reportId: string): Promise<TradingTemplateReportRow> {
    const [row] = await db.select().from(tradingTemplateReports).where(and(eq(tradingTemplateReports.id, reportId), eq(tradingTemplateReports.templateKey, key)));
    if (!row) throw notFound("Template report not found.");
    return row;
  }

  /** Queue a report for one template. Costs, data horizon, source and seed are fixed here. */
  async function queueReport(templateKey: string, actor: TemplateReportActor): Promise<TradingTemplateReportRow> {
    const template = findTradingTemplate(templateKey);
    if (!template) throw notFound("Template not found.");
    const problems = tradingTemplateProblems(template);
    if (problems.length > 0) throw unprocessable("This template does not pass its own checks, so it is not tested.", { code: "trading_template_invalid", problems });
    await seedMatrices();
    const matrix = await latestMatrix();
    const digest = templateSpecDigest(template);
    const params: BacktestRunParams = {
      schema: 1,
      asOf: nowOf().toISOString(),
      source: TRADING_START_GATE.liveSource,
      purpose: "gate",
      assets: [...template.spec.universe.assets],
      costs: { feeRatePct: TRADING_BACKTEST_COSTS.feeRatePct, spreadPct: TRADING_BACKTEST_COSTS.spreadPct, slippagePct: TRADING_BACKTEST_COSTS.slippagePct },
      startingCashNok: 10_000,
      selection: "base",
      // A control has nothing to tune; every other template tries its neighbours so the trial count is honest.
      maxVariants: template.spec.meta.family === "control" ? 1 : TRADING_BACKTEST_LIMITS.maxVariants,
      seed: Number.parseInt(digest.slice(0, 8), 16) >>> 0,
    };
    try {
      const [row] = await db
        .insert(tradingTemplateReports)
        .values({
          templateKey: template.key,
          templateVersion: template.templateVersion,
          specDigest: digest,
          matrixVersion: matrix.version,
          params: params as unknown as Record<string, unknown>,
          requestedByType: actor.type,
          requestedById: actor.id,
        })
        .returning();
      return row!;
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") throw conflict("A report for this template is already waiting or running.", { code: "trading_template_report_already_active" });
      throw err;
    }
  }

  /**
   * Queue a report for every template that has none for its current rules and
   * the newest matrix. A report that failed or found nothing to test on is tried
   * again only after `retryAfterMs`, so a missing feed does not requeue it on every
   * tick. Skips templates already waiting.
   */
  async function queueMissing(actor: TemplateReportActor, options: { retryAfterMs?: number } = {}): Promise<{ queued: string[]; skipped: string[] }> {
    await seedMatrices();
    const matrix = await latestMatrix();
    const reports = await latestReports();
    const retryAfterMs = options.retryAfterMs ?? 6 * 3_600_000;
    const queued: string[] = [];
    const skipped: string[] = [];
    for (const template of tradingTemplates()) {
      const latest = reports.get(`${template.key}@${template.templateVersion}`);
      const current = latest && latest.specDigest === templateSpecDigest(template) && latest.matrixVersion === matrix.version;
      const retryable = latest && (latest.status === "failed" || latest.status === "not_testable");
      const waited = latest ? nowOf().getTime() - (latest.finishedAt ?? latest.createdAt).getTime() >= retryAfterMs : true;
      if (current && (!retryable || !waited)) {
        skipped.push(template.key);
        continue;
      }
      try {
        await queueReport(template.key, actor);
        queued.push(template.key);
      } catch (err) {
        if ((err as { details?: { code?: string } }).details?.code === "trading_template_report_already_active") skipped.push(template.key);
        else throw err;
      }
    }
    return { queued, skipped };
  }

  /** Called by the report queue's own connection before it looks for work: stores the matrix versions and queues what is missing. */
  async function prepare(): Promise<{ queued: string[] }> {
    const { queued } = await queueMissing({ type: "system", id: "template-library" });
    return { queued };
  }

  // ─── Worker side ──────────────────────────────────────────────────────────

  async function claimNextReport(): Promise<{ id: string } | null> {
    const [next] = await db.select({ id: tradingTemplateReports.id }).from(tradingTemplateReports).where(eq(tradingTemplateReports.status, "queued")).orderBy(asc(tradingTemplateReports.createdAt)).limit(1);
    if (!next) return null;
    const [claimed] = await db
      .update(tradingTemplateReports)
      .set({ status: "running", startedAt: nowOf(), updatedAt: nowOf() })
      .where(and(eq(tradingTemplateReports.id, next.id), eq(tradingTemplateReports.status, "queued")))
      .returning({ id: tradingTemplateReports.id });
    return claimed ?? null;
  }

  async function failInterrupted(): Promise<number> {
    const rows = await db
      .update(tradingTemplateReports)
      .set({ status: "failed", error: "Interrupted by a server restart. Queue the report again.", finishedAt: nowOf(), updatedAt: nowOf() })
      .where(eq(tradingTemplateReports.status, "running"))
      .returning({ id: tradingTemplateReports.id });
    return rows.length;
  }

  async function failReport(reportId: string, message: string): Promise<void> {
    await db
      .update(tradingTemplateReports)
      .set({ status: "failed", error: message.slice(0, 1000), finishedAt: nowOf(), updatedAt: nowOf() })
      .where(and(eq(tradingTemplateReports.id, reportId), inArray(tradingTemplateReports.status, ["queued", "running"])));
  }

  /** The template, the pinned params, and what the lineage has already seen (other reports of the template, and any strategy created from it). */
  async function loadContext(reportId: string) {
    const [report] = await db.select().from(tradingTemplateReports).where(eq(tradingTemplateReports.id, reportId));
    if (!report) throw notFound("Template report not found.");
    const template = findTradingTemplate(report.templateKey);
    if (!template) throw notFound("Template not found.");
    if (templateSpecDigest(template) !== report.specDigest) throw unprocessable("The template's rules changed after this report was queued. Queue a new report.");
    const own = await db
      .select({ id: tradingTemplateReports.id, holdoutStart: tradingTemplateReports.holdoutStart, holdoutEnd: tradingTemplateReports.holdoutEnd })
      .from(tradingTemplateReports)
      .where(and(eq(tradingTemplateReports.templateKey, report.templateKey), isNotNull(tradingTemplateReports.holdoutStart)));
    const fromStrategies = await db
      .select({ runId: tradingBacktestHoldoutReads.runId, holdoutStart: tradingBacktestHoldoutReads.holdoutStart, holdoutEnd: tradingBacktestHoldoutReads.holdoutEnd })
      .from(tradingBacktestHoldoutReads)
      .where(eq(tradingBacktestHoldoutReads.templateKey, report.templateKey));
    const priorReads: HoldoutRead[] = [
      ...own.filter((r) => r.id !== report.id && r.holdoutStart && r.holdoutEnd).map((r) => ({ runId: r.id, holdoutStart: r.holdoutStart!.toISOString(), holdoutEnd: r.holdoutEnd!.toISOString() })),
      ...fromStrategies.map((r) => ({ runId: r.runId, holdoutStart: r.holdoutStart.toISOString(), holdoutEnd: r.holdoutEnd.toISOString() })),
    ];
    const ownTrials = await db.select({ variantDigest: tradingTemplateTrials.variantDigest, oosSharpe: tradingTemplateTrials.oosSharpe }).from(tradingTemplateTrials).where(eq(tradingTemplateTrials.templateKey, report.templateKey));
    const strategyTrials = await db.select({ variantDigest: tradingBacktestTrials.variantDigest, oosSharpe: tradingBacktestTrials.oosSharpe }).from(tradingBacktestTrials).where(eq(tradingBacktestTrials.templateKey, report.templateKey));
    const seen = new Set<string>();
    const priorTrials = [...ownTrials, ...strategyTrials].filter((t) => (seen.has(t.variantDigest) ? false : (seen.add(t.variantDigest), true)));
    return { report, template, params: report.params as unknown as BacktestRunParams, priorReads, priorTrials };
  }

  /** Write a finished report, its trials and its holdout read in one transaction. */
  async function finishReport(reportId: string, outcome: BacktestOutcome, ctx: { templateKey: string; assets: readonly string[] }) {
    const skipped = ((outcome.report as { skippedCoins?: unknown[] }).skippedCoins ?? []) as Array<{ coin: string; reason: string }>;
    const nothingToTest = skipped.length >= ctx.assets.length;
    await db.transaction(async (tx) => {
      const handle = tx as unknown as Db;
      if (!nothingToTest && outcome.trials.length > 0) {
        await handle
          .insert(tradingTemplateTrials)
          .values(outcome.trials.map((t) => ({ templateKey: ctx.templateKey, reportId, variantDigest: t.variantDigest, variantLabel: t.variantLabel, oosSharpe: t.oosSharpe, oosObservations: t.oosObservations })))
          .onConflictDoNothing();
      }
      const [row] = await handle
        .update(tradingTemplateReports)
        .set(
          nothingToTest
            ? { status: "not_testable", error: `No stored candles to test on: ${skipped.map((s) => `${s.coin} (${s.reason})`).join("; ")}.`, report: outcome.report, finishedAt: nowOf(), updatedAt: nowOf() }
            : {
                status: "succeeded",
                report: outcome.report,
                gate: outcome.gate as unknown as Record<string, unknown>,
                gatePassed: outcome.gate.passed,
                resultDigest: outcome.resultDigest,
                variantsTried: outcome.variantsTried,
                holdoutStart: outcome.holdoutRead ? new Date(outcome.holdoutRead.start) : null,
                holdoutEnd: outcome.holdoutRead ? new Date(outcome.holdoutRead.end) : null,
                holdoutSeenCount: outcome.holdoutRead ? outcome.holdoutRead.seenCount : null,
                finishedAt: nowOf(),
                updatedAt: nowOf(),
              },
        )
        .where(and(eq(tradingTemplateReports.id, reportId), eq(tradingTemplateReports.status, "running")))
        .returning({ id: tradingTemplateReports.id });
      if (!row) throw conflict("The report was no longer running, so its result was not saved.");
    });
    return { notTestable: nothingToTest };
  }

  /** Variants and holdout reads a template lineage has used, for the count shown next to a result. */
  async function lineageCounts(templateKey: string): Promise<{ variants: number; holdoutReads: number }> {
    const [t] = await db.select({ n: sql<number>`count(*)::int` }).from(tradingTemplateTrials).where(eq(tradingTemplateTrials.templateKey, templateKey));
    const [h] = await db.select({ n: sql<number>`count(*)::int` }).from(tradingTemplateReports).where(and(eq(tradingTemplateReports.templateKey, templateKey), isNotNull(tradingTemplateReports.holdoutStart)));
    return { variants: t?.n ?? 0, holdoutReads: h?.n ?? 0 };
  }

  return { seedMatrices, listMatrices, latestMatrix, library, getTemplate, getReport, queueReport, queueMissing, prepare, claimNextReport, failInterrupted, failReport, loadContext, finishReport, lineageCounts };
}

export type TradingTemplateStore = ReturnType<typeof tradingTemplateStore>;
