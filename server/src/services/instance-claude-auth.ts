/**
 * One-click Claude sign-in (Filip's long-standing ask): one instance-wide
 * Claude subscription token that every claude_local agent falls back to when
 * it has no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY of its own, so a new
 * agent or company needs no per-agent secret + binding to start working.
 *
 * Two ways in:
 *   - "Sign in with Claude": drives `claude setup-token` under a
 *     pseudo-terminal (see the adapter's signin.ts) — the operator opens the
 *     link, approves, pastes the code back, done.
 *   - "Paste a token": for a token made elsewhere with `claude setup-token`.
 * Both paths test the token with one real CLI call before it is stored.
 *
 * The token is sealed with the local_encrypted material scheme and is never
 * returned by any method except `resolveFallbackToken` (heartbeat only).
 * Board-only: an agent can never reach these routes.
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceClaudeAuth } from "@paperclipai/db";
import {
  CLAUDE_AUTH_EXPIRY_WARNING_DAYS,
  CLAUDE_AUTH_TOKEN_LIFETIME_DAYS,
  type ClaudeAuthHealth,
  type ClaudeAuthSource,
  type InstanceClaudeAuthStatus,
  type InstanceClaudeSignInSession,
} from "@paperclipai/shared";
import {
  automaticClaudeSignInSupport,
  looksLikeClaudeOAuthToken,
  readClaudeCliVersion,
  scrubClaudeTokens,
  startClaudeSignInSession,
  verifyClaudeOAuthToken,
  type ClaudeSignInSession,
  type ClaudeTokenVerification,
  type StartClaudeSignInSessionOptions,
} from "@paperclipai/adapter-claude-local/server";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

const SINGLETON_KEY = "default";
const SEALED_PREFIX = "instance-claude-auth:";
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a finished sign-in stays pollable before it is forgotten. */
const FINISHED_SIGNIN_RETENTION_MS = 15 * 60 * 1000;
/** `lastUsedAt` is informational; don't write it on every single run. */
const LAST_USED_WRITE_THROTTLE_MS = 5 * 60 * 1000;
export const CLAUDE_AUTH_FALLBACK_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

export interface InstanceClaudeAuthServiceDeps {
  command?: string;
  verifyToken?: (token: string) => Promise<ClaudeTokenVerification>;
  startSignIn?: (options: StartClaudeSignInSessionOptions) => ClaudeSignInSession;
  readCliVersion?: () => Promise<string | null>;
  automaticSupport?: () => { supported: boolean; reason: string | null };
  now?: () => Date;
}

type ActiveSignIn = {
  id: string;
  userId: string | null;
  session: ClaudeSignInSession;
  finishedAt: number | null;
};

// Process-wide: the route-created and heartbeat-created service instances
// must see the same in-flight sign-in (there is one CLI process behind it).
let activeSignIn: ActiveSignIn | null = null;
let lastUsedWriteAt = 0;

export function resetInstanceClaudeAuthStateForTests() {
  if (activeSignIn) {
    try {
      activeSignIn.session.cancel("reset");
    } catch {
      // ignore
    }
  }
  activeSignIn = null;
  lastUsedWriteAt = 0;
}

async function sealToken(token: string): Promise<string> {
  const prepared = await localEncryptedProvider.createSecret({ value: token });
  return `${SEALED_PREFIX}${JSON.stringify(prepared.material)}`;
}

async function unsealToken(sealed: string): Promise<string> {
  if (!sealed.startsWith(SEALED_PREFIX)) {
    throw badRequest("Stored Claude sign-in is in an unknown format");
  }
  const material = JSON.parse(sealed.slice(SEALED_PREFIX.length)) as Record<string, unknown>;
  return localEncryptedProvider.resolveVersion({ material, externalRef: null });
}

