import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { userTotpSecrets, userRecoveryCodes, totpSessionTokens, authUsers } from "@paperclipai/db";
import * as speakeasy from "speakeasy";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

// DUR-4180: the raw base32 TOTP secret must never be written to the
// database in plaintext (it is the only thing standing between an attacker
// with DB read access and a full TOTP bypass). We seal it with the same
// local_encrypted AES-256-GCM scheme already used elsewhere in this codebase
// for exactly this kind of "single sensitive field, not part of the
// company secrets vault" case (see instance-claude-auth.ts's
// sealToken/unsealToken for the identical pattern). The sealed prefix marks
// the on-disk format so a future migration to a different scheme can be
// detected instead of silently misparsed.
const SEALED_TOTP_SECRET_PREFIX = "totp_secret:local_encrypted_v1:";

async function sealTotpSecret(secret: string): Promise<string> {
  const prepared = await localEncryptedProvider.createSecret({ value: secret });
  return `${SEALED_TOTP_SECRET_PREFIX}${JSON.stringify(prepared.material)}`;
}

async function unsealTotpSecret(sealed: string): Promise<string> {
  if (!sealed.startsWith(SEALED_TOTP_SECRET_PREFIX)) {
    // Defence in depth for any pre-existing plaintext row from before this
    // fix: treat anything without the sealed prefix as already-plaintext
    // rather than throwing, so existing (test/dev) rows do not hard-break.
    return sealed;
  }
  const material = JSON.parse(sealed.slice(SEALED_TOTP_SECRET_PREFIX.length)) as Record<string, unknown>;
  return localEncryptedProvider.resolveVersion({ material, externalRef: null });
}

export interface TotpSetupResponse {
  secret: string;
  qrCode: string;
  recoveryCodes: string[];
}

export interface TotpVerifyResponse {
  valid: boolean;
  totalCodes: number;
  remainingCodes: number;
  /** True when the attempt was refused because the user is locked out. */
  locked?: boolean;
  /** Seconds until the lockout ends (only set when locked). */
  retryAfterSeconds?: number;
}

// DUR-4297: after this many failed attempts the factor is locked.
export const TOTP_MAX_FAILED_ATTEMPTS = 5;
export const TOTP_LOCKOUT_MS = 15 * 60 * 1000;
const TOTP_STEP_SECONDS = 30;
const TOTP_WINDOW = 2;

