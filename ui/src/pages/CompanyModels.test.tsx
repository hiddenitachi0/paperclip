// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { bodyFromForm, CompanyModels, modelErrorMessage } from "./CompanyModels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const mockApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  duplicate: vi.fn(),
  listStarters: vi.fn(),
  addStarters: vi.fn(),
}));
const mockRole = vi.hoisted(() => vi.fn());

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY, selectedCompany: { id: COMPANY, name: "Nordstrand" } }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../hooks/useCompanyRole", () => ({ useCompanyRole: mockRole }));
vi.mock("../api/modelDirectory", () => ({ modelDirectoryApi: mockApi }));

const ENTRY = {
  id: "22222222-2222-4222-8222-222222222222",
  companyId: COMPANY,
  name: "Maja local",
  provider: "local",
  model: "llama3.2",
  baseUrl: "http://100.1.1.1:11434/v1",
  providerRouting: null,
  defaultThinking: null,
  defaultTemperature: null,
  defaultMaxOutputTokens: null,
  backupEntryIds: [],
  note: "Needs my PC on",
};

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  mockApi.list.mockResolvedValue([ENTRY]);
  mockApi.listStarters.mockResolvedValue([
    { id: "s1", name: "Local: Llama 3.2", note: "Needs your PC", alreadyAdded: false },
    { id: "s2", name: "Mistral", note: "Cloud", alreadyAdded: true },
  ]);
  mockRole.mockReturnValue({ canManageConnections: true, isLoading: false });
});
afterEach(() => {
  container.remove();
  vi.clearAllMocks();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CompanyModels />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return root;
}

describe("CompanyModels", () => {
  it("lists saved models and the starters not yet added, for an admin", async () => {
    await render();
    expect(container.textContent).toContain("Maja local");
    expect(container.textContent).toContain("Edit");
    expect(container.textContent).toContain("Local: Llama 3.2");
    expect(container.textContent).not.toContain("Mistral");
  });

  it("hides every change button from someone who may not manage", async () => {
    mockRole.mockReturnValue({ canManageConnections: false, isLoading: false });
    await render();
    expect(container.textContent).toContain("Maja local");
    expect(container.textContent).not.toContain("Add a model");
    expect(container.textContent).not.toContain("Delete");
    expect(container.querySelector("[data-testid=models-read-only-note]")).not.toBeNull();
    expect(mockApi.listStarters).not.toHaveBeenCalled();
  });

  it("adds one starter by its id", async () => {
    mockApi.addStarters.mockResolvedValue([]);
    await render();
    const add = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Add")!;
    await act(async () => add.click());
    expect(mockApi.addStarters).toHaveBeenCalledWith(COMPANY, ["s1"]);
  });
});

describe("helpers", () => {
  const base = {
    name: "A",
    provider: "openrouter" as const,
    model: "m",
    baseUrl: "http://stale:1/v1",
    thinking: "" as const,
    temperature: "",
    maxOutputTokens: "",
    note: "",
  };
  it("drops a stale address when the provider does not use one", () => {
    expect(bodyFromForm(base).baseUrl).toBeNull();
    expect(bodyFromForm({ ...base, provider: "local" }).baseUrl).toBe("http://stale:1/v1");
  });
  it("explains refusals in plain English", () => {
    expect(modelErrorMessage(new ApiError("Forbidden", 403, null), "delete this model setup")).toBe(
      "Only the company owner or an admin can delete this model setup.",
    );
    expect(modelErrorMessage(new ApiError("dup", 409, null), "save")).toContain("already has that name");
  });
});
