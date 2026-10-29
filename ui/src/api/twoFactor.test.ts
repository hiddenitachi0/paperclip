import { afterEach, describe, expect, it, vi } from "vitest";
import { TwoFactorApiError, twoFactorApi } from "./twoFactor";

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

describe("twoFactorApi", () => {
  afterEach(() => vi.restoreAllMocks());

  it("treats a 404 (feature off) and a 401 (nobody signed in) as 'nothing to show'", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(respond(404, { error: "Not found" }));
    expect(await twoFactorApi.getStatus()).toBeNull();
    fetchMock.mockResolvedValueOnce(respond(401, { error: "Sign in required" }));
    expect(await twoFactorApi.getStatus()).toBeNull();
  });

  it("returns the status when the feature is on", async () => {
    const status = { enabled: true, verificationRequired: true, enabledAt: null, recoveryCodesRemaining: 0 };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(respond(200, status));
    expect(await twoFactorApi.getStatus()).toEqual(status);
  });

  it("sends totpCode and isRecoveryCode to the sign-in step", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(respond(200, { verified: true, recoveryCodesRemaining: 3 }));
    await twoFactorApi.verifyLogin({ totpCode: "ABCD-1234", isRecoveryCode: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/2fa/login/verify");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ totpCode: "ABCD-1234", isRecoveryCode: true });
  });

  it("keeps the error code from a wrong-code answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      respond(401, { error: "Invalid verification code", code: "two_factor_invalid_code" }),
    );
    const err = await twoFactorApi.verifyLogin({ totpCode: "000000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TwoFactorApiError);
    expect((err as TwoFactorApiError).code).toBe("two_factor_invalid_code");
    expect((err as TwoFactorApiError).status).toBe(401);
  });

  it("reads how long to wait from the Retry-After header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      respond(429, { error: "Too many", code: "two_factor_rate_limited", details: { retryAfterSeconds: 10 } }, { "Retry-After": "37" }),
    );
    const err = (await twoFactorApi.disable({ totpCode: "000000" }).catch((e: unknown) => e)) as TwoFactorApiError;
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(37);
  });
});
