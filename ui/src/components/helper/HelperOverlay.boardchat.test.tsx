// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelperAskResponse, HelperSettingsView } from "@paperclipai/shared";

/**
 * Ask Paperclip ↔ Board chat: the panel says it makes no changes, points to
 * Board chat when empty, and offers "Do this in Board chat" — prominently when
 * the server flags the question as a request, and as a small action under
 * every answer. The hand-off opens Board chat with the question in navigation
 * state (not the address). Someone who cannot use Board chat gets a plain note
 * instead of the button.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockHelperApi = vi.hoisted(() => ({
  ask: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  listInvestigations: vi.fn(),
  startInvestigation: vi.fn(),
}));
vi.mock("../../api/helper", () => ({ helperApi: mockHelperApi }));
vi.mock("../../api/auth", () => ({
  authApi: {
    getSession: vi.fn(async () => ({ session: { id: "s-u1", userId: "u1" }, user: { id: "u1", email: null, name: null, image: null } })),
  },
}));
const boardChatState = vi.hoisted(() => ({ flag: true, mode: "local_trusted" as "local_trusted" | "authenticated" }));
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: vi.fn(async () => ({ enableConferenceRoomChat: boardChatState.flag })) },
}));
vi.mock("@/api/health", () => ({
  healthApi: { get: vi.fn(async () => ({ status: "ok", deploymentMode: boardChatState.mode })) },
}));
vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", name: "Acme", issuePrefix: "ACM" } }),
}));
vi.mock("../MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div data-markdown>{children}</div> }));
vi.mock("../../lib/helper-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/helper-capture")>()),
  captureHelperContext: () => ({ text: "Agents list", truncated: false, entities: [], applyTargets: [], itemCount: 1 }),
  viewportRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
}));

import { HelperOverlay } from "./HelperOverlay";

function settings(): HelperSettingsView {
  return {
    defaultDirectoryEntryId: null,
    investigationAgentId: null,
    investigationMaxRunning: 3,
    investigationMaxPerDay: 20,
    investigationCompanyMaxPerDay: 50,
    investigationAgent: null,
    keys: [],
    models: [],
    builtInDefaultLabel: "Claude",
    builtInDefaultCanSeePictures: true,
    builtInDefaultStatus: { kind: "paperclip_key", label: "Paperclip's key", detail: "Runs on Paperclip's own key.", tone: "ok" },
    canEdit: false,
    updatedAt: null,
  };
}

function answer(overrides: Partial<HelperAskResponse> = {}): HelperAskResponse {
  return {
    answer: "I can't make changes. Go to Agents and press Hire.",
    directoryEntryId: null,
    modelLabel: "Claude",
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputTokens: 1,
    outputTokens: 1,
    costCents: 0,
    truncated: false,
    pictureCount: 0,
    suggestInvestigation: false,
    suggestBoardChat: false,
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <pre data-testid="location-probe" hidden>
      {JSON.stringify({ pathname: location.pathname, search: location.search, state: location.state ?? null })}
    </pre>
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  boardChatState.flag = true;
  boardChatState.mode = "local_trusted";
  mockHelperApi.getSettings.mockResolvedValue(settings());
  mockHelperApi.listInvestigations.mockResolvedValue({ investigations: [], availability: null });
  document.title = "Agents · Acme · Paperclip";
});

afterEach(() => {
  window.sessionStorage.clear();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function renderOpen() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/ACM/agents/all"]}>
          <HelperOverlay />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await flush();
  const opener = document.querySelector("[data-testid=helper-open]") as HTMLButtonElement | null;
  if (opener) act(() => opener.click());
  await flush();
}

function typeQuestion(text: string) {
  const textarea = document.querySelector("textarea[aria-label='Your question']") as HTMLTextAreaElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(selector: string) {
  const el = document.querySelector(selector) as HTMLElement | null;
  expect(el, selector).not.toBeNull();
  await act(async () => {
    el!.click();
  });
  await flush();
}

async function ask(question: string, response: HelperAskResponse) {
  mockHelperApi.ask.mockResolvedValue(response);
  typeQuestion(question);
  await click("button[aria-label=Send]");
}

function location() {
  return JSON.parse(document.querySelector("[data-testid=location-probe]")!.textContent!) as {
    pathname: string;
    search: string;
    state: Record<string, unknown> | null;
  };
}

describe("HelperOverlay — Board chat hand-off", () => {
  it("says it makes no changes and points to Board chat while empty", async () => {
    await renderOpen();
    expect(document.querySelector("[data-testid=helper-subtitle]")?.textContent).toContain("Explains this page — makes no changes");
    const tip = document.querySelector("[data-testid=helper-board-chat-tip]");
    expect(tip?.textContent).toBe("Want something changed? Use Board chat.");
    expect(tip?.querySelector("a")?.getAttribute("href")).toBe("/ACM/board-chat");
  });

  it("offers Board chat for a request and hands the question over in navigation state, not the address", async () => {
    await renderOpen();
    await ask("Can you hire a marketing agent? My key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", answer({ suggestBoardChat: true }));

    const offer = document.querySelector("[data-testid=helper-suggest-board-chat]");
    expect(offer?.textContent).toContain("Ask can only explain, but Board chat can do it for you");
    expect(offer?.textContent).toContain("nothing is sent until you press Send");
    // The small action is not shown twice when the big offer is there.
    expect(document.querySelector("[data-testid=helper-board-chat-answer]")).toBeNull();

    await click("[data-testid=helper-board-chat-suggested]");
    const now = location();
    expect(now.pathname).toBe("/ACM/board-chat");
    expect(now.search).toBe("");
    const prefill = String(now.state?.boardChatPrefill ?? "");
    expect(prefill).toContain("Can you hire a marketing agent?");
    expect(prefill).toContain("(I asked this while looking at the page “Agents · Acme · Paperclip”.)");
    // Secrets are masked with the helper's own masking before they leave the panel.
    expect(prefill).not.toContain("sk-ant-api03");
    expect(prefill).toContain("[hidden]");
    // The panel steps aside so Board chat's message box is in view.
    expect(document.querySelector("[data-testid=helper-panel]")).toBeNull();
  });

  it("does not push Board chat for a plain question, but keeps it as a small action under the answer", async () => {
    await renderOpen();
    await ask("What does the heartbeat interval do?", answer({ answer: "It decides how often the agent wakes up." }));
    expect(document.querySelector("[data-testid=helper-suggest-board-chat]")).toBeNull();
    const small = document.querySelector("[data-testid=helper-board-chat-answer]");
    expect(small?.textContent).toContain("Do this in Board chat");

    await click("[data-testid=helper-board-chat-answer]");
    expect(location().pathname).toBe("/ACM/board-chat");
    expect(String(location().state?.boardChatPrefill)).toContain("What does the heartbeat interval do?");
  });

  it("shows a plain note instead of the button when Board chat is turned off", async () => {
    boardChatState.flag = false;
    await renderOpen();
    expect(document.querySelector("[data-testid=helper-board-chat-tip]")).toBeNull();
    await ask("Hire a marketing agent", answer({ suggestBoardChat: true }));
    expect(document.querySelector("[data-testid=helper-suggest-board-chat]")).toBeNull();
    expect(document.querySelector("[data-testid=helper-board-chat-answer]")).toBeNull();
    expect(document.querySelector("[data-testid=helper-board-chat-unavailable]")?.textContent).toContain("is not turned on here");
  });

  it("shows a plain note instead of the button where Board chat cannot run (a shared, signed-in server)", async () => {
    boardChatState.mode = "authenticated";
    await renderOpen();
    await ask("Hire a marketing agent", answer({ suggestBoardChat: true }));
    expect(document.querySelector("[data-testid=helper-board-chat-suggested]")).toBeNull();
    expect(document.querySelector("[data-testid=helper-board-chat-answer]")).toBeNull();
    expect(document.querySelector("[data-testid=helper-board-chat-unavailable]")?.textContent).toContain(
      "only works when Paperclip runs on your own computer",
    );
  });
});
