// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimpleMode } from "./SimpleMode";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  listComments: vi.fn(),
}));
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));

vi.mock("@/lib/router", () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
  useNavigate: () => mockNavigate,
  useParams: () => ({ companyPrefix: "PAP" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", issuePrefix: "PAP" }],
    loading: false,
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

const ceoAgent = { id: "agent-ceo", role: "ceo", status: "active" };

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SimpleMode", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentsApi.list.mockResolvedValue([ceoAgent]);
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
  });

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SimpleMode />
        </QueryClientProvider>,
      );
    });
  }

  it("shows only a text box with no board chrome", async () => {
    render();
    await flush();
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.textContent).not.toMatch(/ticket|approval|board/i);
  });

  it("submitting creates a normal todo issue assigned to the CEO and shows a working state", async () => {
    mockIssuesApi.create.mockResolvedValue({ id: "issue-1", identifier: "PAP-99", status: "todo" });
    mockIssuesApi.get.mockResolvedValue({ id: "issue-1", identifier: "PAP-99", status: "in_progress" });
    render();
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;
    act(() => {
      setTextareaValue(textarea, "Rewrite my product description");
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith("company-1", {
      title: "Rewrite my product description",
      description: "Rewrite my product description",
      assigneeAgentId: "agent-ceo",
      status: "todo",
      priority: "medium",
    });
    expect(container.textContent).toMatch(/working on this/i);
    expect(container.textContent).not.toMatch(/PAP-99/);
  });

  it("shows the sanitized agent reply once the issue settles, with no ticket/PR/commit references", async () => {
    mockIssuesApi.create.mockResolvedValue({ id: "issue-1", identifier: "PAP-99", status: "todo" });
    mockIssuesApi.get.mockResolvedValue({ id: "issue-1", identifier: "PAP-99", status: "done" });
    mockIssuesApi.listComments.mockResolvedValue([
      {
        authorType: "agent",
        body: "Done — see PAP-99 and PR #12 (commit 9c3101d9be7ac0).",
        createdAt: "2026-08-25T00:00:00Z",
        deletedAt: null,
      },
    ]);
    render();
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;
    act(() => {
      setTextareaValue(textarea, "What is going on in the company?");
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Done — see and");
    expect(container.textContent).not.toMatch(/PAP-99/);
    expect(container.textContent).not.toMatch(/PR #12/);
    expect(container.textContent).not.toMatch(/9c3101d9be7ac0/);
    expect(container.textContent).toMatch(/ask something else/i);
  });
});
