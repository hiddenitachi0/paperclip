import { TwoFactorApiError } from "../api/twoFactor";

export type TwoFactorFailure = {
  /** Plain-language sentence for the person to read. */
  message: string;
  /** Seconds to wait before another try, when the server asked for a pause. */
  waitSeconds: number | null;
  /** The sign-in took too long: start again from the password. */
  signInAgain: boolean;
  /** The set-up took too long: start the set-up again. */
  restartSetup: boolean;
};

/** Turns a 2FA failure into words Filip can act on. Never shows server wording. */
export function describeTwoFactorFailure(err: unknown, fallback: string): TwoFactorFailure {
  const base: TwoFactorFailure = { message: fallback, waitSeconds: null, signInAgain: false, restartSetup: false };
  if (!(err instanceof TwoFactorApiError)) return base;
  if (err.code === "two_factor_invalid_code") {
    return { ...base, message: "That code did not work. Check the code in your app and try again." };
  }
  if (err.status === 429) {
    const wait = err.retryAfterSeconds ?? 60;
    return { ...base, waitSeconds: wait, message: `Too many tries. Please wait ${formatWait(wait)} and try again.` };
  }
  if (err.code === "two_factor_pending_expired") {
    return { ...base, signInAgain: true, message: "That took too long. Please sign in again." };
  }
  if (err.code === "two_factor_enrollment_expired") {
    return { ...base, restartSetup: true, message: "Set-up took too long. Please start again." };
  }
  return base;
}

export function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minutes`;
}
