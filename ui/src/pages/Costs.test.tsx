// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Costs } from "./Costs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockCostsApi = vi.hoisted(() => ({
  cacheStatus: vi.fn(),
  summary: vi.fn(),
  byAgent: vi.fn(),
  byAgentModel: vi.fn(),
  byProject: vi.fn(),
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  financeSummary: vi.fn(),
  financeByBiller: vi.fn(),
  financeByKind: vi.fn(),
  financeEvents: vi.fn(),
  walletBalance: vi.fn(),
  windowSpend: vi.fn(),
  quotaWindows: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockBudgetsApi = vi.hoisted(() => ({ overview: vi.fn() }));

vi.mock("../api/costs", () => ({ costsApi: mockCostsApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/budgets", () => ({ budgetsApi: mockBudgetsApi }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Durkan" } }),
}));
vi.mock("../components/HiddenInPresentationMode", () => ({
  HiddenInPresentationMode: ({ children }: { children: unknown }) => <>{children}</>,
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

function cacheRow(agentId: string, agentName: string) {
  return {
    agentId,
    agentName,
    cacheWarm: false,
    contextTokens: null,
    lastRewriteCostCents: null,
    rewritesThisWeekCents: 0,
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("Costs saved context panel", () => {
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("hides retired agents but keeps paused ones", async () => {
    for (const fn of Object.values(mockCostsApi)) fn.mockResolvedValue([]);
    mockBudgetsApi.overview.mockResolvedValue({ policies: [], activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0, pendingApprovalCount: 0 });
    mockCostsApi.cacheStatus.mockResolvedValue([
      cacheRow("a1", "Frontend Engineer"),
      cacheRow("a2", "Claude CTO"),
      cacheRow("a3", "Paused Helper"),
    ]);
    mockAgentsApi.list.mockResolvedValue([
      { id: "a1", name: "Frontend Engineer", status: "active" },
      { id: "a2", name: "Claude CTO", status: "terminated" },
      { id: "a3", name: "Paused Helper", status: "paused" },
    ]);

    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Costs />
        </QueryClientProvider>,
      );
    });
    await flush();

    const text = container.textContent ?? "";
    expect(text).toContain("Saved context");
    expect(text).toContain("Frontend Engineer");
    expect(text).toContain("Paused Helper");
    expect(text).not.toContain("Claude CTO");

    await act(async () => root.unmount());
  });
});
