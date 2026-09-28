import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

/**
 * Watcher routes -- who may do what, with the service mocked so only the
 * route layer is under test:
 *   1. agents are refused everywhere (reading, changing, the outbox);
 *   2. any member of the company can see the watchers; only an owner or
 *      admin (or an instance admin, or the local board) can add, change,
 *      delete or test one;
 *   3. another company's member gets nothing;
 *   4. the outbox and its acknowledgement need board access to the company;
 *   5. bodies are validated (a key VALUE cannot be sent, only a secret id).
 */

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const watcherId = "33333333-3333-4333-8333-333333333333";
const alertId = "44444444-4444-4444-8444-444444444444";
const agentId = "11111111-1111-4111-8111-111111111111";

const mockSvc = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  testAlert: vi.fn(),
  outbox: vi.fn(),
  ack: vi.fn(),
}));
vi.mock("../services/watchers.js", () => ({ watcherService: () => mockSvc }));

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
  const { watcherRoutes } = await import("../routes/watchers.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", watcherRoutes(withFakeCompanyScopeReserve({}) as never));
  app.use(errorHandler);
  return app;
}

const base = `/api/companies/${companyId}/watchers`;
const validBody = {
  name: "Bitcoin swings",
  agentId,
  source: "crypto",
  symbol: "BTC",
  rule: { kind: "change", direction: "either", percent: 5, windowHours: 24 },
};

const writes: Array<[string, string, Record<string, unknown> | undefined]> = [
  ["POST", base, validBody],
  ["PATCH", `${base}/${watcherId}`, { enabled: false }],
  ["DELETE", `${base}/${watcherId}`, undefined],
  ["POST", `${base}/${watcherId}/test`, undefined],
];
const outboxRoutes: Array<[string, string, Record<string, unknown> | undefined]> = [
  ["GET", `/api/companies/${companyId}/watcher-outbox`, undefined],
  ["POST", `/api/companies/${companyId}/watcher-outbox/${alertId}/ack`, { outcome: "delivered" }],
];

function send(app: express.Express, method: string, url: string, body?: Record<string, unknown>) {
  const req = request(app)[method.toLowerCase() as "get" | "post" | "patch" | "delete"](url);
  return body ? req.send(body) : req;
}

function expectServiceUntouched() {
  for (const fn of Object.values(mockSvc)) expect(fn).not.toHaveBeenCalled();
}

describe("watcher routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.list.mockResolvedValue([]);
    mockSvc.create.mockResolvedValue({ id: watcherId });
    mockSvc.update.mockResolvedValue({ id: watcherId });
    mockSvc.remove.mockResolvedValue(undefined);
    mockSvc.testAlert.mockResolvedValue({ id: alertId, status: "composing" });
    mockSvc.outbox.mockResolvedValue([]);
    mockSvc.ack.mockResolvedValue({ id: alertId, status: "delivered" });
  });

  it.each([["GET", base, undefined] as [string, string, undefined], ...writes, ...outboxRoutes])(
    "%s %s -> 403 for an agent, service untouched",
    async (method, url, body) => {
      const res = await send(await buildApp(agent), method, url, body);
      expect(res.status).toBe(403);
      expectServiceUntouched();
    },
  );

  it("any member of the company can see the watchers", async () => {
    const res = await send(await buildApp(member("viewer")), "GET", base);
    expect(res.status).toBe(200);
    expect(mockSvc.list).toHaveBeenCalledWith(companyId);
  });

  it.each(writes)("%s %s -> 403 for an operator or viewer, service untouched", async (method, url, body) => {
    for (const role of ["operator", "viewer", "member"]) {
      const res = await send(await buildApp(member(role)), method, url, body);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Only a company owner or admin can change watchers");
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
    for (const [method, url, body] of [["GET", base, undefined] as [string, string, undefined], ...writes, ...outboxRoutes]) {
      const res = await send(app, method, url, body);
      expect(res.status).toBe(403);
    }
    expectServiceUntouched();
  });

  it("create passes the person and the validated body; the test button answers 202", async () => {
    const app = await buildApp(member("owner"));
    const created = await send(app, "POST", base, validBody);
    expect(created.status).toBe(201);
    expect(mockSvc.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ ...validBody, checkEveryMinutes: 15, cooldownMinutes: 360, enabled: true, withPicture: false, keySecretId: null }),
      { userId: "filip" },
    );
    const tested = await send(app, "POST", `${base}/${watcherId}/test`);
    expect(tested.status).toBe(202);
    expect(mockSvc.testAlert).toHaveBeenCalledWith(companyId, watcherId, { userId: "filip" });
  });

  it("refuses bad bodies: checks under 5 minutes, unknown fields (a key value), unknown rules", async () => {
    const app = await buildApp(member("owner"));
    for (const body of [
      { ...validBody, checkEveryMinutes: 1 },
      { ...validBody, apiKey: "d0fakefinnhubkey" },
      { ...validBody, rule: { kind: "ai_decides" } },
      { ...validBody, rule: { kind: "change", direction: "up", percent: 5, windowHours: 500 } },
    ]) {
      const res = await send(app, "POST", base, body);
      expect(res.status).toBe(400);
    }
    expectServiceUntouched();
  });

  it("an id that is not an id is a 404, not a database error", async () => {
    const res = await send(await buildApp(member("owner")), "DELETE", `${base}/not-a-uuid`);
    expect(res.status).toBe(404);
    expectServiceUntouched();
  });

  it("the outbox and its acknowledgement work for a board member of the company", async () => {
    const app = await buildApp(member("operator"));
    const listed = await send(app, "GET", `/api/companies/${companyId}/watcher-outbox`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ alerts: [] });
    const acked = await send(app, "POST", `/api/companies/${companyId}/watcher-outbox/${alertId}/ack`, { outcome: "delivered" });
    expect(acked.status).toBe(200);
    expect(mockSvc.ack).toHaveBeenCalledWith(companyId, alertId, { outcome: "delivered" });
    const bad = await send(app, "POST", `/api/companies/${companyId}/watcher-outbox/${alertId}/ack`, { outcome: "maybe" });
    expect(bad.status).toBe(400);
  });
});
