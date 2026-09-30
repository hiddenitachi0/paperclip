import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { createTradingStrategySchema, setTradingStrategyStatusSchema, updateTradingStrategySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoardOrgAccess, assertCompanyAccess, assertCompanyOwnerAdminOrInstanceAdmin } from "./authz.js";
import { tradingService } from "../services/trading.js";

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
 */

export function tradingRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const trading = tradingService(db);

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
    validate(createTradingStrategySchema),
    writeScope(),
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
    validate(updateTradingStrategySchema),
    writeScope(),
    async (req, res) => {
      res.json(await trading.updateStrategy(req.params.companyId as string, req.params.strategyId as string, req.body));
    },
  );

  /** The kill switch -- the one route the UI's pause/resume button and the Telegram bridge's command both call. */
  router.post(
    "/companies/:companyId/trading/strategies/:strategyId/status",
    validate(setTradingStrategyStatusSchema),
    writeScope(),
    async (req, res) => {
      res.json(await trading.setStatus(req.params.companyId as string, req.params.strategyId as string, req.body.status));
    },
  );

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

  return router;
}
