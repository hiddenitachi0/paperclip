// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneAConversationLogPage, LaneAConversationLogRow, LaneAConversationLogTranscript } from "../api/laneA";
import { ApiError } from "../api/client";

/**
 * The "Conversations" tab on a quick agent's page: a list (who, when, how many
 * messages, first question, what it did), filters that go to the server, "Show
 * more" paging, a private row that cannot be opened, and a transcript with
 * plain-word actions and picture thumbnails.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const mockApi = vi.hoisted(() => ({ listConversationLog: vi.fn(), getConversationLog: vi.fn() }));
vi.mock("../api/laneA", () => ({ laneAApi: mockApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { QuickAgentConversations } = await import("./QuickAgentConversations");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function row(id: string, extra: Partial<LaneAConversationLogRow> = {}): LaneAConversationLogRow {
  return {
    id,
    person: { kind: "user", id: "olga", name: "Olga" },
    channel: null,
    startedAt: "2026-10-03T10:00:00.000Z",
    lastMessageAt: "2026-10-04T10:00:00.000Z",
    messageCount: 2,
    firstQuestion: "How were sales last week?",
    toolUse: [],
    handoffCount: 0,
    private: false,
    mine: false,
    ...extra,
  };
}

function page(rows: LaneAConversationLogRow[], extra: Partial<LaneAConversationLogPage> = {}): LaneAConversationLogPage {
  return {
    conversations: rows,
    nextCursor: null,
    people: [
      { kind: "user", id: "filip", name: "Filip" },
      { kind: "user", id: "olga", name: "Olga" },
    ],
    canSeeAll: true,
    ...extra,
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function setInput(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelect(element: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`No button with text ${text}`);
  return button as HTMLButtonElement;
}

describe("QuickAgentConversations", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <QuickAgentConversations companyId={COMPANY} agentId={AGENT} agentName="Secretary" />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("lists conversations with who, channel, count, first question and what it did", async () => {
    mockApi.listConversationLog.mockResolvedValue(
      page([
        row("c1", {
          channel: "telegram",
          toolUse: [
            { label: "Handed to Fork Lead", count: 1 },
            { label: "Made a picture", count: 2 },
          ],
          handoffCount: 1,
        }),
        row("c2", { person: { kind: "user", id: "emma", name: "Emma" }, private: true, firstQuestion: null }),
      ]),
    );
    await render();

    expect(mockApi.listConversationLog).toHaveBeenCalledWith(COMPANY, AGENT, { limit: 25, cursor: undefined });
    const rows = container.querySelectorAll("[data-testid=conversation-row]");
    expect(rows).toHaveLength(2);
    const first = rows[0]!.textContent ?? "";
    expect(first).toContain("Olga");
    expect(first).toContain("Telegram");
    expect(first).toContain("2 messages");
    expect(first).toContain("1 hand-off");
    expect(first).toContain("How were sales last week?");
    expect(first).toContain("Handed to Fork Lead");
    expect(first).toContain("Made a picture ×2");
    expect(container.textContent).toContain("Every chat people have had with Secretary");

    // A private chat is listed, cannot be opened, and says why.
    const second = rows[1]!;
    expect(second.textContent).toContain("Private");
    expect(second.textContent).toContain("emergency access");
    expect((second.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a member sees their own chats and no person filter", async () => {
    mockApi.listConversationLog.mockResolvedValue(page([row("c1", { mine: true })], { canSeeAll: false, people: [] }));
    await render();
    expect(container.textContent).toContain("Your chats with Secretary");
    expect(container.textContent).toContain("Olga (you)");
    expect(container.querySelector("select[aria-label=Person]")).toBeNull();
  });

  it("sends filters and search to the server", async () => {
    mockApi.listConversationLog.mockResolvedValue(page([row("c1")]));
    await render();

    await act(async () => setSelect(container.querySelector("select[aria-label=Person]") as HTMLSelectElement, "olga"));
    await flush();
    expect(mockApi.listConversationLog).toHaveBeenLastCalledWith(COMPANY, AGENT, { userId: "olga", limit: 25, cursor: undefined });

    await act(async () => {
      (container.querySelector("input[aria-label='Has hand-offs']") as HTMLInputElement).click();
    });
    await flush();
    expect(mockApi.listConversationLog).toHaveBeenLastCalledWith(COMPANY, AGENT, {
      userId: "olga",
      hasHandoffs: true,
      limit: 25,
      cursor: undefined,
    });

    await act(async () => setInput(container.querySelector("input[aria-label=From]") as HTMLInputElement, "2026-10-01"));
    await flush();
    await act(async () => setInput(container.querySelector("input[aria-label='Search messages']") as HTMLInputElement, "  sofa "));
    await act(async () => buttonByText(container, "Search").click());
    await flush();
    expect(mockApi.listConversationLog).toHaveBeenLastCalledWith(COMPANY, AGENT, {
      userId: "olga",
      from: "2026-10-01",
      hasHandoffs: true,
      q: "sofa",
      limit: 25,
      cursor: undefined,
    });

    mockApi.listConversationLog.mockResolvedValue(page([]));
    await act(async () => buttonByText(container, "Clear").click());
    await flush();
    expect(mockApi.listConversationLog).toHaveBeenLastCalledWith(COMPANY, AGENT, { limit: 25, cursor: undefined });
  });

  it("says plainly when nothing matches", async () => {
    mockApi.listConversationLog.mockResolvedValue(page([]));
    await render();
    expect(container.textContent).toContain("No one has chatted with Secretary yet.");
  });

  it("pages with Show more", async () => {
    mockApi.listConversationLog
      .mockResolvedValueOnce(page([row("c1")], { nextCursor: "next-1" }))
      .mockResolvedValueOnce(page([row("c2", { firstQuestion: "Second page question" })]));
    await render();
    expect(container.querySelectorAll("[data-testid=conversation-row]")).toHaveLength(1);

    await act(async () => buttonByText(container, "Show more").click());
    await flush();
    expect(mockApi.listConversationLog).toHaveBeenLastCalledWith(COMPANY, AGENT, { limit: 25, cursor: "next-1" });
    expect(container.querySelectorAll("[data-testid=conversation-row]")).toHaveLength(2);
    expect(container.textContent).toContain("Second page question");
    expect(container.textContent).not.toContain("Show more");
  });

  it("opens a transcript with actions in plain words and picture thumbnails, and goes back", async () => {
    mockApi.listConversationLog.mockResolvedValue(page([row("c1")]));
    const transcript: LaneAConversationLogTranscript = {
      conversation: row("c1"),
      continuedFrom: null,
      messages: [
        { id: "m1", role: "user", content: "Make a red sofa", createdAt: "2026-10-03T10:00:01.000Z", actions: [] },
        {
          id: "m2",
          role: "assistant",
          content: "Here it is.",
          createdAt: "2026-10-03T10:00:02.000Z",
          actions: [
            {
              tool: "paperclip.media-studio:generate-image",
              label: "Made a picture",
              summary: "Made a picture of a red sofa.",
              ok: true,
              image: { contentPath: "/api/attachments/abc/content", contentType: "image/png" },
              task: null,
            },
            {
              tool: "route_to_agent",
              label: "Handed to Fork Lead",
              summary: "Handed to Fork Lead as task DUR-12.",
              ok: true,
              image: null,
              task: { issueId: "i1", identifier: "DUR-12", title: "Look at sales" },
            },
          ],
        },
      ],
    };
    mockApi.getConversationLog.mockResolvedValue(transcript);
    await render();

    await act(async () => (container.querySelector("[data-testid=conversation-row] button") as HTMLButtonElement).click());
    await flush();
    expect(mockApi.getConversationLog).toHaveBeenCalledWith(COMPANY, AGENT, "c1");
    const view = container.querySelector("[data-testid=conversation-transcript]")!;
    expect(view.textContent).toContain("Make a red sofa");
    expect(view.textContent).toContain("Secretary");
    expect(view.textContent).toContain("Made a picture");
    expect(view.textContent).toContain("Handed to Fork Lead");
    expect((view.querySelector("img") as HTMLImageElement).getAttribute("src")).toBe("/api/attachments/abc/content");
    expect((view.querySelector("a[href='/issues/DUR-12']") as HTMLAnchorElement).textContent).toBe("DUR-12");

    await act(async () => buttonByText(container, "All conversations").click());
    await flush();
    expect(container.querySelector("[data-testid=conversation-transcript]")).toBeNull();
    expect(container.querySelectorAll("[data-testid=conversation-row]")).toHaveLength(1);
  });

  it("shows the server's sentence when a transcript is refused", async () => {
    mockApi.listConversationLog.mockResolvedValue(page([row("c1")]));
    mockApi.getConversationLog.mockRejectedValue(new ApiError("This is Emma's private chat.", 403, null));
    await render();
    await act(async () => (container.querySelector("[data-testid=conversation-row] button") as HTMLButtonElement).click());
    await flush();
    expect(container.textContent).toContain("This is Emma's private chat.");
  });
});
