/**
 * DUR-4078: the worker's own session lifecycle -- launches one hardened
 * Chromium process per session (chromium-launch.ts), wraps its page in the
 * real `PlaywrightBrowserDriver`, and enforces the same caps
 * `server/src/services/browser-service.ts` already enforces (2 sessions per
 * instance, 1 per agent, 20-minute wall clock, 5-minute idle, 300 actions).
 *
 * That server-side enforcement is in-memory and per-process too (see that
 * file's own header comment), so it does not survive a server restart; this
 * is the second, independent layer that actually owns the real Chromium
 * process and tmpfs directory, and cleans both up even if the server's own
 * bookkeeping is gone -- a leaked session here is a live browser process and
 * disk usage on the container, not just a stale map entry.
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import type { AccessibilitySnapshot } from "@paperclipai/adapter-utils/browser-tools";
import { launchHardenedContext } from "./chromium-launch.js";
import { PlaywrightBrowserDriver } from "./playwright-driver.js";

export const MAX_CONCURRENT_SESSIONS = 2;
export const MAX_SESSIONS_PER_AGENT = 1;
export const MAX_WALL_CLOCK_MS = 20 * 60 * 1000;
export const MAX_IDLE_MS = 5 * 60 * 1000;
export const MAX_ACTIONS = 300;
const SWEEP_INTERVAL_MS = 30_000;

export class SessionLimitError extends Error {}
export class SessionExpiredError extends Error {}
export class SessionNotFoundError extends Error {}

interface WorkerSession {
  id: string;
  agentId: string;
  companyId: string;
  purpose: string;
  context: BrowserContext;
  page: Page;
  driver: PlaywrightBrowserDriver;
  userDataDir: string;
  openedAt: number;
  lastActivityAt: number;
  actionCount: number;
}

export interface OpenSessionInput {
  agentId: string;
  companyId: string;
  purpose: string;
}

export interface OpenSessionResult {
  workerSessionId: string;
  snapshot: AccessibilitySnapshot;
}

export interface SessionManagerOptions {
  sessionsRoot?: string;
  /** Injectable for tests: real code always launches a real Chromium via chromium-launch.ts. */
  launch?: (userDataDir: string) => Promise<BrowserContext>;
  /** Injectable for tests: `0` disables the periodic sweep entirely, so a test can assert on `getDriver`'s own lazy expiry check without the sweep racing to close the session first. */
  sweepIntervalMs?: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly sweepTimer: NodeJS.Timeout | null;
  private readonly sessionsRoot: string;
  private readonly launch: (userDataDir: string) => Promise<BrowserContext>;

  constructor(options: SessionManagerOptions = {}) {
    this.sessionsRoot = options.sessionsRoot ?? process.env.BROWSER_SESSIONS_ROOT?.trim() ?? "/tmp/paperclip-browser-sessions";
    this.launch = options.launch ?? ((userDataDir) => launchHardenedContext({ userDataDir }));
    const sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.sweepExpired();
      }, sweepIntervalMs);
      // Never let the sweep keep the process alive on its own.
      this.sweepTimer.unref?.();
    } else {
      this.sweepTimer = null;
    }
  }

  private async sweepExpired(): Promise<void> {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.openedAt > MAX_WALL_CLOCK_MS || now - session.lastActivityAt > MAX_IDLE_MS) {
        await this.closeSession(session.id).catch(() => undefined);
      }
    }
  }

  async openSession(input: OpenSessionInput): Promise<OpenSessionResult> {
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      throw new SessionLimitError(`This instance already has ${MAX_CONCURRENT_SESSIONS} browser sessions open.`);
    }
    const perAgent = [...this.sessions.values()].filter((s) => s.agentId === input.agentId).length;
    if (perAgent >= MAX_SESSIONS_PER_AGENT) {
      throw new SessionLimitError("This agent already has an open browser session.");
    }

    const id = randomUUID();
    const userDataDir = join(this.sessionsRoot, id);
    const context = await this.launch(userDataDir);
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const driver = new PlaywrightBrowserDriver(page);
      const session: WorkerSession = {
        id,
        agentId: input.agentId,
        companyId: input.companyId,
        purpose: input.purpose,
        context,
        page,
        driver,
        userDataDir,
        openedAt: Date.now(),
        lastActivityAt: Date.now(),
        actionCount: 0,
      };
      this.sessions.set(id, session);
      const snapshot = await driver.snapshot();
      return { workerSessionId: id, snapshot };
    } catch (error) {
      await context.close().catch(() => undefined);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Resolves a session and enforces the caps, or throws a clear reason. Every route handler calls this before touching the driver. */
  getDriver(sessionId: string): PlaywrightBrowserDriver {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError("Browser session not found. It may have expired or already been closed.");
    const now = Date.now();
    if (now - session.openedAt > MAX_WALL_CLOCK_MS) {
      void this.closeSession(sessionId);
      throw new SessionExpiredError("This browser session's 20-minute limit has passed. Open a new one.");
    }
    if (now - session.lastActivityAt > MAX_IDLE_MS) {
      void this.closeSession(sessionId);
      throw new SessionExpiredError("This browser session has been idle for more than 5 minutes and was closed. Open a new one.");
    }
    session.lastActivityAt = now;
    session.actionCount += 1;
    if (session.actionCount > MAX_ACTIONS) {
      void this.closeSession(sessionId);
      throw new SessionExpiredError("This browser session hit its 300-action limit and was closed. Open a new one.");
    }
    return session.driver;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    try {
      await session.context.close();
    } finally {
      // "tmpfs wipe at session end": the container's own tmpfs mount for
      // /tmp already reclaims this on container restart, but a live
      // container running for days should not accumulate one directory per
      // closed session in the meantime.
      await rm(session.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
  }
}
