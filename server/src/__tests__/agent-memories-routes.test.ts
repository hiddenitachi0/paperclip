import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { conflict, notFound } from "../errors.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

/**
 * Quick-agent memory notebook routes -- who may do what, with the service and
 * the permission decision mocked so only the route layer is under test.
 *
 *   1. Agents are refused on every route, reading included; the service is
 *      never called, so an agent can neither read nor plant notes here.
 *   2. A board user needs access to the agent's company AND the same
 *      permission that changing the agent's quick settings needs
 *      (agents:create); without it, a plain 403.
 *   3. Another company's agent is refused before the service runs.
 *   4. Allowed users list, add, edit, delete one and clear all; the service
 *      gets the company off the agent row and the person as the actor.
 */

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const agentId = "11111111-1111-4111-8111-111111111111";
const memoryId = "33333333-3333-4333-8333-333333333333";

const note = {
  id: memoryId,
  text: "I take my coffee black.",
  source: "user",
  agentId,
  personaId: null,
  createdByUserId: "filip",
  createdByName: "Filip",
  createdAt: "2026-09-28T10:00:00.000Z",
  updatedAt: "2026-09-28T10:00:00.000Z",
};

const mockSvc = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("../services/agent-memories.js", () => ({ agentMemoryService: () => mockSvc }));

const mockDecide = vi.hoisted(() => vi.fn());
vi.mock("../services/access.js", () => ({ accessService: () => ({ decide: mockDecide }) }));

type AgentRow = { id: string; companyId: string } | null;
const agentRow = vi.hoisted(() => ({ current: null as AgentRow }));

function fakeRawDb() {
  const query = {
    from: () => query,
    where: async () => (agentRow.current ? [agentRow.current] : []),
  };
  return { select: () => query };
}

type Actor = Record<string, unknown>;

const member = (companyIds = [companyId], role = "owner"): Actor => ({
  type: "board",
  source: "session",
  userId: "filip",
  isInstanceAdmin: false,
  companyIds,
  memberships: companyIds.map((id) => ({ companyId: id, status: "active", membershipRole: role })),
});
const agent = (company = companyId): Actor => ({ type: "agent", agentId, companyId: company, source: "agent_key", runId: "run-1" });

async function buildApp(actor: Actor) {
  const { agentMemoryRoutes } = await import("../routes/agent-memories.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", agentMemoryRoutes(withFakeCompanyScopeReserve(fakeRawDb()) as never));
  app.use(errorHandler);
  return app;
}

const base = `/api/agents/${agentId}/memories`;
const allRoutes: Array<[string, string, Record<string, unknown> | undefined]> = [
  ["GET", base, undefined],
  ["POST", base, { text: "Planted." }],
  ["PATCH", `${base}/${memoryId}`, { text: "Changed." }],
  ["DELETE", `${base}/${memoryId}`, undefined],
  ["DELETE", base, undefined],
];

function send(app: express.Express, method: string, url: string, body?: Record<string, unknown>) {
  const req = request(app)[method.toLowerCase() as "get" | "post" | "patch" | "delete"](url);
  return body ? req.send(body) : req;
}

function expectServiceUntouched() {
  for (const fn of Object.values(mockSvc)) expect(fn).not.toHaveBeenCalled();
}

