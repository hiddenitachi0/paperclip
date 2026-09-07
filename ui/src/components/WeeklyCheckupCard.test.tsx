// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatestCheckupResponse } from "../api/checkups";
import { WeeklyCheckupCard, WeeklyCheckupCardView, describeCheckupSuggestions } from "./WeeklyCheckupCard";

const mockCheckupsApi = vi.hoisted(() => ({
  latest: vi.fn(),
  run: vi.fn(),
}));
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("../api/checkups", () => ({
  checkupsApi: mockCheckupsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

const openReport: LatestCheckupResponse = {
  report: {
    id: "33333333-3333-4333-8333-333333333333",
    identifier: "DUR-900",
    title: "Weekly check-up for Durkan, 2026-09-07: 3 things to look at",
    status: "todo",
    createdAt: "2026-09-07T09:00:00.000Z",
  },
  suggestionCount: 3,
  pendingSuggestionCount: 3,
  suggestionsStatus: "pending",
};

const nothingOpen: LatestCheckupResponse = {
  report: null,
  suggestionCount: 0,
  pendingSuggestionCount: 0,
  suggestionsStatus: "none",
};

function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => {
    root!.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
}

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  mockCheckupsApi.latest.mockReset();
  mockCheckupsApi.run.mockReset();
  mockNavigate.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("describeCheckupSuggestions", () => {
  it("says plainly what waits on the operator", () => {
    expect(describeCheckupSuggestions(openReport)).toBe(
      "3 suggestions waiting for you. Tick the ones you agree with and press accept, or hide the ones you do not want to see for a month.",
    );
    expect(describeCheckupSuggestions({ ...openReport, suggestionCount: 1, pendingSuggestionCount: 0, suggestionsStatus: "accepted" })).toBe(
      "You have already decided on the 1 suggestion. Nothing more to do here until the next check-up.",
    );
    expect(describeCheckupSuggestions({ ...openReport, suggestionCount: 2, pendingSuggestionCount: 0, suggestionsStatus: "rejected" })).toBe(
      "You turned down the 2 suggestions. Nothing more to do here until the next check-up.",
    );
    expect(describeCheckupSuggestions({ ...openReport, suggestionCount: 0, pendingSuggestionCount: 0, suggestionsStatus: "none" })).toBe(
      "Nothing needed doing. The report is just a record.",
    );
    expect(describeCheckupSuggestions(nothingOpen)).toBe("");
  });
});

describe("WeeklyCheckupCardView", () => {
  it("shows the open report's headline, the suggestion count and a link to the report", () => {
    render(<WeeklyCheckupCardView latest={openReport} running={false} runMessage={null} runError={null} onRun={() => {}} />);

    const card = container!.querySelector('[data-testid="weekly-checkup-card"]');
    expect(card?.getAttribute("data-pending")).toBe("3");
    expect(container!.querySelector('[data-testid="weekly-checkup-headline"]')?.textContent).toBe(
      "Weekly check-up for Durkan, 2026-09-07: 3 things to look at",
    );
    expect(container!.querySelector('[data-testid="weekly-checkup-suggestions"]')?.textContent).toContain("3 suggestions waiting for you");
    const links = [...container!.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("/issues/DUR-900");
    expect(container!.querySelector('button[aria-label="Run check-up now"]')?.textContent).toBe("Run check-up now");
  });

  it("explains what the button does when no check-up is open", () => {
    render(<WeeklyCheckupCardView latest={nothingOpen} running={false} runMessage={null} runError={null} onRun={() => {}} />);

    expect(container!.querySelector('[data-testid="weekly-checkup-empty"]')?.textContent).toContain("No check-up is open right now.");
    expect(container!.querySelector('[data-testid="weekly-checkup-card"]')?.getAttribute("data-pending")).toBe("0");
    expect(container!.querySelector("a")).toBeNull();
  });
});

describe("WeeklyCheckupCard", () => {
  it("loads the latest check-up and runs one on demand, then goes to the report", async () => {
    mockCheckupsApi.latest.mockResolvedValue(nothingOpen);
    mockCheckupsApi.run.mockResolvedValue({
      outcome: "created",
      dryRun: false,
      reportIssueId: openReport.report!.id,
      reportIdentifier: "DUR-900",
      message: "Found 3 things to look at.",
      title: openReport.report!.title,
      body: "...",
      findingCount: 3,
      findings: [],
    });

    render(<WeeklyCheckupCard companyId={COMPANY_ID} />);
    await flush();

    expect(mockCheckupsApi.latest).toHaveBeenCalledWith(COMPANY_ID);
    expect(container!.querySelector('[data-testid="weekly-checkup-empty"]')).not.toBeNull();

    const button = container!.querySelector<HTMLButtonElement>('button[aria-label="Run check-up now"]');
    await act(async () => {
      button?.click();
    });
    await flush();

    expect(mockCheckupsApi.run).toHaveBeenCalledWith(COMPANY_ID);
    expect(container!.querySelector('[data-testid="weekly-checkup-message"]')?.textContent).toBe("Found 3 things to look at.");
    expect(mockNavigate).toHaveBeenCalledWith("/issues/DUR-900");
  });

  it("tells the operator in plain words when the check-up could not run", async () => {
    mockCheckupsApi.latest.mockResolvedValue(openReport);
    mockCheckupsApi.run.mockRejectedValue(new Error("Company not found"));

    render(<WeeklyCheckupCard companyId={COMPANY_ID} />);
    await flush();
    expect(container!.querySelector('[data-testid="weekly-checkup-headline"]')?.textContent).toContain("3 things to look at");

    await act(async () => {
      container!.querySelector<HTMLButtonElement>('button[aria-label="Run check-up now"]')?.click();
    });
    await flush();

    expect(container!.querySelector('[data-testid="weekly-checkup-error"]')?.textContent).toBe(
      "The check-up could not run: Company not found",
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("renders nothing for viewers the server turns away", async () => {
    const { ApiError } = await import("../api/client");
    mockCheckupsApi.latest.mockRejectedValue(new ApiError("Board authentication required", 403, {}));

    render(<WeeklyCheckupCard companyId={COMPANY_ID} />);
    await flush();

    expect(container!.querySelector('[data-testid="weekly-checkup-card"]')).toBeNull();
  });
});
