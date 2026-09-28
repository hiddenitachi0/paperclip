/**
 * DUR-4013 step 3: the server-side browser service -- the enforcement point
 * the design insists on ("the model is not trusted to follow the rules; the
 * Paperclip server enforces them, and the browser only does what the server
 * signs off"). Owns session lifecycle, the access-level and full-run gates,
 * and the concurrency/duration/action caps; the actual click/type gating
 * (final-action refusal, payment-field refusal) is the already-tested
 * `BrowserToolHandler` from `@paperclipai/browser-worker`, reused unchanged
 * against a `RemoteBrowserDriver` that forwards each call to the worker over
 * `BrowserWorkerClient`.
 *
 * Scope: browse_and_forms only, per the issue ("browse and forms only, no
 * final steps"). The gated tools (request_booking, request_purchase,
 * fill_payment_details, confirm_final_step, ...) are a later phase and are
 * not reachable from here.
 *
 * Session state is in-memory and per-process, not a new `browser_sessions`
 * table -- deliberately: nothing reads this yet (the worker container isn't
 * deployed anywhere), the switch defaults every agent to "off", and an
 * in-memory store needs no migration to add or roll back. Durable audit
 * (browser_sessions/browser_actions) is designed in section 6 of the ticket
 * but not assigned to this phase; add it before this ships wired to a real
 * worker, so a session survives a server restart and shows up in the
 * activity log per-action, not just at open/close.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  BrowserToolHandler,
  type AccessibilitySnapshot,
  type BrowserDriver,
  type ElementDescriptor,
  type ToolOutcome,
} from "@paperclipai/browser-worker";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import type { BrowserWorkerClient } from "./browser-worker-client.js";
import { createBrowserWorkerClientFromEnv } from "./browser-worker-client.js";

const MAX_CONCURRENT_SESSIONS_PER_INSTANCE = 2;
const MAX_WALL_CLOCK_MS = 20 * 60 * 1000;
const MAX_IDLE_MS = 5 * 60 * 1000;
const MAX_ACTIONS = 300;

export interface BrowserAccessAgent {
  id: string;
  companyId: string;
  browserAccess: string;
  status: string;
}

class RemoteBrowserDriver implements BrowserDriver {
  constructor(
    private readonly client: BrowserWorkerClient,
    private readonly workerSessionId: string,
  ) {}
  navigate(url: string): Promise<AccessibilitySnapshot> {
    return this.client.navigate(this.workerSessionId, url);
  }
  snapshot(): Promise<AccessibilitySnapshot> {
    return this.client.snapshot(this.workerSessionId);
  }
  readText(): Promise<string> {
    return this.client.readText(this.workerSessionId);
  }
  describeElement(ref: string): Promise<ElementDescriptor | null> {
    return this.client.describeElement(this.workerSessionId, ref);
  }
  performClick(ref: string): Promise<AccessibilitySnapshot> {
    return this.client.performClick(this.workerSessionId, ref);
  }
  performType(ref: string, text: string): Promise<AccessibilitySnapshot> {
    return this.client.performType(this.workerSessionId, ref, text);
  }
  performSelect(ref: string, value: string): Promise<AccessibilitySnapshot> {
    return this.client.performSelect(this.workerSessionId, ref, value);
  }
  performCheck(ref: string, checked: boolean): Promise<AccessibilitySnapshot> {
    return this.client.performCheck(this.workerSessionId, ref, checked);
  }
  focusedFormSubmitTarget(): Promise<ElementDescriptor | null> {
    return this.client.focusedFormSubmitTarget(this.workerSessionId);
  }
  performPressKey(key: string): Promise<AccessibilitySnapshot> {
    return this.client.performPressKey(this.workerSessionId, key);
  }
  screenshot(): Promise<Uint8Array> {
    return this.client.screenshot(this.workerSessionId);
  }
  wait(ms: number): Promise<void> {
    return this.client.wait(this.workerSessionId, ms);
  }
  back(): Promise<AccessibilitySnapshot> {
    return this.client.back(this.workerSessionId);
  }
  close(): Promise<void> {
    return this.client.close(this.workerSessionId);
  }
}

interface BrowserSession {
  id: string;
  agentId: string;
  companyId: string;
  purpose: string;
  issueId: string | null;
  workerSessionId: string;
  handler: BrowserToolHandler;
  openedAt: number;
  lastActivityAt: number;
  actionCount: number;
  handedOver: boolean;
}

/** Module-level: caps are per Paperclip instance (one process), per the design. */
const sessions = new Map<string, BrowserSession>();

