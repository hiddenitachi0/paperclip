// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ProjectDeployHistoryCard, ProjectDeployHistoryCardView } from "./ProjectDeployHistoryCard";

const mockApprovalsApi = vi.hoisted(() => ({ create: vi.fn() }));
const mockDeployRunnerApi = vi.hoisted(() => ({ projectDeployHistory: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
vi.mock("../api/deployRunner", () => ({ deployRunnerApi: mockDeployRunnerApi }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const current = { commit: "bbbbbbbbbbbb", approvalId: "approval-current", deployedAt: "2026-09-02T10:00:00Z" };
const previous = { commit: "aaaaaaaaaaaa", approvalId: "approval-previous", deployedAt: "2026-09-01T10:00:00Z" };

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function render(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  return container;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ProjectDeployHistoryCard", () => {
  beforeEach(() => {
    mockApprovalsApi.create.mockReset();
    mockDeployRunnerApi.projectDeployHistory.mockReset();
    mockPushToast.mockReset();
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it("renders nothing for a project without a deploy policy", async () => {
    const el = await render(<ProjectDeployHistoryCard companyId="co-1" projectId="proj-1" deployPolicy={null} />);
    expect(el.querySelector('[data-testid="project-deploy-history"]')).toBeNull();
    expect(mockDeployRunnerApi.projectDeployHistory).not.toHaveBeenCalled();
  });

  it("shows the live and previous versions from the deploy log", async () => {
    mockDeployRunnerApi.projectDeployHistory.mockResolvedValue({ current, previous });
    const el = await render(
      <ProjectDeployHistoryCard
        companyId="co-1"
        projectId="proj-1"
        deployPolicy={{
          enabled: true,
          requestingAgentId: null,
          workspaceId: "ws-1",
          deployTargetPath: "/opt/app",
          deployKind: "custom",
          healthCheckUrl: "http://x/health",
          rollback: "git_previous",
        }}
      />,
    );
    await flush();
    expect(mockDeployRunnerApi.projectDeployHistory).toHaveBeenCalledWith("co-1", "proj-1");
    expect(el.querySelector('[data-testid="deploy-history-current"]')?.textContent).toContain("bbbbbbbb");
    expect(el.querySelector('[data-testid="deploy-history-previous"]')?.textContent).toContain("aaaaaaaa");
    expect(el.querySelector('[data-testid="deploy-history-rollback"]')?.textContent).toContain("Roll back to previous version");
  });

  it("files a rollback deploy approval for the previous commit after the operator confirms", async () => {
    mockApprovalsApi.create.mockResolvedValue({ id: "approval-new" });
    const confirm = vi.fn((_text: string) => true);
    const el = await render(
      <ProjectDeployHistoryCardView
        companyId="co-1"
        projectId="proj-1"
        workspaceId="ws-1"
        history={{ current, previous }}
        isLoading={false}
        error={null}
        confirm={confirm}
      />,
    );
    const button = el.querySelector('[data-testid="deploy-history-rollback"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    await flush();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toContain("Nothing changes yet");
    expect(mockApprovalsApi.create).toHaveBeenCalledTimes(1);
    const [companyId, input] = mockApprovalsApi.create.mock.calls[0] as [string, { type: string; payload: Record<string, unknown> }];
    expect(companyId).toBe("co-1");
    expect(input.type).toBe("request_board_approval");
    expect(input.payload).toMatchObject({
      kind: "deploy",
      projectId: "proj-1",
      workspaceId: "ws-1",
      commit: "aaaaaaaaaaaa",
      allowBackwardDeploy: true,
    });
    expect(input.payload.note).toContain("Approving moves production back to aaaaaaaa, the version that was live before bbbbbbbb");
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success", action: { label: "Open the card", href: "/approvals/approval-new" } }),
    );
  });

  it("files nothing when the operator cancels the confirmation", async () => {
    const el = await render(
      <ProjectDeployHistoryCardView
        companyId="co-1"
        projectId="proj-1"
        workspaceId="ws-1"
        history={{ current, previous }}
        isLoading={false}
        error={null}
        confirm={() => false}
      />,
    );
    const button = el.querySelector('[data-testid="deploy-history-rollback"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    await flush();
    expect(mockApprovalsApi.create).not.toHaveBeenCalled();
  });

  it("offers no rollback when only one version has ever been live", async () => {
    const el = await render(
      <ProjectDeployHistoryCardView
        companyId="co-1"
        projectId="proj-1"
        workspaceId="ws-1"
        history={{ current, previous: null }}
        isLoading={false}
        error={null}
      />,
    );
    expect(el.querySelector('[data-testid="deploy-history-rollback"]')).toBeNull();
    expect(el.textContent).toContain("No earlier version on record");
  });
});
