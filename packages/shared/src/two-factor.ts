import { z } from "zod";

/**
 * Board two-factor login (DUR-4304). Request bodies for the
 * `/api/auth/2fa/*` routes. A "proof" is the user's current second factor:
 * either an authenticator code or one of their one-time recovery codes.
 */
const twoFactorCodeSchema = z.string().trim().min(1).max(32);

export const twoFactorProofSchema = z.object({
  totpCode: twoFactorCodeSchema,
  isRecoveryCode: z.boolean().optional().default(false),
});
export type TwoFactorProofInput = z.infer<typeof twoFactorProofSchema>;

export const twoFactorEnrollVerifySchema = z.object({
  enrollmentToken: z.string().min(1).max(4096),
  totpCode: twoFactorCodeSchema,
});
export type TwoFactorEnrollVerifyInput = z.infer<typeof twoFactorEnrollVerifySchema>;

/** Shape of `GET /api/auth/2fa/status`. Never carries a secret or a code. */
export interface TwoFactorStatus {
  enabled: boolean;
  /** True when this session still has to pass the second factor. */
  verificationRequired: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
}
