// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataConnectionSummary, DataReadEventSummary } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { DataSourcesSection, describeReadEvent, lastTwoClosedMonths } from "./DataSourcesSection";

/**
 * DUR-3972 slice S2, the "Datakilder" screen. What it must not get wrong:
 *  - the key is typed once and never shown again, only its last four characters;
 *  - Test shows the shop, currency, time zone, "no write access", how far back
 *    orders go, and the product types with how many products have none;
 *  - a missing read_all_orders is explained in plain Norwegian with what to add;
 *  - no Shopify permission name appears without its meaning next to it, and no
 *    internal id appears anywhere;
 *  - the trial calculation, the "Salg" tick and the lookup log work.
 */

const mockApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  trial: vi.fn(),
  listDatasetSources: vi.fn(),
  setDatasetSource: vi.fn(),
  listReads: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/dataConnections", () => ({ dataConnectionsApi: mockApi }));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";
const KEY = "shp" + "at_n0tar3alk3y0000000000000000abcd";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function connection(overrides: Partial<DataConnectionSummary> = {}): DataConnectionSummary {
  return {
    id: CONNECTION,
    companyId: COMPANY,
    kind: "shopify",
    name: "Shopify",
    shopDomain: "nordstrand.myshopify.com",
    apiVersion: "2026-07",
    credentialKind: "admin_access_token",
    credentialHint: "••••abcd",
    access: "read",
    status: "active",
    dailyLookupCap: 300,
    observed: {
      shopName: "Nordstrand Møbler",
      shopDomain: "nordstrand.myshopify.com",
      ianaTimezone: "Europe/Oslo",
      currencyCode: "NOK",
      grantedScopes: ["read_all_orders", "read_orders", "read_products"],
      earliestVisibleOrderAt: "2024-03-02T09:15:00Z",
      productTypeCoverage: {
        complete: true,
        productsScanned: 4,
        productsWithoutType: 1,
        types: [
          { productType: "Sofa", products: 2 },
          { productType: "Hjørnesofa", products: 1 },
        ],
      },
      checkedAt: "2026-09-21T08:00:00.000Z",
    },
    datasets: [],
    lastCheckAt: "2026-09-21T08:00:00.000Z",
    lastCheckOk: true,
    lastCheckError: null,
    createdAt: "2026-09-21T07:00:00.000Z",
    updatedAt: "2026-09-21T08:00:00.000Z",
    ...overrides,
  };
}

function readEvent(overrides: Partial<DataReadEventSummary> = {}): DataReadEventSummary {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    connectionId: CONNECTION,
    dataset: "sales",
    channel: "telegram",
    agentId: AGENT,
    agentName: "Salgsanalytikeren",
    userId: null,
    params: { action: "sales", periods: ["2026-08", "2026-07"], productTypes: ["Sofa"] },
    outcome: "ok",
    refusalCode: null,
    upstreamRequests: 4,
    durationMs: 900,
    createdAt: "2026-09-21T08:14:00.000Z",
    ...overrides,
  };
}

