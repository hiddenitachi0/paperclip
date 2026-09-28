import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWorkerClient } from "./browser-worker-client.js";

vi.mock("./activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

const { browserService, _resetBrowserSessionsForTests } = await import("./browser-service.js");
const { logActivity } = await import("./activity-log.js");

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "c0000001-0000-4000-8000-000000000001";

function fakeDbWithAgent(agent: { id: string; companyId: string; browserAccess: string; status: string } | null) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(agent ? [agent] : [])),
        })),
      })),
    })),
  };
}

function fakeWorkerClient(overrides: Partial<BrowserWorkerClient> = {}): BrowserWorkerClient {
  return {
    openSession: vi.fn().mockResolvedValue({
      workerSessionId: "worker-session-1",
      snapshot: { tree: "[ref=e1] heading \"Example\"", url: "https://example.com", title: "Example" },
    }),
    navigate: vi.fn(),
    snapshot: vi.fn(),
    readText: vi.fn(),
    describeElement: vi.fn(),
    performClick: vi.fn(),
    performType: vi.fn(),
    performSelect: vi.fn(),
    performCheck: vi.fn(),
    focusedFormSubmitTarget: vi.fn(),
    performPressKey: vi.fn(),
    screenshot: vi.fn(),
    wait: vi.fn(),
    back: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("browserService", () => {
  beforeEach(() => {
    _resetBrowserSessionsForTests();
    vi.mocked(logActivity).mockClear();
  });

  it("refuses to open a session when the agent's browser access is off (the default)", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, browserAccess: "off", status: "idle" });
    const svc = browserService(db as any, { workerClient: fakeWorkerClient() });

    await expect(svc.open(AGENT_ID, { purpose: "book a table" })).rejects.toMatchObject({ status: 403 });
  });

  it("refuses to open a session for an agent that does not exist", async () => {
    const db = fakeDbWithAgent(null);
    const svc = browserService(db as any, { workerClient: fakeWorkerClient() });

    await expect(svc.open(AGENT_ID, { purpose: "book a table" })).rejects.toMatchObject({ status: 404 });
  });

  it("opens a session, returns the initial snapshot, and logs it", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, browserAccess: "browse_and_forms", status: "idle" });
    const worker = fakeWorkerClient();
    const svc = browserService(db as any, { workerClient: worker });

    const result = await svc.open(AGENT_ID, { purpose: "book a table", issueId: "issue-1" });

    expect(result.sessionId).toBeTruthy();
    expect(result.snapshot.url).toBe("https://example.com");
    expect(worker.openSession).toHaveBeenCalledWith({ agentId: AGENT_ID, companyId: COMPANY_ID, purpose: "book a table" });
    expect(logActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: "browser_session_opened", companyId: COMPANY_ID, agentId: AGENT_ID }),
    );
  });

  it("refuses a second concurrent session for the same agent", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, browserAccess: "browse_and_forms", status: "idle" });
    const svc = browserService(db as any, { workerClient: fakeWorkerClient() });

    await svc.open(AGENT_ID, { purpose: "first" });
    await expect(svc.open(AGENT_ID, { purpose: "second" })).rejects.toMatchObject({ status: 422 });
  });

  it("refuses to act on a session opened by a different agent", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, browserAccess: "browse_and_forms", status: "idle" });
    const worker = fakeWorkerClient({
      navigate: vi.fn().mockResolvedValue({ tree: "", url: "https://example.com/2", title: "" }),
    });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "first" });

    await expect(svc.navigate(OTHER_AGENT_ID, sessionId, "https://example.com")).rejects.toMatchObject({ status: 403 });
    expect(worker.navigate).not.toHaveBeenCalled();
  });

  it("404s for a session id that was never opened", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, browserAccess: "browse_and_forms", status: "idle" });
    const svc = browserService(db as any, { workerClient: fakeWorkerClient() });

    await expect(svc.navigate(AGENT_ID, "nonexistent-session", "https://example.com")).rejects.toMatchObject({ status: 404 });
  });

  it("closes a session, frees the per-agent slot, and logs it", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, browserAccess: "browse_and_forms", status: "idle" });
    const worker = fakeWorkerClient();
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "first" });
    await svc.close(AGENT_ID, sessionId);

    expect(worker.close).toHaveBeenCalledWith("worker-session-1");
    expect(logActivity).toHaveBeenCalledWith(db, expect.objectContaining({ action: "browser_session_closed" }));

    // The slot freed up: opening again for the same agent must succeed.
    await expect(svc.open(AGENT_ID, { purpose: "second" })).resolves.toMatchObject({});
  });

  it("hand-over marks the session unusable for further actions and logs a plain-English record", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, browserAccess: "browse_and_forms", status: "idle" });
    const svc = browserService(db as any, { workerClient: fakeWorkerClient() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "first" });
    await svc.handOver(AGENT_ID, sessionId, "hit a captcha", "please solve the captcha and continue manually");

    expect(logActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: "browser_session_handed_over",
        details: expect.objectContaining({ reason: "hit a captcha" }),
      }),
    );
    await expect(svc.snapshot(AGENT_ID, sessionId)).rejects.toMatchObject({ status: 422 });
  });
});
