// @vitest-environment jsdom

/**
 * DUR-5237: the "Always use one folder per task" switch on the project page.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Project } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectProperties } from "./ProjectProperties";

const mockProjectsApi = vi.hoisted(() => ({
  checkGitHubToken: vi.fn(),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/goals", () => ({ goalsApi: { list: vi.fn(async () => []) } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn(async () => ({})) } }));
vi.mock("../api/secrets", () => ({ secretsApi: { list: vi.fn(async () => []), create: vi.fn() } }));
vi.mock("../api/environments", () => ({ environmentsApi: { list: vi.fn(async () => []) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "co-1" }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("./PathInstructionsModal", () => ({ ChoosePathButton: () => null }));
vi.mock("./environment-variables-editor", () => ({ EnvironmentVariablesEditor: () => null }));
vi.mock("./InlineEditor", () => ({ InlineEditor: ({ value }: { value: string }) => <p>{value}</p> }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function render(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return container;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buildProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    companyId: "co-1",
    urlKey: "proj-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Dashboard",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: null,
    icon: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    deployPolicy: null,
    deployTransport: "git_push",
    codebase: {
      workspaceId: "ws-1",
      repoUrl: "https://github.com/acme/dashboard",
      repoRef: null,
      defaultRef: null,
      repoName: "acme/dashboard",
      localFolder: null,
      managedFolder: "/tmp/dashboard",
      effectiveLocalFolder: "/tmp/dashboard",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  } as Project;
}

function isolationToggle(el: HTMLElement) {
  const label = Array.from(el.querySelectorAll("span")).find((node) => node.textContent === "Always use one folder per task");
  const row = label?.closest(".flex.items-center.justify-between");
  return row?.querySelector('[role="switch"]') as HTMLButtonElement | null;
}

describe("ProjectProperties one folder per task switch", () => {
  beforeEach(() => {
    mockAgentsApi.list.mockReset();
    mockAgentsApi.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it("shows the switch with the plain explanation, off by default, and turns it on", async () => {
    const onFieldUpdate = vi.fn(async () => {});
    const el = await render(<ProjectProperties project={buildProject()} onFieldUpdate={onFieldUpdate} />);
    await flush();

    expect(el.textContent).toContain(
      "Every task gets its own copy of the code and its own branch, so agents never change each other's files.",
    );
    const toggle = isolationToggle(el);
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle!.click();
    });
    expect(onFieldUpdate).toHaveBeenCalledWith(
      "execution_workspace_require_isolation",
      { executionWorkspacePolicy: expect.objectContaining({ requireIsolation: true }) },
    );
  });

  it("reads the saved value and turns it off while keeping the rest of the policy", async () => {
    const onFieldUpdate = vi.fn(async () => {});
    const el = await render(
      <ProjectProperties
        project={buildProject({
          executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace", requireIsolation: true },
        })}
        onFieldUpdate={onFieldUpdate}
      />,
    );
    await flush();

    const toggle = isolationToggle(el);
    expect(toggle!.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      toggle!.click();
    });
    expect(onFieldUpdate).toHaveBeenCalledWith("execution_workspace_require_isolation", {
      executionWorkspacePolicy: expect.objectContaining({
        enabled: true,
        defaultMode: "isolated_workspace",
        requireIsolation: false,
      }),
    });
  });
});
