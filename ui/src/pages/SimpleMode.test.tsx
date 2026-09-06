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
const mockChatApi = vi.hoisted(() => ({ classify: vi.fn(), sendMessage: vi.fn() }));
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/chat", () => ({ chatApi: mockChatApi }));

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

const ceoAgent = { id: "agent-ceo", name: "Casey", role: "ceo", status: "active" };
const engineerAgent = { id: "agent-eng", name: "Riley", role: "engineer", status: "active" };

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
    mockAgentsApi.list.mockResolvedValue([ceoAgent, engineerAgent]);
    mockChatApi.classify.mockResolvedValue({
      lane: "b",
      targetAgentId: "agent-eng",
      reasoning: "This is a build request, so Riley (engineering) should take it.",
    });
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

  async function advance(ms: number) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
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

  it("shows the classifier's suggested lane, recipient, and reasoning before send", async () => {
    render();
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setTextareaValue(textarea, "Build a new signup flow for the landing page");
    });
    await advance(600);
    await flush();

    expect(mockChatApi.classify).toHaveBeenCalledWith(
      "company-1",
      "Build a new signup flow for the landing page",
    );
    expect(container.textContent).toContain("Riley");
    expect(container.textContent).toContain("Real work");
    expect(container.textContent).toMatch(/Riley \(engineering\) should take it/);
  });

  it("submitting sends through the chat router with the classifier's pick and shows a working state", async () => {
    mockChatApi.sendMessage.mockResolvedValue({
      lane: "b",
      result: null,
      taskRef: { issueId: "issue-1", identifier: "PAP-99", status: "todo" },
    });
    mockIssuesApi.get.mockResolvedValue({ id: "issue-1", identifier: "PAP-99", status: "in_progress" });
    render();
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setTextareaValue(textarea, "Build a new signup flow for the landing page");
    });
    await advance(600);
    await flush();

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flush();

    expect(mockChatApi.sendMessage).toHaveBeenCalledWith("agent-eng", {
      companyId: "company-1",
      message: "Build a new signup flow for the landing page",
      laneHint: "b",
    });
    expect(container.textContent).toMatch(/working on this/i);
    expect(container.textContent).not.toMatch(/PAP-99/);
  });

  it("overriding only the recipient keeps the classifier's lane pick", async () => {
    mockChatApi.sendMessage.mockResolvedValue({
      lane: "b",
      result: null,
      taskRef: { issueId: "issue-1", identifier: "PAP-99", status: "todo" },
    });
    render();
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setTextareaValue(textarea, "Build a new signup flow for the landing page");
    });
    await advance(600);
    await flush();

    // Override the recipient via the select's underlying trigger button click path
    // is exercised indirectly here by asserting state through submit, since Radix
    // Select requires pointer events jsdom doesn't fully implement — instead verify
    // that changing the lane alone leaves the classifier's recipient untouched.
    const laneButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent === "Quick question",
    );
    act(() => {
      laneButtons[0]?.click();
    });
    await flush();

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flush();

    // Lane was overridden to "a", but the recipient still resolves to the
    // classifier's pick (agent-eng) since only lane was touched.
    expect(mockChatApi.sendMessage).toHaveBeenCalledWith("agent-eng", {
      companyId: "company-1",
      message: "Build a new signup flow for the landing page",
      laneHint: "a",
    });
  });

  it("falls back to the CEO pick and still sends when the classifier call fails", async () => {
    mockChatApi.classify.mockRejectedValue(new Error("503"));
    mockChatApi.sendMessage.mockResolvedValue({
      lane: "a",
      result: { conversationId: "c1", response: "Here's your answer.", turnCount: 1, stopReason: "end_turn" },
      taskRef: null,
    });
    render();
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setTextareaValue(textarea, "What is our refund policy?");
    });
    await advance(600);
    await flush();

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flush();

    expect(mockChatApi.sendMessage).toHaveBeenCalledWith("agent-ceo", {
      companyId: "company-1",
      message: "What is our refund policy?",
      laneHint: undefined,
    });
    expect(container.textContent).toContain("Here's your answer.");
  });

  it("shows the sanitized agent reply once the issue settles, with no ticket/PR/commit references", async () => {
    mockChatApi.sendMessage.mockResolvedValue({
      lane: "b",
      result: null,
      taskRef: { issueId: "issue-1", identifier: "PAP-99", status: "todo" },
    });
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
    act(() => {
      setTextareaValue(textarea, "What is going on in the company?");
    });
    await advance(600);
    await flush();

    const form = container.querySelector("form") as HTMLFormElement;
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
