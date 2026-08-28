// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Changelog } from "./Changelog";

const changeLogListMock = vi.hoisted(() => vi.fn());
const projectsListMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/changeLog", () => ({
  changeLogApi: {
    list: (companyId: string, params?: unknown) => changeLogListMock(companyId, params),
  },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: (companyId: string) => projectsListMock(companyId),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Changelog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    projectsListMock.mockResolvedValue([{ id: "proj-1", name: "Website" }]);
    changeLogListMock.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "DUR-1",
        title: "Login button did nothing on mobile",
        changeLogSummary:
          "Wrong: tapping Log in on a phone did nothing. Fixed: the button now submits the form. Where: sign-in page.",
        completedAt: "2026-08-27T10:00:00.000Z",
        priority: "high",
        projectId: "proj-1",
        projectName: "Website",
      },
    ]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders fixed issues in plain language with no action controls", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <Changelog />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("DUR-1");
    expect(container.textContent).toContain("Login button did nothing on mobile");
    expect(container.textContent).toContain("tapping Log in on a phone did nothing");
    expect(container.querySelector("button[type=submit]")).toBeNull();
    expect(container.textContent).not.toContain("Approve");
    expect(container.textContent).not.toContain("Reject");
  });

  it("shows a plain-language empty state when nothing shipped recently", async () => {
    changeLogListMock.mockResolvedValue([]);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <Changelog />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Nothing fixed or changed");
  });
});
