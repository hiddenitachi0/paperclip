// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { QuickAgentSection } from "./QuickAgentSection";

/**
 * DUR-4070: the two settings the ticket asks for beyond what already
 * existed -- "Trust level" (limited/standard/full) and "Who can chat with
 * this agent" (assigned company members, plus the owner who is always
 * allowed). Both save through the same board-only agent PATCH every other
 * quick-agent setting on this card uses.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";

const mockAgentsApi = vi.hoisted(() => ({ update: vi.fn() }));
const mockBudgetsApi = vi.hoisted(() => ({ overview: vi.fn(), upsertPolicy: vi.fn() }));
const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockMcpApi = vi.hoisted(() => ({ listForAgent: vi.fn() }));
const mockPluginsApi = vi.hoisted(() => ({ agentToolGrants: vi.fn() }));
const mockDataApi = vi.hoisted(() => ({ listDatasetSources: vi.fn() }));
const mockServerKeyApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockWebSearchApi = vi.hoisted(() => ({ get: vi.fn(), setKey: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ listMembers: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());
const mockUseCompanyRole = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/budgets", () => ({ budgetsApi: mockBudgetsApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../api/mcpToolLibrary", () => ({ mcpToolLibraryApi: mockMcpApi }));
vi.mock("../api/plugins", () => ({ pluginsApi: mockPluginsApi }));
vi.mock("../api/dataConnections", () => ({ dataConnectionsApi: mockDataApi }));
vi.mock("../api/instanceServerAnthropicKey", () => ({ instanceServerAnthropicKeyApi: mockServerKeyApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../api/webSearch", () => ({ webSearchApi: mockWebSearchApi }));
vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));
vi.mock("./SecretBindingPicker", () => ({
  SecretBindingPicker: () => <div />,
}));
vi.mock("../hooks/useCompanyRole", () => ({ useCompanyRole: mockUseCompanyRole }));

function roleInfo(isInstanceAdmin: boolean) {
  return { role: "owner", isInstanceAdmin, localBoard: false, canManageConnections: true, isLoading: false };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    urlKey: "front-desk",
    companyId: COMPANY,
    name: "Front desk",
    adapterConfig: {},
    laneAEnabled: false,
    laneAInstructions: null,
    laneAModel: null,
    laneAMaxOutputTokens: null,
    laneATransformDailyCallCap: null,
    laneAProvider: null,
    laneABaseUrl: null,
    laneATemperature: null,
    laneATrustLevel: null,
    laneAAssignedUserIds: [],
    ...overrides,
  };
}

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("Trust level and who can chat with this agent", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSecretsApi.list.mockResolvedValue([] as CompanySecret[]);
    mockBudgetsApi.overview.mockResolvedValue({ policies: [] });
    mockMcpApi.listForAgent.mockResolvedValue([]);
    mockPluginsApi.agentToolGrants.mockResolvedValue({ grantedToolNames: [], unrestricted: true, availableTools: [] });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableBusinessData: false });
    mockServerKeyApi.get.mockRejectedValue(new ApiError("Instance admin access required", 403, null));
    mockDataApi.listDatasetSources.mockResolvedValue([]);
    mockUseCompanyRole.mockReturnValue(roleInfo(false));
    mockAgentsApi.update.mockResolvedValue({});
    mockWebSearchApi.get.mockResolvedValue({
      keySecretId: null,
      keySecretName: null,
      keySecretKind: null,
      keyStatus: "none",
      dailyCap: 100,
      usedToday: 0,
    });
    mockAccessApi.listMembers.mockResolvedValue({
      members: [
        {
          id: "member-owner",
          companyId: COMPANY,
          principalType: "user",
          principalId: OWNER_ID,
          status: "active",
          membershipRole: "owner",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          user: { id: OWNER_ID, email: "filip@example.com", name: "Filip", image: null },
          grants: [],
        },
        {
          id: "member-regular",
          companyId: COMPANY,
          principalType: "user",
          principalId: MEMBER_ID,
          status: "active",
          membershipRole: "operator",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          user: { id: MEMBER_ID, email: "kari@example.com", name: "Kari", image: null },
          grants: [],
        },
      ],
      access: { currentUserRole: "owner", canManageMembers: true, canInviteUsers: true, canApproveJoinRequests: true },
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(node: React.ReactNode) {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
    await flushReact();
    return root;
  }

  const trustSelect = () =>
    container.querySelector<HTMLSelectElement>('[data-testid="quick-agent-trust-level-select"]');
  const assignedList = () => container.querySelector('[data-testid="quick-agent-assigned-people-list"]');
  const checkboxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));

  it("defaults the trust level to Full and uses plain-language labels", async () => {
    const root = await render(<QuickAgentSection agent={agent()} companyId={COMPANY} />);
    expect(trustSelect()?.value).toBe("full");
    const options = Array.from(trustSelect()?.options ?? []).map((option) => option.textContent);
    expect(options?.[0]).toMatch(/^Limited/);
    await act(async () => {
      root.unmount();
    });
  });

  it("changing the trust level PATCHes laneATrustLevel alone", async () => {
    const root = await render(<QuickAgentSection agent={agent()} companyId={COMPANY} />);
    await act(async () => {
      trustSelect()!.value = "limited";
      trustSelect()!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    expect(mockAgentsApi.update).toHaveBeenCalledWith(AGENT, { laneATrustLevel: "limited" }, COMPANY);
    await act(async () => {
      root.unmount();
    });
  });

  it("shows the owner as always-allowed and unticked members as not assigned", async () => {
    const root = await render(<QuickAgentSection agent={agent()} companyId={COMPANY} />);
    await flushReact();
    expect(assignedList()?.textContent).toContain("Filip");
    expect(assignedList()?.textContent).toContain("owner, always allowed");
    expect(assignedList()?.textContent).toContain("Kari");
    const ownerBox = checkboxes().find((box) => box.closest("li")?.textContent?.includes("Filip"));
    const memberBox = checkboxes().find((box) => box.closest("li")?.textContent?.includes("Kari"));
    expect(ownerBox?.checked).toBe(true);
    expect(ownerBox?.disabled).toBe(true);
    expect(memberBox?.checked).toBe(false);
    expect(memberBox?.disabled).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });

  it("ticking a member PATCHes laneAAssignedUserIds with that member added", async () => {
    const root = await render(<QuickAgentSection agent={agent()} companyId={COMPANY} />);
    await flushReact();
    const memberBox = checkboxes().find((box) => box.closest("li")?.textContent?.includes("Kari"))!;
    await act(async () => {
      memberBox.click();
    });
    await flushReact();
    expect(mockAgentsApi.update).toHaveBeenCalledWith(AGENT, { laneAAssignedUserIds: [MEMBER_ID] }, COMPANY);
    await act(async () => {
      root.unmount();
    });
  });

  it("unticking an already-assigned member PATCHes laneAAssignedUserIds with that member removed", async () => {
    const root = await render(
      <QuickAgentSection agent={agent({ laneAAssignedUserIds: [MEMBER_ID] })} companyId={COMPANY} />,
    );
    await flushReact();
    const memberBox = checkboxes().find((box) => box.closest("li")?.textContent?.includes("Kari"))!;
    expect(memberBox.checked).toBe(true);
    await act(async () => {
      memberBox.click();
    });
    await flushReact();
    expect(mockAgentsApi.update).toHaveBeenCalledWith(AGENT, { laneAAssignedUserIds: [] }, COMPANY);
    await act(async () => {
      root.unmount();
    });
  });
});
