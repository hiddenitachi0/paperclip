/**
 * DUR-4013 step 3 / DUR-4037 step 4: the server-side browser service -- the
 * enforcement point the design insists on ("the model is not trusted to
 * follow the rules; the Paperclip server enforces them, and the browser only
 * does what the server signs off"). Owns session lifecycle, the access-level
 * and full-run gates, the concurrency/duration/action caps, and (step 4) the
 * booking gate; the actual click/type gating (final-action refusal,
 * payment-field refusal) is the already-tested `BrowserToolHandler` from
 * `@paperclipai/adapter-utils/browser-tools` (moved there from
 * `@paperclipai/browser-worker`, which is private/unpublished, so a
 * published `@paperclipai/server` can still resolve it -- see
 * `packages/browser-worker/src/index.ts`), reused unchanged against a
 * `RemoteBrowserDriver` that forwards each call to the worker over
 * `BrowserWorkerClient`.
 *
 * Step 4 scope: `request_booking` + `confirm_final_step`, `book_and_buy`
 * agents only. Filip's ruling overrides the original design -- EVERY
 * booking, free or not, needs his approval card; there is no auto-clear path
 * at all, so `requestBooking` always files a `request_board_approval` (see
 * `bookingRequestPayloadSchema`) and `confirmFinalStep` only ever proceeds
 * once that specific approval is `approved`. `request_purchase`,
 * `fill_payment_details`, `check_clearance`, `wait_for_outcome`,
 * `report_outcome` (the card/purchase side of the design) and `site_login`
 * fill-in (login into Filip's accounts) are NOT built in this phase -- see
 * the PR description's "Decisions I made" for why, and the follow-up issue
 * this phase files for them.
 *
 * Session state is in-memory and per-process, not a new `browser_sessions`
 * table -- deliberately: nothing reads this yet (the worker container isn't
 * deployed anywhere), the switch defaults every agent to "off", and an
 * in-memory store needs no migration to add or roll back. Durable audit
 * (browser_sessions/browser_actions) is designed in section 6 of the ticket
 * but not assigned to this phase; add it before this ships wired to a real
 * worker, so a session survives a server restart and shows up in the
 * activity log per-action, not just at open/close. A parked
 * `pendingBooking` therefore does not survive a server restart either --
 * acceptable for now since a `book_and_buy` agent capable of filing one at
 * all requires a board user to have deliberately turned both the per-agent
 * switch AND the company kill switch on, which nothing does yet.
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
} from "@paperclipai/adapter-utils/browser-tools";
import { bookingRequestPayloadSchema } from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { approvalService } from "./approvals.js";
import { isAmountStillAcceptable, parseLargestPageAmount, type ParsedPageAmount } from "./browser-amount.js";
import { pageUrlKey, registrableDomain } from "./browser-domain.js";
import type { BrowserWorkerClient } from "./browser-worker-client.js";
import { createBrowserWorkerClientFromEnv } from "./browser-worker-client.js";
import { companyPaymentSettingsService } from "./company-payment-settings.js";
import { issueService } from "./issues.js";
import { paymentNoticesService } from "./payment-notices.js";
import { getStorageService } from "../storage/index.js";

const MAX_CONCURRENT_SESSIONS_PER_INSTANCE = 2;
const MAX_WALL_CLOCK_MS = 20 * 60 * 1000;
const MAX_IDLE_MS = 5 * 60 * 1000;
const MAX_ACTIONS = 300;
/** Design section 1: "parked sessions live until the approval expires (default 30 min)". */
const BOOKING_APPROVAL_EXPIRY_MS = 30 * 60 * 1000;

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

interface PendingBooking {
  approvalId: string;
  merchantDomain: string;
  /** ms epoch; design section 1's 30-minute approval expiry. */
  expiresAt: number;
  /**
   * Security fix (DUR-4045 review): origin+pathname of the page Filip's
   * approval card was filed from. `merchantDomain` alone let one approved
   * booking's clearance cover any final click anywhere on the same domain
   * for up to 30 minutes; `confirmFinalStep` now requires the same page too.
   */
  pageUrl: string;
  /** Role + accessible name of the exact element Filip approved -- confirmFinalStep must resolve to this same element, not merely any element on the bound page. */
  elementRole: string;
  elementName: string | null;
  /** Largest amount visible on the page at request time, if any; confirmFinalStep refuses a higher (or newly-appeared) amount. */
  amount: ParsedPageAmount | null;
}

