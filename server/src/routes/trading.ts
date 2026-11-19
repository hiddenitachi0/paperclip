import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { TRADING_ASSETS, askTraderSchema, createStrategyFromTemplateSchema, createTradingStrategySchema, findTradingTemplate, queueTradingBacktestSchema, queueTradingExperimentSchema, setTradingStrategyStatusSchema, tradingRuleBookSchema, updateTradingAlertSettingsSchema, updateTradingStrategySchema } from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoardOrgAccess, assertCompanyAccess, assertCompanyOwnerAdminOrInstanceAdmin, assertCompanyOwnerOrInstanceAdmin, assertInstanceAdmin } from "./authz.js";
import { tradingTemplateStore } from "../services/trading-template-store.js";
import { tradingSelectorService } from "../services/trading-selector.js";
import { experimentSummary } from "../services/trading-experiment-store.js";
import { tradingService, type TradingServiceDeps } from "../services/trading.js";
import { currentMarketWeather, marketWeatherHistory } from "../services/trading-regimes.js";
import { tradingTraderService } from "../services/trading-trader.js";
import { logActivity } from "../services/activity-log.js";
import { tradingEvaluatorService } from "../services/trading-evaluator.js";
import { tradingVigilanceService } from "../services/trading-vigilance.js";

/**
 * DUR-4153/DUR-4171: the trading agent is board-only, both reading and
 * writing -- unlike Media Studio's generation surface, there is no reason
 * for a quick agent to configure risk limits or pull the kill switch (the
 * design's core rule is "code trades, the AI explains"; an agent has no
 * legitimate reason to touch this surface at all), so this file never calls
 * assertBoardOrAgent. Changing a strategy (create/update/pause/resume) is
 * owner/admin-only, the same bar as company connections
 * (assertCompanyOwnerAdminOrInstanceAdmin); reading is open to any active
 * company member.
 *
 * DUR-5004: every write checks who is asking BEFORE it looks at the body, so an
 * agent token gets a plain 403 whatever it sends. The Trader agent's own tools live in
 * routes/agent-trading.ts; the one write here that concerns it ("Ask the analyst") is a
 * person's action.
 *
 * DUR-5002: changing a strategy's rules or limits (PATCH, or POST .../versions)
 * only ever files a draft version and an approval card; no route here
 * activates one. Approving happens on the card (routes/approvals.ts).
 */

