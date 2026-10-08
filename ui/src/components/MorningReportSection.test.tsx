// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MORNING_REPORT_SETTINGS, MorningReportSection } from "./MorningReportSection";

/**
 * The "Morning report" block on a quick agent's settings: folded by default,
 * says whether it is on and when it is sent while folded, keeps its on/off
 * switch usable without opening it, and groups the settings inside.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const mockAgentsApi = vi.hoisted(() => ({ update: vi.fn() }));
const mockMorningReportsApi = vi.hoisted(() => ({ sendTestNow: vi.fn() }));
const mockPluginsApi = vi.hoisted(() => ({ bridgePerformAction: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/morning-reports", () => ({ morningReportsApi: mockMorningReportsApi }));
vi.mock("../api/plugins", () => ({ pluginsApi: mockPluginsApi }));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("MorningReportSection", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.update.mockResolvedValue({});
    mockPluginsApi.bridgePerformAction.mockResolvedValue({ data: { looks: [] } });
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
      root = null;
    }
    container.remove();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  async function render(morningReportSettings?: unknown) {
    root = createRoot(container);
    const current = root;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      current.render(
        <QueryClientProvider client={queryClient}>
          <MorningReportSection
            agent={{ id: AGENT, urlKey: "assistant", companyId: COMPANY, morningReportSettings }}
            companyId={COMPANY}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  const section = () => container.querySelector<HTMLElement>('[data-testid="morning-report-section"]')!;
  const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-label="Enable morning report"]')!;
  const trigger = () => section().querySelector<HTMLButtonElement>("button[aria-expanded]")!;

  it("starts folded, says it is off, and can be switched on without opening it", async () => {
    await render();
    expect(section().getAttribute("data-state")).toBe("closed");
    expect(section().textContent).toContain("Morning report");
    expect(section().textContent).toContain("Off");
    expect(toggle().closest("[hidden]")).toBeNull();

    await act(async () => toggle().click());
    await flush();
    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      AGENT,
      { morningReportSettings: { ...DEFAULT_MORNING_REPORT_SETTINGS, enabled: true } },
      COMPANY,
    );
  });

  it("says when it is sent while folded, and groups the settings when opened", async () => {
    await render({ ...DEFAULT_MORNING_REPORT_SETTINGS, enabled: true, time: "06:45", timezone: "Europe/Oslo" });
    expect(section().textContent).toContain("On · sends at 06:45 (Europe/Oslo)");

    await act(async () => trigger().click());
    expect(section().getAttribute("data-state")).toBe("open");

    const groups = ["morning-report-when", "morning-report-news", "morning-report-prices", "morning-report-pictures"].map(
      (id) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`),
    );
    for (let i = 0; i < groups.length - 1; i += 1) {
      expect(groups[i]!.compareDocumentPosition(groups[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(groups[0]!.querySelector<HTMLInputElement>("#mr-time")?.value).toBe("06:45");
    expect(groups[1]!.textContent).toContain("News sources");
    expect(groups[2]!.textContent).toContain("Bitcoin (BTC)");
    expect(groups[3]!.textContent).toContain("Weather picture");
  }, 20_000);

  it("shows a short note instead of the settings while it is off", async () => {
    await render();
    await act(async () => trigger().click());
    expect(container.querySelector('[data-testid="morning-report-off"]')?.textContent).toContain(
      "The morning report is off",
    );
    expect(container.querySelector("#mr-time")).toBeNull();
  });
});