/** `el.label` (accessible label) wins over `el.name` (HTML `name` attribute) as the human-readable identity of an element, matching `elementText()` in `@paperclipai/adapter-utils/browser-tools`. */
function accessibleName(el: { label?: string | null; name?: string | null }): string | null {
  return el.label ?? el.name ?? null;
}

interface BrowserSession {
  id: string;
  agentId: string;
  companyId: string;
  purpose: string;
  issueId: string | null;
  workerSessionId: string;
  /** Kept alongside `handler` so `confirmFinalStep` can call the driver directly once Filip has approved, bypassing the generic final-action refusal `handler` would otherwise apply -- the approval IS the sign-off for that one click. */
  driver: BrowserDriver;
  handler: BrowserToolHandler;
  openedAt: number;
  lastActivityAt: number;
  actionCount: number;
  handedOver: boolean;
  pendingBooking: PendingBooking | null;
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
  const approvals = approvalService(db);
  const companyPaymentSettings = companyPaymentSettingsService(db);
  const paymentNotices = paymentNoticesService(db);
  const issues = issueService(db);

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
   * ("browse_and_forms" vs "book_and_buy") is not distinguished here --
   * both get the plain tools this function guards. `book_and_buy` additionally
   * needs `assertBookAndBuyAllowed` below before it may touch a gated tool.
   */
  function assertBrowserAccessAllowed(agent: BrowserAccessAgent) {
    if (agent.browserAccess === "off" || !agent.browserAccess) {
      throw forbidden("This agent's browser access is off. A board user can turn it on in the agent's settings.");
    }
    if (agent.status === "terminated" || agent.status === "pending_approval") {
      throw forbidden("This agent cannot use the browser right now.");
    }
  }

