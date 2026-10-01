// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardPulse } from "@paperclipai/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";

const mockDashboardApi = vi.hoisted(() => ({ pulse: vi.fn(), summary: vi.fn() }));
const mockApprovalsApi = vi.hoisted(() => ({ approve: vi.fn() }));

vi.mock("@/api/dashboard", () => ({ dashboardApi: mockDashboardApi }));
vi.mock("@/api/approvals", () => ({ approvalsApi: mockApprovalsApi }));

const { PulsePanel } = await import("./PulsePanel");

function pulse(overrides: Partial<DashboardPulse> = {}): DashboardPulse {
  return {
    companyId: COMPANY,
    needsYouCount: 1,
    needsYouByType: { deploy: 1 },
    needsYou: [
      {
        approvalId: "approval-1",
        type: "deploy",
        title: "Launch the new homepage",
        requestedByAgentName: "Frontend Engineer",
        createdAt: new Date("2026-10-01T00:00:00.000Z").toISOString(),
      },
    ],
    activeExecutions: [],
    recentCompletions: [],
    budget: { spentTodayCents: 500, dailyLimitCents: 2000, percentage: 25, status: "ok" },
    deploys: [],
    ...overrides,
  };
}

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact(times = 10) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("PulsePanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    mockDashboardApi.pulse.mockResolvedValue(pulse());
  });

  afterEach(async () => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PulsePanel companyId={COMPANY} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  const trigger = () => container.querySelector<HTMLButtonElement>("button");

  it("is off by default, does not poll the backend, and opens straight to Settings", async () => {
    await render();
    expect(mockDashboardApi.pulse).not.toHaveBeenCalled();
    // No unread-count pill when pulse is off.
    expect(trigger()?.textContent).toBe("");

    await act(async () => {
      trigger()?.click();
    });
    await flushReact();

    // Off by default means Settings opens first, with the toggle showing "off".
    expect(document.body.querySelector('[data-state="active"][role="tabpanel"]')?.textContent).toContain(
      "Show pulse updates",
    );
    const toggle = document.body.querySelector<HTMLButtonElement>('button[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(mockDashboardApi.pulse).not.toHaveBeenCalled();
  });

  it("once enabled, polls, shows needs-you items, and approves with one tap", async () => {
    // Pre-seed the preference so the panel starts enabled, with "Needs You" as
    // its default tab -- Radix tab triggers don't respond to a plain jsdom
    // .click() the way they do in a real browser, so we avoid simulating a
    // tab switch and instead exercise the "already enabled" render path.
    window.localStorage.setItem("paperclip.pulse.enabled", "true");

    await render();
    await flushReact();
    expect(mockDashboardApi.pulse).toHaveBeenCalledWith(COMPANY);

    await act(async () => {
      trigger()?.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("Launch the new homepage");
    expect(document.body.textContent).toContain("Frontend Engineer");

    mockApprovalsApi.approve.mockResolvedValue({ id: "approval-1", status: "approved" });
    const approveButton = Array.from(document.body.querySelectorAll("button")).find(
      (el) => el.textContent === "Approve",
    ) as HTMLButtonElement | undefined;
    expect(approveButton).toBeTruthy();
    await act(async () => {
      approveButton?.click();
    });
    await flushReact();

    expect(mockApprovalsApi.approve).toHaveBeenCalledWith("approval-1");
  });

  it("shows a count pill with the right color state once enabled", async () => {
    window.localStorage.setItem("paperclip.pulse.enabled", "true");
    mockDashboardApi.pulse.mockResolvedValue(pulse({ needsYouCount: 3 }));

    await render();
    await flushReact();

    expect(trigger()?.textContent).toBe("3");
  });
});
