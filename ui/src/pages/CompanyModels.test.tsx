// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { applyPrefill, EMPTY_MODEL_FORM } from "../components/ModelEntryDialog";
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
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  syncLocal: vi.fn(),
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
  family: null,
  variant: null,
  ratings: [],
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
    { id: "s1", name: "Local: Llama 3.2", provider: "local", note: "Runs on the model server", alreadyAdded: false },
    { id: "s2", name: "Mistral", provider: "openrouter", note: "Cloud", alreadyAdded: true },
  ]);
  mockRole.mockReturnValue({ canManageConnections: true, isLoading: false });
  mockApi.getSettings.mockResolvedValue({ localGpuVramGb: 12, localBaseUrl: null });
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
    mockApi.getSettings.mockResolvedValue({ localGpuVramGb: 12, localBaseUrl: "http://192.168.1.20:11434/v1" });
    mockApi.addStarters.mockResolvedValue({ created: [], skipped: [] });
    await render();
    expect(byTestId("models-starters-needs-address")).toBeNull();
    const add = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Add")!;
    await act(async () => add.click());
    expect(mockApi.addStarters).toHaveBeenCalledWith(COMPANY, ["s1"]);
  });

  it("asks for the model server address before a local starter can be added; cloud ones can be added now", async () => {
    mockApi.listStarters.mockResolvedValue([
      { id: "s1", name: "Local: Llama 3.2", provider: "local", note: "Local", alreadyAdded: false },
      { id: "s3", name: "Gemma cloud", provider: "openrouter", note: "Cloud", alreadyAdded: false },
    ]);
    mockApi.addStarters.mockResolvedValue({
      created: [ENTRY],
      skipped: [{ starterId: "s1", name: "Local: Llama 3.2", reason: "Set this company's model server address first." }],
    });
    await render();
    expect(byTestId("models-starters-needs-address")!.textContent).toContain("set the model server address");
    expect((byTestId("models-starter-add-s1") as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId("models-starter-add-s3") as HTMLButtonElement).disabled).toBe(false);
    await click(buttonByText(container, "Add all ready-made models"));
    expect(mockApi.addStarters).toHaveBeenCalledWith(COMPANY, undefined);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "1 model added", body: expect.stringContaining("model server address"), tone: "success" }),
    );
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
    for (const chip of ["Local · llama3.2", "Quick chat", "Installed", "#chat"]) expect(card.textContent).toContain(chip);
    expect(byTestId("models-counts")!.textContent).toBe("2 models · 1 local · 1 in the cloud · 1 archived");

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
        // Filled in from the model id: a known Qwen3 size, on the company's own PC address.
        family: "Qwen3",
        variant: "14B",
        baseUrl: "http://100.1.1.1:11434/v1",
        lane: "quick",
        availability: "planned",
        tags: ["code", "tools"],
        specs: expect.objectContaining({ params: "14B", quant: "Q4_K_M", pullCommand: "ollama pull qwen3:14b" }),
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

