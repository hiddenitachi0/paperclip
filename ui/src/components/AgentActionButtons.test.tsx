// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentActionButtons } from "./AgentActionButtons";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockOpenNewIssue = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockAgentsApi = vi.hoisted(() => ({
  invoke: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  clearError: vi.fn(),
  approve: vi.fn(),
  terminate: vi.fn(),
  resetSession: vi.fn(),
  instructionsBundle: vi.fn(),
  instructionsFile: vi.fn(),
  create: vi.fn(),
  hire: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: mockOpenNewIssue }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha Agent",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    avatarAssetId: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("AgentActionButtons", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;
  let invalidateQueries: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    invalidateQueries = vi.spyOn(queryClient, "invalidateQueries") as unknown as ReturnType<typeof vi.fn>;
    mockAgentsApi.clearError.mockResolvedValue(makeAgent({ status: "idle" }));
    mockAgentsApi.pause.mockResolvedValue(makeAgent({ status: "paused" }));
    mockAgentsApi.resume.mockResolvedValue(makeAgent({ status: "idle" }));
    mockAgentsApi.invoke.mockResolvedValue({ id: "run-1" });
    mockAgentsApi.resetSession.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(agent: Agent) {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentActionButtons agent={agent} companyId="company-1" runLabel="Run Heartbeat" />
      </QueryClientProvider>,
    );
  }

  it("replaces the pause slot with Clear error for error agents", async () => {
    render(makeAgent({ status: "error" }));
    await flushReact();

    expect(container.textContent).toContain("Clear error");
    expect(container.textContent).not.toContain("Pause");
    expect(container.textContent).toContain("Run Heartbeat");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]')?.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("Reset Sessions");
  });

  it("calls clearError and refreshes agent-related queries", async () => {
    render(makeAgent({ status: "error" }));
    await flushReact();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Clear error and return agent to idle"]')?.click();
    });
    await flushReact();

    expect(mockAgentsApi.clearError).toHaveBeenCalledWith("agent-1", "company-1");
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "detail", "agent-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "detail", "alpha"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "runtime-state", "agent-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "task-sessions", "agent-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "company-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["live-runs", "company-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["heartbeats", "company-1", "agent-1"] });
  });

  it("keeps the normal pause action for non-error agents", async () => {
    render(makeAgent({ status: "active" }));
    await flushReact();

    expect(container.textContent).toContain("Pause");
    expect(container.textContent).not.toContain("Clear error");
  });

  // DUR-4001: on a phone the agents list has no room for a row of buttons,
  // so the whole cluster collapses into the one "..." menu -- same actions,
  // same mutations, plus whatever the caller appends (Join/Leave).
  it("puts every action in the one menu in the menu variant, and runs the same mutations from there", async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentActionButtons
          agent={makeAgent({ status: "error" })}
          companyId="company-1"
          runLabel="Run Heartbeat"
          variant="menu"
          menuExtra={<button type="button">Leave</button>}
        />
      </QueryClientProvider>,
    );
    await flushReact();

    // Nothing inline but the trigger.
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector('[aria-label="Open actions for Alpha Agent"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Clear error and return agent to idle"]')).toBeNull();
    expect(container.textContent).not.toContain("Run Heartbeat");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]')?.click();
    });
    await flushReact();

    const menu = document.body.querySelector('[data-testid="agent-actions-menu"]');
    expect(menu).not.toBeNull();
    const labels = Array.from(menu!.querySelectorAll("button")).map((btn) => btn.textContent?.trim());
    expect(labels).toEqual([
      "Assign Task",
      "Run Heartbeat",
      "Clear error",
      "Duplicate Agent",
      "Copy Agent ID",
      "Reset Sessions",
      "Terminate",
      "Leave",
    ]);

    const clear = Array.from(menu!.querySelectorAll("button")).find((btn) => btn.textContent?.trim() === "Clear error");
    await act(async () => {
      clear!.click();
    });
    await flushReact();

    expect(mockAgentsApi.clearError).toHaveBeenCalledWith("agent-1", "company-1");
    // Choosing an item closes the menu.
    expect(document.body.querySelector('[data-testid="agent-actions-menu"]')).toBeNull();
  });

  // DUR-4001: Terminate and Reset Sessions ask first, in both layouts. On a
  // phone the menu is the only way to act and Terminate sits one tap below
  // Copy Agent ID.
  it("asks before terminating or resetting sessions, and does nothing when the answer is no", async () => {
    const confirm = vi.spyOn(window, "confirm");
    mockAgentsApi.terminate.mockResolvedValue(makeAgent({ status: "terminated" }));

    for (const variant of ["buttons", "menu"] as const) {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentActionButtons agent={makeAgent()} companyId="company-1" variant={variant} />
        </QueryClientProvider>,
      );
      await flushReact();

      const openMenu = async () => {
        await act(async () => {
          container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]')?.click();
        });
        await flushReact();
      };
      const pick = async (label: string) => {
        await openMenu();
        const item = Array.from(document.body.querySelectorAll("button")).find((btn) => btn.textContent?.trim() === label);
        expect(item, `${label} in ${variant}`).toBeDefined();
        await act(async () => {
          item!.click();
        });
        await flushReact();
      };

      confirm.mockReturnValue(false);
      await pick("Terminate");
      expect(confirm).toHaveBeenLastCalledWith("Terminate Alpha Agent? This cannot be undone.");
      expect(mockAgentsApi.terminate).not.toHaveBeenCalled();
      await pick("Reset Sessions");
      expect(confirm).toHaveBeenLastCalledWith(
        "Reset the sessions of Alpha Agent? Its next run starts without the memory of earlier runs.",
      );
      expect(mockAgentsApi.resetSession).not.toHaveBeenCalled();

      confirm.mockReturnValue(true);
      await pick("Terminate");
      expect(mockAgentsApi.terminate).toHaveBeenCalledWith("agent-1", "company-1");
      await pick("Reset Sessions");
      expect(mockAgentsApi.resetSession).toHaveBeenCalledWith("agent-1", null, "company-1");

      await act(async () => {
        root!.unmount();
      });
      root = null;
      mockAgentsApi.terminate.mockClear();
      mockAgentsApi.resetSession.mockClear();
    }
    confirm.mockRestore();
  });
});
