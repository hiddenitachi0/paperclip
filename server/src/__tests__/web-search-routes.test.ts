import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

/**
 * Connections → Web search routes, with the service mocked so only who may do
 * what is under test: any active member reads; only an owner, an admin, an
 * instance admin or the local board picks the key; agents get nothing; the
 * body names a secret by id and nothing else.
 */

const companyId = "22222222-2222-4222-8222-222222222222";
const secretId = "44444444-4444-4444-8444-444444444444";

const settings = {
  keySecretId: secretId,
  keySecretName: "Brave",
  keySecretKind: "brave_search_api_key",
  keyStatus: "ok",
  dailyCap: 100,
  usedToday: 3,
};

const mockSvc = vi.hoisted(() => ({ getSettings: vi.fn(), setKey: vi.fn() }));
vi.mock("../services/web-search.js", () => ({ webSearchService: () => mockSvc }));

type Actor = Record<string, unknown>;
const member = (role: string, companyIds = [companyId]): Actor => ({
  type: "board",
  source: "session",
  userId: "filip",
  isInstanceAdmin: false,
  companyIds,
  memberships: companyIds.map((id) => ({ companyId: id, status: "active", membershipRole: role })),
});
const localBoard = (): Actor => ({ type: "board", source: "local_implicit", userId: "local", isInstanceAdmin: false, companyIds: [], memberships: [] });
const instanceAdmin = (): Actor => ({ ...member("viewer"), isInstanceAdmin: true });
const agent = (): Actor => ({ type: "agent", agentId: "11111111-1111-4111-8111-111111111111", companyId, source: "agent_key" });

async function buildApp(actor: Actor) {
  const { webSearchRoutes } = await import("../routes/web-search.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", webSearchRoutes(withFakeCompanyScopeReserve({}) as never));
  app.use(errorHandler);
  return app;
}

describe("web search routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.getSettings.mockResolvedValue(settings);
    mockSvc.setKey.mockResolvedValue(settings);
  });

  it("lets any active member read the card, never a key value", async () => {
    const res = await request(await buildApp(member("viewer"))).get(`/api/companies/${companyId}/web-search`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(settings);
    expect(mockSvc.getSettings).toHaveBeenCalledWith(companyId);
  });

  it.each([
    ["owner", member("owner")],
    ["admin", member("admin")],
    ["instance admin", instanceAdmin()],
    ["local board", localBoard()],
  ])("lets the %s pick or remove the key", async (_label, actor) => {
    const app = await buildApp(actor);
    const picked = await request(app).put(`/api/companies/${companyId}/web-search`).send({ secretId });
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    expect(mockSvc.setKey).toHaveBeenCalledWith(companyId, secretId, expect.anything());
    const removed = await request(app).put(`/api/companies/${companyId}/web-search`).send({ secretId: null });
    expect(removed.status).toBe(200);
    expect(mockSvc.setKey).toHaveBeenLastCalledWith(companyId, null, expect.anything());
  });

  it("refuses an operator or viewer who tries to change the key, with a plain sentence", async () => {
    for (const role of ["operator", "viewer"]) {
      const res = await request(await buildApp(member(role))).put(`/api/companies/${companyId}/web-search`).send({ secretId });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Only a company owner or admin can change the web search key");
    }
    expect(mockSvc.setKey).not.toHaveBeenCalled();
  });

  it("refuses agents on both routes, and members of another company", async () => {
    const asAgent = await buildApp(agent());
    expect((await request(asAgent).get(`/api/companies/${companyId}/web-search`)).status).toBe(403);
    expect((await request(asAgent).put(`/api/companies/${companyId}/web-search`).send({ secretId })).status).toBe(403);
    const stranger = await buildApp(member("owner", ["99999999-9999-4999-8999-999999999999"]));
    expect((await request(stranger).get(`/api/companies/${companyId}/web-search`)).status).toBe(403);
    expect(mockSvc.getSettings).not.toHaveBeenCalled();
    expect(mockSvc.setKey).not.toHaveBeenCalled();
  });

  it("takes a secret id only: a pasted value or a malformed id is refused", async () => {
    const app = await buildApp(member("owner"));
    expect((await request(app).put(`/api/companies/${companyId}/web-search`).send({ secretId, value: "BSA-key" })).status).toBe(400);
    expect((await request(app).put(`/api/companies/${companyId}/web-search`).send({ secretId: "BSA-key" })).status).toBe(400);
    expect(mockSvc.setKey).not.toHaveBeenCalled();
  });
});
