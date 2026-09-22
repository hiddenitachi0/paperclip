// DUR-3997: POST /companies/:companyId/secrets/:id/test -- who may call it,
// that the verdict is recorded without the value, and that a request which
// carries a secret and fails never puts that secret in the HTTP log.
//
// The log assertion drives a real pino-http instance (the same customProps
// the server's logger uses, middleware/http-log-props.ts) into an in-memory
// stream, so what is checked is the line that would have reached server.log.
// Every value here is a random decoy ("canary"); assertions compare booleans
// so a failure never prints one.
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretRoutes } from "../routes/secrets.js";
import { errorHandler } from "../middleware/error-handler.js";
import { httpErrorLogProps } from "../middleware/http-log-props.js";
import { conflict, unprocessable } from "../errors.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const SECRET_ID = "33333333-3333-4333-8333-333333333333";

const mockSecretService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  secretService: () => mockSecretService,
  logActivity: mockLogActivity,
}));

const secretTests = { test: vi.fn() };

const boardMember = {
  type: "board",
  userId: "user-1",
  source: "session",
  companyIds: [COMPANY],
  memberships: [{ companyId: COMPANY, status: "active", membershipRole: "admin" }],
};

function secretRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SECRET_ID,
    companyId: COMPANY,
    key: "openai_api_key",
    name: "OpenAI key",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    kind: "openai_api_key",
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-09-23T00:00:00.000Z"),
    updatedAt: new Date("2026-09-23T00:00:00.000Z"),
    ...overrides,
  };
}

/** An app whose 4xx/5xx log lines land in `lines`, exactly as server.log would get them. */
function createApp(actor: Record<string, unknown> = boardMember) {
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
  app.use("/api", secretRoutes(withFakeCompanyScopeReserve({}) as any, { secretTests: secretTests as any }));
  app.use(errorHandler);
  return { app, lines };
}

async function flushLogs(lines: string[]) {
  // pino writes asynchronously through the sink; give it a tick.
  for (let i = 0; i < 5 && lines.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  return lines.join("\n");
}

describe("POST /companies/:companyId/secrets/:id/test", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockSecretService)) mock.mockReset();
    mockLogActivity.mockReset();
    secretTests.test.mockReset();
  });

  it("lets a board member with company access test, records the verdict and logs it without the sentence", async () => {
    const tested = secretRow({
      lastTestAt: new Date("2026-09-23T10:00:00.000Z"),
      lastTestOk: false,
      lastTestMessage: "OpenAI did not accept this key (Incorrect API key provided).",
    });
    secretTests.test.mockResolvedValue({ ok: false, message: tested.lastTestMessage, secret: tested });

    const { app } = createApp();
    const res = await request(app).post(`/api/companies/${COMPANY}/secrets/${SECRET_ID}/test`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toBe("OpenAI did not accept this key (Incorrect API key provided).");
    expect(res.body.secret.lastTestOk).toBe(false);
    expect(secretTests.test).toHaveBeenCalledWith(COMPANY, SECRET_ID, { userId: "user-1" });

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const entry = mockLogActivity.mock.calls[0][1];
    expect(entry).toMatchObject({
      companyId: COMPANY,
      action: "secret.tested",
      entityType: "secret",
      entityId: SECRET_ID,
      details: { name: "OpenAI key", kind: "openai_api_key", ok: false },
    });
    expect("message" in entry.details).toBe(false);
  });

  it("refuses an agent and a board member of another company before touching the service", async () => {
    const agent = { type: "agent", agentId: "agent-1", companyId: COMPANY };
    const stranger = {
      ...boardMember,
      companyIds: [OTHER_COMPANY],
      memberships: [{ companyId: OTHER_COMPANY, status: "active", membershipRole: "admin" }],
    };
    for (const actor of [agent, stranger]) {
      const { app } = createApp(actor);
      const res = await request(app).post(`/api/companies/${COMPANY}/secrets/${SECRET_ID}/test`);
      expect(res.status).toBe(403);
    }
    expect(secretTests.test).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("passes a 422 from the service through as plain words", async () => {
    secretTests.test.mockRejectedValue(
      unprocessable("Choose what kind of key this is first, then Paperclip can test it.", {
        code: "secret_kind_not_testable",
      }),
    );
    const { app } = createApp();
    const res = await request(app).post(`/api/companies/${COMPANY}/secrets/${SECRET_ID}/test`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("secret_kind_not_testable");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  // The route takes no body, so there is nothing secret to leak from it. The
  // request that DOES carry the value is the one that saves it, and a 409
  // ("name already taken" -- the Add-integration-token dialog retries into
  // this) is an ordinary outcome that the HTTP logger writes with the body.
  it("never writes the secret's value to the HTTP log when saving it fails", async () => {
    const canary = `sk-proj-DUR3997${randomBytes(24).toString("hex")}`;
    mockSecretService.create.mockRejectedValue(conflict("Secret already exists: OpenAI key"));

    const { app, lines } = createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY}/secrets`)
      .send({ name: "OpenAI key", provider: "local_encrypted", value: canary, kind: "openai_api_key" });

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body).includes(canary)).toBe(false);

    const logged = await flushLogs(lines);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).toContain("[REDACTED]");
    expect(logged).toContain('"kind":"openai_api_key"');
    expect(logged.includes(canary)).toBe(false);
  });

  it("never writes a value-shaped test failure to the HTTP log either", async () => {
    // A probe verdict is a 200, never an error, so the logger gets no body
    // and no error context. Belt and braces: even a message that a buggy
    // provider echoed a key into must not appear in the log line.
    const canary = `sk-proj-DUR3997${randomBytes(24).toString("hex")}`;
    secretTests.test.mockResolvedValue({
      ok: false,
      message: "OpenAI did not accept this key ([key]).",
      secret: secretRow({ lastTestOk: false, lastTestMessage: "OpenAI did not accept this key ([key])." }),
    });
    const { app, lines } = createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY}/secrets/${SECRET_ID}/test`)
      .send({ value: canary });
    expect(res.status).toBe(200);
    const logged = await flushLogs(lines);
    expect(logged.includes(canary)).toBe(false);
    expect(JSON.stringify(res.body).includes(canary)).toBe(false);
  });

  it("stores the kind on create and update", async () => {
    mockSecretService.create.mockResolvedValue(secretRow());
    const created = await request(createApp().app)
      .post(`/api/companies/${COMPANY}/secrets`)
      .send({ name: "OpenAI key", provider: "local_encrypted", value: "sk-proj-canary-000000000000", kind: "openai_api_key" });
    expect(created.status).toBe(201);
    expect(mockSecretService.create.mock.calls[0][1]).toMatchObject({ kind: "openai_api_key" });
    expect(mockLogActivity.mock.calls[0][1].details).toEqual({
      name: "OpenAI key",
      provider: "local_encrypted",
      kind: "openai_api_key",
    });

    mockSecretService.getById.mockResolvedValue(secretRow({ kind: null }));
    mockSecretService.update.mockResolvedValue(secretRow({ kind: "openrouter_api_key" }));
    const updated = await request(createApp().app).patch(`/api/secrets/${SECRET_ID}`).send({ kind: "openrouter_api_key" });
    expect(updated.status).toBe(200);
    expect(mockSecretService.update.mock.calls[0][1]).toMatchObject({ kind: "openrouter_api_key" });

    const rejected = await request(createApp().app).patch(`/api/secrets/${SECRET_ID}`).send({ kind: "made_up" });
    expect(rejected.status).toBe(400);
  });
});
