import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWorkerClient } from "./browser-worker-client.js";

vi.mock("./activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));
// Sane no-op defaults so every pre-existing test above (which never touches
// the booking gate) keeps constructing `browserService()` without wiring
// these up itself; `wireBookingGateDefaults` below overrides per test.
vi.mock("./approvals.js", () => ({
  approvalService: vi.fn(() => ({
    create: vi.fn().mockResolvedValue({ id: "approval-1" }),
    getById: vi.fn().mockResolvedValue(null),
  })),
}));
vi.mock("./company-payment-settings.js", () => ({
  companyPaymentSettingsService: vi.fn(() => ({
    get: vi.fn().mockResolvedValue({ companyId: "unset", bookingEnabled: false, purchasesEnabled: false }),
  })),
}));
vi.mock("./payment-notices.js", () => ({
  paymentNoticesService: vi.fn(() => ({
    writeReceipt: vi.fn().mockResolvedValue({}),
    writePurchaseReceipt: vi.fn().mockResolvedValue({}),
    writeHandOver: vi.fn().mockResolvedValue({}),
  })),
}));
vi.mock("./issues.js", () => ({
  issueService: vi.fn(() => ({ createCompanyFile: vi.fn().mockResolvedValue({ id: "unset" }) })),
}));
vi.mock("../storage/index.js", () => ({
  getStorageService: vi.fn(() => ({ putFile: vi.fn().mockResolvedValue({}) })),
}));
// DUR-4046 (step 6): the purchase gate's own two services. Sane no-op
// defaults so nothing above this point (booking/plain tools) needs to know
// they exist; `wirePurchaseGateDefaults` below overrides per test.
vi.mock("./payment-cards.js", () => ({
  paymentCardService: vi.fn(() => ({
    getById: vi.fn().mockResolvedValue({ id: "unset", last4: "0000", label: "Unset card" }),
    reserveAvailableCard: vi.fn().mockResolvedValue({ id: "unset", status: "reserved" }),
    consumeReservation: vi.fn().mockResolvedValue({ id: "unset", status: "used" }),
    releaseReservation: vi.fn().mockResolvedValue({ id: "unset", status: "available" }),
    resolveForFill: vi.fn().mockResolvedValue(JSON.stringify({ cardNumber: "4111111111111111", expMonth: "01", expYear: "2030", cvc: "123", nameOnCard: "M Test" })),
  })),
}));
vi.mock("./finance.js", () => ({
  financeService: vi.fn(() => ({
    createEvent: vi.fn().mockResolvedValue({ id: "finance-event-1" }),
  })),
}));
// readPurchaseCapCounters runs its counter query inside withCompanyScope's
// advisory-lock transaction -- the fake `db` here is not a real Db and has
// no `.transaction()`, so this bypasses the reservation machinery entirely
// and hands the callback a fake tx returning all-zero counters by default
// (see fakeTxWithCounters below), same pattern as
// invite-test-resolution-route.test.ts.
let txCounterRow: Record<string, number> = {};
vi.mock("@paperclipai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/db")>();
  return {
    ...actual,
    withCompanyScope: async (_db: unknown, _companyId: string, fn: (tx: unknown) => unknown) => {
      const query = {
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([txCounterRow])),
      };
      const fakeTx = {
        execute: vi.fn().mockResolvedValue(undefined),
        select: () => ({ from: () => ({ where: () => query }) }),
      };
      return fn(fakeTx);
    },
  };
});

const { browserService, _resetBrowserSessionsForTests } = await import("./browser-service.js");
const { logActivity } = await import("./activity-log.js");
const { approvalService } = await import("./approvals.js");
const { companyPaymentSettingsService } = await import("./company-payment-settings.js");
const { paymentNoticesService } = await import("./payment-notices.js");
const { issueService } = await import("./issues.js");
const { getStorageService } = await import("../storage/index.js");
const { paymentCardService } = await import("./payment-cards.js");
const { financeService } = await import("./finance.js");

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "c0000001-0000-4000-8000-000000000001";

/** DUR-4037: booking-gate test doubles, wired to sane no-op defaults so tests that don't care about them (everything above this point) keep passing untouched. */
function fakeApprovals() {
  const approvals = {
    create: vi.fn().mockResolvedValue({ id: "approval-1" }),
    getById: vi.fn().mockResolvedValue({ id: "approval-1", status: "pending" }),
  };
  vi.mocked(approvalService).mockReturnValue(approvals as any);
  return approvals;
}

