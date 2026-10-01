// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeployRunnerLogViewer } from "./DeployRunnerLogViewer";
import type { DeployRunnerStatusEntry } from "../api/deployRunner";

const mockUseStream = vi.hoisted(() => vi.fn());
vi.mock("../hooks/useDeployRunnerStatusStream", () => ({
  useDeployRunnerStatusStream: (...args: unknown[]) => mockUseStream(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  return container;
}

function entry(overrides: Partial<DeployRunnerStatusEntry>): DeployRunnerStatusEntry {
  return { ts: "2026-09-01T10:00:00Z", approvalId: "a1", companyId: "c1", commentDelivered: true, body: "working", ...overrides };
}

describe("DeployRunnerLogViewer", () => {
  afterEach(() => {
    if (root && container) {
      act(() => root!.unmount());
      container.remove();
    }
    root = null;
    container = null;
    mockUseStream.mockReset();
  });

  it("renders nothing when not active, without subscribing to the stream", async () => {
    mockUseStream.mockReturnValue({ entries: [], connecting: false, connected: false, error: null });
    const el = await render(<DeployRunnerLogViewer companyId="c1" approvalId="a1" active={false} />);
    expect(el.textContent).toBe("");
  });

  it("shows a waiting message with no entries yet, and a live indicator once connected", async () => {
    mockUseStream.mockReturnValue({ entries: [], connecting: false, connected: true, error: null });
    const el = await render(<DeployRunnerLogViewer companyId="c1" approvalId="a1" active />);
    expect(el.textContent).toContain("Waiting for the deploy runner");
    expect(el.textContent).toContain("Live");
  });

  it("renders streamed entries in order", async () => {
    mockUseStream.mockReturnValue({
      entries: [entry({ body: "Deploy started" }), entry({ ts: "2026-09-01T10:00:05Z", body: "Deployed — commit abc123 is live" })],
      connecting: false,
      connected: true,
      error: null,
    });
    const el = await render(<DeployRunnerLogViewer companyId="c1" approvalId="a1" active />);
    const lines = el.querySelector('[data-testid="deploy-log-viewer"]')!.textContent ?? "";
    expect(lines).toContain("Deploy started");
    expect(lines).toContain("Deployed — commit abc123 is live");
  });

  it("surfaces a stream error", async () => {
    mockUseStream.mockReturnValue({ entries: [], connecting: false, connected: false, error: new Error("Lost connection to the deploy log stream") });
    const el = await render(<DeployRunnerLogViewer companyId="c1" approvalId="a1" active />);
    expect(el.textContent).toContain("Lost connection to the deploy log stream");
  });
});