describe("quick-agent memory routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentRow.current = { id: agentId, companyId };
    mockDecide.mockResolvedValue({ allowed: true, explanation: "ok" });
    mockSvc.list.mockResolvedValue({ owner: { kind: "agent", agentId, name: "Front desk" }, maxNotes: 100, maxLength: 500, notes: [note] });
    mockSvc.add.mockResolvedValue(note);
    mockSvc.update.mockResolvedValue({ ...note, text: "Changed." });
    mockSvc.remove.mockResolvedValue({ id: memoryId, text: note.text });
    mockSvc.clear.mockResolvedValue({ deleted: 1 });
  });

  describe("agents are refused everywhere", () => {
    it.each(allRoutes)("%s %s -> 403 for an agent of the same company, service untouched", async (method, url, body) => {
      const res = await send(await buildApp(agent()), method, url, body);
      expect(res.status).toBe(403);
      expectServiceUntouched();
      expect(mockDecide).not.toHaveBeenCalled();
    });

    it("refuses the quick agent itself, even for reading its own notes", async () => {
      const res = await send(await buildApp({ ...agent(), agentId }), "GET", base);
      expect(res.status).toBe(403);
      expectServiceUntouched();
    });
  });

  it.each(allRoutes)("%s %s -> 403 with a plain sentence for a board user without the right to change the agent", async (method, url, body) => {
    mockDecide.mockResolvedValue({ allowed: false, explanation: "Missing permission: agents:create" });
    const res = await send(await buildApp(member([companyId], "operator")), method, url, body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only people who can change this agent's settings can see and change its memory.");
    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agents:create", resource: { type: "company", companyId } }),
    );
    expectServiceUntouched();
  });

  it.each(allRoutes)("%s %s -> 403 for a board user of another company, before any permission check", async (method, url, body) => {
    const res = await send(await buildApp(member([otherCompanyId])), method, url, body);
    expect(res.status).toBe(403);
    expect(mockDecide).not.toHaveBeenCalled();
    expectServiceUntouched();
  });

  it("answers 404 for an agent that does not exist or an id that is not an id", async () => {
    agentRow.current = null;
    const app = await buildApp(member());
    expect((await send(app, "GET", base)).status).toBe(404);
    expect((await send(app, "GET", "/api/agents/not-a-uuid/memories")).status).toBe(404);
    agentRow.current = { id: agentId, companyId };
    expect((await send(app, "DELETE", `${base}/not-a-uuid`)).status).toBe(404);
    expect((await send(app, "PATCH", `${base}/not-a-uuid`, { text: "x" })).status).toBe(404);
    expectServiceUntouched();
  });

  describe("a board user who may change the agent", () => {
    it("lists the notebook", async () => {
      const res = await send(await buildApp(member()), "GET", base);
      expect(res.status).toBe(200);
      expect(res.body.notes).toEqual([note]);
      expect(mockSvc.list).toHaveBeenCalledWith(companyId, agentId);
    });

    it("adds a note as 'user', tidied, with the person as the actor", async () => {
      const res = await send(await buildApp(member()), "POST", base, { text: "  I take my\ncoffee black.  " });
      expect(res.status).toBe(201);
      expect(mockSvc.add).toHaveBeenCalledWith(
        companyId,
        agentId,
        { text: "I take my coffee black.", source: "user" },
        { actorType: "user", actorId: "filip", userId: "filip", via: "page" },
      );
    });

    it("refuses an empty note, one over 500 characters and extra fields before the service runs", async () => {
      const app = await buildApp(member());
      expect((await send(app, "POST", base, { text: "  " })).status).toBe(400);
      expect((await send(app, "POST", base, { text: "x".repeat(501) })).status).toBe(400);
      expect((await send(app, "POST", base, { text: "ok", source: "agent" })).status).toBe(400);
      expect((await send(app, "PATCH", `${base}/${memoryId}`, { text: "x".repeat(501) })).status).toBe(400);
      expectServiceUntouched();
    });

    it("passes the service's plain refusals on: memory full, note gone", async () => {
      const app = await buildApp(member());
      mockSvc.add.mockRejectedValueOnce(conflict("The memory is full: it already holds 100 notes. Delete some old ones first."));
      const full = await send(app, "POST", base, { text: "One more." });
      expect(full.status).toBe(409);
      expect(full.body.error).toBe("The memory is full: it already holds 100 notes. Delete some old ones first.");
      mockSvc.remove.mockRejectedValueOnce(notFound("That note was not found. It may already have been deleted."));
      expect((await send(app, "DELETE", `${base}/${memoryId}`)).status).toBe(404);
    });

    it("edits, deletes one and clears all", async () => {
      const app = await buildApp(member());
      const edited = await send(app, "PATCH", `${base}/${memoryId}`, { text: "Changed." });
      expect(edited.status).toBe(200);
      expect(mockSvc.update).toHaveBeenCalledWith(companyId, agentId, memoryId, { text: "Changed." }, expect.objectContaining({ via: "page" }));
      expect((await send(app, "DELETE", `${base}/${memoryId}`)).status).toBe(204);
      expect(mockSvc.remove).toHaveBeenCalledWith(companyId, agentId, memoryId, expect.objectContaining({ userId: "filip" }));
      const cleared = await send(app, "DELETE", base);
      expect(cleared.status).toBe(200);
      expect(cleared.body).toEqual({ deleted: 1 });
      expect(mockSvc.clear).toHaveBeenCalledWith(companyId, agentId, expect.objectContaining({ userId: "filip" }));
    });

    it("works for the local single-user board", async () => {
      const local = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: false, companyIds: [], memberships: [] };
      const res = await send(await buildApp(local), "GET", base);
      expect(res.status).toBe(200);
    });
  });
});
