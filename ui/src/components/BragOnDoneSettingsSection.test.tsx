// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCompaniesApi = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));

import { BragOnDoneSettingsSection } from "./BragOnDoneSettingsSection";
import { TooltipProvider } from "@/components/ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Company settings: brag videos for finished tasks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockCompaniesApi.update.mockReset();
    mockCompaniesApi.update.mockResolvedValue({});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  function render(company: { id: string; bragOnDoneEnabled?: boolean; bragOnDoneMaxCostCents?: number | null }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <BragOnDoneSettingsSection company={company} />
        </TooltipProvider>
      </QueryClientProvider>,
    ));
  }

  it("explains the switch in plain words and turns it off", async () => {
    render({ id: "company-1", bragOnDoneEnabled: true, bragOnDoneMaxCostCents: null });
    expect(container.textContent).toContain("Brag videos for finished tasks");
    expect(container.textContent).toContain("standard limit of $0.39");
    const toggle = container.querySelector('[data-testid="company-settings-brag-on-done-toggle"]') as HTMLButtonElement;
    await act(async () => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", { bragOnDoneEnabled: false });
  });

  it("saves a cost limit in cents", async () => {
    render({ id: "company-1", bragOnDoneEnabled: true, bragOnDoneMaxCostCents: null });
    const input = container.querySelector('[data-testid="company-settings-brag-on-done-cap"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "1.25");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save")!;
    expect(save.disabled).toBe(false);
    await act(async () => save.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", { bragOnDoneMaxCostCents: 125 });
  });

  it("disables the limit while the feature is off", () => {
    render({ id: "company-1", bragOnDoneEnabled: false });
    const input = container.querySelector('[data-testid="company-settings-brag-on-done-cap"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});
