// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductGrabberStagedItemSummary } from "@paperclipai/shared";
import { ProductGrabber } from "./ProductGrabber";

/**
 * The Product grabber page (DUR-4188):
 *   - off by default: shows a plain explanation, and an owner/admin gets a
 *     button to turn it on; anyone else is told to ask an owner or admin;
 *   - once on, lists waiting/approved/rejected products with plain labels;
 *   - an owner or admin gets the "add product" form and approve/reject
 *     buttons; anyone else only sees the list.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ITEM = "33333333-3333-4333-8333-333333333333";

const mockProductGrabberApi = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setEnabled: vi.fn(),
  listStagedItems: vi.fn(),
  extract: vi.fn(),
  review: vi.fn(),
}));
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
vi.mock("../api/productGrabber", () => ({ productGrabberApi: mockProductGrabberApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function role(canManage: boolean) {
  return { role: canManage ? "owner" : "operator", isInstanceAdmin: false, localBoard: false, canManageConnections: canManage, isLoading: false };
}

const sweater: ProductGrabberStagedItemSummary = {
  id: ITEM,
  companyId: COMPANY,
  vendor: "Ellos",
  sourceUrl: "https://www.ellos.no/produkt/sweater",
  rawFields: { title: "Blue wool sweater", price: "499 kr" },
  imageUrls: ["https://www.ellos.no/images/sweater.jpg"],
  status: "pending",
  approvedByUserId: null,
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

describe("ProductGrabber page", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockProductGrabberApi.getSettings.mockResolvedValue({ companyId: COMPANY, enabled: true });
    mockProductGrabberApi.listStagedItems.mockResolvedValue([sweater]);
    mockProductGrabberApi.setEnabled.mockResolvedValue({ companyId: COMPANY, enabled: true });
    mockProductGrabberApi.extract.mockResolvedValue(sweater);
    mockProductGrabberApi.review.mockResolvedValue({ ...sweater, status: "approved" });
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
          <ProductGrabber />
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

  it("lists a waiting product in plain words with its source link", async () => {
    await render();
    const row = container.querySelector('[data-testid="product-grabber-row"]')!;
    expect(row.textContent).toContain("Blue wool sweater");
    expect(row.textContent).toContain("Ellos");
    expect(row.textContent).toContain("499 kr");
    expect(row.textContent).toContain("https://www.ellos.no/produkt/sweater");
  });

  it("an owner can approve or reject a waiting product", async () => {
    await render();
    await act(async () => buttonByText("Approve")!.click());
    await flush();
    expect(mockProductGrabberApi.review).toHaveBeenCalledWith(COMPANY, ITEM, "approved");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Product approved" }));
  });

  it("an owner can add a product by pasting its web address", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Product web address"]')!;
    const form = input.closest("form")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "https://www.ellos.no/produkt/jacket");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await flush();
    expect(mockProductGrabberApi.extract).toHaveBeenCalledWith(COMPANY, "https://www.ellos.no/produkt/jacket");
  });

  it("someone who is not owner or admin sees the list and no approve/reject buttons", async () => {
    mockUseCompanyRole.mockReturnValue(role(false));
    await render();
    expect(container.textContent).toContain("Blue wool sweater");
    expect(buttonByText("Approve")).toBeUndefined();
    expect(buttonByText("Add product")).toBeUndefined();
  });

  it("when turned off, an owner sees a button to turn it on and no staging list call", async () => {
    mockProductGrabberApi.getSettings.mockResolvedValue({ companyId: COMPANY, enabled: false });
    await render();
    expect(container.textContent).toContain("isn't turned on yet");
    expect(mockProductGrabberApi.listStagedItems).not.toHaveBeenCalled();
    await act(async () => buttonByText("Turn on product grabber")!.click());
    await flush();
    expect(mockProductGrabberApi.setEnabled).toHaveBeenCalledWith(COMPANY, true);
  });

  it("when turned off, someone who is not owner or admin is told to ask one, with no button", async () => {
    mockProductGrabberApi.getSettings.mockResolvedValue({ companyId: COMPANY, enabled: false });
    mockUseCompanyRole.mockReturnValue(role(false));
    await render();
    expect(container.textContent).toContain("Ask a company owner or admin to turn it on");
    expect(buttonByText("Turn on product grabber")).toBeUndefined();
  });
});
