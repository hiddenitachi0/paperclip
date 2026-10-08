// @vitest-environment jsdom

import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

// The agent's Configuration tab: Identity, then the quick agent block (always
// in the same place, so flipping its switch keeps it mounted), then "Full
// runs: engine and model", daily limits, trust and permissions, job, API keys
// and configuration history. AgentConfigForm is stubbed here so this test is
// only about where the page puts each block; the form's own grouping is
// covered in AgentConfigForm.render.test.tsx.

const mockAgentsApi = vi.hoisted(() => ({
  listConfigRevisions: vi.fn(),
  listKeys: vi.fn(),
  adapterModels: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../api/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/agents")>()),
  agentsApi: mockAgentsApi,
}));

vi.mock("../context/ToastContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context/ToastContext")>()),
  useToastActions: () => ({ pushToast: vi.fn(), dismissToast: vi.fn(), clearToasts: vi.fn() }),
}));

vi.mock("../components/AgentConfigForm", () => ({
  AgentConfigForm: (props: { sectionLayout?: string; afterIdentity?: ReactNode }) => (
    <div data-testid="form" data-layout={props.sectionLayout}>
      <div data-testid="form-identity">Identity</div>
      {props.afterIdentity}
      <div data-testid="form-full-runs">Full runs: engine and model</div>
      <div data-testid="form-limits">Daily limits and standing rules</div>
    </div>
  ),
}));

// The rich-text editor pulls in a sandbox bundle that jsdom cannot parse.
vi.mock("../components/MarkdownEditor", () => ({ MarkdownEditor: () => null }));

const quickAgentMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("../components/QuickAgentSection", async () => {
  const { useEffect } = await import("react");
  return {
    QuickAgentSection: () => {
      useEffect(() => {
        quickAgentMounts.count += 1;
      }, []);
      return <div data-testid="quick-agent">Quick agent</div>;
    },
  };
});
vi.mock("../components/QuickAgentMemorySection", () => ({
  QuickAgentMemorySection: () => <div data-testid="quick-agent-memory">Memory</div>,
}));
vi.mock("../components/MorningReportSection", () => ({
  MorningReportSection: () => <div data-testid="morning-report">Morning report</div>,
}));
vi.mock("../components/TrustPresetSection", () => ({
  TrustPresetSection: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="trust-preset" data-embedded={String(Boolean(embedded))}>Trust preset</div>
  ),
}));
vi.mock("../components/jobs/AgentJobSection", () => ({
  AgentJobSection: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="job-section" data-embedded={String(Boolean(embedded))}>Position</div>
  ),
}));

import { AgentConfigurePage } from "./AgentDetail";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    urlKey: "cody",
    companyId: "company-1",
    name: "Cody",
    role: "engineer",
    title: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: { canCreateAgents: false },
    access: { canAssignTasks: false, taskAssignSource: "none" },
    laneAEnabled: false,
    ...overrides,
  };
}

let roots: Root[] = [];

async function renderPage(agentOverrides: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const updatePermissions = { mutate: vi.fn(), isPending: false };
  const render = async (overrides: Record<string, unknown>) => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AgentConfigurePage
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            agent={makeAgent(overrides) as any}
            agentId="agent-1"
            companyId="company-1"
            onDirtyChange={vi.fn()}
            onSaveActionChange={vi.fn()}
            onCancelActionChange={vi.fn()}
            onSavingChange={vi.fn()}
            updatePermissions={updatePermissions}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await flushReact();
  };
  await render(agentOverrides);
  return { container, updatePermissions, rerender: render };
}

function byTestId(container: HTMLElement, testId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`missing ${testId}`);
  return element;
}

function expectInOrder(container: HTMLElement, testIds: string[]) {
  const elements = testIds.map((id) => byTestId(container, id));
  for (let i = 1; i < elements.length; i += 1) {
    const follows = elements[i - 1]!.compareDocumentPosition(elements[i]!) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(Boolean(follows), `${testIds[i - 1]} before ${testIds[i]}`).toBe(true);
  }
}

