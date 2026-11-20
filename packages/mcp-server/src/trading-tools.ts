/**
 * Trading tools for the Trader agent. Like the wallet tools, this file "holds
 * no secret, makes no decision": each tool is a direct pass-through to one
 * `/api/agent-trading/...` call made with the agent's own run token. The
 * tools are registered for every agent, so the server is the real gate: it
 * answers 403 to any agent that is not the company's designated Trader.
 *
 * There is no tool here that places, cancels or sizes an order, switches a
 * strategy on or off, or touches a wallet. A strategy's rules change only two
 * ways: `trading_propose_change` files an approval card that a person answers,
 * and `trading_apply_change` (DUR-5019) applies a finished experiment's own
 * recommendation to a PAPER strategy when the server's checks all pass.
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
    makeTool(
      "trading_get_daily_brief",
      "Your daily read, in one call: for every strategy the last 24 hours of trades (losses marked, with the ledger id to tag), safety stops, the rules' own list of common mistakes (with the position to tag by), the prediction scoreboard, and what you already filed or applied today and how much of today's limits is left. Read-only.",
      z.object({}),
      () => client.requestJson("GET", "/agent-trading/daily-brief"),
    ),
    makeTool(
      "trading_write_post_mortem",
      "Write a short plain-language post-mortem for one strategy (a few sentences, no jargon) and tag each losing trade with one of that strategy's own common mistakes. A tag needs the losing trade's ledgerEntryId and the mistake's index from the daily brief; the server refuses a tag on a trade that did not lose or a mistake the rules do not list. At most 2 per strategy per day. It is a note in the ledger; it changes nothing.",
      z.object({
        strategyId: z.string().uuid(),
        text: z.string().min(10).max(2000).describe("The post-mortem, in plain words a non-trader can follow"),
        lossTags: z
          .array(z.object({ ledgerEntryId: z.string().uuid(), mistakeIndex: z.number().int().min(0).max(19) }))
          .max(20)
          .optional()
          .describe("One entry per losing trade you can tie to a listed common mistake"),
      }),
      ({ strategyId, ...body }) => client.requestJson("POST", `/agent-trading/strategies/${enc(strategyId)}/post-mortems`, { body }),
    ),
    makeTool(
      "trading_apply_change",
      "Apply a finished experiment's recommendation to a PAPER strategy yourself, with no approval card. You send only the experimentId and your own words; the rules come from the experiment. The server refuses unless the experiment succeeded, recommended a change, passed every check including 'positive after fees at double fees' and 'deflated Sharpe', finished less than 72 hours ago, and was run on the rules that are live right now. It also refuses a loosened risk limit, a bigger size within 7 days of a safety stop, a person's open proposal on that strategy, and anything beyond 1 applied change per strategy and 3 per company per day. When it refuses, file the change with trading_propose_change instead. Every applied change is logged and listed in the daily summary; mention it in your report.",
      z.object({
        strategyId: z.string().uuid(),
        experimentId: z.string().uuid().describe("The finished experiment whose recommendation you are applying"),
        summary: z.string().min(3).max(500).describe("What changes, in one or two plain sentences"),
        reasons: z.string().min(3).max(2000).describe("Why this change is a good idea"),
      }),
      ({ strategyId, ...body }) => client.requestJson("POST", `/agent-trading/strategies/${enc(strategyId)}/changes`, { body }),
    ),
    makeTool(
      "trading_log_forecast",
      "Log your own probability call for a strategy's coin, for the bar that JUST closed. You send only `probabilityUp` (your chance, 0.01 to 0.99 and not 0.5, that the price is higher when the strategy's prediction horizon ends) and a short `reason` in plain words. The server picks the bar, the price, the horizon and the time; you cannot set or change any of them, and a call is accepted only within 15 minutes after a bar closes (otherwise wait for the next close). One call per strategy per bar, never edited. It is scored forward only, next to the rules and the simple baselines, as its own forecaster. It is never backtested, has no effect on any order, and the reason is only kept as a note: news or web text may inform it but never reaches the trading engine.",
      z.object({
        strategyId: z.string().uuid(),
        probabilityUp: z.number().min(0.01).max(0.99).describe("Your probability that the price is higher at the end of the horizon, from the closing price of the newest closed bar"),
        reason: z.string().min(5).max(500).describe("Why, in one or two plain sentences"),
      }),
      ({ strategyId, ...body }) => client.requestJson("POST", `/agent-trading/strategies/${enc(strategyId)}/forecasts`, { body }),
    ),
  ];
}
