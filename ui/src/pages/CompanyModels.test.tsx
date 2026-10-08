// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { EMPTY_MODEL_FORM } from "../components/ModelEntryDialog";
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
  exportCatalogue: vi.fn(),
  importCatalogue: vi.fn(),
  listReviews: vi.fn(),
}));
const mockRole = vi.hoisted(() => vi.fn());
const mockToast = vi.hoisted(() => vi.fn());

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY, selectedCompany: { id: COMPANY, name: "Nordstrand" } }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockToast }) }));
vi.mock("../hooks/useCompanyRole", () => ({ useCompanyRole: mockRole }));
vi.mock("../api/modelDirectory", () => ({ modelDirectoryApi: mockApi }));

const BASE = {
  companyId: COMPANY,
  providerRouting: null,
  defaultThinking: null,
  defaultTemperature: null,
  defaultMaxOutputTokens: null,
  backupEntryIds: [],
  note: null,
  maker: null,
  baseModel: null,
  lane: null,
  availability: null,
  tags: [],
  specs: null,
  favorite: false,
  archivedAt: null,
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

const ENTRY = {
  ...BASE,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Maja local",
  provider: "local",
  model: "llama3.2",
  baseUrl: "http://100.1.1.1:11434/v1",
  note: "Needs my PC on",
  maker: "Meta",
  baseModel: "Llama 3.2",
  lane: "quick",
  availability: "installed",
  tags: ["chat"],
  specs: { params: "3B", quant: "Q4_K_M", sizeGb: 2, tools: "yes" },
};
const GEMMA = {
  ...BASE,
  id: "33333333-3333-4333-8333-333333333333",
  name: "Gemma cloud",
  provider: "huggingface",
  model: "google/gemma-3-27b-it:deepinfra",
  baseUrl: null,
  maker: "Google",
  baseModel: "Gemma 3 27B",
  lane: "full",
  availability: "cloud",
  tags: ["vision"],
};
const OLD = {
  ...BASE,
  id: "44444444-4444-4444-8444-444444444444",
  name: "Old mistral",
  provider: "openrouter",
  model: "mistralai/mistral-7b",
  baseUrl: null,
  archivedAt: "2026-10-02T00:00:00Z",
};

let container: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  mockApi.list.mockResolvedValue([ENTRY, GEMMA, OLD]);
  mockApi.update.mockResolvedValue(ENTRY);
  mockApi.listStarters.mockResolvedValue([
    { id: "s1", name: "Local: Llama 3.2", note: "Needs your PC", alreadyAdded: false },
    { id: "s2", name: "Mistral", note: "Cloud", alreadyAdded: true },
  ]);
  mockRole.mockReturnValue({ canManageConnections: true, isLoading: false });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <CompanyModels />
      </QueryClientProvider>,
    );
  });
  await flush();
  return root;
}

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const buttonByText = (scope: ParentNode, text: string) =>
  Array.from(scope.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await flush();
}

