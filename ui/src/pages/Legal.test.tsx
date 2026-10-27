// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Contract, ContractDeadline, ContractDetail } from "../api/contracts";
import { Legal, filterContracts } from "./Legal";
import { addDaysIso } from "../lib/contract-labels";

const COMPANY = "11111111-1111-4111-8111-111111111111";

const mockApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  linkPreviousVersion: vi.fn(),
  listDeadlines: vi.fn(),
  listOrganisations: vi.fn(),
  uploadFile: vi.fn(),
}));
const mockCanUse = vi.hoisted(() => vi.fn());

vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: COMPANY }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../hooks/useCanUseContracts", () => ({ useCanUseContracts: mockCanUse }));
vi.mock("../api/contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/contracts")>()),
  contractsApi: mockApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function contract(id: string, title: string, over: Partial<Contract> = {}): Contract {
  return {
    id,
    companyId: COMPANY,
    title,
    type: "rental_lease",
    status: "active",
    assetId: null,
    textStatus: "extracted",
    language: null,
    governingLaw: null,
    effectiveDate: null,
    expiryDate: null,
    autoRenewal: null,
    noticePeriodDays: null,
    summary: null,
    supersedesContractId: null,
    versionNo: 1,
    changeSummary: null,
    createdByAgentId: null,
    createdByUserId: null,
    sourceIssueId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function deadline(contractId: string, dueDate: string): ContractDeadline {
  return {
    id: `d-${contractId}`,
    companyId: COMPANY,
    contractId,
    kind: "notice_terminate",
    dueDate,
    leadTimesDays: [60, 30, 7],
    clauseRef: null,
    state: "open",
    note: null,
    createdAt: "",
    updatedAt: "",
  };
}

const lease = contract("lease", "Office lease Oslo", { expiryDate: "2027-12-31" });
const scanned = contract("scan", "Warehouse lease", { textStatus: "no_text_layer" });
const supplier = contract("sup", "Coffee supplier", { type: "vendor_supplier" });
const old = contract("old", "Office lease Oslo (2022)", { status: "superseded" });
const soon = addDaysIso(10);
const farOff = addDaysIso(75);

function detail(base: Contract, partyName: string): ContractDetail {
  return {
    ...base,
    parties: [{ id: `p-${base.id}`, companyId: COMPANY, contractId: base.id, organizationId: null, role: "Other side", name: partyName, createdAt: "" }],
    deadlines: [],
    terms: [],
  };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("Legal page", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCanUse.mockReturnValue(true);
    mockApi.list.mockResolvedValue([lease, scanned, supplier, old]);
    mockApi.listDeadlines.mockResolvedValue([deadline("lease", soon), deadline("sup", farOff)]);
    mockApi.listOrganisations.mockResolvedValue([]);
    mockApi.get.mockImplementation(async (_company: string, id: string) => {
      const base = [lease, scanned, supplier, old].find((item) => item.id === id)!;
      return detail(base, id === "sup" ? "Fjell Kaffe AS" : "Nordic Properties");
    });
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

  async function render(url = "/legal") {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const current = root;
    await act(async () => {
      current.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[url]}>
            <Legal />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  const rowTitles = () => [...container.querySelectorAll('[data-testid="contract-row"]')].map((row) => row.textContent ?? "");

  it("lists current contracts with their other party, and hides older versions by default", async () => {
    await render();
    const rows = rowTitles();
    expect(rows).toHaveLength(3);
    expect(rows.some((text) => text.includes("Office lease Oslo") && text.includes("Nordic Properties"))).toBe(true);
    expect(rows.some((text) => text.includes("(2022)"))).toBe(false);
  });

  it("flags a scanned file and a date coming up", async () => {
    await render();
    expect(container.querySelectorAll('[data-testid="contract-scan-badge"]')).toHaveLength(1);
    const badges = [...container.querySelectorAll('[data-testid="contract-deadline-badge"]')];
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent).toContain("Last day to give notice and end it");
    expect(badges[0]!.textContent).toContain("in 10 days");
    expect(container.querySelector('[data-testid="legal-due-soon-summary"]')?.textContent).toContain("1 contract");
  });

  it("filters by kind, other party and dates coming up", async () => {
    await render("/legal?type=vendor_supplier");
    expect(rowTitles()).toHaveLength(1);
    await act(async () => root!.unmount());
    root = null;
    await render("/legal?party=Fjell%20Kaffe%20AS");
    expect(rowTitles()).toHaveLength(1);
    await act(async () => root!.unmount());
    root = null;
    await render("/legal?soon=30");
    expect(rowTitles()).toHaveLength(1);
    expect(rowTitles()[0]).toContain("Office lease Oslo");
  });

  it("says plainly when nothing matches and offers a way back", async () => {
    await render("/legal?type=loan");
    expect(container.querySelector('[data-testid="legal-no-matches"]')?.textContent).toContain("No contracts match");
    expect(container.textContent).toContain("Clear choices");
  });

  it("shows nothing but a plain message to someone who cannot use Legal, and asks the server for nothing", async () => {
    mockCanUse.mockReturnValue(false);
    await render();
    expect(container.textContent).toContain("only open to people who can make changes");
    expect(mockApi.list).not.toHaveBeenCalled();
  });

  it("shows the server's refusal in plain words", async () => {
    const { ApiError } = await import("../api/client");
    mockApi.list.mockRejectedValue(new ApiError("This member does not have access to contracts", 403, null));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("do not have access to contracts");
  });

  it("opens the add form, which says the file cannot be attached yet and suggests an older version", async () => {
    await render();
    const add = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add contract"))!;
    await act(async () => add.click());
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[data-testid="contract-file-not-ready"]')).not.toBeNull();
    const title = dialog.querySelector<HTMLInputElement>("#contract-title")!;
    const typeSelect = dialog.querySelector<HTMLSelectElement>("#contract-type")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      selectSetter.call(typeSelect, "rental_lease");
      typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      setter.call(title, "Office lease Oslo v2");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const previous = dialog.querySelector<HTMLSelectElement>("#contract-previous")!;
    expect(previous.value).toBe("lease");
    expect(dialog.textContent).toContain("looks like a newer copy");
    // Linking needs a note about what changed.
    const save = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Add contract")!;
    expect(save.disabled).toBe(true);
  });
});

describe("filterContracts", () => {
  it("counts an overdue open date as coming up", () => {
    const now = new Date(2026, 9, 27);
    const result = filterContracts(
      [lease],
      { type: "", status: "current", party: "", soonDays: 30, search: "" },
      new Map(),
      new Map([["lease", [deadline("lease", "2026-10-01")]]]),
      now,
    );
    expect(result).toHaveLength(1);
  });
});