function fakePaymentSettings(bookingEnabled: boolean, purchasesEnabled = false) {
  const settings = { get: vi.fn().mockResolvedValue({ companyId: COMPANY_ID, bookingEnabled, purchasesEnabled }) };
  vi.mocked(companyPaymentSettingsService).mockReturnValue(settings as any);
  return settings;
}

function fakePaymentNotices() {
  const notices = {
    writeReceipt: vi.fn().mockResolvedValue({}),
    writePurchaseReceipt: vi.fn().mockResolvedValue({}),
    writeHandOver: vi.fn().mockResolvedValue({}),
  };
  vi.mocked(paymentNoticesService).mockReturnValue(notices as any);
  return notices;
}

const CARD_ID = "ca000000-0000-4000-8000-000000000001";

function fakePaymentCards() {
  const cards = {
    getById: vi.fn().mockResolvedValue({ id: CARD_ID, last4: "1111", label: "Company Visa" }),
    reserveAvailableCard: vi.fn().mockResolvedValue({ id: CARD_ID, status: "reserved" }),
    consumeReservation: vi.fn().mockResolvedValue({ id: CARD_ID, status: "used" }),
    releaseReservation: vi.fn().mockResolvedValue({ id: CARD_ID, status: "available" }),
    resolveForFill: vi
      .fn()
      .mockResolvedValue(JSON.stringify({ cardNumber: "4111111111111111", expMonth: "01", expYear: "2030", cvc: "123", nameOnCard: "M Test" })),
  };
  vi.mocked(paymentCardService).mockReturnValue(cards as any);
  return cards;
}

function fakeFinance() {
  const finance = { createEvent: vi.fn().mockResolvedValue({ id: "finance-event-1" }) };
  vi.mocked(financeService).mockReturnValue(finance as any);
  return finance;
}

const FILE_ID = "f1000000-f100-4100-8100-f10000000001";

function fakeIssues() {
  const issues = { createCompanyFile: vi.fn().mockResolvedValue({ id: FILE_ID }) };
  vi.mocked(issueService).mockReturnValue(issues as any);
  return issues;
}

function wireBookingGateDefaults(input: { bookingEnabled?: boolean } = {}) {
  const approvals = fakeApprovals();
  const settings = fakePaymentSettings(input.bookingEnabled ?? true);
  const notices = fakePaymentNotices();
  const issues = fakeIssues();
  vi.mocked(getStorageService).mockReturnValue({
    putFile: vi.fn().mockResolvedValue({
      provider: "fs",
      objectKey: "key-1",
      contentType: "image/png",
      byteSize: 3,
      sha256: "sha",
      originalFilename: "shot.png",
    }),
  } as any);
  return { approvals, settings, notices, issues };
}

function wirePurchaseGateDefaults(input: { purchasesEnabled?: boolean; counters?: Record<string, number> } = {}) {
  const approvals = fakeApprovals();
  const settings = fakePaymentSettings(false, input.purchasesEnabled ?? true);
  const notices = fakePaymentNotices();
  const issues = fakeIssues();
  const cards = fakePaymentCards();
  const finance = fakeFinance();
  txCounterRow = input.counters ?? {};
  vi.mocked(getStorageService).mockReturnValue({
    putFile: vi.fn().mockResolvedValue({
      provider: "fs",
      objectKey: "key-1",
      contentType: "image/png",
      byteSize: 3,
      sha256: "sha",
      originalFilename: "shot.png",
    }),
  } as any);
  return { approvals, settings, notices, issues, cards, finance };
}

const BOOK_AND_BUY_AGENT = { id: AGENT_ID, companyId: COMPANY_ID, adapterConfig: { laneA: { browserAccess: "book_and_buy" } }, status: "idle" };

