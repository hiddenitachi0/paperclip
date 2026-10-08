// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Persona } from "../api/personas";
import { Personas, describePersonaJobs } from "./Personas";

const mockPersonasApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  attachToAgent: vi.fn(),
}));
const pushToast = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigate,
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
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

vi.mock("../api/personas", () => ({
  personasApi: mockPersonasApi,
}));

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "persona-1",
    companyId: "company-1",
    displayName: "Maja",
    pronouns: null,
    traits: null,
    backstory: null,
    voice: null,
    avatarAssetId: null,
    handle: null,
    status: "active",
    publishingPaused: false,
    agentIds: [],
    agentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.trim() === text) ?? null;
}

describe("Personas page (DUR-4000)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockPersonasApi.create.mockResolvedValue(makePersona());
    mockAgentsApi.list.mockResolvedValue([
      { id: "a-1", status: "active" },
      { id: "a-2", status: "active" },
    ]);
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
          <Personas />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("New persona opens the persona page form instead of a dialog", async () => {
    mockPersonasApi.list.mockResolvedValue([makePersona()]);
    await render();
    expect(container.querySelector("#persona-name")).toBeNull();

    await act(async () => {
      buttonByText(container, "New persona")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(navigate).toHaveBeenCalledWith("/personas/new");
    expect(container.querySelector("#persona-name")).toBeNull();
    expect(mockPersonasApi.create).not.toHaveBeenCalled();
  });

  it("the empty list's action also opens the new persona page", async () => {
    mockPersonasApi.list.mockResolvedValue([]);
    await render();
    await act(async () => {
      buttonByText(container, "New persona")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigate).toHaveBeenCalledWith("/personas/new");
  });

  it("lists each persona with pronouns and how many jobs they hold, without she/her by default", async () => {
    mockPersonasApi.list.mockResolvedValue([
      makePersona({ id: "p-1", displayName: "Maja", pronouns: "he/him", handle: "maja", agentIds: ["a-1", "a-2"] }),
      makePersona({ id: "p-2", displayName: "Nova", agentIds: [] }),
    ]);
    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("Maja");
    expect(text).toContain("he/him");
    expect(text).toContain("@maja");
    expect(text).toContain("2 jobs");
    expect(text).toContain("Nova");
    expect(text).toContain("No job yet");
    expect(container.querySelector('a[href="/personas/p-1"]')).not.toBeNull();
    expect(text).not.toMatch(/\bshe\b|\bher\b/i);
  });

  it("describePersonaJobs counts jobs in plain words", () => {
    expect(describePersonaJobs([])).toBe("No job yet");
    expect(describePersonaJobs(["a"])).toBe("1 job");
    expect(describePersonaJobs(["a", "b", "c"])).toBe("3 jobs");
  });

  it("describePersonaJobs leaves terminated jobs out once the agents list is known", () => {
    const agentById = new Map([
      ["a", { status: "active" }],
      ["b", { status: "terminated" }],
      // "c" is absent: the company list never carries terminated agents.
    ]);
    expect(describePersonaJobs(["a", "b", "c"], agentById)).toBe("1 job");
    expect(describePersonaJobs(["b", "c"], agentById)).toBe("No job yet");
    // Before the list has loaded every id counts.
    expect(describePersonaJobs(["a", "b", "c"], null)).toBe("3 jobs");
  });

  it("counts only live jobs in the list rows", async () => {
    mockPersonasApi.list.mockResolvedValue([makePersona({ id: "p-1", displayName: "Maja", agentIds: ["a-1", "a-gone"] })]);
    await render();
    expect(container.textContent).toContain("1 job");
    expect(container.textContent).not.toContain("2 jobs");
  });
});
