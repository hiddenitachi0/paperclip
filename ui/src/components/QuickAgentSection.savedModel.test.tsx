// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDirectoryEntry } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { patchFromDirectoryEntry, QuickAgentSection } from "./QuickAgentSection";

/**
 * DUR-4420 slice: the "Saved model" dropdown in a quick agent's settings.
 * Picking a saved model setup must fill every field it carries and clear
 * whatever does not apply to the new provider (e.g. a local address left
 * over from a different setup), so nothing stale can linger.
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
const mockPushToast = vi.hoisted(() => vi.fn());
const mockUseCompanyRole = vi.hoisted(() => vi.fn());
const mockModelDirectoryApi = vi.hoisted(() => ({ list: vi.fn() }));

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
vi.mock("../api/modelDirectory", () => ({ modelDirectoryApi: mockModelDirectoryApi }));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));
vi.mock("./SecretBindingPicker", () => ({ SecretBindingPicker: () => <div>key picker</div> }));
vi.mock("../hooks/useCompanyRole", () => ({ useCompanyRole: mockUseCompanyRole }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function roleInfo() {
  return { role: "owner", isInstanceAdmin: false, localBoard: false, canManageConnections: true, isLoading: false };
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
    laneAProvider: "local",
    laneABaseUrl: "http://stale-pc:11434/v1",
    laneATemperature: null,
    laneAProviderRouting: null,
    ...overrides,
  };
}

const ENTRY: ModelDirectoryEntry = {
  id: "33333333-3333-4333-8333-333333333333",
  companyId: COMPANY,
  name: "Mistral via OpenRouter",
  provider: "openrouter",
  model: "mistralai/mistral-small-3.2-24b-instruct",
  baseUrl: null,
  providerRouting: { only: ["openai"], order: [], ignore: [], allowFallbacks: true },
  defaultThinking: "off",
  defaultTemperature: 0.7,
  defaultMaxOutputTokens: 1024,
  backupEntryIds: [],
  note: null,
  maker: null,
  baseModel: null,
  lane: null,
  availability: null,
  tags: [],
  specs: null,
  favorite: false,
  archivedAt: null,
  family: null,
  variant: null,
  ratings: [],
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

async function act(callback: () => void | Promise<void>) {
  await callback();
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("QuickAgentSection saved-model dropdown", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSecretsApi.list.mockResolvedValue([]);
    mockBudgetsApi.overview.mockResolvedValue({ policies: [] });
    mockMcpApi.listForAgent.mockResolvedValue([]);
    mockPluginsApi.agentToolGrants.mockResolvedValue({ grantedToolNames: [], unrestricted: true, availableTools: [] });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableBusinessData: false });
    mockServerKeyApi.get.mockRejectedValue(new ApiError("Instance admin access required", 403, null));
    mockDataApi.listDatasetSources.mockResolvedValue([]);
    mockUseCompanyRole.mockReturnValue(roleInfo());
    mockAgentsApi.update.mockResolvedValue({});
    mockModelDirectoryApi.list.mockResolvedValue([ENTRY]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(props: ReturnType<typeof agent>) {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <QuickAgentSection agent={props} companyId={COMPANY} />
        </QueryClientProvider>,
      );
    });
    return root;
  }

  it("lists saved models and hides itself when there are none", async () => {
    const root = await render(agent());
    const select = container.querySelector<HTMLSelectElement>('[data-testid="quick-agent-saved-model-select"]');
    expect(select).not.toBeNull();
    expect(select!.textContent).toContain("Mistral via OpenRouter");
    await act(async () => root.unmount());

    mockModelDirectoryApi.list.mockResolvedValue([]);
    const root2 = await render(agent());
    expect(container.querySelector('[data-testid="quick-agent-saved-model-select"]')).toBeNull();
    await act(async () => root2.unmount());
  });

  it("groups saved models by maker and model, and tells two setups of one model apart", async () => {
    const local = {
      ...ENTRY,
      id: "44444444-4444-4444-8444-444444444444",
      name: "Maja local",
      provider: "local" as const,
      model: "llama3.2:latest",
      baseUrl: "http://pc:11434/v1",
      providerRouting: null,
      maker: "Meta",
      family: "Llama 3.2",
      variant: "3B",
    };
    const cloud = {
      ...ENTRY,
      id: "55555555-5555-4555-8555-555555555555",
      name: "Llama 3.2 3B",
      model: "meta-llama/llama-3.2-3b-instruct",
      maker: "Meta",
      family: "Llama 3.2",
      variant: "3B",
    };
    mockModelDirectoryApi.list.mockResolvedValue([local, cloud]);
    const root = await render(agent());
    const select = container.querySelector<HTMLSelectElement>('[data-testid="quick-agent-saved-model-select"]')!;
    const groups = [...select.querySelectorAll("optgroup")];
    expect(groups.map((g) => g.label)).toEqual(["Meta · Llama 3.2"]);
    expect([...groups[0]!.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "3B · OpenRouter [Needs a key]",
      "3B · Local (llama3.2:latest) — Maja local [Unknown]",
    ]);
    await act(async () => root.unmount());
  });

  it("fills every field and clears the stale local address when picking an OpenRouter setup", async () => {
    const root = await render(agent());
    const select = container.querySelector<HTMLSelectElement>('[data-testid="quick-agent-saved-model-select"]')!;

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      nativeSetter.call(select, ENTRY.id);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      AGENT,
      {
        laneAProvider: "openrouter",
        laneAModel: "mistralai/mistral-small-3.2-24b-instruct",
        laneABaseUrl: null,
        laneAProviderRouting: ENTRY.providerRouting,
        laneAThinking: "off",
        laneATemperature: 0.7,
        laneAMaxOutputTokens: 1024,
      },
      COMPANY,
    );

    await act(async () => root.unmount());
  });
});

describe("patchFromDirectoryEntry", () => {
  it("keeps the address only for a local entry", () => {
    expect(patchFromDirectoryEntry({ ...ENTRY, provider: "local", baseUrl: "http://pc:11434/v1" }).laneABaseUrl).toBe(
      "http://pc:11434/v1",
    );
    expect(patchFromDirectoryEntry(ENTRY).laneABaseUrl).toBeNull();
  });
  it("keeps host routing only for an OpenRouter entry", () => {
    expect(patchFromDirectoryEntry(ENTRY).laneAProviderRouting).toEqual(ENTRY.providerRouting);
    expect(patchFromDirectoryEntry({ ...ENTRY, provider: "anthropic" }).laneAProviderRouting).toBeNull();
  });
});
