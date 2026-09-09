// Instance security overview: who the instance admins are, which sessions
// are open right now, and what the last admin-set check found. Nothing here
// carries a session token, a password hash, or the signed snapshot itself;
// fingerprints are short sha256 prefixes so the UI can say "changed" without
// ever seeing the value.

export const ADMIN_AUTH_CHECK_STATUSES = ["baseline", "unchanged", "changed", "tampered"] as const;
export type AdminAuthCheckStatus = (typeof ADMIN_AUTH_CHECK_STATUSES)[number];

export const ADMIN_AUTH_CHECK_TRIGGERS = ["startup", "scheduled", "manual", "app_change"] as const;
export type AdminAuthCheckTrigger = (typeof ADMIN_AUTH_CHECK_TRIGGERS)[number];

export interface AdminAuthLastCheck {
  at: string;
  status: AdminAuthCheckStatus;
  trigger: AdminAuthCheckTrigger;
  /** Number of differences found (admins added/removed, emails or passwords changed). */
  changes: number;
}

export interface InstanceSecurityAdmin {
  userId: string;
  name: string | null;
  email: string | null;
  /** Open (not yet expired) browser sessions for this admin. */
  sessionCount: number;
  lastSeenAt: string | null;
}

export interface InstanceSecuritySession {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  isInstanceAdmin: boolean;
  /** True for the session that made this request, so the UI can say "this device". */
  isCurrent: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  /** Plain-language device description derived from the user agent, e.g. "Chrome on Windows". */
  device: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface InstanceSecurityOverview {
  admins: InstanceSecurityAdmin[];
  sessions: InstanceSecuritySession[];
  /** When the signed admin record was last taken; null before the first check. */
  snapshotTakenAt: string | null;
  lastCheck: AdminAuthLastCheck | null;
  /** How often the server re-checks the admin set on its own (0 = only at startup / on demand). */
  checkIntervalMinutes: number;
  /** Whether the snapshot is signed with a server secret (false only when no auth secret is configured). */
  snapshotSigned: boolean;
}

export const SIGN_OUT_EVERYWHERE_SCOPES = ["me", "everyone"] as const;
export type SignOutEverywhereScope = (typeof SIGN_OUT_EVERYWHERE_SCOPES)[number];

export interface SignOutEverywhereResult {
  scope: SignOutEverywhereScope;
  revokedSessions: number;
  /** True when the caller's own session was among those revoked (the browser must sign in again). */
  signedOutSelf: boolean;
}

export interface RevokeSessionResult {
  revoked: boolean;
  signedOutSelf: boolean;
}

export interface AdminAuthCheckResult {
  status: AdminAuthCheckStatus;
  checkedAt: string;
  changes: number;
  /** Plain-language sentences describing each difference found (empty when unchanged). */
  notices: string[];
}

/**
 * Turns a browser user-agent string into a short, plain description such as
 * "Chrome on Windows" or "Safari on iPhone". Deliberately coarse: it is for a
 * person glancing at a list of sessions, not for fingerprinting.
 */
export function describeUserAgent(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "Unknown device";

  let os = "";
  if (/iphone/i.test(ua)) os = "iPhone";
  else if (/ipad/i.test(ua)) os = "iPad";
  else if (/android/i.test(ua)) os = "Android";
  else if (/windows/i.test(ua)) os = "Windows";
  else if (/mac os x|macintosh/i.test(ua)) os = "Mac";
  else if (/cros/i.test(ua)) os = "ChromeOS";
  else if (/linux/i.test(ua)) os = "Linux";

  let browser = "";
  if (/edg\//i.test(ua)) browser = "Edge";
  else if (/opr\/|opera/i.test(ua)) browser = "Opera";
  else if (/firefox|fxios/i.test(ua)) browser = "Firefox";
  else if (/chrome|crios/i.test(ua)) browser = "Chrome";
  else if (/safari/i.test(ua)) browser = "Safari";
  else if (/curl\//i.test(ua)) browser = "curl";
  else if (/node|undici|axios|python|go-http/i.test(ua)) browser = "a script";

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return "Unknown device";
}
