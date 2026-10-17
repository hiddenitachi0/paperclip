import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { createWalletToolDefinitions } from "./wallet-tools.js";
import { createPaperclipMcpServer } from "./index.js";

const config = {
  apiUrl: "http://localhost:3100/api",
  apiKey: "token-123",
  companyId: "11111111-1111-1111-1111-111111111111",
  agentId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
};

function tool(name: string) {
  const found = createWalletToolDefinitions(new PaperclipApiClient(config)).find((t) => t.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

describe("crypto wallet MCP tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes a send straight through to the agent-wallets API and returns the server's answer as-is", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "tx", status: "pending_approval" }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const walletId = "44444444-4444-4444-8444-444444444444";
    const result = await tool("wallet_send").execute({ walletId, to: "So1aNaAddressxxxxxxxxxxxxxxxxxxxxxxx", amount: "0.01", purpose: "Pay the supplier" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:3100/api/agent-wallets/${walletId}/send`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ to: "So1aNaAddressxxxxxxxxxxxxxxxxxxxxxxx", amount: "0.01", purpose: "Pay the supplier" });
    expect(result.content[0]!.text).toContain("pending_approval");
  });

  it("has no tool that takes or returns a private key", () => {
    const tools = createWalletToolDefinitions(new PaperclipApiClient(config));
    for (const t of tools) {
      expect(Object.keys(t.schema.shape).some((k) => /key|secret|mnemonic|seed/i.test(k))).toBe(false);
    }
    expect(tools.map((t) => t.name)).toEqual([
      "wallet_list",
      "wallet_balance",
      "wallet_allowed_addresses",
      "wallet_quote",
      "wallet_send",
      "wallet_hyperliquid_order",
      "wallet_check_transaction",
    ]);
  });

  it("is registered on the main Paperclip MCP server", () => {
    const { tools } = createPaperclipMcpServer(config);
    expect(tools.some((t) => t.name === "wallet_send")).toBe(true);
  });
});
