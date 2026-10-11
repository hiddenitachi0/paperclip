// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataConnectionSummary, ReportDataPreview, ReportTemplate } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { ReportTemplatesSection } from "./ReportTemplatesSection";

/**
 * DUR-4072 PR3: the template's data-source picker. What it must get right:
 *  - only the datasets the chosen source can give are offered, in plain English;
 *  - Save sends the source and the dataset choice (never a key);
 *  - "Preview data" is shown to an owner/admin only and shows the first rows;
 *  - a refused preview is explained in a sentence.
 */

const mockReports = vi.hoisted(() => ({ listTemplates: vi.fn(), updateTemplate: vi.fn(), previewData: vi.fn() }));
const mockConnections = vi.hoisted(() => ({ list: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/reports", () => ({ reportsApi: mockReports }));
vi.mock("../api/dataConnections", () => ({ dataConnectionsApi: mockConnections }));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const TEMPLATE = "22222222-2222-4222-8222-222222222222";
const FIKEN = "33333333-3333-4333-8333-333333333333";
const SHOP = "44444444-4444-4444-8444-444444444444";

function template(overrides: Partial<ReportTemplate> = {}): ReportTemplate {
  return {
    id: TEMPLATE,
    companyId: COMPANY,
    key: "kvartal",
    name: "Kvartalsrapport",
    instructions: "i",
    layout: {},
    dataConnectionId: null,
    dataQuery: null,
    scriptVersionId: "55555555-5555-4555-8555-555555555555",
    isActive: true,
    createdByAgentId: null,
    createdByUserId: "owner",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

function conn(id: string, kind: "fiken" | "shopify", name: string): DataConnectionSummary {
  return {
    id,
    companyId: COMPANY,
    kind,
    kindLabel: kind === "fiken" ? "Fiken" : "Shopify",
    supported: true,
    name,
    status: "active",
  } as unknown as DataConnectionSummary;
}

const PREVIEW: ReportDataPreview = {
  connectionName: "Regnskap",
  kindLabel: "Fiken",
  period: { token: "last_quarter", from: "2026-07-01", to: "2026-09-30", months: ["2026-07", "2026-08", "2026-09"], label: "Q3 2026" },
  items: [
    {
      key: "balances",
      dataset: "fiken_balances",
      label: "Account balances",
      ok: true,
      rowCount: 42,
      sampleRows: [{ code: "1920", name: "Bank", opening: 100, closing: 350, change: 250 }],
      message: null,
      lookupId: "66666666-6666-4666-8666-666666666666",
    },
  ],
  bytes: 1234,
  sha256: "a".repeat(64),
};

async function flushReact() {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function setInput(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("ReportTemplatesSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockReports.listTemplates.mockResolvedValue([template()]);
    mockConnections.list.mockResolvedValue([conn(FIKEN, "fiken", "Regnskap"), conn(SHOP, "shopify", "Nettbutikk")]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(canManage: boolean) {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ReportTemplatesSection companyId={COMPANY} canManage={canManage} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  const button = (label: string) => Array.from(container.querySelectorAll("button")).find((element) => element.textContent?.trim() === label);
  const checkbox = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

  it("offers only the chosen source's datasets, saves the choice, and previews the first rows", async () => {
    mockReports.updateTemplate.mockResolvedValue(template({ dataConnectionId: FIKEN }));
    mockReports.previewData.mockResolvedValue(PREVIEW);
    const root = await render(true);

    const source = container.querySelector<HTMLSelectElement>(`#report-source-${TEMPLATE}`)!;
    expect(Array.from(source.options).map((option) => option.textContent)).toEqual(["No data source", "Fiken – Regnskap", "Shopify – Nettbutikk"]);
    await act(async () => setInput(source, SHOP));
    expect(container.textContent).toContain("Sales per month (units)");
    expect(container.textContent).not.toContain("Account balances");

    await act(async () => setInput(source, FIKEN));
    expect(container.textContent).toContain("Account balances");
    expect(container.textContent).toContain("Bookkeeping entries");
    expect(container.textContent).not.toContain("Sales per month");
    await act(async () => checkbox("Account balances").click());
    await act(async () => setInput(container.querySelector<HTMLSelectElement>(`#report-period-${TEMPLATE}`)!, "last_quarter"));

    await act(async () => button("Save")!.click());
    await flushReact();
    expect(mockReports.updateTemplate).toHaveBeenCalledWith(COMPANY, TEMPLATE, {
      dataConnectionId: FIKEN,
      dataQuery: { period: "last_quarter", items: [{ key: "balances", dataset: "fiken_balances" }] },
    });

    await act(async () => button("Preview data")!.click());
    await flushReact();
    expect(mockReports.previewData).toHaveBeenCalledWith(COMPANY, {
      dataConnectionId: FIKEN,
      dataQuery: { period: "last_quarter", items: [{ key: "balances", dataset: "fiken_balances" }] },
    });
    const preview = container.querySelector('[data-testid="report-data-preview"]')!;
    expect(preview.textContent).toContain("Q3 2026");
    expect(preview.textContent).toContain("42 rows, showing the first 1");
    expect(preview.textContent).toContain("1920");
    expect(preview.textContent).toContain("logged");
    // No internal id is shown.
    expect(container.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    await act(async () => root.unmount());
  });

  it("shows no Preview button to someone who is not owner/admin", async () => {
    mockReports.listTemplates.mockResolvedValue([
      template({ dataConnectionId: FIKEN, dataQuery: { period: "last_month", items: [{ key: "accounts", dataset: "fiken_accounts" }] } }),
    ]);
    const root = await render(false);
    expect(button("Preview data")).toBeUndefined();
    expect(container.textContent).toContain("Only the company's owner or an admin can preview the data.");
    expect(checkbox("Chart of accounts").checked).toBe(true);
    await act(async () => root.unmount());
  });

  it("explains a refused preview in a sentence", async () => {
    mockReports.listTemplates.mockResolvedValue([
      template({ dataConnectionId: FIKEN, dataQuery: { period: "last_month", items: [{ key: "accounts", dataset: "fiken_accounts" }] } }),
    ]);
    mockReports.previewData.mockRejectedValue(new ApiError("The data connection is not switched on.", 422, {}));
    const root = await render(true);
    await act(async () => button("Preview data")!.click());
    await flushReact();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("The data connection is not switched on.");
    await act(async () => root.unmount());
  });

  it("asks to draft a template first when there is none", async () => {
    mockReports.listTemplates.mockResolvedValue([]);
    const root = await render(true);
    expect(container.textContent).toContain("No report templates yet");
    await act(async () => root.unmount());
  });
});
