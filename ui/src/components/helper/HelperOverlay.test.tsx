// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HelperSettingsView } from "@paperclipai/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockHelperApi = vi.hoisted(() => ({
  ask: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  listInvestigations: vi.fn(async () => ({ investigations: [], availability: null })),
  startInvestigation: vi.fn(),
}));
vi.mock("../../api/helper", () => ({ helperApi: mockHelperApi }));
const authState = vi.hoisted(() => ({ userId: "u1" as string | null }));
vi.mock("../../api/auth", () => ({
  authApi: {
    getSession: vi.fn(async () =>
      authState.userId ? { session: { id: `s-${authState.userId}`, userId: authState.userId }, user: { id: authState.userId, email: null, name: null, image: null } } : null,
    ),
  },
}));
const companyState = vi.hoisted(() => ({ id: "c1", name: "Acme" }));
vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: companyState.id, selectedCompany: { id: companyState.id, name: companyState.name } }),
}));
vi.mock("../MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));

import { HelperOverlay, isHelperShortcut } from "./HelperOverlay";
import { ApiError } from "../../api/client";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";

const ready = { kind: "paperclip_key", label: "Paperclip's key", detail: "Runs on Paperclip's own Claude key.", tone: "ok" } as const;

function settings(overrides: Partial<HelperSettingsView> = {}): HelperSettingsView {
  return {
    defaultDirectoryEntryId: null,
    investigationAgentId: null,
    investigationMaxRunning: 3,
    investigationMaxPerDay: 20,
    investigationCompanyMaxPerDay: 50,
    investigationAgent: null,
    keys: [],
    models: [
      {
        id: "m1",
        name: "Fast one",
        provider: "openrouter",
        providerLabel: "OpenRouter",
        model: "x/y",
        maker: "Acme AI",
        baseModel: null,
        lane: "quick",
        favorite: false,
        keyReady: false,
        keyHint: "needs key",
        canSeePictures: null,
        picturesSource: "unknown",
        status: { kind: "needs_key", label: "Needs a key", detail: "needs key", tone: "fail" },
      },
    ],
    builtInDefaultLabel: "Claude",
    builtInDefaultCanSeePictures: true,
    builtInDefaultStatus: ready,
    canEdit: true,
    updatedAt: null,
    ...overrides,
  } as HelperSettingsView;
}

function answer(text: string) {
  return { answer: text, directoryEntryId: null, modelLabel: "Claude", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1, costCents: 0, truncated: false };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let navigateTo: ((to: string) => void) | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  navigateTo = null;
  window.sessionStorage.clear();
  companyState.id = "c1";
  companyState.name = "Acme";
  authState.userId = "u1";
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function NavigateProbe() {
  navigateTo = useNavigate();
  return null;
}

function render(extra: React.ReactNode = null) {
  // jsdom has no layout: give every element a box on screen so "the visible page" has something in it.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 10, top: 10, width: 200, height: 40, right: 210, bottom: 50, x: 10, y: 10, toJSON: () => ({}),
  } as DOMRect);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/ACM/dashboard/now"]}>
          <main id="main-content">
            <h1>Now</h1>
            <p>Deploy card for the shop</p>
          </main>
          {extra}
          <NavigateProbe />
          <HelperOverlay />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}

function rerenderSame() {
  // A "reload": everything React held is gone, the browser tab's storage is not.
  act(() => root?.unmount());
  host?.remove();
  render();
}

async function openPanel() {
  // The helper appears once it knows who is signed in.
  await flush();
  const opener = document.querySelector("[data-testid=helper-open]") as HTMLButtonElement | null;
  if (opener) act(() => opener.click());
  await flush();
}

function textarea() {
  return document.querySelector("textarea[aria-label='Your question']") as HTMLTextAreaElement;
}

function type(text: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea(), text);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

async function ask(text: string) {
  type(text);
  await click(document.querySelector("button[aria-label=Send]"));
}

