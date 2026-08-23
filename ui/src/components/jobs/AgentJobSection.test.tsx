// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentJobSection } from "./AgentJobSection";

const getAgentRoleStateMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/jobs", () => ({
  jobsApi: {
    getAgentRoleState: (agentId: string) => getAgentRoleStateMock(agentId),
    list: vi.fn(),
    assignToAgent: vi.fn(),
    addAgentToolOverride: vi.fn(),
    removeAgentToolOverride: vi.fn(),
    addAgentRightOverride: vi.fn(),
    removeAgentRightOverride: vi.fn(),
  },
}));

vi.mock("../../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AgentJobSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getAgentRoleStateMock.mockReset();
    pushToastMock.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentJobSection agentId="agent-1" companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return container;
  }

  it("renders the no-job empty state instead of throwing when tools/rights are absent (unbuilt backend)", async () => {
    // The real DUR-114 backend doesn't exist yet; this mirrors what an agent with
    // no role assigned actually gets back from an endpoint that only returns `job`.
    getAgentRoleStateMock.mockResolvedValue({ job: null, assignedAt: null });

    const node = await render();

    expect(node.textContent).toContain("Could not load this agent's job");
    expect(node.textContent).not.toContain("undefined");
  });

  it("renders normally for an agent with no job assigned and a complete shape", async () => {
    getAgentRoleStateMock.mockResolvedValue({
      job: null,
      assignedAt: null,
      tools: { fromJob: [], added: [], removed: [] },
      rights: { fromJob: [], added: [], removed: [] },
    });

    const node = await render();

    expect(node.textContent).toContain("No job assigned.");
    expect(node.textContent).toContain("No tools.");
    expect(node.textContent).toContain("No rights.");
  });

  it("does not throw when only one of tools/rights is present", async () => {
    getAgentRoleStateMock.mockResolvedValue({
      job: null,
      assignedAt: null,
      tools: { fromJob: [], added: [], removed: [] },
    });

    const node = await render();

    expect(node.textContent).toContain("Could not load this agent's job");
  });
});
