/**
 * Trading tools for the Trader agent. Like the wallet tools, this file "holds
 * no secret, makes no decision": each tool is a direct pass-through to one
 * `/api/agent-trading/...` call made with the agent's own run token. The
 * tools are registered for every agent, so the server is the real gate: it
 * answers 403 to any agent that is not the company's designated Trader.
 *
 * There is no tool here that places, cancels or sizes an order, switches a
 * strategy on or off, or touches a wallet. The only way to change a strategy
 * is `trading_propose_change`, which files an approval card that a person
 * answers.
 */
import { z } from "zod";
import { PaperclipApiClient } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";
import type { ToolDefinition } from "./tools.js";

function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

export function createTradingToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  const enc = encodeURIComponent;
  return [
    makeTool(
      "trading_list_strategies",
      "List the company's paper-trading strategies (id, name, coin, status). Only the company's Trader agent may use this; everyone else is refused by the server.",
      z.object({}),
      () => client.requestJson("GET", "/agent-trading/strategies"),
    ),
    makeTool(
      "trading_get_strategy",
      "Read one strategy: its live rules (spec) and guidelines, recent versions, the last ledger entries and the daily scores. Read-only. Only the company's Trader agent may use this.",
      z.object({ strategyId: z.string().uuid().describe("The strategy's id, from trading_list_strategies") }),
      ({ strategyId }) => client.requestJson("GET", `/agent-trading/strategies/${enc(strategyId)}`),
    ),
    makeTool(
      "trading_run_experiment",
      "Ask for an experiment on a strategy: a small, capped grid of indicator settings (period / lookback / stdDev) on the live rules, tested on past data, walk-forward, at double fees. It runs in the background (check back with trading_get_experiment). The result is a recommended variant or 'no change' and is never applied. Leave `grid` out for the automatic neighbours (each indicator length nudged down and up by a quarter). At most 49 combinations; the rules as written always run too. A rule change can only be proposed by citing a finished experiment that recommended exactly those rules. Every variant counts in the trial count, so do not run grids you do not need.",
      z.object({
        strategyId: z.string().uuid(),
        grid: z
          .array(z.object({ indicator: z.string().describe("The indicator's name in the spec"), param: z.enum(["period", "lookback", "stdDev"]), values: z.array(z.number()).min(1).max(15) }))
          .min(1)
          .max(3)
          .optional()
          .describe("Up to 3 settings to vary together; the combinations are the cross product"),
      }),
      ({ strategyId, ...body }) => client.requestJson("POST", `/agent-trading/strategies/${enc(strategyId)}/experiments`, { body }),
    ),
    makeTool(
      "trading_list_experiments",
      "List the recent experiments for a strategy with their status, trial count, deflated Sharpe and decision. Read-only.",
      z.object({ strategyId: z.string().uuid() }),
      ({ strategyId }) => client.requestJson("GET", `/agent-trading/strategies/${enc(strategyId)}/experiments`),
    ),
    makeTool(
      "trading_get_experiment",
      "Read one experiment in full: the trial counts, deflated Sharpe, plateau check, holdout reads, every variant's numbers and, when it recommended one, the exact rules (`recommendedSpec`) a proposal must contain. Read-only.",
      z.object({ strategyId: z.string().uuid(), experimentId: z.string().uuid() }),
      ({ strategyId, experimentId }) => client.requestJson("GET", `/agent-trading/strategies/${enc(strategyId)}/experiments/${enc(experimentId)}`),
    ),
    makeTool(
      "trading_propose_change",
      "Propose new rules for a strategy. You must cite `experimentId`: a finished experiment of this strategy, run on its live rules, that recommended exactly these rules (send the `recommendedSpec` from trading_get_experiment unchanged); a proposal without one is refused. Send the WHOLE new spec, the guidelines, a plain summary and your reasons. The server checks it; risk limits may only be tightened, never loosened. A valid proposal is saved as a draft and an approval card is filed for a person: nothing changes until they approve it. It does not place or change any order. The card cites the experiment and still says 'not yet tested on past data' until the rules pass the start gate. At most 5 proposals and 6 experiments per strategy per day.",
      z.object({
        strategyId: z.string().uuid(),
        experimentId: z.string().uuid().describe("The finished experiment that recommended exactly this spec"),
        spec: z.record(z.string(), z.unknown()).describe("The complete strategy spec, in the same shape trading_get_strategy returns it"),
        guidelines: z.string().max(8000).optional().describe("The plain-language guidelines for this version"),
        summary: z.string().min(3).max(500).describe("What changes, in one or two plain sentences. Shown on the card."),
        reasons: z.string().min(3).max(2000).describe("Why this change is a good idea. Shown on the card."),
      }),
      ({ strategyId, ...body }) => client.requestJson("POST", `/agent-trading/strategies/${enc(strategyId)}/proposals`, { body }),
    ),
  ];
}