describe("CompanyModels catalogue v2", () => {
  const QWEN = {
    ...BASE,
    id: "66666666-6666-4666-8666-666666666666",
    name: "Qwen at home",
    provider: "local",
    model: "qwen3:14b",
    baseUrl: "http://100.1.1.1:11434/v1",
    availability: "installed",
    ratings: [
      { criterion: "Tool calling", score: 8 },
      { criterion: "Coding", score: 6 },
    ],
  };

  it("shows Maker > Model > Size with the sizes not saved yet, their install command and upgrades", async () => {
    mockApi.list.mockResolvedValue([QWEN, ENTRY]);
    await render();
    const alibaba = byTestId("models-group-maker-alibaba")!;
    expect(alibaba).not.toBeNull();
    const family = byTestId("models-family-maker-alibaba-qwen3")!;
    expect(family.textContent).toContain("Qwen3");
    // The saved size and a known size that is not saved yet.
    const fourteen = byTestId("models-size-maker-alibaba-qwen3-14b")!;
    expect(fourteen.textContent).toContain("Qwen at home");
    expect(fourteen.textContent).toContain("Installed on the model server");
    const eight = byTestId("models-size-maker-alibaba-qwen3-8b")!;
    expect(eight.textContent).toContain("ollama pull qwen3:8b");
    expect(eight.textContent).toContain("Add this way to run it");
    // Llama 3.2: the saved 3B and the 1B that is not saved.
    expect(byTestId("models-size-maker-meta-llama-3-2-1b")!.textContent).toContain("ollama pull llama3.2:1b");
    expect(byTestId(`model-runs-${ENTRY.id}`)!.textContent).toBe("Local · llama3.2");
    // 32B does not fit 12 GB: offered on OpenRouter as an upgrade.
    const upgrades = byTestId("models-upgrades-maker-alibaba-qwen3-14b")!;
    const big = byTestId("models-upgrade-alibaba-qwen3-32b")!;
    expect(upgrades.contains(big)).toBe(true);
    expect(big.textContent).toContain("too big for the graphics card");
    expect(big.textContent).toContain("deepinfra");

    mockApi.create.mockResolvedValue(QWEN);
    await click(buttonByText(big, "Add via OpenRouter"));
    const dialog = byTestId("model-entry-dialog")!;
    expect((dialog.querySelector("#model-name") as HTMLInputElement).value).toBe("Qwen3 32B via OpenRouter");
    expect((dialog.querySelector("#model-family") as HTMLInputElement).value).toBe("Qwen3");
    expect((dialog.querySelector("#model-variant") as HTMLInputElement).value).toBe("32B");
    await click(buttonByText(dialog, "Add model"));
    expect(mockApi.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({
        provider: "openrouter",
        model: "qwen/qwen3-32b",
        maker: "Alibaba",
        family: "Qwen3",
        variant: "32B",
        availability: "cloud",
        providerRouting: expect.objectContaining({ only: expect.arrayContaining(["deepinfra"]) }),
      }),
    );
  });

  it("adds a known local size with the company's own address", async () => {
    mockApi.list.mockResolvedValue([QWEN]);
    mockApi.create.mockResolvedValue(QWEN);
    await render();
    const eight = byTestId("models-size-maker-alibaba-qwen3-8b")!;
    const row = eight.querySelector('[data-testid="models-known-local-qwen3-8b"]')!;
    await click(buttonByText(row, "Add this way to run it"));
    const dialog = byTestId("model-entry-dialog")!;
    expect((dialog.querySelector("#model-address") as HTMLInputElement).value).toBe("http://100.1.1.1:11434/v1");
    await click(buttonByText(dialog, "Add model"));
    expect(mockApi.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ provider: "local", model: "qwen3:8b", baseUrl: "http://100.1.1.1:11434/v1", variant: "8B", availability: "planned" }),
    );
  });

  it("resyncs local Ollama models and offers to add installed ones that are not saved", async () => {
    mockApi.syncLocal.mockResolvedValue({
      baseUrl: "http://100.1.1.1:11434/v1",
      checkedAt: "2026-10-08T12:00:00Z",
      installed: [
        { name: "llama3.2:latest", sizeGb: 2, parameterSize: "3.2B", quantization: "Q4_K_M", family: "llama", entryIds: [ENTRY.id] },
        { name: "qwen3:8b", sizeGb: 5.2, parameterSize: "8.2B", quantization: "Q4_K_M", family: "qwen3", entryIds: [] },
      ],
      missingEntryIds: [],
      markedInstalledEntryIds: [ENTRY.id],
    });
    mockApi.create.mockResolvedValue(ENTRY);
    await render();
    await click(byTestId("models-resync"));
    expect(mockApi.syncLocal).toHaveBeenCalledWith(COMPANY, "http://100.1.1.1:11434/v1");
    const result = byTestId("models-resync-result")!;
    expect(byTestId("models-installed-llama3.2:latest")!.textContent).toContain("saved as Maja local");
    expect(byTestId("models-resync-marked-installed")!.textContent).toContain("Maja local");
    const qwenRow = byTestId("models-installed-qwen3:8b")!;
    expect(result.contains(qwenRow)).toBe(true);
    await click(buttonByText(qwenRow, "Add"));
    await click(buttonByText(byTestId("model-entry-dialog")!, "Add model"));
    expect(mockApi.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ provider: "local", model: "qwen3:8b", family: "Qwen3", variant: "8B", availability: "installed" }),
    );
  });

  it("picks the graphics card memory from common sizes, CPU only or Not set", async () => {
    mockApi.updateSettings.mockImplementation(async (_c: string, body: { localGpuVramGb: number | null }) => ({
      localGpuVramGb: body.localGpuVramGb,
      localBaseUrl: null,
    }));
    await render();
    const select = byTestId("models-gpu-select") as HTMLSelectElement;
    expect(select.value).toBe("12");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Not set",
      "No graphics card / CPU only",
      ...["4", "6", "8", "10", "12", "16", "20", "24", "32", "48", "64", "80"].map((n) => `${n} GB`),
      "Other…",
    ]);
    expect(byTestId("models-gpu-input")).toBeNull();
    await selectValue("models-gpu-select", "24");
    expect(mockApi.updateSettings).toHaveBeenLastCalledWith(COMPANY, { localGpuVramGb: 24 });
    await selectValue("models-gpu-select", "0");
    expect(mockApi.updateSettings).toHaveBeenLastCalledWith(COMPANY, { localGpuVramGb: 0 });
    await selectValue("models-gpu-select", "unset");
    expect(mockApi.updateSettings).toHaveBeenLastCalledWith(COMPANY, { localGpuVramGb: null });
    // Help says what it is and where to find it.
    await click(byTestId("help-graphics-card-memory"));
    const help = byTestId("models-gpu")!.textContent!;
    for (const words of ["Task Manager > Performance > GPU > Dedicated GPU memory", "two thirds", "nvidia-smi", "this company only"]) {
      expect(help).toContain(words);
    }
  });

  it("takes any other graphics card size typed under Other…", async () => {
    mockApi.updateSettings.mockResolvedValue({ localGpuVramGb: 11, localBaseUrl: null });
    await render();
    await selectValue("models-gpu-select", "other");
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
    const input = byTestId("models-gpu-input") as HTMLInputElement;
    await typeInto(input, "lots");
    expect(container.textContent).toContain("Type the memory in GB as a number above 0");
    await typeInto(input, "11");
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();
    expect(mockApi.updateSettings).toHaveBeenCalledWith(COMPANY, { localGpuVramGb: 11 });
  });

  it("shows a saved size that is not in the list under Other…", async () => {
    mockApi.getSettings.mockResolvedValue({ localGpuVramGb: 7.5, localBaseUrl: null });
    await render();
    expect((byTestId("models-gpu-select") as HTMLSelectElement).value).toBe("other");
    expect((byTestId("models-gpu-input") as HTMLInputElement).value).toBe("7.5");
  });

  it("never guesses a graphics card: Not set by default, and fit advice asks for it", async () => {
    mockApi.getSettings.mockResolvedValue({ localGpuVramGb: null, localBaseUrl: null });
    await render();
    expect((byTestId("models-gpu-select") as HTMLSelectElement).value).toBe("unset");
    const tree = byTestId("models-list")!;
    expect(tree.textContent).toContain("Set your graphics card memory above to see what fits.");
    expect(tree.textContent).not.toMatch(/Fits the graphics card|Too big for the graphics card|you have 12 GB/);
  });

  it("shows the settings read-only, with a plain note, to someone who may not manage", async () => {
    mockRole.mockReturnValue({ canManageConnections: false, isLoading: false });
    mockApi.getSettings.mockResolvedValue({ localGpuVramGb: 0, localBaseUrl: "http://192.168.1.20:11434/v1" });
    await render();
    expect(byTestId("models-gpu-select")).toBeNull();
    expect(byTestId("models-address-input")).toBeNull();
    expect(byTestId("models-gpu-readonly")!.textContent).toContain("No graphics card (CPU only)");
    expect(byTestId("models-address-readonly")!.textContent).toContain("http://192.168.1.20:11434/v1");
    expect(byTestId("models-read-only-note")!.textContent).toContain("Only the company owner or an admin");
  });

  it("saves the model server address, refuses a malformed one and warns about localhost", async () => {
    mockApi.updateSettings.mockResolvedValue({ localGpuVramGb: 12, localBaseUrl: "http://192.168.1.20:11434/v1" });
    await render();
    const input = byTestId("models-address-input") as HTMLInputElement;
    expect(input.value).toBe("");
    const blur = async () => {
      await act(async () => {
        input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      });
      await flush();
    };
    await typeInto(input, "192.168.1.20:11434");
    await blur();
    expect(byTestId("models-address-issue")).not.toBeNull();
    await typeInto(input, "http://user:pw@192.168.1.20:11434/v1");
    await blur();
    expect(byTestId("models-address-issue")).not.toBeNull();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
    await typeInto(input, "http://localhost:11434/v1");
    expect(byTestId("models-address-loopback")).not.toBeNull();
    await typeInto(input, "http://192.168.1.20:11434/v1");
    expect(byTestId("models-address-issue")).toBeNull();
    await blur();
    expect(mockApi.updateSettings).toHaveBeenCalledWith(COMPANY, { localBaseUrl: "http://192.168.1.20:11434/v1" });
  });

  it("asks for the model server address instead of using a built-in one for local options and the add dialog", async () => {
    mockApi.list.mockResolvedValue([GEMMA]);
    await render();
    // A new local model in the dialog: no address filled in, a plain request, and it cannot be saved yet.
    await click(buttonByText(container, "Add a model"));
    const dialog = byTestId("model-entry-dialog")!;
    await typeInto(dialog.querySelector("#model-name") as HTMLInputElement, "Qwen");
    await typeInto(dialog.querySelector("#model-id") as HTMLInputElement, "qwen3:14b");
    expect((dialog.querySelector("#model-address") as HTMLInputElement).value).toBe("");
    expect(byTestId("model-entry-needs-address")!.textContent).toContain("no model server address yet");
    expect(byTestId("model-entry-issue")!.textContent).toContain("Type the address of the model server");
    expect(buttonByText(dialog, "Add model")!.disabled).toBe(true);
    expect(container.textContent).not.toContain("100.124.232.68");
  });

  it("starts a new local model from the company's model server address", async () => {
    mockApi.list.mockResolvedValue([GEMMA]);
    mockApi.getSettings.mockResolvedValue({ localGpuVramGb: 12, localBaseUrl: "http://192.168.1.20:11434/v1" });
    await render();
    await click(buttonByText(container, "Add a model"));
    const dialog = byTestId("model-entry-dialog")!;
    await typeInto(dialog.querySelector("#model-id") as HTMLInputElement, "qwen3:14b");
    expect((dialog.querySelector("#model-address") as HTMLInputElement).value).toBe("http://192.168.1.20:11434/v1");
    expect(byTestId("model-entry-issue")).toBeNull();
  });

  it("asks for the address instead of resyncing when the company has no local address at all", async () => {
    mockApi.list.mockResolvedValue([GEMMA]);
    await render();
    await click(byTestId("models-resync"));
    expect(mockApi.syncLocal).not.toHaveBeenCalled();
    expect(byTestId("models-resync-needs-address")!.textContent).toContain("Set the model server address above first");
  });

  it("resyncs at the company's model server address when no local model is saved yet", async () => {
    mockApi.list.mockResolvedValue([GEMMA]);
    mockApi.getSettings.mockResolvedValue({ localGpuVramGb: 12, localBaseUrl: "http://192.168.1.20:11434/v1" });
    mockApi.syncLocal.mockResolvedValue({
      baseUrl: "http://192.168.1.20:11434/v1",
      checkedAt: "2026-10-08T12:00:00Z",
      installed: [],
      missingEntryIds: [],
      markedInstalledEntryIds: [],
    });
    await render();
    await click(byTestId("models-resync"));
    expect(mockApi.syncLocal).toHaveBeenCalledWith(COMPANY, "http://192.168.1.20:11434/v1");
  });

  it("shows scores, filters by 'best for' and edits scores", async () => {
    mockApi.list.mockResolvedValue([QWEN, ENTRY, GEMMA]);
    mockApi.update.mockResolvedValue(QWEN);
    await render();
    const scores = byTestId(`model-ratings-${QWEN.id}`)!;
    expect(scores.textContent).toContain("Tool calling 8");
    expect(scores.textContent).toContain("Coding 6");
    expect(scores.textContent).toContain("average 7");

    await selectValue("models-filter-criterion", "Coding");
    expect(shownNames()).toEqual(["Qwen at home"]);
    expect((byTestId("models-sort") as HTMLSelectElement).value).toBe("rating");
    await click(byTestId("models-clear-filters"));
    expect(shownNames()).toHaveLength(3);

    await click(buttonByText(byTestId(`model-card-${QWEN.id}`)!, "Edit"));
    const dialog = byTestId("model-entry-dialog")!;
    expect((byTestId("model-rating-criterion-0") as HTMLInputElement).value).toBe("Tool calling");
    await click(byTestId("model-rating-add"));
    await typeInto(byTestId("model-rating-criterion-2") as HTMLInputElement, "Responsiveness");
    await typeInto(byTestId("model-rating-score-2") as HTMLInputElement, "4");
    await click(buttonByText(dialog, "Save changes"));
    const body = mockApi.update.mock.calls.at(-1)![2];
    expect(body.ratings.map((r: { criterion: string; score: number }) => `${r.criterion} ${r.score}`)).toEqual([
      "Tool calling 8",
      "Coding 6",
      "Responsiveness 4",
    ]);
  });

  it("lets an owner edit every catalogue value of a saved setup, OpenRouter hosts included", async () => {
    const ROUTED = {
      ...BASE,
      id: "55555555-5555-4555-8555-555555555555",
      name: "Qwen routed",
      provider: "openrouter",
      model: "qwen/qwen3-32b",
      baseUrl: null,
      providerRouting: { only: ["deepinfra"], order: ["deepinfra"], ignore: [] },
      maker: "Alibaba Qwen",
      family: "Qwen3",
      variant: "32B",
      lane: "quick",
      availability: "cloud",
      tags: ["tools"],
      specs: { params: "32B", tools: "yes" },
    };
    mockApi.list.mockResolvedValue([ROUTED]);
    mockApi.update.mockResolvedValue(ROUTED);
    await render();
    await click(buttonByText(byTestId(`model-card-${ROUTED.id}`)!, "Edit"));
    const dialog = () => byTestId("model-entry-dialog")!;
    const field = (id: string) => dialog().querySelector(`#${id}`) as HTMLInputElement;
    expect(field("model-hosts").value).toBe("deepinfra");
    // Saving untouched keeps the saved routing exactly.
    await click(buttonByText(dialog(), "Save changes"));
    expect(mockApi.update.mock.calls.at(-1)![2].providerRouting).toEqual(ROUTED.providerRouting);

    await click(buttonByText(byTestId(`model-card-${ROUTED.id}`)!, "Edit"));
    for (const [id, value] of [
      ["model-maker", "Qwen team"],
      ["model-family", "Qwen3 tuned"],
      ["model-variant", "32B fast"],
      ["model-tags", "tools, fast"],
      ["model-hosts", "Together, deepinfra"],
    ] as const) {
      await typeInto(field(id), value);
    }
    await click(buttonByText(dialog(), "Save changes"));
    expect(mockApi.update.mock.calls.at(-1)![2]).toMatchObject({
      maker: "Qwen team",
      family: "Qwen3 tuned",
      variant: "32B fast",
      tags: ["tools", "fast"],
      providerRouting: { only: ["together", "deepinfra"], order: ["deepinfra"], ignore: [] },
    });
    // Every field in the dialog explains itself.
    await click(buttonByText(byTestId(`model-card-${ROUTED.id}`)!, "Edit"));
    const helps = dialog().querySelectorAll("[data-testid^=help-]");
    expect(helps.length).toBeGreaterThanOrEqual(20);
  });

  it("blocks two scores with the same name", async () => {
    await render();
    await click(buttonByText(container, "Add a model"));
    await click(byTestId("model-rating-add"));
    await click(byTestId("model-rating-add"));
    await typeInto(byTestId("model-rating-criterion-0") as HTMLInputElement, "Coding");
    await typeInto(byTestId("model-rating-criterion-1") as HTMLInputElement, "coding");
    expect(byTestId("model-entry-issue")!.textContent).toContain("two scores");
  });

  it("fills in the maker when a known model family is typed", async () => {
    await render();
    await click(buttonByText(container, "Add a model"));
    const dialog = byTestId("model-entry-dialog")!;
    await typeInto(dialog.querySelector("#model-family") as HTMLInputElement, "Llama 3.2");
    expect((dialog.querySelector("#model-maker") as HTMLInputElement).value).toBe("Meta");
    const sizes = Array.from(dialog.querySelectorAll("#model-variant-options option")).map((o) => (o as HTMLOptionElement).value);
    expect(sizes).toEqual(["1B", "3B"]);
  });
});

