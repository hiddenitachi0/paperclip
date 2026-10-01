// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowMap } from "./WorkflowMap";

// @xyflow/react measures its container with ResizeObserver, which jsdom
// does not implement.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = ResizeObserverStub;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pipelinesListMock = vi.fn();
const pipelinesGetMock = vi.fn();
const routinesListMock = vi.fn();
const approvalsListMock = vi.fn();
const jobsListMock = vi.fn();
const experimentalMock = vi.fn();

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../api/pipelines", () => ({
  pipelinesApi: {
    list: () => pipelinesListMock(),
    get: (id: string) => pipelinesGetMock(id),
  },
}));

vi.mock("../api/routines", () => ({
  routinesApi: {
    list: () => routinesListMock(),
  },
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    list: () => approvalsListMock(),
  },
}));

vi.mock("../api/jobs", () => ({
  jobsApi: {
    list: () => jobsListMock(),
  },
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: {
    getExperimental: () => experimentalMock(),
  },
}));

function renderWithClient(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("WorkflowMap", () => {
  beforeEach(() => {
    pipelinesListMock.mockReset().mockResolvedValue([]);
    pipelinesGetMock.mockReset();
    routinesListMock.mockReset().mockResolvedValue([]);
    approvalsListMock.mockReset().mockResolvedValue([]);
    jobsListMock.mockReset().mockResolvedValue([]);
    experimentalMock.mockReset().mockResolvedValue({ enablePipelines: false });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows an empty state when there is nothing to map", async () => {
    const { container, unmount } = renderWithClient(<WorkflowMap />);
    await flush();
    expect(container.textContent).toContain("Nothing to map yet");
    unmount();
  });

  it("renders routines, their triggers, and approvals as plain-language sections", async () => {
    routinesListMock.mockResolvedValue([
      {
        id: "routine-1",
        companyId: "company-1",
        title: "Morning report",
        status: "active",
        triggers: [{ id: "t1", kind: "schedule", label: null, enabled: true, cronExpression: "0 8 * * *", timezone: "UTC", nextRunAt: null, lastFiredAt: null, lastResult: null }],
      },
    ]);
    approvalsListMock.mockResolvedValue([
      { id: "a1", companyId: "company-1", type: "hire_agent", status: "pending", payload: {}, requestedByAgentId: null, requestedByUserId: null, decisionNote: null, decidedByUserId: null, decidedAt: null, createdAt: new Date(), updatedAt: new Date() },
    ]);
    jobsListMock.mockResolvedValue([
      { id: "job-1", companyId: "company-1", name: "Backend Engineer", description: "Ships the API", instructions: "", defaultTools: [], defaultRights: [], skillKeys: ["a", "b"], connectorKeys: [], createdAt: "", updatedAt: "" },
    ]);

    const { container, unmount } = renderWithClient(<WorkflowMap />);
    await flush();

    expect(container.textContent).toContain("Routines");
    expect(container.textContent).toContain("Morning report");
    expect(container.textContent).toContain("Runs on a schedule");
    expect(container.textContent).toContain("Approvals");
    expect(container.textContent).toContain("Hiring a new agent");
    expect(container.textContent).toContain("Jobs");
    expect(container.textContent).toContain("Backend Engineer");
    // Read-only: nothing here should look like an edit affordance.
    expect(container.querySelector("button[aria-label*=dd]")).toBeNull();

    unmount();
  });

  it("skips the pipelines section when the experimental flag is off", async () => {
    experimentalMock.mockResolvedValue({ enablePipelines: false });
    const { container, unmount } = renderWithClient(<WorkflowMap />);
    await flush();
    expect(pipelinesListMock).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("No pipelines set up yet");
    unmount();
  });

  it("builds a stage chain with transitions when pipelines are enabled", async () => {
    experimentalMock.mockResolvedValue({ enablePipelines: true });
    pipelinesListMock.mockResolvedValue([
      {
        id: "pipeline-1",
        companyId: "company-1",
        key: "intake",
        name: "Intake",
        description: null,
        projectId: null,
        enforceTransitions: true,
        archivedAt: null,
        stageCount: 2,
        stages: [
          { id: "stage-1", pipelineId: "pipeline-1", key: "new", name: "New", kind: "working", position: 0, config: null },
          { id: "stage-2", pipelineId: "pipeline-1", key: "review", name: "Review", kind: "review", position: 1, config: null },
        ],
        openCaseCount: 0,
        createdAt: "",
        updatedAt: "",
      },
    ]);
    pipelinesGetMock.mockResolvedValue({
      id: "pipeline-1",
      companyId: "company-1",
      key: "intake",
      name: "Intake",
      description: null,
      projectId: null,
      enforceTransitions: true,
      archivedAt: null,
      stageCount: 2,
      stages: [],
      openCaseCount: 0,
      createdAt: "",
      updatedAt: "",
      transitions: [{ fromStageId: "stage-1", toStageId: "stage-2", label: "Submit" }],
      documentKeys: [],
    });

    const { container, unmount } = renderWithClient(<WorkflowMap />);
    await flush();
    await flush();

    expect(container.textContent).toContain("Intake");
    expect(container.textContent).toContain("New");
    expect(container.textContent).toContain("Needs review");
    unmount();
  });
});