describe("AgentConfigurePage layout", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockAgentsApi.listConfigRevisions.mockResolvedValue([
      {
        id: "rev-1-aaaaaaaa",
        createdAt: "2026-10-01T10:00:00.000Z",
        source: "patch",
        changedKeys: ["adapterConfig"],
      },
    ]);
    mockAgentsApi.listKeys.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount();
      });
    }
    roots = [];
    document.body.innerHTML = "";
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("puts the quick agent block right after Identity while quick agent is on", async () => {
    const { container } = await renderPage({ laneAEnabled: true });

    expect(byTestId(container, "form").getAttribute("data-layout")).toBe("settings");
    expectInOrder(container, [
      "form-identity",
      "quick-agent",
      "quick-agent-memory",
      "morning-report",
      "form-full-runs",
      "form-limits",
      "agent-config-trust",
      "agent-config-job",
      "agent-config-api-keys",
      "agent-config-history",
    ]);
  });

  it("keeps the quick agent switch under Identity while quick agent is off", async () => {
    const { container } = await renderPage({ laneAEnabled: false });

    expectInOrder(container, ["form-identity", "quick-agent", "form-full-runs", "form-limits", "agent-config-trust"]);
    expect(container.querySelector('[data-testid="quick-agent-memory"]')).toBeNull();
    expect(container.querySelector('[data-testid="morning-report"]')).toBeNull();
  });

  it("keeps the quick agent block mounted in place when its switch is flipped", async () => {
    quickAgentMounts.count = 0;
    const { container, rerender } = await renderPage({ laneAEnabled: false });
    const before = byTestId(container, "quick-agent");
    expect(quickAgentMounts.count).toBe(1);

    await rerender({ laneAEnabled: true });
    expect(byTestId(container, "quick-agent")).toBe(before);
    expect(quickAgentMounts.count).toBe(1);
    expectInOrder(container, ["form-identity", "quick-agent", "quick-agent-memory", "morning-report", "form-full-runs"]);

    await rerender({ laneAEnabled: false });
    expect(byTestId(container, "quick-agent")).toBe(before);
    expect(quickAgentMounts.count).toBe(1);
  });

  it("groups trust and the permission switches together, and the job block under its own heading", async () => {
    const { container, updatePermissions } = await renderPage();

    const trust = byTestId(container, "agent-config-trust");
    expect(trust.textContent).toContain("Trust and permissions");
    expect(byTestId(trust, "trust-preset").getAttribute("data-embedded")).toBe("true");
    expect(trust.textContent).toContain("Can create new agents");
    expect(trust.textContent).toContain("Can create/import skills");
    expect(trust.textContent).toContain("Can assign tasks");

    const job = byTestId(container, "agent-config-job");
    expect(job.textContent).toContain("Job, tools and rights");
    expect(byTestId(job, "job-section").getAttribute("data-embedded")).toBe("true");

    // The permission switches still save the same way.
    const switches = trust.querySelectorAll<HTMLButtonElement>('button[role="switch"]');
    expect(switches.length).toBe(3);
    await act(async () => {
      switches[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(updatePermissions.mutate).toHaveBeenCalledWith({
      canCreateAgents: false,
      canCreateSkills: false,
      canAssignTasks: false,
    });
  });

  it("starts API keys and configuration history closed, with the history count as summary", async () => {
    const { container } = await renderPage();

    const keys = byTestId(container, "agent-config-api-keys");
    expect(keys.getAttribute("data-state")).toBe("closed");
    expect(keys.textContent).toContain("API keys");

    const history = byTestId(container, "agent-config-history");
    expect(history.getAttribute("data-state")).toBe("closed");
    expect(history.textContent).toContain("Configuration history");
    expect(history.textContent).toContain("1 saved version");
    // Closed content stays mounted: the restore button is there once opened.
    await act(async () => {
      history.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(history.getAttribute("data-state")).toBe("open");
    expect(Array.from(history.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Restore")).toBe(true);
    expect(container.textContent).not.toContain("Configuration Revisions");
  });
});
