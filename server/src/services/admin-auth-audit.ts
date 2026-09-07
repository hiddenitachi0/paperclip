// Admin authentication audit (security hardening of operator sign-in).
//
// The gap this closes: anyone with database access could reset an admin's
// password, change their email, or add themselves to `instance_user_roles`
// with a single UPDATE/INSERT, and nothing would ever tell the operator.
// Nothing here can *prevent* a direct database write -- the app runs with
// table-owner credentials today -- so the goal is that such a change can no
// longer be silent:
//
//   1. A signed record ("snapshot") of the admin set -- each admin's user id,
//      sign-in email and a fingerprint of their password hash -- is kept in
//      `instance_settings` under its own singleton key, HMAC-signed with the
//      server's auth secret. A periodic check recomputes the record from the
//      live tables and compares. Any difference that did not arrive through
//      the app (promote/demote, change-password) is reported as an operator
//      notice in every company's Activity feed (the DUR-98 mechanism); a bad
//      signature is reported as tampering.
//   2. Changes that *do* go through the app are reported too, worded as such,
//      and the record is refreshed right away so the periodic check does not
//      report them a second time.
//   3. An instance admin signing in from a device/network address none of
//      their open sessions have used gets a notice as well.
//
// Every write path here is best-effort: a failure to log must never break a
// sign-in or an admin promotion, so callers wrap these in `.catch`.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gt, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  companies,
  instanceSettings,
  instanceUserRoles,
} from "@paperclipai/db";
import {
  describeUserAgent,
  type AdminAuthCheckResult,
  type AdminAuthCheckStatus,
  type AdminAuthCheckTrigger,
  type AdminAuthLastCheck,
  type InstanceSecurityOverview,
} from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

export const ADMIN_AUTH_SNAPSHOT_KEY = "admin_auth_snapshot";
export const ADMIN_AUTH_SNAPSHOT_VERSION = 1;
const INSTANCE_ADMIN_ROLE = "instance_admin";
const CREDENTIAL_PROVIDER_ID = "credential";
const UNSIGNED_FALLBACK_SECRET = "paperclip-admin-auth-unsigned";

export const ADMIN_AUTH_ACTIONS = {
  adminAddedOutsideApp: "security.admin_added_outside_app",
  adminRemovedOutsideApp: "security.admin_removed_outside_app",
  emailChangedOutsideApp: "security.admin_email_changed_outside_app",
  passwordChangedOutsideApp: "security.admin_password_changed_outside_app",
  snapshotTampered: "security.admin_record_tampered",
  adminPromoted: "security.admin_promoted",
  adminDemoted: "security.admin_demoted",
  passwordChanged: "security.password_changed",
  emailChanged: "security.email_changed",
  adminNewDeviceSignIn: "security.admin_signed_in_new_device",
  signedOutEverywhere: "security.signed_out_everywhere",
  sessionRevoked: "security.session_revoked",
} as const;

export interface AdminAuthSnapshotEntry {
  userId: string;
  email: string | null;
  /** Short sha256 prefix of the stored password hash; null when the user has no password account. */
  passwordFingerprint: string | null;
}

export interface AdminAuthSnapshot {
  version: number;
  takenAt: string;
  entries: AdminAuthSnapshotEntry[];
  signature: string;
  signed: boolean;
}

interface StoredAdminAuthRecord {
  snapshot: AdminAuthSnapshot | null;
  lastCheck: AdminAuthLastCheck | null;
}

export interface AdminAuthDiff {
  added: AdminAuthSnapshotEntry[];
  removed: AdminAuthSnapshotEntry[];
  emailChanged: Array<{ userId: string; from: string | null; to: string | null }>;
  passwordChanged: Array<{ userId: string; email: string | null }>;
}

export type ExpectedAdminAuthChange =
  | { kind: "added"; userId: string }
  | { kind: "removed"; userId: string }
  | { kind: "email"; userId: string }
  | { kind: "password"; userId: string };

export interface AdminAuthActorInfo {
  actorType: "user" | "system";
  actorId: string;
  actorName?: string | null;
}

const SYSTEM_ACTOR: AdminAuthActorInfo = { actorType: "system", actorId: "security" };

