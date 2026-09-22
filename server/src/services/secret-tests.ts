/**
 * DUR-3997: "Test" for a company secret.
 *
 * Reads the stored value (through the ordinary resolution path, so the test
 * is in the secret's audit trail like any other access), asks the provider
 * for the secret's kind with one bounded, harmless call
 * (services/secret-kind-probes.ts), records the verdict on the row and hands
 * back one plain sentence.
 *
 * Nothing here returns, logs or stores the value. The sentence is scrubbed
 * of anything key-shaped before it is written to the row or the response.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets } from "@paperclipai/db";
import { isTestableSecretKind, type CompanySecretTestResult, type SecretKind } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { probeSecretKind, scrubSecretValue, type SecretProbeDeps, type SecretProbeResult } from "./secret-kind-probes.js";
import type { secretService } from "./secrets.js";

type SecretServiceLike = Pick<ReturnType<typeof secretService>, "getById" | "resolveSecretValueForTest">;

export interface SecretTestServiceDeps {
  secrets: SecretServiceLike;
  /** Injected so tests never go near a provider. */
  probe?: (kind: SecretKind, value: string, deps?: SecretProbeDeps) => Promise<SecretProbeResult>;
  now?: () => Date;
}

export function secretTestService(db: Db, deps: SecretTestServiceDeps) {
  const probe = deps.probe ?? probeSecretKind;
  const clock = deps.now ?? (() => new Date());

  return {
    /**
     * Test the secret `secretId` of `companyId`. A secret Paperclip cannot
     * test (no kind, or a kind without a probe) is refused with 422 and a
     * sentence saying so; a secret that is not active is refused the same
     * way. A failed probe is NOT an error: it is an `ok: false` verdict.
     */
    async test(
      companyId: string,
      secretId: string,
      actor: { userId: string | null },
    ): Promise<CompanySecretTestResult> {
      const secret = await deps.secrets.getById(secretId);
      if (!secret || secret.companyId !== companyId || secret.status === "deleted") {
        throw notFound("Secret not found");
      }
      const kind = secret.kind as SecretKind | null;
      if (!isTestableSecretKind(kind)) {
        throw unprocessable(
          kind
            ? "Paperclip cannot test this kind of secret yet. Only AI provider keys can be tested."
            : "Choose what kind of key this is first, then Paperclip can test it.",
          { code: "secret_kind_not_testable" },
        );
      }
      if (secret.status !== "active") {
        throw unprocessable("Only an active secret can be tested.", { code: "secret_inactive" });
      }

      let value: string;
      try {
        value = await deps.secrets.resolveSecretValueForTest(companyId, secretId, actor);
      } catch (err) {
        // Cannot read it back (provider vault down, master key rotated…):
        // that is a verdict too, and a more useful one than a 500.
        const detail = err instanceof Error ? err.message : "unknown error";
        return recordVerdict(secretId, {
          ok: false,
          message: scrubSecretValue(`Paperclip could not read the stored value to test it: ${detail}`, ""),
        });
      }

      const result = await probe(kind as SecretKind, value);
      return recordVerdict(secretId, {
        ok: result.ok,
        message: scrubSecretValue(result.message, value),
      });
    },
  };

  async function recordVerdict(secretId: string, verdict: SecretProbeResult): Promise<CompanySecretTestResult> {
    const at = clock();
    const updated = await db
      .update(companySecrets)
      .set({ lastTestAt: at, lastTestOk: verdict.ok, lastTestMessage: verdict.message, updatedAt: at })
      .where(eq(companySecrets.id, secretId))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw notFound("Secret not found");
    return { ok: verdict.ok, message: verdict.message, secret: updated as CompanySecretTestResult["secret"] };
  }
}

export type SecretTestService = ReturnType<typeof secretTestService>;
