// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { QuickAgentSection } from "./QuickAgentSection";

/**
 * DUR-3997 slice 4: the readiness panel on the quick-agent card. What it must
 * not get wrong: the switch cannot be turned ON without a usable model and
 * key, it can always be turned OFF, and every line says what to do next.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SECRET = "33333333-3333-4333-8333-333333333333";

const mockAgentsApi = vi.hoisted(() => ({ update: vi.fn() }));
const mockBudgetsApi = vi.hoisted(() => ({ overview: vi.fn(), upsertPolicy: vi.fn() }));
const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockMcpApi = vi.hoisted(() => ({ listForAgent: vi.fn() }));
const mockDataApi = vi.hoisted(() => ({ listDatasetSources: vi.fn() }));
const mockServerKeyApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());

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

describe("QuickAgentSection readiness", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSecretsApi.list.mockResolvedValue([secret()]);
    mockBudgetsApi.overview.mockResolvedValue({ policies: [] });
    mockMcpApi.listForAgent.mockResolvedValue([
      { id: "t1", enabled: true },
      { id: "t2", enabled: false },
      { id: "t3", enabled: true },
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableBusinessData: false });
    mockServerKeyApi.get.mockRejectedValue(new ApiError("Instance admin access required", 403, null));
    mockDataApi.listDatasetSources.mockResolvedValue([]);
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

  const line = (id: string) => container.querySelector<HTMLElement>(`[data-testid="readiness-${id}"]`);
  const toggle = () => container.querySelector<HTMLButtonElement>('button[role="switch"]');

  it("is ready on Claude with Paperclip's own key, and the switch can be turned on", async () => {
    const root = await render(agent({ laneAInstructions: "You are the front desk." }));

    expect(line("model")?.dataset.state).toBe("ok");
    expect(line("model")?.textContent).toContain("Paperclip's own key");
    expect(line("tools")?.dataset.state).toBe("ok");
    expect(line("tools")?.textContent).toContain("2 tools ticked");
    expect(line("tools")?.querySelector("a")?.getAttribute("href")).toBe("/agents/front-desk/tools");
    expect(line("data")?.dataset.state).toBe("todo");
    expect(line("data")?.textContent).toContain("switched off");
    expect(line("instructions")?.dataset.state).toBe("ok");
    expect(toggle()?.disabled).toBe(false);
    expect(container.querySelector('[data-testid="quick-agent-switch-reason"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("blocks the switch on OpenAI with no key and says where to get one", async () => {
    const root = await render(agent({ laneAProvider: "openai" }));

    expect(line("model")?.dataset.state).toBe("blocked");
    expect(line("model")?.textContent).toContain("no key yet");
    expect(line("model")?.querySelector("a")?.getAttribute("href")).toBe("/company/settings/connections");
    expect(toggle()?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="quick-agent-switch-reason"]')?.textContent).toContain(
      "Cannot switch on yet",
    );
    expect(line("instructions")?.dataset.state).toBe("todo");
    expect(line("instructions")?.textContent).toContain("No instructions yet");

    await act(async () => {
      root.unmount();
    });
  });

  it("is ready with a bound company key and names it", async () => {
    const root = await render(agent({ laneAProvider: "openai", adapterConfig: boundToSecret }));

    expect(line("model")?.dataset.state).toBe("ok");
    expect(line("model")?.textContent).toContain('the company\'s key "OpenAI — all agents"');
    expect(line("model")?.textContent).toContain("tested and working");
    expect(toggle()?.disabled).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("blocks when the bound key was refused, but an agent that is already on can still be switched off", async () => {
    mockSecretsApi.list.mockResolvedValue([secret({ lastTestOk: false })]);
    const off = await render(agent({ laneAProvider: "openai", adapterConfig: boundToSecret }));
    expect(line("model")?.dataset.state).toBe("blocked");
    expect(line("model")?.textContent).toContain("refused the key");
    expect(toggle()?.disabled).toBe(true);
    await act(async () => {
      off.unmount();
    });

    const on = await render(agent({ laneAProvider: "openai", adapterConfig: boundToSecret, laneAEnabled: true }));
    expect(line("model")?.dataset.state).toBe("blocked");
    expect(toggle()?.disabled).toBe(false);
    await act(async () => {
      on.unmount();
    });
  });

  it("reports connected sales data when the feature is on, and says who can see it on a 403", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableBusinessData: true });
    mockDataApi.listDatasetSources.mockResolvedValue([
      { dataset: "sales", connectionId: "c1", grantedByUserId: null, grantedAt: "2026-09-22T00:00:00Z" },
    ]);
    const withSales = await render(agent());
    expect(line("data")?.dataset.state).toBe("ok");
    expect(line("data")?.textContent).toContain("Sales data is connected");
    await act(async () => {
      withSales.unmount();
    });

    mockDataApi.listDatasetSources.mockRejectedValue(new ApiError("Owner only", 403, null));
    const forbidden = await render(agent());
    expect(line("data")?.dataset.state).toBe("todo");
    expect(line("data")?.textContent).toContain("Only the company owner");
    await act(async () => {
      forbidden.unmount();
    });
  });

  it("blocks on Claude when an instance admin can see that Paperclip has no key of its own", async () => {
    mockServerKeyApi.get.mockResolvedValue({ configured: false, source: null, headline: "No key", hint: null });
    const root = await render(agent());

    expect(line("model")?.dataset.state).toBe("blocked");
    expect(line("model")?.textContent).toContain("no key of its own");
    expect(toggle()?.disabled).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});
