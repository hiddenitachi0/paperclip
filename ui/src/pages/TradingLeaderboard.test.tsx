// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TradingLeaderboard } from "./TradingLeaderboard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tradingApi = vi.hoisted(() => ({ selectorDecisions: vi.fn(), selectorDecision: vi.fn(), shadowCells: vi.fn() }));
vi.mock("../api/trading", () => ({ tradingApi }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a> }));

const estimate = (over = {}) => ({ trades: 40, tested: true, rawMeanR: 0.2, shrunkMeanR: 0.1, bootstrapLow: -0.05, bootstrapHigh: 0.3, pValue: 0.2, ...over });
const decision = {
  id: "d1",
  checkpointAt: "2026-11-01T00:00:00Z",
  rulesVersion: 1,
  choice: "cash",
  trials: 6,
  tested: 2,
  discoveries: 0,
  reason: "internal",
  decidedAt: "2026-11-01T01:00:00Z",
  output: {
    trials: 6,
    tested: 2,
    discoveries: 0,
    promoted: [],
    choice: "cash",
    reason: "internal",
    cells: [
      { key: "pullback_trend@1|up|BTC", family: "trend", estimate: estimate(), passedTest: false, action: "failed_test", note: "n", windowTrades: 0, windowMeanR: null },
      { key: "range_fade@1|range|ETH", family: "mean_reversion", estimate: estimate({ shrunkMeanR: 0.4, bootstrapLow: 0.1, bootstrapHigh: 0.7, trades: 55 }), passedTest: false, action: "failed_test", note: "n", windowTrades: 0, windowMeanR: null },
      { key: "pullback_trend@1|squeeze|SOL", family: "trend", estimate: estimate({ tested: false, trades: 8, shrunkMeanR: null, bootstrapLow: null, bootstrapHigh: null }), passedTest: false, action: "not_tested", note: "n", windowTrades: 0, windowMeanR: null },
    ],
  },
};

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TradingLeaderboard />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("TradingLeaderboard", () => {
  it("shows the API numbers, ranges, trial counts, the warning, the greyed-out style and the disclaimer", async () => {
    tradingApi.selectorDecisions.mockResolvedValue({ rules: { version: 1 }, items: [decision] });
    tradingApi.selectorDecision.mockResolvedValue(decision);
    tradingApi.shadowCells.mockResolvedValue({ items: [] });
    const c = await render();
    const rows = Array.from(c.querySelectorAll('[data-testid="leaderboard-row"]'));
    expect(rows).toHaveLength(3);
    // Ranked best-first by the server's estimate; the untested one is last and unranked.
    expect(rows[0]!.textContent).toContain("1.");
    expect(rows[0]!.querySelector('[data-testid="leaderboard-typical"]')!.textContent).toBe("+0.40");
    expect(rows[0]!.querySelector('[data-testid="leaderboard-range"]')!.textContent).toBe("+0.10 to +0.70");
    expect(rows[0]!.querySelector('[data-testid="leaderboard-trades"]')!.textContent).toBe("55");
    expect(rows[2]!.textContent).toContain("8 trades so far");
    expect(rows[2]!.textContent).not.toContain("1.");
    expect(c.querySelector('[data-testid="leaderboard-trials"]')!.textContent).toContain("6 ideas");
    expect(c.querySelector('[data-testid="leaderboard-luck-warning"]')!.textContent).toBe(
      "The best of many tests is often luck: look at the range, not just the top number.",
    );
    const excluded = c.querySelector('[data-testid="leaderboard-excluded"]')!;
    expect(excluded.textContent).toContain("Gap-and-go");
    expect(excluded.getAttribute("aria-disabled")).toBe("true");
    expect(c.querySelector('[data-testid="trading-disclaimer"]')).not.toBeNull();
    expect(c.textContent!.toLowerCase()).not.toMatch(/\bready\b|promising/);
  });

  it("says plainly when there is no monthly check yet", async () => {
    tradingApi.selectorDecisions.mockResolvedValue({ rules: { version: 1 }, items: [] });
    tradingApi.shadowCells.mockResolvedValue({ items: [] });
    const c = await render();
    expect(c.textContent).toContain("No results yet");
    expect(c.querySelector('[data-testid="leaderboard-luck-warning"]')).not.toBeNull();
  });
});