async function selectValue(testId: string, value: string) {
  const select = byTestId(testId) as HTMLSelectElement;
  expect(select).toBeTruthy();
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

const shownNames = () =>
  Array.from(container.querySelectorAll("[data-testid^=model-card-]")).map(
    (card) => card.querySelector("span.font-semibold")?.textContent,
  );

describe("CompanyModels", () => {
  it("lists saved models and the starters not yet added, for an admin", async () => {
    await render();
    expect(mockApi.list).toHaveBeenCalledWith(COMPANY, { includeArchived: true });
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
    expect(container.textContent).not.toContain("Archive");
    expect(byTestId("models-import")).toBeNull();
    expect(byTestId(`model-favorite-${ENTRY.id}`)).toBeNull();
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

  it("groups by maker and base model by default, and can group by where it runs", async () => {
    await render();
    const google = byTestId("models-group-maker-google")!;
    expect(google).not.toBeNull();
    expect(google.textContent).toContain("Gemma 3 27B");
    expect(byTestId("models-group-maker-meta")!.textContent).toContain("Maja local");
    // Specs line and chips.
    expect(byTestId(`model-specs-${ENTRY.id}`)!.textContent).toBe("3B · Q4_K_M · 2 GB · tools: yes");
    const card = byTestId(`model-card-${ENTRY.id}`)!;
    for (const chip of ["On your PC", "Quick chat", "Installed", "#chat"]) expect(card.textContent).toContain(chip);
    expect(byTestId("models-counts")!.textContent).toBe("2 models · 1 on your PC · 1 in the cloud · 1 archived");

    await selectValue("models-group-by", "where");
    expect(byTestId("models-group-maker-google")).toBeNull();
    expect(byTestId("models-group-where-local")!.textContent).toContain("Maja local");
    expect(byTestId("models-group-where-huggingface")!.textContent).toContain("Gemma cloud");
    expect(window.localStorage.getItem("paperclip.models.groupBy")).toBe("where");
  });

  it("hides archived models until Show archived is on, and archives / restores", async () => {
    await render();
    expect(container.textContent).not.toContain("Old mistral");
    await click(byTestId("models-show-archived"));
    expect(container.textContent).toContain("Old mistral");
    expect(byTestId(`model-archived-${OLD.id}`)).not.toBeNull();
    expect(byTestId(`model-archive-${OLD.id}`)!.textContent).toContain("Restore");

    await click(byTestId(`model-archive-${OLD.id}`));
    expect(mockApi.update).toHaveBeenCalledWith(COMPANY, OLD.id, { archived: false });
    await click(byTestId(`model-archive-${ENTRY.id}`));
    expect(mockApi.update).toHaveBeenCalledWith(COMPANY, ENTRY.id, { archived: true });
  });

  it("toggles a favourite with the star", async () => {
    await render();
    const star = byTestId(`model-favorite-${GEMMA.id}`)!;
    expect(star.getAttribute("aria-pressed")).toBe("false");
    await click(star);
    expect(mockApi.update).toHaveBeenCalledWith(COMPANY, GEMMA.id, { favorite: true });
  });

  it("filters by search, where it runs, status and tag, and clears the filters", async () => {
    await render();
    await typeInto(byTestId("models-search") as HTMLInputElement, "gemma");
    expect(shownNames()).toEqual(["Gemma cloud"]);
    expect(byTestId("models-counts")!.textContent).toContain("1 shown");

    await click(byTestId("models-clear-filters"));
    expect(shownNames()).toHaveLength(2);

    await selectValue("models-filter-where", "local");
    expect(shownNames()).toEqual(["Maja local"]);
    await selectValue("models-filter-where", "all");

    await selectValue("models-filter-status", "cloud");
    expect(shownNames()).toEqual(["Gemma cloud"]);
    await selectValue("models-filter-status", "all");

    await click(byTestId("models-tag-chat"));
    expect(shownNames()).toEqual(["Maja local"]);

    await typeInto(byTestId("models-search") as HTMLInputElement, "nothing like this");
    expect(byTestId("models-no-match")).not.toBeNull();
  });

  it("warns when two setups use the very same model", async () => {
    const twin = { ...ENTRY, id: "55555555-5555-4555-8555-555555555555", name: "Maja twin", baseUrl: "HTTP://100.1.1.1:11434/v1/" };
    mockApi.list.mockResolvedValue([ENTRY, twin, GEMMA]);
    await render();
    expect(byTestId(`model-duplicate-${ENTRY.id}`)!.textContent).toBe("Same model as Maja twin");
    expect(byTestId(`model-duplicate-${twin.id}`)!.textContent).toBe("Same model as Maja local");
    expect(byTestId(`model-duplicate-${GEMMA.id}`)).toBeNull();
  });

  it("shows the rest of a note and the address under More", async () => {
    mockApi.list.mockResolvedValue([{ ...ENTRY, note: "First line\nSecond line" }]);
    await render();
    const card = byTestId(`model-card-${ENTRY.id}`)!;
    expect(card.textContent).toContain("First line");
    expect(card.textContent).not.toContain("Second line");
    await click(byTestId(`model-more-${ENTRY.id}`));
    expect(byTestId(`model-details-${ENTRY.id}`)!.textContent).toContain("Second line");
    expect(byTestId(`model-details-${ENTRY.id}`)!.textContent).toContain("http://100.1.1.1:11434/v1");
  });

  it("exports the catalogue as a dated JSON file", async () => {
    const file = { version: 1, exportedAt: "2026-10-08T00:00:00Z", entries: [{ name: "Maja local" }] };
    mockApi.exportCatalogue.mockResolvedValue(file);
    const createUrl = vi.fn(() => "blob:models");
    const revokeUrl = vi.fn();
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    let downloaded = "";
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    await render();
    await click(byTestId("models-export"));
    expect(mockApi.exportCatalogue).toHaveBeenCalledWith(COMPANY);
    expect(createUrl).toHaveBeenCalled();
    expect(downloaded).toMatch(/^paperclip-models-nordstrand-\d{4}-\d{2}-\d{2}\.json$/);
    clickSpy.mockRestore();
  });

  it("imports a file: preview, choose update, then shows the result", async () => {
    mockApi.importCatalogue.mockResolvedValue({
      created: ["Qwen coder"],
      updated: ["Maja local"],
      skipped: [{ name: "Broken one", reason: "The address is missing." }],
    });
    await render();
    const fileEntries = [
      { name: "Qwen coder", provider: "openrouter", model: "qwen/qwen3-coder" },
      { name: "maja LOCAL", provider: "local", model: "llama3.2", baseUrl: "http://100.1.1.1:11434/v1" },
    ];
    const file = new File([JSON.stringify({ version: 1, exportedAt: "x", entries: fileEntries })], "models.json", {
      type: "application/json",
    });
    const input = byTestId("models-import-file") as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    const preview = byTestId("models-import-preview")!;
    expect(preview.textContent).toContain("2 models in this file: 1 new, 1 already here");
    await click(byTestId("models-import-update"));
    await click(byTestId("models-import-confirm"));
    expect(mockApi.importCatalogue).toHaveBeenCalledWith(COMPANY, {
      version: 1,
      entries: [expect.objectContaining({ name: "Qwen coder" }), expect.objectContaining({ name: "maja LOCAL" })],
      onExisting: "update",
    });
    const result = byTestId("models-import-result")!;
    expect(result.textContent).toContain("Added 1 · Updated 1 · Skipped 1");
    expect(result.textContent).toContain("Skipped Broken one: The address is missing.");
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Import finished: 1 added, 1 updated, 1 skipped" }));
  });

  it("says plainly when an import file cannot be read", async () => {
    await render();
    const input = byTestId("models-import-file") as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["nope"], "x.json")] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(byTestId("models-import-error")!.textContent).toContain("not a list of models");
    expect(mockApi.importCatalogue).not.toHaveBeenCalled();
  });

  it("adds a model with its catalogue fields from the grouped dialog", async () => {
    mockApi.create.mockResolvedValue(ENTRY);
    await render();
    await click(buttonByText(container, "Add a model"));
    const dialog = byTestId("model-entry-dialog")!;
    for (const section of ["naming", "connection", "defaults", "details", "notes"]) {
      expect(byTestId(`model-entry-section-${section}`)).not.toBeNull();
    }
    expect(byTestId("model-entry-section-details")!.getAttribute("data-state")).toBe("closed");
    await typeInto(dialog.querySelector("#model-name") as HTMLInputElement, "Qwen on my PC");
    await typeInto(dialog.querySelector("#model-id") as HTMLInputElement, "qwen3:14b");
    await typeInto(dialog.querySelector("#model-maker") as HTMLInputElement, "Alibaba");
    await typeInto(dialog.querySelector("#model-tags") as HTMLInputElement, "Code, tools, code");
    expect(byTestId("model-tags-preview")!.textContent).toBe("codetools");
    await typeInto(dialog.querySelector("#model-note") as HTMLTextAreaElement, "Hello");
    expect(byTestId("model-note-counter")!.textContent).toBe("5 / 2000");
    await click(buttonByText(dialog, "Add model"));
    expect(mockApi.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({
        name: "Qwen on my PC",
        model: "qwen3:14b",
        maker: "Alibaba",
        baseModel: null,
        lane: null,
        tags: ["code", "tools"],
        specs: null,
        favorite: false,
        note: "Hello",
      }),
    );
  });

  it("blocks saving with a plain reason when a number is wrong", async () => {
    await render();
    await click(buttonByText(container, "Add a model"));
    const dialog = byTestId("model-entry-dialog")!;
    await typeInto(dialog.querySelector("#model-name") as HTMLInputElement, "X");
    await typeInto(dialog.querySelector("#model-id") as HTMLInputElement, "x");
    await typeInto(dialog.querySelector("#model-spec-size") as HTMLInputElement, "big");
    expect(byTestId("model-entry-issue")!.textContent).toContain("Download size");
    expect(buttonByText(dialog, "Add model")!.disabled).toBe(true);
  });
});

describe("helpers", () => {
  const base = { ...EMPTY_MODEL_FORM, name: "A", provider: "openrouter" as const, model: "m", baseUrl: "http://stale:1/v1" };
  it("drops a stale address when the provider does not use one", () => {
    expect(bodyFromForm(base).baseUrl).toBeNull();
    expect(bodyFromForm({ ...base, provider: "local" }).baseUrl).toBe("http://stale:1/v1");
  });
  it("sends the catalogue fields, null when empty and tags as a list", () => {
    const empty = bodyFromForm(base);
    expect(empty).toMatchObject({ maker: null, baseModel: null, lane: null, availability: null, tags: [], specs: null, favorite: false });
    const full = bodyFromForm({
      ...base,
      maker: " Google ",
      baseModel: "Gemma 3 27B",
      lane: "both",
      availability: "planned",
      tags: "Vision, vision, uncensored",
      favorite: true,
      temperature: "0,7",
      specs: { ...base.specs, params: "27B", sizeGb: "16,5", contextTokens: "131072", vision: "no", fitsLocalGpu: "tight" },
    });
    expect(full).toMatchObject({
      maker: "Google",
      baseModel: "Gemma 3 27B",
      lane: "both",
      availability: "planned",
      tags: ["vision", "uncensored"],
      favorite: true,
      defaultTemperature: 0.7,
      specs: { params: "27B", sizeGb: 16.5, contextTokens: 131072, vision: false, fitsLocalGpu: "tight" },
    });
  });
  it("explains refusals in plain English", () => {
    expect(modelErrorMessage(new ApiError("Forbidden", 403, null), "delete this model setup")).toBe(
      "Only the company owner or an admin can delete this model setup.",
    );
    expect(modelErrorMessage(new ApiError("dup", 409, null), "save")).toContain("already has that name");
  });
});
