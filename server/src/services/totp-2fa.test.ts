import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authUsers, createDb, userRecoveryCodes, userTotpSecrets } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { totpService } from "./totp-2fa.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping totp-2fa test: ${support.reason ?? "unsupported environment"}`);
}

d("totpService (embedded Postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let service!: ReturnType<typeof totpService>;
  let userId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-totp-2fa-");
    db = createDb(tempDb.connectionString);
    service = totpService(db);

    userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Test User",
      email: "test-user@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("verifySessionTotpStatus", () => {
    it("returns false when no session token exists", async () => {
      const result = await service.verifySessionTotpStatus(userId, `session_${randomUUID()}`);
      expect(result).toBe(false);
    });

    it("returns true for a non-expired session token", async () => {
      const sessionId = `session_${randomUUID()}`;
      await service.recordTotpSessionVerification(userId, sessionId, 30 * 60 * 1000);

      const result = await service.verifySessionTotpStatus(userId, sessionId);
      expect(result).toBe(true);
    });

    it("rejects an expired session token instead of always returning true", async () => {
      const sessionId = `session_${randomUUID()}`;
      // ttlMs negative => expiresAt is already in the past
      await service.recordTotpSessionVerification(userId, sessionId, -1000);

      const result = await service.verifySessionTotpStatus(userId, sessionId);
      expect(result).toBe(false);
    });

    it("does not leak a token across a different sessionId for the same user", async () => {
      const sessionId = `session_${randomUUID()}`;
      await service.recordTotpSessionVerification(userId, sessionId, 30 * 60 * 1000);

      const result = await service.verifySessionTotpStatus(userId, `session_${randomUUID()}`);
      expect(result).toBe(false);
    });
  });

  describe("validateAndConsumeTotpToken (recovery codes)", () => {
    beforeAll(async () => {
      const now = new Date();
      await db.insert(userTotpSecrets).values({
        id: `totp_${randomBytes(16).toString("hex")}`,
        userId,
        secret: "JBSWY3DPEHPK3PXP",
        verified: true,
        enabledAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    it("accepts a valid, unused recovery code exactly once", async () => {
      const setup = await service.initiateTotpSetup(userId, "test-user@example.com");
      const code = setup.recoveryCodes[0];

      // Insert the recovery codes directly since completeTotpSetup also requires a valid TOTP token.
      const now = new Date();
      const { createHash } = await import("node:crypto");
      for (const c of setup.recoveryCodes) {
        await db.insert(userRecoveryCodes).values({
          id: `recovery_${randomBytes(16).toString("hex")}`,
          userId,
          codeHash: createHash("sha256").update(c).digest("hex"),
          createdAt: now,
          updatedAt: now,
        });
      }

      const first = await service.validateAndConsumeTotpToken(userId, code, true);
      expect(first.valid).toBe(true);

      const second = await service.validateAndConsumeTotpToken(userId, code, true);
      expect(second.valid).toBe(false);
    });

    it("rejects an unknown recovery code without throwing", async () => {
      const result = await service.validateAndConsumeTotpToken(userId, "ZZZZ-ZZZZ", true);
      expect(result.valid).toBe(false);
    });
  });
});