// ─── Pure helpers (unit-testable without a database) ─────────────────────────

export function resolveAdminAuthSigningSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.BETTER_AUTH_SECRET ?? env.PAPERCLIP_AGENT_JWT_SECRET;
  return secret && secret.trim() ? secret : null;
}

export function fingerprintPasswordHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  return createHash("sha256").update(hash).digest("hex").slice(0, 16);
}

function canonicalSnapshotPayload(input: { version: number; takenAt: string; entries: AdminAuthSnapshotEntry[] }): string {
  const entries = [...input.entries]
    .map((entry) => ({
      userId: entry.userId,
      email: entry.email ?? null,
      passwordFingerprint: entry.passwordFingerprint ?? null,
    }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
  return JSON.stringify({ version: input.version, takenAt: input.takenAt, entries });
}

export function signAdminAuthSnapshot(
  input: { version: number; takenAt: string; entries: AdminAuthSnapshotEntry[] },
  secret: string | null,
): string {
  return createHmac("sha256", secret ?? UNSIGNED_FALLBACK_SECRET)
    .update(canonicalSnapshotPayload(input))
    .digest("hex");
}

export function verifyAdminAuthSnapshot(snapshot: AdminAuthSnapshot, secret: string | null): boolean {
  if (typeof snapshot.signature !== "string" || !snapshot.signature) return false;
  const expected = signAdminAuthSnapshot(snapshot, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(snapshot.signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function buildAdminAuthSnapshot(
  entries: AdminAuthSnapshotEntry[],
  secret: string | null,
  now: Date = new Date(),
): AdminAuthSnapshot {
  const base = {
    version: ADMIN_AUTH_SNAPSHOT_VERSION,
    takenAt: now.toISOString(),
    entries: [...entries].sort((a, b) => a.userId.localeCompare(b.userId)),
  };
  return { ...base, signature: signAdminAuthSnapshot(base, secret), signed: secret !== null };
}

export function diffAdminAuthSnapshots(
  previous: AdminAuthSnapshotEntry[],
  current: AdminAuthSnapshotEntry[],
): AdminAuthDiff {
  const prevById = new Map(previous.map((entry) => [entry.userId, entry]));
  const currById = new Map(current.map((entry) => [entry.userId, entry]));
  const diff: AdminAuthDiff = { added: [], removed: [], emailChanged: [], passwordChanged: [] };
  for (const entry of current) {
    const before = prevById.get(entry.userId);
    if (!before) {
      diff.added.push(entry);
      continue;
    }
    if ((before.email ?? null) !== (entry.email ?? null)) {
      diff.emailChanged.push({ userId: entry.userId, from: before.email ?? null, to: entry.email ?? null });
    }
    if ((before.passwordFingerprint ?? null) !== (entry.passwordFingerprint ?? null)) {
      diff.passwordChanged.push({ userId: entry.userId, email: entry.email ?? null });
    }
  }
  for (const entry of previous) {
    if (!currById.has(entry.userId)) diff.removed.push(entry);
  }
  return diff;
}

export function countAdminAuthDiff(diff: AdminAuthDiff): number {
  return diff.added.length + diff.removed.length + diff.emailChanged.length + diff.passwordChanged.length;
}

export function removeExpectedChanges(diff: AdminAuthDiff, expected: ExpectedAdminAuthChange[]): AdminAuthDiff {
  if (expected.length === 0) return diff;
  const has = (kind: ExpectedAdminAuthChange["kind"], userId: string) =>
    expected.some((change) => change.kind === kind && change.userId === userId);
  return {
    added: diff.added.filter((entry) => !has("added", entry.userId)),
    removed: diff.removed.filter((entry) => !has("removed", entry.userId)),
    emailChanged: diff.emailChanged.filter((entry) => !has("email", entry.userId)),
    passwordChanged: diff.passwordChanged.filter((entry) => !has("password", entry.userId)),
  };
}

function describeUser(input: { name?: string | null; email?: string | null; userId: string }): string {
  const name = input.name?.trim();
  const email = input.email?.trim();
  if (name && email) return `${name} (${email})`;
  if (name) return name;
  if (email) return email;
  return `a user with id ${input.userId.slice(0, 8)}`;
}

const NOT_YOU_ADVICE =
  'If you did not do this yourself, treat it as a break-in: open Settings > Instance > Security, use "Sign out everywhere", change your password, and check the admin list under Settings > Instance > Access.';

export interface AdminAuthNoticeInput {
  who: string;
}

export function buildAdminAddedOutsideAppNotice(input: AdminAuthNoticeInput): string {
  return `${input.who} was made an instance admin without going through the app -- the change was written straight to the database. ${NOT_YOU_ADVICE}`;
}

export function buildAdminRemovedOutsideAppNotice(input: AdminAuthNoticeInput): string {
  return `${input.who} is no longer an instance admin, and the change did not go through the app -- it was written straight to the database. ${NOT_YOU_ADVICE}`;
}

export function buildEmailChangedOutsideAppNotice(input: AdminAuthNoticeInput & { from: string | null; to: string | null }): string {
  const from = input.from ?? "no email";
  const to = input.to ?? "no email";
  return `The sign-in email for instance admin ${input.who} was changed from ${from} to ${to} without going through the app -- it was written straight to the database. ${NOT_YOU_ADVICE}`;
}

export function buildPasswordChangedOutsideAppNotice(input: AdminAuthNoticeInput): string {
  return `The password for instance admin ${input.who} was changed without going through the app -- it was written straight to the database. ${NOT_YOU_ADVICE}`;
}

export function buildSnapshotTamperedNotice(): string {
  return `The signed record of who the instance admins are no longer matches its signature, which means someone edited it directly in the database. Paperclip has taken a fresh record. ${NOT_YOU_ADVICE}`;
}

export function buildAdminPromotedNotice(input: { who: string; by: string; sessionsRevoked: number }): string {
  const signedOut =
    input.sessionsRevoked > 0
      ? ` ${input.who} was signed out of ${input.sessionsRevoked === 1 ? "their open session" : `${input.sessionsRevoked} open sessions`} and needs to sign in again for the new access to apply.`
      : "";
  return `${input.by} made ${input.who} an instance admin, which gives full access to every company on this server.${signedOut}`;
}

export function buildAdminDemotedNotice(input: { who: string; by: string; sessionsRevoked: number }): string {
  const signedOut =
    input.sessionsRevoked > 0
      ? ` ${input.who} was signed out of ${input.sessionsRevoked === 1 ? "their open session" : `${input.sessionsRevoked} open sessions`} so the old access stops right away.`
      : "";
  return `${input.by} removed ${input.who} as an instance admin.${signedOut}`;
}

export function buildPasswordChangedNotice(input: { who: string; isInstanceAdmin: boolean }): string {
  const role = input.isInstanceAdmin ? "Instance admin " : "";
  return `${role}${input.who} changed their password in the app. If that was not them, use "Sign out everywhere" under Settings > Instance > Security.`;
}

export function buildEmailChangedNotice(input: { who: string; from: string | null; to: string | null; isInstanceAdmin: boolean }): string {
  const role = input.isInstanceAdmin ? "Instance admin " : "";
  return `${role}${input.who} changed their sign-in email from ${input.from ?? "no email"} to ${input.to ?? "no email"} in the app.`;
}

export function buildNewDeviceSignInNotice(input: {
  who: string;
  ipAddress: string | null;
  device: string;
  newIp: boolean;
  newDevice: boolean;
  firstSession: boolean;
}): string {
  const where = input.ipAddress ? `from ${input.ipAddress}` : "from an unknown network address";
  const what = input.firstSession
    ? "This is the first open session on record for them"
    : input.newIp && input.newDevice
      ? "Neither the device nor the network address matches any of their other open sessions"
      : input.newIp
        ? "The network address does not match any of their other open sessions"
        : "The device does not match any of their other open sessions";
  return `Instance admin ${input.who} signed in ${where} using ${input.device}. ${what}. If this was not them, use "Sign out everywhere" under Settings > Instance > Security and change the password.`;
}

export function buildSignedOutEverywhereNotice(input: { by: string; scope: "me" | "everyone"; revoked: number }): string {
  const sessions = `${input.revoked} open ${input.revoked === 1 ? "session" : "sessions"}`;
  return input.scope === "everyone"
    ? `${input.by} signed everyone out of this server (${sessions} ended). Every person has to sign in again.`
    : `${input.by} signed out of all their devices (${sessions} ended).`;
}

// ─── Database-backed operations ──────────────────────────────────────────────

async function isInstanceAdmin(db: Db, userId: string): Promise<boolean> {
  const row = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, INSTANCE_ADMIN_ROLE)))
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

async function loadUserLabels(db: Db, userIds: string[]): Promise<Map<string, { name: string | null; email: string | null }>> {
  const map = new Map<string, { name: string | null; email: string | null }>();
  if (userIds.length === 0) return map;
  const rows = await db
    .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
    .from(authUsers)
    .where(inArray(authUsers.id, userIds));
  for (const row of rows) map.set(row.id, { name: row.name ?? null, email: row.email ?? null });
  return map;
}

/** Recomputes the admin record from the live tables (never from the stored snapshot). */
export async function computeAdminAuthEntries(db: Db): Promise<AdminAuthSnapshotEntry[]> {
  const admins = await db
    .select({ userId: instanceUserRoles.userId })
    .from(instanceUserRoles)
    .where(eq(instanceUserRoles.role, INSTANCE_ADMIN_ROLE));
  const userIds = Array.from(new Set(admins.map((row) => row.userId)));
  if (userIds.length === 0) return [];
  const [users, accounts] = await Promise.all([
    db
      .select({ id: authUsers.id, email: authUsers.email })
      .from(authUsers)
      .where(inArray(authUsers.id, userIds)),
    db
      .select({ userId: authAccounts.userId, password: authAccounts.password })
      .from(authAccounts)
      .where(and(inArray(authAccounts.userId, userIds), eq(authAccounts.providerId, CREDENTIAL_PROVIDER_ID))),
  ]);
  const emailById = new Map(users.map((row) => [row.id, row.email ?? null]));
  const passwordById = new Map<string, string | null>();
  for (const account of accounts) {
    if (!passwordById.has(account.userId) || account.password) passwordById.set(account.userId, account.password ?? null);
  }
  return userIds
    .map((userId) => ({
      userId,
      email: emailById.get(userId) ?? null,
      passwordFingerprint: fingerprintPasswordHash(passwordById.get(userId) ?? null),
    }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

function parseStoredRecord(raw: unknown): StoredAdminAuthRecord {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const snapshotRaw = record.snapshot;
  let snapshot: AdminAuthSnapshot | null = null;
  if (snapshotRaw && typeof snapshotRaw === "object" && !Array.isArray(snapshotRaw)) {
    const s = snapshotRaw as Record<string, unknown>;
    const entries = Array.isArray(s.entries)
      ? s.entries
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
          .filter((entry) => typeof entry.userId === "string")
          .map((entry) => ({
            userId: entry.userId as string,
            email: typeof entry.email === "string" ? entry.email : null,
            passwordFingerprint: typeof entry.passwordFingerprint === "string" ? entry.passwordFingerprint : null,
          }))
      : [];
    snapshot = {
      version: typeof s.version === "number" ? s.version : 0,
      takenAt: typeof s.takenAt === "string" ? s.takenAt : "",
      entries,
      signature: typeof s.signature === "string" ? s.signature : "",
      signed: s.signed === true,
    };
  }
  const lastCheckRaw = record.lastCheck;
  let lastCheck: AdminAuthLastCheck | null = null;
  if (lastCheckRaw && typeof lastCheckRaw === "object" && !Array.isArray(lastCheckRaw)) {
    const c = lastCheckRaw as Record<string, unknown>;
    if (typeof c.at === "string" && typeof c.status === "string") {
      lastCheck = {
        at: c.at,
        status: c.status as AdminAuthCheckStatus,
        trigger: (typeof c.trigger === "string" ? c.trigger : "scheduled") as AdminAuthCheckTrigger,
        changes: typeof c.changes === "number" ? c.changes : 0,
      };
    }
  }
  return { snapshot, lastCheck };
}

export async function loadAdminAuthRecord(db: Db): Promise<StoredAdminAuthRecord> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, ADMIN_AUTH_SNAPSHOT_KEY))
    .then((rows) => rows[0] ?? null);
  return parseStoredRecord(row?.general);
}

async function storeAdminAuthRecord(db: Db, record: StoredAdminAuthRecord): Promise<void> {
  const now = new Date();
  const general = { snapshot: record.snapshot, lastCheck: record.lastCheck } as Record<string, unknown>;
  await db
    .insert(instanceSettings)
    .values({
      singletonKey: ADMIN_AUTH_SNAPSHOT_KEY,
      general,
      experimental: {},
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [instanceSettings.singletonKey],
      set: { general, updatedAt: now },
    });
}

async function listCompanyIds(db: Db): Promise<string[]> {
  return db
    .select({ id: companies.id })
    .from(companies)
    .then((rows) => rows.map((row) => row.id));
}

/**
 * DUR-98 mechanism: one activity-log row per company, each carrying the
 * ready-made sentence in `details.message` so the Activity feed shows it
 * without anyone decoding an action key. Instance-wide events have no single
 * company, hence the fan-out (same pattern as instance-settings routes).
 */
export async function notifyOperators(
  db: Db,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    message: string;
    details?: Record<string, unknown>;
    actor?: AdminAuthActorInfo;
  },
): Promise<number> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const companyIds = await listCompanyIds(db);
  logger.warn({ action: input.action, entityId: input.entityId, companies: companyIds.length }, input.message);
  let written = 0;
  for (const companyId of companyIds) {
    try {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        details: { message: input.message, ...(input.details ?? {}) },
      });
      written += 1;
    } catch (err) {
      logger.warn({ err, companyId, action: input.action }, "failed to write security notice to activity log");
    }
  }
  return written;
}

