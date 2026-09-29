import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

// Route wiring only, same approach as agents-quick-agent-hire.test.ts: the
// service layer is mocked so this file proves what routes/browser.ts is
// actually responsible for -- who gets in the door (a full-run agent only,
// never a quick agent or a board user) and that each route calls the right
// service method with the right arguments -- not the session/gate logic
// itself, which browser-service.test.ts covers directly.
const COMPANY_ID = "c0000001-0000-4000-8000-000000000001";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const mockBrowserService = vi.hoisted(() => ({
  open: vi.fn(),
  navigate: vi.fn(),
  snapshot: vi.fn(),
  readText: vi.fn(),
  click: vi.fn(),
  type: vi.fn(),
  select: vi.fn(),
  check: vi.fn(),
  pressKey: vi.fn(),
  screenshot: vi.fn(),
  wait: vi.fn(),
  back: vi.fn(),
  close: vi.fn(),
  handOver: vi.fn(),
  requestBooking: vi.fn(),
  confirmFinalStep: vi.fn(),
}));

vi.mock("../services/browser-service.js", () => ({
  browserService: () => mockBrowserService,
}));

type Actor = "board" | "agent" | "service";

async function createApp(actorType: Actor) {
  const [{ browserRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/browser.js")>("../routes/browser.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor =
      actorType === "board"
        ? { type: "board", userId: "local-board", companyIds: [COMPANY_ID], source: "local_implicit", isInstanceAdmin: false }
        : actorType === "service"
          ? { type: "service", companyId: COMPANY_ID, serviceTokenId: "svc-1", serviceTokenName: "lane-a" }
          : { type: "agent", agentId: AGENT_ID, companyId: COMPANY_ID, source: "agent_jwt" };
    next();
  });
  app.use("/api", browserRoutes(withFakeCompanyScopeReserve({}) as never));
  app.use(errorHandler);
  return app;
}

describe("browserRoutes", () => {
  beforeEach(() => {
    for (const fn of Object.values(mockBrowserService)) fn.mockReset();
  });

  it("refuses a board user (these routes are agent-only)", async () => {
    const app = await createApp("board");
    const res = await request(app).post("/api/browser/sessions").send({ purpose: "book a table" });
    expect(res.status).toBe(403);
    expect(mockBrowserService.open).not.toHaveBeenCalled();
  });

  it("refuses a Lane A quick-agent call (authenticates as a service actor, never 'agent')", async () => {
    const app = await createApp("service");
    const res = await request(app).post("/api/browser/sessions").send({ purpose: "book a table" });
    expect(res.status).toBe(403);
    expect(mockBrowserService.open).not.toHaveBeenCalled();
  });

  it("opens a session for a full-run agent and returns the service result", async () => {
    mockBrowserService.open.mockResolvedValue({ sessionId: "sess-1", snapshot: { tree: "", url: "https://x", title: "" } });
    const app = await createApp("agent");

    const res = await request(app).post("/api/browser/sessions").send({ purpose: "book a table" });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe("sess-1");
    expect(mockBrowserService.open).toHaveBeenCalledWith(AGENT_ID, { purpose: "book a table" });
  });

  it("rejects an empty purpose before it reaches the service", async () => {
    const app = await createApp("agent");
    const res = await request(app).post("/api/browser/sessions").send({ purpose: "" });
    expect(res.status).toBe(400);
    expect(mockBrowserService.open).not.toHaveBeenCalled();
  });

  it("routes click with ref/why to the service", async () => {
    mockBrowserService.click.mockResolvedValue({ ok: true, value: { tree: "", url: "https://x", title: "" } });
    const app = await createApp("agent");

    const res = await request(app)
      .post("/api/browser/sessions/sess-1/click")
      .send({ ref: "e3", why: "open the menu" });

    expect(res.status).toBe(200);
    expect(mockBrowserService.click).toHaveBeenCalledWith(AGENT_ID, "sess-1", "e3", "open the menu");
  });

  it("routes hand-over with reason/whatFilipShouldDo to the service", async () => {
    mockBrowserService.handOver.mockResolvedValue(undefined);
    const app = await createApp("agent");

    const res = await request(app)
      .post("/api/browser/sessions/sess-1/hand-over")
      .send({ reason: "captcha", whatFilipShouldDo: "solve it and continue" });

    expect(res.status).toBe(200);
    expect(mockBrowserService.handOver).toHaveBeenCalledWith(AGENT_ID, "sess-1", "captcha", "solve it and continue");
  });

  it("routes request-booking with summary and ref to the service (DUR-4037)", async () => {
    mockBrowserService.requestBooking.mockResolvedValue({ approvalId: "approval-1", status: "pending_approval" });
    const app = await createApp("agent");

    const res = await request(app)
      .post("/api/browser/sessions/sess-1/request-booking")
      .send({ summary: "A table for two, free, no deposit", ref: "e9" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ approvalId: "approval-1", status: "pending_approval" });
    expect(mockBrowserService.requestBooking).toHaveBeenCalledWith(AGENT_ID, "sess-1", "A table for two, free, no deposit", "e9");
  });

  it("rejects request-booking with an empty summary before it reaches the service", async () => {
    const app = await createApp("agent");
    const res = await request(app).post("/api/browser/sessions/sess-1/request-booking").send({ summary: "", ref: "e9" });
    expect(res.status).toBe(400);
    expect(mockBrowserService.requestBooking).not.toHaveBeenCalled();
  });

  it("rejects request-booking without a ref before it reaches the service (DUR-4045 clearance binding)", async () => {
    const app = await createApp("agent");
    const res = await request(app).post("/api/browser/sessions/sess-1/request-booking").send({ summary: "A table for two" });
    expect(res.status).toBe(400);
    expect(mockBrowserService.requestBooking).not.toHaveBeenCalled();
  });

  it("refuses a board user on request-booking (agent-only, same as every other browser route)", async () => {
    const app = await createApp("board");
    const res = await request(app).post("/api/browser/sessions/sess-1/request-booking").send({ summary: "A table for two" });
    expect(res.status).toBe(403);
    expect(mockBrowserService.requestBooking).not.toHaveBeenCalled();
  });

  it("routes confirm-final-step with ref to the service (DUR-4037)", async () => {
    mockBrowserService.confirmFinalStep.mockResolvedValue({ tree: "", url: "https://x/confirmed", title: "Confirmed" });
    const app = await createApp("agent");

    const res = await request(app).post("/api/browser/sessions/sess-1/confirm-final-step").send({ ref: "e9" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ snapshot: { tree: "", url: "https://x/confirmed", title: "Confirmed" } });
    expect(mockBrowserService.confirmFinalStep).toHaveBeenCalledWith(AGENT_ID, "sess-1", "e9");
  });
});
