// @vitest-environment jsdom

/**
 * The "Deployment" section and the GitHub "Check token" block on the project
 * page: the server's plain-language refusal is shown next to the settings and
 * the on/off switch never claims what the server refused; the token report
 * is rendered by scope name without ever showing the token.
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

function deployToggle(el: HTMLElement) {
  const label = Array.from(el.querySelectorAll("span")).find((node) => node.textContent === "Agents can request deploys of this project");
  const row = label?.closest(".flex.items-center.justify-between");
  return row?.querySelector('[role="switch"]') as HTMLButtonElement | null;
}

function buttonByText(el: HTMLElement, text: string) {
  return Array.from(el.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) as HTMLButtonElement | undefined;
}

describe("ProjectProperties deployment section", () => {
  beforeEach(() => {
    mockProjectsApi.checkGitHubToken.mockReset();
    mockAgentsApi.list.mockReset();
    mockAgentsApi.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it("shows the server's plain-language refusal and leaves the switch off when the settings are incomplete", async () => {
    const onFieldUpdate = vi.fn(async (field: string) => {
      if (field === "deploy_enabled") {
        throw new ApiError(
          "Deploy settings need attention: Choose which workspace to deploy from before letting agents request deploys. Fill in the folder on the server where this project is checked out, for example /root/my-project.",
          422,
          null,
        );
      }
    });
    const el = await render(<ProjectProperties project={buildProject()} onFieldUpdate={onFieldUpdate} />);
    await flush();

    const toggle = deployToggle(el);
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-checked")).toBe("false");
    expect(el.textContent).not.toContain("Deploy from workspace");

    await act(async () => {
      toggle!.click();
    });
    await flush();

    expect(onFieldUpdate).toHaveBeenCalledWith(
      "deploy_enabled",
      expect.objectContaining({ deployPolicy: expect.objectContaining({ enabled: true, workspaceId: "" }) }),
    );
    expect(deployToggle(el)!.getAttribute("aria-checked")).toBe("false");
    expect(el.textContent).toContain("Choose which workspace to deploy from before letting agents request deploys.");
    // The refusal opens the form so the operator can fill it in.
    expect(el.textContent).toContain("Deploy from workspace");
    expect(el.textContent).toContain("Deploy branch");
    expect(el.textContent).toContain("Folder on the server");
  });

  it("sends the whole draft, dropping empty optional fields, and reads back the saved policy", async () => {
    const onFieldUpdate = vi.fn(async () => {});
    const el = await render(
      <ProjectProperties
        project={buildProject({
          deployPolicy: {
            enabled: true,
            requestingAgentId: null,
            workspaceId: "22222222-2222-4222-8222-222222222222",
            deployTargetPath: "/root/dashboard",
            deployKind: "compose_recreate",
            deployServices: ["web"],
            healthCheckUrl: "https://dashboard.example.com/health",
            rollback: "git_previous",
            deployBranch: "main",
          },
        })}
        onFieldUpdate={onFieldUpdate}
      />,
    );
    await flush();

    expect(deployToggle(el)!.getAttribute("aria-checked")).toBe("true");
    const inputs = Array.from(el.querySelectorAll("input"));
    expect(inputs.some((input) => input.value === "main")).toBe(true);
    expect(el.textContent).toContain("Roll back automatically if the health check fails");

    const rollbackRow = Array.from(el.querySelectorAll("span"))
      .find((node) => node.textContent === "Roll back automatically if the health check fails")
      ?.closest(".flex.items-center.justify-between");
    const rollbackToggle = rollbackRow?.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(rollbackToggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      rollbackToggle.click();
    });
    await flush();

    expect(onFieldUpdate).toHaveBeenCalledWith("deploy_rollback", {
      deployPolicy: {
        enabled: true,
        requestingAgentId: null,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        deployTargetPath: "/root/dashboard",
        deployKind: "compose_recreate",
        deployServices: ["web"],
        healthCheckUrl: "https://dashboard.example.com/health",
        rollback: "none",
        deployBranch: "main",
      },
    });
  });

  it("names the GitHub scopes the project needs and renders the token report without the token", async () => {
    mockProjectsApi.checkGitHubToken.mockResolvedValue({
      tokenKind: "classic",
      login: "filip",
      repo: { owner: "acme", name: "dashboard", hostname: "github.com", private: true, defaultBranch: "main" },
      hasWorkflows: true,
      scopes: [
        { scope: "repo", why: "lets agents read the code and push.", required: true, status: "ok" },
        {
          scope: "workflow",
          why: "this repository has CI files under .github/workflows.",
          required: true,
          status: "missing",
          note: 'Edit the token on GitHub and tick the "workflow" scope, then paste it into GITHUB_TOKEN again.',
        },
      ],
      summary: 'The GitHub token (signed in to GitHub as filip) is missing: "workflow". Agents will get stuck until it is added.',
      ok: false,
      tokenSource: "the project's Env setting GITHUB_TOKEN",
    });
    const el = await render(<ProjectProperties project={buildProject()} onFieldUpdate={vi.fn(async () => {})} />);
    await flush();

    expect(el.textContent).toContain("GITHUB_TOKEN");
    expect(el.textContent).toMatch(/Create it with the\s*repo\s*scope/);
    expect(el.textContent).toMatch(/plus\s*workflow\s*if the repo has CI files/);

    const check = buttonByText(el, "Check token");
    expect(check).toBeDefined();
    await act(async () => {
      check!.click();
    });
    await flush();

    expect(mockProjectsApi.checkGitHubToken).toHaveBeenCalledWith("proj-1", "co-1");
    expect(el.textContent).toContain('is missing: "workflow"');
    expect(el.textContent).toContain("Checked the project's Env setting GITHUB_TOKEN.");
    expect(el.textContent).toContain('tick the "workflow" scope');
    // Once the repo is known to have CI files, the guidance says so outright.
    expect(el.textContent).toMatch(/tick\s*workflow\s*too: this repo has CI files/);
    expect(el.textContent).not.toContain("ghp_");
  });

  it("shows the server's explanation when the token cannot be checked", async () => {
    mockProjectsApi.checkGitHubToken.mockRejectedValue(
      new ApiError("No GitHub token is set for this project yet. Add one under Env as GITHUB_TOKEN, then check again.", 422, null),
    );
    const el = await render(<ProjectProperties project={buildProject()} onFieldUpdate={vi.fn(async () => {})} />);
    await flush();
    await act(async () => {
      buttonByText(el, "Check token")!.click();
    });
    await flush();
    expect(el.textContent).toContain("No GitHub token is set for this project yet.");
  });
});