async function reportDiff(db: Db, diff: AdminAuthDiff): Promise<string[]> {
  const userIds = [
    ...diff.added.map((e) => e.userId),
    ...diff.removed.map((e) => e.userId),
    ...diff.emailChanged.map((e) => e.userId),
    ...diff.passwordChanged.map((e) => e.userId),
  ];
  const labels = await loadUserLabels(db, Array.from(new Set(userIds)));
  const who = (userId: string, fallbackEmail: string | null) =>
    describeUser({ userId, name: labels.get(userId)?.name ?? null, email: labels.get(userId)?.email ?? fallbackEmail });
  const messages: string[] = [];
  for (const entry of diff.added) {
    const message = buildAdminAddedOutsideAppNotice({ who: who(entry.userId, entry.email) });
    messages.push(message);
    await notifyOperators(db, {
      action: ADMIN_AUTH_ACTIONS.adminAddedOutsideApp,
      entityType: "user",
      entityId: entry.userId,
      message,
      details: { userId: entry.userId, email: entry.email, source: "outside_app" },
    });
  }
  for (const entry of diff.removed) {
    const message = buildAdminRemovedOutsideAppNotice({ who: who(entry.userId, entry.email) });
    messages.push(message);
    await notifyOperators(db, {
      action: ADMIN_AUTH_ACTIONS.adminRemovedOutsideApp,
      entityType: "user",
      entityId: entry.userId,
      message,
      details: { userId: entry.userId, email: entry.email, source: "outside_app" },
    });
  }
  for (const entry of diff.emailChanged) {
    const message = buildEmailChangedOutsideAppNotice({ who: who(entry.userId, entry.to), from: entry.from, to: entry.to });
    messages.push(message);
    await notifyOperators(db, {
      action: ADMIN_AUTH_ACTIONS.emailChangedOutsideApp,
      entityType: "user",
      entityId: entry.userId,
      message,
      details: { userId: entry.userId, from: entry.from, to: entry.to, source: "outside_app" },
    });
  }
  for (const entry of diff.passwordChanged) {
    const message = buildPasswordChangedOutsideAppNotice({ who: who(entry.userId, entry.email) });
    messages.push(message);
    await notifyOperators(db, {
      action: ADMIN_AUTH_ACTIONS.passwordChangedOutsideApp,
      entityType: "user",
      entityId: entry.userId,
      message,
      details: { userId: entry.userId, email: entry.email, source: "outside_app" },
    });
  }
  return messages;
}

