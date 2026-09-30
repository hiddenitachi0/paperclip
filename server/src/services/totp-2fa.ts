import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gte, isNull } from "drizzle-orm";
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

  async function verifyTotpToken(secret: string, token: string): Promise<boolean> {
    return speakeasy.totp.verify({
      secret,
      encoding: "base32",
      token,
      window: 2,
    });
  }

  async function completeTotpSetup(userId: string, secret: string, token: string, recoveryCodes: string[]) {
    // Verify the token works with this secret
    const isValid = await verifyTotpToken(secret, token);
    if (!isValid) {
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

  async function validateAndConsumeTotpToken(
    userId: string,
    token: string,
    isRecoveryCode: boolean = false,
  ): Promise<TotpVerifyResponse> {
    if (isRecoveryCode) {
      const codeHash = hashCode(token);
      const codeHashBuf = Buffer.from(codeHash, "hex");
      const candidates = await db
        .select({ id: userRecoveryCodes.id, codeHash: userRecoveryCodes.codeHash, usedAt: userRecoveryCodes.usedAt })
        .from(userRecoveryCodes)
        .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));

      const recoveryCode = candidates.find((candidate) => {
        const candidateHashBuf = Buffer.from(candidate.codeHash, "hex");
        return candidateHashBuf.length === codeHashBuf.length && timingSafeEqual(candidateHashBuf, codeHashBuf);
      });

      if (!recoveryCode) {
        return { valid: false, totalCodes: 0, remainingCodes: 0 };
      }

      // Mark recovery code as used
      await db
        .update(userRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(eq(userRecoveryCodes.id, recoveryCode.id));

      // Get count of remaining codes
      const counts = await db
        .select({ id: userRecoveryCodes.id, usedAt: userRecoveryCodes.usedAt })
        .from(userRecoveryCodes)
        .where(eq(userRecoveryCodes.userId, userId))
        .then((rows) => ({
          total: rows.length,
          remaining: rows.filter((r) => !r.usedAt).length,
        }));

      return { valid: true, totalCodes: counts.total, remainingCodes: counts.remaining };
    }

    // Regular TOTP token
    const secret = await db
      .select({ secret: userTotpSecrets.secret, verified: userTotpSecrets.verified })
      .from(userTotpSecrets)
      .where(and(eq(userTotpSecrets.userId, userId), isNull(userTotpSecrets.disabledAt)))
      .then((rows) => rows[0] ?? null);

    if (!secret?.verified) {
      return { valid: false, totalCodes: 0, remainingCodes: 0 };
    }

    const plaintextSecret = await unsealTotpSecret(secret.secret);
    const isValid = await verifyTotpToken(plaintextSecret, token);

    if (!isValid) {
      return { valid: false, totalCodes: 0, remainingCodes: 0 };
    }

    // Get recovery code counts
    const counts = await db
      .select({ id: userRecoveryCodes.id, usedAt: userRecoveryCodes.usedAt })
      .from(userRecoveryCodes)
      .where(eq(userRecoveryCodes.userId, userId))
      .then((rows) => ({
        total: rows.length,
        remaining: rows.filter((r) => !r.usedAt).length,
      }));

    return { valid: true, totalCodes: counts.total, remainingCodes: counts.remaining };
  }

  async function disableTotpForUser(userId: string) {
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
    recordTotpSessionVerification,
    verifySessionTotpStatus,
    isTotpEnabled,
  };
}
