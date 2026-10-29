import { randomBytes } from "node:crypto";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

// DUR-4304: enrolment is two steps (show the secret, then prove the user's
// authenticator has it) and the server keeps no table for the half-finished
// state. The state travels instead as an opaque token that only the server can
// read or forge: the secret and the recovery codes are sealed with the same
// AES-256-GCM scheme the TOTP secret uses at rest (authenticated, so a client
// cannot alter the contents), and the token is bound to one user and one
// session and expires. The client therefore can never choose its own secret or
// recovery codes.
const ENROLLMENT_TOKEN_PREFIX = "tfe1.";
export const TOTP_ENROLLMENT_TTL_MS = 10 * 60 * 1000;

export interface TotpEnrollmentState {
  secret: string;
  recoveryCodes: string[];
}

interface SealedPayload extends TotpEnrollmentState {
  userId: string;
  sessionId: string;
  expiresAt: number;
  nonce: string;
}

export async function sealTotpEnrollment(
  input: TotpEnrollmentState & { userId: string; sessionId: string },
  now: number = Date.now(),
): Promise<string> {
  const payload: SealedPayload = {
    secret: input.secret,
    recoveryCodes: input.recoveryCodes,
    userId: input.userId,
    sessionId: input.sessionId,
    expiresAt: now + TOTP_ENROLLMENT_TTL_MS,
    nonce: randomBytes(8).toString("hex"),
  };
  const prepared = await localEncryptedProvider.createSecret({ value: JSON.stringify(payload) });
  return `${ENROLLMENT_TOKEN_PREFIX}${Buffer.from(JSON.stringify(prepared.material)).toString("base64url")}`;
}

/** Returns the enrolment state, or null for anything forged, expired or bound to someone else. */
export async function openTotpEnrollment(
  token: string,
  expected: { userId: string; sessionId: string },
  now: number = Date.now(),
): Promise<TotpEnrollmentState | null> {
  if (!token.startsWith(ENROLLMENT_TOKEN_PREFIX)) return null;
  try {
    const material = JSON.parse(
      Buffer.from(token.slice(ENROLLMENT_TOKEN_PREFIX.length), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const plaintext = await localEncryptedProvider.resolveVersion({ material: material as never, externalRef: null });
    const payload = JSON.parse(plaintext) as Partial<SealedPayload>;
    if (
      typeof payload.secret !== "string" ||
      !Array.isArray(payload.recoveryCodes) ||
      !payload.recoveryCodes.every((c) => typeof c === "string") ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt < now ||
      payload.userId !== expected.userId ||
      payload.sessionId !== expected.sessionId
    ) {
      return null;
    }
    return { secret: payload.secret, recoveryCodes: payload.recoveryCodes };
  } catch {
    return null;
  }
}