/** `deps` lets tests inject a fake TradingMarketDataSource (createStrategy's quote fetch) without a real network call; app.ts always calls this with none, i.e. the real Kraken client. */
export function tradingRoutes(rawDb: Db, deps: TradingServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const trading = tradingService(db, { rawDb, ...deps });
  const trader = tradingTraderService(db, rawDb);
  const evaluator = tradingEvaluatorService(db, { marketData: deps.marketData });
  const vigilance = tradingVigilanceService(db, { now: deps.now });

  function readScope() {
    return companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoardOrgAccess(req);
      assertCompanyAccess(req, companyId);
    });
  }

  function writeScope() {
    return companyScopeFromParam(rawDb, (req, companyId) => {
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "the trading agent");
    });
  }

  // DUR-5014: the strategy template library. Library data, not company data, and
  // not shown to client companies before the legal check (decision 19): every
  // route here needs an instance admin, whichever company id the path carries.
  // Reading only; the report queue is written by the scheduler chain's own connection.
  const templates = tradingTemplateStore(db);

  function templateScope() {
    return companyScopeFromParam(rawDb, (req, companyId) => {
      assertInstanceAdmin(req);
      assertCompanyAccess(req, companyId);
    });
  }

  router.get("/companies/:companyId/trading/templates", templateScope(), async (_req, res) => {
    res.json(await templates.library());
  });

  router.get("/companies/:companyId/trading/templates/:templateKey", templateScope(), async (req, res) => {
    res.json(await templates.getTemplate(req.params.templateKey as string));
  });

  router.get("/companies/:companyId/trading/templates/:templateKey/reports/:reportId", templateScope(), async (req, res) => {
    res.json(await templates.getReport(req.params.templateKey as string, req.params.reportId as string));
  });

  /** A new paper strategy from a template: the template's rules as written become version 1 and its key goes into the strategy's lineage. It starts paused and still needs its own past-data test before it may run. */
  router.post("/companies/:companyId/trading/strategies/from-template", templateScope(), validate(createStrategyFromTemplateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const template = findTradingTemplate(req.body.templateKey);
    if (!template) throw notFound("Template not found.");
    const input = createTradingStrategySchema.parse({
      name: req.body.name ?? `${template.spec.meta.name} ${req.body.asset}`.slice(0, 120),
      asset: req.body.asset,
      timeframe: template.spec.universe.decisionTimeframe,
    });
    const row = await trading.createStrategy(companyId, input, { actorType: "user", actorId: req.actor.userId ?? "board" }, template);
    res.status(201).json(row);
  });

  router.get("/companies/:companyId/trading/strategies", readScope(), async (req, res) => {
    res.json(await trading.listStrategies(req.params.companyId as string));
  });

  router.post(
    "/companies/:companyId/trading/strategies",
    writeScope(),
    validate(createTradingStrategySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      // writeScope() enforces board-only (assertCompanyOwnerAdminOrInstanceAdmin), so actor is always a board user here.
      const actor = { actorType: "user" as const, actorId: req.actor.userId ?? "board" };
      const row = await trading.createStrategy(companyId, req.body, actor);
      res.status(201).json(row);
    },
  );

  router.get("/companies/:companyId/trading/strategies/:strategyId", readScope(), async (req, res) => {
    res.json(await trading.requireStrategy(req.params.companyId as string, req.params.strategyId as string));
  });

  router.patch(
    "/companies/:companyId/trading/strategies/:strategyId",
    writeScope(),
    validate(updateTradingStrategySchema),
    async (req, res) => {
      // writeScope() enforces board-only, so the actor is always a person here.
      const actor = { actorType: "user" as const, actorId: req.actor.userId ?? "board" };
      const row = await trading.updateStrategy(req.params.companyId as string, req.params.strategyId as string, req.body, actor);
      // 202: the request was understood but the rules did NOT change; a draft and an approval card were filed.
      res.status(row.pendingVersion ? 202 : 200).json(row);
    },
  );

  // ─── Rule-book versions (DUR-5002) ───────────────────────────────────

  router.get("/companies/:companyId/trading/strategies/:strategyId/versions", readScope(), async (req, res) => {
    res.json(await trading.versions.listVersions(req.params.companyId as string, req.params.strategyId as string));
  });

  router.get("/companies/:companyId/trading/strategies/:strategyId/versions/:versionId", readScope(), async (req, res) => {
    res.json(await trading.versions.getVersion(req.params.companyId as string, req.params.strategyId as string, req.params.versionId as string));
  });

  /**
   * Propose new rules: stores a draft version and files the approval card for
   * it. Nothing changes for the running strategy until an owner or admin
   * approves the card (on the card itself; no route here activates anything).
   */
  router.post(
    "/companies/:companyId/trading/strategies/:strategyId/versions",
    writeScope(),
    validate(tradingRuleBookSchema),
    async (req, res) => {
      const result = await trading.versions.proposeVersion(
        req.params.companyId as string,
        req.params.strategyId as string,
        req.body,
        { type: "user", id: req.actor.userId ?? "board" },
      );
      res.status(result.outcome === "unchanged" ? 200 : 202).json(result);
    },
  );

  /** The rules an approval card stands for, read from the stored version (never the card's own copy). */
  router.get("/companies/:companyId/trading/approval-cards/:approvalId/source", readScope(), async (req, res) => {
    res.json(await trading.versions.getCardSource(req.params.companyId as string, req.params.approvalId as string));
  });

  /**
   * "Ask the analyst": opens a task for the company's Trader agent with a
   * person's question. Owner/admin only, like every other write here. It
   * changes no strategy; the Trader answers by proposing a change (a card) or
   * by commenting on the task.
   */
  router.post("/companies/:companyId/trading/analyst/ask", writeScope(), validate(askTraderSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.actor.userId ?? "board";
    const result = await trader.askTrader(companyId, { userId }, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "trading.trader_asked",
      entityType: "issue",
      entityId: result.issueId,
      details: { strategyId: req.body.strategyId ?? null },
    });
    res.status(201).json(result);
  });

  /** The kill switch -- the one route the UI's pause/resume button and the Telegram bridge's command both call. */
  router.post(
    "/companies/:companyId/trading/strategies/:strategyId/status",
    writeScope(),
    validate(setTradingStrategyStatusSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      // Starting a strategy that has not passed the past-data test is an owner's decision (decision 7), with a written reason.
      // Everything else about the kill switch stays at the owner/admin bar of writeScope().
      let override: { reason: string; userId: string } | undefined;
      if (req.body.overrideReason) {
        assertCompanyOwnerOrInstanceAdmin(req, companyId, "the trading agent's start gate");
        override = { reason: req.body.overrideReason, userId: req.actor.userId ?? "board" };
      }
      res.json(await trading.setStatus(companyId, req.params.strategyId as string, req.body.status, override));
    },
  );

  // ─── Past-data tests and the start gate (DUR-5008) ───────────────────

  /** Where the strategy's active rules stand against the start gate. */
  router.get("/companies/:companyId/trading/strategies/:strategyId/start-gate", readScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const strategy = await trading.requireStrategy(companyId, req.params.strategyId as string);
    const active = await trading.versions.ensureActiveVersion(strategy);
    res.json({
      ...(await trading.backtests.startGateState(companyId, strategy.id, active.version)),
      overrides: (await trading.backtests.listOverrides(companyId, strategy.id)).map((o) => ({ versionId: o.versionId, reason: o.reason, overriddenByUserId: o.overriddenByUserId, createdAt: o.createdAt })),
      variantsTried: await trading.backtests.trialCount(companyId, strategy.id),
      holdoutReads: await trading.backtests.holdoutReadCount(companyId, strategy.id),
    });
  });

  router.get("/companies/:companyId/trading/strategies/:strategyId/backtests", readScope(), async (req, res) => {
    res.json(await trading.backtests.listRuns(req.params.companyId as string, req.params.strategyId as string));
  });

  router.get("/companies/:companyId/trading/strategies/:strategyId/backtests/:runId", readScope(), async (req, res) => {
    res.json(await trading.backtests.getRun(req.params.companyId as string, req.params.strategyId as string, req.params.runId as string));
  });

  /** Queue a past-data test. It runs later, in a worker thread, one at a time; this only files the request. */
  router.post(
    "/companies/:companyId/trading/strategies/:strategyId/backtests",
    writeScope(),
    validate(queueTradingBacktestSchema),
    async (req, res) => {
      const row = await trading.backtests.queueRun(req.params.companyId as string, req.params.strategyId as string, req.body, { type: "user", id: req.actor.userId ?? "board" });
      res.status(202).json({ id: row.id, status: row.status, purpose: row.purpose, versionId: row.versionId });
    },
  );

  router.post("/companies/:companyId/trading/strategies/:strategyId/backtests/:runId/cancel", writeScope(), async (req, res) => {
    res.json(await trading.backtests.cancelQueued(req.params.companyId as string, req.params.strategyId as string, req.params.runId as string));
  });

  // ─── Experiments (DUR-5018) ──────────────────────────────────────────
  // A suggestion engine, never an editor: nothing here changes a strategy. The result
  // is a recommended variant or "no change"; a rule change still needs a proposal that
  // cites the experiment and an approval card a person answers.

  router.get("/companies/:companyId/trading/strategies/:strategyId/experiments", readScope(), async (req, res) => {
    res.json(await trading.experiments.listExperiments(req.params.companyId as string, req.params.strategyId as string));
  });

  router.get("/companies/:companyId/trading/strategies/:strategyId/experiments/:experimentId", readScope(), async (req, res) => {
    const row = await trading.experiments.getExperiment(req.params.companyId as string, req.params.strategyId as string, req.params.experimentId as string);
    res.json({ ...experimentSummary(row), params: row.params, report: row.report, recommendation: row.recommendation, recommendedSpec: row.recommendedSpec });
  });

  /** Queue an experiment. It runs later, in a worker thread, one heavy job at a time; this only files the request. */
  router.post(
    "/companies/:companyId/trading/strategies/:strategyId/experiments",
    writeScope(),
    validate(queueTradingExperimentSchema),
    async (req, res) => {
      const row = await trading.experiments.queueExperiment(req.params.companyId as string, req.params.strategyId as string, req.body, { type: "user", id: req.actor.userId ?? "board" });
      res.status(202).json({ id: row.id, status: row.status, versionId: row.versionId });
    },
  );

  router.post("/companies/:companyId/trading/strategies/:strategyId/experiments/:experimentId/cancel", writeScope(), async (req, res) => {
    res.json(experimentSummary(await trading.experiments.cancelQueued(req.params.companyId as string, req.params.strategyId as string, req.params.experimentId as string)));
  });

  router.get("/companies/:companyId/trading/strategies/:strategyId/dashboard", readScope(), async (req, res) => {
    res.json(await trading.dashboard(req.params.companyId as string, req.params.strategyId as string));
  });

  router.get("/companies/:companyId/trading/strategies/:strategyId/ledger", readScope(), async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json(await trading.listLedgerEntries(req.params.companyId as string, req.params.strategyId as string, limit));
  });

  router.get("/companies/:companyId/trading/strategies/:strategyId/orders", readScope(), async (req, res) => {
    res.json(await trading.listOrders(req.params.companyId as string, req.params.strategyId as string));
  });

  // DUR-5013: market weather. Instance-wide public data (one label per coin per
  // day from the candle store), read-only, any active company member. A label is
  // only listed once its day has closed, so "today" shows yesterday's label.
  router.get("/companies/:companyId/trading/market-weather", readScope(), async (_req, res) => {
    res.json({ items: await currentMarketWeather(db, new Date()) });
  });

  const weatherHistoryQuery = z.object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    spells: z.coerce.number().int().min(1).max(500).default(50),
  });
  router.get("/companies/:companyId/trading/market-weather/:asset", readScope(), async (req, res) => {
    const asset = (TRADING_ASSETS as readonly string[]).includes(String(req.params.asset)) ? (req.params.asset as (typeof TRADING_ASSETS)[number]) : null;
    if (!asset) throw badRequest("Unknown coin.");
    const query = weatherHistoryQuery.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid market weather query.", query.error.flatten());
    res.json(await marketWeatherHistory(db, asset, new Date(), { from: query.data.from, to: query.data.to, spellLimit: query.data.spells }));
  });

  // DUR-5015: the shadow tournament and the monthly selector. Reading only: shadow
  // runs and checkpoints are written by the scheduler chain's own connection, so no
  // route here can place a trade, move a balance or promote a cell. Any active
  // company member may read; the walk-forward replay costs real CPU, so it is
  // owner/admin only.
  const selector = tradingSelectorService(db);

  router.get("/companies/:companyId/trading/shadow/cells", readScope(), async (req, res) => {
    res.json({ items: await selector.shadowSummary(req.params.companyId as string) });
  });

  router.get("/companies/:companyId/trading/selector/decisions", readScope(), async (req, res) => {
    res.json({ rules: { version: selector.rules.version }, items: await selector.listDecisions(req.params.companyId as string) });
  });

  router.get("/companies/:companyId/trading/selector/promoted", readScope(), async (req, res) => {
    res.json({ items: await selector.promotedCells(req.params.companyId as string) });
  });

  router.get("/companies/:companyId/trading/selector/decisions/:decisionId", readScope(), async (req, res) => {
    res.json(await selector.getDecision(req.params.companyId as string, req.params.decisionId as string));
  });

  router.get("/companies/:companyId/trading/selector/decisions/:decisionId/reproduce", readScope(), async (req, res) => {
    res.json(await selector.reproduce(req.params.companyId as string, req.params.decisionId as string));
  });

  router.get("/companies/:companyId/trading/selector/walk-forward", writeScope(), async (req, res) => {
    res.json(await selector.walkForward(req.params.companyId as string));
  });

  // DUR-5017: which vigilance alerts reach Telegram. Owner/admin only, for reading too:
  // the alerts go to the owners and admins, and so does the say over them.
  router.get("/companies/:companyId/trading/alert-settings", writeScope(), async (req, res) => {
    res.json(await vigilance.getSettings(req.params.companyId as string));
  });

  router.patch("/companies/:companyId/trading/alert-settings", writeScope(), validate(updateTradingAlertSettingsSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const settings = await vigilance.updateSettings(companyId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "trading.alert_settings_changed",
      entityType: "company",
      entityId: companyId,
      details: { changed: Object.keys(req.body) },
    });
    res.json(settings);
  });

  // DUR-5010: the prediction scoreboard. Read-only; while a version is still collecting it shows
  // "x of N" and no hit rate. ?version= picks an older version; the default is the active one.
  router.get("/companies/:companyId/trading/strategies/:strategyId/scoreboard", readScope(), async (req, res) => {
    const version = req.query.version === undefined ? undefined : Number(req.query.version);
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
      res.status(400).json({ error: "version must be a positive whole number" });
      return;
    }
    res.json(await evaluator.scoreboard(req.params.companyId as string, req.params.strategyId as string, version));
  });

  return router;
}
