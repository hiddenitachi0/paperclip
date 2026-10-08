// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDirectoryEntry } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { QuickAgentSection } from "./QuickAgentSection";

/**
 * Model readiness in a quick agent's settings: each saved model in both
 * pickers says whether it is ready for THIS agent (Installed / Not installed
 * / Offline for a local model, Key set / Needs a key for a hosted one), the
 * checklist, "Refresh status", and "Check this setup" (a real call, stubbed
 * here) for the main model and each backup.
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
const mockModelDirectoryApi = vi.hoisted(() => ({ list: vi.fn(), health: vi.fn(), getSettings: vi.fn(), syncLocal: vi.fn() }));
const mockLaneAApi = vi.hoisted(() => ({ checkSetup: vi.fn() }));

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
vi.mock("../api/laneA", () => ({ laneAApi: mockLaneAApi }));
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

const LOCAL_URL = "http://office-pc:11434/v1";
const LOCAL_ENTRY: ModelDirectoryEntry = {
  ...ENTRY,
  id: "44444444-4444-4444-8444-444444444444",
  name: "Qwen at the office",
  provider: "local",
  model: "qwen3:14b",
  baseUrl: LOCAL_URL,
  providerRouting: null,
  defaultThinking: null,
};
const MISSING_ENTRY: ModelDirectoryEntry = { ...LOCAL_ENTRY, id: "66666666-6666-4666-8666-666666666666", name: "Big one", model: "llama9:70b" };

const OPENROUTER_KEY = { type: "secret_ref", secretId: "77777777-7777-4777-8777-777777777777", version: "latest" };

function checkResult(overrides: Record<string, unknown> = {}) {
  return {
    target: "main",
    provider: "local",
    model: "qwen3:14b",
    ok: true,
    summary: "Everything works: it answered in 0.8 s and tool calling works.",
    steps: [
      { id: "reachable", ok: true, text: "Reached http://office-pc:11434/v1." },
      { id: "tools", ok: true, text: "Tool calling works." },
      { id: "cost", ok: null, text: "Cost: nothing (a local model)." },
    ],
    answerMs: 800,
    toolCalling: "works",
    thinkingAccepted: null,
    costCents: 0,
    costMicroUsd: 0,
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("QuickAgentSection model readiness", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSecretsApi.list.mockResolvedValue([{ id: OPENROUTER_KEY.secretId, name: "OpenRouter" }]);
    mockBudgetsApi.overview.mockResolvedValue({ policies: [] });
    mockMcpApi.listForAgent.mockResolvedValue([]);
    mockPluginsApi.agentToolGrants.mockResolvedValue({ grantedToolNames: [], unrestricted: true, availableTools: [] });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableBusinessData: false });
    mockServerKeyApi.get.mockRejectedValue(new ApiError("Instance admin access required", 403, null));
    mockDataApi.listDatasetSources.mockResolvedValue([]);
    mockUseCompanyRole.mockReturnValue(roleInfo());
    mockAgentsApi.update.mockResolvedValue({});
    mockModelDirectoryApi.list.mockResolvedValue([ENTRY, LOCAL_ENTRY, MISSING_ENTRY]);
    mockModelDirectoryApi.getSettings.mockResolvedValue({ localGpuVramGb: 16, localBaseUrl: LOCAL_URL, openrouterPreferredHosts: [], openrouterBlockedHosts: [] });
    mockModelDirectoryApi.health.mockResolvedValue({
      entries: [
        { entryId: LOCAL_ENTRY.id, applicable: true, status: "ready", message: "Ready", hint: null, runbookPath: null, lastCheckedAt: minutesAgo(5), outageStartedAt: null },
        { entryId: MISSING_ENTRY.id, applicable: true, status: "model_missing", message: "", hint: null, runbookPath: null, lastCheckedAt: minutesAgo(180), outageStartedAt: null },
      ],
      agents: [],
    });
    mockModelDirectoryApi.syncLocal.mockResolvedValue({ baseUrl: LOCAL_URL, checkedAt: new Date().toISOString(), installed: [], missingEntryIds: [], markedInstalledEntryIds: [] });
    mockLaneAApi.checkSetup.mockResolvedValue(checkResult());
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

  const q = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  it("says per saved model whether it is ready for this agent", async () => {
    const root = await render(agent({ laneAProvider: "local", laneAModel: "qwen3:14b", laneABaseUrl: LOCAL_URL }));
    const options = [...container.querySelectorAll<HTMLOptionElement>('[data-testid="quick-agent-saved-model-select"] option')].map((o) => o.textContent);
    expect(options).toContain("14B · Local (qwen3:14b) — Qwen at the office [Installed]");
    expect(options).toContain("Local (llama9:70b) — Big one [Not installed]");
    expect(options.some((o) => o?.includes("Mistral via OpenRouter [Needs a key]"))).toBe(true);
    // The model in use: installed, read 5 minutes ago.
    const status = q("quick-agent-current-model-status")!;
    expect(status.dataset.kind).toBe("installed");
    expect(status.textContent).toContain("last checked 5 minutes ago");
    await act(async () => root.unmount());
  });

  it("a hosted model with this agent's key says Key set", async () => {
    const root = await render(
      agent({ laneAProvider: "openrouter", laneAModel: "qwen/qwen3-14b", laneABaseUrl: null, adapterConfig: { laneA: { apiKey: OPENROUTER_KEY } } }),
    );
    const options = [...container.querySelectorAll<HTMLOptionElement>('[data-testid="quick-agent-saved-model-select"] option')].map((o) => o.textContent);
    expect(options.some((o) => o?.includes("Mistral via OpenRouter [Key set]"))).toBe(true);
    expect(q("quick-agent-model-checklist-key")!.dataset.status).toBe("ok");
    await act(async () => root.unmount());
  });

  it("shows the checklist and refreshes the model server's list on request", async () => {
    const root = await render(agent({ laneAProvider: "local", laneAModel: "qwen3:14b", laneABaseUrl: LOCAL_URL }));
    expect(q("quick-agent-model-checklist-installed")!.dataset.status).toBe("ok");
    expect(q("quick-agent-model-checklist-gpu")!.dataset.status).toBe("ok");
    expect(q("quick-agent-model-checklist-temperature")!.dataset.status).toBe("warn");
    await act(async () => q("quick-agent-refresh-status")!.click());
    expect(mockModelDirectoryApi.syncLocal).toHaveBeenCalledTimes(1);
    expect(mockModelDirectoryApi.syncLocal).toHaveBeenCalledWith(COMPANY, LOCAL_URL);
    expect(mockModelDirectoryApi.health.mock.calls.length).toBeGreaterThan(1);
    await act(async () => root.unmount());
  });

  it("Check this setup runs the real check for the main model and shows the result in plain words", async () => {
    const root = await render(agent({ laneAProvider: "local", laneAModel: "qwen3:14b", laneABaseUrl: LOCAL_URL }));
    await act(async () => q("quick-agent-check-main-button")!.click());
    expect(mockLaneAApi.checkSetup).toHaveBeenCalledWith(AGENT, { companyId: COMPANY, target: "main" });
    const result = q("quick-agent-check-main-result")!;
    expect(result.dataset.ok).toBe("true");
    expect(result.textContent).toContain("Everything works");
    expect(result.textContent).toContain("Tool calling works.");
    // The checklist now knows the last real check.
    expect(q("quick-agent-model-checklist-last_check")!.dataset.status).toBe("ok");
    expect(q("quick-agent-model-checklist-tools")!.textContent).toContain("Worked in the last real check");
    await act(async () => root.unmount());
  });

  it("only an owner or admin can run the real check", async () => {
    mockUseCompanyRole.mockReturnValue({ ...roleInfo(), role: "operator", canManageConnections: false });
    const root = await render(agent({ laneAProvider: "local", laneAModel: "qwen3:14b", laneABaseUrl: LOCAL_URL }));
    await act(async () => q("quick-agent-check-main-button")!.click());
    expect(mockLaneAApi.checkSetup).not.toHaveBeenCalled();
    expect(q("quick-agent-check-main-note")!.textContent).toMatch(/Only a company owner or admin/);
    await act(async () => root.unmount());
  });

  it("a saved backup gets the instant settings line, then the real check for that backup", async () => {
    mockLaneAApi.checkSetup.mockResolvedValue(
      checkResult({ target: { backupId: "bk_or" }, provider: "openrouter", ok: false, toolCalling: "not_supported", summary: "It answers, but tool calling does not work with it." }),
    );
    const root = await render(
      agent({
        laneAProvider: "local",
        laneAModel: "qwen3:14b",
        laneABaseUrl: LOCAL_URL,
        adapterConfig: { laneA: { apiKeyByProvider: { openrouter: OPENROUTER_KEY } } },
        laneABackupModels: [{ id: "bk_or", provider: "openrouter", model: "qwen/qwen3-14b" }],
      }),
    );
    // The backup picker carries statuses too.
    const backupOptions = [...container.querySelectorAll<HTMLOptionElement>('[data-testid="backup-saved-model-0"] option')].map((o) => o.textContent);
    expect(backupOptions.some((o) => o?.includes("Mistral via OpenRouter [Key set]"))).toBe(true);
    expect(backupOptions).toContain("14B · Local (qwen3:14b) — Qwen at the office [Installed]");

    await act(async () => q("backup-check-0-button")!.click());
    expect(q("backup-check-0-precheck")!.textContent).toContain('Ready. It uses the agent\'s OpenRouter key "OpenRouter".');
    expect(mockLaneAApi.checkSetup).toHaveBeenCalledWith(AGENT, { companyId: COMPANY, target: { backupId: "bk_or" } });
    expect(q("backup-check-0-result")!.textContent).toContain("tool calling does not work");
    expect(q("backup-checklist-0-last_check")!.dataset.status).toBe("fail");
    await act(async () => root.unmount());
  });

  it("an unsaved backup is not checked for real until it is saved", async () => {
    const root = await render(agent({ laneAProvider: "local", laneAModel: "qwen3:14b", laneABaseUrl: LOCAL_URL }));
    await act(async () => q("backup-add")!.click());
    await act(async () => q("backup-check-0-button")!.click());
    expect(mockLaneAApi.checkSetup).not.toHaveBeenCalled();
    expect(q("backup-check-0-note")!.textContent).toMatch(/Save backups first/);
    await act(async () => root.unmount());
  });

  it("a server answer that is not OK (too soon) is shown as it came", async () => {
    mockLaneAApi.checkSetup.mockRejectedValue(new ApiError("Please wait 7 seconds before checking this agent again.", 429, null));
    const root = await render(agent({ laneAProvider: "local", laneAModel: "qwen3:14b", laneABaseUrl: LOCAL_URL }));
    await act(async () => q("quick-agent-check-main-button")!.click());
    expect(q("quick-agent-check-main-error")!.textContent).toBe("Please wait 7 seconds before checking this agent again.");
    await act(async () => root.unmount());
  });
});
