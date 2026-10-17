/**
 * Crypto wallet tools for agents. Like the browser tools, this file "holds
 * no secret, makes no decision": every tool is a direct pass-through to one
 * `/api/agent-wallets/...` call made with the agent's own run token. The
 * server holds the keys, signs, and enforces every rule (allow-list, limits,
 * approval cards, kill switches, test network by default). Nothing a tool
 * returns ever contains a private key.
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

const walletId = z.string().uuid().describe("The wallet's id, from wallet_list");
const amount = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).describe("A plain decimal amount in the wallet's own coin, like 0.001");

export function createWalletToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  const enc = encodeURIComponent;
  return [
    makeTool(
      "wallet_list",
      "List the crypto wallets that belong to you: chain, network (test or main), address, limits and whether they are frozen. You never see or need the private key; the server signs for you.",
      z.object({}),
      () => client.requestJson("GET", "/agent-wallets"),
    ),
    makeTool(
      "wallet_balance",
      "Check one of your wallets' balance on its network.",
      z.object({ walletId }),
      ({ walletId: id }) => client.requestJson("GET", `/agent-wallets/${enc(id)}/balance`),
    ),
    makeTool(
      "wallet_allowed_addresses",
      "List the addresses this wallet may send to. You can only send to these; ask a person to add a new one.",
      z.object({ walletId }),
      ({ walletId: id }) => client.requestJson("GET", `/agent-wallets/${enc(id)}/destinations`),
    ),
    makeTool(
      "wallet_quote",
      "Dry run: the network fee and whether a payment would go straight through, wait for a person's approval, or be refused. Never sends anything. For Hyperliquid, pass coin to get its current price.",
      z.object({
        walletId,
        to: z.string().min(10).max(120).optional(),
        amount: amount.optional(),
        coin: z.string().regex(/^[A-Z0-9]{1,15}$/).optional(),
      }),
      ({ walletId: id, ...body }) => client.requestJson("POST", `/agent-wallets/${enc(id)}/quote`, { body }),
    ),
    makeTool(
      "wallet_send",
      "Send coins from your wallet to an address on its allowed list (on Hyperliquid: withdraw USDC). The server checks the limits; above the approval amount a person must approve first, and the result says so. Payments cannot be undone. Check the result's status with wallet_check_transaction.",
      z.object({
        walletId,
        to: z.string().min(10).max(120),
        amount,
        purpose: z.string().min(3).max(500).describe("One sentence: what the payment is for. Shown to the person who approves it."),
      }),
      ({ walletId: id, ...body }) => client.requestJson("POST", `/agent-wallets/${enc(id)}/send`, { body }),
    ),
    makeTool(
      "wallet_hyperliquid_order",
      "Place a limit order on Hyperliquid from your Hyperliquid wallet. Leverage is capped by the owner (1x unless changed). reduceOnly orders can only shrink a position. Large orders wait for a person's approval.",
      z.object({
        walletId,
        coin: z.string().regex(/^[A-Z0-9]{1,15}$/),
        side: z.enum(["buy", "sell"]),
        size: amount.describe("Order size in the coin, like 0.01"),
        limitPrice: amount.describe("Limit price in USD"),
        reduceOnly: z.boolean().optional(),
        purpose: z.string().min(3).max(500),
      }),
      ({ walletId: id, ...body }) => client.requestJson("POST", `/agent-wallets/${enc(id)}/hyperliquid-order`, { body }),
    ),
    makeTool(
      "wallet_check_transaction",
      "Check what happened to a payment or order you asked for: waiting for approval, sent, confirmed, refused, or expired.",
      z.object({ transactionId: z.string().uuid() }),
      ({ transactionId }) => client.requestJson("GET", `/agent-wallets/transactions/${enc(transactionId)}`),
    ),
  ];
}
