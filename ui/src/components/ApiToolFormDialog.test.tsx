// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiToolFormDialog, draftToInput, emptyApiToolDraft } from "./ApiToolFormDialog";
import type { ApiTool } from "../api/apiTools";

/**
 * DUR-4004: the "API with a key" form. Plain fields, the shared secret
 * picker for the key, three ways of sending it, an action editor and an
 * OpenAPI import; a saved tool gets a Test button and its last-test line.
 * The key value is never part of what the form sends.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const SECRET = "22222222-2222-4222-8222-222222222222";

const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), test: vi.fn() }));
const mockApiToolsApi = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), test: vi.fn(), importOpenApi: vi.fn() }));
const mockUseCompanyRole = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY, selectedCompany: { id: COMPANY, name: "Nordstrand" } }),
}));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));
vi.mock("../hooks/useCompanyRole", () => ({ useCompanyRole: mockUseCompanyRole }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../api/apiTools", () => ({ apiToolsApi: mockApiToolsApi }));
vi.mock("./SecretKindSelect", () => ({
  SecretKindSelect: ({ id }: { id?: string }) => <select id={id} data-testid="kind-select" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const savedTool: ApiTool = {
  id: "t1",
  companyId: COMPANY,
  name: "Fal.ai",
  key: "fal-ai",
  description: "Makes images",
  baseUrl: "https://fal.run",
  auth: { kind: "header", name: "Authorization", prefix: "Key ", secretId: SECRET },
  actions: [
    { name: "make_image", method: "POST", path: "/fal-ai/flux/dev", description: "Make an image", inputs: [{ name: "prompt", type: "string", required: true }] },
  ],
  openapiUrl: null,
  dailyCap: 300,
  status: "active",
  lastTestAt: "2026-09-27T10:00:00.000Z",
  lastTestOk: false,
  lastTestMessage: "fal.run answered 401: the key was not accepted.",
  createdAt: "2026-09-27T10:00:00.000Z",
  updatedAt: "2026-09-27T10:00:00.000Z",
};

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, next: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(element, next);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(element: HTMLSelectElement, next: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(element, next);
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("ApiToolFormDialog", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSecretsApi.list.mockResolvedValue([
      { id: SECRET, name: "Fal key", key: "FAL_KEY", status: "active", provider: "local_encrypted", kind: "other", latestVersion: 1 },
    ]);
    mockUseCompanyRole.mockReturnValue({ role: "owner", isInstanceAdmin: false, localBoard: false, canManageConnections: true, isLoading: false });
    mockApiToolsApi.create.mockResolvedValue(savedTool);
    mockApiToolsApi.update.mockResolvedValue(savedTool);
    mockApiToolsApi.test.mockResolvedValue({ ok: true, status: 200, message: "fal.run answered 200. The key was accepted." });
    mockApiToolsApi.importOpenApi.mockResolvedValue({
      title: "Fal",
      baseUrl: "https://fal.run",
      actions: [
        { name: "flux", method: "POST", path: "/fal-ai/flux/dev", description: "Flux image", inputs: [{ name: "prompt", type: "string", required: true }] },
        { name: "status", method: "GET", path: "/requests/{id}", description: "", inputs: [{ name: "id", type: "string", required: true }] },
      ],
      skipped: 1,
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

  const onSaved = vi.fn();
  const onOpenChange = vi.fn();

  async function render(tool: ApiTool | null) {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const current = root;
    await act(async () => {
      current.render(
        <QueryClientProvider client={queryClient}>
          <ApiToolFormDialog open tool={tool} onOpenChange={onOpenChange} onSaved={onSaved} />
        </QueryClientProvider>,
      );
    });
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog, "dialog").not.toBeNull();
    return dialog!;
  }

  function button(dialog: HTMLElement, label: string): HTMLButtonElement {
    const match = Array.from(dialog.querySelectorAll("button")).find((element) => element.textContent?.trim() === label);
    expect(match, `button "${label}"`).toBeDefined();
    return match as HTMLButtonElement;
  }

  it("shows plain fields with Fal.ai and Fiken examples, the secret picker with inline add, and three ways of sending the key", async () => {
    const dialog = await render(null);
    expect(dialog.textContent).toContain("Add API with a key");
    expect(dialog.querySelector<HTMLInputElement>("#api-tool-name")!.placeholder).toBe("e.g. Fal.ai");
    expect(dialog.querySelector<HTMLInputElement>("#api-tool-base-url")!.placeholder).toBe("https://fal.run");
    expect(dialog.textContent).toContain("Fal.ai: https://fal.run — Fiken: https://api.fiken.no/api/v2");
    const picker = dialog.querySelector<HTMLSelectElement>("select");
    expect(Array.from(picker!.options).map((option) => option.textContent?.trim())).toEqual([
      "Pick the saved secret that holds the key",
      "Fal key — local encrypted",
      "Add new secret…",
    ]);
    expect(dialog.textContent).toContain("How the key is sent");
    expect(button(dialog, "Authorization: Bearer").getAttribute("aria-pressed")).toBe("true");
    expect(dialog.textContent).toContain("Fiken and most modern APIs use this.");
    expect(dialog.textContent).toContain("Save the tool, then open it again to test it.");
    expect(button(dialog, "Save").disabled).toBe(true);
    expect(dialog.textContent).not.toContain("JSON");
  });

  it("asks for the header name and the text before the key for a header, and the parameter name for a query", async () => {
    const dialog = await render(null);
    await act(async () => button(dialog, "A header").click());
    await flush();
    expect(dialog.querySelector('input[aria-label="Header name"]')).not.toBeNull();
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Text before the key"]')!.placeholder).toBe('Text before the key, e.g. "Key "');
    expect(dialog.textContent).toContain("Fal.ai: header “Authorization”, text before the key “Key ” (with the space).");
    await act(async () => button(dialog, "A query parameter").click());
    await flush();
    expect(dialog.querySelector('input[aria-label="Header name"]')).toBeNull();
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Parameter name"]')!.placeholder).toBe("Parameter name, e.g. api_key");
  });

  it("builds the tool from the fields and sends it without any key value; imported actions can be unticked", async () => {
    const dialog = await render(null);
    setInputValue(dialog.querySelector("#api-tool-name")!, "Fal.ai");
    setInputValue(dialog.querySelector("#api-tool-description")!, "Makes images");
    setInputValue(dialog.querySelector("#api-tool-base-url")!, "https://fal.run");
    setSelectValue(dialog.querySelector("select")!, SECRET);
    await act(async () => button(dialog, "A header").click());
    await flush();
    setInputValue(dialog.querySelector('input[aria-label="Header name"]')!, "Authorization");
    setInputValue(dialog.querySelector('input[aria-label="Text before the key"]')!, "Key ");
    setInputValue(dialog.querySelector("#api-tool-daily-cap")!, "50");

    // Import from an OpenAPI address adds the actions as rows.
    setInputValue(dialog.querySelector('input[aria-label="OpenAPI address"]')!, "https://fal.run/openapi.json");
    await act(async () => button(dialog, "Import").click());
    await flush();
    expect(mockApiToolsApi.importOpenApi).toHaveBeenCalledWith(COMPANY, "https://fal.run/openapi.json");
    expect(dialog.querySelectorAll('[data-testid="action-row"]')).toHaveLength(2);
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "2 actions imported" }));

    // Untick the second one, add one by hand with one input.
    const keepBoxes = dialog.querySelectorAll<HTMLButtonElement>('[aria-label="Keep this action"]');
    await act(async () => keepBoxes[1]!.click());
    await flush();
    await act(async () => button(dialog, "Add action").click());
    await flush();
    const rows = dialog.querySelectorAll<HTMLElement>('[data-testid="action-row"]');
    expect(rows).toHaveLength(3);
    const manual = rows[2]!;
    setInputValue(manual.querySelector('input[aria-label="Action name"]')!, "get_status");
    setSelectValue(manual.querySelector<HTMLSelectElement>('select[aria-label="Method"]')!, "GET");
    setInputValue(manual.querySelector('input[aria-label="Path"]')!, "/status/{id}");
    setInputValue(manual.querySelector('input[aria-label="What this action does"]')!, "Check a request");
    await act(async () => button(manual, "Add input").click());
    await flush();
    const inputRow = manual.querySelector<HTMLElement>('[data-testid="input-row"]')!;
    setInputValue(inputRow.querySelector('input[aria-label="Input name"]')!, "id");
    setSelectValue(inputRow.querySelector<HTMLSelectElement>('select[aria-label="Input type"]')!, "integer");
    await act(async () => inputRow.querySelector<HTMLButtonElement>('button[role="checkbox"]')!.click());
    await flush();

    const save = button(dialog, "Save");
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    await flush();
    expect(mockApiToolsApi.create).toHaveBeenCalledTimes(1);
    const [companyId, payload] = mockApiToolsApi.create.mock.calls[0]!;
    expect(companyId).toBe(COMPANY);
    expect(payload).toEqual({
      name: "Fal.ai",
      description: "Makes images",
      baseUrl: "https://fal.run",
      auth: { kind: "header", secretId: SECRET, name: "Authorization", prefix: "Key " },
      actions: [
        { name: "flux", method: "POST", path: "/fal-ai/flux/dev", description: "Flux image", inputs: [{ name: "prompt", type: "string", required: true }] },
        { name: "get_status", method: "GET", path: "/status/{id}", description: "Check a request", inputs: [{ name: "id", type: "integer", required: true }] },
      ],
      openapiUrl: "https://fal.run/openapi.json",
      dailyCap: 50,
      status: "active",
    });
    expect(JSON.stringify(payload)).not.toMatch(/value|apiKey/);
    expect(onSaved).toHaveBeenCalledWith(savedTool);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("for a saved tool shows its fields, the Test button and the last-test line; Test reports the answer in plain words", async () => {
    const dialog = await render(savedTool);
    expect(dialog.textContent).toContain("Edit API with a key");
    expect(dialog.querySelector<HTMLInputElement>("#api-tool-name")!.value).toBe("Fal.ai");
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Text before the key"]')!.value).toBe("Key ");
    expect(dialog.querySelectorAll('[data-testid="action-row"]')).toHaveLength(1);
    expect(dialog.querySelector('[data-testid="last-test-line"]')!.textContent).toContain("Last test failed");
    expect(dialog.querySelector('[data-testid="last-test-line"]')!.textContent).toContain("fal.run answered 401: the key was not accepted.");
    await act(async () => button(dialog, "Test").click());
    await flush();
    expect(mockApiToolsApi.test).toHaveBeenCalledWith(COMPANY, "t1");
    expect(dialog.querySelector('[data-testid="last-test-line"]')!.textContent).toBe("Test passed: fal.run answered 200. The key was accepted.");
    await act(async () => button(dialog, "Save").click());
    await flush();
    expect(mockApiToolsApi.update).toHaveBeenCalledWith(COMPANY, "t1", expect.objectContaining({ name: "Fal.ai", auth: savedTool.auth }));
  });

  it("draftToInput keeps only ticked actions with a name and drops a bearer prefix", () => {
    const draft = emptyApiToolDraft();
    draft.name = " Fiken ";
    draft.baseUrl = "https://api.fiken.no/api/v2";
    draft.secretId = SECRET;
    draft.authKind = "bearer";
    draft.authPrefix = "ignored";
    draft.dailyCap = "abc";
    draft.actions = [
      { id: "1", include: true, name: "list", method: "GET", path: "/invoices", description: "", inputs: [{ id: "i", name: "", type: "string", required: false, description: "" }] },
      { id: "2", include: false, name: "drop", method: "GET", path: "/x", description: "", inputs: [] },
      { id: "3", include: true, name: "   ", method: "GET", path: "/y", description: "", inputs: [] },
    ];
    expect(draftToInput(draft)).toEqual({
      name: "Fiken",
      description: "",
      baseUrl: "https://api.fiken.no/api/v2",
      auth: { kind: "bearer", secretId: SECRET },
      actions: [{ name: "list", method: "GET", path: "/invoices", description: "", inputs: [] }],
      openapiUrl: null,
      dailyCap: 300,
      status: "active",
    });
  });
});