export class TotpVerificationError extends Error {
  constructor(
    public readonly code: "invalid_code" | "locked" | "already_enabled" | "not_enabled",
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TotpVerificationError";
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function generateRecoveryCodes(count: number = 10): string[] {
  return Array(count)
    .fill(null)
    .map(() => {
      const code = randomBytes(4).toString("hex").toUpperCase();
      return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
    });
}

export function totpService(db: Db) {
  async function initiateTotpSetup(userId: string, userEmail: string) {
    const secret = speakeasy.generateSecret({
      name: `Paperclip (${userEmail})`,
      issuer: "Paperclip",
      length: 32,
      otpauth_url: true,
    });

    // speakeasy only returns the otpauth:// URL; rendering it as a scannable
    // QR image is a separate, not-yet-implemented concern (see DUR-4176).
    const qrCode = secret.otpauth_url || "";

    if (!secret.base32) {
      throw new Error("Failed to generate TOTP secret");
    }

    const recoveryCodes = generateRecoveryCodes();

    return {
      secret: secret.base32,
      qrCode,
      recoveryCodes,
    } as TotpSetupResponse;
  }

  // Returns the absolute time-step the token matched, or null.
  function matchTotpStep(secret: string, token: string): number | null {
    const result = speakeasy.totp.verifyDelta({
      secret,
      encoding: "base32",
      token,
      window: TOTP_WINDOW,
      step: TOTP_STEP_SECONDS,
    });
    if (!result) return null;
    return Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + result.delta;
  }

  async function verifyTotpToken(secret: string, token: string): Promise<boolean> {
    return matchTotpStep(secret, token) !== null;
  }

  // Atomically charges one attempt against the user's active factor BEFORE the
  // code is checked, so parallel guesses cannot exceed the limit. Returns the
  // factor row, or a lockout result. A correct code refunds via resetAttempts.
  async function chargeAttempt(userId: string): Promise<
    | { ok: true; id: string; secret: string; verified: boolean; lastUsedStep: number | null }
    | { ok: false; locked: boolean; retryAfterSeconds?: number }
  > {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + TOTP_LOCKOUT_MS);
    const rows = await db
      .update(userTotpSecrets)
      .set({
        failedAttempts: sql`CASE WHEN ${userTotpSecrets.lockedUntil} IS NOT NULL THEN 1 ELSE ${userTotpSecrets.failedAttempts} + 1 END`,
        lockedUntil: sql`CASE WHEN (CASE WHEN ${userTotpSecrets.lockedUntil} IS NOT NULL THEN 1 ELSE ${userTotpSecrets.failedAttempts} + 1 END) >= ${TOTP_MAX_FAILED_ATTEMPTS} THEN ${lockUntil.toISOString()}::timestamptz ELSE NULL END`,
        updatedAt: now,
      })
      .where(
        and(
          eq(userTotpSecrets.userId, userId),
          isNull(userTotpSecrets.disabledAt),
          sql`(${userTotpSecrets.lockedUntil} IS NULL OR ${userTotpSecrets.lockedUntil} <= ${now.toISOString()}::timestamptz)`,
        ),
      )
      .returning({
        id: userTotpSecrets.id,
        secret: userTotpSecrets.secret,
        verified: userTotpSecrets.verified,
        lastUsedStep: userTotpSecrets.lastUsedStep,
      });
    if (rows[0]) return { ok: true, ...rows[0] };

    const active = await db
      .select({ lockedUntil: userTotpSecrets.lockedUntil })
      .from(userTotpSecrets)
      .where(and(eq(userTotpSecrets.userId, userId), isNull(userTotpSecrets.disabledAt)))
      .then((r) => r[0] ?? null);
    if (active?.lockedUntil) {
      return {
        ok: false,
        locked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((active.lockedUntil.getTime() - now.getTime()) / 1000)),
      };
    }
    return { ok: false, locked: false };
  }

