// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleRun } from "../lib/tradingBacktestFixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ run: null as unknown, gate: null as unknown }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => <a href={to} {...rest}>{children}</a>,
  useParams: () => ({ strategyId: "s1", runId: "r1" }),
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("../api/trading", () => ({
  tradingApi: {
    list: async () => [{ id: "s1", name: "Trend follower" }],
    backtest: async () => mocks.run,
    startGate: async () => mocks.gate,
  },
}));

import { TradingBacktestReport } from "./TradingBacktestReport";

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TradingBacktestReport />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return { container, root };
}

beforeEach(() => {
  mocks.gate = { variantsTried: 14, holdoutReads: 2 };
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("TradingBacktestReport", () => {
  it("shows a passing strategy with the paper-only label, a ticked checklist and the honesty numbers", async () => {
    mocks.run = sampleRun("pass");
    const { container, root } = await render();
    expect(container.querySelector('[data-testid="report-verdict"]')?.textContent).toContain("Passed the past-data checks: paper only, not a recommendation");
    expect(container.querySelector('[data-testid="report-headline"]')?.textContent).toContain("312 trades, 54% won");
    const ticks = container.querySelectorAll('[data-testid="report-checklist"] svg[aria-label="Passed"]');
    expect(ticks.length).toBe(12);
    expect(container.querySelector('[data-testid="report-tried"]')?.textContent).toContain("14 versions of the rules have been tried");
    expect(container.querySelector('[data-testid="report-looked"]')?.textContent).toContain("looked at 2 times");
    expect(container.querySelector('[data-testid="coin-BTC"]')?.textContent).toContain("Main result");
    expect(container.querySelector('[data-testid="coin-SOL"]')?.textContent).toContain("Picked after the fact");
    expect(container.querySelector('[data-testid="window-chart"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="compare-chart"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("shows a failing strategy with the failed checks marked and what was never tested", async () => {
    mocks.run = sampleRun("fail");
    const { container, root } = await render();
    expect(container.querySelector('[data-testid="report-verdict"]')?.textContent).toContain("Did not pass the past-data checks");
    expect(container.querySelector('[data-testid="report-verdict"]')?.textContent).not.toContain("paper only");
    expect(container.querySelectorAll('[data-testid="report-checklist"] svg[aria-label="Did not pass"]').length).toBe(6);
    expect(container.querySelector('[data-testid="coin-BTC"]')?.textContent).toContain("BTC was never tested in a rising market.");
    await act(async () => root.unmount());
  });

  it("can show a chart as a table", async () => {
    mocks.run = sampleRun("pass");
    const { container, root } = await render();
    const toggle = [...container.querySelectorAll("button")].find((b) => b.textContent === "Show as a table")!;
    await act(async () => toggle.click());
    expect(container.querySelector('[data-testid="window-table"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="window-table"] tbody tr').length).toBe(12);
    await act(async () => root.unmount());
  });

  it("says a test that is still waiting is waiting, without a verdict", async () => {
    mocks.run = { ...sampleRun("pass"), status: "queued", report: null, gate: null, gatePassed: null };
    const { container, root } = await render();
    expect(container.querySelector('[data-testid="report-waiting"]')?.textContent).toContain("waiting for its turn");
    expect(container.querySelector('[data-testid="report-verdict"]')).toBeNull();
    await act(async () => root.unmount());
  });
});
