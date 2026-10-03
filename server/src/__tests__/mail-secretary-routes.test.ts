import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

/**
 * Mail secretary routes -- who may do what, with the service mocked so only
 * the route layer is under test:
 *   1. agents are refused everywhere;
 *   2. unlike watchers, even reading is owner/admin only (or an instance
 *      admin, or the local board) -- this reads someone's real mail;
 *   3. another company's member gets nothing;
 *   4. an unrecognized id is a 404, not a database error.
 */

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const inboxId = "33333333-3333-4333-8333-333333333333";
const filterId = "44444444-4444-4444-8444-444444444444";
const agentId = "11111111-1111-4111-8111-111111111111";
const delegateAgentId = "55555555-5555-4555-8555-555555555555";

const mockSvc = vi.hoisted(() => ({
  listInboxes: vi.fn(),
  getInbox: vi.fn(),
  createInbox: vi.fn(),
  updateInbox: vi.fn(),
  removeInbox: vi.fn(),
  listFilters: vi.fn(),
  createFilter: vi.fn(),
  updateFilter: vi.fn(),
  removeFilter: vi.fn(),
  listItems: vi.fn(),
  tick: vi.fn(),
}));
vi.mock("../services/mail-secretary.js", () => ({ mailSecretaryService: () => mockSvc }));

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
  const { mailSecretaryRoutes } = await import("../routes/mail-secretary.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", mailSecretaryRoutes(withFakeCompanyScopeReserve({}) as never));
  app.use(errorHandler);
  return app;
}

const base = `/api/companies/${companyId}/mail-inboxes`;
const validBody = {
  name: "Filip's inbox",
  agentId,
  imapHost: "imap.example.com",
  imapUsername: "filip@example.com",
};
const validFilterBody = { label: "Nordstrand", field: "any", matchType: "contains", value: "Nordstrand" };

const everyRoute: Array<[string, string, Record<string, unknown> | undefined]> = [
  ["GET", base, undefined],
  ["GET", `${base}/${inboxId}`, undefined],
  ["POST", base, validBody],
  ["PATCH", `${base}/${inboxId}`, { name: "Renamed" }],
  ["DELETE", `${base}/${inboxId}`, undefined],
  ["GET", `${base}/${inboxId}/filters`, undefined],
  ["POST", `${base}/${inboxId}/filters`, validFilterBody],
  ["PATCH", `${base}/${inboxId}/filters/${filterId}`, { enabled: false }],
  ["DELETE", `${base}/${inboxId}/filters/${filterId}`, undefined],
  ["GET", `${base}/${inboxId}/items`, undefined],
];

function send(app: express.Express, method: string, url: string, body?: Record<string, unknown>) {
  const req = request(app)[method.toLowerCase() as "get" | "post" | "patch" | "delete"](url);
  return body ? req.send(body) : req;
}

function expectServiceUntouched() {
  for (const fn of Object.values(mockSvc)) expect(fn).not.toHaveBeenCalled();
}

describe("mail secretary routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.listInboxes.mockResolvedValue([]);
    mockSvc.getInbox.mockResolvedValue({ id: inboxId });
    mockSvc.createInbox.mockResolvedValue({ id: inboxId });
    mockSvc.updateInbox.mockResolvedValue({ id: inboxId });
    mockSvc.removeInbox.mockResolvedValue(undefined);
    mockSvc.listFilters.mockResolvedValue([]);
    mockSvc.createFilter.mockResolvedValue({ id: filterId });
    mockSvc.updateFilter.mockResolvedValue({ id: filterId });
    mockSvc.removeFilter.mockResolvedValue(undefined);
    mockSvc.listItems.mockResolvedValue([]);
  });

  it.each(everyRoute)("%s %s -> 403 for an agent, service untouched", async (method, url, body) => {
    const res = await send(await buildApp(agent), method, url, body);
    expect(res.status).toBe(403);
    expectServiceUntouched();
  });

  it.each(everyRoute)("%s %s -> 403 for a plain member (not owner/admin), service untouched", async (method, url, body) => {
    for (const role of ["operator", "viewer", "member"]) {
      const res = await send(await buildApp(member(role)), method, url, body);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Only a company owner or admin");
    }
    expectServiceUntouched();
  });

  it.each(everyRoute)("%s %s -> allowed for an owner, an admin, an instance admin and the local board", async (method, url, body) => {
    for (const actor of [member("owner"), member("admin"), instanceAdmin, localBoard]) {
      const res = await send(await buildApp(actor), method, url, body);
      expect([200, 201, 204]).toContain(res.status);
    }
  });

  it("an owner of another company gets nothing", async () => {
    const app = await buildApp(member("owner", [otherCompanyId]));
    for (const [method, url, body] of everyRoute) {
      const res = await send(app, method, url, body);
      expect(res.status).toBe(403);
    }
    expectServiceUntouched();
  });

  it("create passes the person and the validated body", async () => {
    const app = await buildApp(member("owner"));
    const res = await send(app, "POST", base, { ...validBody, delegateAgentId });
    expect(res.status).toBe(201);
    expect(mockSvc.createInbox).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        ...validBody,
        delegateAgentId,
        imapPort: 993,
        imapSecure: true,
        imapMailbox: "INBOX",
        practiceMode: true,
        checkEveryMinutes: 10,
      }),
      { userId: "filip" },
    );
  });

  it("refuses bad bodies: a credential VALUE sent instead of an id, unknown fields, a check interval under 5 minutes", async () => {
    const app = await buildApp(member("owner"));
    for (const body of [
      { ...validBody, credentialSecretId: "hunter2" },
      { ...validBody, imapPassword: "hunter2" },
      { ...validBody, checkEveryMinutes: 1 },
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

  it("the items report accepts a decision filter and rejects an unknown one", async () => {
    const app = await buildApp(member("owner"));
    const ok = await send(app, "GET", `${base}/${inboxId}/items?decision=delegated_to_maja&limit=10`);
    expect(ok.status).toBe(200);
    expect(mockSvc.listItems).toHaveBeenCalledWith(companyId, inboxId, { decision: "delegated_to_maja", limit: 10 });
    const bad = await send(app, "GET", `${base}/${inboxId}/items?decision=not_a_decision`);
    expect(bad.status).toBe(400);
  });
});
