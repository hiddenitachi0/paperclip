// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockHelperApi = vi.hoisted(() => ({
  ask: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("../../api/helper", () => ({ helperApi: mockHelperApi }));
vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", name: "Acme" } }),
}));
vi.mock("../MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));

import { HelperOverlay, isHelperShortcut } from "./HelperOverlay";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("HelperOverlay", () => {
  it("recognises Ctrl/Cmd+Shift+H only", () => {
    expect(isHelperShortcut({ key: "H", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe(true);
    expect(isHelperShortcut({ key: "h", ctrlKey: false, metaKey: true, shiftKey: true, altKey: false })).toBe(true);
    expect(isHelperShortcut({ key: "h", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
    expect(isHelperShortcut({ key: "h", ctrlKey: true, metaKey: false, shiftKey: true, altKey: true })).toBe(false);
  });

  it("opens on the shortcut, shows what will be sent, and asks with the page address and default model", async () => {
    mockHelperApi.getSettings.mockResolvedValue({
      defaultDirectoryEntryId: null,
      investigationAgentId: null,
      keys: [],
      models: [{ id: "m1", name: "Fast one", provider: "openrouter", providerLabel: "OpenRouter", model: "x/y", maker: "Acme AI", baseModel: null, lane: "quick", favorite: false, keyReady: false, keyHint: "needs key" }],
      builtInDefaultLabel: "Claude",
      canEdit: true,
      updatedAt: null,
    });
    mockHelperApi.ask.mockResolvedValue({ answer: "Step 1. Do it.", directoryEntryId: null, modelLabel: "Claude", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1, costCents: 0, truncated: false });

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/ACM/dashboard/now"]}>
            <HelperOverlay />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    expect(document.querySelector("[data-testid=helper-panel]")).toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "H", ctrlKey: true, shiftKey: true }));
    });
    await flush();
    expect(document.querySelector("[data-testid=helper-panel]")).not.toBeNull();
    expect(document.querySelector("[data-testid=helper-sees]")?.textContent).toContain("/ACM/dashboard/now");
    const modelSelect = document.querySelector("[data-testid=helper-model]") as HTMLSelectElement;
    expect(modelSelect.textContent).toContain("Fast one (needs a key)");
    expect(modelSelect.querySelector("optgroup")?.getAttribute("label")).toBe("Acme AI");

    const textarea = document.querySelector("textarea[aria-label='Your question']") as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Should I approve this?");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (document.querySelector("button[aria-label=Send]") as HTMLButtonElement).click();
    });
    await flush();
    expect(mockHelperApi.ask).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ message: "Should I approve this?", pageRoute: "/ACM/dashboard/now", directoryEntryId: null, history: [] }),
    );
    expect(document.querySelector("[data-testid=helper-answer]")?.textContent).toContain("Step 1. Do it.");
  });
});
