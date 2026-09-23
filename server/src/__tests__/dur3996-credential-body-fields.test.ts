// DUR-3996: two request bodies carried a real credential in a field called
// `token`, which the HTTP logger leaves readable on purpose (a bare `token`
// is a pagination cursor far more often than a credential). Any failed call
// -- wrong role, a typo elsewhere in the body, a database error -- therefore
// wrote a Telegram bot token or a live CLI sign-in secret to server.log, and
// on this server every agent can read that file. The fields are now
// `botToken` and `authToken`, both on the redaction list, and the old
// spelling is moved to the new name before anything on the route can fail.
//
// Same method as secret-test-route.test.ts: a real pino-http instance with
// the server's own customProps (middleware/http-log-props.ts) writes into an
// in-memory stream, and what is checked is the line that would have reached
// server.log. Every credential here is a random decoy ("canary"); assertions
// compare booleans so a failure never prints one.
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { httpErrorLogProps } from "../middleware/http-log-props.js";
import { acceptLegacyBodyField } from "../middleware/legacy-body-field.js";
import { telegramBotRoutes } from "../routes/telegram-bots.js";
import { accessRoutes } from "../routes/access.js";
import { conflict } from "../errors.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const BOT = "33333333-3333-4333-8333-333333333333";

const mockTelegramBotService = vi.hoisted(() => ({
  create: vi.fn(),
  rotateToken: vi.fn(),
}));
const mockBoardAuthService = vi.hoisted(() => ({
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardActivityCompanyIds: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/telegram-bots.js", () => ({
  telegramBotService: () => mockTelegramBotService,
}));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ listCompanyIds: vi.fn(async () => []) }),
}));
vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => ({}),
  boardAuthService: () => mockBoardAuthService,
  deduplicateAgentName: (name: string) => name,
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
}));

const boardMember = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: [COMPANY],
  memberships: [{ companyId: COMPANY, status: "active", membershipRole: "admin" }],
};
const agentActor = { type: "agent", agentId: AGENT, companyId: COMPANY, source: "agent_key", runId: null };
const nobody = { type: "none", source: "none" };

/** Shaped like a BotFather token so it passes the validator when the rest of the body is right. */
function botTokenCanary() {
  return `8100000001:AAH${randomBytes(18).toString("hex")}`;
}
/** Shaped like a challenge secret; 45 chars, inside the 16..256 the validator wants. */
function authTokenCanary() {
  return `pcp_cli_auth_${randomBytes(16).toString("hex")}`;
}

/** An app whose 4xx/5xx log lines land in `lines`, exactly as server.log would get them. */
function createApp(actor: Record<string, unknown>, mount: (app: express.Express) => void) {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = pino({ level: "debug" }, sink);
  const app = express();
  app.use(express.json());
  app.use(
    pinoHttp({
      logger,
      customLogLevel(_req, res, err) {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
      customProps: httpErrorLogProps,
    }),
  );
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  mount(app);
  app.use(errorHandler);
  return { app, lines };
}

function telegramApp(actor: Record<string, unknown>) {
  return createApp(actor, (app) => {
    app.use("/api", telegramBotRoutes(withFakeCompanyScopeReserve({}) as any));
  });
}

function accessApp(actor: Record<string, unknown>) {
  return createApp(actor, (app) => {
    app.use(
      "/api",
      accessRoutes(withFakeCompanyScopeReserve({}) as any, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
  });
}

async function flushLogs(lines: string[]) {
  // pino writes asynchronously through the sink; give it a tick.
  for (let i = 0; i < 5 && lines.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  return lines.join("\n");
}

/** The line was written, the field was blanked, and the canary is nowhere in it. */
function expectRedactedWithout(logged: string, canary: string) {
  expect(logged.length).toBeGreaterThan(0);
  expect(logged).toContain("[REDACTED]");
  expect(logged.includes(canary)).toBe(false);
}

describe("acceptLegacyBodyField", () => {
  function run(body: unknown) {
    const req = { body } as any;
    const next = vi.fn();
    acceptLegacyBodyField("token", "botToken")(req, {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    return req.body;
  }

  it("moves the legacy field to the new name and removes the old one", () => {
    expect(run({ name: "CEO", token: "t" })).toEqual({ name: "CEO", botToken: "t" });
  });

  it("lets the new name win when a client sends both, and still removes the legacy field", () => {
    expect(run({ token: "old", botToken: "new" })).toEqual({ botToken: "new" });
  });

  it("leaves a body without the legacy field, and non-object bodies, alone", () => {
    expect(run({ botToken: "t" })).toEqual({ botToken: "t" });
    expect(run(undefined)).toBeUndefined();
    expect(run("text")).toBe("text");
    expect(run([{ token: "t" }])).toEqual([{ token: "t" }]);
  });
});

describe("Telegram bot token never reaches the HTTP log", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockTelegramBotService)) mock.mockReset();
    mockLogActivity.mockReset();
  });

  for (const field of ["botToken", "token"] as const) {
    it(`when an agent is refused (sent as \`${field}\`)`, async () => {
      const canary = botTokenCanary();
      const { app, lines } = telegramApp(agentActor);
      const res = await request(app)
        .post(`/api/companies/${COMPANY}/telegram-bots`)
        .send({ agentId: AGENT, name: "CEO", [field]: canary });

      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body).includes(canary)).toBe(false);
      expectRedactedWithout(await flushLogs(lines), canary);
      expect(mockTelegramBotService.create).not.toHaveBeenCalled();
    });

    it(`when the rest of the body is wrong (sent as \`${field}\`)`, async () => {
      const canary = botTokenCanary();
      const { app, lines } = telegramApp(boardMember);
      const res = await request(app)
        .post(`/api/companies/${COMPANY}/telegram-bots`)
        .send({ agentId: "not-an-agent-id", name: "CEO", [field]: canary });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body).includes(canary)).toBe(false);
      expectRedactedWithout(await flushLogs(lines), canary);
      expect(mockTelegramBotService.create).not.toHaveBeenCalled();
    });

    it(`when re-keying fails on the server (sent as \`${field}\`)`, async () => {
      // A thrown Error is the 500 path: the error handler snapshots the body
      // into the log line's errorContext, which is the other copy to check.
      const canary = botTokenCanary();
      mockTelegramBotService.rotateToken.mockRejectedValue(new Error("database is on fire"));
      const { app, lines } = telegramApp(boardMember);
      const res = await request(app)
        .post(`/api/companies/${COMPANY}/telegram-bots/${BOT}/token`)
        .send({ [field]: canary });

      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body).includes(canary)).toBe(false);
      expectRedactedWithout(await flushLogs(lines), canary);
    });
  }

  it("still accepts the old `token` spelling and hands the service the same value", async () => {
    const canary = botTokenCanary();
    mockTelegramBotService.create.mockResolvedValue({ id: BOT, name: "CEO", agentId: AGENT });
    const { app, lines } = telegramApp(boardMember);
    const res = await request(app)
      .post(`/api/companies/${COMPANY}/telegram-bots`)
      .send({ agentId: AGENT, name: "CEO", token: canary });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockTelegramBotService.create).toHaveBeenCalledTimes(1);
    const input = mockTelegramBotService.create.mock.calls[0][1];
    expect(input.token === canary).toBe(true);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogActivity.mock.calls[0][1]).includes(canary)).toBe(false);
    expect((await flushLogs(lines)).includes(canary)).toBe(false);
  });
});