function fakeDbWithAgent(agent: { id: string; companyId: string; adapterConfig: unknown; status: string } | null) {
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
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, adapterConfig: { laneA: { browserAccess: "off" } }, status: "idle" });
    const svc = browserService(db as any, { workerClient: fakeWorkerClient() });

    await expect(svc.open(AGENT_ID, { purpose: "book a table" })).rejects.toMatchObject({ status: 403 });
  });

  it("refuses to open a session for an agent that does not exist", async () => {
    const db = fakeDbWithAgent(null);
    const svc = browserService(db as any, { workerClient: fakeWorkerClient() });

    await expect(svc.open(AGENT_ID, { purpose: "book a table" })).rejects.toMatchObject({ status: 404 });
  });

  it("opens a session, returns the initial snapshot, and logs it", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, adapterConfig: { laneA: { browserAccess: "browse_and_forms" } }, status: "idle" });
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
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, adapterConfig: { laneA: { browserAccess: "browse_and_forms" } }, status: "idle" });
    const svc = browserService(db as any, { workerClient: fakeWorkerClient() });

    await svc.open(AGENT_ID, { purpose: "first" });
    await expect(svc.open(AGENT_ID, { purpose: "second" })).rejects.toMatchObject({ status: 422 });
  });

  it("refuses to act on a session opened by a different agent", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, adapterConfig: { laneA: { browserAccess: "browse_and_forms" } }, status: "idle" });
    const worker = fakeWorkerClient({
      navigate: vi.fn().mockResolvedValue({ tree: "", url: "https://example.com/2", title: "" }),
    });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "first" });

    await expect(svc.navigate(OTHER_AGENT_ID, sessionId, "https://example.com")).rejects.toMatchObject({ status: 403 });
    expect(worker.navigate).not.toHaveBeenCalled();
  });

  it("404s for a session id that was never opened", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, adapterConfig: { laneA: { browserAccess: "browse_and_forms" } }, status: "idle" });
    const svc = browserService(db as any, { workerClient: fakeWorkerClient() });

    await expect(svc.navigate(AGENT_ID, "nonexistent-session", "https://example.com")).rejects.toMatchObject({ status: 404 });
  });

  it("closes a session, frees the per-agent slot, and logs it", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, adapterConfig: { laneA: { browserAccess: "browse_and_forms" } }, status: "idle" });
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
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, adapterConfig: { laneA: { browserAccess: "browse_and_forms" } }, status: "idle" });
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

