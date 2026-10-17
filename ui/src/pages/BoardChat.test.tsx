// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { act, forwardRef, useImperativeHandle } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardChat } from "./BoardChat";
import { boardChatPrefillState } from "../lib/board-chat-handoff";

/**
 * Regression coverage for the post-wizard Conference Room intro (PAP-134,
 * plan: PAP-133 A+B): a fresh mount shows the three-dot typing bubble for
 * ~2s, then the CEO welcome, then the suggestion chips ~700ms later. The
 * staged reveal must hold while the onboarding wizard overlay is open or
 * the tab is hidden, and must fast-forward when the user already replied.
 */

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockGoalsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listComments: vi.fn(),
  listFeedbackVotes: vi.fn(),
}));
const mockDialogState = vi.hoisted(() => ({ onboardingOpen: false }));

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Acme Robotics", issuePrefix: "PAP" },
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogState: () => ({ onboardingOpen: mockDialogState.onboardingOpen }),
}));

// Heavy children that are irrelevant to the staged intro.
vi.mock("../components/ActivityFeed", () => ({
  ActivityFeed: () => <div data-testid="activity-feed" />,
}));
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
const composerSpy = vi.hoisted(() => ({ onSubmit: vi.fn() }));
vi.mock("../components/ChatComposer", () => ({
  ChatComposer: forwardRef((props: { value: string; onSubmit: () => void }, ref) => {
    useImperativeHandle(ref, () => ({ focus: vi.fn() }));
    composerSpy.onSubmit = vi.fn(props.onSubmit);
    return <div data-testid="chat-composer" data-value={props.value} />;
  }),
}));
vi.mock("../components/AgentBubbleActionRow", () => ({
  AgentBubbleActionRow: () => null,
  agentBubbleDateLabel: () => "",
}));
vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => null,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetContent: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const CEO_AGENT = {
  id: "agent-ceo",
  name: "Alex",
  role: "ceo",
  status: "active",
  icon: null,
};
const BOARD_ISSUE = { id: "issue-board", title: "Board Operations", status: "in_progress" };
const USER_COMMENT = {
  id: "comment-user-1",
  body: "Hi Alex!",
  authorAgentId: null,
  authorUserId: "user-1",
  createdAt: "2026-06-10T00:00:00.000Z",
};

function hasTypingDots(container: HTMLElement) {
  return container.querySelectorAll(".typing-dots").length > 0;
}

function hasWelcome(container: HTMLElement) {
  return (container.textContent ?? "").includes("Welcome to");
}

function hasChips(container: HTMLElement) {
  return (container.textContent ?? "").includes("Draft a Company Brief");
}

