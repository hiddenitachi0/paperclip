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
      "trading_propose_change",
      "Propose new rules for a strategy. Send the WHOLE new spec (start from the live spec returned by trading_get_strategy and edit it), the guidelines, a plain summary and your reasons. The server checks it; risk limits may only be tightened, never loosened. A valid proposal is saved as a draft and an approval card is filed for a person: nothing changes until they approve it. It does not place or change any order. Until past-data tests exist, every proposal is shown as 'not yet tested on past data'. At most 5 per strategy per day.",
      z.object({
        strategyId: z.string().uuid(),
        spec: z.record(z.string(), z.unknown()).describe("The complete strategy spec, in the same shape trading_get_strategy returns it"),
        guidelines: z.string().max(8000).optional().describe("The plain-language guidelines for this version"),
        summary: z.string().min(3).max(500).describe("What changes, in one or two plain sentences. Shown on the card."),
        reasons: z.string().min(3).max(2000).describe("Why this change is a good idea. Shown on the card."),
      }),
      ({ strategyId, ...body }) => client.requestJson("POST", `/agent-trading/strategies/${enc(strategyId)}/proposals`, { body }),
    ),
  ];
}
