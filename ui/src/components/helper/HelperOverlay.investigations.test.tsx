// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HelperInvestigationAvailability, HelperInvestigationView, HelperSettingsView } from "@paperclipai/shared";

/**
 * Ask Paperclip, Phase 3 in the panel: "Investigate deeper" on an answer, on a
 * suggestion from the quick helper, or straight from the typed question; the
 * confirm step (who, usual time and cost, advice only) and the "not set up"
 * explanation with a link; "My investigations" with live status, the agent's
 * answer, and the list coming back after a reload.
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
vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", name: "Acme", issuePrefix: "ACM" } }),
}));
vi.mock("../MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div data-markdown>{children}</div> }));
vi.mock("../../lib/helper-capture", () => ({
  captureHelperContext: () => ({
    text: "Card: Deploy PR #612",
    truncated: false,
    entities: ["approval:a1"],
    applyTargets: [],
    itemCount: 1,
  }),
  viewportRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  rectFromPoints: () => ({ left: 0, top: 0, width: 100, height: 100 }),
}));

import { HelperOverlay } from "./HelperOverlay";
import { investigationEstimateText } from "./HelperInvestigations";

function settings(): HelperSettingsView {
  return {
    defaultDirectoryEntryId: null,
    investigationAgentId: "agent-1",
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

function availability(overrides: Partial<HelperInvestigationAvailability> = {}): HelperInvestigationAvailability {
  return {
    agentId: "agent-1",
    agentName: "Investigator",
    ready: true,
    problem: null,
    problemCode: null,
    estimate: { basedOnTasks: 12, typicalMinutes: 4, typicalCostCents: 35 },
    agentBudgetMonthlyCents: 5000,
    agentSpentMonthlyCents: 1200,
    maxRunning: 3,
    maxPerDay: 20,
    runningCount: 0,
    startedLast24h: 1,
    companyMaxPerDay: 50,
    companyStartedLast24h: 4,
    canConfigure: false,
    ...overrides,
  };
}

function investigation(overrides: Partial<HelperInvestigationView> = {}): HelperInvestigationView {
  return {
    id: "i1",
    identifier: "ACM-12",
    title: "Ask Paperclip: Should I approve this?",
    question: "Should I approve this?",
    status: "queued",
    statusLabel: "Waiting to start",
    statusDetail: "The agent picks it up on its next run.",
    answer: null,
    answeredAt: null,
    agentId: "agent-1",
    agentName: "Investigator",
    costCents: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function flush() {
  for (let i = 0; i < 6; i += 1) {
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
        <MemoryRouter initialEntries={["/ACM/dashboard/now"]}>
          <HelperOverlay />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  act(() => (document.querySelector("[data-testid=helper-open]") as HTMLButtonElement).click());
  await flush();
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
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
  const el = document.querySelector(selector) as HTMLButtonElement | null;
  expect(el, selector).not.toBeNull();
  await act(async () => {
    el!.click();
  });
  await flush();
}

async function askAndAnswer(answer: { answer: string; suggestInvestigation?: boolean }) {
  mockHelperApi.ask.mockResolvedValue({
    answer: answer.answer,
    directoryEntryId: null,
    modelLabel: "Claude",
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputTokens: 1,
    outputTokens: 1,
    costCents: 0,
    truncated: false,
    pictureCount: 0,
    suggestInvestigation: answer.suggestInvestigation ?? false,
  });
  typeQuestion("Should I approve this?");
  await click("button[aria-label=Send]");
}

describe("HelperOverlay — Investigate deeper", () => {
  it("shows the quick helper's suggestion and starts only on click, with the question, page, records and the quick answer", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.listInvestigations.mockResolvedValue({ investigations: [], availability: availability() });
    mockHelperApi.startInvestigation.mockResolvedValue(investigation());
    await renderOpen();
    await askAndAnswer({ answer: "I can't see the code; this needs a closer look.", suggestInvestigation: true });

    const suggestion = document.querySelector("[data-testid=helper-suggest-investigation]");
    expect(suggestion?.textContent).toContain("Nothing starts until you press the button");
    expect(mockHelperApi.startInvestigation).not.toHaveBeenCalled();

    await click("[data-testid=helper-investigate-suggested]");
    const confirm = document.querySelector("[data-testid=helper-investigate-confirm]")!;
    expect(confirm.textContent).toContain("“Investigator” will read what it needs");
    expect(confirm.textContent).toContain("advice only");
    expect(document.querySelector("[data-testid=helper-investigate-estimate]")?.textContent).toContain(
      "It usually takes about 4 minutes and costs about $0.35, going by the middle of “Investigator”'s last 12 finished tasks.",
    );
    expect(confirm.textContent).toContain("$38.00 of its $50.00 monthly budget is left.");
    expect(confirm.textContent).toContain("You have 0 of 3 running, and started 1 of 20 in the last 24 hours (4 of 50 for the whole company).");
    expect(confirm.textContent).toContain("The question, the page text shown under “What the helper sees” and the records you marked go into a normal task");
    // A member who cannot change the settings is not told about the agent's budget setup.
    expect(document.querySelector("[data-testid=helper-investigate-no-budget]")).toBeNull();
    expect(mockHelperApi.startInvestigation).not.toHaveBeenCalled();

    // From now on the server lists it too.
    mockHelperApi.listInvestigations.mockResolvedValue({ investigations: [investigation()], availability: availability({ runningCount: 1 }) });
    await click("[data-testid=helper-investigate-start]");
    expect(mockHelperApi.startInvestigation).toHaveBeenCalledWith("c1", {
      question: "Should I approve this?",
      context: "Card: Deploy PR #612",
      pageRoute: "/ACM/dashboard/now",
      references: ["approval:a1"],
      quickAnswer: "I can't see the code; this needs a closer look.",
    });
    expect(document.querySelector("[data-testid=helper-investigate-confirm]")).toBeNull();
    const item = document.querySelector("[data-testid=helper-investigation]")!;
    expect(item.getAttribute("data-status")).toBe("queued");
    expect(item.textContent).toContain("Waiting to start");
    expect(document.querySelector("[data-testid=helper-investigation-link]")?.getAttribute("href")).toBe("/ACM/issues/ACM-12");
  });

  it("offers Investigate deeper on every answer, and explains (with a link) when no agent is set up instead of failing", async () => {
    mockHelperApi.getSettings.mockResolvedValue({ ...settings(), investigationAgentId: null });
    mockHelperApi.listInvestigations.mockResolvedValue({
      investigations: [],
      availability: availability({
        agentId: null,
        agentName: null,
        ready: false,
        problemCode: "no_agent",
        problem: "No agent is set up to investigate yet. A company owner or admin can pick one under Company settings → General → Helper.",
      }),
    });
    await renderOpen();
    await askAndAnswer({ answer: "Here is what it does." });
    expect(document.querySelector("[data-testid=helper-suggest-investigation]")).toBeNull();

    await click("[data-testid=helper-investigate-answer]");
    expect(document.querySelector("[data-testid=helper-investigate-problem]")?.textContent).toContain(
      "A company owner or admin can pick one under Company settings → General → Helper.",
    );
    expect(document.querySelector("[data-testid=helper-investigate-settings-link]")?.getAttribute("href")).toBe("/ACM/company/settings");
    expect(document.querySelector("[data-testid=helper-investigate-start]")).toBeNull();
    expect(mockHelperApi.startInvestigation).not.toHaveBeenCalled();
  });

  it("can hand a typed question straight to the agent (after confirming), then clears it", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.listInvestigations.mockResolvedValue({ investigations: [], availability: availability({ estimate: { basedOnTasks: 0, typicalMinutes: null, typicalCostCents: null } }) });
    mockHelperApi.startInvestigation.mockResolvedValue(investigation({ id: "i2", question: "Why did the sync fail?" }));
    await renderOpen();
    typeQuestion("Why did the sync fail?");
    await click("[data-testid=helper-investigate-composer]");
    expect(document.querySelector("[data-testid=helper-investigate-estimate]")?.textContent).toContain(
      "has no finished tasks yet to estimate from",
    );
    await click("[data-testid=helper-investigate-start]");
    expect(mockHelperApi.ask).not.toHaveBeenCalled();
    expect(mockHelperApi.startInvestigation).toHaveBeenCalledWith("c1", expect.objectContaining({ question: "Why did the sync fail?", quickAnswer: null }));
    expect((document.querySelector("textarea[aria-label='Your question']") as HTMLTextAreaElement).value).toBe("");
  });

  it("shows the plain refusal from the server (for example a limit) and keeps the draft", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.listInvestigations.mockResolvedValue({ investigations: [], availability: availability() });
    mockHelperApi.startInvestigation.mockRejectedValue(new Error("You already have 3 investigations running, the most this company allows at once (3)."));
    await renderOpen();
    typeQuestion("One more?");
    await click("[data-testid=helper-investigate-composer]");
    await click("[data-testid=helper-investigate-start]");
    expect(document.querySelector("[data-testid=helper-investigate-confirm]")?.textContent).toContain("You already have 3 investigations running");
    expect((document.querySelector("textarea[aria-label='Your question']") as HTMLTextAreaElement).value).toBe("One more?");
  });

  it("tells the person which marked records were left out, and warns an owner/admin when the agent has no budget", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.listInvestigations.mockResolvedValue({
      investigations: [],
      availability: availability({ canConfigure: true, agentBudgetMonthlyCents: 0, agentSpentMonthlyCents: 0 }),
    });
    mockHelperApi.startInvestigation.mockResolvedValue({
      ...investigation(),
      droppedReferences: [{ reference: "approval:a1", reason: "you do not have access to it" }],
    });
    await renderOpen();
    typeQuestion("Is this safe?");
    await click("[data-testid=helper-investigate-composer]");
    expect(document.querySelector("[data-testid=helper-investigate-no-budget]")?.textContent).toContain(
      "“Investigator” has no monthly budget, so only the helper's limits cap what investigations cost.",
    );
    await click("[data-testid=helper-investigate-start]");
    expect(document.querySelector("[data-testid=helper-investigation-dropped]")?.textContent).toContain(
      "approval:a1: you do not have access to it.",
    );
  });

  it("explains in plain words when the person may not give the agent work, with no start button", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.listInvestigations.mockResolvedValue({
      investigations: [],
      availability: availability({
        ready: false,
        problemCode: "assign_denied",
        problem: "You do not have the right to give work to agents in this company, so you cannot start an investigation.",
      }),
    });
    await renderOpen();
    typeQuestion("Why?");
    await click("[data-testid=helper-investigate-composer]");
    expect(document.querySelector("[data-testid=helper-investigate-problem]")?.textContent).toContain(
      "You do not have the right to give work to agents in this company",
    );
    expect(document.querySelector("[data-testid=helper-investigate-start]")).toBeNull();
  });

  it("lists my investigations from the server with status and the rendered answer, and they are still there after a reload", async () => {
    mockHelperApi.getSettings.mockResolvedValue(settings());
    const list = {
      investigations: [
        investigation({ id: "i3", identifier: "ACM-14", question: "What broke?", status: "working", statusLabel: "Working", statusDetail: null }),
        investigation({
          id: "i1",
          status: "done",
          statusLabel: "Done",
          statusDetail: null,
          answer: "**Yes, approve it.** Tests pass and the reviewer agreed.",
          costCents: 42,
        }),
        investigation({ id: "i0", identifier: "ACM-9", question: "Old one", status: "failed", statusLabel: "Stopped", statusDetail: "The task was cancelled before the agent finished." }),
      ],
      availability: availability({ runningCount: 1 }),
    };
    mockHelperApi.listInvestigations.mockResolvedValue(list);
    await renderOpen();

    const section = document.querySelector("[data-testid=helper-investigations]")!;
    expect(section.textContent).toContain("My investigations");
    expect(section.textContent).toContain("1 running");
    const items = [...document.querySelectorAll("[data-testid=helper-investigation]")];
    expect(items.map((el) => el.getAttribute("data-status"))).toEqual(["working", "done", "failed"]);
    expect(items[2]!.textContent).toContain("The task was cancelled before the agent finished.");
    // The done one is not the newest, so its answer is one click away.
    expect(items[1]!.querySelector("[data-testid=helper-investigation-answer]")).toBeNull();
    expect(items[1]!.textContent).toContain("$0.42 so far");
    await act(async () => {
      [...items[1]!.querySelectorAll("button")].find((b) => b.textContent === "Show the answer")!.click();
    });
    expect(items[1]!.querySelector("[data-testid=helper-investigation-answer] [data-markdown]")?.textContent).toBe(
      "**Yes, approve it.** Tests pass and the reviewer agreed.",
    );

    // A reload forgets the conversation, not the investigations.
    unmount();
    mockHelperApi.listInvestigations.mockResolvedValue({
      ...list,
      investigations: [
        { ...list.investigations[0]!, status: "done", statusLabel: "Done", answer: "The sync key expired. Ask an admin to renew it." },
        ...list.investigations.slice(1),
      ],
    });
    await renderOpen();
    const first = document.querySelector("[data-testid=helper-investigation]")!;
    expect(first.getAttribute("data-status")).toBe("done");
    expect(first.querySelector("[data-testid=helper-investigation-answer]")?.textContent).toContain("The sync key expired.");
    expect(mockHelperApi.listInvestigations).toHaveBeenCalledWith("c1");
  });

  it("polls while one is running and stops once it is done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockHelperApi.getSettings.mockResolvedValue(settings());
    mockHelperApi.listInvestigations
      .mockResolvedValueOnce({ investigations: [investigation({ status: "working", statusLabel: "Working", statusDetail: null })], availability: availability() })
      .mockResolvedValue({
        investigations: [investigation({ status: "done", statusLabel: "Done", statusDetail: null, answer: "No, wait for the fix." })],
        availability: availability(),
      });
    await renderOpen();
    expect(document.querySelector("[data-testid=helper-investigation]")?.getAttribute("data-status")).toBe("working");
    const callsBefore = mockHelperApi.listInvestigations.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_500);
    });
    await flush();
    expect(mockHelperApi.listInvestigations.mock.calls.length).toBeGreaterThan(callsBefore);
    const item = document.querySelector("[data-testid=helper-investigation]")!;
    expect(item.getAttribute("data-status")).toBe("done");
    expect(item.querySelector("[data-testid=helper-investigation-answer]")?.textContent).toContain("No, wait for the fix.");

    const callsWhenDone = mockHelperApi.listInvestigations.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    await flush();
    expect(mockHelperApi.listInvestigations.mock.calls.length).toBe(callsWhenDone);
  });
});

describe("investigationEstimateText", () => {
  it("is honest when the agent's tasks show no metered cost", () => {
    const text = investigationEstimateText(availability({ estimate: { basedOnTasks: 3, typicalMinutes: 90, typicalCostCents: 0 }, agentBudgetMonthlyCents: 0 }));
    expect(text).toContain("It usually takes about 1.5 hours");
    expect(text).toContain("show no metered cost");
    expect(text).not.toContain("monthly budget");
  });
});
