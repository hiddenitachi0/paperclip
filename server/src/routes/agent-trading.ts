import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { companyScope } from "../middleware/company-scope.js";
import { forbidden } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { tradingTraderService } from "../services/trading-trader.js";

/**
 * DUR-5004: the Trader agent's trading tools. Every route here is agent-only
 * AND designated-only: the caller must be an agent's own run, in the company
 * it names, and the agent that company designated as its Trader
 * (company_crypto_settings.trader_agent_id). Everyone else -- a board user, a
 * different agent, the Trader of another company -- gets a plain 403 before
 * anything is read. MCP tools are registered for every agent, so this check,
 * not the tool list, is the gate.
 *
 * What the Trader can do: read a strategy (spec, guidelines, recent ledger,
 * scores) and propose a rule change, which becomes a draft version plus an
 * approval card that only a person can answer. These routes never take a
 * strategy status, a mode, a wallet or an order, and nothing here activates a
 * version.
 */

function requireAgentActor(req: Request): { agentId: string; companyId: string } {
  if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
    throw forbidden("Only the Trader agent's own run can use the trading tools.");
  }
  return { agentId: req.actor.agentId, companyId: req.actor.companyId };
}

export function agentTradingRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const trader = tradingTraderService(db, rawDb);

  /** Agent-only (the company comes from the agent's own token), then the designation check inside the handler. */
  function agentScope() {
    return companyScope(rawDb, (req) => requireAgentActor(req).companyId);
  }

  async function designated(req: Request) {
    const { agentId, companyId } = requireAgentActor(req);
    await trader.requireTrader(companyId, agentId);
    return { agentId, companyId };
  }

  router.get("/agent-trading/strategies", agentScope(), async (req, res) => {
    const { companyId } = await designated(req);
    res.json(await trader.listStrategies(companyId));
  });

  router.get("/agent-trading/strategies/:strategyId", agentScope(), async (req, res) => {
    const { companyId } = await designated(req);
    res.json(await trader.getStrategy(companyId, req.params.strategyId as string));
  });

  router.post("/agent-trading/strategies/:strategyId/proposals", agentScope(), async (req, res) => {
    const { agentId, companyId } = await designated(req);
    const strategyId = req.params.strategyId as string;
    const result = await trader.proposeChange(companyId, agentId, strategyId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "trading.trader_proposed_change",
      entityType: "agent",
      entityId: agentId,
      details: {
        strategyId,
        outcome: result.outcome,
        versionId: result.version.id,
        versionNumber: result.version.version,
        approvalId: "approvalId" in result ? result.approvalId : null,
      },
    });
    res.status(result.outcome === "unchanged" ? 200 : 202).json({
      outcome: result.outcome,
      versionId: result.version.id,
      versionNumber: result.version.version,
      approvalId: "approvalId" in result ? result.approvalId : null,
      message:
        result.outcome === "drafted"
          ? "Your proposal is saved as a draft and an approval card was filed. Nothing changes until a person approves the card."
          : result.outcome === "already_pending"
            ? "This exact change is already waiting for approval."
            : "These rules are already the live rules; nothing to propose.",
    });
  });

  return router;
}
