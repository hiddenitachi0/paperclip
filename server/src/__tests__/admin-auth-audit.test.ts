import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
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
import { describeUserAgent } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ADMIN_AUTH_ACTIONS,
  ADMIN_AUTH_SNAPSHOT_KEY,
  buildAdminAuthSnapshot,
  buildAdminPromotedNotice,
  buildNewDeviceSignInNotice,
  buildPasswordChangedOutsideAppNotice,
  computeAdminAuthEntries,
  diffAdminAuthSnapshots,
  fingerprintPasswordHash,
  loadAdminAuthRecord,
  reconcileAdminAuthSnapshot,
  recordAdminSessionCreated,
  recordAdminSetChangedViaApp,
  recordPasswordChangedViaApp,
  removeExpectedChanges,
  resolveAdminAuthSigningSecret,
  revokeSessionsForUser,
  verifyAdminAuthSnapshot,
} from "../services/admin-auth-audit.js";
import { buildBetterAuthDatabaseHooks } from "../auth/better-auth.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres admin-auth-audit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SECRET = "test-admin-auth-secret";

// ─── Pure pieces: no database ────────────────────────────────────────────────

describe("admin auth record (pure)", () => {
  it("signs and verifies a snapshot, and rejects a forged one", () => {
    const snapshot = buildAdminAuthSnapshot(
      [{ userId: "u1", email: "a@example.com", passwordFingerprint: "abc" }],
      SECRET,
      new Date("2026-09-07T10:00:00Z"),
    );
    expect(snapshot.signed).toBe(true);
    expect(verifyAdminAuthSnapshot(snapshot, SECRET)).toBe(true);
    expect(verifyAdminAuthSnapshot(snapshot, "other-secret")).toBe(false);
    expect(verifyAdminAuthSnapshot({ ...snapshot, entries: [...snapshot.entries, { userId: "u2", email: null, passwordFingerprint: null }] }, SECRET)).toBe(false);
    expect(verifyAdminAuthSnapshot({ ...snapshot, signature: "" }, SECRET)).toBe(false);
    // Entry order does not matter for the signature.
    const reordered = buildAdminAuthSnapshot(
      [
        { userId: "u2", email: null, passwordFingerprint: null },
        { userId: "u1", email: "a@example.com", passwordFingerprint: "abc" },
      ],
      SECRET,
      new Date("2026-09-07T10:00:00Z"),
    );
    const sameOrder = buildAdminAuthSnapshot(
      [
        { userId: "u1", email: "a@example.com", passwordFingerprint: "abc" },
        { userId: "u2", email: null, passwordFingerprint: null },
      ],
      SECRET,
      new Date("2026-09-07T10:00:00Z"),
    );
    expect(reordered.signature).toBe(sameOrder.signature);
  });

  it("marks a snapshot unsigned when no secret is configured", () => {
    expect(buildAdminAuthSnapshot([], null).signed).toBe(false);
    expect(resolveAdminAuthSigningSecret({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveAdminAuthSigningSecret({ PAPERCLIP_AGENT_JWT_SECRET: "x" } as NodeJS.ProcessEnv)).toBe("x");
    expect(resolveAdminAuthSigningSecret({ BETTER_AUTH_SECRET: "y", PAPERCLIP_AGENT_JWT_SECRET: "x" } as NodeJS.ProcessEnv)).toBe("y");
  });

  it("diffs admin sets by user, email and password fingerprint", () => {
    const before = [
      { userId: "keep", email: "keep@example.com", passwordFingerprint: "p1" },
      { userId: "gone", email: "gone@example.com", passwordFingerprint: "p2" },
      { userId: "mail", email: "old@example.com", passwordFingerprint: "p3" },
      { userId: "pass", email: "pass@example.com", passwordFingerprint: "p4" },
    ];
    const after = [
      { userId: "keep", email: "keep@example.com", passwordFingerprint: "p1" },
      { userId: "new", email: "new@example.com", passwordFingerprint: "p5" },
      { userId: "mail", email: "new-mail@example.com", passwordFingerprint: "p3" },
      { userId: "pass", email: "pass@example.com", passwordFingerprint: "p6" },
    ];
    const diff = diffAdminAuthSnapshots(before, after);
    expect(diff.added.map((e) => e.userId)).toEqual(["new"]);
    expect(diff.removed.map((e) => e.userId)).toEqual(["gone"]);
    expect(diff.emailChanged).toEqual([{ userId: "mail", from: "old@example.com", to: "new-mail@example.com" }]);
    expect(diff.passwordChanged).toEqual([{ userId: "pass", email: "pass@example.com" }]);

    const trimmed = removeExpectedChanges(diff, [
      { kind: "added", userId: "new" },
      { kind: "password", userId: "pass" },
    ]);
    expect(trimmed.added).toEqual([]);
    expect(trimmed.passwordChanged).toEqual([]);
    expect(trimmed.removed.map((e) => e.userId)).toEqual(["gone"]);
    expect(trimmed.emailChanged).toHaveLength(1);
  });

  it("fingerprints password hashes without exposing them", () => {
    const fp = fingerprintPasswordHash("scrypt$abc$def");
    expect(fp).toHaveLength(16);
    expect(fp).not.toContain("scrypt");
    expect(fingerprintPasswordHash(null)).toBeNull();
    expect(fingerprintPasswordHash("")).toBeNull();
  });

  it("writes operator notices in plain language that say what to do next", () => {
    const outside = buildPasswordChangedOutsideAppNotice({ who: "Filip (filip@example.com)" });
    expect(outside).toContain("Filip (filip@example.com)");
    expect(outside).toContain("without going through the app");
    expect(outside).toContain("Sign out everywhere");
    expect(outside).not.toMatch(/security\./);

    const promoted = buildAdminPromotedNotice({ who: "Kari", by: "Filip", sessionsRevoked: 2 });
    expect(promoted).toBe(
      "Filip made Kari an instance admin, which gives full access to every company on this server. Kari was signed out of 2 open sessions and needs to sign in again for the new access to apply.",
    );

    const newDevice = buildNewDeviceSignInNotice({
      who: "Filip",
      ipAddress: "203.0.113.9",
      device: "Safari on iPhone",
      newIp: true,
      newDevice: false,
      firstSession: false,
    });
    expect(newDevice).toContain("signed in from 203.0.113.9 using Safari on iPhone");
    expect(newDevice).toContain("network address does not match");
  });

  it("describes browsers the way a person would", () => {
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Gecko/20100101 Firefox/129.0")).toBe("Firefox on Mac");
    expect(describeUserAgent("curl/8.4.0")).toBe("curl");
    expect(describeUserAgent("")).toBe("Unknown device");
    expect(describeUserAgent(null)).toBe("Unknown device");
  });

  it("wires better-auth hooks so a failing audit hook never breaks sign-in", async () => {
    const onSessionCreated = vi.fn(async () => {
      throw new Error("boom");
    });
    const onUserUpdated = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const built = buildBetterAuthDatabaseHooks({ onSessionCreated, onUserUpdated }) as {
        databaseHooks: {
          session: { create: { after: (s: unknown) => Promise<void> } };
          user: { update: { after: (u: unknown) => Promise<void> } };
        };
        hooks: { after: unknown };
      };
      await expect(
        built.databaseHooks.session.create.after({ id: "s1", userId: "u1", ipAddress: "1.2.3.4", userAgent: "ua" }),
      ).resolves.toBeUndefined();
      expect(onSessionCreated).toHaveBeenCalledWith({ id: "s1", userId: "u1", ipAddress: "1.2.3.4", userAgent: "ua" });
      expect(warn).toHaveBeenCalled();
      await built.databaseHooks.user.update.after({ id: "u1", email: "a@example.com", name: "A" });
      expect(onUserUpdated).toHaveBeenCalledWith({ id: "u1", email: "a@example.com", name: "A" });
      expect(built.hooks.after).toBeTruthy();
      expect(buildBetterAuthDatabaseHooks(undefined)).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── Database-backed reconciliation and notices ──────────────────────────────

describeEmbeddedPostgres("admin auth reconciliation and notices (embedded Postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-admin-auth-audit-");
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

  async function seedCompany(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: `C${id.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    });
    return id;
  }

  async function seedUser(input: { name: string; email: string; passwordHash?: string | null; admin?: boolean }) {
    const id = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({ id, name: input.name, email: input.email, emailVerified: true, createdAt: now, updatedAt: now });
    if (input.passwordHash !== null) {
      await db.insert(authAccounts).values({
        id: randomUUID(),
        accountId: id,
        providerId: "credential",
        userId: id,
        password: input.passwordHash ?? `hash-${id}`,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (input.admin) {
      await db.insert(instanceUserRoles).values({ userId: id, role: "instance_admin" });
    }
    return id;
  }

  async function seedSession(userId: string, ipAddress: string, userAgent: string, opts?: { expired?: boolean }) {
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
      expiresAt: new Date(now.getTime() + (opts?.expired ? -1 : 1) * 60 * 60 * 1000),
    });
    return id;
  }

  async function noticesFor(action: string) {
    return db.select().from(activityLog).where(eq(activityLog.action, action));
  }

  it("takes a baseline on the first run, then reports nothing while nothing changes", async () => {
    await seedCompany("Acme");
    const admin = await seedUser({ name: "Filip", email: "filip@example.com", admin: true });
    await seedUser({ name: "Kari", email: "kari@example.com" });

    const first = await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "startup" });
    expect(first.status).toBe("baseline");
    expect(first.notices).toEqual([]);

    const stored = await loadAdminAuthRecord(db);
    expect(stored.snapshot?.entries.map((e) => e.userId)).toEqual([admin]);
    expect(stored.snapshot?.entries[0]?.email).toBe("filip@example.com");
    expect(stored.snapshot?.entries[0]?.passwordFingerprint).toHaveLength(16);
    expect(stored.snapshot?.signed).toBe(true);
    expect(stored.lastCheck?.status).toBe("baseline");
    expect(stored.lastCheck?.trigger).toBe("startup");

    const second = await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "scheduled" });
    expect(second.status).toBe("unchanged");
    expect(await db.select().from(activityLog)).toHaveLength(0);
    // The default instance_settings row is never touched by the record.
    const rows = await db.select({ key: instanceSettings.singletonKey }).from(instanceSettings);
    expect(rows.map((r) => r.key)).toContain(ADMIN_AUTH_SNAPSHOT_KEY);
  });

  it("reports an admin added by a direct database write, once, to every company", async () => {
    const acme = await seedCompany("Acme");
    const globex = await seedCompany("Globex");
    await seedUser({ name: "Filip", email: "filip@example.com", admin: true });
    const intruder = await seedUser({ name: "Mallory", email: "mallory@example.com" });
    await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "startup" });

    // The attack: INSERT straight into instance_user_roles, bypassing the API.
    await db.insert(instanceUserRoles).values({ userId: intruder, role: "instance_admin" });

    const result = await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "scheduled" });
    expect(result.status).toBe("changed");
    expect(result.changes).toBe(1);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain("Mallory (mallory@example.com) was made an instance admin without going through the app");

    const rows = await noticesFor(ADMIN_AUTH_ACTIONS.adminAddedOutsideApp);
    expect(rows.map((r) => r.companyId).sort()).toEqual([acme, globex].sort());
    for (const row of rows) {
      expect(row.actorType).toBe("system");
      expect(row.entityType).toBe("user");
      expect(row.entityId).toBe(intruder);
      expect((row.details as Record<string, unknown>).message).toBe(result.notices[0]);
      expect((row.details as Record<string, unknown>).source).toBe("outside_app");
    }

    // The record was refreshed: the next tick stays quiet instead of nagging.
    const again = await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "scheduled" });
    expect(again.status).toBe("unchanged");
    expect(await noticesFor(ADMIN_AUTH_ACTIONS.adminAddedOutsideApp)).toHaveLength(2);
  });

  it("reports an admin password or email changed by a direct database write", async () => {
    await seedCompany("Acme");
    const admin = await seedUser({ name: "Filip", email: "filip@example.com", passwordHash: "old-hash", admin: true });
    await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "startup" });

    // The incident from 2026-08-11: UPDATE account SET password = ... on the box.
    await db.update(authAccounts).set({ password: "new-hash" }).where(eq(authAccounts.userId, admin));
    const afterPassword = await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "scheduled" });
    expect(afterPassword.status).toBe("changed");
    expect(afterPassword.notices[0]).toContain("The password for instance admin Filip (filip@example.com) was changed without going through the app");
    expect(await noticesFor(ADMIN_AUTH_ACTIONS.passwordChangedOutsideApp)).toHaveLength(1);

    await db.update(authUsers).set({ email: "attacker@example.com" }).where(eq(authUsers.id, admin));
    const afterEmail = await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "scheduled" });
    expect(afterEmail.status).toBe("changed");
    expect(afterEmail.notices[0]).toContain("changed from filip@example.com to attacker@example.com without going through the app");
    expect(await noticesFor(ADMIN_AUTH_ACTIONS.emailChangedOutsideApp)).toHaveLength(1);

    // An admin removed by DELETE is reported too.
    await db.delete(instanceUserRoles).where(eq(instanceUserRoles.userId, admin));
    const afterRemoval = await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "scheduled" });
    expect(afterRemoval.status).toBe("changed");
    expect(afterRemoval.notices[0]).toContain("is no longer an instance admin, and the change did not go through the app");
  });

  it("reports a record whose signature no longer matches as tampering and re-baselines", async () => {
    await seedCompany("Acme");
    await seedUser({ name: "Filip", email: "filip@example.com", admin: true });
    await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "startup" });

    // Someone edits the stored record to hide an added admin.
    const row = await db
      .select({ id: instanceSettings.id, general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, ADMIN_AUTH_SNAPSHOT_KEY))
      .then((rows) => rows[0]!);
    const general = row.general as { snapshot: { entries: unknown[] } };
    general.snapshot.entries.push({ userId: "ghost", email: null, passwordFingerprint: null });
    await db.update(instanceSettings).set({ general: { ...general } }).where(eq(instanceSettings.id, row.id));

    const result = await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "scheduled" });
    expect(result.status).toBe("tampered");
    expect(result.notices[0]).toContain("no longer matches its signature");
    expect(await noticesFor(ADMIN_AUTH_ACTIONS.snapshotTampered)).toHaveLength(1);

    const fresh = await loadAdminAuthRecord(db);
    expect(fresh.snapshot && verifyAdminAuthSnapshot(fresh.snapshot, SECRET)).toBe(true);
    expect((await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "scheduled" })).status).toBe("unchanged");
  });

  it("announces a promotion made through the app and does not re-report it as an outside change", async () => {
    await seedCompany("Acme");
    const filip = await seedUser({ name: "Filip", email: "filip@example.com", admin: true });
    const kari = await seedUser({ name: "Kari", email: "kari@example.com" });
    await seedSession(kari, "10.0.0.2", "Chrome");
    await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "startup" });

    // What the promote route does: add the role, end Kari's sessions, record it.
    await db.insert(instanceUserRoles).values({ userId: kari, role: "instance_admin" });
    const revoked = await revokeSessionsForUser(db, kari);
    expect(revoked).toBe(1);
    await recordAdminSetChangedViaApp(db, {
      secret: SECRET,
      userId: kari,
      change: "promoted",
      actor: { actorType: "user", actorId: filip, actorName: "Filip" },
      sessionsRevoked: revoked,
    });

    const promoted = await noticesFor(ADMIN_AUTH_ACTIONS.adminPromoted);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.actorType).toBe("user");
    expect(promoted[0]!.actorId).toBe(filip);
    expect((promoted[0]!.details as Record<string, unknown>).message).toBe(
      "Filip (filip@example.com) made Kari (kari@example.com) an instance admin, which gives full access to every company on this server. Kari (kari@example.com) was signed out of their open session and needs to sign in again for the new access to apply.",
    );
    expect(await noticesFor(ADMIN_AUTH_ACTIONS.adminAddedOutsideApp)).toHaveLength(0);

    const next = await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "scheduled" });
    expect(next.status).toBe("unchanged");
    expect((await loadAdminAuthRecord(db)).snapshot?.entries.map((e) => e.userId).sort()).toEqual([filip, kari].sort());
  });

  it("announces an in-app password change and folds it into the record", async () => {
    await seedCompany("Acme");
    const filip = await seedUser({ name: "Filip", email: "filip@example.com", passwordHash: "old", admin: true });
    await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "startup" });

    await db.update(authAccounts).set({ password: "new" }).where(eq(authAccounts.userId, filip));
    await recordPasswordChangedViaApp(db, { secret: SECRET, userId: filip });

    const rows = await noticesFor(ADMIN_AUTH_ACTIONS.passwordChanged);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.details as Record<string, unknown>).message).toBe(
      'Instance admin Filip (filip@example.com) changed their password in the app. If that was not them, use "Sign out everywhere" under Settings > Instance > Security.',
    );
    expect((await reconcileAdminAuthSnapshot(db, { secret: SECRET, trigger: "scheduled" })).status).toBe("unchanged");
    expect(await noticesFor(ADMIN_AUTH_ACTIONS.passwordChangedOutsideApp)).toHaveLength(0);
  });

  it("notices an admin signing in from a new device or address, but stays quiet for known ones", async () => {
    await seedCompany("Acme");
    const filip = await seedUser({ name: "Filip", email: "filip@example.com", admin: true });
    const kari = await seedUser({ name: "Kari", email: "kari@example.com" });

    // Non-admins are not watched.
    const kariSession = await seedSession(kari, "10.0.0.9", "Chrome on Windows");
    expect(await recordAdminSessionCreated(db, { id: kariSession, userId: kari, ipAddress: "10.0.0.9", userAgent: "Chrome on Windows" })).toEqual({
      notified: false,
      reason: "not_admin",
    });

    const first = await seedSession(filip, "10.0.0.1", "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0");
    expect((await recordAdminSessionCreated(db, { id: first, userId: filip, ipAddress: "10.0.0.1", userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0" })).reason).toBe("first_session");

    const same = await seedSession(filip, "10.0.0.1", "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0");
    expect((await recordAdminSessionCreated(db, { id: same, userId: filip, ipAddress: "10.0.0.1", userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0" })).reason).toBe("known_device");

    const phone = await seedSession(filip, "203.0.113.9", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1");
    const outcome = await recordAdminSessionCreated(db, { id: phone, userId: filip, ipAddress: "203.0.113.9", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1" });
    expect(outcome).toEqual({ notified: true, reason: "new_device" });

    const rows = await noticesFor(ADMIN_AUTH_ACTIONS.adminNewDeviceSignIn);
    expect(rows).toHaveLength(2);
    const latest = rows.find((row) => (row.details as Record<string, unknown>).sessionId === phone)!;
    const details = latest.details as Record<string, unknown>;
    expect(details.message).toContain("Instance admin Filip (filip@example.com) signed in from 203.0.113.9 using Safari on iPhone");
    expect(details.message).toContain("Neither the device nor the network address matches");
    expect(details.newIp).toBe(true);
    expect(details.newDevice).toBe(true);

    // Expired sessions do not count as "known".
    await db.delete(authSessions);
    await seedSession(filip, "10.0.0.1", "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0", { expired: true });
    const afterExpiry = await seedSession(filip, "10.0.0.1", "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0");
    expect((await recordAdminSessionCreated(db, { id: afterExpiry, userId: filip, ipAddress: "10.0.0.1", userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0" })).reason).toBe("first_session");
  });

  it("computes the live record from the tables, never from the stored snapshot", async () => {
    const a = await seedUser({ name: "A", email: "a@example.com", passwordHash: "ha", admin: true });
    const b = await seedUser({ name: "B", email: "b@example.com", passwordHash: null, admin: true });
    await seedUser({ name: "C", email: "c@example.com" });
    const entries = await computeAdminAuthEntries(db);
    expect(entries.map((e) => e.userId).sort()).toEqual([a, b].sort());
    expect(entries.find((e) => e.userId === a)?.passwordFingerprint).toBe(fingerprintPasswordHash("ha"));
    expect(entries.find((e) => e.userId === b)?.passwordFingerprint).toBeNull();
    expect(
      await db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, a), eq(instanceUserRoles.role, "instance_admin"))),
    ).toHaveLength(1);
  });
});
