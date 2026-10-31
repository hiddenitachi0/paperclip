import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import * as speakeasy from "speakeasy";
import { like, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  authSessions,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  userTotpSecrets,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pendingSessionAuthGuard, twoFactorGate, TWO_FACTOR_PENDING_TTL_MS } from "../auth/two-factor-gate.js";
import { createCodeAttemptLimiter, twoFactorRoutes } from "../routes/two-factor.js";
import { sealTotpEnrollment, openTotpEnrollment } from "../services/totp-enrollment-token.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping two-factor-routes test: ${support.reason ?? "unsupported environment"}`);
}

const ORIGIN = "http://localhost:3100";

/**
 * A TOTP code for the step `offset` steps from now. Each accepted use must be a later step than the last.
 * The server accepts +/-2 steps, so the oldest offset used here (-2) is exactly on the edge of the window:
 * the route suite freezes `Date` (see `freezeClockMidStep`) so the test and the server read one instant.
 */
function codeAt(secret: string, offset: number) {
  return speakeasy.totp({
    secret,
    encoding: "base32",
    step: 30,
    time: Math.floor(Date.now() / 1000) + offset * 30,
  });
}

const TOTP_STEP_MS = 30_000;

/** Freezes `Date` at the middle of the current 30s step, so no code can cross a step boundary mid-test. */
function freezeClockMidStep() {
  const stepStart = Math.floor(Date.now() / TOTP_STEP_MS) * TOTP_STEP_MS;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(stepStart + TOTP_STEP_MS / 2);
}

describe("createCodeAttemptLimiter", () => {
  it("allows up to max attempts per window, then reports seconds to wait, then resets", () => {
    let t = 1_000_000;
    const limiter = createCodeAttemptLimiter({ max: 3, windowMs: 60_000, now: () => t });
    expect(limiter.take("u")).toBeNull();
    expect(limiter.take("u")).toBeNull();
    expect(limiter.take("u")).toBeNull();
    expect(limiter.take("u")).toBe(60);
    expect(limiter.take("other")).toBeNull();
    t += 61_000;
    expect(limiter.take("u")).toBeNull();
  });
});

describe("totp enrollment token", () => {
  it("round-trips for the same user+session and rejects anyone else, expiry and tampering", async () => {
    const state = { secret: "JBSWY3DPEHPK3PXP", recoveryCodes: ["AAAA-BBBB"] };
    const token = await sealTotpEnrollment({ ...state, userId: "u1", sessionId: "s1" });
    expect(token).not.toContain(state.secret);
    expect(await openTotpEnrollment(token, { userId: "u1", sessionId: "s1" })).toEqual(state);
    expect(await openTotpEnrollment(token, { userId: "u2", sessionId: "s1" })).toBeNull();
    expect(await openTotpEnrollment(token, { userId: "u1", sessionId: "s2" })).toBeNull();
    expect(await openTotpEnrollment(token, { userId: "u1", sessionId: "s1" }, Date.now() + 11 * 60_000)).toBeNull();
    expect(await openTotpEnrollment(`${token.slice(0, -4)}AAAA`, { userId: "u1", sessionId: "s1" })).toBeNull();
    expect(await openTotpEnrollment("garbage", { userId: "u1", sessionId: "s1" })).toBeNull();
  });
});

