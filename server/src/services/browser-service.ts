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
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, financeEvents, withCompanyScope } from "@paperclipai/db";
import {
  BrowserToolHandler,
  type AccessibilitySnapshot,
  type BrowserDriver,
  type ElementDescriptor,
  type ToolOutcome,
} from "@paperclipai/adapter-utils/browser-tools";
import {
  bookingRequestPayloadSchema,
  containsSubscriptionOrTrialWording,
  evaluatePurchaseAmount,
  evaluatePurchaseCaps,
  isPurchaseTotalStillAcceptable,
  NOK_APPROVAL_THRESHOLD,
  purchaseRequestPayloadSchema,
  effectiveLaneABrowserAccess,
  type ParsedTotal,
  type PurchaseCapKind,
} from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { approvalService } from "./approvals.js";
import { isAmountStillAcceptable, parseLargestPageAmount, type ParsedPageAmount } from "./browser-amount.js";
import { fullPageUrlKey, pageUrlKey, registrableDomain } from "./browser-domain.js";
import { classifyPurchaseOutcome, maskCardNumbers, type PurchaseOutcome } from "./browser-purchase-outcome.js";
import type { BrowserWorkerClient } from "./browser-worker-client.js";
import { createBrowserWorkerClientFromEnv } from "./browser-worker-client.js";
import { companyPaymentSettingsService } from "./company-payment-settings.js";
import { financeService } from "./finance.js";
import { issueService } from "./issues.js";
import { paymentCardService } from "./payment-cards.js";
import { paymentNoticesService } from "./payment-notices.js";
import { getStorageService } from "../storage/index.js";

