import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

/**
 * Email settings routes (DUR-4277) -- who may do what, with the service mocked
 * so only the route layer is under test, same shape as
 * product-grabber-routes.test.ts:
 *   1. agents are refused everywhere;
 *   2. any member of the company can read the setting; only an owner or admin
 *      (or an instance admin, or the local board) can flip it;
 *   3. another company's member gets nothing;
 *   4. the PATCH body is validated.
 */

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const agentId = "11111111-1111-4111-8111-111111111111";

const mockSvc = vi.hoisted(() => ({ get: vi.fn(), setEnabled: vi.fn() }));
vi.mock("../services/email/settings.js", () => ({ emailSettingsService: () => mockSvc }));

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
  const { emailSettingsRoutes } = await import("../routes/email-settings.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", emailSettingsRoutes(withFakeCompanyScopeReserve({}) as never));
  app.use(errorHandler);
  return app;
}

const base = `/api/companies/${companyId}/email`;

function send(app: express.Express, method: string, url: string, body?: Record<string, unknown>) {
  const req = request(app)[method.toLowerCase() as "get" | "post" | "patch" | "delete"](url);
  return body ? req.send(body) : req;
}

function expectServiceUntouched() {
  expect(mockSvc.get).not.toHaveBeenCalled();
  expect(mockSvc.setEnabled).not.toHaveBeenCalled();
}

describe("email settings routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.get.mockResolvedValue({ enabled: false });
    mockSvc.setEnabled.mockResolvedValue({ enabled: true });
  });

  it.each([
    ["GET", `${base}/settings`, undefined],
    ["PATCH", `${base}/settings`, { enabled: true }],
  ])("%s %s -> 403 for an agent, service untouched", async (method, url, body) => {
    const res = await send(await buildApp(agent), method, url, body as Record<string, unknown> | undefined);
    expect(res.status).toBe(403);
    expectServiceUntouched();
  });

  it("any member of the company can read the setting", async () => {
    const res = await send(await buildApp(member("viewer")), "GET", `${base}/settings`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
    expect(mockSvc.get).toHaveBeenCalledWith(companyId);
  });

  it("PATCH -> 403 for an operator or viewer with the plain-language message", async () => {
    for (const role of ["operator", "viewer", "member"]) {
      const res = await send(await buildApp(member(role)), "PATCH", `${base}/settings`, { enabled: true });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Only a company owner or admin can change this.");
    }
    expect(mockSvc.setEnabled).not.toHaveBeenCalled();
  });

  it("PATCH -> allowed for an owner, an admin, an instance admin and the local board", async () => {
    for (const actor of [member("owner"), member("admin"), instanceAdmin, localBoard]) {
      const res = await send(await buildApp(actor), "PATCH", `${base}/settings`, { enabled: true });
      expect(res.status).toBe(200);
    }
    expect(mockSvc.setEnabled).toHaveBeenCalledWith(companyId, true);
  });

  it("an owner of another company gets nothing", async () => {
    const app = await buildApp(member("owner", [otherCompanyId]));
    for (const [method, url, body] of [
      ["GET", `${base}/settings`, undefined],
      ["PATCH", `${base}/settings`, { enabled: true }],
    ] as const) {
      const res = await send(app, method, url, body as Record<string, unknown> | undefined);
      expect(res.status).toBe(403);
    }
    expectServiceUntouched();
  });

  it("rejects an invalid PATCH body", async () => {
    const app = await buildApp(member("owner"));
    const missing = await send(app, "PATCH", `${base}/settings`, {});
    expect(missing.status).toBe(400);
    const wrongType = await send(app, "PATCH", `${base}/settings`, { enabled: "yes" });
    expect(wrongType.status).toBe(400);
    const extraKey = await send(app, "PATCH", `${base}/settings`, { enabled: true, sneaky: 1 });
    expect(extraKey.status).toBe(400);
    expect(mockSvc.setEnabled).not.toHaveBeenCalled();
  });
});
