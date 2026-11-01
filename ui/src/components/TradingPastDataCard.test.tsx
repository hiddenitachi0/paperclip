// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ gate: null as unknown, runs: [] as unknown[], queue: vi.fn(async () => ({ id: "r9", status: "queued" })) }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => <a href={to} {...rest}>{children}</a>,
}));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../api/trading", () => ({
  tradingApi: {
    startGate: async () => mocks.gate,
    backtests: async () => mocks.runs,
    queueBacktest: mocks.queue,
    cancelBacktest: async () => ({}),
  },
}));

import { TradingPastDataCard } from "./TradingPastDataCard";

const baseGate = { cleared: false, basis: null, versionId: "v1", versionNumber: 1, latestRun: null, queuedRunId: null, overrides: [], variantsTried: 0, holdoutReads: 0 };

async function render(props: Partial<React.ComponentProps<typeof TradingPastDataCard>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOverride = vi.fn();
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TradingPastDataCard companyId="c1" strategyId="s1" canManage blockedReason={null} canOverride overrideBusy={false} onOverride={onOverride} {...props} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return { container, root, onOverride };
}

afterEach(() => {
  document.body.innerHTML = "";
  mocks.runs = [];
});

describe("TradingPastDataCard", () => {
  it("shows the passed label exactly as the server's start state says", async () => {
    mocks.gate = { ...baseGate, cleared: true, basis: "passed" };
    mocks.runs = [{ id: "r1", versionId: "v1", purpose: "gate", status: "succeeded", gatePassed: true, gate: null, variantsTried: 1, error: null, createdAt: "2026-11-01T10:00:00Z", startedAt: null, finishedAt: "2026-11-01T10:08:00Z" }];
    const { container, root } = await render();
    expect(container.querySelector('[data-testid="start-state"]')?.textContent).toContain("Passed the past-data checks: paper only, not a recommendation");
    expect(container.querySelector('[data-testid="past-data-latest"] a')?.getAttribute("href")).toBe("/trading/s1/past-data/r1");
    await act(async () => root.unmount());
  });

  it("shows a blocked start state, the server's reason, and the owner override only for an owner", async () => {
    mocks.gate = baseGate;
    const reason = 'Strategy "Trend" (rules version 1) has not passed the past-data test yet, so it cannot start.';
    const { container, root, onOverride } = await render({ blockedReason: reason });
    expect(container.querySelector('[data-testid="start-state"]')?.getAttribute("data-basis")).toBe("none");
    expect(container.querySelector('[data-testid="start-blocked-reason"]')?.textContent).toBe(reason);
    const open = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Start anyway as the owner"))!;
    await act(async () => open.click());
    const ok = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("on my say-so"))!;
    expect(ok.disabled).toBe(true);
    const box = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "I want to watch it on paper first");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ok.disabled).toBe(false);
    await act(async () => ok.click());
    expect(onOverride).toHaveBeenCalledWith("I want to watch it on paper first");
    await act(async () => root.unmount());

    const second = await render({ blockedReason: reason, canOverride: false });
    expect(second.container.textContent).not.toContain("Start anyway");
    await act(async () => second.root.unmount());
  });

  it("shows progress while a test is waiting or running and disables a second one", async () => {
    mocks.gate = { ...baseGate, queuedRunId: "r2" };
    mocks.runs = [{ id: "r2", versionId: "v1", purpose: "gate", status: "running", gatePassed: null, gate: null, variantsTried: null, error: null, createdAt: "2026-11-01T10:00:00Z", startedAt: new Date().toISOString(), finishedAt: null }];
    const { container, root } = await render();
    expect(container.querySelector('[data-testid="past-data-progress"]')?.textContent).toContain("Running since");
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Test on past data"))!;
    expect(button.disabled).toBe(true);
    await act(async () => root.unmount());
  });

  it("hides the test button from people who cannot manage trading", async () => {
    mocks.gate = baseGate;
    const { container, root } = await render({ canManage: false });
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Test on past data"))).toBe(false);
    await act(async () => root.unmount());
  });
});
