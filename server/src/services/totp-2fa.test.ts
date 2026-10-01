import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as speakeasy from "speakeasy";
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

  describe("completeTotpSetup (DUR-4180: secret encrypted at rest)", () => {
    it("stores the TOTP secret sealed (never plaintext) and still verifies a valid code after the round trip", async () => {
      const setupUserId = randomUUID();
      const now = new Date();
      await db.insert(authUsers).values({
        id: setupUserId,
        name: "Setup Test User",
        email: `setup-${setupUserId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });

      const setup = await service.initiateTotpSetup(setupUserId, `setup-${setupUserId}@example.com`);
      const currentToken = speakeasy.totp({ secret: setup.secret, encoding: "base32" });

      await service.completeTotpSetup(setupUserId, setup.secret, currentToken, setup.recoveryCodes);

      const row = await db
        .select({ secret: userTotpSecrets.secret })
        .from(userTotpSecrets)
        .where(eq(userTotpSecrets.userId, setupUserId))
        .then((rows) => rows[0]);

      expect(row).toBeTruthy();
      // The stored value must not be (or contain) the raw base32 secret, and
      // must be wrapped in the sealed scheme rather than stored plaintext.
      expect(row!.secret).not.toBe(setup.secret);
      expect(row!.secret).not.toContain(setup.secret);
      expect(row!.secret.startsWith("totp_secret:local_encrypted_v1:")).toBe(true);

      // A fresh valid token still verifies correctly after the encrypt/decrypt
      // round trip through storage.
      const nextToken = speakeasy.totp({ secret: setup.secret, encoding: "base32" });
      const result = await service.validateAndConsumeTotpToken(setupUserId, nextToken, false);
      expect(result.valid).toBe(true);
    });

    it("rejects an invalid code after the encrypted round trip", async () => {
      const setupUserId = randomUUID();
      const now = new Date();
      await db.insert(authUsers).values({
        id: setupUserId,
        name: "Setup Test User 2",
        email: `setup2-${setupUserId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });

      const setup = await service.initiateTotpSetup(setupUserId, `setup2-${setupUserId}@example.com`);
      const currentToken = speakeasy.totp({ secret: setup.secret, encoding: "base32" });
      await service.completeTotpSetup(setupUserId, setup.secret, currentToken, setup.recoveryCodes);

      const result = await service.validateAndConsumeTotpToken(setupUserId, "000000", false);
      expect(result.valid).toBe(false);
    });
  });
});