describe("CLI sign-in secret never reaches the HTTP log", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockBoardAuthService)) mock.mockReset();
    mockLogActivity.mockReset();
  });

  for (const field of ["authToken", "token"] as const) {
    it(`when nobody is signed in (sent as \`${field}\`)`, async () => {
      // The most likely failure: the approval link opened in a browser that
      // is not signed in. The secret in this body is LIVE -- whoever reads
      // the log line could approve the sign-in themselves.
      const canary = authTokenCanary();
      const { app, lines } = accessApp(nobody);
      const res = await request(app)
        .post("/api/cli-auth/challenges/challenge-1/approve")
        .send({ [field]: canary });

      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body).includes(canary)).toBe(false);
      expectRedactedWithout(await flushLogs(lines), canary);
      expect(mockBoardAuthService.approveCliAuthChallenge).not.toHaveBeenCalled();
    });

    it(`when the challenge can no longer be approved (sent as \`${field}\`)`, async () => {
      const canary = authTokenCanary();
      mockBoardAuthService.approveCliAuthChallenge.mockRejectedValue(
        conflict("CLI auth challenge is no longer pending"),
      );
      const { app, lines } = accessApp(boardMember);
      const res = await request(app)
        .post("/api/cli-auth/challenges/challenge-1/approve")
        .send({ [field]: canary });

      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body).includes(canary)).toBe(false);
      expectRedactedWithout(await flushLogs(lines), canary);
    });

    it(`when cancelling fails on the server (sent as \`${field}\`)`, async () => {
      const canary = authTokenCanary();
      mockBoardAuthService.cancelCliAuthChallenge.mockRejectedValue(new Error("database is on fire"));
      const { app, lines } = accessApp(nobody);
      const res = await request(app)
        .post("/api/cli-auth/challenges/challenge-1/cancel")
        .send({ [field]: canary });

      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body).includes(canary)).toBe(false);
      expectRedactedWithout(await flushLogs(lines), canary);
    });

    it(`when the value is the wrong shape (sent as \`${field}\`)`, async () => {
      const canary = `${authTokenCanary()}${randomBytes(120).toString("hex")}`; // > 256 chars
      const { app, lines } = accessApp(boardMember);
      const res = await request(app)
        .post("/api/cli-auth/challenges/challenge-1/approve")
        .send({ [field]: canary });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body).includes(canary)).toBe(false);
      expectRedactedWithout(await flushLogs(lines), canary);
      expect(mockBoardAuthService.approveCliAuthChallenge).not.toHaveBeenCalled();
    });
  }

  it("still accepts the old `token` spelling on approve and cancel", async () => {
    const canary = authTokenCanary();
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      challenge: {
        id: "challenge-1",
        boardApiKeyId: "board-key-1",
        requestedAccess: "board",
        requestedCompanyId: COMPANY,
        expiresAt: new Date("2026-09-23T13:00:00.000Z"),
      },
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([COMPANY]);
    mockBoardAuthService.cancelCliAuthChallenge.mockResolvedValue({ status: "cancelled" });

    const approved = await request(accessApp(boardMember).app)
      .post("/api/cli-auth/challenges/challenge-1/approve")
      .send({ token: canary });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.approved).toBe(true);
    expect(mockBoardAuthService.approveCliAuthChallenge).toHaveBeenCalledTimes(1);
    expect(mockBoardAuthService.approveCliAuthChallenge.mock.calls[0][1] === canary).toBe(true);
    expect(mockBoardAuthService.approveCliAuthChallenge.mock.calls[0][2]).toBe("user-1");

    const cancelled = await request(accessApp(nobody).app)
      .post("/api/cli-auth/challenges/challenge-1/cancel")
      .send({ token: canary });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.cancelled).toBe(true);
    expect(mockBoardAuthService.cancelCliAuthChallenge.mock.calls[0][1] === canary).toBe(true);
  });
});