describe("add dialog prefill", () => {
  const dialogInput = (id: string) => byTestId("model-entry-dialog")!.querySelector(`#${id}`) as HTMLInputElement;

  it("offers Claude's models and fills in a finished Claude setup", async () => {
    mockApi.create.mockResolvedValue(ENTRY);
    await render();
    await click(buttonByText(container, "Add a model"));
    const provider = dialogInput("model-provider") as unknown as HTMLSelectElement;
    await act(async () => {
      provider.value = "anthropic";
      provider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    const model = dialogInput("model-id") as unknown as HTMLSelectElement;
    expect(model.tagName).toBe("SELECT");
    expect(model.value).toBe("claude-sonnet-5");
    expect(Array.from(model.options).map((o) => o.value)).toEqual(
      expect.arrayContaining(["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"]),
    );
    expect(dialogInput("model-name").value).toBe("Claude Sonnet 5");
    expect(dialogInput("model-maker").value).toBe("Anthropic");
    expect(dialogInput("model-family").value).toBe("Claude Sonnet");
    expect(dialogInput("model-variant").value).toBe("5");
    expect(byTestId("model-entry-dialog")!.textContent).toContain("No key needed");

    // Another model: the automatic name follows.
    await act(async () => {
      model.value = "claude-opus-5";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(dialogInput("model-name").value).toBe("Claude Opus 5");
    // A name typed by the person is never overwritten.
    await typeInto(dialogInput("model-name"), "Boss brain");
    await act(async () => {
      model.value = "claude-haiku-4-5";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(dialogInput("model-name").value).toBe("Boss brain");
    expect(dialogInput("model-variant").value).toBe("4.5");

    await click(buttonByText(byTestId("model-entry-dialog")!, "Add model"));
    expect(mockApi.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({
        name: "Boss brain",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        maker: "Anthropic",
        family: "Claude Haiku",
        variant: "4.5",
        lane: "both",
        availability: "cloud",
        baseUrl: null,
        providerRouting: null,
        specs: expect.objectContaining({ tools: "yes", vision: true }),
      }),
    );
  });

  it("fills OpenRouter hosts with tool calling but keeps a maker the person typed", async () => {
    mockApi.create.mockResolvedValue(ENTRY);
    await render();
    await click(buttonByText(container, "Add a model"));
    const provider = dialogInput("model-provider") as unknown as HTMLSelectElement;
    await act(async () => {
      provider.value = "openrouter";
      provider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    const options = Array.from(byTestId("model-entry-dialog")!.querySelectorAll("#model-id-options option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toContain("qwen/qwen3-32b");
    await typeInto(dialogInput("model-maker"), "Qwen team");
    await typeInto(dialogInput("model-id"), "qwen/qwen3-32b");
    expect(dialogInput("model-maker").value).toBe("Qwen team");
    expect(dialogInput("model-family").value).toBe("Qwen3");
    expect(dialogInput("model-variant").value).toBe("32B");
    expect(byTestId("model-entry-hosts")!.textContent).toContain("deepinfra");
    await click(buttonByText(byTestId("model-entry-dialog")!, "Add model"));
    expect(mockApi.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({
        name: "Qwen3 32B via OpenRouter",
        maker: "Qwen team",
        availability: "cloud",
        providerRouting: expect.objectContaining({ only: expect.arrayContaining(["deepinfra"]) }),
      }),
    );
  });

  it("suggests the tags the last resync found installed and marks them installed", async () => {
    mockApi.syncLocal.mockResolvedValue({
      baseUrl: "http://100.1.1.1:11434/v1",
      checkedAt: "2026-10-08T12:00:00Z",
      installed: [{ name: "mystery:7b", sizeGb: 4, parameterSize: "7B", quantization: "Q4_0", family: null, entryIds: [] }],
      missingEntryIds: [],
      markedInstalledEntryIds: [],
    });
    await render();
    await click(byTestId("models-resync"));
    await click(buttonByText(container, "Add a model"));
    const first = byTestId("model-entry-dialog")!.querySelector("#model-id-options option") as HTMLOptionElement;
    expect(first.value).toBe("mystery:7b");
    expect(first.textContent).toBe("Installed on the model server");
    await typeInto(dialogInput("model-id"), "mystery:7b");
    expect((dialogInput("model-availability") as unknown as HTMLSelectElement).value).toBe("installed");
    expect(dialogInput("model-address").value).toBe("http://100.1.1.1:11434/v1");
    expect(dialogInput("model-name").value).toBe("mystery:7b (local)");
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
  it("prefills only empty or automatically filled fields, and clears stale automatic ones", () => {
    const first = applyPrefill(
      { ...EMPTY_MODEL_FORM, maker: "Mine" },
      { name: "A", maker: "Meta", family: "Llama 3.2", specs: { params: "3B", tools: "yes" } },
      new Set(),
    );
    expect(first.form).toMatchObject({ name: "A", maker: "Mine", family: "Llama 3.2" });
    expect(first.form.specs).toMatchObject({ params: "3B", tools: "yes" });
    const second = applyPrefill(first.form, { name: "B", specs: { params: "7B" } }, first.auto);
    expect(second.form).toMatchObject({ name: "B", maker: "Mine", family: "" });
    expect(second.form.specs).toMatchObject({ params: "7B", tools: "" });
  });
  it("explains refusals in plain English", () => {
    expect(modelErrorMessage(new ApiError("Forbidden", 403, null), "delete this model setup")).toBe(
      "Only the company owner or an admin can delete this model setup.",
    );
    expect(modelErrorMessage(new ApiError("dup", 409, null), "save")).toContain("already has that name");
  });
});
