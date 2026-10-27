// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractDetail, ContractVersion } from "../api/contracts";
import { ContractPage } from "./ContractPage";
import { addDaysIso } from "../lib/contract-labels";

const COMPANY = "11111111-1111-4111-8111-111111111111";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  versions: vi.fn(),
  update: vi.fn(),
  setTerm: vi.fn(),
  removeTerm: vi.fn(),
  addDeadline: vi.fn(),
  updateDeadline: vi.fn(),
  removeDeadline: vi.fn(),
  addParty: vi.fn(),
  removeParty: vi.fn(),
  linkPreviousVersion: vi.fn(),
  remove: vi.fn(),
  listOrganisations: vi.fn(),
  fileUrl: (assetId: string) => `/api/assets/${assetId}/content`,
}));

vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: COMPANY }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../hooks/useCanUseContracts", () => ({ useCanUseContracts: () => true }));
vi.mock("../api/contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/contracts")>()),
  contractsApi: mockApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const soon = addDaysIso(12);

const contract: ContractDetail = {
  id: "v2",
  companyId: COMPANY,
  title: "Office lease Oslo",
  type: "rental_lease",
  status: "active",
  assetId: "asset-1",
  textStatus: "no_text_layer",
  language: "Norwegian",
  governingLaw: "Norway",
  effectiveDate: "2025-01-01",
  expiryDate: "2027-12-31",
  autoRenewal: true,
  noticePeriodDays: 90,
  summary: "A three year lease of the Oslo office.",
  supersedesContractId: "v1",
  versionNo: 2,
  changeSummary: "Rent goes up 3%",
  createdByAgentId: null,
  createdByUserId: null,
  sourceIssueId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  parties: [{ id: "p1", companyId: COMPANY, contractId: "v2", organizationId: "org-1", role: "Landlord", name: null, createdAt: "" }],
  deadlines: [
    {
      id: "d1",
      companyId: COMPANY,
      contractId: "v2",
      kind: "notice_terminate",
      dueDate: soon,
      leadTimesDays: [60, 30, 7],
      clauseRef: "9.1",
      state: "open",
      note: null,
      createdAt: "",
      updatedAt: "",
      reminders: [{ leadDays: 30, issueId: "issue-9" }],
    },
    {
      id: "d2",
      companyId: COMPANY,
      contractId: "v2",
      kind: "price_review",
      dueDate: "2026-01-01",
      leadTimesDays: [30, 7],
      clauseRef: null,
      state: "done",
      note: null,
      createdAt: "",
      updatedAt: "",
    },
  ],
  terms: [
    { id: "t2", companyId: COMPANY, contractId: "v2", key: "liability_cap", valueKind: "explicitly_none", numberValue: null, currency: null, textValue: null, boolValue: null, clauseRef: null, pageRef: null, createdAt: "", updatedAt: "" },
    { id: "t1", companyId: COMPANY, contractId: "v2", key: "notice_period_days", valueKind: "number", numberValue: "90.000000", currency: null, textValue: null, boolValue: null, clauseRef: "9.1", pageRef: "4", createdAt: "", updatedAt: "" },
  ],
};

