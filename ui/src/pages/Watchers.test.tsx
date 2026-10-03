// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatcherSummary } from "@paperclipai/shared";
import { Watchers } from "./Watchers";
import { emptyWatcherDraft, watcherInputFromDraft } from "../components/WatcherFormDialog";

/**
 * The Watchers page:
 *   - lists each watcher with its rule in one sentence, the last price, and
 *     checks / alerts today;
 *   - an owner or admin gets the switch, "Test alert now", edit and delete,
 *     and a form whose rule builder starts at "moves 5% or more (up or down)
 *     within 24 hours" and says the rule back in a sentence;
 *   - anyone else sees the list and nothing to change it with;
 *   - a stock market asks for its key as a saved secret.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const MAJA = "22222222-2222-4222-8222-222222222222";
const WATCHER = "33333333-3333-4333-8333-333333333333";

const mockWatchersApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), testAlert: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), test: vi.fn() }));
const mockUseCompanyRole = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY, selectedCompany: { id: COMPANY, name: "Nordstrand" } }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));
vi.mock("../hooks/useCompanyRole", () => ({ useCompanyRole: mockUseCompanyRole }));
vi.mock("../api/watchers", () => ({ watchersApi: mockWatchersApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../components/SecretKindSelect", () => ({
  SecretKindSelect: ({ id }: { id?: string }) => <select id={id} data-testid="kind-select" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function role(canManage: boolean) {
  return { role: canManage ? "owner" : "operator", isInstanceAdmin: false, localBoard: false, canManageConnections: canManage, isLoading: false };
}

const bitcoin: WatcherSummary = {
  id: WATCHER,
  companyId: COMPANY,
  agentId: MAJA,
  agentName: "Maja",
  name: "Bitcoin swings",
  source: "crypto",
  symbol: "BTC",
  subject: "Bitcoin",
  currency: "USD",
  rule: { kind: "change", direction: "either", percent: 5, windowHours: 24 },
  ruleText: "Bitcoin moves 5% or more (up or down) within 24 hours",
  checkEveryMinutes: 15,
  cooldownMinutes: 360,
  enabled: true,
  withPicture: true,
  keySecretId: null,
  lastPrice: 84000,
  lastPriceAt: new Date().toISOString(),
  lastCheckAt: new Date().toISOString(),
  lastCheckOk: true,
  lastCheckMessage: null,
  lastAlertAt: null,
  nextCheckAt: new Date().toISOString(),
  checksToday: 42,
  alertsToday: 1,
  recentAlerts: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function setSelectValue(element: HTMLSelectElement, next: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(element, next);
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Watchers page", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockWatchersApi.list.mockResolvedValue([bitcoin]);
    mockWatchersApi.testAlert.mockResolvedValue({ id: "a", status: "composing" });
    mockWatchersApi.update.mockResolvedValue(bitcoin);
    mockWatchersApi.create.mockResolvedValue(bitcoin);
    mockAgentsApi.list.mockResolvedValue([
      { id: MAJA, name: "Maja", laneAEnabled: true, status: "idle" },
      { id: "44444444-4444-4444-8444-444444444444", name: "Builder", laneAEnabled: false, status: "idle" },
    ]);
    mockSecretsApi.list.mockResolvedValue([]);
    mockUseCompanyRole.mockReturnValue(role(true));
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
      root = null;
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const current = root;
    await act(async () => {
      current.render(
        <QueryClientProvider client={queryClient}>
          <Watchers />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  function buttonByText(label: string, scope: ParentNode = document): HTMLButtonElement | undefined {
    return Array.from(scope.querySelectorAll("button")).find((element) => element.textContent?.trim() === label) as
      | HTMLButtonElement
      | undefined;
  }

  it("lists a watcher in plain words with its price and today's counts", async () => {
    await render();
    const row = container.querySelector('[data-testid="watcher-row"]')!;
    expect(row.textContent).toContain("Bitcoin swings");
    expect(row.textContent).toContain("Bitcoin moves 5% or more (up or down) within 24 hours · Maja tells you");
    expect(row.textContent).toContain("Last price $84,000");
    expect(row.textContent).toContain("42 checks today");
    expect(row.textContent).toContain("1 alert today");
    expect(row.textContent).toContain("with picture");
  });

  it("an owner can send a test alert and switch a watcher off", async () => {
    await render();
    await act(async () => buttonByText("Test alert now")!.click());
    await flush();
    expect(mockWatchersApi.testAlert).toHaveBeenCalledWith(COMPANY, WATCHER);
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Test alert on its way" }));

    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => toggle.click());
    await flush();
    expect(mockWatchersApi.update).toHaveBeenCalledWith(COMPANY, WATCHER, { enabled: false });
  });

  it("someone who is not owner or admin sees the list and nothing to change it with", async () => {
    mockUseCompanyRole.mockReturnValue(role(false));
    await render();
    expect(container.textContent).toContain("Bitcoin swings");
    expect(buttonByText("Add watcher")).toBeUndefined();
    expect(buttonByText("Test alert now")).toBeUndefined();
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(container.textContent).toContain("Only a company owner or admin can change watchers.");
  });

  it("the form starts at 'moves 5% or more within 24 hours', offers only quick agents, and saves the rule", async () => {
    mockWatchersApi.list.mockResolvedValue([]);
    await render();
    await act(async () => buttonByText("Add watcher")!.click());
    await flush();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[data-testid="watcher-rule-sentence"]')!.textContent).toBe(
      "Tell me when Bitcoin moves 5% or more (up or down) within 24 hours.",
    );
    const agentOptions = Array.from(dialog.querySelectorAll<HTMLOptionElement>("#watcher-agent option")).map((o) => o.textContent);
    expect(agentOptions).toEqual(["Maja"]);

    setSelectValue(dialog.querySelector<HTMLSelectElement>('select[aria-label="Coin"]')!, "SOL");
    await flush();
    expect(dialog.querySelector('[data-testid="watcher-rule-sentence"]')!.textContent).toBe(
      "Tell me when Solana moves 5% or more (up or down) within 24 hours.",
    );
    await act(async () => buttonByText("Add watcher", dialog)!.click());
    await flush();
    expect(mockWatchersApi.create).toHaveBeenCalledWith(COMPANY, {
      name: "Solana moves 5% or more (up or down) within 24 hours",
      agentId: MAJA,
      source: "crypto",
      symbol: "SOL",
      rule: { kind: "change", direction: "either", percent: 5, windowHours: 24 },
      checkEveryMinutes: 15,
      cooldownMinutes: 360,
      enabled: true,
      withPicture: false,
      keySecretId: null,
    });
  });

  it("Oslo Børs asks for the EODHD key and only offers checks every 6 hours or less often", async () => {
    mockWatchersApi.list.mockResolvedValue([]);
    await render();
    await act(async () => buttonByText("Add watcher")!.click());
    await flush();
    const dialog = document.querySelector('[role="dialog"]')!;
    setSelectValue(dialog.querySelector<HTMLSelectElement>("#watcher-source")!, "oslo_stock");
    await flush();
    expect(dialog.textContent).toContain("EODHD key");
    expect(dialog.textContent).toContain("There is no free source for Oslo prices during the day");
    const every = Array.from(dialog.querySelectorAll<HTMLOptionElement>("#watcher-every option")).map((o) => Number(o.value));
    expect(Math.min(...every)).toBe(360);
    expect((dialog.querySelector<HTMLInputElement>('input[aria-label="Ticker"]')!).value).toBe("DNB");
    await act(async () => buttonByText("Add watcher", dialog)!.click());
    await flush();
    expect(mockWatchersApi.create).not.toHaveBeenCalled();
    expect(dialog.querySelector('[role="alert"]')!.textContent).toBe("Pick the secret that holds your EODHD key.");
  });
});

describe("the rule builder's request", () => {
  it("builds a level rule, and says plainly what is missing", () => {
    const draft = { ...emptyWatcherDraft(MAJA), ruleKind: "level" as const, price: "100 000" };
    expect(watcherInputFromDraft(draft)).toMatchObject({
      input: { rule: { kind: "level", direction: "above", price: 100000 }, name: "Bitcoin goes above $100,000" },
    });
    expect(watcherInputFromDraft({ ...draft, price: "" })).toEqual({ problem: "The price must be above zero." });
    expect(watcherInputFromDraft({ ...emptyWatcherDraft(""), name: "x" })).toEqual({
      problem: "Pick the quick agent that sends the alerts.",
    });
    expect(watcherInputFromDraft({ ...emptyWatcherDraft(MAJA), source: "us_stock", symbol: "aapl", keySecretId: null })).toEqual({
      problem: "Pick the secret that holds your Finnhub key.",
    });
  });

  it("builds a web-page price rule, and says plainly what is missing", () => {
    const draft = {
      ...emptyWatcherDraft(MAJA),
      source: "web_page" as const,
      symbol: "Competitor price",
      checkEveryMinutes: 60,
      webPageKind: "price" as const,
      webPageUrl: "https://example.com/product",
      webPageSelector: ".price",
      webPagePriceDirection: "below" as const,
      webPageTargetPrice: "499",
      webPageCurrency: "USD",
    };
    expect(watcherInputFromDraft(draft)).toMatchObject({
      input: {
        source: "web_page",
        rule: {
          kind: "price",
          url: "https://example.com/product",
          selector: ".price",
          direction: "below",
          targetPrice: 499,
          currency: "USD",
        },
        name: "The price at https://example.com/product drops to or below USD 499",
      },
    });
    expect(watcherInputFromDraft({ ...draft, webPageUrl: "not-a-url" })).toEqual({
      problem: "Use a full web address, starting with http:// or https://.",
    });
    expect(watcherInputFromDraft({ ...draft, webPageUrl: "http://localhost/product" })).toEqual({
      problem: "That address is not reachable from the server. Use the page's public address.",
    });
  });

  it("builds a web-page stock rule", () => {
    const draft = {
      ...emptyWatcherDraft(MAJA),
      source: "web_page" as const,
      symbol: "Back in stock",
      checkEveryMinutes: 60,
      webPageKind: "stock" as const,
      webPageUrl: "https://example.com/product",
      webPageSelector: ".buy-box",
      webPageInStockPhrase: "Add to cart",
      webPageAlertWhen: "becomes_in_stock" as const,
    };
    expect(watcherInputFromDraft(draft)).toMatchObject({
      input: {
        rule: {
          kind: "stock",
          url: "https://example.com/product",
          selector: ".buy-box",
          inStockPhrase: "Add to cart",
          alertWhen: "becomes_in_stock",
        },
      },
    });
  });
});