function fingerprintOf(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function daysUntil(date: Date, now: Date): number {
  return Math.ceil((date.getTime() - now.getTime()) / DAY_MS);
}

function headlineFor(health: ClaudeAuthHealth, expiresInDays: number | null): string {
  switch (health) {
    case "not_configured":
      return "Not signed in. Claude agents only work if each one has its own token until you sign in here.";
    case "ok":
      return "Signed in. Claude agents without a token of their own use this sign-in.";
    case "unverified":
      return "Signed in, but this token has not been tested yet. Click \"Check now\".";
    case "expiring_soon":
      return `Signed in, but this sign-in expires in about ${Math.max(0, expiresInDays ?? 0)} day${expiresInDays === 1 ? "" : "s"}. Sign in again soon so agents keep working.`;
    case "expired":
      return "This sign-in has expired. Sign in again so Claude agents keep working.";
    case "check_failed":
      return "Claude rejected this sign-in the last time it was used or checked. Sign in again.";
  }
}

export function instanceClaudeAuthService(db: Db, deps: InstanceClaudeAuthServiceDeps = {}) {
  const command = deps.command?.trim() || "claude";
  const now = deps.now ?? (() => new Date());
  const verifyToken = deps.verifyToken ?? ((token: string) => verifyClaudeOAuthToken({ token, command }));
  const startSignIn = deps.startSignIn ?? ((options: StartClaudeSignInSessionOptions) => startClaudeSignInSession({ ...options, command }));
  const readCliVersion = deps.readCliVersion ?? (() => readClaudeCliVersion(command));
  const automaticSupport = deps.automaticSupport ?? automaticClaudeSignInSupport;

  async function getRow() {
    const rows = await db
      .select()
      .from(instanceClaudeAuth)
      .where(eq(instanceClaudeAuth.singletonKey, SINGLETON_KEY))
      .limit(1);
    return rows[0] ?? null;
  }

  function activeSignInSnapshot(): InstanceClaudeSignInSession | null {
    if (!activeSignIn) return null;
    const snapshot = activeSignIn.session.snapshot();
    const terminal = snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "cancelled";
    if (terminal) {
      if (activeSignIn.finishedAt === null) activeSignIn.finishedAt = Date.now();
      if (Date.now() - activeSignIn.finishedAt > FINISHED_SIGNIN_RETENTION_MS) {
        activeSignIn = null;
        return null;
      }
    }
    return { id: activeSignIn.id, ...snapshot };
  }

  async function getStatus(): Promise<InstanceClaudeAuthStatus> {
    const [row, version] = await Promise.all([getRow(), readCliVersion().catch(() => null)]);
    const support = automaticSupport();
    const current = now();
    const base = {
      cli: { command, version },
      automaticSignIn: support,
      activeSignIn: activeSignInSnapshot(),
    };
    if (!row) {
      return {
        configured: false,
        health: "not_configured",
        headline: headlineFor("not_configured", null),
        fingerprint: null,
        source: null,
        savedAt: null,
        savedByUserId: null,
        expiresAt: null,
        expiresInDays: null,
        lastCheckAt: null,
        lastCheckOk: null,
        lastCheckMessage: null,
        lastUsedAt: null,
        lastAuthFailureAt: null,
        ...base,
      };
    }
    const expiresInDays = row.expiresAt ? daysUntil(row.expiresAt, current) : null;
    const authFailedSinceLastCheck =
      row.lastAuthFailureAt != null &&
      (row.lastCheckAt == null || row.lastAuthFailureAt.getTime() > row.lastCheckAt.getTime());
    let health: ClaudeAuthHealth;
    if (expiresInDays !== null && expiresInDays <= 0) health = "expired";
    else if (row.lastCheckOk === false || authFailedSinceLastCheck) health = "check_failed";
    else if (expiresInDays !== null && expiresInDays <= CLAUDE_AUTH_EXPIRY_WARNING_DAYS) health = "expiring_soon";
    else if (row.lastCheckOk == null) health = "unverified";
    else health = "ok";
    return {
      configured: true,
      health,
      headline: headlineFor(health, expiresInDays),
      fingerprint: row.fingerprintSha256.slice(0, 12),
      source: row.source,
      savedAt: row.savedAt.toISOString(),
      savedByUserId: row.savedByUserId,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      expiresInDays,
      lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
      lastCheckOk: row.lastCheckOk,
      lastCheckMessage: row.lastCheckMessage,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      lastAuthFailureAt: row.lastAuthFailureAt?.toISOString() ?? null,
      ...base,
    };
  }

  async function storeVerifiedToken(input: {
    token: string;
    source: ClaudeAuthSource;
    userId: string | null;
    verification: ClaudeTokenVerification;
  }) {
    const current = now();
    const sealed = await sealToken(input.token);
    const values = {
      tokenSealed: sealed,
      fingerprintSha256: fingerprintOf(input.token),
      source: input.source,
      savedByUserId: input.userId,
      savedAt: current,
      expiresAt: new Date(current.getTime() + CLAUDE_AUTH_TOKEN_LIFETIME_DAYS * DAY_MS),
      lastCheckAt: current,
      lastCheckOk: true,
      lastCheckMessage: scrubClaudeTokens(input.verification.message),
      lastAuthFailureAt: null,
      updatedAt: current,
    };
    const existing = await getRow();
    if (existing) {
      await db.update(instanceClaudeAuth).set(values).where(eq(instanceClaudeAuth.id, existing.id));
    } else {
      await db.insert(instanceClaudeAuth).values({ singletonKey: SINGLETON_KEY, ...values });
    }
  }

  /**
   * Validate → test with one CLI call → seal → store. Throws 422 with a
   * plain-language reason (never the token) when Claude rejects it.
   */
  async function saveToken(input: { token: string; source: ClaudeAuthSource; userId: string | null }) {
    const token = input.token.trim();
    if (!looksLikeClaudeOAuthToken(token)) {
      throw unprocessable(
        "That does not look like a Claude subscription token. It should start with sk-ant-oat01- and be one long line with no spaces.",
      );
    }
    const verification = await verifyToken(token);
    if (!verification.ok) {
      throw unprocessable(scrubClaudeTokens(verification.message), { authRejected: verification.authRejected });
    }
    await storeVerifiedToken({ token, source: input.source, userId: input.userId, verification });
    return getStatus();
  }

  /** Re-test the stored token now and record the outcome. */
  async function checkNow() {
    const row = await getRow();
    if (!row) throw notFound("No Claude sign-in has been saved yet.");
    const token = await unsealToken(row.tokenSealed);
    const verification = await verifyToken(token);
    const current = now();
    await db
      .update(instanceClaudeAuth)
      .set({
        lastCheckAt: current,
        lastCheckOk: verification.ok,
        lastCheckMessage: scrubClaudeTokens(verification.message),
        ...(verification.ok ? { lastAuthFailureAt: null } : {}),
        updatedAt: current,
      })
      .where(eq(instanceClaudeAuth.id, row.id));
    return getStatus();
  }

  async function clear() {
    const row = await getRow();
    if (row) await db.delete(instanceClaudeAuth).where(eq(instanceClaudeAuth.id, row.id));
    return getStatus();
  }

  /**
   * Heartbeat-only: the plaintext token for a run, or null when none is
   * saved. Also bumps `lastUsedAt` (throttled) so the page can show that
   * agents really are using it.
   */
  async function resolveFallbackToken(): Promise<string | null> {
    const row = await getRow();
    if (!row) return null;
    let token: string;
    try {
      token = await unsealToken(row.tokenSealed);
    } catch (err) {
      console.warn(
        `[instance-claude-auth] could not unseal the instance-wide Claude token: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    const nowMs = Date.now();
    if (nowMs - lastUsedWriteAt > LAST_USED_WRITE_THROTTLE_MS) {
      lastUsedWriteAt = nowMs;
      const current = now();
      await db
        .update(instanceClaudeAuth)
        .set({ lastUsedAt: current, updatedAt: current })
        .where(eq(instanceClaudeAuth.id, row.id))
        .catch(() => undefined);
    }
    return token;
  }

  /** Heartbeat-only: a run that used the fallback token was told to log in. */
  async function markAuthFailure() {
    const row = await getRow();
    if (!row) return;
    const current = now();
    await db
      .update(instanceClaudeAuth)
      .set({ lastAuthFailureAt: current, updatedAt: current })
      .where(eq(instanceClaudeAuth.id, row.id));
  }

  function startInteractiveSignIn(input: { userId: string | null }): InstanceClaudeSignInSession {
    const support = automaticSupport();
    if (!support.supported) {
      throw unprocessable(support.reason ?? "Automatic sign-in is not available on this server.");
    }
    if (activeSignIn) {
      const status = activeSignIn.session.snapshot().status;
      if (status === "starting" || status === "awaiting_code" || status === "exchanging") {
        activeSignIn.session.cancel("Replaced by a newer sign-in attempt.");
      }
      activeSignIn = null;
    }
    const id = crypto.randomUUID();
    const session = startSignIn({
      onToken: async (token) => {
        const verification = await verifyToken(token);
        if (!verification.ok) {
          throw new Error(scrubClaudeTokens(verification.message));
        }
        await storeVerifiedToken({ token, source: "signin", userId: input.userId, verification });
      },
    });
    activeSignIn = { id, userId: input.userId, session, finishedAt: null };
    return { id, ...session.snapshot() };
  }

  function requireSignIn(id: string): ActiveSignIn {
    const snapshot = activeSignInSnapshot();
    if (!activeSignIn || !snapshot || activeSignIn.id !== id) {
      throw notFound("That sign-in attempt is no longer available. Start a new one.");
    }
    return activeSignIn;
  }

  function getSignIn(id: string): InstanceClaudeSignInSession {
    const active = requireSignIn(id);
    return { id: active.id, ...active.session.snapshot() };
  }

  function submitSignInCode(id: string, code: string): InstanceClaudeSignInSession {
    const active = requireSignIn(id);
    try {
      active.session.submitCode(code);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Could not use that code.");
    }
    return { id: active.id, ...active.session.snapshot() };
  }

  function cancelSignIn(id: string): InstanceClaudeSignInSession {
    const active = requireSignIn(id);
    active.session.cancel("Sign-in cancelled.");
    return { id: active.id, ...active.session.snapshot() };
  }

  return {
    getStatus,
    saveToken,
    checkNow,
    clear,
    resolveFallbackToken,
    markAuthFailure,
    startInteractiveSignIn,
    getSignIn,
    submitSignInCode,
    cancelSignIn,
  };
}

export type InstanceClaudeAuthService = ReturnType<typeof instanceClaudeAuthService>;