describe("HelperOverlay", () => {
  it("recognises Ctrl/Cmd+Shift+H only", () => {
    expect(isHelperShortcut({ key: "H", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe(true);
    expect(isHelperShortcut({ key: "h", ctrlKey: false, metaKey: true, shiftKey: true, altKey: false })).toBe(true);
    expect(isHelperShortcut({ key: "h", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(false);
    expect(isHelperShortcut({ key: "h", ctrlKey: true, metaKey: false, shiftKey: true, altKey: true })).toBe(false);
  });

  it("opens on the shortcut, shows what will be sent, and asks with the page address and default model", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.ask.mockResolvedValue(answer("Step 1. Do it."));
    render();
    await flush();
    expect(document.querySelector("[data-testid=helper-panel]")).toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "H", ctrlKey: true, shiftKey: true }));
    });
    await flush();
    expect(document.querySelector("[data-testid=helper-panel]")).not.toBeNull();
    expect(document.activeElement).toBe(textarea());
    expect(document.querySelector("[data-testid=helper-sees]")?.textContent).toContain("/ACM/dashboard/now");
    const modelSelect = document.querySelector("[data-testid=helper-model]") as HTMLSelectElement;
    expect(modelSelect.textContent).toContain("Fast one — ❌ Needs a key");
    expect(modelSelect.textContent).toContain("Use default (Claude) — ✅ Ready");
    expect(modelSelect.querySelector("optgroup")?.getAttribute("label")).toBe("Acme AI");

    await ask("Should I approve this?");
    expect(mockHelperApi.ask).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ message: "Should I approve this?", pageRoute: "/ACM/dashboard/now", directoryEntryId: null, history: [] }),
    );
    // The visible page is read when the question is sent, not only when the panel opened.
    expect(mockHelperApi.ask.mock.calls[0]![1].context).toContain("Deploy card for the shop");
    expect(document.querySelector("[data-testid=helper-answer]")?.textContent).toContain("Step 1. Do it.");
  });

  it("is drawn outside the page (above pop-ups) and the Ask tab is labelled for screen readers", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    render();
    await flush();
    const opener = document.querySelector("[data-testid=helper-open]")!;
    expect(opener.getAttribute("aria-label")).toBe("Ask Paperclip");
    expect(opener.getAttribute("aria-keyshortcuts")).toContain("Control+Shift+H");
    expect(host!.contains(opener)).toBe(false);
    expect(opener.className).toContain("z-[60]");
  });

  it("keeps the conversation and the open panel across pages and a reload, and only for its own company", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.ask.mockResolvedValueOnce(answer("First answer.")).mockResolvedValueOnce(answer("Second answer."));
    render();
    await openPanel();
    await ask("First question");

    act(() => navigateTo!("/ACM/agents"));
    await flush();
    expect(document.querySelector("[data-testid=helper-panel]")).not.toBeNull();
    expect(document.querySelector("[data-testid=helper-answer]")?.textContent).toContain("First answer.");

    rerenderSame();
    await flush();
    expect(document.querySelector("[data-testid=helper-panel]")).not.toBeNull();
    expect(document.querySelector("[data-testid=helper-question]")?.textContent).toContain("First question");
    await ask("Second question");
    expect(mockHelperApi.ask.mock.calls[1]![1].history).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer." },
    ]);

    // Another company: its own (empty) conversation; nothing of Acme's goes along.
    act(() => root?.unmount());
    host?.remove();
    companyState.id = "c2";
    companyState.name = "Other";
    render();
    await flush();
    expect(document.querySelector("[data-testid=helper-panel]")).not.toBeNull();
    expect(document.querySelectorAll("[data-testid=helper-question]")).toHaveLength(0);

    // Back to the first company: its conversation is still there.
    act(() => root?.unmount());
    host?.remove();
    companyState.id = "c1";
    render();
    await flush();
    expect(document.querySelectorAll("[data-testid=helper-question]")).toHaveLength(2);

    await click(document.querySelector("[data-testid=helper-new-conversation]"));
    expect(document.querySelectorAll("[data-testid=helper-question]")).toHaveLength(0);
    expect(window.sessionStorage.getItem("paperclip.helper.session.v1:u1:c1")).toBeNull();
  });

  it("keeps each person's conversation to themselves on a shared tab, and saves nothing while nobody is signed in", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.ask.mockResolvedValue(answer("Here is the payroll."));
    render();
    await openPanel();
    await ask("Show me the payroll page");
    expect(document.querySelectorAll("[data-testid=helper-question]")).toHaveLength(1);

    // Someone else signs in on the same tab and company.
    act(() => root?.unmount());
    host?.remove();
    authState.userId = "u2";
    render();
    await openPanel();
    expect(document.querySelectorAll("[data-testid=helper-question]")).toHaveLength(0);
    mockHelperApi.ask.mockClear();
    await ask("Hello");
    expect(mockHelperApi.ask.mock.calls[0]![1].history).toEqual([]);

    // Nobody known: works, but nothing goes into storage.
    act(() => root?.unmount());
    host?.remove();
    window.sessionStorage.clear();
    authState.userId = null;
    render();
    await openPanel();
    await ask("Anything");
    expect(Object.keys(window.sessionStorage).filter((k) => k.startsWith("paperclip.helper.session"))).toEqual([]);
  });

  it("sends only the last turns of a long conversation, so the next question is never refused", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    const turns = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `${i} ${"z".repeat(7_000)}` }));
    window.sessionStorage.setItem("paperclip.helper.session.v1:u1:c1", JSON.stringify({ turns, entryId: "", seenAnswerIds: [] }));
    mockHelperApi.ask.mockResolvedValue(answer("ok"));
    render();
    await openPanel();
    await ask("One more");
    const history = mockHelperApi.ask.mock.calls[0]![1].history as Array<{ content: string }>;
    expect(history).toHaveLength(24);
    expect(history[0]!.content.startsWith("16 ")).toBe(true);
    expect(Math.max(...history.map((t) => t.content.length))).toBeLessThanOrEqual(6_000);
  });

  it("shows failures in plain words with a retry, keeps the question, and never sends twice on a double press", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    let resolveAsk: ((value: unknown) => void) | null = null;
    mockHelperApi.ask
      .mockRejectedValueOnce(new ApiError("Validation error", 400, { error: "Validation error" }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveAsk = resolve)));
    render();
    await openPanel();
    await ask("Why is this red?");
    expect(document.querySelector("[data-testid=helper-error]")?.textContent).toContain("The question could not be sent as it was.");
    expect(document.querySelector("[data-testid=helper-error]")?.textContent).not.toContain("Validation error");
    expect(textarea().value).toBe("Why is this red?");
    expect(document.querySelectorAll("[data-testid=helper-question]")).toHaveLength(0);

    await click(document.querySelector("[data-testid=helper-retry]"));
    expect(document.querySelector("[data-testid=helper-error]")?.textContent).toContain("Could not reach Paperclip. Check your connection");

    // Third try: two quick presses of Enter make one request.
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(mockHelperApi.ask).toHaveBeenCalledTimes(3);
    expect(document.querySelector("[data-testid=helper-thinking]")).not.toBeNull();
    await act(async () => {
      resolveAsk!(answer("Because the sync failed."));
    });
    await flush();
    expect(document.querySelector("[data-testid=helper-error]")).toBeNull();
    expect(document.querySelector("[data-testid=helper-answer]")?.textContent).toContain("Because the sync failed.");
  });

  it("keeps a server's own plain message as it is", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.ask.mockRejectedValue(new ApiError("OpenRouter is busy right now. Try again in a moment.", 429, {}));
    render();
    await openPanel();
    await ask("Hello?");
    expect(document.querySelector("[data-testid=helper-error]")?.textContent).toContain("OpenRouter is busy right now. Try again in a moment.");
  });

  it("sends no page text when the person switches it off, and falls back to the default when a picked model is gone", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.ask.mockResolvedValue(answer("ok"));
    window.sessionStorage.setItem("paperclip.helper.session.v1:u1:c1", JSON.stringify({ turns: [], entryId: "removed-model", seenAnswerIds: [] }));
    render();
    await openPanel();
    expect((document.querySelector("[data-testid=helper-model]") as HTMLSelectElement).value).toBe("");
    await click(document.querySelector("[data-testid=helper-include-page]"));
    expect(document.querySelector("[data-testid=helper-sees]")?.textContent).toContain("(No page text will be sent.)");
    await ask("General question");
    expect(mockHelperApi.ask).toHaveBeenCalledWith("c1", expect.objectContaining({ context: null, directoryEntryId: null }));
  });

  it("copies an answer", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.ask.mockResolvedValue(answer("Paste this."));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render();
    await openPanel();
    await ask("Write it");
    await click(document.querySelector("[data-testid=helper-copy-answer]"));
    expect(writeText).toHaveBeenCalledWith("Paste this.");
    expect(document.querySelector("[data-testid=helper-copy-answer]")?.textContent).toContain("Copied");
  });

  it("closes on Esc from inside the panel and gives the focus back to the Ask tab", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    render();
    await openPanel();
    expect(document.activeElement).toBe(textarea());
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    await flush();
    expect(document.querySelector("[data-testid=helper-panel]")).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("[data-testid=helper-open]"));
  });

  it("marks an area: can be cancelled with the button or Esc", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    render();
    await openPanel();
    await click(document.querySelector("[data-testid=helper-mark]"));
    expect(document.querySelector("[data-testid=helper-marking-layer]")).not.toBeNull();
    expect(document.querySelector("[data-testid=helper-panel]")).toBeNull();
    await click(document.querySelector("[data-testid=helper-mark-cancel]"));
    expect(document.querySelector("[data-testid=helper-marking-layer]")).toBeNull();
    expect(document.querySelector("[data-testid=helper-panel]")).not.toBeNull();

    await click(document.querySelector("[data-testid=helper-mark]"));
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(document.querySelector("[data-testid=helper-marking-layer]")).toBeNull();
    expect(document.querySelector("[data-testid=helper-panel]")).not.toBeNull();
  });

  it("works next to an open pop-up dialog: reads the dialog, typing and clicking in the panel and Esc do not close it", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.ask.mockResolvedValue(answer("It removes the agent."));
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Delete this agent?</DialogTitle>
          <p>Its tasks go back to the queue.</p>
        </DialogContent>
      </Dialog>,
    );
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await openPanel();
    await flush();
    expect(document.querySelector("[data-testid=helper-panel]")).not.toBeNull();

    // Focus can go into the panel even though the dialog traps focus.
    act(() => textarea().focus());
    await flush();
    expect(document.activeElement).toBe(textarea());

    // Clicking in the panel is not "outside the dialog".
    act(() => {
      textarea().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    await ask("What happens if I press Delete?");
    expect(onOpenChange).not.toHaveBeenCalled();
    const context = mockHelperApi.ask.mock.calls[0]![1].context as string;
    expect(context).toContain("Delete this agent?");
    expect(context).not.toContain("Deploy card for the shop");

    // Esc in the panel closes the panel, not the dialog.
    act(() => textarea().focus());
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(document.querySelector("[data-testid=helper-panel]")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
