import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

/**
 * Product grabber routes -- who may do what, with the service mocked so only
 * the route layer is under test, same shape as watchers-routes.test.ts:
 *   1. agents are refused everywhere;
 *   2. any member of the company can see the settings and the staging list;
 *      only an owner or admin (or an instance admin, or the local board) can
 *      flip the switch, trigger an extraction, or review a staged item;
 *   3. another company's member gets nothing;
 *   4. bodies are validated.
 */

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const itemId = "33333333-3333-4333-8333-333333333333";
const agentId = "11111111-1111-4111-8111-111111111111";

const mockSettings = vi.hoisted(() => ({ get: vi.fn(), setEnabled: vi.fn() }));
const mockSvc = vi.hoisted(() => ({
  settings: mockSettings,
  extractAndStage: vi.fn(),
  list: vi.fn(),
  review: vi.fn(),
}));
vi.mock("../services/product-grabber/service.js", () => ({ productGrabberService: () => mockSvc }));

type Actor = Record<string, unknown>;
const member = (role: string, companyIds = [companyId]): Actor => ({
  type: "board",
  source: "session",
  userId: "filip",
  isInstanceAdmin: false,
  companyIds,
  memberships: companyIds.map((id) => ({ companyId: id, status: "active", membershipRole: role })),
});
const instanceAdmin: Actor = { type: "board", source: "session", userId: "root", isInstanceAdmin: true, companyIds: [companyId], memberships: [] };
const localBoard: Actor = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
const agent: Actor = { type: "agent", agentId, companyId, source: "agent_key", runId: "run-1" };

async function buildApp(actor: Actor) {
  const { productGrabberRoutes } = await import("../routes/product-grabber.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", productGrabberRoutes(withFakeCompanyScopeReserve({}) as never));
  app.use(errorHandler);
  return app;
}

const base = `/api/companies/${companyId}/product-grabber`;

const writes: Array<[string, string, Record<string, unknown> | undefined]> = [
  ["PATCH", `${base}/settings`, { enabled: true }],
  ["POST", `${base}/extract`, { url: "https://ellos.no/p/1" }],
  ["POST", `${base}/staged-items/${itemId}/review`, { status: "approved" }],
];
const reads: Array<[string, string, Record<string, unknown> | undefined]> = [
  ["GET", `${base}/settings`, undefined],
  ["GET", `${base}/staged-items`, undefined],
];

function send(app: express.Express, method: string, url: string, body?: Record<string, unknown>) {
  const req = request(app)[method.toLowerCase() as "get" | "post" | "patch" | "delete"](url);
  return body ? req.send(body) : req;
}

function expectServiceUntouched() {
  expect(mockSettings.get).not.toHaveBeenCalled();
  expect(mockSettings.setEnabled).not.toHaveBeenCalled();
  expect(mockSvc.extractAndStage).not.toHaveBeenCalled();
  expect(mockSvc.list).not.toHaveBeenCalled();
  expect(mockSvc.review).not.toHaveBeenCalled();
}

describe("product grabber routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.get.mockResolvedValue({ companyId, enabled: false });
    mockSettings.setEnabled.mockResolvedValue({ companyId, enabled: true });
    mockSvc.list.mockResolvedValue([]);
    mockSvc.extractAndStage.mockResolvedValue({ id: itemId, status: "pending" });
    mockSvc.review.mockResolvedValue({ id: itemId, status: "approved" });
  });

  it.each([...reads, ...writes])("%s %s -> 403 for an agent, service untouched", async (method, url, body) => {
    const res = await send(await buildApp(agent), method, url, body);
    expect(res.status).toBe(403);
    expectServiceUntouched();
  });

  it("any member of the company can see the settings and the staging list", async () => {
    const app = await buildApp(member("viewer"));
    const settingsRes = await send(app, "GET", `${base}/settings`);
    expect(settingsRes.status).toBe(200);
    expect(mockSettings.get).toHaveBeenCalledWith(companyId);
    const listRes = await send(app, "GET", `${base}/staged-items`);
    expect(listRes.status).toBe(200);
    expect(mockSvc.list).toHaveBeenCalledWith(companyId, undefined);
  });

  it.each(writes)("%s %s -> 403 for an operator or viewer, service untouched", async (method, url, body) => {
    for (const role of ["operator", "viewer", "member"]) {
      const res = await send(await buildApp(member(role)), method, url, body);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Only a company owner or admin can change the product grabber");
    }
    expectServiceUntouched();
  });

  it.each(writes)("%s %s -> allowed for an owner, an admin, an instance admin and the local board", async (method, url, body) => {
    for (const actor of [member("owner"), member("admin"), instanceAdmin, localBoard]) {
      const res = await send(await buildApp(actor), method, url, body);
      expect([200, 201, 202, 204]).toContain(res.status);
    }
  });

  it("an owner of another company gets nothing", async () => {
    const app = await buildApp(member("owner", [otherCompanyId]));
    for (const [method, url, body] of [...reads, ...writes]) {
      const res = await send(app, method, url, body);
      expect(res.status).toBe(403);
    }
    expectServiceUntouched();
  });

  it("extract passes the actor and validated body", async () => {
    const app = await buildApp(member("admin"));
    const res = await send(app, "POST", `${base}/extract`, { url: "https://ellos.no/p/1" });
    expect(res.status).toBe(201);
    expect(mockSvc.extractAndStage).toHaveBeenCalledWith(companyId, { url: "https://ellos.no/p/1" }, { userId: "filip" });
  });

  it("rejects a non-URL in the extract body", async () => {
    const app = await buildApp(member("admin"));
    const res = await send(app, "POST", `${base}/extract`, { url: "not-a-url" });
    expect(res.status).toBe(400);
    expectServiceUntouched();
  });

  it("review passes the actor and validated status", async () => {
    const app = await buildApp(member("owner"));
    const res = await send(app, "POST", `${base}/staged-items/${itemId}/review`, { status: "rejected" });
    expect(res.status).toBe(200);
    expect(mockSvc.review).toHaveBeenCalledWith(companyId, itemId, { status: "rejected" }, { userId: "filip" });
  });

  it("rejects an unknown review status", async () => {
    const app = await buildApp(member("owner"));
    const res = await send(app, "POST", `${base}/staged-items/${itemId}/review`, { status: "maybe" });
    expect(res.status).toBe(400);
    expectServiceUntouched();
  });

  it("an id that is not an id is a 404, not a database error", async () => {
    const res = await send(await buildApp(member("owner")), "POST", `${base}/staged-items/not-a-uuid/review`, {
      status: "approved",
    });
    expect(res.status).toBe(404);
    expectServiceUntouched();
  });

  it("filters the staging list by status when given a valid one, ignores an invalid one", async () => {
    const app = await buildApp(member("viewer"));
    const filtered = await send(app, "GET", `${base}/staged-items?status=approved`);
    expect(filtered.status).toBe(200);
    expect(mockSvc.list).toHaveBeenCalledWith(companyId, "approved");
    const ignored = await send(app, "GET", `${base}/staged-items?status=whatever`);
    expect(ignored.status).toBe(200);
    expect(mockSvc.list).toHaveBeenCalledWith(companyId, undefined);
  });
});
