// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { QuickAgentSection } from "./QuickAgentSection";

/**
 * "Browser access" on the quick-agent card (DUR-4020): off by default, a
 * three-way dial saved through the same agent PATCH as "Can search the web",
 * keeping the rest of adapterConfig.laneA untouched.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const mockAgentsApi = vi.hoisted(() => ({ update: vi.fn() }));
const mockBudgetsApi = vi.hoisted(() => ({ overview: vi.fn(), upsertPolicy: vi.fn() }));
const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockMcpApi = vi.hoisted(() => ({ listForAgent: vi.fn() }));
const mockPluginsApi = vi.hoisted(() => ({ agentToolGrants: vi.fn() }));
const mockDataApi = vi.hoisted(() => ({ listDatasetSources: vi.fn() }));
const mockServerKeyApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockWebSearchApi = vi.hoisted(() => ({ get: vi.fn(), setKey: vi.fn() }));
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

describe("Browser access", () => {
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

  const select = () => container.querySelector<HTMLSelectElement>('[data-testid="quick-agent-browser-access-select"]');

  it("is off by default and uses plain-language labels, not internal names", async () => {
    const root = await render(<QuickAgentSection agent={agent()} companyId={COMPANY} />);
    expect(select()?.value).toBe("off");
    const options = Array.from(select()?.options ?? []).map((option) => option.textContent);
    expect(options).toEqual(["Off", "Can browse and fill forms", "Can browse, book, and pay"]);
    const section = container.querySelector('[data-testid="quick-agent-browser-access"]');
    expect(section?.textContent).not.toMatch(/laneA|adapterConfig|claude_local/i);
    expect(section?.textContent).toContain("This only applies when the agent does a full run");
    expect(section?.textContent).not.toContain("Lets this quick agent");
    await act(async () => {
      root.unmount();
    });
  });

  it("reads an existing level from adapterConfig.laneA.browserAccess", async () => {
    const root = await render(
      <QuickAgentSection agent={agent({ adapterConfig: { laneA: { browserAccess: "book_and_buy" } } })} companyId={COMPANY} />,
    );
    expect(select()?.value).toBe("book_and_buy");
    await act(async () => {
      root.unmount();
    });
  });

  it("raising the level PATCHes adapterConfig.laneA.browserAccess and keeps the rest of laneA", async () => {
    const root = await render(
      <QuickAgentSection agent={agent({ adapterConfig: { laneA: { webSearch: true } } })} companyId={COMPANY} />,
    );
    await act(async () => {
      select()!.value = "browse_and_forms";
      select()!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      AGENT,
      { adapterConfig: { laneA: { webSearch: true, browserAccess: "browse_and_forms" } } },
      COMPANY,
    );
    await act(async () => {
      root.unmount();
    });
  });
});
