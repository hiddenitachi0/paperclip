// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { QuickAgentSection } from "./QuickAgentSection";

/**
 * The "Thinking" control on the quick-agent card (DUR-4367): on / off / model
 * default, saved the moment it is changed, same rules as "Creativity".
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
    laneAThinking: null,
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

describe("QuickAgentSection thinking (DUR-4367)", () => {
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

  const select = () => container.querySelector<HTMLSelectElement>('[data-testid="thinking-select"]');
  const status = () => container.querySelector<HTMLElement>('[data-testid="thinking-status"]');

  async function choose(value: string) {
    await act(async () => {
      const el = select()!;
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
  }

  it("shows the Thinking control, defaulting to Model default", async () => {
    const root = await render(agent({ laneAProvider: "local", laneAModel: "huihui_ai/qwen3-abliterated:8b" }));

    expect(container.textContent).toContain("Thinking");
    expect(select()?.value).toBe("");
    expect(Array.from(select()!.options).map((o) => o.textContent)).toEqual(["Model default", "On", "Off"]);
    expect(status()).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("saves 'off' the moment it is picked, through the agent PATCH", async () => {
    const root = await render(agent({ laneAProvider: "local", laneAModel: "huihui_ai/qwen3-abliterated:8b" }));

    await choose("off");

    expect(mockAgentsApi.update).toHaveBeenCalledTimes(1);
    expect(mockAgentsApi.update).toHaveBeenCalledWith(AGENT, { laneAThinking: "off" }, COMPANY);
    expect(status()?.textContent).toBe("Saved");

    await act(async () => {
      root.unmount();
    });
  });

  it("goes back to model default by saving null", async () => {
    const root = await render(agent({ laneAProvider: "local", laneAModel: "llama3.1", laneAThinking: "off" }));
    expect(select()?.value).toBe("off");

    await choose("");

    expect(mockAgentsApi.update).toHaveBeenCalledWith(AGENT, { laneAThinking: null }, COMPANY);
    expect(status()?.textContent).toBe("Saved");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not claim it saved when the server refuses", async () => {
    mockAgentsApi.update.mockRejectedValue(new ApiError("Invalid thinking setting.", 400, null));
    const root = await render(agent({ laneAProvider: "local", laneAModel: "llama3.1" }));

    await choose("off");

    expect(status()).toBeNull();
    expect(container.textContent).toContain("Invalid thinking setting.");

    await act(async () => {
      root.unmount();
    });
  });

  it("says plainly when the picked model/provider does not take this setting", async () => {
    const root = await render(agent({ laneAProvider: "google", laneAModel: "gemini-2.5-flash", laneAThinking: "off" }));

    expect(container.querySelector('[data-testid="thinking-not-used"]')?.textContent).toContain(
      "does not take this setting",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("does not warn about the model when 'off' is not even picked", async () => {
    const root = await render(agent({ laneAProvider: "google", laneAModel: "gemini-2.5-flash" }));

    expect(container.querySelector('[data-testid="thinking-not-used"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
