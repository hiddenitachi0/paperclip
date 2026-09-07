// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetHealthSnapshot } from "@paperclipai/shared";
import { FleetHealthStrip, FleetHealthStripView, fleetHealthFacts, formatFleetDuration } from "./FleetHealthStrip";

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../api/health", () => ({
  healthApi: mockHealthApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

const healthyFleet: FleetHealthSnapshot = {
  available: true,
  computedAt: "2026-09-06T10:00:00.000Z",
  runs: {
    windowMinutes: 15,
    startedInWindow: 9,
    succeededInWindow: 7,
    failedInWindow: 1,
    cancelledInWindow: 0,
    running: 3,
    queued: 0,
    oldestQueuedWaitMs: null,
    zombieCandidates: 0,
    zombieSilenceMinutes: 30,
  },
  slots: { max: 4, used: 3, available: 1, saturated: false },
  agents: { inError: 0, inErrorSample: [] },
  scheduler: {
    enabled: true,
    intervalMs: 30_000,
    lastTickStartedAt: "2026-09-06T09:59:48.000Z",
    lastTickFinishedAt: "2026-09-06T09:59:48.200Z",
    lastTickResult: { checked: 12, enqueued: 3, skipped: 9 },
    lastTickError: null,
    sinceLastTickMs: 12_000,
    stale: false,
  },
  requests: {
    inFlight: 2,
    streaming: 0,
    peakInFlight: 9,
    peakInFlightAt: "2026-09-06T09:00:00.000Z",
    longestInFlightMs: 120,
    slowInFlight: 0,
    slowThresholdMs: 10_000,
    overloadThreshold: 50,
    overloaded: false,
    totalStarted: 100,
    totalFinished: 98,
  },
  database: { available: true, poolMax: 20, connections: 5, active: 1, idleInTransaction: 0, waitingOnLocks: 0 },
  summary: {
    level: "ok",
    headline: "Runs are flowing: 9 started, 7 finished, 1 failed in the last 15 minutes. 3 of 4 slots in use.",
    notes: [],
  },
};

const starvedFleet: FleetHealthSnapshot = {
  ...healthyFleet,
  runs: { ...healthyFleet.runs, running: 4, queued: 15, oldestQueuedWaitMs: 20 * 60_000, zombieCandidates: 1 },
  slots: { max: 4, used: 4, available: 0, saturated: true },
  agents: {
    inError: 2,
    inErrorSample: [
      { id: "a", name: "Reviewer", companyId: "c", errorAt: "2026-09-06T08:00:00.000Z" },
      { id: "b", name: "Writer", companyId: "c", errorAt: null },
    ],
  },
  summary: {
    level: "warning",
    headline:
      'All 4 run slots are in use and 15 runs are waiting for one (the oldest has waited 20 minutes). Nothing is broken; raise "Max concurrent runs (whole instance)" under Settings > Instance settings > General to let more through.',
    notes: [
      "1 run has shown no output for 30+ minutes and may be stuck, holding a slot. The watchdog ends a run once its process is confirmed gone.",
      "2 agents have stopped with an error and will not take work until someone clears it: Reviewer, Writer.",
      "Runs are flowing: 9 started, 7 finished, 1 failed in the last 15 minutes. 4 of 4 slots in use, 15 queued.",
    ],
  },
};

function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  mockHealthApi.get.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("formatFleetDuration", () => {
  it("rounds to what an operator would say", () => {
    expect(formatFleetDuration(12_000)).toBe("12s");
    expect(formatFleetDuration(20 * 60_000)).toBe("20 min");
    expect(formatFleetDuration(125 * 60_000)).toBe("2 h 5 min");
    expect(formatFleetDuration(120 * 60_000)).toBe("2 h");
    expect(formatFleetDuration(null)).toBe("unknown");
  });
});

