// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { QuickAgentSection } from "./QuickAgentSection";

/**
 * The "Model hosts" setting on the quick-agent card (OpenRouter only): which
 * hosts the model may only use / never use, saved through the agent PATCH.
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
const mockModelDirectoryApi = vi.hoisted(() => ({ list: vi.fn(), getSettings: vi.fn(), openrouterHosts: vi.fn() }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/budgets", () => ({ budgetsApi: mockBudgetsApi }));
vi.mock("../api/modelDirectory", () => ({ modelDirectoryApi: mockModelDirectoryApi }));
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

const OPENROUTER = { laneAProvider: "openrouter", laneAModel: "mistralai/mistral-small-3.2-24b-instruct" };

describe("QuickAgentSection model hosts", () => {
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
    mockModelDirectoryApi.list.mockResolvedValue([]);
    mockModelDirectoryApi.getSettings.mockResolvedValue({
      localGpuVramGb: null,
      localBaseUrl: null,
      openrouterPreferredHosts: [],
      openrouterBlockedHosts: [],
    });
    // The live host list is not reachable unless a test says so: the typed fields still work.
    mockModelDirectoryApi.openrouterHosts.mockRejectedValue(new ApiError("Could not read the host list.", 502, null));
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

  const section = () => container.querySelector<HTMLElement>('[data-testid="quick-agent-model-hosts"]');
  const onlyInput = () => container.querySelector<HTMLInputElement>('[data-testid="model-hosts-only"]');
  const ignoreInput = () => container.querySelector<HTMLInputElement>('[data-testid="model-hosts-ignore"]');
  const saveButton = () => container.querySelector<HTMLButtonElement>('[data-testid="model-hosts-save"]');
  const problem = () => container.querySelector<HTMLElement>('[data-testid="model-hosts-problem"]');

  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();
  }

  async function clickSave() {
    await act(async () => {
      saveButton()!.click();
    });
    await flushReact();
  }

  it("shows the setting, with the plain-English help line, only for OpenRouter", async () => {
    const root = await render(agent(OPENROUTER));

    expect(section()).not.toBeNull();
    expect(section()!.textContent).toContain("Model hosts");
    expect(section()!.textContent).toContain("Use only these hosts");
    expect(section()!.textContent).toContain("Never use these hosts");
    expect(section()!.textContent).toContain(
      "OpenRouter can send the same model to different hosts, and not every host supports tools for every model.",
    );
    // No host is suggested as a default.
    expect(section()!.textContent!.toLowerCase()).not.toContain("deepinfra");
    expect(onlyInput()?.value).toBe("");
    expect(ignoreInput()?.value).toBe("");
    expect(saveButton()?.disabled).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("is not shown for Claude, OpenAI, Google or a local model", async () => {
    for (const laneAProvider of [null, "anthropic", "openai", "google", "local"]) {
      const root = await render(agent({ laneAProvider }));
      expect(section(), String(laneAProvider)).toBeNull();
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("saves the typed hosts, lower-cased and split on commas, through the agent PATCH", async () => {
    const root = await render(agent(OPENROUTER));

    await type(onlyInput()!, "DeepInfra, mistral");
    await type(ignoreInput()!, "venice");
    expect(saveButton()?.disabled).toBe(false);
    await clickSave();

    expect(mockAgentsApi.update).toHaveBeenCalledTimes(1);
    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      AGENT,
      { laneAProviderRouting: { only: ["deepinfra", "mistral"], ignore: ["venice"] } },
      COMPANY,
    );
    expect(problem()).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the saved hosts, and clearing both fields saves null (OpenRouter picks again)", async () => {
    const root = await render(
      agent({ ...OPENROUTER, laneAProviderRouting: { only: ["deepinfra"], ignore: ["venice"] } }),
    );
    expect(onlyInput()?.value).toBe("deepinfra");
    expect(ignoreInput()?.value).toBe("venice");

    await type(onlyInput()!, "");
    await type(ignoreInput()!, "");
    await clickSave();

    expect(mockAgentsApi.update).toHaveBeenCalledWith(AGENT, { laneAProviderRouting: null }, COMPANY);

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps a stored try-first order and fallback choice when only the host lists change", async () => {
    const root = await render(
      agent({ ...OPENROUTER, laneAProviderRouting: { order: ["deepinfra", "mistral"], allowFallbacks: false } }),
    );

    await type(onlyInput()!, "deepinfra");
    await clickSave();

    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      AGENT,
      { laneAProviderRouting: { only: ["deepinfra"], order: ["deepinfra", "mistral"], allowFallbacks: false } },
      COMPANY,
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the server's rejection next to the fields, not only in the card's own error line", async () => {
    // DUR-4353: Filip's host restrictions were saved three times and still
    // ended up null; this used to swallow the server's own 422 silently
    // (a code comment, not a message), so a rejected save looked identical
    // to a successful one unless the operator noticed the card's error line
    // far above this field.
    mockAgentsApi.update.mockRejectedValue(
      new ApiError("List at most 10 model hosts in each field.", 422, null),
    );
    const root = await render(agent(OPENROUTER));

    await type(onlyInput()!, "deepinfra");
    await clickSave();

    expect(problem()?.textContent).toContain("List at most 10 model hosts in each field.");
    // What was typed is kept, not wiped out by the failed save.
    expect(onlyInput()?.value).toBe("deepinfra");

    await act(async () => {
      root.unmount();
    });
  });

  it("says which entry is not a host name instead of saving it", async () => {
    const root = await render(agent(OPENROUTER));

    await type(onlyInput()!, "deepinfra, Deep Infra!");
    await clickSave();

    expect(mockAgentsApi.update).not.toHaveBeenCalled();
    expect(problem()?.textContent).toContain('"Infra!" is not a host name.');

    await act(async () => {
      root.unmount();
    });
  });

  const host = (slug: string, supportsTools: boolean) => ({
    slug,
    name: slug[0]!.toUpperCase() + slug.slice(1),
    quantization: "fp8",
    contextTokens: 131072,
    maxOutputTokens: null,
    priceInPerM: 0.1,
    priceOutPerM: 0.3,
    supportsTools,
    supportsToolChoice: supportsTools,
    supportsReasoning: false,
    supportsImages: true,
    status: "ok",
    uptimeLast30m: null,
  });

  it("shows the live hosts for the agent's model and saves a choice from the table", async () => {
    mockModelDirectoryApi.openrouterHosts.mockResolvedValue({
      model: OPENROUTER.laneAModel,
      fetchedAt: "2026-10-08T12:00:00.000Z",
      hosts: [host("mistral", true), host("venice", false)],
    });
    const root = await render(agent(OPENROUTER));
    expect(mockModelDirectoryApi.openrouterHosts).toHaveBeenCalledWith(COMPANY, OPENROUTER.laneAModel);
    expect(container.querySelector('[data-testid="openrouter-host-row-mistral"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="openrouter-host-no-tools-venice"]')?.textContent).toContain(
      "No tool support",
    );
    const select = container.querySelector<HTMLSelectElement>('[data-testid="openrouter-host-choice-venice"]')!;
    await act(async () => {
      select.value = "use";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    // Only a host without tools allowed: warned in plain words.
    expect(container.querySelector('[data-testid="openrouter-hosts-warning"]')?.textContent).toContain(
      "No host you allow supports tool calling for this model",
    );
    expect(onlyInput()?.value).toBe("venice");
    await clickSave();
    expect(mockAgentsApi.update).toHaveBeenCalledWith(AGENT, { laneAProviderRouting: { only: ["venice"] } }, COMPANY);
    await act(async () => {
      root.unmount();
    });
  });

  it("adds the company's blocked hosts on save unless the agent marks them Use", async () => {
    mockModelDirectoryApi.getSettings.mockResolvedValue({
      localGpuVramGb: null,
      localBaseUrl: null,
      openrouterPreferredHosts: [],
      openrouterBlockedHosts: ["venice"],
    });
    const root = await render(agent(OPENROUTER));
    // Nothing typed, but the company rule is pending: Save is offered with a plain hint.
    expect(saveButton()?.disabled).toBe(false);
    expect(section()!.textContent).toContain("Save to add the company's host rules");
    await clickSave();
    expect(mockAgentsApi.update).toHaveBeenLastCalledWith(AGENT, { laneAProviderRouting: { ignore: ["venice"] } }, COMPANY);

    await type(onlyInput()!, "venice");
    await clickSave();
    expect(mockAgentsApi.update).toHaveBeenLastCalledWith(AGENT, { laneAProviderRouting: { only: ["venice"] } }, COMPANY);
    await act(async () => {
      root.unmount();
    });
  });
});
