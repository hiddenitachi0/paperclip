// DUR-3995: who may read or change Paperclip's own Claude key, that no
// response ever carries the key, and the status codes the OpenAPI document
// promises.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { instanceServerAnthropicKeyRoutes } from "../routes/instance-server-anthropic-key.js";

const KEY = `sk-ant-api03-${"RouteKey".repeat(6)}AA`;

const status = {
  configured: true,
  source: "stored",
  headline: "Paperclip has its own Claude key and Claude accepted it.",
  hint: "…ceAA",
  fingerprint: "0123456789ab",
  savedAt: "2026-09-22T10:00:00.000Z",
  savedByUserId: "user-1",
  lastTestAt: "2026-09-22T10:00:00.000Z",
  lastTestOk: true,
  lastTestMessage: "Claude answered. This key works.",
};

const service = {
  getStatus: vi.fn(),
  save: vi.fn(),
  test: vi.fn(),
  remove: vi.fn(),
};

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ listCompanyIds: async () => ["company-1"] }),
}));
const logActivity = vi.fn(async () => {});
vi.mock("../services/activity-log.js", () => ({
  logActivity: (...args: unknown[]) => logActivity(...(args as [])),
}));

const admin = { type: "board", source: "session", isInstanceAdmin: true, userId: "user-1", companyIds: ["c1"] };
const member = { type: "board", source: "session", isInstanceAdmin: false, userId: "user-2", companyIds: ["c1"] };
const agent = { type: "agent", agentId: "agent-1", companyId: "c1" };

function createApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", instanceServerAnthropicKeyRoutes({} as any, { service: service as any }));
  app.use(errorHandler);
  return app;
}

describe("instance server Anthropic key routes", () => {
  beforeEach(() => {
    for (const fn of Object.values(service)) fn.mockReset();
    logActivity.mockClear();
    service.getStatus.mockResolvedValue(status);
    service.save.mockResolvedValue({ ok: true, message: "Claude answered. This key works.", status });
    service.test.mockResolvedValue({ ok: true, message: "Claude answered. This key works.", status });
    service.remove.mockResolvedValue({ ...status, configured: false, source: null, hint: null });
  });

  it("lets an instance admin read the status, and never returns the key", async () => {
    const res = await request(createApp(admin)).get("/api/instance/server-anthropic-key");
    expect(res.status).toBe(200);
    expect(res.body.hint).toBe("…ceAA");
    expect(JSON.stringify(res.body).includes(KEY)).toBe(false);
  });

  it("refuses an ordinary member and an agent on every route", async () => {
    for (const actor of [member, agent]) {
      const app = createApp(actor);
      expect((await request(app).get("/api/instance/server-anthropic-key")).status).toBe(403);
      expect((await request(app).put("/api/instance/server-anthropic-key").send({ apiKey: KEY })).status).toBe(403);
      expect((await request(app).post("/api/instance/server-anthropic-key/test")).status).toBe(403);
      expect((await request(app).delete("/api/instance/server-anthropic-key")).status).toBe(403);
    }
    expect(service.save).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it("saves a pasted key and records the change without the key", async () => {
    const res = await request(createApp(admin)).put("/api/instance/server-anthropic-key").send({ apiKey: KEY });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(JSON.stringify(res.body).includes(KEY)).toBe(false);
    expect(service.save).toHaveBeenCalledWith({ key: KEY, userId: "user-1" });

    expect(logActivity).toHaveBeenCalledTimes(1);
    const details = (logActivity.mock.calls[0] as any[])[1];
    expect(details.action).toBe("instance.server_anthropic_key.saved");
    expect(JSON.stringify(details).includes(KEY)).toBe(false);
  });

  it("refuses a key that is not shaped like a Claude API key", async () => {
    const res = await request(createApp(admin))
      .put("/api/instance/server-anthropic-key")
      .send({ apiKey: "not a key" });
    expect(res.status).toBe(400);
    expect(service.save).not.toHaveBeenCalled();
  });

  it("tests and removes the key", async () => {
    const app = createApp(admin);
    const tested = await request(app).post("/api/instance/server-anthropic-key/test");
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(true);

    const removed = await request(app).delete("/api/instance/server-anthropic-key");
    expect(removed.status).toBe(200);
    expect(removed.body.configured).toBe(false);
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect((logActivity.mock.calls[0] as any[])[1].action).toBe("instance.server_anthropic_key.removed");
  });
  // DUR-3995 review finding 2: in `local_trusted` deployment mode an
  // unauthenticated local request counts as an implicit instance admin, and
  // agents run on this host. They may read the status, but must not be able to
  // swap in their own key or delete the owner's.
  it("refuses the implicit local admin on every write route but allows the read", async () => {
    const localImplicit = {
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: true,
      userId: null,
      companyIds: ["c1"],
    };
    const app = createApp(localImplicit);

    expect((await request(app).get("/api/instance/server-anthropic-key")).status).toBe(200);
    expect((await request(app).put("/api/instance/server-anthropic-key").send({ apiKey: KEY })).status).toBe(403);
    expect((await request(app).post("/api/instance/server-anthropic-key/test")).status).toBe(403);
    expect((await request(app).delete("/api/instance/server-anthropic-key")).status).toBe(403);
    expect(service.save).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  // The body must never reach the validator (and therefore the error path,
  // which logs it) for someone who is not allowed to save at all.
  it("checks admin before it looks at the body", async () => {
    const res = await request(createApp(member))
      .put("/api/instance/server-anthropic-key")
      .send({ apiKey: "not a key" });

    expect(res.status).toBe(403);
    expect(service.save).not.toHaveBeenCalled();
  });
});
