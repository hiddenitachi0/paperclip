// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectDeployHistoryPage } from "./ProjectDeployHistoryPage";

const projectsGetMock = vi.hoisted(() => vi.fn());
const historyListMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useParams: () => ({ projectId: "proj-1" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../api/projects", () => ({
  projectsApi: { get: (...args: unknown[]) => projectsGetMock(...args) },
}));

vi.mock("../api/deployRunner", () => ({
  deployRunnerApi: {
    projectDeployHistoryList: (...args: unknown[]) => historyListMock(...args),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function renderPage(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ProjectDeployHistoryPage />
      </QueryClientProvider>,
    );
  });
}

describe("ProjectDeployHistoryPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    projectsGetMock.mockResolvedValue({ id: "proj-1", companyId: "company-1", name: "Website" });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("lists pass and fail deploy entries with a link to each approval card", async () => {
    historyListMock.mockResolvedValue({
      entries: [
        { commit: "abcdef123456", approvalId: "approval-1", deployedAt: "2026-09-01T10:00:00.000Z", status: "pass" },
        { commit: "123456abcdef", approvalId: "approval-2", deployedAt: "2026-08-20T10:00:00.000Z", status: "fail" },
      ],
      pagination: { limit: 20, offset: 0, total: 2, hasMore: false },
    });

    await renderPage(container);
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Succeeded");
    expect(container.textContent).toContain("Failed");
    expect(container.querySelectorAll('a[href="/approvals/approval-1"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('a[href="/approvals/approval-2"]').length).toBeGreaterThan(0);
  });

  it("shows a plain-language empty state when there is no history yet", async () => {
    historyListMock.mockResolvedValue({ entries: [], pagination: { limit: 20, offset: 0, total: 0, hasMore: false } });

    await renderPage(container);
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No deploys have been recorded for this project yet.");
  });

  it("shows a plain-language error message when the history fails to load", async () => {
    historyListMock.mockRejectedValue(new Error("network down"));

    await renderPage(container);
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Could not load the deploy history");
  });

  it("requests the next page when Older is clicked", async () => {
    historyListMock.mockResolvedValue({
      entries: [{ commit: "abcdef123456", approvalId: "approval-1", deployedAt: "2026-09-01T10:00:00.000Z", status: "pass" }],
      pagination: { limit: 20, offset: 0, total: 40, hasMore: true },
    });

    await renderPage(container);
    await flushReact();
    await flushReact();

    const olderButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Older");
    expect(olderButton).toBeDefined();
    await act(async () => {
      olderButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const lastCall = historyListMock.mock.calls.at(-1);
    expect(lastCall?.[3]).toEqual({ limit: 20, offset: 20 });
  });
});
