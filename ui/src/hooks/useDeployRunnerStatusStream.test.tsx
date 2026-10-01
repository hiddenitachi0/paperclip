// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDeployRunnerStatusStream } from "./useDeployRunnerStatusStream";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  close() {
    this.closed = true;
  }
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let latest: ReturnType<typeof useDeployRunnerStatusStream> | null = null;

function Probe({ companyId, approvalId }: { companyId: string; approvalId?: string }) {
  latest = useDeployRunnerStatusStream(companyId, { approvalId });
  return null;
}

async function render(companyId: string, approvalId?: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe companyId={companyId} approvalId={approvalId} />);
  });
}

describe("useDeployRunnerStatusStream", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    (globalThis as any).EventSource = FakeEventSource;
  });

  afterEach(() => {
    if (root && container) {
      act(() => root!.unmount());
      container.remove();
    }
    root = null;
    container = null;
    latest = null;
  });

  it("opens an EventSource against the per-company stream endpoint, scoped to approvalId when given", async () => {
    await render("company-1", "approval-1");
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe(
      "/api/companies/company-1/deploy-runner/status/stream?approvalId=approval-1",
    );
  });

  it("replaces entries on a snapshot event and appends on an entries event", async () => {
    await render("company-1");
    const source = FakeEventSource.instances[0]!;

    await act(async () => {
      source.emit({ type: "snapshot", entries: [{ ts: "t1", approvalId: "a1", companyId: "company-1", commentDelivered: true, body: "started" }] });
    });
    expect(latest?.entries).toHaveLength(1);

    await act(async () => {
      source.emit({ type: "entries", entries: [{ ts: "t2", approvalId: "a1", companyId: "company-1", commentDelivered: true, body: "deployed" }] });
    });
    expect(latest?.entries.map((e) => e.body)).toEqual(["started", "deployed"]);

    // A fresh snapshot (e.g. after an auto-reconnect) replaces rather than appends.
    await act(async () => {
      source.emit({ type: "snapshot", entries: [{ ts: "t2", approvalId: "a1", companyId: "company-1", commentDelivered: true, body: "deployed" }] });
    });
    expect(latest?.entries.map((e) => e.body)).toEqual(["deployed"]);
  });

  it("closes the connection on unmount", async () => {
    await render("company-1");
    const source = FakeEventSource.instances[0]!;
    expect(source.closed).toBe(false);
    act(() => root!.unmount());
    root = null;
    expect(source.closed).toBe(true);
  });
});
