import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

/**
 * DUR-4040: payment-card routes are board-only -- an agent API key can never
 * list, disable or mark-as-used-up a card, matching the rest of this feature
 * (companies.paymentsEnabled is board-settable only; see secrets.ts routes
 * for the identical assertBoard + assertCompanyAccess shape this copies).
 */
const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const cardId = "33333333-3333-4333-8333-333333333333";
const agentId = "11111111-1111-4111-8111-111111111111";

const mockSvc = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  disable: vi.fn(),
  markAsUsedUp: vi.fn(),
  runDailyExpiryTick: vi.fn(),
  resolveForFill: vi.fn(),
}));
vi.mock("../services/payment-cards.js", () => ({ paymentCardService: () => mockSvc }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

type Actor = Record<string, unknown>;
const member = (role: string, companyIds = [companyId]): Actor => ({
  type: "board",
  source: "session",
  userId: "filip",
  isInstanceAdmin: false,
  companyIds,
  memberships: companyIds.map((id) => ({ companyId: id, status: "active", membershipRole: role })),
});
const agent: Actor = { type: "agent", agentId, companyId, source: "agent_key", runId: "run-1" };

async function buildApp(actor: Actor) {
  const { paymentCardRoutes } = await import("../routes/payment-cards.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", paymentCardRoutes(withFakeCompanyScopeReserve({}) as never));
  app.use(errorHandler);
  return app;
}

const listUrl = `/api/companies/${companyId}/payment-cards`;
const disableUrl = `${listUrl}/${cardId}/disable`;
const markUsedUpUrl = `${listUrl}/${cardId}/mark-used-up`;

describe("payment card routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.list.mockResolvedValue([]);
    mockSvc.getById.mockResolvedValue({ id: cardId, companyId, label: "Test card" });
    mockSvc.disable.mockResolvedValue({ id: cardId, companyId, status: "disabled" });
    mockSvc.markAsUsedUp.mockResolvedValue({ id: cardId, companyId, status: "used" });
  });

  it.each([
    ["GET", listUrl, undefined],
    ["POST", disableUrl, { reason: "lost" }],
    ["POST", markUsedUpUrl, {}],
  ] as Array<[string, string, Record<string, unknown> | undefined]>)(
    "%s %s -> 403 for an agent, service untouched",
    async (method, url, body) => {
      const app = await buildApp(agent);
      const req = request(app)[method.toLowerCase() as "get" | "post"](url);
      const res = body ? await req.send(body) : await req;
      expect(res.status).toBe(403);
      for (const fn of Object.values(mockSvc)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it("any board member, including a viewer, can list the company's cards", async () => {
    const res = await request(await buildApp(member("viewer"))).get(listUrl);
    expect(res.status).toBe(200);
    expect(mockSvc.list).toHaveBeenCalledWith(companyId);
  });

  it("a viewer cannot disable or mark a card used up, only read", async () => {
    for (const url of [disableUrl, markUsedUpUrl]) {
      const res = await request(await buildApp(member("viewer"))).post(url).send({});
      expect(res.status).toBe(403);
    }
  });

  it("a non-viewer board member can disable a card", async () => {
    const res = await request(await buildApp(member("owner"))).post(disableUrl).send({ reason: "lost" });
    expect(res.status).toBe(200);
    expect(mockSvc.disable).toHaveBeenCalledWith(companyId, cardId, { reason: "lost" });
  });

  it("a non-viewer board member can mark a card as used up", async () => {
    const res = await request(await buildApp(member("owner"))).post(markUsedUpUrl).send({});
    expect(res.status).toBe(200);
    expect(mockSvc.markAsUsedUp).toHaveBeenCalledWith(companyId, cardId, { reason: null });
  });

  it("a member of a different company gets nothing", async () => {
    const app = await buildApp(member("owner", [otherCompanyId]));
    for (const [method, url] of [["GET", listUrl], ["POST", disableUrl], ["POST", markUsedUpUrl]] as Array<[string, string]>) {
      const res = await request(app)[method.toLowerCase() as "get" | "post"](url).send({});
      expect(res.status).toBe(403);
    }
  });
});
