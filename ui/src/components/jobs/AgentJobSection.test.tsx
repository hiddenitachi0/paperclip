// @vitest-environment jsdom
//
// DUR-142: the live backend response for GET /agents/:id/role never matched
// the AgentRoleState shape this component reads (`roleState.tools.fromJob`),
// so every agent detail page crashed with "Cannot read properties of
// undefined (reading 'fromJob')". The server side of that mismatch is fixed
// separately in server/src/routes/agent-roles.ts; this covers the client
// guard so a future shape drift renders calmly instead of throwing again.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentJobSection } from "./AgentJobSection";
import { jobsApi } from "../../api/jobs";
import { agentsApi } from "../../api/agents";
import { companySkillsApi } from "../../api/companySkills";

vi.mock("../../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../../api/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/jobs")>();
  return {
    ...actual,
    jobsApi: {
      ...actual.jobsApi,
      getAgentRoleState: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
    },
  };
});

vi.mock("../../api/agents", () => ({
  agentsApi: { get: vi.fn().mockResolvedValue({ id: "agent-1", roleOverrides: {} }) },
}));

vi.mock("../../api/companySkills", () => ({
  companySkillsApi: { list: vi.fn().mockResolvedValue([]) },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushReact();
    }
  }
  throw lastError;
}

describe("AgentJobSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentJobSection agentId="agent-1" companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders the normal empty state for an agent with no job assigned", async () => {
    vi.mocked(jobsApi.getAgentRoleState).mockResolvedValue({
      job: null,
      assignedAt: null,
      tools: { fromJob: [], added: [], removed: [] },
      rights: { fromJob: [], added: [], removed: [] },
    });

    await render();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("No job assigned.");
    });
  });

  // Reproduces the exact DUR-142 crash: a response missing the nested
  // tools/rights structure the type promises must not throw.
  it("renders the fallback message instead of throwing when tools/rights are missing from the response", async () => {
    vi.mocked(jobsApi.getAgentRoleState).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { job: null, assignedAt: null } as any,
    );

    await render();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Could not load this agent's job");
    });
  });

  // DUR-146 Stage 1 item 19(b): the skills bucket combines the assigned
  // job's skillKeys (fromJob) with this agent's own roleOverrides.skills
  // (added/removed) — two separate endpoints, since GET /agents/:id/role
  // doesn't return skill state.
  it("renders from-job, added, and removed skills from the job and the agent's overrides", async () => {
    vi.mocked(jobsApi.getAgentRoleState).mockResolvedValue({
      job: { id: "job-1", name: "Support agent", description: "" },
      assignedAt: null,
      tools: { fromJob: [], added: [], removed: [] },
      rights: { fromJob: [], added: [], removed: [] },
    });
    vi.mocked(jobsApi.get).mockResolvedValue({
      id: "job-1",
      companyId: "company-1",
      name: "Support agent",
      description: "",
      instructions: "",
      defaultTools: [],
      defaultRights: [],
      skillKeys: ["triage", "refunds"],
      connectorKeys: [],
      createdAt: "",
      updatedAt: "",
    });
    vi.mocked(agentsApi.get).mockResolvedValue({
      id: "agent-1",
      roleOverrides: { skills: { add: ["custom-macro"], remove: ["refunds"] } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(companySkillsApi.list).mockResolvedValue([
      { key: "triage", name: "Triage tickets" },
      { key: "refunds", name: "Process refunds" },
      { key: "custom-macro", name: "Custom macro" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    await render();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Triage tickets");
      expect(container.textContent).toContain("Custom macro");
      expect(container.textContent).toContain("Process refunds");
    });
  });
});
