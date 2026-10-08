// @vitest-environment jsdom

import { act as reactAct } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDirectoryEntry } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { QuickAgentSection } from "./QuickAgentSection";

/**
 * The quick agent block's layout: the model and its limits come first (so
 * the saved model and the model itself are not separated by other settings),
 * then backups, instructions, abilities, access and rewrite limits, each in
 * its own foldable group that says what is in it while folded.
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
const mockAccessApi = vi.hoisted(() => ({ listMembers: vi.fn() }));
const mockWebSearchApi = vi.hoisted(() => ({ get: vi.fn() }));
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
vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("../api/webSearch", () => ({ webSearchApi: mockWebSearchApi }));
vi.mock("../api/modelDirectory", () => ({ modelDirectoryApi: mockModelDirectoryApi }));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));
vi.mock("./SecretBindingPicker", () => ({ SecretBindingPicker: () => <div data-testid="key-picker">key picker</div> }));
vi.mock("../hooks/useCompanyRole", () => ({ useCompanyRole: mockUseCompanyRole }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRY: ModelDirectoryEntry = {
  id: "33333333-3333-4333-8333-333333333333",
  companyId: COMPANY,
  name: "Mistral via OpenRouter",
  provider: "openrouter",
  model: "mistralai/mistral-small-3.2-24b-instruct",
  baseUrl: null,
  providerRouting: null,
  defaultThinking: "off",
  defaultTemperature: 0.6,
  defaultMaxOutputTokens: 1024,
  backupEntryIds: [],
  note: null,
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    urlKey: "front-desk",
    companyId: COMPANY,
    name: "Front desk",
    adapterConfig: {},
    laneAEnabled: false,
    laneAInstructions: null,
    laneAModel: "mistralai/mistral-small-3.2-24b-instruct",
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
  await reactAct(async () => {
    await callback();
  });
  for (let i = 0; i < 3; i += 1) {
    await reactAct(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("QuickAgentSection layout", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSecretsApi.list.mockResolvedValue([]);
    mockBudgetsApi.overview.mockResolvedValue({ policies: [] });
    mockMcpApi.listForAgent.mockResolvedValue([]);
    mockPluginsApi.agentToolGrants.mockResolvedValue({ grantedToolNames: [], unrestricted: true, availableTools: [] });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableBusinessData: false });
    mockServerKeyApi.get.mockRejectedValue(new ApiError("Instance admin access required", 403, null));
    mockDataApi.listDatasetSources.mockResolvedValue([]);
    mockAccessApi.listMembers.mockResolvedValue({ members: [] });
    mockWebSearchApi.get.mockResolvedValue({ keyStatus: "ok", usedToday: 0, dailyCap: 100 });
    mockUseCompanyRole.mockReturnValue({
      role: "owner",
      isInstanceAdmin: false,
      localBoard: false,
      canManageConnections: true,
      isLoading: false,
    });
    mockAgentsApi.update.mockResolvedValue({});
    mockModelDirectoryApi.list.mockResolvedValue([ENTRY]);
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
      root = null;
    }
    container.remove();
    document.body.innerHTML = "";
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  async function render(props: ReturnType<typeof agent>) {
    root = createRoot(container);
    const current = root;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      current.render(
        <QueryClientProvider client={queryClient}>
          <QuickAgentSection agent={props} companyId={COMPANY} />
        </QueryClientProvider>,
      );
    });
  }

  const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const before = (a: Element | null, b: Element | null) => {
    if (!a || !b) throw new Error("element not found");
    return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  };
  /** The heading button of a foldable group. */
  const trigger = (group: HTMLElement | null) => {
    const button = group?.querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (!button) throw new Error("trigger not found");
    return button;
  };

  it("shows the groups in order, with the model and its limits first", async () => {
    await render(agent());
    expect(q("quick-agent-section")?.textContent).toContain("Quick agent (chat)");

    const order = [
      "quick-agent-overview",
      "quick-agent-model-group",
      "quick-agent-backups-group",
      "quick-agent-instructions-group",
      "quick-agent-abilities-group",
      "quick-agent-access-group",
      "quick-agent-rewrites-group",
    ].map((id) => q(id));
    for (let i = 0; i < order.length - 1; i += 1) expect(before(order[i]!, order[i + 1]!)).toBe(true);

    // "Is it ready?" sits in the always-visible top part.
    expect(q("quick-agent-overview")?.contains(q("quick-agent-readiness"))).toBe(true);
  });

  it("keeps the saved model, provider, key, model and its limits together, saved model first", async () => {
    await render(agent());
    const model = q("quick-agent-model-group")!;
    const savedModel = q("quick-agent-saved-model-select");
    expect(model.contains(savedModel)).toBe(true);
    const providerSelect = [...model.querySelectorAll("select")].find((el) =>
      el.textContent?.includes("Claude (Paperclip's own key unless you pick one)"),
    )!;
    const modelInput = model.querySelector('input[placeholder="openai/gpt-4.1-mini"]');
    expect(before(savedModel, providerSelect)).toBe(true);
    expect(before(providerSelect, q("key-picker"))).toBe(true);
    expect(before(q("key-picker"), modelInput)).toBe(true);
    expect(before(modelInput, q("quick-agent-model-hosts"))).toBe(true);
    expect(before(q("quick-agent-model-hosts"), q("creativity-select"))).toBe(true);
    expect(before(q("creativity-select"), q("thinking-select"))).toBe(true);
    expect(model.textContent).toContain("Longest answer (tokens)");

    expect(q("quick-agent-abilities-group")?.contains(q("quick-agent-web-search"))).toBe(true);
    expect(q("quick-agent-abilities-group")?.contains(q("quick-agent-browser-access"))).toBe(true);
    expect(q("quick-agent-access-group")?.contains(q("quick-agent-trust-level"))).toBe(true);
    expect(q("quick-agent-access-group")?.contains(q("quick-agent-assigned-people"))).toBe(true);
    expect(q("quick-agent-rewrites-group")?.textContent).toContain("How many texts per day");
    expect(q("quick-agent-rewrites-group")?.textContent).toContain("Maximum cost per month for rewriting");
  });

  it("folds Backup models away when there are none, and opens it when there are some", async () => {
    await render(agent());
    expect(q("quick-agent-backups-group")?.getAttribute("data-state")).toBe("closed");
    expect(q("quick-agent-backups-group")?.textContent).toContain("None yet");
    await act(async () => root!.unmount());

    root = null;
    await render(
      agent({ laneABackupModels: [{ id: "a", provider: "openrouter", model: ENTRY.model, directoryEntryId: ENTRY.id }] }),
    );
    expect(q("quick-agent-backups-group")?.getAttribute("data-state")).toBe("open");
  });

  it("offers the company's saved models on each backup", async () => {
    await render(agent({ laneABackupModels: [{ id: "a", provider: "openai", model: "gpt-4.1" }] }));
    const select = q("backup-saved-model-0") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(Array.from(select!.options).map((o) => o.textContent)).toEqual([
      "Custom (set it up below)",
      "Mistral via OpenRouter",
    ]);
  });

  it("says what is in a group while it is folded", async () => {
    await render(
      agent({
        laneABackupModels: [{ id: "a", provider: "openrouter", model: ENTRY.model, directoryEntryId: ENTRY.id }],
        laneAInstructions: "You are the front desk.",
      }),
    );
    for (const id of [
      "quick-agent-model-group",
      "quick-agent-backups-group",
      "quick-agent-instructions-group",
      "quick-agent-abilities-group",
      "quick-agent-access-group",
      "quick-agent-rewrites-group",
    ]) {
      await act(async () => trigger(q(id)).click());
      expect(q(id)?.getAttribute("data-state")).toBe("closed");
    }
    expect(q("quick-agent-model-group")?.textContent).toContain("OpenRouter · mistralai/mistral-small-3.2-24b-instruct");
    expect(q("quick-agent-backups-group")?.textContent).toContain("1 backup: Mistral via OpenRouter");
    expect(q("quick-agent-instructions-group")?.textContent).toContain("You are the front desk.");
    expect(q("quick-agent-abilities-group")?.textContent).toContain("No web search · Browser: off");
    expect(q("quick-agent-access-group")?.textContent).toContain("Trust: Full · only the owner can chat");
    expect(q("quick-agent-rewrites-group")?.textContent).toContain("Up to 2000 texts a day · no monthly limit");
  });

  it("keeps the on/off switch usable while the whole block is folded", async () => {
    await render(agent());
    const section = q("quick-agent-section")!;
    await act(async () => trigger(section).click());
    expect(section.getAttribute("data-state")).toBe("closed");
    expect(section.textContent).toContain("Off · OpenRouter · mistralai/mistral-small-3.2-24b-instruct");
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Quick agent on or off"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.closest("[hidden]")).toBeNull();
  });
});
