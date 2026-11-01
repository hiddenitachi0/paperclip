import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { TRADING_ASSETS, askTraderSchema, createTradingStrategySchema, queueTradingBacktestSchema, setTradingStrategyStatusSchema, tradingRuleBookSchema, updateTradingStrategySchema } from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoardOrgAccess, assertCompanyAccess, assertCompanyOwnerAdminOrInstanceAdmin, assertCompanyOwnerOrInstanceAdmin } from "./authz.js";
import { tradingService, type TradingServiceDeps } from "../services/trading.js";
import { currentMarketWeather, marketWeatherHistory } from "../services/trading-regimes.js";
import { tradingTraderService } from "../services/trading-trader.js";
import { logActivity } from "../services/activity-log.js";
import { tradingEvaluatorService } from "../services/trading-evaluator.js";

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
