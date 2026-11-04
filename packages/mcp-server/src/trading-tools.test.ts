import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { createTradingToolDefinitions } from "./trading-tools.js";

const config = {
  apiUrl: "http://localhost:3100/api",
  apiKey: "token-123",
  companyId: "11111111-1111-1111-1111-111111111111",
  agentId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
};
const strategyId = "44444444-4444-4444-8444-444444444444";

function tool(name: string) {
  const found = createTradingToolDefinitions(new PaperclipApiClient(config)).find((t) => t.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

describe("trading MCP tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers read tools, experiment tools and one proposal tool, and nothing that trades, switches a strategy or touches a wallet", () => {
    const tools = createTradingToolDefinitions(new PaperclipApiClient(config));
    expect(tools.map((t) => t.name)).toEqual(["trading_list_strategies", "trading_get_strategy", "trading_run_experiment", "trading_list_experiments", "trading_get_experiment", "trading_propose_change"]);
    for (const t of tools) {
      expect(Object.keys(t.schema.shape).some((k) => /key|secret|wallet|order|status|mode|side|quantity/i.test(k))).toBe(false);
    }
  });

  it("passes a read straight to the agent-trading API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ strategy: { id: strategyId } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await tool("trading_get_strategy").execute({ strategyId });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:3100/api/agent-trading/strategies/${strategyId}`);
    expect((init as RequestInit).method).toBe("GET");
  });

  it("posts a proposal to the proposals route with the strategy id in the path, not the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ outcome: "drafted" }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const experimentId = "6f1c9a52-0b5d-4c7e-9a41-2f4a3a1d7e10";
    await tool("trading_propose_change").execute({ strategyId, experimentId, spec: { a: 1 }, summary: "Tighten the stop", reasons: "Losses were deeper than planned" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:3100/api/agent-trading/strategies/${strategyId}/proposals`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ experimentId, spec: { a: 1 }, summary: "Tighten the stop", reasons: "Losses were deeper than planned" });
  });

  it("will not even send a proposal that cites no experiment", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await tool("trading_propose_change").execute({ strategyId, spec: { a: 1 }, summary: "Tighten the stop", reasons: "Losses were deeper than planned" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toMatch(/experimentId/);
  });

  it("queues an experiment with the grid in the body and the strategy in the path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "e1", status: "queued" }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const grid = [{ indicator: "slow", param: "period", values: [10, 20] }];
    await tool("trading_run_experiment").execute({ strategyId, grid });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:3100/api/agent-trading/strategies/${strategyId}/experiments`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ grid });
  });

  it("reads one experiment from the agent-trading API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "e1" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const experimentId = "6f1c9a52-0b5d-4c7e-9a41-2f4a3a1d7e10";
    await tool("trading_get_experiment").execute({ strategyId, experimentId });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`http://localhost:3100/api/agent-trading/strategies/${strategyId}/experiments/${experimentId}`);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("GET");
  });

  it("returns the server's refusal as an error result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Only the company's Trader agent can use the trading tools." }), { status: 403, headers: { "Content-Type": "application/json" } })));
    const result = await tool("trading_list_strategies").execute({});
    expect(result.content[0]!.text).toContain("Trader agent");
  });
});
