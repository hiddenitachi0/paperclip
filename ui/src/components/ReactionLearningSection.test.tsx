// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactionLearningSection } from "./ReactionLearningSection";
import type { AgentMemoryList, AgentMemoryNote } from "../api/agentMemories";
import { ApiError } from "../api/client";

/**
 * "What Maja has learned from your reactions": only the notes learned from
 * reactions, each with Edit and Delete that save at once.
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
    source: "reaction",
    agentId: AGENT,
    personaId: null,
    createdByUserId: null,
    createdByName: null,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function list(notes: AgentMemoryNote[]): AgentMemoryList {
  return { owner: { kind: "agent", agentId: AGENT, name: "Maja" }, maxNotes: 100, maxLength: 500, notes };
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

describe("ReactionLearningSection", () => {
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
          <ReactionLearningSection agentId={AGENT} agentName="Maja" />
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

  it("says nothing has been learned yet", async () => {
    mockApi.list.mockResolvedValue(list([]));
    await render();
    expect(container.textContent).toContain("What Maja has learned from your reactions");
    expect(container.querySelector('[data-testid="reaction-learning-empty"]')?.textContent).toContain("Nothing yet.");
  });

  it("shows only the notes learned from reactions", async () => {
    mockApi.list.mockResolvedValue(
      list([
        note("n1", "Filip likes short, warm replies."),
        note("n2", "I prefer short answers.", { source: "agent" }),
        note("n3", "Typed by hand.", { source: "user" }),
      ]),
    );
    await render();
    const items = container.querySelectorAll('[data-testid="reaction-learning-note"]');
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("Filip likes short, warm replies.");
    expect(items[0]!.textContent).toContain("Learned just now");
    expect(container.textContent).not.toContain("Typed by hand.");
  });

  it("edits a note and saves it", async () => {
    mockApi.list.mockResolvedValue(list([note("n1", "Filip likes short replies.")]));
    mockApi.update.mockResolvedValue(note("n1", "Filip likes short, warm replies."));
    await render();
    await click("Edit note: Filip likes short replies.");
    const box = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit note"]')!;
    await act(async () => setValue(box, "Filip likes short, warm replies."));
    await click("Save");
    expect(mockApi.update).toHaveBeenCalledWith(AGENT, "n1", "Filip likes short, warm replies.");
    expect(mockToast).toHaveBeenCalledWith({ title: "Note saved", tone: "success" });
  });

  it("deletes a note", async () => {
    mockApi.list.mockResolvedValue(list([note("n1", "Filip likes short replies.")]));
    mockApi.remove.mockResolvedValue(undefined);
    await render();
    await click("Delete note: Filip likes short replies.");
    expect(mockApi.remove).toHaveBeenCalledWith(AGENT, "n1");
    expect(mockToast).toHaveBeenCalledWith({ title: "Note deleted", tone: "success" });
  });

  it("says so in one sentence when the server refuses", async () => {
    mockApi.list.mockRejectedValue(new ApiError("Forbidden", 403, null));
    await render();
    expect(container.querySelector('[data-testid="reaction-learning-refused"]')?.textContent).toContain("Only people who can change");
  });
});