describe("fleetHealthFacts", () => {
  it("summarises the numbers and flags the ones that need a look", () => {
    const facts = fleetHealthFacts(starvedFleet);
    expect(facts.map((fact) => fact.key)).toEqual(["runs", "slots", "zombies", "agents", "scheduler", "requests"]);
    expect(facts[0]).toEqual({ key: "runs", text: "9 started · 7 finished · 1 failed (last 15 min)", alert: false });
    expect(facts[1]).toEqual({ key: "slots", text: "4 of 4 slots in use · 15 queued (oldest 20 min)", alert: true });
    expect(facts[2]).toEqual({ key: "zombies", text: "1 run silent for 30+ min", alert: true });
    expect(facts[3]).toEqual({ key: "agents", text: "2 agents need attention", alert: true });
    expect(facts[4]).toEqual({ key: "scheduler", text: "Scheduler ticked 12s ago", alert: false });
    expect(facts[5]).toEqual({ key: "requests", text: "2 requests in flight", alert: false });
  });

  it("reads calmly when nothing is wrong and loudly when the scheduler is off", () => {
    const calm = fleetHealthFacts(healthyFleet);
    expect(calm.every((fact) => !fact.alert)).toBe(true);
    expect(calm[2]?.text).toBe("No stuck runs");
    expect(calm[3]?.text).toBe("No agents in error");

    const off = fleetHealthFacts({ ...healthyFleet, scheduler: { ...healthyFleet.scheduler, enabled: false } });
    expect(off[4]).toEqual({ key: "scheduler", text: "Scheduler off", alert: true });
    const stale = fleetHealthFacts({ ...healthyFleet, scheduler: { ...healthyFleet.scheduler, stale: true, sinceLastTickMs: 5 * 3_600_000 } });
    expect(stale[4]).toEqual({ key: "scheduler", text: "Scheduler ticked 5 h ago", alert: true });
  });

  it("shows slow requests and open streams as information, and only a pile-up as an alert", () => {
    const busy = fleetHealthFacts({
      ...healthyFleet,
      requests: { ...healthyFleet.requests, inFlight: 3, slowInFlight: 1, streaming: 2 },
    });
    expect(busy[5]).toEqual({ key: "requests", text: "3 requests in flight (1 slow) · 2 streaming", alert: false });

    const overloaded = fleetHealthFacts({
      ...healthyFleet,
      requests: { ...healthyFleet.requests, inFlight: 60, overloaded: true },
    });
    expect(overloaded[5]).toEqual({ key: "requests", text: "60 requests in flight", alert: true });
  });
});

describe("FleetHealthStripView", () => {
  it("renders nothing when the health payload carries no fleet signal (anonymous callers)", () => {
    render(<FleetHealthStripView fleet={undefined} />);
    expect(container!.querySelector('[data-testid="fleet-health-strip"]')).toBeNull();
  });

  it("shows a healthy fleet as one calm sentence", () => {
    render(<FleetHealthStripView fleet={healthyFleet} />);
    const strip = container!.querySelector('[data-testid="fleet-health-strip"]');
    expect(strip?.getAttribute("data-level")).toBe("ok");
    expect(strip?.textContent).toContain("Healthy.");
    expect(container!.querySelector('[data-testid="fleet-health-headline"]')?.textContent).toBe(healthyFleet.summary.headline);
    expect(container!.querySelectorAll('[data-testid="fleet-health-note"]')).toHaveLength(0);
  });

  it("shows the 2026-09-06 starvation as a warning with the cap explanation and the notes", () => {
    render(<FleetHealthStripView fleet={starvedFleet} />);
    const strip = container!.querySelector('[data-testid="fleet-health-strip"]');
    expect(strip?.getAttribute("data-level")).toBe("warning");
    expect(strip?.textContent).toContain("Needs a look.");
    expect(strip?.textContent).toContain('raise "Max concurrent runs (whole instance)" under Settings > Instance settings > General');
    const notes = [...container!.querySelectorAll('[data-testid="fleet-health-note"]')].map((node) => node.textContent);
    expect(notes).toHaveLength(3);
    expect(notes[1]).toContain("Reviewer, Writer");
    expect(container!.querySelector('[data-testid="fleet-health-fact-slots"]')?.textContent).toContain("4 of 4 slots in use · 15 queued");
  });

  it("never renders a failed check as healthy (DUR-98)", () => {
    render(<FleetHealthStripView fleet={{ available: false, reason: "database_unreachable" }} />);
    const strip = container!.querySelector('[data-testid="fleet-health-strip"]');
    expect(strip?.getAttribute("data-level")).toBe("unavailable");
    expect(strip?.textContent).toContain("Fleet health could not be checked right now.");
    expect(strip?.textContent).toContain("database_unreachable");
  });
});

describe("FleetHealthStrip", () => {
  it("loads the health payload and renders its fleet signal", async () => {
    mockHealthApi.get.mockResolvedValue({ status: "ok", fleet: healthyFleet });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <FleetHealthStrip />
      </QueryClientProvider>,
    );
    await flush();
    await flush();
    expect(mockHealthApi.get).toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="fleet-health-strip"]')?.getAttribute("data-level")).toBe("ok");
    queryClient.clear();
  });

  it("shows the check as unavailable when the health request itself fails", async () => {
    mockHealthApi.get.mockRejectedValue(new Error("Failed to load health (503)"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <FleetHealthStrip />
      </QueryClientProvider>,
    );
    await flush();
    await flush();
    const strip = container!.querySelector('[data-testid="fleet-health-strip"]');
    expect(strip?.getAttribute("data-level")).toBe("unavailable");
    expect(strip?.textContent).toContain("Failed to load health (503)");
    queryClient.clear();
  });
});