d("board two-factor routes (embedded Postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-two-factor-routes-");
    db = createDb(tempDb.connectionString);
    freezeClockMidStep();
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "2FA Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    await tempDb?.cleanup();
  });

  async function newUser(label: string) {
    const userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: label,
      email: `${label}-${userId.slice(0, 6)}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    return userId;
  }

  async function newSession(userId: string, createdAt = new Date()) {
    const id = `sess_${randomUUID()}`;
    await db.insert(authSessions).values({
      id,
      userId,
      token: `tok_${randomUUID()}`,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    return id;
  }

  function buildApp(enabled: boolean) {
    const gate = twoFactorGate(db, { enabled });
    // Stand-in for better-auth: the session id comes from a header.
    const base = async (req: express.Request) => {
      const sessionId = req.header("x-test-session");
      if (!sessionId) return null;
      const row = await db
        .select({ userId: authSessions.userId, email: authUsers.email, name: authUsers.name })
        .from(authSessions)
        .innerJoin(authUsers, eq(authUsers.id, authSessions.userId))
        .where(eq(authSessions.id, sessionId))
        .then((r) => r[0] ?? null);
      if (!row) return null;
      return {
        session: { id: sessionId, userId: row.userId },
        user: { id: row.userId, email: row.email, name: row.name },
      };
    };
    const app = express();
    app.use(express.json());
    const resolveSession = gate.wrapRequestResolver(base);
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession }));
    app.use("/api/auth/2fa", twoFactorRoutes(db, { enabled }));
    // Stand-in for better-auth's own endpoints (list-sessions, change-password, ...),
    // which read the cookie themselves: reachable for any request that gets past the guard.
    app.all("/api/auth/{*authPath}", pendingSessionAuthGuard({ enabled, resolveSession }), (_req, res) => {
      res.json({ reached: true });
    });
    // A stand-in board route: reachable only as a full board session.
    app.get("/api/board-only", (req, res) => {
      if (req.actor.type !== "board") {
        res.status(401).json({ error: "Board authentication required" });
        return;
      }
      res.json({ userId: req.actor.userId });
    });
    app.use(errorHandler);
    return app;
  }

  const post = (app: express.Express, path: string, sessionId: string | null, body: unknown = {}) => {
    const r = request(app).post(path).set("Origin", ORIGIN);
    if (sessionId) r.set("x-test-session", sessionId);
    return r.send(body as object);
  };
  const get = (app: express.Express, path: string, sessionId: string | null) => {
    const r = request(app).get(path);
    if (sessionId) r.set("x-test-session", sessionId);
    return r;
  };

  /** Enrols the user through the routes; returns the secret, recovery codes and the enrolling session. */
  async function enrol(app: express.Express, userId: string) {
    const sessionId = await newSession(userId);
    const start = await post(app, "/api/auth/2fa/enroll/start", sessionId);
    expect(start.status).toBe(200);
    const { enrollmentToken, secret, recoveryCodes } = start.body as {
      enrollmentToken: string;
      secret: string;
      recoveryCodes: string[];
    };
    const done = await post(app, "/api/auth/2fa/enroll/verify", sessionId, {
      enrollmentToken,
      totpCode: codeAt(secret, -2),
    });
    expect(done.status).toBe(200);
    return { sessionId, secret, recoveryCodes, otpauthUri: start.body.otpauthUri as string };
  }

  it("flag off: every 2FA route is a 404 and sign-in is unchanged", async () => {
    const app = buildApp(false);
    const userId = await newUser("flagoff");
    const sessionId = await newSession(userId);
    for (const [method, path] of [
      ["get", "/api/auth/2fa/status"],
      ["post", "/api/auth/2fa/enroll/start"],
      ["post", "/api/auth/2fa/enroll/verify"],
      ["post", "/api/auth/2fa/login/verify"],
      ["post", "/api/auth/2fa/disable"],
      ["post", "/api/auth/2fa/recovery-codes/regenerate"],
    ] as const) {
      const res = method === "get" ? await get(app, path, sessionId) : await post(app, path, sessionId, {});
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const board = await get(app, "/api/board-only", sessionId);
    expect(board.status).toBe(200);
    // Even a user who has a second factor on file is not challenged while the flag is off.
    const enabledApp = buildApp(true);
    const { sessionId: other } = await enrol(enabledApp, await newUser("flagoff2"));
    expect((await get(app, "/api/board-only", other)).status).toBe(200);
  });

  it("enrols without leaking the secret anywhere but the one start response", async () => {
    const app = buildApp(true);
    const userId = await newUser("enrol");
    const { sessionId, secret, recoveryCodes, otpauthUri } = await enrol(app, userId);
    expect(otpauthUri).toContain("otpauth://");

    const status = await get(app, "/api/auth/2fa/status", sessionId);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enabled: true, verificationRequired: false, recoveryCodesRemaining: 10 });
    const text = JSON.stringify(status.body);
    expect(text).not.toContain(secret);
    for (const code of recoveryCodes) expect(text).not.toContain(code);

    // The enrolling session is already verified; the secret is sealed at rest.
    expect((await get(app, "/api/board-only", sessionId)).status).toBe(200);
    const stored = await db.select().from(userTotpSecrets).where(eq(userTotpSecrets.userId, userId));
    expect(stored[0].secret).not.toContain(secret);

    // Starting again while enabled is refused.
    expect((await post(app, "/api/auth/2fa/enroll/start", sessionId)).status).toBe(409);
  });

  it("enrolment: a wrong code or a token from another session does not turn 2FA on", async () => {
    const app = buildApp(true);
    const userId = await newUser("enrolbad");
    const sessionId = await newSession(userId);
    const start = await post(app, "/api/auth/2fa/enroll/start", sessionId);
    const { enrollmentToken, secret } = start.body as { enrollmentToken: string; secret: string };

    const wrong = await post(app, "/api/auth/2fa/enroll/verify", sessionId, { enrollmentToken, totpCode: "000000" });
    expect(wrong.status).toBe(401);

    const otherSession = await newSession(userId);
    const stolen = await post(app, "/api/auth/2fa/enroll/verify", otherSession, {
      enrollmentToken,
      totpCode: codeAt(secret, -2),
    });
    expect(stolen.status).toBe(400);

    const forged = await post(app, "/api/auth/2fa/enroll/verify", sessionId, {
      enrollmentToken: "tfe1.eyJmb28iOiJiYXIifQ",
      totpCode: codeAt(secret, -2),
    });
    expect(forged.status).toBe(400);

    expect((await get(app, "/api/auth/2fa/status", sessionId)).body.enabled).toBe(false);
  });

  it("login: a password-only session is pending and cannot reach any board route", async () => {
    const app = buildApp(true);
    const userId = await newUser("pending");
    const { secret } = await enrol(app, userId);
    const fresh = await newSession(userId);

    expect((await get(app, "/api/board-only", fresh)).status).toBe(401);
    const status = await get(app, "/api/auth/2fa/status", fresh);
    expect(status.body).toMatchObject({ enabled: true, verificationRequired: true });

    // A pending session cannot change 2FA settings either.
    for (const path of ["/api/auth/2fa/enroll/start", "/api/auth/2fa/disable", "/api/auth/2fa/recovery-codes/regenerate"]) {
      const res = await post(app, path, fresh, { totpCode: codeAt(secret, -1) });
      expect(res.status, path).toBe(403);
    }
    expect((await get(app, "/api/board-only", fresh)).status).toBe(401);

    const ok = await post(app, "/api/auth/2fa/login/verify", fresh, { totpCode: codeAt(secret, -1) });
    expect(ok.status).toBe(200);
    expect(ok.body.verified).toBe(true);
    expect((await get(app, "/api/board-only", fresh)).status).toBe(200);

    // The same code cannot be used again on another session (replay protection).
    const second = await newSession(userId);
    const replay = await post(app, "/api/auth/2fa/login/verify", second, { totpCode: codeAt(secret, -1) });
    expect(replay.status).toBe(401);
    expect((await get(app, "/api/board-only", second)).status).toBe(401);
  });

  it("login: a pending session cannot use better-auth's own account endpoints, even with an Authorization header", async () => {
    const app = buildApp(true);
    const userId = await newUser("pending-betterauth");
    const { sessionId: verified, secret } = await enrol(app, userId);
    const pending = await newSession(userId);

    for (const path of ["/api/auth/list-sessions", "/api/auth/change-password", "/api/auth/revoke-sessions", "/api/auth/revoke-session", "/api/auth/update-user"]) {
      expect((await post(app, path, pending, {})).status, path).toBe(403);
      // actorMiddleware skips session resolution when a Bearer header is present; the guard must not.
      const withBearer = await post(app, path, pending, {}).set("Authorization", "Bearer junk");
      expect(withBearer.status, `${path} with bearer`).toBe(403);
      expect((await post(app, path, verified, {})).status, `${path} verified`).toBe(200);
    }
    // Sign-in, sign-out and the session probe still work for a pending session.
    expect((await post(app, "/api/auth/sign-out", pending, {})).status).toBe(200);
    expect((await post(app, "/api/auth/sign-in/email", pending, {})).status).toBe(200);
    expect((await get(app, "/api/auth/get-session", pending)).status).toBe(200);
    // And a request with no session at all is untouched (sign-in is how you get one).
    expect((await post(app, "/api/auth/sign-in/email", null, {})).status).toBe(200);

    // Once the second factor passes, the same session reaches them.
    expect((await post(app, "/api/auth/2fa/login/verify", pending, { totpCode: codeAt(secret, -1) })).status).toBe(200);
    expect((await post(app, "/api/auth/list-sessions", pending, {})).status).toBe(200);
  });

  it("login: a dot-segment path cannot walk a pending session out of the sign-in allowlist", async () => {
    const app = buildApp(true);
    const userId = await newUser("pending-dotseg");
    const { sessionId: verified } = await enrol(app, userId);
    const pending = await newSession(userId);

    // supertest normalises the path, so send it exactly as written over a raw socket.
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const raw = (method: string, path: string, sessionId: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, method, path, headers: { "x-test-session": sessionId, origin: ORIGIN, "content-length": 0 } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      const paths = [
        "/api/auth/sign-in/%2e%2e/list-sessions",
        "/api/auth/sign-in/%2E%2E/change-password",
        "/api/auth/sign-in/../list-sessions",
        "/api/auth/sign-up/%2E%2E/revoke-sessions",
        "/api/auth/sign-up/../update-user",
        "/api/auth/sign-in/email/../../change-password",
        "/api/auth/sign-in%2f..%2flist-sessions",
        "/api/auth/sign-in\\..\\list-sessions",
        "/api/auth/sign-in/email/extra",
        "/api/auth/sign-in/anything-else",
      ];
      for (const path of paths) {
        expect(await raw("POST", path, pending), `pending ${path}`).toBe(403);
      }
      // The same walk-out is not blocked for a session that passed its second factor, and the real paths still work.
      expect(await raw("POST", "/api/auth/sign-in/email", pending)).toBe(200);
      expect(await raw("POST", "/api/auth/sign-out?x=1", pending)).toBe(200);
      expect(await raw("POST", "/api/auth/sign-in/%2e%2e/list-sessions", verified)).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("login: client-supplied Host / X-Forwarded-Proto cannot make better-auth route on a different path", async () => {
    const app = buildApp(true);
    const userId = await newUser("pending-hdr");
    const { sessionId: verified } = await enrol(app, userId);
    const pending = await newSession(userId);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const raw = (method: string, path: string, sessionId: string, headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, method, path, headers: { "x-test-session": sessionId, origin: ORIGIN, "content-length": 0, ...headers } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      for (const target of ["list-sessions", "change-password", "revoke-sessions", "update-user"]) {
        const viaProto = { "x-forwarded-proto": `http://localhost:3100/api/auth/${target}?` };
        const viaHost = { host: `localhost:3100/api/auth/${target}?` };
        expect(await raw("GET", "/api/auth/sign-in/email", pending, viaProto), `proto ${target}`).toBe(403);
        expect(await raw("POST", "/api/auth/sign-in/email", pending, viaProto), `proto POST ${target}`).toBe(403);
        expect(await raw("GET", "/api/auth/get-session", pending, viaHost), `host ${target}`).toBe(403);
        expect(await raw("POST", "/api/auth/get-session", pending, viaHost), `host POST ${target}`).toBe(403);
      }
      for (const host of ["localhost:3100/x?", "a b", "user@host", "host#frag", "host:99999999"]) {
        expect(await raw("GET", "/api/auth/get-session", pending, { host }), `host ${JSON.stringify(host)}`).toBe(403);
      }
      for (const proto of ["https://x/?", "ftp", "https, http", "javascript:"]) {
        expect(await raw("GET", "/api/auth/get-session", pending, { "x-forwarded-proto": proto }), `proto ${proto}`).toBe(403);
      }
      // Ordinary traffic is untouched: a bare scheme from a proxy, a host:port, an IPv4 and a bracketed IPv6 Host.
      expect(await raw("GET", "/api/auth/get-session", pending, { "x-forwarded-proto": "https", host: "app.example.test" })).toBe(200);
      expect(await raw("GET", "/api/auth/get-session", pending, { host: "localhost:3100" })).toBe(200);
      expect(await raw("GET", "/api/auth/get-session", pending, { host: "10.0.0.5:3100" })).toBe(200);
      expect(await raw("GET", "/api/auth/get-session", pending, { host: "[::1]:3100" })).toBe(200);
      expect(await raw("POST", "/api/auth/list-sessions", verified, { host: "localhost:3100" })).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("login: a session the gate cannot classify is refused at better-auth's endpoints too", async () => {
    // A db that throws on every query stands in for "the database hiccuped at the wrong moment".
    const brokenGate = twoFactorGate({} as never, { enabled: true });
    const resolveSession = brokenGate.wrapRequestResolver(async () => ({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "u@example.test", name: "U" },
    }) as never);
    const app = express();
    app.all("/api/auth/{*authPath}", pendingSessionAuthGuard({ enabled: true, resolveSession }), (_req, res) => {
      res.json({ reached: true });
    });
    expect((await request(app).post("/api/auth/list-sessions")).status).toBe(403);
    expect((await request(app).post("/api/auth/change-password")).status).toBe(403);
    // The allowlisted paths stay reachable so the person can still sign in and out.
    expect((await request(app).post("/api/auth/sign-in/email")).status).toBe(200);
    expect((await request(app).post("/api/auth/sign-out")).status).toBe(200);
  });

  it("login: no session at all gets 401, and the response for a wrong code never says what was wrong", async () => {
    const app = buildApp(true);
    expect((await post(app, "/api/auth/2fa/login/verify", null, { totpCode: "123456" })).status).toBe(401);
    const userId = await newUser("wrongcode");
    await enrol(app, userId);
    const fresh = await newSession(userId);
    const bad = await post(app, "/api/auth/2fa/login/verify", fresh, { totpCode: "000000" });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: "Invalid verification code", code: "two_factor_invalid_code", details: { code: "two_factor_invalid_code" } });
    const badRecovery = await post(app, "/api/auth/2fa/login/verify", fresh, { totpCode: "ZZZZ-ZZZZ", isRecoveryCode: true });
    expect(badRecovery.status).toBe(401);
    expect(badRecovery.body).toEqual(bad.body);
  });

  it("login: repeated failures lock the factor (429 + Retry-After), including for the right code", async () => {
    const app = buildApp(true);
    const userId = await newUser("lockout");
    const { secret } = await enrol(app, userId);
    const fresh = await newSession(userId);
    for (let i = 0; i < 5; i += 1) {
      expect((await post(app, "/api/auth/2fa/login/verify", fresh, { totpCode: "000000" })).status).toBe(401);
    }
    const locked = await post(app, "/api/auth/2fa/login/verify", fresh, { totpCode: codeAt(secret, -1) });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await get(app, "/api/board-only", fresh)).status).toBe(401);
  });

  it("login: the pending window expires", async () => {
    const app = buildApp(true);
    const userId = await newUser("expiry");
    const { secret } = await enrol(app, userId);
    const stale = await newSession(userId, new Date(Date.now() - TWO_FACTOR_PENDING_TTL_MS - 5_000));
    const res = await post(app, "/api/auth/2fa/login/verify", stale, { totpCode: codeAt(secret, -1) });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("two_factor_pending_expired");
    expect((await get(app, "/api/board-only", stale)).status).toBe(401);
  });

  it("login: a recovery code works exactly once", async () => {
    const app = buildApp(true);
    const userId = await newUser("recovery");
    const { recoveryCodes } = await enrol(app, userId);
    const first = await newSession(userId);
    const ok = await post(app, "/api/auth/2fa/login/verify", first, { totpCode: recoveryCodes[0].toLowerCase(), isRecoveryCode: true });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodesRemaining).toBe(9);
    const second = await newSession(userId);
    const again = await post(app, "/api/auth/2fa/login/verify", second, { totpCode: recoveryCodes[0], isRecoveryCode: true });
    expect(again.status).toBe(401);
  });

  it("disable and recovery-code regeneration need the current factor, not just a session", async () => {
    const app = buildApp(true);
    const userId = await newUser("sensitive");
    const { sessionId, secret, recoveryCodes } = await enrol(app, userId);

    expect((await post(app, "/api/auth/2fa/disable", sessionId, {})).status).toBe(400);
    expect((await post(app, "/api/auth/2fa/disable", sessionId, { totpCode: "000000" })).status).toBe(401);
    expect((await post(app, "/api/auth/2fa/recovery-codes/regenerate", sessionId, { totpCode: "000000" })).status).toBe(401);
    expect((await get(app, "/api/auth/2fa/status", sessionId)).body.enabled).toBe(true);

    const regen = await post(app, "/api/auth/2fa/recovery-codes/regenerate", sessionId, { totpCode: codeAt(secret, -1) });
    expect(regen.status).toBe(200);
    const fresh: string[] = regen.body.recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh.some((c) => recoveryCodes.includes(c))).toBe(false);
    // The old codes are dead; the new ones live.
    const s1 = await newSession(userId);
    expect((await post(app, "/api/auth/2fa/login/verify", s1, { totpCode: recoveryCodes[1], isRecoveryCode: true })).status).toBe(401);
    const s2 = await newSession(userId);
    expect((await post(app, "/api/auth/2fa/login/verify", s2, { totpCode: fresh[0], isRecoveryCode: true })).status).toBe(200);

    const off = await post(app, "/api/auth/2fa/disable", sessionId, { totpCode: codeAt(secret, 0) });
    expect(off.status).toBe(200);
    expect((await get(app, "/api/auth/2fa/status", sessionId)).body.enabled).toBe(false);
    // With 2FA off a brand-new session is a normal board session again.
    expect((await get(app, "/api/board-only", await newSession(userId))).status).toBe(200);

    // And disabling again reports "not enabled".
    expect((await post(app, "/api/auth/2fa/disable", sessionId, { totpCode: codeAt(secret, 1) })).status).toBe(404);
  });

  it("disabling forgets verified sessions, so a later re-enrolment does not inherit them", async () => {
    const app = buildApp(true);
    const userId = await newUser("reenrol");
    const first = await enrol(app, userId);
    expect((await post(app, "/api/auth/2fa/disable", first.sessionId, { totpCode: codeAt(first.secret, 0) })).status).toBe(200);
    const second = await enrol(app, userId);
    expect(second.secret).not.toBe(first.secret);
    // The session that passed the old factor is pending again under the new one.
    expect((await get(app, "/api/board-only", first.sessionId)).status).toBe(401);
    expect((await get(app, "/api/board-only", second.sessionId)).status).toBe(200);
  });

  it("a user can only act on their own 2FA record", async () => {
    const app = buildApp(true);
    const alice = await newUser("alice");
    const bob = await newUser("bob");
    const a = await enrol(app, alice);
    const bobSession = await newSession(bob);

    // Bob, fully signed in, presents Alice's valid code and recovery code.
    // Nothing in a request names a user: each call can only reach Bob's own (empty) record.
    const disable = await post(app, "/api/auth/2fa/disable", bobSession, { totpCode: codeAt(a.secret, -1) });
    expect(disable.status).toBe(404);
    const disableRecovery = await post(app, "/api/auth/2fa/disable", bobSession, {
      totpCode: a.recoveryCodes[0],
      isRecoveryCode: true,
    });
    expect(disableRecovery.status).toBe(404);
    const regen = await post(app, "/api/auth/2fa/recovery-codes/regenerate", bobSession, { totpCode: codeAt(a.secret, -1) });
    expect(regen.status).toBe(409);
    // Alice's factor and codes are untouched.
    expect((await get(app, "/api/auth/2fa/status", a.sessionId)).body).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
    // Bob's session cannot be verified with Alice's code.
    const bobPending = await post(app, "/api/auth/2fa/login/verify", bobSession, { totpCode: codeAt(a.secret, -1) });
    expect(bobPending.status).toBe(409);
    // Alice cannot start a second enrolment over her live one.
    expect((await post(app, "/api/auth/2fa/enroll/start", a.sessionId)).status).toBe(409);
  });

  it("refuses cross-origin POSTs and non-session callers", async () => {
    const app = buildApp(true);
    const userId = await newUser("origin");
    const sessionId = await newSession(userId);
    const noOrigin = await request(app).post("/api/auth/2fa/enroll/start").set("x-test-session", sessionId).send({});
    expect(noOrigin.status).toBe(403);
    const evil = await request(app)
      .post("/api/auth/2fa/enroll/start")
      .set("x-test-session", sessionId)
      .set("Origin", "https://evil.example")
      .send({});
    expect(evil.status).toBe(403);
    expect((await get(app, "/api/auth/2fa/status", null)).status).toBe(401);
  });

  it("writes activity entries for the main events and never puts a secret or code in them", async () => {
    const app = buildApp(true);
    const userId = await newUser("audit");
    const { sessionId, secret, recoveryCodes, otpauthUri } = await enrol(app, userId);
    const badCode = "135790";
    await post(app, "/api/auth/2fa/disable", sessionId, { totpCode: badCode });
    await post(app, "/api/auth/2fa/recovery-codes/regenerate", sessionId, { totpCode: codeAt(secret, -1) });
    await post(app, "/api/auth/2fa/disable", sessionId, { totpCode: codeAt(secret, 0) });

    const rows = await db.select().from(activityLog).where(like(activityLog.action, "two_factor.%"));
    const mine = rows.filter((r) => r.actorId === userId);
    const actions = new Set(mine.map((r) => r.action));
    expect(actions).toEqual(
      new Set([
        "two_factor.enrolled",
        "two_factor.verify_failed",
        "two_factor.recovery_codes_regenerated",
        "two_factor.disabled",
      ]),
    );
    const blob = JSON.stringify(mine);
    expect(blob).not.toContain(secret);
    expect(blob).not.toContain(otpauthUri);
    expect(blob).not.toContain(badCode);
    for (const code of recoveryCodes) expect(blob).not.toContain(code);
  });
});