const MAX_CONCURRENT_SESSIONS_PER_INSTANCE = 2;
const MAX_WALL_CLOCK_MS = 20 * 60 * 1000;
const MAX_IDLE_MS = 5 * 60 * 1000;
const MAX_ACTIONS = 300;
/** Design section 1: "parked sessions live until the approval expires (default 30 min)". */
const BOOKING_APPROVAL_EXPIRY_MS = 30 * 60 * 1000;
/** Auto-cleared purchases get no human decision window -- a much shorter clearance lifetime than a Filip-approval-gated one (which reuses BOOKING_APPROVAL_EXPIRY_MS below), just long enough for fill_payment_details + confirm_final_step to run. */
const AUTO_CLEAR_PURCHASE_EXPIRY_MS = 10 * 60 * 1000;
/** Purchase caps (DUR-4046 step 6) are rolling windows, not calendar day/week boundaries -- a fixed reset point (midnight) would let a caps-aware page time a purchase right after the reset. Matches the 24h anti-splitting counter's own convention (see PurchaseCapsInput.merchantSpendLast24hNok). */
const PURCHASE_CAPS_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const PURCHASE_CAPS_WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface BrowserAccessAgent {
  id: string;
  companyId: string;
  /**
   * DUR-4046 fix: the browse/book gate reads `adapterConfig.laneA.browserAccess`
   * (via `readLaneABrowserAccess`), not a bare string field. This used to be a
   * plain `agents.browser_access` DB column that the Connections form
   * (DUR-4020) and `paymentCardService.resolveForFill` never wrote or read --
   * an operator turning the switch on in the UI silently never reached this
   * gate. Kept as `unknown` so callers pass the raw `adapterConfig` column
   * through unchanged.
   */
  adapterConfig: unknown;
  status: string;
  /** DUR-4070: a "limited"-trust agent gets no browser access at all, regardless of adapterConfig.laneA.browserAccess. */
  laneATrustLevel?: string | null;
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

interface PendingPurchase {
  clearanceId: string;
  cardId: string;
  /** Set once a Filip approval was filed (amount at/above threshold, unparseable, ambiguous currency, subscription wording, or a breached cap); null on the auto-clear path. */
  approvalId: string | null;
  autoCleared: boolean;
  merchantDomain: string;
  /** ms epoch; auto-clear gets a short window (AUTO_CLEAR_PURCHASE_EXPIRY_MS), approval-gated gets Filip's 30-minute decision window. */
  expiresAt: number;
  /** origin+pathname+search (DUR-4046 fix over the booking gate's origin+pathname: cart/product identity commonly lives in the query string). */
  pageUrl: string;
  elementRole: string;
  elementName: string | null;
  detectedTotal: ParsedTotal | null;
  amountNok: number | null;
  /** Set once confirm_final_step has clicked and armed the network hold -- wait_for_outcome/report_outcome are the only calls valid after this. */
  awaitingOutcome: boolean;
  /**
   * Security fix (DUR-4047 review of PR #405): set once `fillPaymentDetails`
   * has actually typed the real PAN/CVC/expiry/name into the page. Until
   * this purchase resolves (finalizePurchase nulls `pendingPurchase`), the
   * card fields may still be sitting unmasked in the DOM -- the *generic*
   * plain tools (browser_snapshot/browser_read_text/browser_screenshot) are
   * not gated tools and know nothing about clearances, so they must not be
   * allowed to hand that back to the agent unscrubbed just because they
   * happen to be called on the same session mid-purchase.
   */
  cardFieldsFilled: boolean;
  /**
   * DUR-4049 (residual from the DUR-4047 re-review): the exact CVC/expiry/
   * cardholder-name/PAN strings `fillPaymentDetails` actually typed into
   * the page, for `maskCardNumbers`'s `extraLiterals` to blank verbatim --
   * the PAN regex alone never matches a 3-4 digit CVC or plain-text
   * expiry/name. Populated once, at fill time, alongside
   * `cardFieldsFilled`; cleared with the rest of `pendingPurchase` when the
   * purchase resolves.
   */
  sensitiveLiterals: string[];
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
  pendingPurchase: PendingPurchase | null;
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
  const paymentCards = paymentCardService(db);
  const finance = financeService(db);

  async function loadAgent(agentId: string): Promise<BrowserAccessAgent> {
    const [agent] = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        adapterConfig: agents.adapterConfig,
        status: agents.status,
        laneATrustLevel: agents.laneATrustLevel,
      })
      .from(agents)
      .where(eq(agents.id, agentId));
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  /**
   * The access gate: board-only switch (never mutable by the agent itself
   * beyond raising its own level, see `assertNoAgentBrowserAccessRaise` in
   * routes/agents.ts) must be something other than "off", and the agent must
   * be active. Level ("browse_and_forms" vs "book_and_buy") is not
   * distinguished here -- both get the plain tools this function guards.
   * `book_and_buy` additionally needs `assertBookAndBuyAllowed` below before
   * it may touch a gated tool.
   */
  function assertBrowserAccessAllowed(agent: BrowserAccessAgent) {
    if (effectiveLaneABrowserAccess(agent) === "off") {
      throw forbidden("This agent's browser access is off. A board user can turn it on in the agent's settings.");
    }
    if (agent.status === "terminated" || agent.status === "pending_approval") {
      throw forbidden("This agent cannot use the browser right now.");
    }
  }

  /**
   * The access-level half of the booking/purchase gate (DUR-4037/DUR-4046):
   * `agents.browser_access = book_and_buy` and the instance-wide kill switch,
   * checked fresh on every gated call, never cached on the session. Does NOT
   * check either company-level switch (`bookingEnabled`/`purchasesEnabled`)
   * -- those are independent per company-payment-settings.ts, so booking and
   * purchase callers each check their own below.
   */
  async function assertBookAndBuyAccessLevel(agent: BrowserAccessAgent) {
    assertBrowserAccessAllowed(agent);
    if (effectiveLaneABrowserAccess(agent) !== "book_and_buy") {
      throw forbidden("This agent can browse but cannot book or purchase. A board user can turn booking on in the agent's settings.");
    }
    if (process.env.PAPERCLIP_BROWSER_DISABLED === "1") {
      throw forbidden("Browser bookings are switched off on this instance.");
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
    await assertBookAndBuyAccessLevel(agent);
    const settings = await companyPaymentSettings.get(agent.companyId);
    if (!settings.bookingEnabled) {
      throw forbidden("Bookings are switched off for this company. A board user can turn them on in Company settings.");
    }
  }

  /** The purchase-gate access check (DUR-4046), the `purchasesEnabled` analogue of `assertBookAndBuyAllowed` above. */
  async function assertPurchasingAllowed(agent: BrowserAccessAgent) {
    await assertBookAndBuyAccessLevel(agent);
    const settings = await companyPaymentSettings.get(agent.companyId);
    if (!settings.purchasesEnabled) {
      throw forbidden("Purchases are switched off for this company. A board user can turn them on in Company settings.");
    }
  }

  /**
   * Real spend/count counters for `evaluatePurchaseCaps`, read from
   * `finance_events` (DUR-4046 step 6, closing the "wire evaluatePurchaseCaps
   * to real data" gap left by the foundations commit). Rolling 24h/7d
   * windows (PURCHASE_CAPS_DAY_WINDOW_MS/WEEK_WINDOW_MS), not calendar
   * boundaries -- see those constants' own comment. Scoped to
   * `eventKind = 'browser_purchase'` and `metadataJson->>'autoCleared' =
   * 'true'`: a Filip-approved purchase (kind "purchase" board approval) is
   * not rate-limited by these caps at all -- he is the check for those, the
   * same way every booking always goes to him regardless of amount. Read
   * under a transaction-scoped advisory lock so two concurrent
   * `request_purchase` calls for the same company serialize on this read
   * (matching web-search.ts's `reserveSearch` pattern) -- NOTE this only
   * protects the read itself, not the read-then-decide-then-eventually-write
   * window (the finance_events row is only written once the purchase's
   * outcome is known, at `finalizePurchase`, not here); two purchases
   * decided "auto-clear, under cap" in the same few-second window before
   * either has reached finalize could together exceed a cap. Accepted as a
   * documented residual race rather than building full reserve/reconcile
   * ledger plumbing this pass: MAX_CONCURRENT_SESSIONS_PER_INSTANCE caps it
   * at 2 concurrent sessions company/instance-wide, and the failure
   * direction (an auto-clear a whisker over a soft rate limit, not the hard
   * 500 NOK Filip-approval threshold) is the safe one. Flagged as a named
   * follow-up rather than silently accepted -- see the PR description.
   */
  async function readPurchaseCapCounters(
    companyId: string,
    merchantDomain: string,
    now: number,
  ): Promise<{
    spendTodayNok: number;
    spendThisWeekNok: number;
    autoPurchasesToday: number;
    merchantPurchasesToday: number;
    merchantPurchasesThisWeek: number;
    merchantSpendLast24hNok: number;
  }> {
    return withCompanyScope(db, companyId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`purchase_caps:${companyId}`}))`);

      const dayCutoff = new Date(now - PURCHASE_CAPS_DAY_WINDOW_MS);
      const weekCutoff = new Date(now - PURCHASE_CAPS_WEEK_WINDOW_MS);
      const autoClearedCondition = sql`(${financeEvents.metadataJson} ->> 'autoCleared') = 'true'`;

      const [weekRow] = await tx
        .select({
          spendThisWeekCents: sql<number>`coalesce(sum(${financeEvents.amountCents}), 0)::int`,
          merchantPurchasesThisWeek: sql<number>`coalesce(sum(case when ${financeEvents.biller} = ${merchantDomain} then 1 else 0 end), 0)::int`,
        })
        .from(financeEvents)
        .where(
          and(
            eq(financeEvents.companyId, companyId),
            eq(financeEvents.eventKind, "browser_purchase"),
            autoClearedCondition,
            gte(financeEvents.occurredAt, weekCutoff),
          ),
        );

      const [dayRow] = await tx
        .select({
          spendTodayCents: sql<number>`coalesce(sum(${financeEvents.amountCents}), 0)::int`,
          autoPurchasesToday: sql<number>`count(*)::int`,
          merchantPurchasesToday: sql<number>`coalesce(sum(case when ${financeEvents.biller} = ${merchantDomain} then 1 else 0 end), 0)::int`,
          merchantSpendTodayCents: sql<number>`coalesce(sum(case when ${financeEvents.biller} = ${merchantDomain} then ${financeEvents.amountCents} else 0 end), 0)::int`,
        })
        .from(financeEvents)
        .where(
          and(
            eq(financeEvents.companyId, companyId),
            eq(financeEvents.eventKind, "browser_purchase"),
            autoClearedCondition,
            gte(financeEvents.occurredAt, dayCutoff),
          ),
        );

      return {
        spendTodayNok: Number(dayRow?.spendTodayCents ?? 0) / 100,
        spendThisWeekNok: Number(weekRow?.spendThisWeekCents ?? 0) / 100,
        autoPurchasesToday: Number(dayRow?.autoPurchasesToday ?? 0),
        merchantPurchasesToday: Number(dayRow?.merchantPurchasesToday ?? 0),
        merchantPurchasesThisWeek: Number(weekRow?.merchantPurchasesThisWeek ?? 0),
        // The 24h anti-splitting counter reuses the same "today" (trailing
        // 24h) window -- merchant spend in the trailing day IS merchant
        // spend in the trailing 24h, same query, no separate one needed.
        merchantSpendLast24hNok: Number(dayRow?.merchantSpendTodayCents ?? 0) / 100,
      };
    });
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
      pendingPurchase: null,
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

  /**
   * Security fix (DUR-4047 review of PR #405): the gated purchase tools
   * (`fillPaymentDetails`/`confirmPurchaseFinalStep`/`waitForOutcome`/
   * `reportOutcome`) each scrub their own returned snapshot with
   * `maskCardNumbers`, but every *generic* plain tool below
   * (navigate/snapshot/read_text/click/type/select/check/press_key) also
   * hands an `AccessibilitySnapshot.tree` straight back to the agent, and
   * is perfectly usable on the same session in the same window -- once
   * `fill_payment_details` has typed the real card into the page,
   * `pending.cardFieldsFilled` is set and stays set until this purchase
   * resolves, so every plain-tool snapshot on this session is scrubbed too.
   * Centralizing it here (rather than re-deriving the check in every
   * caller) means a future plain tool can't reintroduce this gap.
   */
  function maskIfCardFilled(session: BrowserSession, snap: AccessibilitySnapshot): AccessibilitySnapshot {
    const pending = session.pendingPurchase;
    if (!pending?.cardFieldsFilled) return snap;
    return { ...snap, tree: maskCardNumbers(snap.tree, pending.sensitiveLiterals) };
  }

  function maskOutcomeIfCardFilled(session: BrowserSession, result: ToolOutcome<AccessibilitySnapshot>): ToolOutcome<AccessibilitySnapshot> {
    if (!result.ok) return result;
    return { ok: true, value: maskIfCardFilled(session, result.value) };
  }

  async function navigate(agentId: string, sessionId: string, url: string): Promise<AccessibilitySnapshot> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.navigate(url);
    touch(session);
    return maskIfCardFilled(session, result);
  }

  async function snapshot(agentId: string, sessionId: string): Promise<AccessibilitySnapshot> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.snapshot();
    touch(session);
    return maskIfCardFilled(session, result);
  }

  async function readText(agentId: string, sessionId: string): Promise<string> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.readText();
    touch(session);
    const pending = session.pendingPurchase;
    return pending?.cardFieldsFilled ? maskCardNumbers(result, pending.sensitiveLiterals) : result;
  }

  async function click(agentId: string, sessionId: string, ref: string, why: string): Promise<ToolOutcome<AccessibilitySnapshot>> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.click(ref, why);
    touch(session);
    return maskOutcomeIfCardFilled(session, result);
  }

  async function type(agentId: string, sessionId: string, ref: string, text: string): Promise<ToolOutcome<AccessibilitySnapshot>> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.type(ref, text);
    touch(session);
    return maskOutcomeIfCardFilled(session, result);
  }

  async function select(agentId: string, sessionId: string, ref: string, value: string): Promise<AccessibilitySnapshot> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.select(ref, value);
    touch(session);
    return maskIfCardFilled(session, result);
  }

  async function check(agentId: string, sessionId: string, ref: string, checked: boolean): Promise<AccessibilitySnapshot> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.check(ref, checked);
    touch(session);
    return maskIfCardFilled(session, result);
  }

  async function pressKey(agentId: string, sessionId: string, key: string): Promise<ToolOutcome<AccessibilitySnapshot>> {
    const session = requireSession(agentId, sessionId);
    const result = await session.handler.pressKey(key);
    touch(session);
    return maskOutcomeIfCardFilled(session, result);
  }

  /**
   * Security fix (DUR-4047 review): a screenshot is an image -- there is no
   * text-regex scrub for it, so unlike the tree-based tools above this one
   * refuses outright while this session has a real card sitting in the
   * checkout page's fields, rather than risk handing back a picture of the
   * PAN/CVC. The gated purchase flow takes its own screenshots server-side
   * (for the approval card / receipt / outcome record); this only blocks
   * the agent-facing generic tool.
   */
  async function screenshot(agentId: string, sessionId: string): Promise<Uint8Array> {
    const session = requireSession(agentId, sessionId);
    if (session.pendingPurchase?.cardFieldsFilled) {
      throw unprocessable(
        "Screenshots are unavailable on this session until the current purchase is confirmed or cancelled -- the checkout page has real card details filled in. Call confirm_final_step, or wait_for_outcome/report_outcome if already confirmed.",
      );
    }
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
    return maskIfCardFilled(session, result);
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

    if (session.pendingBooking || session.pendingPurchase) {
      throw unprocessable(
        "This session already has a booking or purchase waiting on a decision. Wait for confirm_final_step (or wait_for_outcome/report_outcome) or close the session before starting another.",
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
    const session = requireSession(agentId, sessionId);
    if (session.pendingPurchase) {
      return confirmPurchaseFinalStep(agentId, session, ref);
    }
    if (session.pendingBooking) {
      return confirmBookingFinalStep(agentId, session, ref);
    }
    // Neither pending (never filed, or already consumed by an earlier
    // confirm/expiry/rejection) -- checked here rather than falling into
    // one specific branch's own company-setting check (bookingEnabled vs
    // purchasesEnabled), which would give a misleading refusal reason
    // (e.g. "bookings are switched off") for what was actually a purchase.
    const agent = await loadAgent(agentId);
    await assertBookAndBuyAccessLevel(agent);
    throw unprocessable("There is no booking or purchase waiting for a decision on this session. Call request_booking or request_purchase first.");
  }

  async function confirmBookingFinalStep(agentId: string, session: BrowserSession, ref: string): Promise<AccessibilitySnapshot> {
    const agent = await loadAgent(agentId);
    await assertBookAndBuyAllowed(agent);

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
      originalFilename: `booking-receipt-${session.id}.png`,
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
      details: { sessionId: session.id, merchantDomain: pending.merchantDomain },
    });

    return result;
  }

  // ── DUR-4046 (step 6): the purchase gate. request_purchase -> optionally
  // fill_payment_details -> confirm_final_step (dispatched above, purchase
  // branch) -> wait_for_outcome/report_outcome. Every "reasons this needed
  // approval" string returned to Filip is generated server-side from what
  // the server itself detected, never from the agent's own words.

  function purchaseReasonStrings(input: {
    amountEval: ReturnType<typeof evaluatePurchaseAmount>;
    subscriptionWording: boolean;
    breachedCaps: PurchaseCapKind[];
  }): string[] {
    const reasons: string[] = [];
    if (input.amountEval.reason === "unparseable") {
      reasons.push("Could not read a total amount from the page with confidence.");
    } else if (input.amountEval.reason === "ambiguous_currency") {
      reasons.push(`Detected a currency ("${input.amountEval.detected?.currency}") with no known NOK conversion rate.`);
    } else if (input.amountEval.reason === "at_or_above_threshold") {
      reasons.push(`Amount is ${input.amountEval.amountNok?.toFixed(2)} NOK, at or above the ${NOK_APPROVAL_THRESHOLD} NOK auto-clear line.`);
    }
    if (input.subscriptionWording) {
      reasons.push("The page mentions a subscription, membership, or free trial -- always needs your OK.");
    }
    const CAP_LABELS: Record<PurchaseCapKind, string> = {
      daily_amount: "Would push today's auto-cleared purchase total over its cap.",
      weekly_amount: "Would push this week's auto-cleared purchase total over its cap.",
      daily_auto_purchase_count: "Already at today's auto-cleared purchase count cap.",
      merchant_daily: "Already at today's per-merchant purchase cap.",
      merchant_weekly: "Already at this week's per-merchant purchase cap.",
      merchant_24h_splitting: "This merchant's trailing-24h spend would reach the auto-clear line -- looks like it could be a split purchase.",
    };
    for (const cap of input.breachedCaps) reasons.push(CAP_LABELS[cap]);
    return reasons;
  }

  /**
   * The purchase gate's filing half (DUR-4046). Unlike booking, most
   * purchases need no human decision at all: strictly below 500 NOK
   * equivalent, no subscription/trial wording, and under the rolling
   * daily/weekly/per-merchant/anti-splitting caps (see
   * `readPurchaseCapCounters`) auto-clears -- `fill_payment_details` and
   * `confirm_final_step` may proceed immediately, no `approvalId`. Anything
   * else (unparseable/ambiguous amount, at/above threshold, subscription
   * wording, or a breached cap) files the same kind of board approval
   * booking does. Either way the card is reserved up front (DUR-4046: "no
   * advisory lock needed for THIS check", see payment-cards.ts) so a
   * concurrent request_purchase for the same card fails fast rather than
   * racing fill_payment_details/confirm_final_step later.
   */
  async function requestPurchase(
    agentId: string,
    sessionId: string,
    summary: string,
    ref: string,
    cardId: string,
  ): Promise<{ clearanceId: string; cardId: string; status: "auto_cleared" | "pending_approval"; approvalId: string | null }> {
    const agent = await loadAgent(agentId);
    await assertPurchasingAllowed(agent);
    const session = requireSession(agentId, sessionId);

    if (session.pendingBooking || session.pendingPurchase) {
      throw unprocessable(
        "This session already has a booking or purchase waiting on a decision. Finish it (confirm_final_step / wait_for_outcome / report_outcome) or close the session before starting another.",
      );
    }

    const snap = await session.handler.snapshot();
    const merchantDomain = registrableDomain(snap.url);
    if (!merchantDomain) {
      throw unprocessable("Could not tell what site this is from the current page. Take a fresh browser_snapshot on the checkout page first.");
    }
    const fullPageUrl = fullPageUrlKey(snap.url);
    if (!fullPageUrl) {
      throw unprocessable("Could not tell what page this is from the current page. Take a fresh browser_snapshot on the checkout page first.");
    }
    const el = await session.driver.describeElement(ref);
    if (!el) throw new Error(`Unknown element ref "${ref}"; take a fresh browser_snapshot`);

    const amountEval = evaluatePurchaseAmount({ text: snap.tree });
    const subscriptionWording = containsSubscriptionOrTrialWording(snap.tree);

    let breachedCaps: PurchaseCapKind[] = [];
    // No sense querying real counters when the amount/wording already forces
    // approval -- but harmless (and simplest) to always compute them so the
    // reasons list is always complete for whoever reviews the card.
    if (amountEval.reason === "below_threshold" && amountEval.amountNok !== null) {
      const counters = await readPurchaseCapCounters(agent.companyId, merchantDomain, Date.now());
      const capsResult = evaluatePurchaseCaps({
        amountNok: amountEval.amountNok,
        merchant: merchantDomain,
        ...counters,
      });
      breachedCaps = capsResult.breachedCaps;
    }

    const reasons = purchaseReasonStrings({ amountEval, subscriptionWording, breachedCaps });
    const needsApproval = reasons.length > 0;

    const clearanceId = randomUUID();
    // DUR-4046: reserved for BOTH paths (auto-clear and approval-gated) up
    // front, same reasoning as the booking gate parking its one live slot at
    // request time -- fill_payment_details/confirm_final_step need a card
    // already bound to this clearanceId, and reserving late would let a
    // second request_purchase (a different session, or a retry) grab the
    // card out from under an approval Filip is mid-review on.
    await paymentCards.reserveAvailableCard(agent.companyId, cardId, { clearanceId, agentId });

    let approvalId: string | null = null;
    try {
      if (needsApproval) {
        const screenshotBytes = await session.handler.screenshot();
        const stored = await getStorageService().putFile({
          companyId: agent.companyId,
          namespace: "files",
          originalFilename: `purchase-request-${sessionId}.png`,
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
        const card = await paymentCards.getById(agent.companyId, cardId);

        const payload = purchaseRequestPayloadSchema.parse({
          kind: "purchase",
          sessionId,
          agentId,
          clearanceId,
          cardId,
          cardLast4: card.last4,
          cardLabel: card.label,
          merchantDomain,
          agentSummary: summary,
          detectedAmount: amountEval.detected?.amount ?? null,
          detectedCurrency: amountEval.detected?.currency ?? null,
          amountNok: amountEval.amountNok,
          reasons,
          screenshotFileId: file.id,
          title: `Purchase on ${merchantDomain}`,
          summary: `Wants to buy this on ${merchantDomain}: "${summary}". ${reasons.join(" ")}`,
          expiresAt: new Date(Date.now() + BOOKING_APPROVAL_EXPIRY_MS).toISOString(),
        });

        const approval = await approvals.create(agent.companyId, {
          type: "request_board_approval",
          requestedByAgentId: agentId,
          payload,
          status: "pending",
        });
        approvalId = approval!.id;
      }
    } catch (error) {
      // Roll back the reservation: an approval that failed to file (or a
      // card lookup that failed) must not leave a card silently locked with
      // no live clearance anyone can ever confirm or release.
      await paymentCards.releaseReservation(agent.companyId, cardId, { clearanceId });
      throw error;
    }

    session.pendingPurchase = {
      clearanceId,
      cardId,
      approvalId,
      autoCleared: !needsApproval,
      merchantDomain,
      expiresAt: Date.now() + (needsApproval ? BOOKING_APPROVAL_EXPIRY_MS : AUTO_CLEAR_PURCHASE_EXPIRY_MS),
      pageUrl: fullPageUrl,
      elementRole: el.role,
      elementName: accessibleName(el),
      detectedTotal: amountEval.detected,
      amountNok: amountEval.amountNok,
      awaitingOutcome: false,
      cardFieldsFilled: false,
      sensitiveLiterals: [],
    };
    touch(session);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "agent",
      actorId: agentId,
      action: "browser_purchase_requested",
      entityType: needsApproval ? "approval" : "browser_session",
      entityId: needsApproval ? approvalId! : sessionId,
      agentId,
      details: { sessionId, merchantDomain, summary, ref, cardId, clearanceId, autoCleared: !needsApproval, reasons },
    });

    return { clearanceId, cardId, status: needsApproval ? "pending_approval" : "auto_cleared", approvalId };
  }

  /**
   * Types the card's PAN/expiry/CVC/name directly into whichever refs the
   * caller passes (a page's checkout form does not always have all of
   * them), bypassing `BrowserToolHandler.type`'s payment-field-shaped-text
   * refusal on purpose -- that refusal exists for every OTHER tool; this is
   * the one gated path allowed to fill a card number, and only once a live
   * clearance (auto-cleared, or Filip-approved) exists for the exact
   * `clearanceId` passed in. The secret is resolved fresh on every call
   * (never cached on the session) and never appears in the return value:
   * `maskCardNumbers` scrubs the post-fill snapshot before it goes back to
   * the agent, per DUR-4044's canary-card requirement.
   */
  async function fillPaymentDetails(
    agentId: string,
    sessionId: string,
    input: {
      clearanceId: string;
      cardNumberRef?: string;
      expiryRef?: string;
      expiryMonthRef?: string;
      expiryYearRef?: string;
      cvcRef?: string;
      nameOnCardRef?: string;
    },
  ): Promise<AccessibilitySnapshot> {
    const agent = await loadAgent(agentId);
    await assertPurchasingAllowed(agent);
    const session = requireSession(agentId, sessionId);

    const pending = session.pendingPurchase;
    if (!pending || pending.clearanceId !== input.clearanceId) {
      throw unprocessable("No live purchase clearance with this id on this session. Call request_purchase first.");
    }
    if (pending.awaitingOutcome) {
      throw unprocessable("This purchase has already been confirmed and is waiting on its outcome.");
    }
    await assertPurchaseClearanceUsable(agent, pending);

    const cardSecret = await paymentCards.resolveForFill(agent.companyId, pending.clearanceId, {
      agentId,
      issueId: session.issueId,
      heartbeatRunId: null,
    });
    const card = JSON.parse(cardSecret) as {
      cardNumber?: string;
      expMonth?: string;
      expYear?: string;
      cvc?: string;
      nameOnCard?: string;
    };

    const fills: Array<[string | undefined, string | undefined]> = [
      [input.cardNumberRef, card.cardNumber],
      [input.expiryRef, card.expMonth && card.expYear ? `${card.expMonth}/${card.expYear.slice(-2)}` : undefined],
      [input.expiryMonthRef, card.expMonth],
      [input.expiryYearRef, card.expYear],
      [input.cvcRef, card.cvc],
      [input.nameOnCardRef, card.nameOnCard],
    ];
    let filledAny = false;
    const filledLiterals: string[] = [];
    for (const [ref, value] of fills) {
      if (ref && value) {
        await session.driver.performType(ref, value);
        filledAny = true;
        filledLiterals.push(value);
      }
    }
    // Security fix (DUR-4047 review): once the real card is on the page,
    // the generic plain tools must mask/refuse until this purchase resolves.
    // DUR-4049: also record the exact values typed, so maskCardNumbers can
    // blank the CVC/expiry/name verbatim, not just the PAN.
    if (filledAny) {
      pending.cardFieldsFilled = true;
      pending.sensitiveLiterals = [...pending.sensitiveLiterals, ...filledLiterals];
    }
    touch(session);

    const snap = await session.driver.snapshot();
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "agent",
      actorId: agentId,
      action: "browser_payment_details_filled",
      entityType: "browser_session",
      entityId: sessionId,
      agentId,
      // Never the card's own value -- only which fields were targeted.
      details: { sessionId, clearanceId: pending.clearanceId, filledFields: fills.filter(([ref, v]) => ref && v).map(([ref]) => ref) },
    });

    return { ...snap, tree: maskCardNumbers(snap.tree, pending.sensitiveLiterals) };
  }

  /** Shared by fill_payment_details and confirm_final_step's purchase branch: refuses unless the clearance is live -- auto-cleared, or Filip has approved it (and not yet expired/rejected). Clears the slot and releases the card on a rejection. */
  async function assertPurchaseClearanceUsable(agent: BrowserAccessAgent, pending: PendingPurchase): Promise<void> {
    if (Date.now() > pending.expiresAt) {
      throw unprocessable("This purchase clearance has expired. Call request_purchase again if you still want it.");
    }
    if (!pending.approvalId) return; // auto-cleared: nothing to wait on
    const approval = await approvals.getById(pending.approvalId);
    if (!approval || approval.status === "pending" || approval.status === "revision_requested") {
      throw unprocessable("Still waiting for Filip's decision on this purchase.");
    }
    if (approval.status !== "approved") {
      throw unprocessable("Filip said no to this purchase, so it will not be confirmed.");
    }
  }

  async function confirmPurchaseFinalStep(agentId: string, session: BrowserSession, ref: string): Promise<AccessibilitySnapshot> {
    const agent = await loadAgent(agentId);
    await assertPurchasingAllowed(agent);

    const pending = session.pendingPurchase;
    if (!pending) {
      throw unprocessable("There is no purchase waiting for a decision on this session. Call request_purchase first.");
    }
    if (pending.awaitingOutcome) {
      throw unprocessable("This purchase has already been confirmed and is waiting on its outcome. Call wait_for_outcome or report_outcome.");
    }

    try {
      await assertPurchaseClearanceUsable(agent, pending);
    } catch (error) {
      if (pending.approvalId) {
        // Expired or rejected -- single-use, same as booking: clear the slot
        // and release the card so it is not left locked forever.
        session.pendingPurchase = null;
        await paymentCards.releaseReservation(agent.companyId, pending.cardId, { clearanceId: pending.clearanceId });
      } else if (Date.now() > pending.expiresAt) {
        session.pendingPurchase = null;
        await paymentCards.releaseReservation(agent.companyId, pending.cardId, { clearanceId: pending.clearanceId });
      }
      throw error;
    }

    const snap = await session.handler.snapshot();
    const currentPageUrl = fullPageUrlKey(snap.url);
    const currentTotal = evaluatePurchaseAmount({ text: snap.tree }).detected;
    const el = await session.driver.describeElement(ref);
    if (!el) throw new Error(`Unknown element ref "${ref}"; take a fresh browser_snapshot`);

    const pageMatches = currentPageUrl === pending.pageUrl;
    const elementMatches = el.role === pending.elementRole && accessibleName(el) === pending.elementName;
    const amountStillOk = isPurchaseTotalStillAcceptable(pending.detectedTotal, currentTotal);

    if (!pageMatches || !elementMatches || !amountStillOk) {
      session.pendingPurchase = null;
      await paymentCards.releaseReservation(agent.companyId, pending.cardId, { clearanceId: pending.clearanceId });
      if (!pageMatches) {
        throw unprocessable("The page changed since request_purchase. Call request_purchase again from the checkout page.");
      }
      if (!elementMatches) {
        throw unprocessable("This isn't the button request_purchase was filed for. Call request_purchase again for the exact button you want to click.");
      }
      throw unprocessable("The price on this page changed since request_purchase. Call request_purchase again so it can be re-checked.");
    }

    // Unlike the booking gate, a purchase's confirm click legitimately
    // submits a form with a payment field -- that IS the point, once
    // fill_payment_details has put the card details in it. No
    // formHasPaymentField refusal here.
    const result = await session.driver.performClick(ref);
    pending.awaitingOutcome = true;
    touch(session);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "agent",
      actorId: agentId,
      action: "browser_purchase_confirmed",
      entityType: "browser_session",
      entityId: session.id,
      agentId,
      details: { sessionId: session.id, merchantDomain: pending.merchantDomain, clearanceId: pending.clearanceId },
    });

    return { ...result, tree: maskCardNumbers(result.tree, pending.sensitiveLiterals) };
  }

  /**
   * The purchase gate's outcome half (DUR-4046), the "fake confirmation
   * pages" mitigation from the design: the server re-derives the outcome
   * itself from the page it can see (`classifyPurchaseOutcome`), never
   * trusting the agent's own claim. `unverified` does NOT finalize --
   * `wait_for_outcome` may be called again (e.g. after a `ms` wait for a
   * slow redirect); only `report_outcome` (below) forces a terminal
   * decision on a still-unverified outcome.
   */
  async function waitForOutcome(agentId: string, sessionId: string, ms?: number): Promise<{ outcome: PurchaseOutcome; snapshot: AccessibilitySnapshot }> {
    const agent = await loadAgent(agentId);
    await assertPurchasingAllowed(agent);
    const session = requireSession(agentId, sessionId);

    const pending = session.pendingPurchase;
    if (!pending || !pending.awaitingOutcome) {
      throw unprocessable("No purchase is waiting on an outcome on this session. Call confirm_final_step first.");
    }

    if (ms && ms > 0) {
      await session.handler.wait(Math.min(Math.max(ms, 0), 30_000));
    }
    const snap = await session.handler.snapshot();
    const outcome = classifyPurchaseOutcome({ url: snap.url, tree: snap.tree, clearedDomain: pending.merchantDomain });
    touch(session);

    if (outcome === "unverified") {
      return { outcome, snapshot: { ...snap, tree: maskCardNumbers(snap.tree, pending.sensitiveLiterals) } };
    }
    await finalizePurchase(agent, session, pending, outcome);
    return { outcome, snapshot: { ...snap, tree: maskCardNumbers(snap.tree, pending.sensitiveLiterals) } };
  }

  /** Forces a terminal decision: unlike wait_for_outcome, a still-"unverified" classification here finalizes as used_unverified rather than leaving the clearance (and the reserved card) dangling forever. `agentNote` is shown in the receipt/notice text, always quoted, never used to decide the outcome itself. */
  async function reportOutcome(agentId: string, sessionId: string, agentNote?: string): Promise<{ outcome: PurchaseOutcome; snapshot: AccessibilitySnapshot }> {
    const agent = await loadAgent(agentId);
    await assertPurchasingAllowed(agent);
    const session = requireSession(agentId, sessionId);

    const pending = session.pendingPurchase;
    if (!pending || !pending.awaitingOutcome) {
      throw unprocessable("No purchase is waiting on an outcome on this session. Call confirm_final_step first.");
    }

    const snap = await session.handler.snapshot();
    const outcome = classifyPurchaseOutcome({ url: snap.url, tree: snap.tree, clearedDomain: pending.merchantDomain });
    touch(session);

    await finalizePurchase(agent, session, pending, outcome, agentNote);
    return { outcome, snapshot: { ...snap, tree: maskCardNumbers(snap.tree, pending.sensitiveLiterals) } };
  }

  /**
   * Terminal step for both wait_for_outcome and report_outcome. `failed` ->
   * release the card (never charged, available for retry) and no
   * finance_events entry (no spend happened). `confirmed`/`unverified` ->
   * consume the reservation (`used` / `used_unverified` respectively, the
   * design's fake-confirmation-page mitigation: an unverified charge is
   * never allowed to look identical to a verified one) and write ONE
   * finance_events debit -- for an auto-cleared purchase this is the first
   * ledger entry for it (nothing was written at request_purchase time, see
   * readPurchaseCapCounters's own comment on the resulting residual race);
   * for a Filip-approved purchase, likewise the first and only entry, since
   * approved purchases are deliberately outside the cap counters.
   */
  async function finalizePurchase(
    agent: BrowserAccessAgent,
    session: BrowserSession,
    pending: PendingPurchase,
    outcome: PurchaseOutcome,
    agentNote?: string,
  ): Promise<void> {
    session.pendingPurchase = null;

    const screenshotBytes = await session.handler.screenshot();
    const stored = await getStorageService().putFile({
      companyId: agent.companyId,
      namespace: "files",
      originalFilename: `purchase-outcome-${session.id}.png`,
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
      createdByAgentId: agent.id,
    });

    if (outcome === "failed") {
      await paymentCards.releaseReservation(agent.companyId, pending.cardId, { clearanceId: pending.clearanceId });
      await paymentNotices.writePurchaseReceipt({
        companyId: agent.companyId,
        agentId: agent.id,
        text: `Purchase failed on ${pending.merchantDomain}.${agentNote ? ` Agent note: "${agentNote}"` : ""}`,
        imageFileId: file.id,
      });
    } else {
      const cardOutcome = outcome === "confirmed" ? "used" : "used_unverified";
      const spentAmountCents = Math.round((pending.amountNok ?? 0) * 100);
      await paymentCards.consumeReservation(agent.companyId, pending.cardId, {
        clearanceId: pending.clearanceId,
        outcome: cardOutcome,
        spentAmountCents,
        purchaseId: pending.clearanceId,
      });
      await finance.createEvent(agent.companyId, {
        agentId: agent.id,
        issueId: session.issueId,
        eventKind: "browser_purchase",
        direction: "debit",
        biller: pending.merchantDomain,
        amountCents: spentAmountCents,
        currency: "NOK",
        estimated: outcome !== "confirmed",
        metadataJson: { clearanceId: pending.clearanceId, autoCleared: pending.autoCleared, sessionId: session.id, outcome },
        occurredAt: new Date(),
      });
      await paymentNotices.writePurchaseReceipt({
        companyId: agent.companyId,
        agentId: agent.id,
        text:
          outcome === "confirmed"
            ? `Purchase confirmed on ${pending.merchantDomain}.`
            : `Purchase on ${pending.merchantDomain} could not be independently verified -- treated as spent.${agentNote ? ` Agent note: "${agentNote}"` : ""}`,
        imageFileId: file.id,
      });
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "agent",
      actorId: agent.id,
      action: "browser_purchase_outcome",
      entityType: "browser_session",
      entityId: session.id,
      agentId: agent.id,
      details: { sessionId: session.id, merchantDomain: pending.merchantDomain, clearanceId: pending.clearanceId, outcome },
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
    requestBooking,
    confirmFinalStep,
    requestPurchase,
    fillPaymentDetails,
    waitForOutcome,
    reportOutcome,
  };
}

/** Test-only: the session map is module state so it survives across `browserService(db)` calls within one process. */
export function _resetBrowserSessionsForTests(): void {
  sessions.clear();
}
