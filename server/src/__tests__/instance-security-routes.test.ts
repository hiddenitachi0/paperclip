import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  authAccounts,
  authSessions,
  authUsers,
  companies,
  createDb,
  instanceSettings,
  instanceUserRoles,
} from "@paperclipai/db";
import type { InstanceSecurityOverview } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { instanceSecurityRoutes } from "../routes/instance-security.js";
import { ADMIN_AUTH_ACTIONS, ADMIN_AUTH_SNAPSHOT_KEY } from "../services/admin-auth-audit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres instance-security route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Actor = {
  type: "board" | "none";
  source?: "session" | "local_implicit" | "board_key";
  userId?: string;
  userName?: string | null;
  userEmail?: string | null;
  isInstanceAdmin?: boolean;
  sessionId?: string;
};

describeEmbeddedPostgres("instance security routes (admin auth hardening)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-instance-security-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(authSessions);
    await db.delete(authAccounts);
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
    await db.delete(companies);
    await db.delete(instanceSettings).where(eq(instanceSettings.singletonKey, ADMIN_AUTH_SNAPSHOT_KEY));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Actor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", instanceSecurityRoutes(db, { checkIntervalMinutes: 10 }));
    app.use(errorHandler);
    return app;
  }

  async function seedUser(input: { name: string; email: string; admin?: boolean }) {
    const id = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({ id, name: input.name, email: input.email, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(authAccounts).values({
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: `hash-${id}`,
      createdAt: now,
      updatedAt: now,
    });
    if (input.admin) await db.insert(instanceUserRoles).values({ userId: id, role: "instance_admin" });
    return id;
  }

  async function seedSession(userId: string, ipAddress: string, userAgent: string) {
    const id = randomUUID();
    const now = new Date();
    await db.insert(authSessions).values({
      id,
      userId,
      token: `tok-${id}`,
      ipAddress,
      userAgent,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    return id;
  }

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Acme", issuePrefix: `C${id.replace(/-/g, "").slice(0, 5).toUpperCase()}` });
    return id;
  }

  it("refuses non-admins and lists admins and sessions for an admin, marking this device", async () => {
    await seedCompany();
    const filip = await seedUser({ name: "Filip", email: "filip@example.com", admin: true });
    const kari = await seedUser({ name: "Kari", email: "kari@example.com" });
    const mine = await seedSession(filip, "10.0.0.1", "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0");
    await seedSession(kari, "10.0.0.2", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1");

    const forbidden = await request(createApp({ type: "board", source: "session", userId: kari, isInstanceAdmin: false })).get("/api/instance/security");
    expect(forbidden.status).toBe(403);
    const anonymous = await request(createApp({ type: "none" })).get("/api/instance/security");
    expect(anonymous.status).toBe(403);

    const res = await request(
      createApp({ type: "board", source: "session", userId: filip, userName: "Filip", isInstanceAdmin: true, sessionId: mine }),
    ).get("/api/instance/security");
    expect(res.status).toBe(200);
    const body = res.body as InstanceSecurityOverview;
    expect(body.admins).toEqual([
      expect.objectContaining({ userId: filip, name: "Filip", email: "filip@example.com", sessionCount: 1 }),
    ]);
    expect(body.sessions).toHaveLength(2);
    const own = body.sessions.find((s) => s.id === mine)!;
    expect(own).toMatchObject({ isCurrent: true, isInstanceAdmin: true, device: "Chrome on Windows", ipAddress: "10.0.0.1" });
    const other = body.sessions.find((s) => s.userId === kari)!;
    expect(other).toMatchObject({ isCurrent: false, isInstanceAdmin: false, device: "Safari on iPhone", userName: "Kari" });
    // No secrets leak through the overview.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("tok-");
    expect(raw).not.toContain("hash-");
    expect(raw).not.toContain("signature");
    expect(body.checkIntervalMinutes).toBe(10);
    expect(body.lastCheck).toBeNull();
  });

  it("runs the admin record check on demand and reports the result on the overview", async () => {
    await seedCompany();
    const filip = await seedUser({ name: "Filip", email: "filip@example.com", admin: true });
    const app = createApp({ type: "board", source: "session", userId: filip, isInstanceAdmin: true });

    const baseline = await request(app).post("/api/instance/security/check");
    expect(baseline.status).toBe(200);
    expect(baseline.body.status).toBe("baseline");

    const mallory = await seedUser({ name: "Mallory", email: "mallory@example.com" });
    await db.insert(instanceUserRoles).values({ userId: mallory, role: "instance_admin" });
    const check = await request(app).post("/api/instance/security/check");
    expect(check.status).toBe(200);
    expect(check.body.status).toBe("changed");
    expect(check.body.notices[0]).toContain("Mallory (mallory@example.com) was made an instance admin without going through the app");

    const overview = await request(app).get("/api/instance/security");
    expect(overview.body.lastCheck).toMatchObject({ status: "changed", trigger: "manual", changes: 1 });
    expect(overview.body.snapshotTakenAt).toBeTruthy();
  });

  it("signs the caller out everywhere, or everyone out, and says so in the Activity feed", async () => {
    const companyId = await seedCompany();
    const filip = await seedUser({ name: "Filip", email: "filip@example.com", admin: true });
    const kari = await seedUser({ name: "Kari", email: "kari@example.com" });
    const mine = await seedSession(filip, "10.0.0.1", "Chrome");
    await seedSession(filip, "10.0.0.5", "Firefox");
    await seedSession(kari, "10.0.0.2", "Safari");
    const app = createApp({ type: "board", source: "session", userId: filip, userName: "Filip", userEmail: "filip@example.com", isInstanceAdmin: true, sessionId: mine });

    const me = await request(app).post("/api/instance/security/sign-out-everywhere").send({ scope: "me" });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ scope: "me", revokedSessions: 2, signedOutSelf: true });
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, filip))).toHaveLength(0);
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, kari))).toHaveLength(1);

    const notice = await db.select().from(activityLog).where(eq(activityLog.action, ADMIN_AUTH_ACTIONS.signedOutEverywhere));
    expect(notice).toHaveLength(1);
    expect(notice[0]!.companyId).toBe(companyId);
    expect((notice[0]!.details as Record<string, unknown>).message).toBe(
      "Filip (filip@example.com) signed out of all their devices (2 open sessions ended).",
    );

    const invalid = await request(app).post("/api/instance/security/sign-out-everywhere").send({ scope: "somebody" });
    expect(invalid.status).toBe(400);

    const everyone = await request(app).post("/api/instance/security/sign-out-everywhere").send({ scope: "everyone" });
    expect(everyone.status).toBe(200);
    expect(everyone.body).toEqual({ scope: "everyone", revokedSessions: 1, signedOutSelf: true });
    expect(await db.select().from(authSessions)).toHaveLength(0);
  });

  it("ends a single session and reports whether it was the caller's own", async () => {
    await seedCompany();
    const filip = await seedUser({ name: "Filip", email: "filip@example.com", admin: true });
    const kari = await seedUser({ name: "Kari", email: "kari@example.com" });
    const mine = await seedSession(filip, "10.0.0.1", "Chrome");
    const theirs = await seedSession(kari, "10.0.0.2", "Safari");
    const app = createApp({ type: "board", source: "session", userId: filip, userName: "Filip", isInstanceAdmin: true, sessionId: mine });

    const other = await request(app).delete(`/api/instance/security/sessions/${theirs}`);
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ revoked: true, signedOutSelf: false });
    expect(await db.select().from(authSessions).where(eq(authSessions.id, theirs))).toHaveLength(0);

    const gone = await request(app).delete(`/api/instance/security/sessions/${theirs}`);
    expect(gone.status).toBe(404);

    const own = await request(app).delete(`/api/instance/security/sessions/${mine}`);
    expect(own.body).toEqual({ revoked: true, signedOutSelf: true });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, ADMIN_AUTH_ACTIONS.sessionRevoked))).toHaveLength(2);
  });
});
