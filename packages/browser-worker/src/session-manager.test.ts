import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionExpiredError, SessionLimitError, SessionManager, SessionNotFoundError, MAX_ACTIONS, MAX_CONCURRENT_SESSIONS, MAX_IDLE_MS, MAX_WALL_CLOCK_MS } from "./session-manager.js";
import { createFakeContext, createFakeFrame, createFakePage } from "./test-support/fake-playwright.js";
import type { BrowserContext } from "playwright-core";

const EMPTY_SNAPSHOT_RESULT = { kind: "snapshot" as const, tree: "", elements: [], nextIndex: 0 };

function fakeLaunch() {
  const created: Array<ReturnType<typeof createFakePage>> = [];
  const launch = vi.fn(async (_userDataDir: string) => {
    const page = createFakePage({ frames: [createFakeFrame({ evaluateResults: [EMPTY_SNAPSHOT_RESULT] })] });
    created.push(page);
    return createFakeContext(page) as unknown as BrowserContext;
  });
  return { launch, created };
}

describe("SessionManager", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pc-session-mgr-test-"));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a session and returns its initial snapshot", async () => {
    const { launch } = fakeLaunch();
    const manager = new SessionManager({ sessionsRoot: root, launch, sweepIntervalMs: 0 });

    const result = await manager.openSession({ agentId: "agent-1", companyId: "company-1", purpose: "book a hotel" });

    expect(result.workerSessionId).toBeTruthy();
    expect(result.snapshot).toEqual({ tree: "", url: "https://example.com/", title: "Example" });
    expect(launch).toHaveBeenCalledWith(join(root, result.workerSessionId));
  });

  it(`refuses a ${MAX_CONCURRENT_SESSIONS + 1}th concurrent session on the instance`, async () => {
    const { launch } = fakeLaunch();
    const manager = new SessionManager({ sessionsRoot: root, launch, sweepIntervalMs: 0 });

    for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) {
      await manager.openSession({ agentId: `agent-${i}`, companyId: "company-1", purpose: "x" });
    }

    await expect(manager.openSession({ agentId: "agent-overflow", companyId: "company-1", purpose: "x" })).rejects.toBeInstanceOf(SessionLimitError);
  });

  it("refuses a second concurrent session for the same agent", async () => {
    const { launch } = fakeLaunch();
    const manager = new SessionManager({ sessionsRoot: root, launch, sweepIntervalMs: 0 });

    await manager.openSession({ agentId: "agent-1", companyId: "company-1", purpose: "x" });

    await expect(manager.openSession({ agentId: "agent-1", companyId: "company-1", purpose: "y" })).rejects.toBeInstanceOf(SessionLimitError);
  });

  it("getDriver throws SessionNotFoundError for an unknown session id", () => {
    const { launch } = fakeLaunch();
    const manager = new SessionManager({ sessionsRoot: root, launch, sweepIntervalMs: 0 });
    expect(() => manager.getDriver("does-not-exist")).toThrow(SessionNotFoundError);
  });

  it("getDriver throws SessionExpiredError once the wall-clock limit has passed", async () => {
    const { launch } = fakeLaunch();
    const manager = new SessionManager({ sessionsRoot: root, launch, sweepIntervalMs: 0 });
    const { workerSessionId } = await manager.openSession({ agentId: "agent-1", companyId: "company-1", purpose: "x" });

    vi.advanceTimersByTime(MAX_WALL_CLOCK_MS + 1);

    expect(() => manager.getDriver(workerSessionId)).toThrow(SessionExpiredError);
    // The session must actually be gone, not just refused once -- a second agent should be able to open a new one immediately.
    expect(() => manager.getDriver(workerSessionId)).toThrow(SessionNotFoundError);
  });

  it("getDriver throws SessionExpiredError once the idle limit has passed", async () => {
    const { launch } = fakeLaunch();
    const manager = new SessionManager({ sessionsRoot: root, launch, sweepIntervalMs: 0 });
    const { workerSessionId } = await manager.openSession({ agentId: "agent-1", companyId: "company-1", purpose: "x" });

    vi.advanceTimersByTime(MAX_IDLE_MS + 1);

    expect(() => manager.getDriver(workerSessionId)).toThrow(SessionExpiredError);
  });

  it("a getDriver call resets the idle clock, so steady activity keeps a session alive past the idle window", async () => {
    const { launch } = fakeLaunch();
    const manager = new SessionManager({ sessionsRoot: root, launch, sweepIntervalMs: 0 });
    const { workerSessionId } = await manager.openSession({ agentId: "agent-1", companyId: "company-1", purpose: "x" });

    // 3 * (MAX_IDLE_MS - 1s) stays comfortably under MAX_WALL_CLOCK_MS, so
    // this only exercises the idle reset, not the wall-clock cap.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(MAX_IDLE_MS - 1000);
      expect(() => manager.getDriver(workerSessionId)).not.toThrow();
    }
  });

  it("closes a session once it hits the action cap", async () => {
    const { launch } = fakeLaunch();
    const manager = new SessionManager({ sessionsRoot: root, launch, sweepIntervalMs: 0 });
    const { workerSessionId } = await manager.openSession({ agentId: "agent-1", companyId: "company-1", purpose: "x" });

    for (let i = 0; i < MAX_ACTIONS; i++) manager.getDriver(workerSessionId);

    expect(() => manager.getDriver(workerSessionId)).toThrow(SessionExpiredError);
  });

  it("closeSession is a no-op for an unknown id (matches browserService's close-in-a-finally-block usage)", async () => {
    const { launch } = fakeLaunch();
    const manager = new SessionManager({ sessionsRoot: root, launch, sweepIntervalMs: 0 });
    await expect(manager.closeSession("does-not-exist")).resolves.toBeUndefined();
  });

  it("closeSession frees the agent's slot so it can open a new session", async () => {
    const { launch } = fakeLaunch();
    const manager = new SessionManager({ sessionsRoot: root, launch, sweepIntervalMs: 0 });
    const { workerSessionId } = await manager.openSession({ agentId: "agent-1", companyId: "company-1", purpose: "x" });

    await manager.closeSession(workerSessionId);

    await expect(manager.openSession({ agentId: "agent-1", companyId: "company-1", purpose: "y" })).resolves.toBeTruthy();
  });

  it("closeAll tears down every open session", async () => {
    const { launch, created } = fakeLaunch();
    const manager = new SessionManager({ sessionsRoot: root, launch, sweepIntervalMs: 0 });
    await manager.openSession({ agentId: "agent-1", companyId: "company-1", purpose: "x" });
    await manager.openSession({ agentId: "agent-2", companyId: "company-1", purpose: "y" });

    await manager.closeAll();

    expect(created).toHaveLength(2);
    expect(() => manager.getDriver("anything")).toThrow(SessionNotFoundError);
  });
});