const versions: ContractVersion[] = [
  { id: "v1", title: "Office lease Oslo (2023)", status: "superseded", versionNo: 1, changeSummary: null, supersedesContractId: null, effectiveDate: "2023-01-01", createdAt: "" },
  { id: "v2", title: "Office lease Oslo", status: "active", versionNo: 2, changeSummary: "Rent goes up 3%", supersedesContractId: "v1", effectiveDate: "2025-01-01", createdAt: "" },
];

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("Contract page", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockApi.get.mockResolvedValue(contract);
    mockApi.list.mockResolvedValue([]);
    mockApi.versions.mockResolvedValue(versions);
    mockApi.listOrganisations.mockResolvedValue([{ id: "org-1", name: "Nordic Properties AS" }]);
    mockApi.updateDeadline.mockResolvedValue({});
    mockApi.removeTerm.mockResolvedValue({ ok: true });
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
          <MemoryRouter initialEntries={["/legal/v2"]}>
            <Routes>
              <Route path="/legal/:contractId" element={<ContractPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);

  it("shows the file, its reading status, the summary and the other party by name", async () => {
    await render();
    const file = q("contract-file")!;
    expect(file.querySelector('a[href="/api/assets/asset-1/content"]')?.textContent).toContain("Open the file");
    expect(file.querySelector("a[download]")?.textContent).toContain("Download");
    expect(q("contract-text-status")?.textContent).toBe("Scanned file, no readable text");
    expect(file.textContent).toContain("assistant can still read the PDF");
    expect(q("contract-summary")?.textContent).toContain("A three year lease of the Oslo office.");
    expect(q("contract-parties")?.textContent).toContain("Nordic Properties AS");
    expect(q("contract-parties")?.textContent).toContain("Landlord");
  });

  it("shows key terms with where they sit, and never reads 'none' as a number", async () => {
    await render();
    const rows = [...container.querySelectorAll('[data-testid="contract-term-row"]')].map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Liability cap");
    expect(rows[0]).toContain("The contract says there is none");
    expect(rows[1]).toContain("Notice period (days)");
    expect(rows[1]).toContain("90");
    expect(rows[1]).toContain("Clause 9.1, page 4");
  });

  it("shows each date with its state, clause, reminders and linked reminder task", async () => {
    await render();
    const rows = [...container.querySelectorAll('[data-testid="contract-deadline-row"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Last day to give notice and end it");
    expect(rows[0]!.textContent).toContain("in 12 days");
    expect(rows[0]!.textContent).toContain("Open");
    expect(rows[0]!.textContent).toContain("Clause 9.1");
    expect(rows[0]!.textContent).toContain("Reminders 60, 30, 7 days before");
    expect(rows[0]!.querySelector('a[href$="/issues/issue-9"]')).not.toBeNull();
    expect(rows[1]!.textContent).toContain("Done");
  });

  it("walks the version chain, newest first, with what changed", async () => {
    await render();
    const rows = [...container.querySelectorAll('[data-testid="contract-version-row"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Version 2");
    expect(rows[0]!.textContent).toContain("You are here");
    expect(rows[0]!.textContent).toContain("What changed: Rent goes up 3%");
    expect(rows[1]!.textContent).toContain("Version 1");
    expect(rows[1]!.textContent).toContain("Replaced by a newer version");
    expect(rows[1]!.querySelector('a[href$="/legal/v1"]')).not.toBeNull();
  });

  it("lets the board mark a date as done", async () => {
    await render();
    await act(async () => button("Mark as done")!.click());
    await flush();
    expect(mockApi.updateDeadline).toHaveBeenCalledWith(COMPANY, "v2", "d1", { state: "done" });
  });

  it("lets the board remove a key term", async () => {
    await render();
    await act(async () => button("Remove Liability cap")!.click());
    await flush();
    expect(mockApi.removeTerm).toHaveBeenCalledWith(COMPANY, "v2", "liability_cap");
  });

  it("opens the detail form filled in, and sends only what changed", async () => {
    mockApi.update.mockResolvedValue(contract);
    await render();
    await act(async () => button("Change details")!.click());
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const title = dialog.querySelector<HTMLInputElement>("#facts-title")!;
    expect(title.value).toBe("Office lease Oslo");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(title, "Office lease, Oslo");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    await act(async () => save.click());
    await flush();
    expect(mockApi.update).toHaveBeenCalledWith(COMPANY, "v2", { title: "Office lease, Oslo" });
  });

  it("explains a missing field instead of sending a bad date", async () => {
    await render();
    await act(async () => button("Add a date")!.click());
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const save = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    await act(async () => save.click());
    expect(dialog.textContent).toContain("Pick the date.");
    expect(mockApi.addDeadline).not.toHaveBeenCalled();
  });
});
