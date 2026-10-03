// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAgentMemorySection } from "./QuickAgentMemorySection";
import type { AgentMemoryList, AgentMemoryNote } from "../api/agentMemories";
import { ApiError } from "../api/client";

/**
 * The "Memory" card on a quick agent's page: list (text, when, who added),
 * add, inline edit, delete one, and "Clear all" behind a confirmation. Every
 * change goes straight to the server; a refusal is shown in one sentence.
 */

const AGENT = "11111111-1111-4111-8111-111111111111";

const mockApi = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn(), clear: vi.fn() }));
vi.mock("../api/agentMemories", () => ({ agentMemoriesApi: mockApi }));
const mockToast = vi.hoisted(() => vi.fn());
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockToast }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date().toISOString();

function note(id: string, text: string, extra: Partial<AgentMemoryNote> = {}): AgentMemoryNote {
  return {
    id,
    text,
    source: "user",
    agentId: AGENT,
    personaId: null,
    createdByUserId: "filip",
    createdByName: "Filip",
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function list(notes: AgentMemoryNote[], owner: AgentMemoryList["owner"] = { kind: "agent", agentId: AGENT, name: "Front desk" }): AgentMemoryList {
  return { owner, maxNotes: 100, maxLength: 500, notes };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function setValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("QuickAgentMemorySection", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
      root = null;
    }
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const current = root;
    await act(async () => {
      current.render(
        <QueryClientProvider client={queryClient}>
          <QuickAgentMemorySection agentId={AGENT} />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent === label || element.getAttribute("aria-label") === label,
    );
    if (!found) throw new Error(`No button "${label}"`);
    return found;
  }

  async function click(label: string) {
    await act(async () => button(label).click());
    await flush();
  }

  it("says there is nothing yet and offers no Clear all", async () => {
    mockApi.list.mockResolvedValue(list([]));
    await render();
    expect(container.textContent).toContain("Memory");
    expect(container.querySelector('[data-testid="memory-empty"]')?.textContent).toContain('Nothing yet. Say "remember that …" in a chat');
    expect(container.textContent).toContain("These notes belong to this agent. 0 of 100 notes used.");
    expect(container.querySelector('[data-testid="memory-clear"]')).toBeNull();
  });

  it("lists each note with when and who added it, and says whose notebook it is", async () => {
    mockApi.list.mockResolvedValue(
      list(
        [
          note("n1", "I prefer short answers.", { source: "agent" }),
          note("n2", "My dog is called Rex.", { createdByName: null, createdByUserId: null }),
        ],
        { kind: "persona", personaId: "p1", name: "Maja" },
      ),
    );
    await render();
    const items = container.querySelectorAll('[data-testid="memory-note"]');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("I prefer short answers.");
    expect(items[0]!.textContent).toContain("Saved in chat, asked by Filip, just now");
    expect(items[1]!.textContent).toContain("Added here, just now");
    expect(container.textContent).toContain("These notes belong to Maja and are shared by every job they hold. 2 of 100 notes used.");
  });

  it("adds a note and clears the box", async () => {
    mockApi.list.mockResolvedValue(list([]));
    mockApi.add.mockResolvedValue(note("n1", "I take my coffee black."));
    await render();
    const box = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="New note"]')!;
    expect(button("Add note").disabled).toBe(true);
    await act(async () => setValue(box, "I take my coffee black."));
    expect(container.textContent).toContain("23 / 500");
    await click("Add note");
    expect(mockApi.add).toHaveBeenCalledWith(AGENT, "I take my coffee black.");
    expect(box.value).toBe("");
    expect(mockToast).toHaveBeenCalledWith({ title: "Note saved", tone: "success" });
    expect(mockApi.list).toHaveBeenCalledTimes(2);
  });

  it("shows the server's sentence when a note cannot be saved", async () => {
    mockApi.list.mockResolvedValue(list([]));
    mockApi.add.mockRejectedValue(new ApiError("The memory is full: it already holds 100 notes. Delete some old ones first.", 409, null));
    await render();
    await act(async () => setValue(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="New note"]')!, "One more."));
    await click("Add note");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The memory is full: it already holds 100 notes. Delete some old ones first.",
    );
  });

  it("edits a note in place and saves it", async () => {
    mockApi.list.mockResolvedValue(list([note("n1", "I like tea.")]));
    mockApi.update.mockResolvedValue(note("n1", "I like green tea."));
    await render();
    await click("Edit note: I like tea.");
    const box = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit note"]')!;
    expect(box.value).toBe("I like tea.");
    expect(button("Save").disabled).toBe(true);
    await act(async () => setValue(box, "I like green tea."));
    await click("Save");
    expect(mockApi.update).toHaveBeenCalledWith(AGENT, "n1", "I like green tea.");
    expect(container.querySelector('textarea[aria-label="Edit note"]')).toBeNull();
  });

  it("cancelling an edit changes nothing", async () => {
    mockApi.list.mockResolvedValue(list([note("n1", "I like tea.")]));
    await render();
    await click("Edit note: I like tea.");
    await click("Cancel");
    expect(container.querySelector('textarea[aria-label="Edit note"]')).toBeNull();
    expect(mockApi.update).not.toHaveBeenCalled();
  });

  it("deletes one note", async () => {
    mockApi.list.mockResolvedValue(list([note("n1", "I like tea."), note("n2", "I like coffee.")]));
    mockApi.remove.mockResolvedValue(undefined);
    await render();
    await click("Delete note: I like coffee.");
    expect(mockApi.remove).toHaveBeenCalledWith(AGENT, "n2");
    expect(mockToast).toHaveBeenCalledWith({ title: "Note deleted", tone: "success" });
  });

  it("clears all only after the confirmation", async () => {
    mockApi.list.mockResolvedValue(list([note("n1", "I like tea."), note("n2", "I like coffee.")]));
    mockApi.clear.mockResolvedValue({ deleted: 2 });
    await render();
    await click("Clear all");
    expect(mockApi.clear).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Delete all 2 notes? This cannot be undone.");
    await click("Cancel");
    expect(mockApi.clear).not.toHaveBeenCalled();
    await click("Clear all");
    await click("Yes, delete all");
    expect(mockApi.clear).toHaveBeenCalledWith(AGENT);
    expect(mockToast).toHaveBeenCalledWith({ title: "2 notes deleted", tone: "success" });
  });

  it("says who may see it when the server refuses", async () => {
    mockApi.list.mockRejectedValue(new ApiError("Only people who can change this agent's settings can see and change its memory.", 403, null));
    await render();
    expect(container.querySelector('[data-testid="memory-refused"]')?.textContent).toBe(
      "Only people who can change this agent's settings can see and change its memory.",
    );
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("stops adding when the memory is full", async () => {
    mockApi.list.mockResolvedValue(list(Array.from({ length: 100 }, (_, i) => note(`n${i}`, `Note ${i}`))));
    await render();
    const box = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="New note"]')!;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe("The memory is full. Delete a note to add another.");
    expect(button("Add note").disabled).toBe(true);
  });
});
