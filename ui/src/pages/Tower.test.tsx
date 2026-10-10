// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tower } from "./Tower";

const DUR = "11111111-1111-4111-8111-111111111111";
const NOR = "22222222-2222-4222-8222-222222222222";
const COMPANIES = [
  { id: DUR, name: "Durkan Agency", issuePrefix: "DUR", status: "active", brandColor: null },
  { id: NOR, name: "Nordstrand", issuePrefix: "NOR", status: "active", brandColor: "#4aa3df" },
];

const mocks = vi.hoisted(() => ({
  agents: { list: vi.fn() },
  heartbeats: { liveRunsForCompany: vi.fn() },
  costs: { byAgent: vi.fn() },
  issues: { create: vi.fn(), get: vi.fn() },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: COMPANIES,
    selectedCompanyId: DUR,
    selectedCompany: COMPANIES[0],
  }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../api/agents", () => ({ agentsApi: mocks.agents }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: mocks.heartbeats }));
vi.mock("../api/costs", () => ({ costsApi: mocks.costs }));
vi.mock("../api/issues", () => ({ issuesApi: mocks.issues }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, name: string, reportsTo: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  companyId: DUR,
  name,
  urlKey: name.toLowerCase().replace(/\s+/g, "-"),
  role: "engineer",
  title: null,
  status: "idle",
  reportsTo,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  persona: null,
  ...extra,
});

const DUR_AGENTS = [
  agent("ceo", "CEO", null, { role: "ceo" }),
  agent("lead", "Fork Lead", "ceo"),
  agent("backend", "Backend", "lead"),
  agent("frontend", "Frontend", "lead"),
  agent("old-cto", "Old CTO", "ceo", { status: "terminated" }),
];

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

describe("Tower page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.agents.list.mockResolvedValue(DUR_AGENTS);
    mocks.heartbeats.liveRunsForCompany.mockImplementation(async (companyId: string) =>
      companyId === DUR
        ? [
            { id: "run-1", status: "running", agentId: "backend", agentName: "Backend", issueId: "issue-9", currentStatusMessage: "Writing tests" },
            { id: "run-2", status: "queued", agentId: "frontend", agentName: "Frontend", issueId: null },
          ]
        : [],
    );
    mocks.costs.byAgent.mockResolvedValue([{ agentId: "backend", costCents: 1234 }]);
    mocks.issues.get.mockResolvedValue({ id: "issue-9", identifier: "DUR-9", title: "Fix the login bug" });
    mocks.issues.create.mockResolvedValue({ id: "new-issue", identifier: "DUR-10", title: "Ship it" });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function flush() {
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  async function render() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/DUR/tower"]}>
            <Routes>
              <Route path="/:companyPrefix/tower" element={<Tower />} />
            </Routes>
            <LocationProbe />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  const q = (sel: string) => container.querySelector(sel);

  async function click(el: Element | null) {
    expect(el).not.toBeNull();
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  it("shows one elevator floor per company the viewer belongs to", async () => {
    await render();
    expect(q('[data-testid="tower-floor-DUR"]')).not.toBeNull();
    expect(q('[data-testid="tower-floor-NOR"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid^="tower-floor-"]')).toHaveLength(2);
    // Only the running run counts as working on the DUR floor button.
    expect(q('[data-testid="tower-floor-DUR"]')!.getAttribute("aria-label")).toContain("1 working");
  });

  it("seats only the working agent at a desk and hides terminated agents", async () => {
    await render();
    expect(q('[data-testid="tower-agent-backend"]')!.getAttribute("data-place")).toBe("desk");
    // A queued run is not "working" yet.
    expect(q('[data-testid="tower-agent-frontend"]')!.getAttribute("data-place")).toBe("break");
    expect(q('[data-testid="tower-agent-ceo"]')!.getAttribute("data-place")).toBe("break");
    expect(q('[data-testid="tower-agent-old-cto"]')).toBeNull();
    // The lead manages people, so they get a room nested in the CEO's room.
    expect(q('[data-room="ceo"]')!.getAttribute("data-depth")).toBe("0");
    expect(q('[data-room="lead"]')!.getAttribute("data-depth")).toBe("1");
    expect(q('[data-office="lead"]')).not.toBeNull();
  });

  it("inspect panel shows status, current task and this month's spend", async () => {
    await render();
    await click(q('[data-testid="tower-agent-backend"]'));
    const panel = q('[data-testid="tower-panel"]')!;
    expect(panel.textContent).toContain("Working now");
    expect(panel.textContent).toContain("DUR-9");
    expect(panel.textContent).toContain("Fix the login bug");
    expect(panel.textContent).toContain("Writing tests");
    expect(q('[data-testid="tower-panel-spend"]')!.textContent).toBe("$12.34");
    expect(panel.textContent).toContain("Fork Lead");
    expect(mocks.costs.byAgent).toHaveBeenCalledWith(DUR, expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/));
  });

  it("new task creates a normal company issue assigned to that agent", async () => {
    await render();
    await click(q('[data-testid="tower-agent-frontend"]'));
    const taskTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "New task");
    await click(taskTab ?? null);

    const input = q("#tower-task-title") as HTMLInputElement;
    const textarea = q("#tower-task-description") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Ship it");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Before Friday");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = [...container.querySelectorAll("button")].find((b) => b.textContent === "Create task");
    await click(submit ?? null);

    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    expect(mocks.issues.create).toHaveBeenCalledWith(DUR, {
      title: "Ship it",
      description: "Before Friday",
      status: "todo",
      priority: "medium",
      assigneeAgentId: "frontend",
    });
    expect(container.textContent).toContain("Task created");
    expect(container.textContent).toContain("DUR-10");
  });

  it("explains a permission refusal in plain words", async () => {
    const { ApiError } = await import("../api/client");
    mocks.issues.create.mockRejectedValue(new ApiError("Forbidden", 403, null));
    await render();
    await click(q('[data-testid="tower-agent-ceo"]'));
    const taskTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "New task");
    await click(taskTab ?? null);
    const input = q("#tower-task-title") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Do a thing");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Create task") ?? null);
    expect(container.textContent).toContain("You don't have permission to give this agent a task.");
  });

  it("the elevator switches to another company's floor", async () => {
    await render();
    await click(q('[data-testid="tower-floor-NOR"]'));
    expect(q('[data-testid="location"]')!.textContent).toBe("/NOR/tower");
  });
});
