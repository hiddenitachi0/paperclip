// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { QuickAgentSection } from "./QuickAgentSection";
import { WebSearchSection } from "./WebSearchSection";

/**
 * "Can search the web" on the quick-agent card: off by default, saved through
 * the agent PATCH with the rest of adapterConfig.laneA kept, and it says so
 * plainly when the company has no Brave key yet. Plus the Connections card
 * that picks that key.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SECRET = "33333333-3333-4333-8333-333333333333";

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
  SecretBindingPicker: ({ label, onChange }: { label?: string; onChange: (next: { secretId: string } | null) => void }) => (
    <button type="button" data-testid={`picker-${label}`} onClick={() => onChange({ secretId: "55555555-5555-4555-8555-555555555555" })}>
      key picker
    </button>
  ),
}));
vi.mock("../hooks/useCompanyRole", () => ({ useCompanyRole: mockUseCompanyRole }));

function roleInfo(isInstanceAdmin: boolean) {
  return { role: "owner", isInstanceAdmin, localBoard: false, canManageConnections: true, isLoading: false };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function secret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: SECRET,
    companyId: COMPANY,
    key: "openai_api_key__all_agents",
    name: "OpenAI — all agents",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    kind: "openai_api_key",
    lastTestAt: new Date("2026-09-22T10:00:00Z"),
    lastTestOk: true,
    lastTestMessage: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-09-20T00:00:00Z"),
    updatedAt: new Date("2026-09-20T00:00:00Z"),
    ...overrides,
  };
}

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

const boundToSecret = { laneA: { apiKey: { type: "secret_ref", secretId: SECRET, version: "latest" } } };

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

const settings = (overrides: Record<string, unknown> = {}) => ({
  keySecretId: null,
  keySecretName: null,
  keySecretKind: null,
  keyStatus: "none",
  dailyCap: 100,
  usedToday: 12,
  ...overrides,
});

describe("Can search the web", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSecretsApi.list.mockResolvedValue([secret()]);
    mockBudgetsApi.overview.mockResolvedValue({ policies: [] });
    mockMcpApi.listForAgent.mockResolvedValue([]);
    mockPluginsApi.agentToolGrants.mockResolvedValue({ grantedToolNames: [], unrestricted: true, availableTools: [] });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableBusinessData: false });
    mockServerKeyApi.get.mockRejectedValue(new ApiError("Instance admin access required", 403, null));
    mockDataApi.listDatasetSources.mockResolvedValue([]);
    mockUseCompanyRole.mockReturnValue(roleInfo(false));
    mockAgentsApi.update.mockResolvedValue({});
    mockWebSearchApi.get.mockResolvedValue(settings());
    mockWebSearchApi.setKey.mockResolvedValue(settings({ keySecretId: "55555555-5555-4555-8555-555555555555", keySecretName: "Brave", keyStatus: "ok" }));
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

  const webSwitch = () => container.querySelector<HTMLButtonElement>('button[aria-label="Can search the web"]');

  it("is off by default, explains the price, and switching it on keeps the quick agent's key binding", async () => {
    const root = await render(<QuickAgentSection agent={agent({ adapterConfig: boundToSecret })} companyId={COMPANY} />);
    const section = container.querySelector('[data-testid="quick-agent-web-search"]');
    expect(webSwitch()?.getAttribute("aria-checked")).toBe("false");
    expect(section?.textContent).toContain("$5 per 1,000 searches");
    expect(section?.textContent).toContain("$5 of free credit every month");
    expect(section?.textContent).toContain("100 searches a day for the whole company");

    await act(async () => {
      webSwitch()!.click();
    });
    await flushReact();
    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      AGENT,
      { adapterConfig: { laneA: { apiKey: { type: "secret_ref", secretId: SECRET, version: "latest" }, webSearch: true } } },
      COMPANY,
    );
    await act(async () => {
      root.unmount();
    });
  });

  it("says plainly when it is on but the company has no Brave key yet, and links to Connections", async () => {
    const root = await render(<QuickAgentSection agent={agent({ adapterConfig: { laneA: { webSearch: true } } })} companyId={COMPANY} />);
    expect(webSwitch()?.getAttribute("aria-checked")).toBe("true");
    const note = container.querySelector('[data-testid="quick-agent-web-search-no-key"]');
    expect(note?.textContent).toContain("no usable Brave Search key yet");
    expect(note?.querySelector("a")?.getAttribute("href")).toBe("/company/settings/connections");
    expect(container.textContent).toContain("Searches today (whole company): 12 of 100.");
    await act(async () => {
      root.unmount();
    });
  });

  it("the Connections card shows usage, and an owner picks the key by id", async () => {
    const root = await render(<WebSearchSection companyId={COMPANY} readOnly={false} />);
    expect(container.querySelector('[data-testid="web-search-status"]')?.textContent).toContain("No key picked yet");
    expect(container.querySelector('[data-testid="web-search-usage"]')?.textContent).toContain("Searches today: 12 of 100.");
    expect(container.textContent).toContain("$5 per 1,000 searches");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="picker-Brave Search key"]')!.click();
    });
    await flushReact();
    expect(mockWebSearchApi.setKey).toHaveBeenCalledWith(COMPANY, "55555555-5555-4555-8555-555555555555");
    expect(container.querySelector('[data-testid="web-search-status"]')?.textContent).toContain('Using "Brave"');
    await act(async () => {
      root.unmount();
    });
  });

  it("puts a Brave key first in the list, also one saved as \"other\" under a Brave name", async () => {
    const { rankBraveSecret } = await import("./WebSearchSection");
    expect(rankBraveSecret(secret({ kind: "brave_search_api_key", name: "Key" }))).toBe(0);
    expect(rankBraveSecret(secret({ kind: "other", name: "Brave_Search_API" }))).toBe(1);
    expect(rankBraveSecret(secret())).toBe(2);
  });

  it("the Connections card is read-only for everyone but an owner or admin", async () => {
    const root = await render(<WebSearchSection companyId={COMPANY} readOnly />);
    expect(container.textContent).toContain("Only the company owner or an admin can pick the key.");
    expect(container.querySelector('[data-testid="picker-Brave Search key"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