describe("browserService booking gate (DUR-4037)", () => {
  beforeEach(() => {
    _resetBrowserSessionsForTests();
    vi.mocked(logActivity).mockClear();
  });

  const BOOKING_PAGE_URL = "https://booking.example.com/step-3";
  const OTHER_SITE_URL = "https://other-site.example/step-3";

  function fakeWorkerClientOnBookingPage(overrides: Partial<BrowserWorkerClient> = {}): BrowserWorkerClient {
    return fakeWorkerClient({
      snapshot: vi.fn().mockResolvedValue({ tree: "", url: BOOKING_PAGE_URL, title: "Review booking" }),
      screenshot: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      describeElement: vi.fn().mockResolvedValue({
        ref: "e9",
        role: "button",
        label: "Bekreft bestilling",
        name: null,
        isFormSubmit: true,
      }),
      performClick: vi.fn().mockResolvedValue({ tree: "", url: BOOKING_PAGE_URL + "/confirmed", title: "Confirmed" }),
      ...overrides,
    });
  }

  it("refuses request_booking for a browse_and_forms agent even with bookings enabled company-wide", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, adapterConfig: { laneA: { browserAccess: "browse_and_forms" } }, status: "idle" });
    wireBookingGateDefaults({ bookingEnabled: true });
    const svc = browserService(db as any, { workerClient: fakeWorkerClientOnBookingPage() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await expect(svc.requestBooking(AGENT_ID, sessionId, "A table for two", "e9")).rejects.toMatchObject({ status: 403 });
  });

  it("refuses request_booking for a book_and_buy agent when the company kill switch is off", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    wireBookingGateDefaults({ bookingEnabled: false });
    const svc = browserService(db as any, { workerClient: fakeWorkerClientOnBookingPage() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await expect(svc.requestBooking(AGENT_ID, sessionId, "A table for two", "e9")).rejects.toMatchObject({ status: 403 });
  });

  it("request_booking files a board approval stamped with the server's own domain and screenshot, and parks the session", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const { approvals, issues } = wireBookingGateDefaults({ bookingEnabled: true });
    const svc = browserService(db as any, { workerClient: fakeWorkerClientOnBookingPage() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    const result = await svc.requestBooking(AGENT_ID, sessionId, 'A "free" table, no deposit', "e9");

    expect(result).toEqual({ approvalId: "approval-1", status: "pending_approval" });
    expect(issues.createCompanyFile).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID, createdByAgentId: AGENT_ID }));
    expect(approvals.create).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        type: "request_board_approval",
        requestedByAgentId: AGENT_ID,
        status: "pending",
        payload: expect.objectContaining({
          kind: "booking",
          merchantDomain: "example.com",
          agentSummary: 'A "free" table, no deposit',
          screenshotFileId: FILE_ID,
        }),
      }),
    );
  });

  it("refuses a second request_booking while one is already pending on the session", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    wireBookingGateDefaults({ bookingEnabled: true });
    const svc = browserService(db as any, { workerClient: fakeWorkerClientOnBookingPage() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await svc.requestBooking(AGENT_ID, sessionId, "First booking", "e9");
    await expect(svc.requestBooking(AGENT_ID, sessionId, "Second booking", "e9")).rejects.toMatchObject({ status: 422 });
  });

  it("confirm_final_step refuses when there is no pending booking on the session", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const worker = fakeWorkerClientOnBookingPage();
    wireBookingGateDefaults({ bookingEnabled: true });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
    expect(worker.performClick).not.toHaveBeenCalled();
  });

  it("confirm_final_step refuses while Filip has not decided yet, without clicking anything", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const worker = fakeWorkerClientOnBookingPage();
    const { approvals } = wireBookingGateDefaults({ bookingEnabled: true });
    approvals.getById.mockResolvedValue({ id: "approval-1", status: "pending" });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await svc.requestBooking(AGENT_ID, sessionId, "A table for two", "e9");

    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
    expect(worker.performClick).not.toHaveBeenCalled();
  });

  it("confirm_final_step refuses and clears the slot once Filip has said no", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const worker = fakeWorkerClientOnBookingPage();
    const { approvals } = wireBookingGateDefaults({ bookingEnabled: true });
    approvals.getById.mockResolvedValue({ id: "approval-1", status: "rejected" });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await svc.requestBooking(AGENT_ID, sessionId, "A table for two", "e9");

    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
    expect(worker.performClick).not.toHaveBeenCalled();
    // Slot cleared: a second confirm attempt gets the "no pending booking" refusal, not another "rejected" one.
    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
  });

  it("confirm_final_step refuses when the page moved to a different site since request_booking", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const worker = fakeWorkerClientOnBookingPage();
    const { approvals } = wireBookingGateDefaults({ bookingEnabled: true });
    approvals.getById.mockResolvedValue({ id: "approval-1", status: "approved" });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await svc.requestBooking(AGENT_ID, sessionId, "A table for two", "e9");

    vi.mocked(worker.snapshot).mockResolvedValue({ tree: "", url: OTHER_SITE_URL, title: "Different site" });
    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
    expect(worker.performClick).not.toHaveBeenCalled();
  });

  // DUR-4045 security review: the clearance used to be bound only to the
  // registrable domain, so one approved booking allowed any final click
  // anywhere on that domain for up to 30 minutes. These tests pin the fix.

  it("confirm_final_step refuses when the page navigated to a different page on the SAME domain since request_booking", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const worker = fakeWorkerClientOnBookingPage();
    const { approvals } = wireBookingGateDefaults({ bookingEnabled: true });
    approvals.getById.mockResolvedValue({ id: "approval-1", status: "approved" });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await svc.requestBooking(AGENT_ID, sessionId, "A table for two", "e9");

    // Same domain, different page -- must not inherit the clearance.
    vi.mocked(worker.snapshot).mockResolvedValue({ tree: "", url: "https://booking.example.com/another-room", title: "Another room" });
    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
    expect(worker.performClick).not.toHaveBeenCalled();
  });

  it("confirm_final_step refuses a different element on the same page since request_booking", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const worker = fakeWorkerClientOnBookingPage();
    const { approvals } = wireBookingGateDefaults({ bookingEnabled: true });
    approvals.getById.mockResolvedValue({ id: "approval-1", status: "approved" });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await svc.requestBooking(AGENT_ID, sessionId, "A table for two", "e9");

    // Same page, but confirm_final_step is pointed at a different element
    // (e.g. a "Subscribe to newsletter" button the page also final-refuses).
    vi.mocked(worker.describeElement).mockResolvedValue({
      ref: "e12",
      role: "button",
      label: "Meld pa nyhetsbrev",
      name: null,
      isFormSubmit: false,
    });
    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e12")).rejects.toMatchObject({ status: 422 });
    expect(worker.performClick).not.toHaveBeenCalled();
  });

  it("confirm_final_step refuses when the visible price increased since request_booking", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const worker = fakeWorkerClientOnBookingPage({
      snapshot: vi.fn().mockResolvedValue({ tree: "Total: 450 kr", url: BOOKING_PAGE_URL, title: "Review booking" }),
    });
    const { approvals } = wireBookingGateDefaults({ bookingEnabled: true });
    approvals.getById.mockResolvedValue({ id: "approval-1", status: "approved" });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await svc.requestBooking(AGENT_ID, sessionId, "A table for two", "e9");

    vi.mocked(worker.snapshot).mockResolvedValue({ tree: "Total: 900 kr", url: BOOKING_PAGE_URL, title: "Review booking" });
    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
    expect(worker.performClick).not.toHaveBeenCalled();
  });

  it("confirm_final_step refuses when a price appears where the page was free at request_booking time", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const worker = fakeWorkerClientOnBookingPage();
    const { approvals } = wireBookingGateDefaults({ bookingEnabled: true });
    approvals.getById.mockResolvedValue({ id: "approval-1", status: "approved" });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await svc.requestBooking(AGENT_ID, sessionId, "A table for two", "e9");

    vi.mocked(worker.snapshot).mockResolvedValue({ tree: "Deposit: 300 kr", url: BOOKING_PAGE_URL, title: "Review booking" });
    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
    expect(worker.performClick).not.toHaveBeenCalled();
  });

  it("confirm_final_step allows a lower or equal price since request_booking", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const worker = fakeWorkerClientOnBookingPage({
      snapshot: vi.fn().mockResolvedValue({ tree: "Total: 900 kr", url: BOOKING_PAGE_URL, title: "Review booking" }),
    });
    const { approvals } = wireBookingGateDefaults({ bookingEnabled: true });
    approvals.getById.mockResolvedValue({ id: "approval-1", status: "approved" });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await svc.requestBooking(AGENT_ID, sessionId, "A table for two", "e9");

    vi.mocked(worker.snapshot).mockResolvedValue({ tree: "Total: 450 kr", url: BOOKING_PAGE_URL, title: "Review booking" });
    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).resolves.toMatchObject({});
    expect(worker.performClick).toHaveBeenCalledWith("worker-session-1", "e9");
  });

  it("confirm_final_step still refuses a submit button in a form with a payment field, even for the approved element", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const worker = fakeWorkerClientOnBookingPage({
      describeElement: vi.fn().mockResolvedValue({
        ref: "e9",
        role: "button",
        label: "Bekreft bestilling",
        name: null,
        isFormSubmit: true,
        formHasPaymentField: true,
      }),
    });
    const { approvals } = wireBookingGateDefaults({ bookingEnabled: true });
    approvals.getById.mockResolvedValue({ id: "approval-1", status: "approved" });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await svc.requestBooking(AGENT_ID, sessionId, "A table for two", "e9");

    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
    expect(worker.performClick).not.toHaveBeenCalled();
  });

  it(
    "confirm_final_step clicks the final-action button directly once Filip approved, bypassing the refusal a plain " +
      "browser_click would give the exact same button (the fixture booking wizard's Norwegian final-action wording), " +
      "and writes a receipt",
    async () => {
      const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
      const worker = fakeWorkerClientOnBookingPage();
      const { approvals, notices, issues } = wireBookingGateDefaults({ bookingEnabled: true });
      approvals.getById.mockResolvedValue({ id: "approval-1", status: "approved" });
      const svc = browserService(db as any, { workerClient: worker });

      const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
      await svc.requestBooking(AGENT_ID, sessionId, "A table for two", "e9");

      // Proves the bypass is real: the exact same ref/element ("Bekreft bestilling",
      // a final-action submit button) is refused through the plain click tool...
      const plainClick = await svc.click(AGENT_ID, sessionId, "e9", "finishing the booking");
      expect(plainClick).toMatchObject({ ok: false });
      expect(worker.performClick).not.toHaveBeenCalled();

      // ...but proceeds through confirm_final_step once Filip has approved it.
      const snapshot = await svc.confirmFinalStep(AGENT_ID, sessionId, "e9");

      expect(worker.performClick).toHaveBeenCalledWith("worker-session-1", "e9");
      expect(snapshot.url).toBe(BOOKING_PAGE_URL + "/confirmed");
      expect(issues.createCompanyFile).toHaveBeenCalledTimes(2); // request screenshot + receipt screenshot
      expect(notices.writeReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: COMPANY_ID, agentId: AGENT_ID, imageFileId: FILE_ID }),
      );
      expect(logActivity).toHaveBeenCalledWith(db, expect.objectContaining({ action: "browser_booking_confirmed" }));

      // Single-use: a second confirm on the same session has nothing left to consume.
      await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
    },
  );

  it("confirm_final_step consumes the clearance even when the click itself fails, refusing a retry", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const worker = fakeWorkerClientOnBookingPage({
      performClick: vi.fn().mockRejectedValue(new Error("worker crashed mid-click")),
    });
    const { approvals } = wireBookingGateDefaults({ bookingEnabled: true });
    approvals.getById.mockResolvedValue({ id: "approval-1", status: "approved" });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await svc.requestBooking(AGENT_ID, sessionId, "A table for two", "e9");

    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toThrow("worker crashed mid-click");
    expect(worker.performClick).toHaveBeenCalledTimes(1);

    // Single-use held even though the click failed: no dangling clearance to retry.
    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
    expect(worker.performClick).toHaveBeenCalledTimes(1);
  });

  it("hand_over writes a plain-language payment notice for the Telegram bridge", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, adapterConfig: { laneA: { browserAccess: "browse_and_forms" } }, status: "idle" });
    const { notices } = wireBookingGateDefaults();
    const svc = browserService(db as any, { workerClient: fakeWorkerClientOnBookingPage() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await svc.handOver(AGENT_ID, sessionId, "hit a captcha", "please solve it and continue manually");

    expect(notices.writeHandOver).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, agentId: AGENT_ID, text: expect.stringContaining("captcha") }),
    );
  });
});

