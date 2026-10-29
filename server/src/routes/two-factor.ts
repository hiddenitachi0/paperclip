import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authSessions, companyMemberships } from "@paperclipai/db";
import {
  twoFactorEnrollVerifySchema,
  twoFactorProofSchema,
  type TwoFactorStatus,
} from "@paperclipai/shared";
import { conflict, forbidden, HttpError, notFound, tooManyRequests, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { isTrustedBoardMutationRequest } from "../middleware/board-mutation-guard.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/activity-log.js";
import { totpService, TotpVerificationError } from "../services/totp-2fa.js";
import { openTotpEnrollment, sealTotpEnrollment } from "../services/totp-enrollment-token.js";
import {
  getPendingTwoFactor,
  TWO_FACTOR_PENDING_TTL_MS,
  TWO_FACTOR_VERIFIED_TTL_MS,
} from "../auth/two-factor-gate.js";

// DUR-4304: HTTP surface of the board two-factor service (services/totp-2fa.ts),
// mounted at /api/auth/2fa. Everything here is behind PAPERCLIP_TWO_FACTOR_ENABLED:
// with the flag off every route is a plain 404 and sign-in is untouched.
//
// What a caller is allowed to be:
//   - "pending": signed in with a password but has not passed the second factor
//     (see auth/two-factor-gate.ts). Reaches only /status and /login/verify.
//   - "full": a normal board browser session. Reaches enrolment, disable and
//     recovery-code regeneration. Board API keys, delegate tokens and the
//     trusted-header paths are refused: a second factor belongs to a person at
//     a browser.
// Every route acts on the caller's own user id from the session, never on an id
// from the request, so there is no way to name another user's 2FA record.
//
// Nothing secret is logged or written to the activity log: not the TOTP secret,
// the otpauth URI, recovery codes, enrolment tokens or any submitted code.

const INVALID_CODE_MESSAGE = "Invalid verification code";
const CODE_ATTEMPTS_PER_WINDOW = 10;
const CODE_ATTEMPT_WINDOW_MS = 60 * 1000;

export const TWO_FACTOR_ACTIONS = {
  enrolled: "two_factor.enrolled",
  verifyFailed: "two_factor.verify_failed",
  loginVerified: "two_factor.login_verified",
  disabled: "two_factor.disabled",
  recoveryCodesRegenerated: "two_factor.recovery_codes_regenerated",
} as const;

/** Per-user fixed-window limiter sitting in front of the service's own lockout. */
export function createCodeAttemptLimiter(opts?: { max?: number; windowMs?: number; now?: () => number }) {
  const max = opts?.max ?? CODE_ATTEMPTS_PER_WINDOW;
  const windowMs = opts?.windowMs ?? CODE_ATTEMPT_WINDOW_MS;
  const now = opts?.now ?? Date.now;
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Returns seconds to wait if over the limit, else null (and counts the attempt). */
    take(key: string): number | null {
      const t = now();
      if (windows.size > 5000) {
        for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
      }
      const w = windows.get(key);
      if (!w || w.resetAt <= t) {
        windows.set(key, { count: 1, resetAt: t + windowMs });
        return null;
      }
      if (w.count >= max) return Math.max(1, Math.ceil((w.resetAt - t) / 1000));
      w.count += 1;
      return null;
    },
  };
}

function normalizeCode(input: { totpCode: string; isRecoveryCode: boolean }): string {
  return input.isRecoveryCode ? input.totpCode.toUpperCase() : input.totpCode.replace(/\s+/g, "");
}

type FullSubject = { userId: string; sessionId: string; userEmail: string | null };

function requireFull(req: Request): FullSubject {
  const actor = req.actor;
  if (actor.type === "board" && actor.userId && actor.source === "session" && actor.sessionId) {
    return { userId: actor.userId, sessionId: actor.sessionId, userEmail: actor.userEmail ?? null };
  }
  if (getPendingTwoFactor(req)) throw forbidden("Complete two-factor verification first");
  if (actor.type === "board") throw forbidden("Two-factor settings need a signed-in browser session");
  throw unauthorized("Board authentication required");
}

function sendTooMany(res: Response, retryAfterSeconds: number): never {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  throw tooManyRequests("Too many attempts. Try again later.", {
    code: "two_factor_rate_limited",
    retryAfterSeconds,
  });
}