function assertNotExpired(session: BrowserSession) {
  const now = Date.now();
  if (now - session.openedAt > MAX_WALL_CLOCK_MS) {
    sessions.delete(session.id);
    throw unprocessable("This browser session's 20-minute limit has passed. Open a new one.");
  }
  if (now - session.lastActivityAt > MAX_IDLE_MS) {
    sessions.delete(session.id);
    throw unprocessable("This browser session has been idle for more than 5 minutes and was closed. Open a new one.");
  }
  if (session.handedOver) {
    throw unprocessable("This browser session was handed over and is waiting on a person. It cannot take more actions.");
  }
}

function touch(session: BrowserSession) {
  session.lastActivityAt = Date.now();
  session.actionCount += 1;
  if (session.actionCount > MAX_ACTIONS) {
    sessions.delete(session.id);
    throw unprocessable("This browser session hit its 300-action limit and was closed. Open a new one.");
  }
}

export interface BrowserServiceDeps {
  workerClient?: BrowserWorkerClient;
}

export function browserService(db: Db, deps: BrowserServiceDeps = {}) {
  const workerClient = deps.workerClient ?? createBrowserWorkerClientFromEnv();

  async function loadAgent(agentId: string): Promise<BrowserAccessAgent> {
    const [agent] = await db
      .select({ id: agents.id, companyId: agents.companyId, browserAccess: agents.browserAccess, status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId));
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  /**
   * The access gate: board-only switch (never mutable by the agent itself,
   * see `assertNoAgentBrowserAccessFieldMutation` in routes/agents.ts) must
   * be something other than "off", and the agent must be active. Level
   * ("browse_and_forms" vs "book_and_buy") is not distinguished here since
   * this service only ever exposes the browse-and-forms surface; a
   * `book_and_buy` agent gets exactly the same tools until step 4/6 add the
   * gated ones.
   */
  function assertBrowserAccessAllowed(agent: BrowserAccessAgent) {
    if (agent.browserAccess === "off" || !agent.browserAccess) {
      throw forbidden("This agent's browser access is off. A board user can turn it on in the agent's settings.");
    }
    if (agent.status === "terminated" || agent.status === "pending_approval") {
      throw forbidden("This agent cannot use the browser right now.");
    }
  }

  function assertOwnSession(session: BrowserSession | undefined, agentId: string, sessionId: string): BrowserSession {
    if (!session) throw notFound("Browser session not found. It may have expired or already been closed.");
    if (session.agentId !== agentId) throw forbidden("This browser session belongs to a different agent.");
    return session;
  }

  function sessionsForAgent(agentId: string): BrowserSession[] {
    return [...sessions.values()].filter((s) => s.agentId === agentId);
  }

  async function open(agentId: string, input: { purpose: string; issueId?: string | null }): Promise<{
    sessionId: string;
    snapshot: AccessibilitySnapshot;
  }> {
    const agent = await loadAgent(agentId);
    assertBrowserAccessAllowed(agent);

    if (sessionsForAgent(agentId).length >= 1) {
      throw unprocessable("This agent already has an open browser session. Close it before opening another.");
    }
    if (sessions.size >= MAX_CONCURRENT_SESSIONS_PER_INSTANCE) {
      throw unprocessable("The browser is busy with the maximum number of sessions right now. Try again shortly.");
    }

    const handle = await workerClient.openSession({ agentId, companyId: agent.companyId, purpose: input.purpose });
    const sessionId = randomUUID();
    const session: BrowserSession = {
      id: sessionId,
      agentId,
      companyId: agent.companyId,
      purpose: input.purpose,
      issueId: input.issueId ?? null,
      workerSessionId: handle.workerSessionId,
      handler: new BrowserToolHandler(new RemoteBrowserDriver(workerClient, handle.workerSessionId)),
      openedAt: Date.now(),
      lastActivityAt: Date.now(),
      actionCount: 0,
      handedOver: false,
    };
    sessions.set(sessionId, session);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "agent",
      actorId: agentId,
      action: "browser_session_opened",
      entityType: "browser_session",
      entityId: sessionId,
      agentId,
      details: { purpose: input.purpose, issueId: input.issueId ?? null },
    });

    return { sessionId, snapshot: handle.snapshot };
  }

  function requireSession(agentId: string, sessionId: string): BrowserSession {
    const session = assertOwnSession(sessions.get(sessionId), agentId, sessionId);
    assertNotExpired(session);
    return session;
  }

  async function navigate(agentId: string, sessionId: string, url: string): Promise<AccessibilitySnapshot> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.navigate(url);
    touch(session);
    return result;
  }

  async function snapshot(agentId: string, sessionId: string): Promise<AccessibilitySnapshot> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.snapshot();
    touch(session);
    return result;
  }

  async function readText(agentId: string, sessionId: string): Promise<string> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.readText();
    touch(session);
    return result;
  }

  async function click(agentId: string, sessionId: string, ref: string, why: string): Promise<ToolOutcome<AccessibilitySnapshot>> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.click(ref, why);
    touch(session);
    return result;
  }

  async function type(agentId: string, sessionId: string, ref: string, text: string): Promise<ToolOutcome<AccessibilitySnapshot>> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.type(ref, text);
    touch(session);
    return result;
  }

  async function select(agentId: string, sessionId: string, ref: string, value: string): Promise<AccessibilitySnapshot> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.select(ref, value);
    touch(session);
    return result;
  }

  async function check(agentId: string, sessionId: string, ref: string, checked: boolean): Promise<AccessibilitySnapshot> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.check(ref, checked);
    touch(session);
    return result;
  }

  async function pressKey(agentId: string, sessionId: string, key: string): Promise<ToolOutcome<AccessibilitySnapshot>> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.pressKey(key);
    touch(session);
    return result;
  }

  async function screenshot(agentId: string, sessionId: string): Promise<Uint8Array> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.screenshot();
    touch(session);
    return result;
  }

  async function wait(agentId: string, sessionId: string, ms: number): Promise<void> {
    const session = requireSession(agentId, sessionId);
    const cappedMs = Math.min(Math.max(ms, 0), 30_000);
    await session.handler.wait(cappedMs);
    touch(session);
  }

  async function back(agentId: string, sessionId: string): Promise<AccessibilitySnapshot> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.back();
    touch(session);
    return result;
  }

  async function close(agentId: string, sessionId: string): Promise<void> {
    const session = assertOwnSession(sessions.get(sessionId), agentId, sessionId);
    sessions.delete(sessionId);
    try {
      await session.handler.close();
    } finally {
      await logActivity(db, {
        companyId: session.companyId,
        actorType: "agent",
        actorId: agentId,
        action: "browser_session_closed",
        entityType: "browser_session",
        entityId: sessionId,
        agentId,
        details: { actionCount: session.actionCount },
      });
    }
  }

  /**
   * Plain tool per the design ("browser_hand_over({reason, whatFilipShouldDo})")
   * -- not a decision, just a stop: closes the session to further agent
   * action and writes an activity-log entry a person can act on. The
   * design's "park until an approval" behaviour only applies to the gated
   * tools (booking/purchase clearances), which this phase does not build.
   */
  async function handOver(agentId: string, sessionId: string, reason: string, whatFilipShouldDo: string): Promise<void> {
    const session = assertOwnSession(sessions.get(sessionId), agentId, sessionId);
    session.handedOver = true;
    await logActivity(db, {
      companyId: session.companyId,
      actorType: "agent",
      actorId: agentId,
      action: "browser_session_handed_over",
      entityType: "browser_session",
      entityId: sessionId,
      agentId,
      details: { reason, whatFilipShouldDo, issueId: session.issueId },
    });
  }

  return {
    open,
    navigate,
    snapshot,
    readText,
    click,
    type,
    select,
    check,
    pressKey,
    screenshot,
    wait,
    back,
    close,
    handOver,
  };
}

/** Test-only: the session map is module state so it survives across `browserService(db)` calls within one process. */
export function _resetBrowserSessionsForTests(): void {
  sessions.clear();
}