describe("BoardChat staged typing intro", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    container = document.createElement("div");
    document.body.appendChild(container);
    mockDialogState.onboardingOpen = false;
    mockAgentsApi.list.mockResolvedValue([CEO_AGENT]);
    mockGoalsApi.list.mockResolvedValue([
      { id: "goal-1", title: "Build affordable robots", status: "active" },
    ]);
    mockIssuesApi.list.mockResolvedValue([BOARD_ISSUE]);
    mockIssuesApi.listComments.mockResolvedValue([]);
    mockIssuesApi.listFeedbackVotes.mockResolvedValue([]);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
    // Drop any per-test document.visibilityState override.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (document as any).visibilityState;
  });

  let queryClient: QueryClient | null = null;
  let initialEntry: string | { pathname: string; state: unknown } = "/PAP/board-chat";

  function buildElement() {
    // A fresh element every time — rendering an identical element reference
    // lets React bail out of re-rendering, which would hide mock-state flips.
    return (
      <QueryClientProvider client={queryClient!}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <BoardChat />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  async function render() {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(buildElement());
    });
    // Let the agent/goal/issue queries resolve, plus the follow-up render
    // that enables the comments query off boardIssueId. react-query batches
    // notifications through zero-delay timers, so flush those too.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
  }

  /** Re-render the existing tree so hooks re-read mutated mock state. */
  async function rerender() {
    await act(async () => {
      root!.render(buildElement());
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("reveals typing dots, then the welcome at 2s, then chips at +700ms", async () => {
    await render();

    // Fresh mount: dots only.
    expect(hasTypingDots(container)).toBe(true);
    expect(hasWelcome(container)).toBe(false);

    // Just before the reveal: still dots.
    await advance(1900);
    expect(hasTypingDots(container)).toBe(true);
    expect(hasWelcome(container)).toBe(false);

    // t=2s: welcome bubble lands, dots leave, chips not yet.
    await advance(100);
    expect(hasWelcome(container)).toBe(true);
    expect(hasTypingDots(container)).toBe(false);
    expect(hasChips(container)).toBe(false);

    // t=2.7s: chips stage in.
    await advance(700);
    expect(hasChips(container)).toBe(true);
  });

  it("skips the staged reveal when a user comment already exists", async () => {
    mockIssuesApi.listComments.mockResolvedValue([USER_COMMENT]);
    await render();

    // Fast-forwarded: no dots, welcome immediately, no timer needed.
    expect(hasTypingDots(container)).toBe(false);
    expect(hasWelcome(container)).toBe(true);
  });

  it("holds the dots while the onboarding wizard overlay is open (PAP-134)", async () => {
    mockDialogState.onboardingOpen = true;
    await render();

    // The 2s window must not burn behind the wizard overlay.
    await advance(2500);
    expect(hasTypingDots(container)).toBe(true);
    expect(hasWelcome(container)).toBe(false);

    // Wizard closes → reveal timer starts fresh.
    mockDialogState.onboardingOpen = false;
    await rerender();
    await advance(2000);
    expect(hasWelcome(container)).toBe(true);
    expect(hasTypingDots(container)).toBe(false);
  });

  it("holds the dots while the document is hidden (PAP-134)", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    await render();

    // The 2s window must not burn while the tab is hidden.
    await advance(2500);
    expect(hasTypingDots(container)).toBe(true);
    expect(hasWelcome(container)).toBe(false);

    // Tab becomes visible → reveal timer starts fresh.
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(2000);
    expect(hasWelcome(container)).toBe(true);
    expect(hasTypingDots(container)).toBe(false);
  });

  it("is titled Board chat and says what it can do", async () => {
    await render();
    expect(container.querySelector("h3")?.textContent).toBe("Alex");
    expect(container.querySelector("[data-testid=board-chat-subtitle]")?.textContent).toBe(
      "Talk to an AI board member that can make changes for you (hire agents, create tasks, change settings).",
    );
    expect(container.textContent).not.toContain("Conference Room");
  });

  it("points to Ask while the conversation is empty, and not once there are messages", async () => {
    await render();
    expect(container.querySelector("[data-testid=board-chat-ask-tip]")?.textContent).toBe(
      "Just want an explanation of a page? Use the Ask tab on the right edge.",
    );
    await act(async () => {
      root?.unmount();
    });
    mockIssuesApi.listComments.mockResolvedValue([USER_COMMENT]);
    await render();
    expect(container.querySelector("[data-testid=board-chat-ask-tip]")).toBeNull();
  });

  it("types in a message handed over from Ask, without sending it, and clears it from the history entry", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    sessionStorage.setItem("paperclip.boardChat.draft.company-1", "an older draft");
    initialEntry = { pathname: "/PAP/board-chat", state: boardChatPrefillState("Hire a marketing agent\n\n(I asked this while looking at the page “Agents · Acme”.)") };
    await render();

    const composer = container.querySelector("[data-testid=chat-composer]")!;
    expect(composer.getAttribute("data-value")).toBe(
      "Hire a marketing agent\n\n(I asked this while looking at the page “Agents · Acme”.)",
    );
    // Nothing was sent: the person reviews it and presses Send themselves.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(composerSpy.onSubmit).not.toHaveBeenCalled();
    // The hand-off lived only in navigation state (never the address), and is gone after use.
    const probe = JSON.parse(container.querySelector("[data-testid=location-probe]")!.textContent!);
    expect(probe.pathname).toBe("/PAP/board-chat");
    expect(probe.search).toBe("");
    expect(probe.state).toBeNull();
    // It is kept as the draft, like anything typed.
    expect(sessionStorage.getItem("paperclip.boardChat.draft.company-1")).toContain("Hire a marketing agent");
    initialEntry = "/PAP/board-chat";
  });
});

function LocationProbe() {
  const location = useLocation();
  return (
    <pre data-testid="location-probe" hidden>
      {JSON.stringify({ pathname: location.pathname, search: location.search, state: location.state ?? null })}
    </pre>
  );
}

describe("typing-dots CSS animation guard (PAP-54 failure mode)", () => {
  // PAP-54: the .typing-dots CSS block was silently dropped from index.css
  // during a theme migration, leaving static markup with no animation. Guard
  // the source so the block can't vanish again without failing a test. The
  // browser-computed `animationName !== "none"` assertion lives in
  // tests/e2e/conference-room-typing-intro.spec.ts.
  // Locate ui/src/index.css regardless of whether vitest runs from ui/ or
  // the workspace root (import.meta.url is an http URL under jsdom, and the
  // css pipeline swallows `?raw` imports — plain fs is the reliable path).
  function readIndexCss(): string {
    let dir = process.cwd();
    for (let depth = 0; depth < 6; depth++) {
      for (const candidate of [
        path.join(dir, "src/index.css"),
        path.join(dir, "ui/src/index.css"),
      ]) {
        if (existsSync(candidate)) return readFileSync(candidate, "utf8");
      }
      dir = path.dirname(dir);
    }
    throw new Error("ui/src/index.css not found from " + process.cwd());
  }
  const css = readIndexCss();

  it("keeps the bounce animation wired to .typing-dots span", () => {
    const spanRules = [...css.matchAll(/\.typing-dots span\s*\{[^}]*\}/g)].map(
      (m) => m[0],
    );
    expect(spanRules.length).toBeGreaterThan(0);
    expect(
      spanRules.some((rule) => /animation:\s*typing-bounce/.test(rule)),
    ).toBe(true);
  });

  it("keeps the typing-bounce keyframes", () => {
    expect(css).toMatch(/@keyframes typing-bounce\s*\{/);
  });
});