const pad2 = (value: number) => String(value).padStart(2, "0");
function localShort(iso: string) {
  const date = new Date(iso);
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function setInput(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("DataSourcesSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockApi.list.mockResolvedValue([connection()]);
    mockApi.listReads.mockResolvedValue([readEvent()]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DataSourcesSection companyId={COMPANY} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  function button(label: string) {
    return Array.from(container.querySelectorAll("button")).find((element) => element.textContent?.trim() === label);
  }

  it("connects a shop with a write-only key field that is emptied after saving", async () => {
    mockApi.list.mockResolvedValue([]);
    mockApi.create.mockResolvedValue(connection({ status: "draft", observed: null, lastCheckAt: null, lastCheckOk: null }));
    const root = await render();

    expect(container.textContent).toContain("Koble til Shopify");
    const kind = container.querySelector<HTMLSelectElement>("#data-new-kind")!;
    // Client credentials is the default (new Dev Dashboard apps); both key fields are password fields.
    expect(kind.value).toBe("client_credentials");
    for (const id of ["#data-new-client-id", "#data-new-client-secret"]) {
      const field = container.querySelector<HTMLInputElement>(id)!;
      expect(field.type).toBe("password");
      expect(field.value).toBe("");
    }

    await act(async () => setInput(kind, "admin_access_token"));
    const tokenField = container.querySelector<HTMLInputElement>("#data-new-token")!;
    expect(tokenField.type).toBe("password");
    expect(tokenField.value).toBe("");
    await act(async () => setInput(container.querySelector<HTMLInputElement>("#data-shop-domain")!, "nordstrand"));
    await act(async () => setInput(tokenField, KEY));
    await act(async () => button("Koble til")?.click());
    await flushReact();

    expect(mockApi.create).toHaveBeenCalledWith(COMPANY, {
      kind: "shopify",
      name: "Shopify",
      shopDomain: "nordstrand",
      credential: { kind: "admin_access_token", accessToken: KEY },
    });
    // After saving, the key is nowhere in the page, not even in a field.
    expect(container.innerHTML).not.toContain(KEY);
    const leftover = Array.from(container.querySelectorAll<HTMLInputElement>("input")).map((input) => input.value);
    expect(leftover).not.toContain(KEY);

    await act(async () => root.unmount());
  });

  it("shows what Test found: shop, NOK, Europe/Oslo, no write access, order history and product types", async () => {
    const root = await render();
    const text = container.textContent ?? "";

    expect(text).toContain("Datakilder");
    expect(text).toContain("Nøkkel ••••abcd");
    expect(text).toContain("Nordstrand Møbler");
    expect(text).toContain("NOK");
    expect(text).toContain("Europe/Oslo");
    expect(text).toContain("Ingen skrivetilgang");
    expect(text).toContain("Kan se ordre tilbake til 02.03.2024");
    expect(text).toContain("Produkttyper i butikken (2)");
    expect(text).toContain("Sofa");
    expect(text).toContain("Hjørnesofa");
    expect(text).toContain("1 av 4 produkter har ingen produkttype");
    expect(text).not.toContain("kan ikke regnes ut");

    await act(async () => root.unmount());
  });

  it("explains a missing read_all_orders in plain Norwegian, and flags a key that can write", async () => {
    mockApi.list.mockResolvedValue([
      connection({
        status: "error",
        lastCheckOk: false,
        lastCheckError: "Appen mangler tilgangen read_all_orders (lese alle ordre, ikke bare de siste 60 dagene).",
        observed: {
          ...connection().observed!,
          grantedScopes: ["read_orders", "read_products", "write_products"],
        },
      }),
    ]);
    const root = await render();
    const text = container.textContent ?? "";

    expect(text).toContain("Shopify viser bare ordre fra de siste 60 dagene");
    expect(text).toContain("«lese alle ordre, ikke bare de siste 60 dagene» (read_all_orders)");
    expect(text).toContain("Nøkkelen kan endre ting i butikken");
    expect(text).toContain("Testen fant problemer");

    await act(async () => root.unmount());
  });

  it("never shows a permission name without its meaning, and never an internal id", async () => {
    mockApi.list.mockResolvedValue([]);
    const empty = await render();
    const connectText = container.textContent ?? "";
    await act(async () => empty.unmount());

    container.innerHTML = "";
    mockApi.list.mockResolvedValue([connection({ observed: { ...connection().observed!, grantedScopes: ["read_orders", "read_products"] } })]);
    const root = await render();
    const settingsText = container.textContent ?? "";

    const meanings: Record<string, string> = {
      read_orders: "lese ordre",
      read_all_orders: "lese alle ordre, ikke bare de siste 60 dagene",
      read_products: "lese produkter",
    };
    for (const text of [connectText, settingsText]) {
      for (const [scope, meaning] of Object.entries(meanings)) {
        if (text.includes(scope)) expect(text, scope).toContain(meaning);
      }
      expect(text).not.toMatch(/write_[a-z_]+/);
      expect(text).not.toMatch(UUID_PATTERN);
    }
    expect(connectText).toContain("read_all_orders");

    await act(async () => root.unmount());
  });

  it("runs the trial calculation for the last two finished months and shows the answer card", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 21, 10, 14));
    expect(lastTwoClosedMonths()).toEqual(["2026-07", "2026-08"]);
    mockApi.trial.mockResolvedValue({
      ok: true,
      lookupId: "66666666-6666-4666-8666-666666666666",
      card: "Salg i antall enheter, alle produkter\n\nJuli 2026 (1.–31. juli 2026, avsluttet)\nSolgt: 4 stk",
      reconciliationNotes: ["august 2026, produkttypen Sofa: Shopifys salgslogg viser 2 returnerte stk, men refusjonene viser 1 stk."],
    });
    const root = await render();

    expect(container.querySelector<HTMLInputElement>(`#data-trial-first-${CONNECTION}`)!.value).toBe("2026-07");
    expect(container.querySelector<HTMLInputElement>(`#data-trial-second-${CONNECTION}`)!.value).toBe("2026-08");
    await act(async () => button("Regn ut")?.click());
    await flushReact();

    expect(mockApi.trial).toHaveBeenCalledWith(COMPANY, CONNECTION, { periods: ["2026-07", "2026-08"], groupBy: "product_type" });
    const card = container.querySelector('[data-testid="data-trial-card"]');
    expect(card?.textContent).toContain("Solgt: 4 stk");
    expect(container.textContent).toContain("Merknader til sammenligningen");
    expect(container.textContent).toContain("Net items sold by product type");

    await act(async () => root.unmount());
  });

  it("shows a refused trial as a plain sentence, with no numbers", async () => {
    mockApi.trial.mockResolvedValue({
      ok: false,
      lookupId: null,
      code: "before_visible_window",
      message: "Shopify viser bare ordre fra og med 1. juli 2026, så mai 2026 kan ikke regnes ut.",
    });
    const root = await render();
    await act(async () => button("Regn ut")?.click());
    await flushReact();
    expect(container.textContent).toContain("så mai 2026 kan ikke regnes ut");
    expect(container.querySelector('[data-testid="data-trial-card"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("does not offer the trial calculation before the connection has passed Test", async () => {
    mockApi.list.mockResolvedValue([connection({ status: "draft", observed: null, lastCheckAt: null, lastCheckOk: null })]);
    const root = await render();
    expect(button("Regn ut")?.disabled).toBe(true);
    expect(container.textContent).toContain("Trykk Test for å se hvilken butikk nøkkelen hører til");
    // Salg cannot be ticked either.
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Salg"]')!.disabled).toBe(true);
    await act(async () => root.unmount());
  });

  it("ticks Salg for this shop, and shows Lager as coming later", async () => {
    mockApi.setDatasetSource.mockResolvedValue({ dataset: "sales", source: { dataset: "sales", connectionId: CONNECTION } });
    const root = await render();
    const sales = container.querySelector<HTMLInputElement>('input[aria-label="Salg"]')!;
    expect(sales.checked).toBe(false);
    await act(async () => sales.click());
    await flushReact();
    expect(mockApi.setDatasetSource).toHaveBeenCalledWith(COMPANY, "sales", CONNECTION);

    const stock = container.querySelector<HTMLInputElement>('input[aria-label="Lager"]')!;
    expect(stock.disabled).toBe(true);
    expect(container.textContent).toContain("Kommer senere");
    await act(async () => root.unmount());
  });

  it("unticking Salg removes the source", async () => {
    mockApi.list.mockResolvedValue([connection({ datasets: ["sales"] })]);
    mockApi.setDatasetSource.mockResolvedValue({ dataset: "sales", source: null });
    const root = await render();
    const sales = container.querySelector<HTMLInputElement>('input[aria-label="Salg"]')!;
    expect(sales.checked).toBe(true);
    await act(async () => sales.click());
    await flushReact();
    expect(mockApi.setDatasetSource).toHaveBeenCalledWith(COMPANY, "sales", null);
    await act(async () => root.unmount());
  });

  it("lists the latest lookups in plain words", async () => {
    const root = await render();
    const reads = container.querySelector('[data-testid="data-reads"]')?.textContent ?? "";
    expect(reads).toContain(
      `Salgsanalytikeren leste Salg (Sofa, aug 2026 og jul 2026) via Telegram, ${localShort("2026-09-21T08:14:00.000Z")}`,
    );
    expect(reads).not.toMatch(UUID_PATTERN);
    await act(async () => root.unmount());
  });

  it("describes trial runs, tests and refusals without ids", () => {
    expect(
      describeReadEvent(
        readEvent({ channel: "settings_test", agentId: null, agentName: null, userId: "user-1", params: { action: "sales", periods: ["2026-07"] } }),
      ),
    ).toMatch(/^Prøveberegning av Salg \(jul 2026\) fra innstillingene, /);
    expect(
      describeReadEvent(readEvent({ dataset: "connection_check", channel: "settings_test", agentId: null, agentName: null })),
    ).toMatch(/^Test av koblingen fra innstillingene, /);
    expect(
      describeReadEvent(readEvent({ channel: "quick_chat", outcome: "rate_limited", params: { periods: ["last_month"] } })),
    ).toMatch(/^Salgsanalytikeren leste Salg \(forrige måned\) i chatten – stoppet av en grense for antall oppslag, /);
    expect(describeReadEvent(readEvent({ agentName: null }))).toMatch(/^En ansatt som ikke finnes lenger leste Salg/);
  });

  it("asks before disconnecting, and only removes after the owner says yes", async () => {
    mockApi.remove.mockResolvedValue({ ok: true });
    const root = await render();
    await act(async () => button("Fjern")?.click());
    await flushReact();
    expect(mockApi.remove).not.toHaveBeenCalled();
    expect(container.textContent).toContain("den lagrede nøkkelen slettes");
    await act(async () => button("Ja, fjern koblingen")?.click());
    await flushReact();
    expect(mockApi.remove).toHaveBeenCalledWith(COMPANY, CONNECTION);
    await act(async () => root.unmount());
  });

  it("replaces the key through a write-only field and asks for a new Test", async () => {
    mockApi.update.mockResolvedValue(connection({ status: "draft" }));
    const root = await render();
    await act(async () => button("Bytt nøkkel")?.click());
    const kind = container.querySelector<HTMLSelectElement>(`#data-rotate-${CONNECTION}-kind`)!;
    await act(async () => setInput(kind, "admin_access_token"));
    const field = container.querySelector<HTMLInputElement>(`#data-rotate-${CONNECTION}-token`)!;
    expect(field.type).toBe("password");
    expect(field.value).toBe("");
    await act(async () => setInput(field, KEY));
    await act(async () => button("Lagre ny nøkkel")?.click());
    await flushReact();
    expect(mockApi.update).toHaveBeenCalledWith(COMPANY, CONNECTION, {
      credential: { kind: "admin_access_token", accessToken: KEY },
    });
    expect(container.innerHTML).not.toContain(KEY);
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Ny nøkkel lagret. Trykk Test før den tas i bruk." }));
    await act(async () => root.unmount());
  });

  it("tells a member who is not the owner, plainly, who can do this", async () => {
    mockApi.list.mockRejectedValue(new ApiError("Forbidden", 403, { error: "Forbidden" }));
    const root = await render();
    expect(container.textContent).toContain(
      "Bare eieren av selskapet eller en administrator for hele Paperclip kan se og endre datakilder.",
    );
    expect(container.querySelector("#data-shop-domain")).toBeNull();
    await act(async () => root.unmount());
  });
});
