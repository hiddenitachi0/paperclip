// One-click Claude sign-in: the instance-wide Claude subscription token every
// claude_local agent falls back to when it has no token of its own. Nothing
// here ever carries the token value; `fingerprint` is a short prefix of its
// sha256 so the UI can say "same as before" / "rotated".

export const CLAUDE_AUTH_SOURCES = ["signin", "pasted"] as const;
export type ClaudeAuthSource = (typeof CLAUDE_AUTH_SOURCES)[number];

/** `claude setup-token` tokens are described by the CLI as one-year tokens. */
export const CLAUDE_AUTH_TOKEN_LIFETIME_DAYS = 365;
/** Show "expiring soon" this many days ahead so a renewal is never a surprise. */
export const CLAUDE_AUTH_EXPIRY_WARNING_DAYS = 14;

export type ClaudeAuthHealth =
  | "not_configured"
  | "ok"
  | "expiring_soon"
  | "expired"
  | "check_failed"
  | "unverified";

export interface InstanceClaudeAuthStatus {
  configured: boolean;
  health: ClaudeAuthHealth;
  /** Plain-language one-liner matching `health`. */
  headline: string;
  fingerprint: string | null;
  source: ClaudeAuthSource | null;
  savedAt: string | null;
  savedByUserId: string | null;
  /** Estimated from savedAt + CLAUDE_AUTH_TOKEN_LIFETIME_DAYS; the CLI does not print a date. */
  expiresAt: string | null;
  expiresInDays: number | null;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
  lastUsedAt: string | null;
  lastAuthFailureAt: string | null;
  cli: {
    command: string;
    version: string | null;
  };
  automaticSignIn: {
    supported: boolean;
    reason: string | null;
  };
  /** The sign-in currently in progress on this server, if any. */
  activeSignIn: InstanceClaudeSignInSession | null;
}

export type InstanceClaudeSignInStatus =
  | "starting"
  | "awaiting_code"
  | "exchanging"
  | "completed"
  | "failed"
  | "cancelled";

export interface InstanceClaudeSignInSession {
  id: string;
  status: InstanceClaudeSignInStatus;
  loginUrl: string | null;
  message: string | null;
  startedAt: string;
  updatedAt: string;
}