export interface ReconcileAdminAuthOptions {
  secret: string | null;
  trigger: AdminAuthCheckTrigger;
  now?: Date;
  /** Changes the caller already reported (they went through the app); not re-reported as out-of-band. */
  expected?: ExpectedAdminAuthChange[];
}

/**
 * Compares the live admin set against the signed record. First run stores a
 * baseline silently; afterwards any unexplained difference becomes an operator
 * notice and the record is refreshed so the same difference is not reported
 * again on the next tick.
 */
export async function reconcileAdminAuthSnapshot(db: Db, opts: ReconcileAdminAuthOptions): Promise<AdminAuthCheckResult> {
  const now = opts.now ?? new Date();
  const current = await computeAdminAuthEntries(db);
  const stored = await loadAdminAuthRecord(db);

  const finish = async (status: AdminAuthCheckStatus, changes: number, notices: string[]) => {
    const lastCheck: AdminAuthLastCheck = { at: now.toISOString(), status, trigger: opts.trigger, changes };
    const snapshot =
      status === "unchanged" && stored.snapshot
        ? stored.snapshot
        : buildAdminAuthSnapshot(current, opts.secret, now);
    await storeAdminAuthRecord(db, { snapshot, lastCheck });
    return { status, checkedAt: now.toISOString(), changes, notices };
  };

  if (!stored.snapshot) {
    logger.info({ admins: current.length, trigger: opts.trigger }, "admin auth record: baseline taken");
    return finish("baseline", 0, []);
  }

  if (!verifyAdminAuthSnapshot(stored.snapshot, opts.secret)) {
    const message = buildSnapshotTamperedNotice();
    await notifyOperators(db, {
      action: ADMIN_AUTH_ACTIONS.snapshotTampered,
      entityType: "instance_settings",
      entityId: ADMIN_AUTH_SNAPSHOT_KEY,
      message,
      details: { trigger: opts.trigger, storedAdmins: stored.snapshot.entries.length, liveAdmins: current.length },
    });
    return finish("tampered", 1, [message]);
  }

  const diff = removeExpectedChanges(diffAdminAuthSnapshots(stored.snapshot.entries, current), opts.expected ?? []);
  const changes = countAdminAuthDiff(diff);
  if (changes === 0) {
    const expectedCount = opts.expected?.length ?? 0;
    return finish(expectedCount > 0 ? "changed" : "unchanged", expectedCount, []);
  }
  const notices = await reportDiff(db, diff);
  return finish("changed", changes + (opts.expected?.length ?? 0), notices);
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export async function revokeSessionsForUser(db: Db, userId: string, opts?: { exceptSessionId?: string | null }): Promise<number> {
  const where = opts?.exceptSessionId
    ? and(eq(authSessions.userId, userId), ne(authSessions.id, opts.exceptSessionId))
    : eq(authSessions.userId, userId);
  const rows = await db.delete(authSessions).where(where).returning({ id: authSessions.id });
  return rows.length;
}

export async function revokeAllSessions(db: Db): Promise<number> {
  const rows = await db.delete(authSessions).returning({ id: authSessions.id });
  return rows.length;
}

export async function revokeSessionById(db: Db, sessionId: string): Promise<{ id: string; userId: string } | null> {
  const rows = await db
    .delete(authSessions)
    .where(eq(authSessions.id, sessionId))
    .returning({ id: authSessions.id, userId: authSessions.userId });
  return rows[0] ?? null;
}

function normalizeAddress(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export interface SessionCreatedInput {
  id: string;
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface SessionCreatedOutcome {
  notified: boolean;
  reason: "not_admin" | "known_device" | "new_device" | "first_session";
}

/**
 * Called after better-auth stores a new session. Only instance admins are
 * watched. "Known" means both the network address and the device (user agent)
 * appear on at least one of the admin's *other* open sessions -- so a laptop
 * seen from home and from the office stays quiet, while an unfamiliar browser
 * or address gets a notice.
 */
export async function recordAdminSessionCreated(db: Db, session: SessionCreatedInput): Promise<SessionCreatedOutcome> {
  if (!(await isInstanceAdmin(db, session.userId))) return { notified: false, reason: "not_admin" };
  const others = await db
    .select({ ipAddress: authSessions.ipAddress, userAgent: authSessions.userAgent })
    .from(authSessions)
    .where(and(eq(authSessions.userId, session.userId), ne(authSessions.id, session.id), gt(authSessions.expiresAt, new Date())));
  const ip = normalizeAddress(session.ipAddress);
  const ua = normalizeAddress(session.userAgent);
  const seenIp = others.some((row) => normalizeAddress(row.ipAddress) === ip);
  const seenUa = others.some((row) => normalizeAddress(row.userAgent) === ua);
  const firstSession = others.length === 0;
  if (!firstSession && seenIp && seenUa) return { notified: false, reason: "known_device" };

  const labels = await loadUserLabels(db, [session.userId]);
  const label = labels.get(session.userId);
  const device = describeUserAgent(session.userAgent);
  const message = buildNewDeviceSignInNotice({
    who: describeUser({ userId: session.userId, name: label?.name ?? null, email: label?.email ?? null }),
    ipAddress: session.ipAddress?.trim() || null,
    device,
    newIp: !seenIp,
    newDevice: !seenUa,
    firstSession,
  });
  await notifyOperators(db, {
    action: ADMIN_AUTH_ACTIONS.adminNewDeviceSignIn,
    entityType: "user",
    entityId: session.userId,
    message,
    details: {
      userId: session.userId,
      sessionId: session.id,
      ipAddress: session.ipAddress?.trim() || null,
      device,
      newIp: !seenIp,
      newDevice: !seenUa,
      firstSession,
    },
  });
  return { notified: true, reason: firstSession ? "first_session" : "new_device" };
}

// ─── Changes that went through the app ───────────────────────────────────────

export async function recordAdminSetChangedViaApp(
  db: Db,
  input: {
    secret: string | null;
    userId: string;
    change: "promoted" | "demoted";
    actor: AdminAuthActorInfo;
    sessionsRevoked: number;
  },
): Promise<void> {
  const labels = await loadUserLabels(db, [input.userId, input.actor.actorId]);
  const target = labels.get(input.userId);
  const who = describeUser({ userId: input.userId, name: target?.name ?? null, email: target?.email ?? null });
  const actorLabel = labels.get(input.actor.actorId);
  const by =
    input.actor.actorType === "user"
      ? describeUser({ userId: input.actor.actorId, name: input.actor.actorName ?? actorLabel?.name ?? null, email: actorLabel?.email ?? null })
      : "Paperclip";
  const message =
    input.change === "promoted"
      ? buildAdminPromotedNotice({ who, by, sessionsRevoked: input.sessionsRevoked })
      : buildAdminDemotedNotice({ who, by, sessionsRevoked: input.sessionsRevoked });
  await notifyOperators(db, {
    action: input.change === "promoted" ? ADMIN_AUTH_ACTIONS.adminPromoted : ADMIN_AUTH_ACTIONS.adminDemoted,
    entityType: "user",
    entityId: input.userId,
    message,
    details: { userId: input.userId, sessionsRevoked: input.sessionsRevoked, source: "app" },
    actor: input.actor,
  });
  await reconcileAdminAuthSnapshot(db, {
    secret: input.secret,
    trigger: "app_change",
    expected: [{ kind: input.change === "promoted" ? "added" : "removed", userId: input.userId }],
  });
}

export async function recordPasswordChangedViaApp(db: Db, input: { secret: string | null; userId: string }): Promise<void> {
  const [labels, admin] = await Promise.all([loadUserLabels(db, [input.userId]), isInstanceAdmin(db, input.userId)]);
  const label = labels.get(input.userId);
  const message = buildPasswordChangedNotice({
    who: describeUser({ userId: input.userId, name: label?.name ?? null, email: label?.email ?? null }),
    isInstanceAdmin: admin,
  });
  await notifyOperators(db, {
    action: ADMIN_AUTH_ACTIONS.passwordChanged,
    entityType: "user",
    entityId: input.userId,
    message,
    details: { userId: input.userId, isInstanceAdmin: admin, source: "app" },
    actor: { actorType: "user", actorId: input.userId },
  });
  if (admin) {
    await reconcileAdminAuthSnapshot(db, {
      secret: input.secret,
      trigger: "app_change",
      expected: [{ kind: "password", userId: input.userId }],
    });
  }
}

/**
 * better-auth's user.update hook: fires for any profile update it performs.
 * Only an email change is security-relevant; the previous email is read from
 * the signed record (admins) or skipped (non-admins have no record to compare
 * against, and better-auth's change-email endpoint is disabled here anyway).
 */
export async function recordUserUpdatedViaApp(
  db: Db,
  input: { secret: string | null; userId: string; email?: string | null; name?: string | null },
): Promise<void> {
  const admin = await isInstanceAdmin(db, input.userId);
  if (!admin) return;
  const stored = await loadAdminAuthRecord(db);
  const before = stored.snapshot?.entries.find((entry) => entry.userId === input.userId);
  if (!before || input.email === undefined || (before.email ?? null) === (input.email ?? null)) return;
  const message = buildEmailChangedNotice({
    who: describeUser({ userId: input.userId, name: input.name ?? null, email: input.email ?? null }),
    from: before.email,
    to: input.email ?? null,
    isInstanceAdmin: true,
  });
  await notifyOperators(db, {
    action: ADMIN_AUTH_ACTIONS.emailChanged,
    entityType: "user",
    entityId: input.userId,
    message,
    details: { userId: input.userId, from: before.email, to: input.email ?? null, source: "app" },
    actor: { actorType: "user", actorId: input.userId },
  });
  await reconcileAdminAuthSnapshot(db, {
    secret: input.secret,
    trigger: "app_change",
    expected: [{ kind: "email", userId: input.userId }],
  });
}

// ─── Overview for the Security settings page ─────────────────────────────────

export async function buildInstanceSecurityOverview(
  db: Db,
  input: { currentSessionId: string | null; checkIntervalMinutes: number; secret: string | null; now?: Date },
): Promise<InstanceSecurityOverview> {
  const now = input.now ?? new Date();
  const [adminRows, sessionRows, stored] = await Promise.all([
    db
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, INSTANCE_ADMIN_ROLE)),
    db
      .select({
        id: authSessions.id,
        userId: authSessions.userId,
        ipAddress: authSessions.ipAddress,
        userAgent: authSessions.userAgent,
        createdAt: authSessions.createdAt,
        updatedAt: authSessions.updatedAt,
        expiresAt: authSessions.expiresAt,
      })
      .from(authSessions)
      .where(gt(authSessions.expiresAt, now)),
    loadAdminAuthRecord(db),
  ]);
  const adminIds = new Set(adminRows.map((row) => row.userId));
  const userIds = Array.from(new Set([...adminIds, ...sessionRows.map((row) => row.userId)]));
  const labels = await loadUserLabels(db, userIds);

  const sessions = sessionRows
    .map((row) => ({
      id: row.id,
      userId: row.userId,
      userName: labels.get(row.userId)?.name ?? null,
      userEmail: labels.get(row.userId)?.email ?? null,
      isInstanceAdmin: adminIds.has(row.userId),
      isCurrent: input.currentSessionId !== null && row.id === input.currentSessionId,
      ipAddress: row.ipAddress?.trim() || null,
      userAgent: row.userAgent?.trim() || null,
      device: describeUserAgent(row.userAgent),
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.updatedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

  const admins = Array.from(adminIds)
    .map((userId) => {
      const own = sessions.filter((session) => session.userId === userId);
      return {
        userId,
        name: labels.get(userId)?.name ?? null,
        email: labels.get(userId)?.email ?? null,
        sessionCount: own.length,
        lastSeenAt: own[0]?.lastSeenAt ?? null,
      };
    })
    .sort((a, b) => (a.name ?? a.email ?? a.userId).localeCompare(b.name ?? b.email ?? b.userId));

  return {
    admins,
    sessions,
    snapshotTakenAt: stored.snapshot?.takenAt || null,
    lastCheck: stored.lastCheck,
    checkIntervalMinutes: input.checkIntervalMinutes,
    snapshotSigned: input.secret !== null,
  };
}