describe("browserService purchase gate (DUR-4046)", () => {
  beforeEach(() => {
    _resetBrowserSessionsForTests();
    vi.mocked(logActivity).mockClear();
    txCounterRow = {};
  });

  const CHECKOUT_URL = "https://shop.example.com/checkout?cart=abc123";
  const RECEIPT_URL = "https://shop.example.com/receipt?order=12345";

  function fakeWorkerClientOnCheckoutPage(overrides: Partial<BrowserWorkerClient> = {}): BrowserWorkerClient {
    return fakeWorkerClient({
      snapshot: vi.fn().mockResolvedValue({ tree: "Total: 300 kr", url: CHECKOUT_URL, title: "Checkout" }),
      screenshot: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      describeElement: vi.fn().mockResolvedValue({
        ref: "e9",
        role: "button",
        label: "Betal na",
        name: null,
        isFormSubmit: true,
        formHasPaymentField: true,
      }),
      performClick: vi.fn().mockResolvedValue({ tree: "", url: CHECKOUT_URL, title: "Processing" }),
      performType: vi.fn().mockResolvedValue({ tree: "", url: CHECKOUT_URL, title: "Checkout" }),
      ...overrides,
    });
  }

  it("refuses request_purchase for a browse_and_forms agent", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, adapterConfig: { laneA: { browserAccess: "browse_and_forms" } }, status: "idle" });
    wirePurchaseGateDefaults();
    const svc = browserService(db as any, { workerClient: fakeWorkerClientOnCheckoutPage() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    await expect(svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses request_purchase when purchases are switched off for the company", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    wirePurchaseGateDefaults({ purchasesEnabled: false });
    const svc = browserService(db as any, { workerClient: fakeWorkerClientOnCheckoutPage() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    await expect(svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID)).rejects.toMatchObject({ status: 403 });
  });

  it("auto-clears a purchase strictly under the threshold with no caps breached, reserving the card and filing no approval", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const { approvals, cards } = wirePurchaseGateDefaults();
    const svc = browserService(db as any, { workerClient: fakeWorkerClientOnCheckoutPage() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    const result = await svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID);

    expect(result).toMatchObject({ cardId: CARD_ID, status: "auto_cleared", approvalId: null });
    expect(cards.reserveAvailableCard).toHaveBeenCalledWith(COMPANY_ID, CARD_ID, { clearanceId: result.clearanceId, agentId: AGENT_ID });
    expect(approvals.create).not.toHaveBeenCalled();
  });

  it("files a board approval when the amount is at or above the NOK threshold, with server-derived reasons", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const { approvals, issues } = wirePurchaseGateDefaults();
    const worker = fakeWorkerClientOnCheckoutPage({
      snapshot: vi.fn().mockResolvedValue({ tree: "Total: 900 kr", url: CHECKOUT_URL, title: "Checkout" }),
    });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    const result = await svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID);

    expect(result.status).toBe("pending_approval");
    expect(result.approvalId).toBe("approval-1");
    expect(issues.createCompanyFile).toHaveBeenCalled();
    expect(approvals.create).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: "purchase",
          cardId: CARD_ID,
          merchantDomain: "example.com",
          amountNok: 900,
          reasons: expect.arrayContaining([expect.stringContaining("900")]),
        }),
      }),
    );
  });

  it("files a board approval when a rolling-window cap is breached, even though the amount itself is under threshold", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const { approvals } = wirePurchaseGateDefaults({ counters: { autoPurchasesToday: 3 } }); // PURCHASE_CAPS.autoPurchasesPerDay is 3
    const svc = browserService(db as any, { workerClient: fakeWorkerClientOnCheckoutPage() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    const result = await svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID);

    expect(result.status).toBe("pending_approval");
    expect(approvals.create).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        payload: expect.objectContaining({
          reasons: expect.arrayContaining([expect.stringContaining("auto-cleared purchase count cap")]),
        }),
      }),
    );
  });

  it("rolls back the card reservation if filing the approval fails", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const { approvals, cards } = wirePurchaseGateDefaults();
    approvals.create.mockRejectedValue(new Error("approvals service down"));
    const worker = fakeWorkerClientOnCheckoutPage({
      snapshot: vi.fn().mockResolvedValue({ tree: "Total: 900 kr", url: CHECKOUT_URL, title: "Checkout" }),
    });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    await expect(svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID)).rejects.toThrow("approvals service down");

    expect(cards.releaseReservation).toHaveBeenCalledWith(COMPANY_ID, CARD_ID, { clearanceId: expect.any(String) });
  });

  it("fill_payment_details types the card's fields directly into the given refs and masks card numbers out of the response", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    wirePurchaseGateDefaults();
    const worker = fakeWorkerClientOnCheckoutPage();
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    const { clearanceId } = await svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID);

    // Fresh snapshot at fill time happens to echo the (unmasked) card number -- proves maskCardNumbers scrubs it.
    vi.mocked(worker.snapshot).mockResolvedValue({ tree: "Total: 300 kr card on file: 4111111111111111", url: CHECKOUT_URL, title: "Checkout" });
    const result = await svc.fillPaymentDetails(AGENT_ID, sessionId, {
      clearanceId,
      cardNumberRef: "e10",
      cvcRef: "e11",
      nameOnCardRef: "e12",
    });

    expect(worker.performType).toHaveBeenCalledWith("worker-session-1", "e10", "4111111111111111");
    expect(worker.performType).toHaveBeenCalledWith("worker-session-1", "e11", "123");
    expect(worker.performType).toHaveBeenCalledWith("worker-session-1", "e12", "M Test");
    // Unmasked snapshot text ("card on file: 4111111111111111") comes back scrubbed.
    expect(result.tree).not.toContain("4111111111111111");
    expect(result.tree).toContain("****************");
  });

  it("fill_payment_details refuses while an approval-gated purchase is still waiting on Filip's decision", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const { approvals } = wirePurchaseGateDefaults();
    approvals.getById.mockResolvedValue({ id: "approval-1", status: "pending" });
    const worker = fakeWorkerClientOnCheckoutPage({
      snapshot: vi.fn().mockResolvedValue({ tree: "Total: 900 kr", url: CHECKOUT_URL, title: "Checkout" }),
    });
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    const { clearanceId } = await svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID);

    await expect(svc.fillPaymentDetails(AGENT_ID, sessionId, { clearanceId, cardNumberRef: "e10" })).rejects.toMatchObject({ status: 422 });
    expect(worker.performType).not.toHaveBeenCalled();
  });

  it("confirm_final_step (purchase) refuses and releases the card when the price increased since request_purchase", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const { cards } = wirePurchaseGateDefaults();
    const worker = fakeWorkerClientOnCheckoutPage();
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    const { clearanceId } = await svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID);
    void clearanceId;

    vi.mocked(worker.snapshot).mockResolvedValue({ tree: "Total: 900 kr", url: CHECKOUT_URL, title: "Checkout" });
    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
    expect(worker.performClick).not.toHaveBeenCalled();
    expect(cards.releaseReservation).toHaveBeenCalledWith(COMPANY_ID, CARD_ID, { clearanceId: expect.any(String) });

    // Slot cleared: a second confirm has nothing left to consume.
    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
  });

  it("confirm_final_step (purchase) allows a payment-field form submit (unlike booking) and marks the purchase awaiting outcome without writing a receipt yet", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const { notices } = wirePurchaseGateDefaults();
    const worker = fakeWorkerClientOnCheckoutPage();
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    await svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID);

    const snapshot = await svc.confirmFinalStep(AGENT_ID, sessionId, "e9");

    expect(worker.performClick).toHaveBeenCalledWith("worker-session-1", "e9");
    expect(snapshot).toBeTruthy();
    expect(notices.writePurchaseReceipt).not.toHaveBeenCalled();

    // Awaiting outcome: a second confirm attempt has nothing left to consume.
    await expect(svc.confirmFinalStep(AGENT_ID, sessionId, "e9")).rejects.toMatchObject({ status: 422 });
  });

  it("wait_for_outcome does not finalize while the outcome is still unverified", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const { cards, finance } = wirePurchaseGateDefaults();
    const worker = fakeWorkerClientOnCheckoutPage();
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    await svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID);
    await svc.confirmFinalStep(AGENT_ID, sessionId, "e9");

    // Still on the processing page -- no order reference, no failure wording.
    const { outcome } = await svc.waitForOutcome(AGENT_ID, sessionId);

    expect(outcome).toBe("unverified");
    expect(cards.consumeReservation).not.toHaveBeenCalled();
    expect(cards.releaseReservation).not.toHaveBeenCalled();
    expect(finance.createEvent).not.toHaveBeenCalled();

    // Still pending: calling it again is fine, not "no purchase waiting".
    await expect(svc.waitForOutcome(AGENT_ID, sessionId)).resolves.toMatchObject({ outcome: "unverified" });
  });

  it("wait_for_outcome finalizes a confirmed purchase: consumes the card, writes one finance_events debit, and sends a receipt", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const { cards, finance, notices } = wirePurchaseGateDefaults();
    const worker = fakeWorkerClientOnCheckoutPage();
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    const { clearanceId } = await svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID);
    await svc.confirmFinalStep(AGENT_ID, sessionId, "e9");

    vi.mocked(worker.snapshot).mockResolvedValue({ tree: "Order confirmed. Order reference: 12345", url: RECEIPT_URL, title: "Receipt" });
    const { outcome } = await svc.waitForOutcome(AGENT_ID, sessionId);

    expect(outcome).toBe("confirmed");
    expect(cards.consumeReservation).toHaveBeenCalledWith(COMPANY_ID, CARD_ID, {
      clearanceId,
      outcome: "used",
      spentAmountCents: 30000,
      purchaseId: clearanceId,
    });
    expect(finance.createEvent).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        eventKind: "browser_purchase",
        direction: "debit",
        biller: "example.com",
        amountCents: 30000,
        currency: "NOK",
        estimated: false,
      }),
    );
    expect(notices.writePurchaseReceipt).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID, agentId: AGENT_ID }));

    // Finalized: no purchase left waiting on this session.
    await expect(svc.waitForOutcome(AGENT_ID, sessionId)).rejects.toMatchObject({ status: 422 });
  });

  it("report_outcome forces a terminal used_unverified finalize when the outcome is still unverified", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const { cards, finance } = wirePurchaseGateDefaults();
    const worker = fakeWorkerClientOnCheckoutPage();
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    const { clearanceId } = await svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID);
    await svc.confirmFinalStep(AGENT_ID, sessionId, "e9");

    const { outcome } = await svc.reportOutcome(AGENT_ID, sessionId, "I think it went through but the page never redirected");

    expect(outcome).toBe("unverified");
    expect(cards.consumeReservation).toHaveBeenCalledWith(COMPANY_ID, CARD_ID, {
      clearanceId,
      outcome: "used_unverified",
      spentAmountCents: 30000,
      purchaseId: clearanceId,
    });
    expect(finance.createEvent).toHaveBeenCalledWith(COMPANY_ID, expect.objectContaining({ estimated: true }));
  });

  it("a failed outcome releases the card reservation and writes no finance_events debit", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const { cards, finance } = wirePurchaseGateDefaults();
    const worker = fakeWorkerClientOnCheckoutPage();
    const svc = browserService(db as any, { workerClient: worker });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "buy something" });
    const { clearanceId } = await svc.requestPurchase(AGENT_ID, sessionId, "A gadget", "e9", CARD_ID);
    await svc.confirmFinalStep(AGENT_ID, sessionId, "e9");

    vi.mocked(worker.snapshot).mockResolvedValue({ tree: "Payment declined by your bank", url: CHECKOUT_URL, title: "Checkout" });
    const { outcome } = await svc.waitForOutcome(AGENT_ID, sessionId);

    expect(outcome).toBe("failed");
    expect(cards.releaseReservation).toHaveBeenCalledWith(COMPANY_ID, CARD_ID, { clearanceId });
    expect(cards.consumeReservation).not.toHaveBeenCalled();
    expect(finance.createEvent).not.toHaveBeenCalled();
  });
});
