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
    get: vi.fn().mockResolvedValue({ companyId: "unset", bookingEnabled: false }),
  })),
}));
vi.mock("./payment-notices.js", () => ({
  paymentNoticesService: vi.fn(() => ({
    writeReceipt: vi.fn().mockResolvedValue({}),
    writeHandOver: vi.fn().mockResolvedValue({}),
  })),
}));
vi.mock("./issues.js", () => ({
  issueService: vi.fn(() => ({ createCompanyFile: vi.fn().mockResolvedValue({ id: "unset" }) })),
}));
vi.mock("../storage/index.js", () => ({
  getStorageService: vi.fn(() => ({ putFile: vi.fn().mockResolvedValue({}) })),
}));

const { browserService, _resetBrowserSessionsForTests } = await import("./browser-service.js");
const { logActivity } = await import("./activity-log.js");
const { approvalService } = await import("./approvals.js");
const { companyPaymentSettingsService } = await import("./company-payment-settings.js");
const { paymentNoticesService } = await import("./payment-notices.js");
const { issueService } = await import("./issues.js");
const { getStorageService } = await import("../storage/index.js");

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

function fakePaymentSettings(bookingEnabled: boolean) {
  const settings = { get: vi.fn().mockResolvedValue({ companyId: COMPANY_ID, bookingEnabled }) };
  vi.mocked(companyPaymentSettingsService).mockReturnValue(settings as any);
  return settings;
}

function fakePaymentNotices() {
  const notices = { writeReceipt: vi.fn().mockResolvedValue({}), writeHandOver: vi.fn().mockResolvedValue({}) };
  vi.mocked(paymentNoticesService).mockReturnValue(notices as any);
  return notices;
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

const BOOK_AND_BUY_AGENT = { id: AGENT_ID, companyId: COMPANY_ID, browserAccess: "book_and_buy", status: "idle" };

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
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, browserAccess: "browse_and_forms", status: "idle" });
    wireBookingGateDefaults({ bookingEnabled: true });
    const svc = browserService(db as any, { workerClient: fakeWorkerClientOnBookingPage() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await expect(svc.requestBooking(AGENT_ID, sessionId, "A table for two")).rejects.toMatchObject({ status: 403 });
  });

  it("refuses request_booking for a book_and_buy agent when the company kill switch is off", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    wireBookingGateDefaults({ bookingEnabled: false });
    const svc = browserService(db as any, { workerClient: fakeWorkerClientOnBookingPage() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await expect(svc.requestBooking(AGENT_ID, sessionId, "A table for two")).rejects.toMatchObject({ status: 403 });
  });

  it("request_booking files a board approval stamped with the server's own domain and screenshot, and parks the session", async () => {
    const db = fakeDbWithAgent(BOOK_AND_BUY_AGENT);
    const { approvals, issues } = wireBookingGateDefaults({ bookingEnabled: true });
    const svc = browserService(db as any, { workerClient: fakeWorkerClientOnBookingPage() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    const result = await svc.requestBooking(AGENT_ID, sessionId, 'A "free" table, no deposit');

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
    await svc.requestBooking(AGENT_ID, sessionId, "First booking");
    await expect(svc.requestBooking(AGENT_ID, sessionId, "Second booking")).rejects.toMatchObject({ status: 422 });
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
    await svc.requestBooking(AGENT_ID, sessionId, "A table for two");

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
    await svc.requestBooking(AGENT_ID, sessionId, "A table for two");

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
    await svc.requestBooking(AGENT_ID, sessionId, "A table for two");

    vi.mocked(worker.snapshot).mockResolvedValue({ tree: "", url: OTHER_SITE_URL, title: "Different site" });
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
      await svc.requestBooking(AGENT_ID, sessionId, "A table for two");

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

  it("hand_over writes a plain-language payment notice for the Telegram bridge", async () => {
    const db = fakeDbWithAgent({ id: AGENT_ID, companyId: COMPANY_ID, browserAccess: "browse_and_forms", status: "idle" });
    const { notices } = wireBookingGateDefaults();
    const svc = browserService(db as any, { workerClient: fakeWorkerClientOnBookingPage() });

    const { sessionId } = await svc.open(AGENT_ID, { purpose: "book a table" });
    await svc.handOver(AGENT_ID, sessionId, "hit a captcha", "please solve it and continue manually");

    expect(notices.writeHandOver).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, agentId: AGENT_ID, text: expect.stringContaining("captcha") }),
    );
  });
});
