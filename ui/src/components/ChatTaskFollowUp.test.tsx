// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTaskFollowUp, chatTaskLinks } from "./ChatTaskFollowUp";

/**
 * The in-app chat's follow-up of a task a quick agent started: "working on
 * it" while it runs, then the agent's short answer and a link to the result
 * page, the same thing Telegram gets.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";

const mockChatApi = vi.hoisted(() => ({ answers: vi.fn() }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../api/chat", () => ({ chatApi: mockChatApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE,
    companyId: COMPANY,
    identifier: "DUR-31",
    title: "Trip plan: 4 days in Rome",
    status: "in_progress",
    answer: null,
    resultDocument: null,
    ...overrides,
  };
}

describe("ChatTaskFollowUp", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root.render(
      <QueryClientProvider client={queryClient}>
        <ChatTaskFollowUp companyId={COMPANY} task={{ issueId: ISSUE, identifier: "DUR-31", title: "Trip plan" }} />
      </QueryClientProvider>,
    );
    await flushReact();
  }

  it("says it is working while the task runs", async () => {
    mockChatApi.answers.mockResolvedValue({ issues: [item()] });
    await render();

    expect(mockChatApi.answers).toHaveBeenCalledWith(COMPANY, [ISSUE]);
    expect(container.textContent).toContain("Working on DUR-31");
    expect(container.querySelector('a[href="/issues/DUR-31"]')?.textContent).toBe("Open the task");
    expect(container.textContent).not.toContain("Open the result page");
  });

  it("shows the answer and links the result page when the task is done", async () => {
    mockChatApi.answers.mockResolvedValue({
      issues: [
        item({
          status: "done",
          answer: { commentId: "c1", authorAgentId: null, body: "Your Rome plan is ready: about 14 500 NOK.", createdAt: "2026-09-28T10:00:00Z" },
          resultDocument: { key: "result", title: "Rome, 4 days" },
        }),
      ],
    });
    await render();

    expect(container.textContent).toContain("DUR-31 is finished");
    expect(container.textContent).toContain("about 14 500 NOK");
    expect(container.querySelector('a[href="/issues/DUR-31#document-result"]')?.textContent).toBe("Open the result page");
  });

  it("builds the links from the identifier, falling back to the id", () => {
    expect(chatTaskLinks({ id: ISSUE, identifier: null, resultDocument: { key: "result", title: null } })).toEqual({
      taskPath: `/issues/${ISSUE}`,
      resultPath: `/issues/${ISSUE}#document-result`,
    });
  });
});