/** Maps a service refusal to the one response shape callers get, whatever part was wrong. */
function mapServiceError(res: Response, err: unknown): never {
  if (err instanceof TotpVerificationError) {
    if (err.code === "locked") {
      sendTooMany(res, err.retryAfterSeconds ?? Math.ceil(CODE_ATTEMPT_WINDOW_MS / 1000));
    }
    if (err.code === "invalid_code") {
      throw new HttpError(401, INVALID_CODE_MESSAGE, { code: "two_factor_invalid_code" });
    }
    if (err.code === "already_enabled") throw conflict("Two-factor authentication is already enabled");
    throw conflict("Two-factor authentication is not enabled");
  }
  throw err;
}

export function twoFactorRoutes(db: Db, opts: { enabled: boolean }) {
  const router = Router();
  const totp = totpService(db);
  const limiter = createCodeAttemptLimiter();

  // Flag off: indistinguishable from a route that does not exist.
  router.use((_req, res, next) => {
    if (!opts.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // These POSTs are made by a browser; a pending session has no board actor so
  // the global board-mutation guard does not see it.
  router.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (!isTrustedBoardMutationRequest(req)) {
      res.status(403).json({ error: "Two-factor request requires trusted browser origin" });
      return;
    }
    next();
  });

  async function recordEvent(
    userId: string,
    action: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    logger.info({ userId, action }, `two-factor: ${message}`);
    try {
      const memberships = await db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        );
      for (const { companyId } of memberships) {
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: userId,
          action,
          entityType: "user_two_factor",
          entityId: userId,
          details: { message, ...details },
        });
      }
    } catch (err) {
      logger.warn({ err, action }, "two-factor: failed to write activity entry");
    }
  }

  function takeAttempt(res: Response, userId: string) {
    const wait = limiter.take(userId);
    if (wait !== null) sendTooMany(res, wait);
  }

  router.get("/status", async (req, res) => {
    const pending = getPendingTwoFactor(req);
    if (pending) {
      const body: TwoFactorStatus = {
        enabled: true,
        verificationRequired: true,
        enabledAt: null,
        recoveryCodesRemaining: 0,
      };
      res.json(body);
      return;
    }
    const { userId } = requireFull(req);
    const status = await totp.getTotpStatus(userId);
    const body: TwoFactorStatus = {
      enabled: status.enabled,
      verificationRequired: false,
      enabledAt: status.enabledAt ? status.enabledAt.toISOString() : null,
      recoveryCodesRemaining: status.recoveryCodesRemaining,
    };
    res.json(body);
  });

  // Step 1 of enrolment. The secret, otpauth URI and recovery codes are shown
  // here once; the enrolment token carries them (sealed) to step 2.
  router.post("/enroll/start", async (req, res) => {
    const { userId, sessionId, userEmail } = requireFull(req);
    takeAttempt(res, userId);
    if (await totp.isTotpEnabled(userId)) throw conflict("Two-factor authentication is already enabled");
    const setup = await totp.initiateTotpSetup(userId, userEmail ?? userId);
    const enrollmentToken = await sealTotpEnrollment({
      userId,
      sessionId,
      secret: setup.secret,
      recoveryCodes: setup.recoveryCodes,
    });
    res.json({
      enrollmentToken,
      secret: setup.secret,
      otpauthUri: setup.qrCode,
      recoveryCodes: setup.recoveryCodes,
    });
  });

  // Step 2: the user proves their authenticator holds the secret.
  router.post("/enroll/verify", validate(twoFactorEnrollVerifySchema), async (req, res) => {
    const { userId, sessionId } = requireFull(req);
    takeAttempt(res, userId);
    const body = twoFactorEnrollVerifySchema.parse(req.body);
    const state = await openTotpEnrollment(body.enrollmentToken, { userId, sessionId });
    if (!state) throw new HttpError(400, "Enrollment expired. Start again.", { code: "two_factor_enrollment_expired" });
    if (!(await totp.verifyTotpToken(state.secret, normalizeCode({ totpCode: body.totpCode, isRecoveryCode: false })))) {
      await recordEvent(userId, TWO_FACTOR_ACTIONS.verifyFailed, "Two-factor enrolment code was not accepted", {
        stage: "enroll",
      });
      throw new HttpError(401, INVALID_CODE_MESSAGE, { code: "two_factor_invalid_code" });
    }
    try {
      await totp.completeTotpSetup(userId, state.secret, normalizeCode({ totpCode: body.totpCode, isRecoveryCode: false }), state.recoveryCodes);
    } catch (err) {
      if (await totp.isTotpEnabled(userId)) throw conflict("Two-factor authentication is already enabled");
      mapServiceError(res, err);
    }
    // They just proved possession of the factor on this very session.
    await totp.recordTotpSessionVerification(userId, sessionId, TWO_FACTOR_VERIFIED_TTL_MS);
    await recordEvent(userId, TWO_FACTOR_ACTIONS.enrolled, "Two-factor authentication was turned on");
    res.json({ enabled: true });
  });

  // The login step: a password-only session trades a code for full access.
  router.post("/login/verify", validate(twoFactorProofSchema), async (req, res) => {
    const pending = getPendingTwoFactor(req);
    if (!pending) {
      if (req.actor.type === "board") throw conflict("Two-factor verification is not pending for this session");
      throw unauthorized("Sign in required");
    }
    const body = twoFactorProofSchema.parse(req.body);
    const session = await db
      .select({ createdAt: authSessions.createdAt })
      .from(authSessions)
      .where(eq(authSessions.id, pending.sessionId))
      .then((rows) => rows[0] ?? null);
    if (!session || session.createdAt.getTime() + TWO_FACTOR_PENDING_TTL_MS < Date.now()) {
      throw new HttpError(401, "Verification window expired. Sign in again.", {
        code: "two_factor_pending_expired",
      });
    }
    takeAttempt(res, pending.userId);
    const token = normalizeCode(body);
    const result = await totp.validateAndConsumeTotpToken(pending.userId, token, body.isRecoveryCode);
    if (result.locked) {
      await recordEvent(pending.userId, TWO_FACTOR_ACTIONS.verifyFailed, "Two-factor sign-in is locked after repeated failures", {
        stage: "login",
        locked: true,
      });
      sendTooMany(res, result.retryAfterSeconds ?? 60);
    }
    if (!result.valid) {
      await recordEvent(pending.userId, TWO_FACTOR_ACTIONS.verifyFailed, "A two-factor sign-in code was not accepted", {
        stage: "login",
        recoveryCode: body.isRecoveryCode,
      });
      throw new HttpError(401, INVALID_CODE_MESSAGE, { code: "two_factor_invalid_code" });
    }
    await totp.recordTotpSessionVerification(pending.userId, pending.sessionId, TWO_FACTOR_VERIFIED_TTL_MS);
    await recordEvent(pending.userId, TWO_FACTOR_ACTIONS.loginVerified, "Signed in with two-factor verification", {
      recoveryCode: body.isRecoveryCode,
    });
    res.json({ verified: true, recoveryCodesRemaining: result.remainingCodes });
  });

  // Turning 2FA off (and so also "reset": disable, then enrol again) needs the
  // current factor, checked inside the service.
  router.post("/disable", validate(twoFactorProofSchema), async (req, res) => {
    const { userId } = requireFull(req);
    takeAttempt(res, userId);
    const body = twoFactorProofSchema.parse(req.body);
    const token = normalizeCode(body);
    let outcome: { disabled: boolean };
    try {
      outcome = await totp.disableTotpForUser(userId, { token, isRecoveryCode: body.isRecoveryCode });
    } catch (err) {
      if (err instanceof TotpVerificationError) {
        await recordEvent(userId, TWO_FACTOR_ACTIONS.verifyFailed, "A code to turn off two-factor was not accepted", {
          stage: "disable",
          locked: err.code === "locked",
        });
      }
      mapServiceError(res, err);
    }
    if (!outcome.disabled) throw notFound("Two-factor authentication is not enabled");
    await recordEvent(userId, TWO_FACTOR_ACTIONS.disabled, "Two-factor authentication was turned off");
    res.json({ disabled: true });
  });

  router.post("/recovery-codes/regenerate", validate(twoFactorProofSchema), async (req, res) => {
    const { userId } = requireFull(req);
    takeAttempt(res, userId);
    const body = twoFactorProofSchema.parse(req.body);
    const token = normalizeCode(body);
    let recoveryCodes: string[];
    try {
      recoveryCodes = await totp.regenerateRecoveryCodes(userId, { token, isRecoveryCode: body.isRecoveryCode });
    } catch (err) {
      if (err instanceof TotpVerificationError) {
        await recordEvent(userId, TWO_FACTOR_ACTIONS.verifyFailed, "A code to renew recovery codes was not accepted", {
          stage: "regenerate",
          locked: err.code === "locked",
        });
      }
      mapServiceError(res, err);
    }
    await recordEvent(userId, TWO_FACTOR_ACTIONS.recoveryCodesRegenerated, "Two-factor recovery codes were renewed");
    res.json({ recoveryCodes });
  });

  return router;
}
