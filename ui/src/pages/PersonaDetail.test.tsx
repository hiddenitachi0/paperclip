// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import type { Persona } from "../api/personas";
import { PersonaDetail } from "./PersonaDetail";

const mockPersonasApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  attachToAgent: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockApprovalsApi = vi.hoisted(() => ({ list: vi.fn(), approve: vi.fn(), reject: vi.fn() }));
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useParams: () => ({ personaId: "persona-1" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast }),
}));

vi.mock("../api/personas", () => ({ personasApi: mockPersonasApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
vi.mock("../api/assets", () => ({ assetsApi: { uploadImage: vi.fn() } }));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

// Publishing has its own queries and its own tests; the approval card only
// needs to prove which approvals reach this page.
vi.mock("../components/PersonaPublishingPanel", () => ({
  PersonaPublishingPanel: () => <div data-testid="publishing-panel" />,
}));
vi.mock("../components/ApprovalCard", () => ({
  ApprovalCard: ({ approval }: { approval: { id: string } }) => <div data-testid="approval-card">{approval.id}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const persona: Persona = {
  id: "persona-1",
  companyId: "company-1",
  displayName: "Maja",
  pronouns: "she/her",
  traits: "Curious, dry humour",
  backstory: "Grew up by the sea.",
  voice: "Short sentences.",
  avatarAssetId: null,
  handle: "maja",
  status: "active",
  publishingPaused: false,
  agentIds: ["agent-1"],
  agentId: "agent-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Sales agent 1",
    urlKey: "sales-agent-1",
    role: "general",
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

const agents: Agent[] = [
  makeAgent({
    id: "agent-1",
    name: "Sales agent 1",
    urlKey: "sales-agent-1",
    title: "Sales",
    personaId: "persona-1",
    limits: { dailyImageGenerations: 3 },
  }),
  makeAgent({ id: "agent-2", name: "Support agent", urlKey: "support-agent", personaId: null, laneAEnabled: true }),
  makeAgent({ id: "agent-3", name: "Other job", urlKey: "other-job", personaId: "persona-2" }),
];

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.trim() === text) ?? null;
}

describe("PersonaDetail (DUR-4000)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockPersonasApi.get.mockResolvedValue(persona);
    mockAgentsApi.list.mockResolvedValue(agents);
    mockApprovalsApi.list.mockResolvedValue([]);
    mockPersonasApi.attachToAgent.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PersonaDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("shows who they are, the jobs they hold with the job's picture limit, and a link to each job's Tools tab", async () => {
    await render();
    const text = container.textContent ?? "";

    expect(text).toContain("Maja");
    expect(text).toContain("she/her");
    expect(text).toContain("@maja");
    expect(text).toContain("Traits");
    expect(text).toContain("Curious, dry humour");
    expect(text).toContain("Who they are");
    expect(text).toContain("Grew up by the sea.");
    expect(text).toContain("How they write");
    expect(text).toContain("Short sentences.");
    // Never "Who she is" -- the persona's own pronouns are shown, nothing is assumed.
    expect(text).not.toContain("Who she is");
    expect(text).not.toContain("How she writes");

    expect(text).toContain("Jobs");
    expect(container.querySelector('a[href="/agents/sales-agent-1"]')?.textContent).toBe("Sales agent 1");
    expect(text).toContain("Up to 3 pictures a day");
    expect(container.querySelector('a[href="/agents/sales-agent-1/tools"]')).not.toBeNull();
    // Picture tools stay agent-level: no tools panel on the persona page.
    expect(text).not.toContain("Picture tools");
    expect(text).not.toContain("Daily picture limit");
    expect(container.querySelector('[data-testid="publishing-panel"]')).not.toBeNull();
  });

  it("attaches a job from the company's agents and detaches one from the list", async () => {
    await render();

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Attach a job"]');
    expect(select).not.toBeNull();
    const options = Array.from(select!.options).map((option) => option.textContent);
    // Already attached here, or attached to another persona: not offered.
    expect(options.join("|")).toContain("Support agent");
    expect(options.join("|")).not.toContain("Sales agent 1");
    expect(options.join("|")).not.toContain("Other job");

    const attach = buttonByText(container, "Attach");
    expect(attach?.disabled).toBe(true);

    await act(async () => {
      setSelectValue(select!, "agent-2");
    });
    await flushReact();
    expect(attach?.disabled).toBe(false);

    await act(async () => {
      attach!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(mockPersonasApi.attachToAgent).toHaveBeenCalledWith("agent-2", "persona-1");
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Job attached" }));

    const detach = container.querySelector<HTMLButtonElement>('button[aria-label="Detach Sales agent 1"]');
    expect(detach).not.toBeNull();
    await act(async () => {
      detach!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(mockPersonasApi.attachToAgent).toHaveBeenCalledWith("agent-1", null);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Job detached" }));
  });

  it("shows only approvals filed by the persona's attached jobs", async () => {
    mockApprovalsApi.list.mockResolvedValue([
      { id: "approval-mine", status: "pending", requestedByAgentId: "agent-1", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "approval-other", status: "pending", requestedByAgentId: "agent-2", createdAt: "2026-01-03T00:00:00.000Z" },
      { id: "approval-done", status: "approved", requestedByAgentId: "agent-1", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await render();

    const cards = Array.from(container.querySelectorAll('[data-testid="approval-card"]')).map((el) => el.textContent);
    expect(cards).toEqual(["approval-mine"]);
  });
});