  /**
   * The booking-gate access check (DUR-4037): everything the design calls
   * for -- "Everything behind agents.browser_access = book_and_buy (default
   * off) and the company kill switch" -- checked fresh on every gated call,
   * never cached on the session, so a board user flipping either switch off
   * mid-session takes effect on the very next `request_booking`/
   * `confirm_final_step`.
   */
  async function assertBookAndBuyAllowed(agent: BrowserAccessAgent) {
    assertBrowserAccessAllowed(agent);
    if (agent.browserAccess !== "book_and_buy") {
      throw forbidden("This agent can browse but cannot book. A board user can turn booking on in the agent's settings.");
    }
    if (process.env.PAPERCLIP_BROWSER_DISABLED === "1") {
      throw forbidden("Browser bookings are switched off on this instance.");
    }
    const settings = await companyPaymentSettings.get(agent.companyId);
    if (!settings.bookingEnabled) {
      throw forbidden("Bookings are switched off for this company. A board user can turn them on in Company settings.");
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
    const driver = new RemoteBrowserDriver(workerClient, handle.workerSessionId);
    const session: BrowserSession = {
      id: sessionId,
      agentId,
      companyId: agent.companyId,
      purpose: input.purpose,
      issueId: input.issueId ?? null,
      workerSessionId: handle.workerSessionId,
      driver,
      handler: new BrowserToolHandler(driver),
      openedAt: Date.now(),
      lastActivityAt: Date.now(),
      actionCount: 0,
      handedOver: false,
      pendingBooking: null,
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
   * action, writes an activity-log entry, and (DUR-4037) drops a plain-
   * language `hand_over` payment notice in the outbox so the Telegram bridge
   * tells Filip about it even if nobody is watching the activity log. The
   * design's "park until an approval" behaviour is `requestBooking` below,
   * not this.
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
    await paymentNotices.writeHandOver({
      companyId: session.companyId,
      agentId,
      text: `I got stuck in the browser and need you: ${reason}\n\nWhat to do: ${whatFilipShouldDo}`,
    });
  }

  /**
   * The booking gate's filing half (DUR-4037). Filip's ruling: EVERY
   * booking, free or not, needs his approval card -- there is no auto-clear
   * input to accept here, unlike the design's original purchase-side
   * threshold. Files a `request_board_approval` (kind "booking") stamped
   * server-side with the page's registrable domain (never the raw URL, which
   * an agent's own words could pad with a lie) and a screenshot, and parks
   * the session's one live booking slot on it; `confirmFinalStep` is the
   * only thing that can consume it, and only once it is `approved`. Security
   * fix (DUR-4045 review): also stamps the exact page (origin+path), the
   * target element's role/accessible name, and the largest amount visible on
   * the page -- `confirmFinalStep` requires an exact match on all three
   * before it will use this clearance, so approving this booking does not
   * clear a different page, a different button, or a higher price.
   */
  async function requestBooking(
    agentId: string,
    sessionId: string,
    summary: string,
    ref: string,
  ): Promise<{ approvalId: string; status: "pending_approval" }> {
    const agent = await loadAgent(agentId);
    await assertBookAndBuyAllowed(agent);
    const session = requireSession(agentId, sessionId);

    if (session.pendingBooking) {
      throw unprocessable(
        "This session already has a booking waiting on Filip's decision. Wait for confirm_final_step or close the session before starting another.",
      );
    }

    const snap = await session.handler.snapshot();
    const merchantDomain = registrableDomain(snap.url);
    if (!merchantDomain) {
      throw unprocessable("Could not tell what site this is from the current page. Take a fresh browser_snapshot on the booking page first.");
    }
    const pageUrl = pageUrlKey(snap.url);
    if (!pageUrl) {
      throw unprocessable("Could not tell what page this is from the current page. Take a fresh browser_snapshot on the booking page first.");
    }
    const el = await session.driver.describeElement(ref);
    if (!el) throw new Error(`Unknown element ref "${ref}"; take a fresh browser_snapshot`);
    const amount = parseLargestPageAmount(snap.tree);

    const screenshotBytes = await session.handler.screenshot();
    const stored = await getStorageService().putFile({
      companyId: agent.companyId,
      namespace: "files",
      originalFilename: `booking-request-${sessionId}.png`,
      contentType: "image/png",
      body: Buffer.from(screenshotBytes),
    });
    const file = await issues.createCompanyFile({
      companyId: agent.companyId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: agentId,
    });

    const expiresAt = new Date(Date.now() + BOOKING_APPROVAL_EXPIRY_MS);
    const payload = bookingRequestPayloadSchema.parse({
      kind: "booking",
      sessionId,
      agentId,
      merchantDomain,
      agentSummary: summary,
      screenshotFileId: file.id,
      title: `Booking on ${merchantDomain}`,
      summary: `Wants to book this on ${merchantDomain}: "${summary}". See the screenshot for what will be booked. This needs your OK even if it is free.`,
      expiresAt: expiresAt.toISOString(),
    });

    const approval = await approvals.create(agent.companyId, {
      type: "request_board_approval",
      requestedByAgentId: agentId,
      payload,
      status: "pending",
    });

    session.pendingBooking = {
      approvalId: approval!.id,
      merchantDomain,
      expiresAt: expiresAt.getTime(),
      pageUrl,
      elementRole: el.role,
      elementName: accessibleName(el),
      amount,
    };
    touch(session);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "agent",
      actorId: agentId,
      action: "browser_booking_requested",
      entityType: "approval",
      entityId: approval!.id,
      agentId,
      details: { sessionId, merchantDomain, summary, ref },
    });

    return { approvalId: approval!.id, status: "pending_approval" };
  }

