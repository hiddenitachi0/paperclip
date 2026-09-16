// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { StalledTask, StalledTasksResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
  approvalsList: vi.fn(),
  approvalsListIssues: vi.fn(),
  agentsList: vi.fn(),
  issuesList: vi.fn(),
  issuesGet: vi.fn(),
  pendingInteractions: vi.fn(),
  stalledTasks: vi.fn(),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: apiMocks.liveRunsForCompany },
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    list: apiMocks.approvalsList,
    listIssues: apiMocks.approvalsListIssues,
    approve: vi.fn(),
    reject: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: apiMocks.agentsList },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: apiMocks.issuesList,
    get: apiMocks.issuesGet,
    acceptInteraction: vi.fn(),
    rejectInteraction: vi.fn(),
  },
}));

vi.mock("../api/interactions", () => ({
  interactionsApi: { listPendingForCompany: apiMocks.pendingInteractions },
}));

vi.mock("../api/stalledTasks", () => ({
  stalledTasksApi: { listForCompany: apiMocks.stalledTasks },
}));

vi.mock("../components/FleetHealthStrip", () => ({
  FleetHealthStrip: () => null,
}));

vi.mock("../components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({ transcriptByRun: new Map() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Nordstrand", issuePrefix: "NOR" },
    companies: [{ id: "company-1", name: "Nordstrand" }],
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
  ),
}));

import { DashboardNow } from "./DashboardNow";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function stalledTask(overrides: Partial<StalledTask> = {}): StalledTask {
  return {
    issueId: "issue-1",
    identifier: "NOR-1410",
    title: "Check the new supplier import",
    status: "in_review",
    reason: "idle_in_review",
    reasonText: "Finished and waiting for you since 13 September.",
    sinceAt: "2026-09-13T08:00:00.000Z",
    agentName: "Backend Engineer",
    ...overrides,
  };
}

function stalledResult(tasks: StalledTask[], totalCount?: number): StalledTasksResult {
  return { tasks, totalCount: totalCount ?? tasks.length, stalledAfterHours: 12 };
}

function resetMocks() {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.liveRunsForCompany.mockResolvedValue([]);
  apiMocks.approvalsList.mockResolvedValue([]);
  apiMocks.approvalsListIssues.mockResolvedValue([]);
  apiMocks.agentsList.mockResolvedValue([]);
  apiMocks.issuesList.mockResolvedValue([]);
  apiMocks.issuesGet.mockResolvedValue(null);
  apiMocks.pendingInteractions.mockResolvedValue([]);
  apiMocks.stalledTasks.mockResolvedValue(stalledResult([]));
}

async function renderNow(container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DashboardNow />
      </QueryClientProvider>,
    );
  });
  // Let the parallel lane queries settle.
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  return root;
}

describe("DashboardNow — work nobody is moving", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("shows a row for each task nobody is moving, each with its plain-language reason", async () => {
    apiMocks.stalledTasks.mockResolvedValue(
      stalledResult([
        stalledTask(),
        stalledTask({
          issueId: "issue-2",
          identifier: "NOR-1412",
          title: "Reconcile the September ledger",
          status: "in_progress",
          reason: "assignee_unavailable",
          reasonText:
            "Nobody is working on this — Budgeted is paused because it reached its budget limit. Waiting since 13 September.",
        }),
      ]),
    );

    const root = await renderNow(container);

    const rows = container.querySelectorAll('[data-testid="now-stalled-task"]');
    expect(rows).toHaveLength(2);
    expect(container.textContent).toContain("Finished and waiting for you since 13 September.");
    expect(container.textContent).toContain(
      "Nobody is working on this — Budgeted is paused because it reached its budget limit.",
    );
    // The operator is told which task, in his own reference, not an internal id.
    expect(container.textContent).toContain("NOR-1410");
    expect(container.textContent).not.toContain("issue-1");

    act(() => root.unmount());
  });

  it("counts stalled work in the Needs-you total and in the honesty line", async () => {
    apiMocks.stalledTasks.mockResolvedValue(stalledResult([stalledTask(), stalledTask({ issueId: "issue-2" })]));
    // Three open tasks on the board overall.
    apiMocks.issuesList.mockResolvedValue([
      { id: "issue-1" },
      { id: "issue-2" },
      { id: "issue-3" },
    ]);

    const root = await renderNow(container);

    expect(container.textContent).toContain("Showing 2 of 3 open");

    act(() => root.unmount());
  });

  it("keeps the +N more line honest about rows the server itself capped", async () => {
    // 60 qualify; the server returned its cap of 50, the lane renders 12.
    const tasks = Array.from({ length: 50 }, (_, index) =>
      stalledTask({ issueId: `issue-${index}`, identifier: `NOR-${index}` }),
    );
    apiMocks.stalledTasks.mockResolvedValue(stalledResult(tasks, 60));

    const root = await renderNow(container);

    expect(container.querySelectorAll('[data-testid="now-stalled-task"]')).toHaveLength(12);
    // 50 fetched - 12 shown = 38, plus 60 - 50 = 10 the server capped.
    expect(container.textContent).toContain("+48 more");

    act(() => root.unmount());
  });

  it("says nothing needs you when no source has anything", async () => {
    const root = await renderNow(container);

    expect(container.querySelectorAll('[data-testid="now-stalled-task"]')).toHaveLength(0);
    expect(container.textContent).toContain("Nothing needs you right now.");

    act(() => root.unmount());
  });
});
