// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { QuickAgentSection } from "./QuickAgentSection";

/**
 * DUR-4353: a quick agent's free-form "Model" field (OpenRouter, a local
 * model) used to save only on an explicit click of its own "Save" button.
 * Filip switched this quick agent's provider to OpenRouter, typed a model
 * id, and it was never saved — laneAModel stayed null and every message
 * afterward silently became a full task (503 LANE_A_MODEL_MISSING). These
 * tests pin that the field now also saves on blur and on Enter, that a
 * failed save is shown right next to the field (not only in the card's own
 * far-away error line), and that a free-form provider with no model says so
 * plainly next to the field it needs filled in.
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
    key: "openrouter_api_key__all_agents",
    name: "OpenRouter — all agents",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    kind: "openrouter_api_key",
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
    laneAProvider: "openrouter",
    laneABaseUrl: null,
    laneATemperature: null,
    laneAProviderRouting: null,
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

describe("QuickAgentSection model field", () => {
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

  const modelInput = () => container.querySelector<HTMLInputElement>('input[placeholder="openai/gpt-4.1-mini"]');
  const missingNotice = () => container.querySelector<HTMLElement>('[data-testid="quick-agent-model-missing-notice"]');
  const statusText = () => container.querySelector<HTMLElement>('[data-testid="text-setting-status"]')?.textContent;

  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();
  }

  it("shows a plain notice that a model is required when the provider is free-form and none is set", async () => {
    const root = await render(agent());

    expect(missingNotice()).not.toBeNull();
    expect(missingNotice()!.textContent).toContain("Pick a model for OpenRouter");

    await act(async () => {
      root.unmount();
    });
  });

  it("has no notice once a model is set", async () => {
    const root = await render(agent({ laneAModel: "mistralai/mistral-small-3.2-24b-instruct" }));

    expect(missingNotice()).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("saves on blur, not only on an explicit Save click", async () => {
    const root = await render(agent());

    await type(modelInput()!, "mistralai/mistral-small-3.2-24b-instruct");
    expect(statusText()).toBe("Unsaved");
    expect(mockAgentsApi.update).not.toHaveBeenCalled();

    await act(async () => {
      modelInput()!.focus();
      modelInput()!.blur();
    });
    await flushReact();

    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      AGENT,
      { laneAModel: "mistralai/mistral-small-3.2-24b-instruct" },
      COMPANY,
    );
    expect(statusText()).toBe("Saved");

    await act(async () => {
      root.unmount();
    });
  });

  it("saves on Enter without needing a blur or a Save click", async () => {
    const root = await render(agent());

    await type(modelInput()!, "mistralai/mistral-small-3.2-24b-instruct");
    await act(async () => {
      modelInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      AGENT,
      { laneAModel: "mistralai/mistral-small-3.2-24b-instruct" },
      COMPANY,
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a failed save next to the field instead of only in the card's far-away error line", async () => {
    mockAgentsApi.update.mockRejectedValue(
      new ApiError("\"bad id\" does not look like a model id (letters, digits, dots, dashes, colons and slashes only).", 422, null),
    );
    const root = await render(agent());

    await type(modelInput()!, "bad id");
    await act(async () => {
      modelInput()!.focus();
      modelInput()!.blur();
    });
    await flushReact();

    expect(container.textContent).toContain("does not look like a model id");
    // The draft the operator typed is kept, not silently wiped.
    expect(modelInput()!.value).toBe("bad id");

    await act(async () => {
      root.unmount();
    });
  });
});
