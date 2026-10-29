import type { TwoFactorStatus } from "@paperclipai/shared";

// Board two-step sign-in. These routes live under /api/auth/2fa and answer 404 while the
// feature is switched off. They use their own fetch, not the shared API client, because a
// 401 here ("that code is wrong", "sign in again") must never trigger the app-wide
// sign-out redirect.

export type TwoFactorErrorCode =
  | "two_factor_invalid_code"
  | "two_factor_rate_limited"
  | "two_factor_pending_expired"
  | "two_factor_enrollment_expired";

export class TwoFactorApiError extends Error {
  status: number;
  code: string | null;
  retryAfterSeconds: number | null;

  constructor(message: string, status: number, code: string | null, retryAfterSeconds: number | null) {
    super(message);
    this.name = "TwoFactorApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface TwoFactorEnrollStart {
  enrollmentToken: string;
  secret: string;
  otpauthUri: string;
  recoveryCodes: string[];
}

export interface TwoFactorProof {
  totpCode: string;
  isRecoveryCode?: boolean;
}

function readRetryAfter(res: Response, body: { retryAfterSeconds?: unknown } | null): number | null {
  const header = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header);
  const fromBody = Number(body?.retryAfterSeconds);
  return Number.isFinite(fromBody) && fromBody > 0 ? Math.ceil(fromBody) : null;
}

async function call(path: string, init?: { method: "POST"; body: unknown }): Promise<Response> {
  return fetch(`/api/auth/2fa${path}`, {
    method: init?.method ?? "GET",
    credentials: "include",
    headers: init ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
    body: init ? JSON.stringify(init.body) : undefined,
  });
}

async function toError(res: Response): Promise<TwoFactorApiError> {
  const body = (await res.json().catch(() => null)) as
    | { error?: unknown; code?: unknown; details?: { code?: unknown; retryAfterSeconds?: unknown } }
    | null;
  const code =
    typeof body?.code === "string" ? body.code : typeof body?.details?.code === "string" ? body.details.code : null;
  const message = typeof body?.error === "string" ? body.error : `Request failed: ${res.status}`;
  return new TwoFactorApiError(message, res.status, code, readRetryAfter(res, body?.details ?? null));
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await call(path, { method: "POST", body });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export const twoFactorApi = {
  /**
   * Where two-step sign-in stands for whoever is asking.
   * Returns null when the feature is off (404) or nobody is signed in (401), so callers can
   * simply hide themselves.
   */
  getStatus: async (): Promise<TwoFactorStatus | null> => {
    const res = await call("/status");
    if (res.status === 404 || res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw await toError(res);
    return (await res.json()) as TwoFactorStatus;
  },

  startEnrollment: () => post<TwoFactorEnrollStart>("/enroll/start", {}),

  finishEnrollment: (input: { enrollmentToken: string; totpCode: string }) =>
    post<{ enabled: true }>("/enroll/verify", input),

  verifyLogin: (input: TwoFactorProof) =>
    post<{ verified: true; recoveryCodesRemaining: number }>("/login/verify", {
      totpCode: input.totpCode,
      isRecoveryCode: input.isRecoveryCode ?? false,
    }),

  regenerateRecoveryCodes: (input: TwoFactorProof) =>
    post<{ recoveryCodes: string[] }>("/recovery-codes/regenerate", {
      totpCode: input.totpCode,
      isRecoveryCode: input.isRecoveryCode ?? false,
    }),

  disable: (input: TwoFactorProof) =>
    post<{ disabled: true }>("/disable", {
      totpCode: input.totpCode,
      isRecoveryCode: input.isRecoveryCode ?? false,
    }),
};