  /**
   * The booking gate's confirming half (DUR-4037). Only proceeds when the
   * session's parked `pendingBooking` approval is `approved`, has not
   * expired, the page is still the exact page it was filed against (not
   * just the same domain -- a merchant redirecting/iframing to a different
   * page, or a different domain, between filing and confirming must not
   * silently inherit the clearance), `ref` resolves to the same
   * role+accessible-name element Filip's card showed, and the largest
   * amount visible on the page has not gone up (or newly appeared where
   * there was none). Any mismatch clears the slot and refuses, per the
   * DUR-4045 review: clearance is single-use and does not survive a failed
   * match, so the agent must call `request_booking` again from the actual
   * page/button/price Filip is being asked to see.
   *
   * On a match this calls `session.driver.performClick` directly, bypassing
   * only the final-action/invoice *wording* refusal `BrowserToolHandler`
   * would otherwise give this exact button -- Filip's approval, not another
   * heuristic, is the sign-off for that one click. The payment-field-in-form
   * refusal stays in force even for the approved element: bookings in this
   * phase never get a payment-field clearance, so a form that suddenly
   * contains one is refused regardless of what Filip approved. The slot is
   * cleared the instant every check has passed and the click is committed --
   * before the click's own result is known -- so a clearance is consumed on
   * the first confirm attempt, success or failure, never left dangling for
   * a retry.
   */
  async function confirmFinalStep(agentId: string, sessionId: string, ref: string): Promise<AccessibilitySnapshot> {
    const agent = await loadAgent(agentId);
    await assertBookAndBuyAllowed(agent);
    const session = requireSession(agentId, sessionId);

    const pending = session.pendingBooking;
    if (!pending) {
      throw unprocessable("There is no booking waiting for a decision on this session. Call request_booking first.");
    }
    if (Date.now() > pending.expiresAt) {
      session.pendingBooking = null;
      throw unprocessable("Filip's decision window for this booking expired. Call request_booking again if you still want it.");
    }

    const approval = await approvals.getById(pending.approvalId);
    if (!approval || approval.status === "pending" || approval.status === "revision_requested") {
      throw unprocessable("Still waiting for Filip's decision on this booking.");
    }
    if (approval.status !== "approved") {
      session.pendingBooking = null;
      throw unprocessable("Filip said no to this booking, so it will not be confirmed.");
    }

    const snap = await session.handler.snapshot();
    const currentPageUrl = pageUrlKey(snap.url);
    if (currentPageUrl !== pending.pageUrl) {
      session.pendingBooking = null;
      throw unprocessable(
        "The page changed since Filip approved this booking. Call request_booking again from the booking page.",
      );
    }

    const el = await session.driver.describeElement(ref);
    if (!el) throw new Error(`Unknown element ref "${ref}"; take a fresh browser_snapshot`);
    if (el.role !== pending.elementRole || accessibleName(el) !== pending.elementName) {
      session.pendingBooking = null;
      throw unprocessable(
        "This isn't the button Filip approved. Call request_booking again for the exact button you want to click.",
      );
    }

    const currentAmount = parseLargestPageAmount(snap.tree);
    if (!isAmountStillAcceptable(pending.amount, currentAmount)) {
      session.pendingBooking = null;
      throw unprocessable(
        "The price on this page changed since Filip approved this booking. Call request_booking again so he can see the new price.",
      );
    }

    // Checked directly rather than via evaluateFinalActionRisk(): that
    // helper checks final-action *wording* first and returns as soon as it
    // matches, so a wording match (expected here -- it is why request_booking
    // was needed) would mask a payment-field-in-form signal instead of both
    // being independently enforced. Bookings never get a payment-field
    // clearance in this phase, so this refusal stays in force even for the
    // one approved element.
    if (el.isFormSubmit && el.formHasPaymentField) {
      session.pendingBooking = null;
      throw unprocessable("This submits a form with a payment field. That needs request_purchase and a live clearance first.");
    }
    // The final-action/invoice wording refusal a plain browser_click would
    // give this exact button is expected -- it is exactly what
    // request_booking exists for -- and does not block the one element
    // Filip's approval already bound this clearance to.

    session.pendingBooking = null;
    const result = await session.driver.performClick(ref);
    touch(session);

    const receiptScreenshot = await session.handler.screenshot();
    const stored = await getStorageService().putFile({
      companyId: agent.companyId,
      namespace: "files",
      originalFilename: `booking-receipt-${sessionId}.png`,
      contentType: "image/png",
      body: Buffer.from(receiptScreenshot),
    });
    const file = await issues.createCompanyFile({
      companyId: agent.companyId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: agentId,
    });
    await paymentNotices.writeReceipt({
      companyId: agent.companyId,
      agentId,
      text: `Booking confirmed on ${pending.merchantDomain}.`,
      imageFileId: file.id,
    });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "agent",
      actorId: agentId,
      action: "browser_booking_confirmed",
      entityType: "approval",
      entityId: pending.approvalId,
      agentId,
      details: { sessionId, merchantDomain: pending.merchantDomain },
    });

    return result;
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
    requestBooking,
    confirmFinalStep,
  };
}

/** Test-only: the session map is module state so it survives across `browserService(db)` calls within one process. */
export function _resetBrowserSessionsForTests(): void {
  sessions.clear();
}
