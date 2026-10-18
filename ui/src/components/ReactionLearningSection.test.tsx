// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactionLearningSection } from "./ReactionLearningSection";
import type { AgentMemoryList, AgentMemoryNote } from "../api/agentMemories";
import type { AgentReaction, AgentReactionList } from "../api/agentReactions";
import { ApiError } from "../api/client";

/**
 * "What Maja has learned from your reactions": only the notes learned from
 * reactions, each with Edit and Delete that save at once.
 */

const AGENT = "11111111-1111-4111-8111-111111111111";

const mockApi = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn(), clear: vi.fn() }));
vi.mock("../api/agentMemories", () => ({ agentMemoriesApi: mockApi }));
const mockReactions = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../api/agentReactions", () => ({ agentReactionsApi: mockReactions }));
const mockAgents = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgents }));
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

function reaction(id: string, extra: Partial<AgentReaction> = {}): AgentReaction {
  return {
    id,
    emoji: "👍",
    meaning: "positive",
    active: true,
    reactedAt: now,
    removedAt: null,
    message: { id: `m-${id}`, conversationId: null, excerpt: "Here is your summary." },
    picture: null,
    ...extra,
  };
}

function reactionList(items: AgentReaction[], extra: Partial<AgentReactionList> = {}): AgentReactionList {
  return { agentId: AGENT, reactionLearningEnabled: true, limit: 25, offset: 0, hasMore: false, items, ...extra };
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

  beforeEach(() => {
    mockReactions.list.mockResolvedValue(reactionList([]));
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

  it("lists recent reactions with what they were on", async () => {
    mockApi.list.mockResolvedValue(list([]));
    mockReactions.list.mockResolvedValue(
      reactionList([
        reaction("r1"),
        reaction("r2", {
          emoji: "👎",
          meaning: "negative",
          active: false,
          removedAt: now,
          message: { id: "m2", conversationId: null, excerpt: null },
          picture: { fileId: "f1", look: "watercolour", promptExcerpt: null },
        }),
      ]),
    );
    await render();
    const rows = container.querySelectorAll('[data-testid="recent-reaction"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Here is your summary.");
    expect(rows[0]!.textContent).toContain("Liked · just now");
    expect(rows[1]!.textContent).toContain("Picture: watercolour");
    expect(rows[1]!.textContent).toContain("Did not like · taken back just now");
  });

  it("says there are no reactions yet", async () => {
    mockApi.list.mockResolvedValue(list([]));
    await render();
    expect(container.querySelector('[data-testid="recent-reactions-empty"]')?.textContent).toContain("No reactions yet");
  });

  it("shows more reactions when asked", async () => {
    mockApi.list.mockResolvedValue(list([]));
    mockReactions.list.mockResolvedValue(reactionList([reaction("r1")], { hasMore: true }));
    await render();
    await click("Show more");
    expect(mockReactions.list).toHaveBeenLastCalledWith(AGENT, 50);
  });

  it("switches learning off and says what that means", async () => {
    mockApi.list.mockResolvedValue(list([note("n1", "Filip likes short replies.")]));
    mockAgents.update.mockResolvedValue({});
    await render();
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    mockReactions.list.mockResolvedValue(reactionList([], { reactionLearningEnabled: false }));
    await act(async () => toggle.click());
    await flush();
    expect(mockAgents.update).toHaveBeenCalledWith(AGENT, { reactionLearningEnabled: false }, undefined);
    expect(mockToast).toHaveBeenCalledWith({
      title: "Maja has stopped learning from your reactions",
      tone: "success",
    });
    expect(container.querySelector('button[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Maja ignores new reactions and adds no new notes. Notes it already has are kept.");
    // The notes it already has stay editable.
    expect(container.textContent).toContain("Filip likes short replies.");
  });

  it("says so in one sentence when switching fails", async () => {
    mockApi.list.mockResolvedValue(list([]));
    mockAgents.update.mockRejectedValue(new ApiError("Board access required", 403, null));
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('button[role="switch"]')!.click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Board access required");
  });
});
