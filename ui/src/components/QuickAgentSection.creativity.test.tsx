// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { QuickAgentSection } from "./QuickAgentSection";

/**
 * The "Creativity" control on the quick-agent card: plain-language steps,
 * saved the moment it is changed (no Save button to forget), and it says so.
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
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));
vi.mock("./SecretBindingPicker", () => ({
  SecretBindingPicker: () => <div>key picker</div>,
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

describe("QuickAgentSection creativity", () => {
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
    await flushReact();
    return root;
  }

  const select = () => container.querySelector<HTMLSelectElement>('[data-testid="creativity-select"]');
  const status = () => container.querySelector<HTMLElement>('[data-testid="creativity-status"]');

  async function choose(value: string) {
    await act(async () => {
      const el = select()!;
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
  }

  it("shows the plain-language steps and the one-line explanation, starting at Model default", async () => {
    const root = await render(agent({ laneAProvider: "openrouter", laneAModel: "mistralai/mistral-small-3.2-24b-instruct" }));

    expect(container.textContent).toContain("Creativity");
    expect(select()?.value).toBe("");
    expect(Array.from(select()!.options).map((o) => o.textContent)).toEqual([
      "Model default",
      "Precise (0.2)",
      "Balanced (0.6)",
      "Lively (0.9)",
      "Very lively (1.2)",
    ]);
    expect(container.textContent).toContain(
      "Higher makes replies more playful and varied; lower makes them more predictable. Work agents usually stay precise.",
    );
    expect(status()).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("saves the moment a step is picked, through the agent PATCH, and says it is saved", async () => {
    const root = await render(agent({ laneAProvider: "openrouter", laneAModel: "mistralai/mistral-small-3.2-24b-instruct" }));

    await choose("0.9");

    expect(mockAgentsApi.update).toHaveBeenCalledTimes(1);
    expect(mockAgentsApi.update).toHaveBeenCalledWith(AGENT, { laneATemperature: 0.9 }, COMPANY);
    expect(status()?.textContent).toBe("Saved");

    await act(async () => {
      root.unmount();
    });
  });

  it("goes back to the model's default by saving null", async () => {
    const root = await render(agent({ laneAProvider: "local", laneAModel: "llama3.1", laneATemperature: 1.2 }));
    expect(select()?.value).toBe("1.2");

    await choose("");

    expect(mockAgentsApi.update).toHaveBeenCalledWith(AGENT, { laneATemperature: null }, COMPANY);
    expect(status()?.textContent).toBe("Saved");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not claim it saved when the server refuses", async () => {
    mockAgentsApi.update.mockRejectedValue(new ApiError("Creativity must be between 0 and 1.5.", 400, null));
    const root = await render(agent({ laneAProvider: "local", laneAModel: "llama3.1" }));

    await choose("0.6");

    expect(status()).toBeNull();
    expect(container.textContent).toContain("Creativity must be between 0 and 1.5.");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a value set some other way as Custom, instead of pretending it is a step", async () => {
    const root = await render(agent({ laneAProvider: "local", laneAModel: "llama3.1", laneATemperature: 0.7 }));

    expect(select()?.value).toBe("0.7");
    expect(select()?.selectedOptions[0]?.textContent).toBe("Custom (0.7)");

    await act(async () => {
      root.unmount();
    });
  });

  it("says plainly when the picked model decides this for itself (Claude Sonnet 5, the default)", async () => {
    const root = await render(agent({ laneATemperature: 0.9 }));

    expect(container.querySelector('[data-testid="creativity-not-used"]')?.textContent).toContain(
      "decides this for itself",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("says Claude Haiku caps at 1 when Very lively is picked", async () => {
    const root = await render(agent({ laneAModel: "claude-haiku-4-5", laneATemperature: 1.2 }));

    expect(container.querySelector('[data-testid="creativity-not-used"]')).toBeNull();
    expect(container.querySelector('[data-testid="creativity-capped"]')?.textContent).toContain("no higher than 1");

    await act(async () => {
      root.unmount();
    });
  });
});
