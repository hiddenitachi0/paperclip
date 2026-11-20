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
 * scores), request and read experiments (DUR-5018), and propose a rule change
 * that cites the experiment recommending it, which becomes a draft version plus an
 * approval card that only a person can answer. DUR-5019 adds the daily brief
 * (read-only), a post-mortem note, and `changes`: applying a PAPER strategy's
 * change itself, with no card, only from a finished experiment that passed every
 * check at double fees (see trading-trader.ts applyChange). These routes never
 * take a strategy status, a mode, a wallet or an order.
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

  // DUR-5019: the daily brief, read-only: the last day's trades and stops, the scoreboard, the mistakes list and what is left of today's limits.
  router.get("/agent-trading/daily-brief", agentScope(), async (req, res) => {
    const { companyId } = await designated(req);
    res.json(await trader.getDailyBrief(companyId));
  });

  // DUR-5018: experiments. The Trader asks for one, then reads the result; it can never apply one.
  router.get("/agent-trading/strategies/:strategyId/experiments", agentScope(), async (req, res) => {
    const { companyId } = await designated(req);
    res.json(await trader.listExperiments(companyId, req.params.strategyId as string));
  });

  router.get("/agent-trading/strategies/:strategyId/experiments/:experimentId", agentScope(), async (req, res) => {
    const { companyId } = await designated(req);
    res.json(await trader.getExperiment(companyId, req.params.strategyId as string, req.params.experimentId as string));
  });

  router.post("/agent-trading/strategies/:strategyId/experiments", agentScope(), async (req, res) => {
    const { agentId, companyId } = await designated(req);
    const strategyId = req.params.strategyId as string;
    const row = await trader.requestExperiment(companyId, agentId, strategyId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "trading.trader_requested_experiment",
      entityType: "agent",
      entityId: agentId,
      details: { strategyId, experimentId: row.id, versionId: row.versionId, grid: (row.params as { grid?: unknown }).grid ?? null },
    });
    res.status(202).json({ id: row.id, status: row.status, versionId: row.versionId, message: "The experiment is queued. It runs in the background; read it again later. Its result is a suggestion only." });
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

  // DUR-5019: apply an experiment's recommendation to a PAPER strategy with no card. The body names the experiment; the rules come from it.
  router.post("/agent-trading/strategies/:strategyId/changes", agentScope(), async (req, res) => {
    const { agentId, companyId } = await designated(req);
    const strategyId = req.params.strategyId as string;
    const result = await trader.applyChange(companyId, agentId, strategyId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "trading.trader_applied_change",
      entityType: "agent",
      entityId: agentId,
      details: {
        strategyId,
        outcome: result.outcome,
        versionId: result.version.id,
        versionNumber: result.version.version,
        previousVersionId: "previousVersionId" in result ? result.previousVersionId : null,
        experimentId: (req.body as { experimentId?: unknown } | null)?.experimentId ?? null,
      },
    });
    res.status(result.outcome === "applied" ? 201 : 200).json({
      outcome: result.outcome,
      versionId: result.version.id,
      versionNumber: result.version.version,
      message:
        result.outcome === "applied"
          ? "The change is applied to the paper strategy. It is recorded in the ledger and will be listed in the daily summary. Mention it in your report."
          : "These rules are already the live rules; nothing was applied.",
    });
  });

  // DUR-5019: the Trader's short post-mortem for one strategy, with each tagged loss tied to one of the rules' own common mistakes.
  router.post("/agent-trading/strategies/:strategyId/post-mortems", agentScope(), async (req, res) => {
    const { agentId, companyId } = await designated(req);
    const strategyId = req.params.strategyId as string;
    const result = await trader.filePostMortem(companyId, agentId, strategyId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "trading.trader_wrote_post_mortem",
      entityType: "agent",
      entityId: agentId,
      details: { strategyId, ledgerEntryId: result.ledgerEntryId, tagged: result.tagged },
    });
    res.status(201).json(result);
  });

  return router;
}
