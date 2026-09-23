// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { CompanyConnections, secretsForProvider } from "./CompanyConnections";

/**
 * DUR-3997 slice 4: the Connections page. What it must not get wrong:
 *  - every section is there (AI providers, data sources, messaging, all secrets);
 *  - a key shows under its provider with its last-test status, never its value;
 *  - "Add key" opens the existing dialog with the right kind already chosen;
 *  - Test calls the existing test route;
 *  - an operator or viewer sees status only: no Add key, no Test, and the
 *    messaging cards are told to hide their write actions.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const SECRET_VALUE = "sk-" + "n0tar3alk3y0000000000000000";

const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn(), test: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockServerKeyApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockUseCompanyRole = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const telegramProps = vi.hoisted(() => vi.fn());
const serviceTokenProps = vi.hoisted(() => vi.fn());
const dataSourcesProps = vi.hoisted(() => vi.fn());
const dialogProps = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY, selectedCompany: { id: COMPANY, name: "Nordstrand" } }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));
vi.mock("../hooks/useCompanyRole", () => ({ useCompanyRole: mockUseCompanyRole }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../api/instanceServerAnthropicKey", () => ({ instanceServerAnthropicKeyApi: mockServerKeyApi }));
vi.mock("../components/DataSourcesSection", () => ({
  DataSourcesSection: (props: { companyId: string }) => {
    dataSourcesProps(props);
    return <div data-testid="data-sources-stub">Data sources card</div>;
  },
}));
vi.mock("../components/TelegramBotsSection", () => ({
  TelegramBotsSection: (props: { companyId: string; readOnly?: boolean }) => {
    telegramProps(props);
    return <div>Telegram bots card</div>;
  },
}));
vi.mock("../components/ServiceTokensSection", () => ({
  ServiceTokensSection: (props: { companyId: string; readOnly?: boolean }) => {
    serviceTokenProps(props);
    return <div>Service tokens card</div>;
  },
}));
vi.mock("../components/AddIntegrationTokenDialog", () => ({
  AddIntegrationTokenDialog: (props: { open: boolean; initialKind: string | null; companyId: string }) => {
    dialogProps(props);
    return props.open ? <div data-testid="add-token-dialog">Dialog for {props.initialKind}</div> : null;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function secret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
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
    lastTestMessage: "OpenAI accepted the key.",
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

const OPENAI_KEY = secret();
const CLAUDE_KEY = secret({
  id: "aaaaaaaa-0000-4000-8000-000000000002",
  key: "anthropic_api_key__all_agents",
  name: "Claude — company key",
  kind: "anthropic_api_key",
  lastTestAt: new Date("2026-09-22T10:00:00Z"),
  lastTestOk: false,
  lastTestMessage: "Anthropic said: invalid x-api-key.",
});
const UNTAGGED = secret({
  id: "aaaaaaaa-0000-4000-8000-000000000003",
  key: "something_else",
  name: "Old token with no kind",
  kind: null,
  lastTestAt: null,
  lastTestOk: null,
  lastTestMessage: null,
});

function role(canManage: boolean) {
  return {
    role: canManage ? "owner" : "viewer",
    isInstanceAdmin: false,
    localBoard: false,
    canManageConnections: canManage,
    isLoading: false,
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

describe("CompanyConnections", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSecretsApi.list.mockResolvedValue([OPENAI_KEY, CLAUDE_KEY, UNTAGGED]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableBusinessData: true });
    mockServerKeyApi.get.mockRejectedValue(new ApiError("Instance admin access required", 403, null));
    mockUseCompanyRole.mockReturnValue(role(true));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyConnections />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  function buttons(label: string) {
    return Array.from(container.querySelectorAll("button")).filter(
      (element) => element.textContent?.trim() === label,
    );
  }

  it("groups the company's keys by provider using their kind tag", () => {
    expect(secretsForProvider([OPENAI_KEY, CLAUDE_KEY, UNTAGGED], "openai").map((s) => s.name)).toEqual([
      "OpenAI — all agents",
    ]);
    expect(secretsForProvider([OPENAI_KEY, CLAUDE_KEY, UNTAGGED], "anthropic").map((s) => s.name)).toEqual([
      "Claude — company key",
    ]);
    expect(secretsForProvider([OPENAI_KEY, CLAUDE_KEY, UNTAGGED], "google")).toEqual([]);
  });

  it("renders every section for an owner, with keys under their provider and never a value", async () => {
    const root = await render();
    const text = container.textContent ?? "";

    expect(text).toContain("Every key or password you add anywhere ends up in Secrets");
    for (const provider of ["Claude", "OpenAI", "Google", "OpenRouter", "Local model"]) {
      expect(text).toContain(provider);
    }
    const openaiCard = container.querySelector('[data-testid="provider-card-openai"]');
    expect(openaiCard?.textContent).toContain("OpenAI — all agents");
    expect(openaiCard?.textContent).toContain("Works");
    const claudeCard = container.querySelector('[data-testid="provider-card-anthropic"]');
    expect(claudeCard?.textContent).toContain("Claude — company key");
    expect(claudeCard?.textContent).toContain("Refused by the provider");
    expect(claudeCard?.textContent).toContain("Paperclip's own Claude key");
    expect(container.querySelector('a[href="/company/settings/instance/claude"]')).not.toBeNull();
    expect(text).not.toContain(SECRET_VALUE);
    expect(container.querySelector('[data-testid="provider-card-google"]')?.textContent).toContain(
      "No Google key saved for this company yet.",
    );

    expect(container.querySelector('[data-testid="data-sources-stub"]')).not.toBeNull();
    expect(dataSourcesProps).toHaveBeenCalledWith({ companyId: COMPANY });
    expect(text).toContain("Telegram bots card");
    expect(text).toContain("Service tokens card");
    expect(telegramProps).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY, readOnly: false }));
    expect(serviceTokenProps).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY, readOnly: false }));

    expect(text).toContain("3 secrets in this company");
    expect(text).toContain("1 of them has no kind yet");
    expect(container.querySelector('a[href="/company/settings/secrets"]')).not.toBeNull();
    expect(container.querySelector('a[href="/tools"]')).not.toBeNull();

    expect(buttons("Add key")).toHaveLength(5);
    expect(buttons("Test")).toHaveLength(2);
    expect(container.querySelector('[data-testid="connections-read-only-note"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("opens the existing add-token dialog with the card's kind already chosen", async () => {
    const root = await render();

    const openaiCard = container.querySelector('[data-testid="provider-card-openai"]');
    const addKey = Array.from(openaiCard?.querySelectorAll("button") ?? []).find(
      (element) => element.textContent?.trim() === "Add key",
    );
    await act(async () => {
      addKey?.click();
    });
    await flushReact();

    expect(container.querySelector('[data-testid="add-token-dialog"]')?.textContent).toContain(
      "Dialog for openai_api_key",
    );
    expect(dialogProps).toHaveBeenCalledWith(
      expect.objectContaining({ open: true, initialKind: "openai_api_key", companyId: COMPANY }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("tests a key through the existing test route and reports the provider's answer", async () => {
    mockSecretsApi.test.mockResolvedValue({ ok: true, message: "OpenAI accepted the key.", secret: OPENAI_KEY });
    const root = await render();

    const openaiCard = container.querySelector('[data-testid="provider-card-openai"]');
    const test = Array.from(openaiCard?.querySelectorAll("button") ?? []).find(
      (element) => element.textContent?.trim() === "Test",
    );
    await act(async () => {
      test?.click();
    });
    await flushReact();

    expect(mockSecretsApi.test).toHaveBeenCalledWith(COMPANY, OPENAI_KEY.id);
    expect(mockPushToast).toHaveBeenCalledWith({ title: "OpenAI accepted the key.", tone: "success" });

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a viewer the status only: no Add key, no Test, messaging cards read-only", async () => {
    mockUseCompanyRole.mockReturnValue(role(false));
    const root = await render();
    const text = container.textContent ?? "";

    expect(buttons("Add key")).toHaveLength(0);
    expect(buttons("Test")).toHaveLength(0);
    expect(container.querySelector('[data-testid="connections-read-only-note"]')?.textContent).toContain(
      "Only the company owner or an admin can add or change them",
    );
    expect(telegramProps).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    expect(serviceTokenProps).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    expect(dialogProps).not.toHaveBeenCalled();
    // Status is still visible.
    expect(text).toContain("OpenAI — all agents");
    expect(text).toContain("Works");

    await act(async () => {
      root.unmount();
    });
  });

  it("explains where to switch business data on when the feature is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableBusinessData: false });
    const root = await render();

    expect(container.querySelector('[data-testid="data-sources-stub"]')).toBeNull();
    expect(container.querySelector('[data-testid="connections-data-sources"]')?.textContent).toContain(
      "Business data is switched off for this Paperclip",
    );

    await act(async () => {
      root.unmount();
    });
  });
});