  async function resetAttempts(id: string) {
    await db
      .update(userTotpSecrets)
      .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(userTotpSecrets.id, id));
  }

  async function completeTotpSetup(userId: string, secret: string, token: string, recoveryCodes: string[]) {
    // DUR-4297: replacing/resetting an enabled factor must go through
    // disableTotpForUser, which demands a current TOTP or recovery code.
    if (await isTotpEnabled(userId)) {
      throw new TotpVerificationError("already_enabled", "Two-factor authentication is already enabled");
    }

    // Verify the token works with this secret
    const matchedStep = matchTotpStep(secret, token);
    if (matchedStep === null) {
      throw new Error("Invalid TOTP token");
    }

    const now = new Date();
    const setupId = `totp_${randomBytes(16).toString("hex")}`;
    const sealedSecret = await sealTotpSecret(secret);

    // Store the TOTP secret (verified), encrypted at rest -- never the raw
    // base32 value (DUR-4180).
    await db.insert(userTotpSecrets).values({
      id: setupId,
      userId,
      secret: sealedSecret,
      verified: true,
      enabledAt: now,
      // The setup code is spent: it cannot be replayed to log in.
      lastUsedStep: matchedStep,
      createdAt: now,
      updatedAt: now,
    });

    // Store recovery codes (hashed)
    const recoveryCodeRecords = recoveryCodes.map((code, index) => ({
      id: `recovery_${randomBytes(16).toString("hex")}`,
      userId,
      codeHash: hashCode(code),
      createdAt: now,
      updatedAt: now,
    }));

    await db.insert(userRecoveryCodes).values(recoveryCodeRecords);

    // Update user's TOTP verified timestamp
    await db.update(authUsers).set({ totpVerifiedAt: now }).where(eq(authUsers.id, userId));

    return { success: true };
  }

  async function getTotpStatus(userId: string) {
    const secret = await db
      .select({ id: userTotpSecrets.id, verified: userTotpSecrets.verified, enabledAt: userTotpSecrets.enabledAt })
      .from(userTotpSecrets)
      .where(and(eq(userTotpSecrets.userId, userId), isNull(userTotpSecrets.disabledAt)))
      .then((rows) => rows[0] ?? null);

    const recoveryCodes = await db
      .select({ id: userRecoveryCodes.id, usedAt: userRecoveryCodes.usedAt })
      .from(userRecoveryCodes)
      .where(eq(userRecoveryCodes.userId, userId))
      .then((rows) => rows);

    return {
      enabled: !!secret?.verified,
      enabledAt: secret?.enabledAt,
      recoveryCodesTotal: recoveryCodes.length,
      recoveryCodesUsed: recoveryCodes.filter((c) => c.usedAt).length,
      recoveryCodesRemaining: recoveryCodes.filter((c) => !c.usedAt).length,
    };
  }

  async function countRecoveryCodes(userId: string) {
    return db
      .select({ id: userRecoveryCodes.id, usedAt: userRecoveryCodes.usedAt })
      .from(userRecoveryCodes)
      .where(eq(userRecoveryCodes.userId, userId))
      .then((rows) => ({
        total: rows.length,
        remaining: rows.filter((r) => !r.usedAt).length,
      }));
  }

  async function validateAndConsumeTotpToken(
    userId: string,
    token: string,
    isRecoveryCode: boolean = false,
  ): Promise<TotpVerifyResponse> {
    const none = { valid: false, totalCodes: 0, remainingCodes: 0 };
    const charge = await chargeAttempt(userId);
    if (!charge.ok) {
      return charge.locked
        ? { ...none, locked: true, retryAfterSeconds: charge.retryAfterSeconds }
        : none;
    }
    if (!charge.verified) return none;

    if (isRecoveryCode) {
      const codeHashBuf = Buffer.from(hashCode(token), "hex");
      const candidates = await db
        .select({ id: userRecoveryCodes.id, codeHash: userRecoveryCodes.codeHash })
        .from(userRecoveryCodes)
        .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));

      const recoveryCode = candidates.find((candidate) => {
        const candidateHashBuf = Buffer.from(candidate.codeHash, "hex");
        return candidateHashBuf.length === codeHashBuf.length && timingSafeEqual(candidateHashBuf, codeHashBuf);
      });
      if (!recoveryCode) return none;

      // Atomic single-use: only one concurrent caller can flip usedAt.
      const claimed = await db
        .update(userRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(userRecoveryCodes.id, recoveryCode.id), isNull(userRecoveryCodes.usedAt)))
        .returning({ id: userRecoveryCodes.id });
      if (claimed.length === 0) return none;

      await resetAttempts(charge.id);
      const counts = await countRecoveryCodes(userId);
      return { valid: true, totalCodes: counts.total, remainingCodes: counts.remaining };
    }

    const plaintextSecret = await unsealTotpSecret(charge.secret);
    const step = matchTotpStep(plaintextSecret, token);
    if (step === null) return none;

    // Replay protection: atomically advance last_used_step; a code from a step
    // already used (or older) updates no row and is rejected.
    const advanced = await db
      .update(userTotpSecrets)
      .set({ lastUsedStep: step, failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
      .where(
        and(
          eq(userTotpSecrets.id, charge.id),
          sql`(${userTotpSecrets.lastUsedStep} IS NULL OR ${userTotpSecrets.lastUsedStep} < ${step})`,
        ),
      )
      .returning({ id: userTotpSecrets.id });
    if (advanced.length === 0) return none;

    const counts = await countRecoveryCodes(userId);
    return { valid: true, totalCodes: counts.total, remainingCodes: counts.remaining };
  }

  // DUR-4297: disabling/resetting requires a valid current TOTP or recovery
  // code, enforced here (not only in the route). Shares the attempt limiter.
  async function disableTotpForUser(
    userId: string,
    proof: { token: string; isRecoveryCode?: boolean },
  ) {
    if (!(await isTotpEnabled(userId))) return { disabled: false };
    const result = await validateAndConsumeTotpToken(userId, proof?.token ?? "", proof?.isRecoveryCode ?? false);
    if (result.locked) {
      throw new TotpVerificationError("locked", "Too many failed attempts", result.retryAfterSeconds);
    }
    if (!result.valid) {
      throw new TotpVerificationError("invalid_code", "Invalid verification code");
    }
    const now = new Date();

    // Soft-delete TOTP secret
    await db
      .update(userTotpSecrets)
      .set({ disabledAt: now })
      .where(and(eq(userTotpSecrets.userId, userId), isNull(userTotpSecrets.disabledAt)));

    // Mark all recovery codes as used (retire them)
    await db
      .update(userRecoveryCodes)
      .set({ usedAt: now })
      .where(eq(userRecoveryCodes.userId, userId));

    // Clear TOTP verified timestamp
    await db.update(authUsers).set({ totpVerifiedAt: null }).where(eq(authUsers.id, userId));
    return { disabled: true };
  }

  // DUR-4304: replace every recovery code with a fresh set. Needs a valid
  // current TOTP or recovery code (shares the attempt limiter), so a signed-in
  // session alone cannot mint new codes. The old codes are deleted outright, so
  // none of them works afterwards. The new codes are returned once, in the clear.
  async function regenerateRecoveryCodes(
    userId: string,
    proof: { token: string; isRecoveryCode?: boolean },
  ): Promise<string[]> {
    if (!(await isTotpEnabled(userId))) {
      throw new TotpVerificationError("not_enabled", "Two-factor authentication is not enabled");
    }
    const result = await validateAndConsumeTotpToken(userId, proof?.token ?? "", proof?.isRecoveryCode ?? false);
    if (result.locked) {
      throw new TotpVerificationError("locked", "Too many failed attempts", result.retryAfterSeconds);
    }
    if (!result.valid) {
      throw new TotpVerificationError("invalid_code", "Invalid verification code");
    }
    const now = new Date();
    const fresh = generateRecoveryCodes();
    await db.transaction(async (tx) => {
      await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
      await tx.insert(userRecoveryCodes).values(
        fresh.map((code) => ({
          id: `recovery_${randomBytes(16).toString("hex")}`,
          userId,
          codeHash: hashCode(code),
          createdAt: now,
          updatedAt: now,
        })),
      );
    });
    return fresh;
  }

  async function recordTotpSessionVerification(userId: string, sessionId: string, ttlMs: number = 30 * 60 * 1000) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    const tokenId = `totp_session_${randomBytes(16).toString("hex")}`;

    await db.insert(totpSessionTokens).values({
      id: tokenId,
      userId,
      sessionId,
      verifiedAt: now,
      expiresAt,
      createdAt: now,
    });

    return tokenId;
  }

  async function verifySessionTotpStatus(userId: string, sessionId: string): Promise<boolean> {
    const now = new Date();

    const token = await db
      .select({ id: totpSessionTokens.id })
      .from(totpSessionTokens)
      .where(
        and(
          eq(totpSessionTokens.userId, userId),
          eq(totpSessionTokens.sessionId, sessionId),
          gte(totpSessionTokens.expiresAt, now),
        ),
      )
      .then((rows) => rows[0] ?? null);

    return !!token;
  }

  async function isTotpEnabled(userId: string): Promise<boolean> {
    const secret = await db
      .select({ id: userTotpSecrets.id })
      .from(userTotpSecrets)
      .where(and(eq(userTotpSecrets.userId, userId), isNull(userTotpSecrets.disabledAt)))
      .then((rows) => rows[0] ?? null);

    return !!secret;
  }

  return {
    initiateTotpSetup,
    verifyTotpToken,
    completeTotpSetup,
    getTotpStatus,
    validateAndConsumeTotpToken,
    disableTotpForUser,
    regenerateRecoveryCodes,
    recordTotpSessionVerification,
    verifySessionTotpStatus,
    isTotpEnabled,
  };
}
