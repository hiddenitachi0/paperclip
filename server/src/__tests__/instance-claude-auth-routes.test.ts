// One-click Claude sign-in routes: who may read/change the instance-wide
// sign-in, that responses never carry a token, and the status codes the
// OpenAPI document promises.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { instanceClaudeAuthRoutes } from "../routes/instance-claude-auth.js";
import { HttpError } from "../errors.js";

const TOKEN = `sk-ant-oat01-${"Route123".repeat(10)}-AA`;

const status = {
  configured: true,
  health: "ok",
  headline: "Signed in.",
  fingerprint: "abcdef012345",
  source: "pasted",
  savedAt: "2026-09-07T10:00:00.000Z",
  savedByUserId: "user-1",
  expiresAt: "2027-09-07T10:00:00.000Z",
  expiresInDays: 365,
  lastCheckAt: "2026-09-07T10:00:00.000Z",
  lastCheckOk: true,
  lastCheckMessage: "Claude answered. This token works.",
  lastUsedAt: null,
  lastAuthFailureAt: null,
  cli: { command: "claude", version: "2.1.263 (Claude Code)" },
  automaticSignIn: { supported: true, reason: null },
  activeSignIn: null,
};

const session = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "awaiting_code",
  loginUrl: "https://claude.com/cai/oauth/authorize?x=1",
  message: "Open the link.",
  startedAt: "2026-09-07T10:00:00.000Z",
  updatedAt: "2026-09-07T10:00:00.000Z",
};

const service = {
  getStatus: vi.fn(),
  saveToken: vi.fn(),
  checkNow: vi.fn(),
  clear: vi.fn(),
  resolveFallbackToken: vi.fn(),
  markAuthFailure: vi.fn(),
  startInteractiveSignIn: vi.fn(),
  getSignIn: vi.fn(),
  submitSignInCode: vi.fn(),
  cancelSignIn: vi.fn(),
};

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ listCompanyIds: async () => [] }),
}));
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => {}),
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
  app.use("/api", instanceClaudeAuthRoutes({} as any, { service: service as any }));
  app.use(errorHandler);
  return app;
}

describe("instance Claude auth routes", () => {
  beforeEach(() => {
    for (const fn of Object.values(service)) fn.mockReset();
    service.getStatus.mockResolvedValue(status);
    service.saveToken.mockResolvedValue(status);
    service.checkNow.mockResolvedValue(status);
    service.clear.mockResolvedValue({ ...status, configured: false, health: "not_configured" });
    service.startInteractiveSignIn.mockReturnValue({ ...session, status: "starting", loginUrl: null });
    service.getSignIn.mockReturnValue(session);
    service.submitSignInCode.mockReturnValue({ ...session, status: "exchanging" });
    service.cancelSignIn.mockReturnValue({ ...session, status: "cancelled" });
  });

  it("lets any org member read the status, but never an agent", async () => {
    const res = await request(createApp(member)).get("/api/instance/claude-auth");
    expect(res.status).toBe(200);
    expect(res.body.health).toBe("ok");
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);

    const denied = await request(createApp(agent)).get("/api/instance/claude-auth");
    expect(denied.status).toBe(403);
  });

  it("only an instance admin may save, check, remove, or sign in", async () => {
    const app = createApp(member);
    expect((await request(app).post("/api/instance/claude-auth/token").send({ token: TOKEN })).status).toBe(403);
    expect((await request(app).post("/api/instance/claude-auth/check")).status).toBe(403);
    expect((await request(app).delete("/api/instance/claude-auth")).status).toBe(403);
    expect((await request(app).post("/api/instance/claude-auth/sign-in")).status).toBe(403);
    expect(service.saveToken).not.toHaveBeenCalled();
    expect(service.startInteractiveSignIn).not.toHaveBeenCalled();
  });

  it("saves a pasted token through the service with the acting user, after validation", async () => {
    const app = createApp(admin);
    const bad = await request(app).post("/api/instance/claude-auth/token").send({ token: "sk-ant-api03-wrong-kind" });
    expect(bad.status).toBe(400);
    expect(service.saveToken).not.toHaveBeenCalled();

    const ok = await request(app).post("/api/instance/claude-auth/token").send({ token: `  ${TOKEN}  ` });
    expect(ok.status).toBe(200);
    expect(service.saveToken).toHaveBeenCalledWith({ token: TOKEN, source: "pasted", userId: "user-1" });
    expect(JSON.stringify(ok.body)).not.toContain(TOKEN);
  });

  it("surfaces a rejected token as 422 with the service's plain-language message", async () => {
    service.saveToken.mockRejectedValue(new HttpError(422, "Claude rejected this token. Sign in again."));
    const res = await request(createApp(admin)).post("/api/instance/claude-auth/token").send({ token: TOKEN });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/rejected this token/);
  });

  it("check and remove go through the service", async () => {
    const app = createApp(admin);
    expect((await request(app).post("/api/instance/claude-auth/check")).status).toBe(200);
    expect(service.checkNow).toHaveBeenCalledTimes(1);
    const removed = await request(app).delete("/api/instance/claude-auth");
    expect(removed.status).toBe(200);
    expect(removed.body.configured).toBe(false);
  });

  it("interactive sign-in: 201 on start, poll, code, cancel", async () => {
    const app = createApp(admin);
    const started = await request(app).post("/api/instance/claude-auth/sign-in");
    expect(started.status).toBe(201);
    expect(service.startInteractiveSignIn).toHaveBeenCalledWith({ userId: "user-1" });

    const polled = await request(app).get(`/api/instance/claude-auth/sign-in/${session.id}`);
    expect(polled.status).toBe(200);
    expect(polled.body.loginUrl).toBe(session.loginUrl);

    const badCode = await request(app).post(`/api/instance/claude-auth/sign-in/${session.id}/code`).send({ code: "has space" });
    expect(badCode.status).toBe(400);
    expect(service.submitSignInCode).not.toHaveBeenCalled();

    const code = await request(app).post(`/api/instance/claude-auth/sign-in/${session.id}/code`).send({ code: " abc#def " });
    expect(code.status).toBe(200);
    expect(service.submitSignInCode).toHaveBeenCalledWith(session.id, "abc#def");
    expect(code.body.status).toBe("exchanging");

    const cancelled = await request(app).post(`/api/instance/claude-auth/sign-in/${session.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
  });
});
