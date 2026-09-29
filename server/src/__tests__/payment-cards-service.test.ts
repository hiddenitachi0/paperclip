import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, companySecrets, createDb, paymentCards, secretAccessEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.ts";
import { paymentCardService } from "../services/payment-cards.ts";
import { HttpError } from "../errors.ts";

/**
 * DUR-4040 (Maja browser step 5): paymentCardService against a real Postgres
 * with every migration applied. Purchasing itself (arming/consuming a
 * reservation) is step 6, not built here -- these tests seed an
 * already-reserved card directly to exercise resolveForFill's own checks in
 * isolation.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping payment card service tests: ${support.reason ?? "unsupported environment"}`);
}

const CANARY_CARD_VALUE = JSON.stringify({ cardNumber: "4242424242424242", cvc: "123" });

d("paymentCardService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-payment-cards-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("payment-cards");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(paymentsEnabled = true) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Card Co",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      paymentsEnabled,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, browserAccess: "off" | "browse_and_forms" | "book_and_buy" = "book_and_buy") {
    const created = await agentService(db).create(companyId, {
      name: "Maja",
      role: "general",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: { laneA: { browserAccess } },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    return created.id;
  }

  async function seedCardSecret(companyId: string) {
    const secret = await secretService(db).create(companyId, {
      name: `card-${randomUUID()}`,
      provider: "local_encrypted",
      value: CANARY_CARD_VALUE,
      kind: "payment_card_single_use",
    });
    return secret.id;
  }

  async function seedCard(
    companyId: string,
    secretId: string,
    overrides: Partial<typeof paymentCards.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(paymentCards)
      .values({
        companyId,
        secretId,
        label: "Test card",
        last4: "4242",
        currency: "NOK",
        loadedAmountCents: 100_000,
        remainingAmountCents: 100_000,
        singleUse: true,
        status: "available",
        allowedAgentIds: [],
        ...overrides,
      })
      .returning();
    return row!;
  }

  function service(overrides: Parameters<typeof paymentCardService>[2] = {}) {
    return paymentCardService(db, db, overrides);
  }

  describe("list", () => {
    it("returns only the requesting company's cards", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const secretA = await seedCardSecret(companyA);
      const secretB = await seedCardSecret(companyB);
      await seedCard(companyA, secretA, { label: "A card" });
      await seedCard(companyB, secretB, { label: "B card" });

      const resultA = await service().list(companyA);
      expect(resultA).toHaveLength(1);
      expect(resultA[0]!.label).toBe("A card");
    });

    it("never includes the card's own secret value in the summary shape", async () => {
      const companyId = await seedCompany();
      const secretId = await seedCardSecret(companyId);
      await seedCard(companyId, secretId);

      const [card] = await service().list(companyId);
      expect(JSON.stringify(card)).not.toContain("4242424242424242");
    });
  });

  describe("disable", () => {
    it("moves an available card to disabled and records the reason", async () => {
      const companyId = await seedCompany();
      const secretId = await seedCardSecret(companyId);
      const card = await seedCard(companyId, secretId);

      const updated = await service().disable(companyId, card.id, { reason: "lost card" });
      expect(updated.status).toBe("disabled");
      expect(updated.disabledReason).toBe("lost card");
      expect(updated.disabledAt).not.toBeNull();
    });

    it("is idempotent when the card is already disabled", async () => {
      const companyId = await seedCompany();
      const secretId = await seedCardSecret(companyId);
      const card = await seedCard(companyId, secretId, { status: "disabled" });

      const updated = await service().disable(companyId, card.id, { reason: "second click" });
      expect(updated.status).toBe("disabled");
      expect(updated.disabledReason).toBeNull(); // unchanged from the seeded row
    });

    it("404s for a card in a different company", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const secretB = await seedCardSecret(companyB);
      const card = await seedCard(companyB, secretB);

      await expect(service().disable(companyA, card.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("markAsUsedUp", () => {
    it("moves an available card to used and zeroes the remaining balance", async () => {
      const companyId = await seedCompany();
      const secretId = await seedCardSecret(companyId);
      const card = await seedCard(companyId, secretId, { remainingAmountCents: 5_000 });

      const updated = await service().markAsUsedUp(companyId, card.id);
      expect(updated.status).toBe("used");
      expect(updated.remainingAmountCents).toBe(0);
      expect(updated.usedAt).not.toBeNull();
    });

    it("refuses to mark an expired card as used up", async () => {
      const companyId = await seedCompany();
      const secretId = await seedCardSecret(companyId);
      const card = await seedCard(companyId, secretId, { status: "expired" });

      await expect(service().markAsUsedUp(companyId, card.id)).rejects.toMatchObject({ status: 409 });
    });

    it("is idempotent when the card is already used", async () => {
      const companyId = await seedCompany();
      const secretId = await seedCardSecret(companyId);
      const card = await seedCard(companyId, secretId, { status: "used", remainingAmountCents: 0 });

      const updated = await service().markAsUsedUp(companyId, card.id);
      expect(updated.status).toBe("used");
    });
  });

  describe("runDailyExpiryTick", () => {
    it("expires available and reserved cards whose expiresOn has passed, and nothing else", async () => {
      const companyId = await seedCompany();
      const secretId = await seedCardSecret(companyId);
      const pastAvailable = await seedCard(companyId, secretId, { expiresOn: "2020-01-01", status: "available" });
      const pastReserved = await seedCard(companyId, secretId, {
        expiresOn: "2020-01-01",
        status: "reserved",
        reservedForClearanceId: "clearance-1",
      });
      const futureCard = await seedCard(companyId, secretId, { expiresOn: "2099-01-01", status: "available" });
      const noExpiry = await seedCard(companyId, secretId, { expiresOn: null, status: "available" });
      const alreadyDisabled = await seedCard(companyId, secretId, { expiresOn: "2020-01-01", status: "disabled" });

      const result = await service().runDailyExpiryTick(new Date("2026-09-29T00:00:00.000Z"));
      expect(result.expired).toBe(2);

      const rows = await db.select().from(paymentCards).where(eq(paymentCards.companyId, companyId));
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(pastAvailable.id)!.status).toBe("expired");
      expect(byId.get(pastReserved.id)!.status).toBe("expired");
      expect(byId.get(futureCard.id)!.status).toBe("available");
      expect(byId.get(noExpiry.id)!.status).toBe("available");
      expect(byId.get(alreadyDisabled.id)!.status).toBe("disabled");
    });
  });

  describe("resolveForFill", () => {
    async function reservedSetup(opts: { browserAccess?: "off" | "browse_and_forms" | "book_and_buy"; paymentsEnabled?: boolean } = {}) {
      const companyId = await seedCompany(opts.paymentsEnabled ?? true);
      const agentId = await seedAgent(companyId, opts.browserAccess ?? "book_and_buy");
      const secretId = await seedCardSecret(companyId);
      const clearanceId = `clearance-${randomUUID()}`;
      const card = await seedCard(companyId, secretId, {
        status: "reserved",
        reservedForClearanceId: clearanceId,
        reservedAt: new Date(),
        allowedAgentIds: [agentId],
      });
      return { companyId, agentId, secretId, clearanceId, card };
    }

    it("resolves the card's secret value when every check passes, and audits the access", async () => {
      const { companyId, agentId, clearanceId, secretId } = await reservedSetup();

      const value = await service().resolveForFill(companyId, clearanceId, { agentId });
      expect(value).toBe(CANARY_CARD_VALUE);

      const events = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, secretId));
      expect(events.length).toBeGreaterThan(0);
    });

    it("refuses when the company has payments disabled", async () => {
      const { companyId, agentId, clearanceId } = await reservedSetup({ paymentsEnabled: false });
      await expect(service().resolveForFill(companyId, clearanceId, { agentId })).rejects.toMatchObject({ status: 403 });
    });

    it("refuses when the instance kill switch is on", async () => {
      const { companyId, agentId, clearanceId } = await reservedSetup();
      const svc = service({ isInstanceBrowserDisabled: () => true });
      await expect(svc.resolveForFill(companyId, clearanceId, { agentId })).rejects.toMatchObject({ status: 403 });
    });

    it("refuses when the agent's browser access is not book_and_buy", async () => {
      const { companyId, agentId, clearanceId } = await reservedSetup({ browserAccess: "browse_and_forms" });
      await expect(service().resolveForFill(companyId, clearanceId, { agentId })).rejects.toMatchObject({ status: 403 });
    });

    it("404s when no card is reserved for the clearance", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      await expect(
        service().resolveForFill(companyId, "no-such-clearance", { agentId }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("refuses when the card is not actually reserved", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const secretId = await seedCardSecret(companyId);
      const clearanceId = `clearance-${randomUUID()}`;
      await seedCard(companyId, secretId, { status: "used", reservedForClearanceId: clearanceId, allowedAgentIds: [agentId] });

      await expect(service().resolveForFill(companyId, clearanceId, { agentId })).rejects.toMatchObject({ status: 409 });
    });

    it("refuses an agent not in the card's allowed list", async () => {
      const { companyId, clearanceId } = await reservedSetup();
      const otherAgentId = await seedAgent(companyId);
      await expect(
        service().resolveForFill(companyId, clearanceId, { agentId: otherAgentId }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("never lets the canary card number leak into a thrown error's message", async () => {
      const { companyId, agentId, clearanceId } = await reservedSetup({ paymentsEnabled: false });
      try {
        await service().resolveForFill(companyId, clearanceId, { agentId });
        throw new Error("expected resolveForFill to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).message).not.toContain("4242424242424242");
      }
    });
  });

  describe("reserveAvailableCard (DUR-4046)", () => {
    it("reserves an available card allowed to this agent", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const secretId = await seedCardSecret(companyId);
      const card = await seedCard(companyId, secretId, { allowedAgentIds: [agentId] });
      const clearanceId = `clearance-${randomUUID()}`;

      const reserved = await service().reserveAvailableCard(companyId, card.id, { clearanceId, agentId });
      expect(reserved.status).toBe("reserved");
      expect(reserved.reservedForClearanceId).toBe(clearanceId);
    });

    it("refuses an agent not in the card's allowed list", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const secretId = await seedCardSecret(companyId);
      const card = await seedCard(companyId, secretId, { allowedAgentIds: [] });

      await expect(
        service().reserveAvailableCard(companyId, card.id, { clearanceId: "c1", agentId }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("refuses a card that is not available", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const secretId = await seedCardSecret(companyId);
      const card = await seedCard(companyId, secretId, { allowedAgentIds: [agentId], status: "used" });

      await expect(
        service().reserveAvailableCard(companyId, card.id, { clearanceId: "c1", agentId }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("lets only one of two racing reservations win (the status='available' guard is the race guard)", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const secretId = await seedCardSecret(companyId);
      const card = await seedCard(companyId, secretId, { allowedAgentIds: [agentId] });

      const results = await Promise.allSettled([
        service().reserveAvailableCard(companyId, card.id, { clearanceId: "c1", agentId }),
        service().reserveAvailableCard(companyId, card.id, { clearanceId: "c2", agentId }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
    });
  });

  describe("consumeReservation (DUR-4046)", () => {
    it("marks a reserved card used and reduces its remaining balance", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const secretId = await seedCardSecret(companyId);
      const clearanceId = `clearance-${randomUUID()}`;
      const card = await seedCard(companyId, secretId, {
        allowedAgentIds: [agentId],
        status: "reserved",
        reservedForClearanceId: clearanceId,
        remainingAmountCents: 100_000,
      });

      const consumed = await service().consumeReservation(companyId, card.id, {
        clearanceId,
        outcome: "used",
        spentAmountCents: 62_000,
        purchaseId: "purchase-1",
      });
      expect(consumed.status).toBe("used");
      expect(consumed.remainingAmountCents).toBe(38_000);
      expect(consumed.usedByPurchaseId).toBe("purchase-1");
    });

    it("can mark a card used_unverified when the outcome could not be confirmed", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const secretId = await seedCardSecret(companyId);
      const clearanceId = `clearance-${randomUUID()}`;
      const card = await seedCard(companyId, secretId, {
        allowedAgentIds: [agentId],
        status: "reserved",
        reservedForClearanceId: clearanceId,
      });

      const consumed = await service().consumeReservation(companyId, card.id, {
        clearanceId,
        outcome: "used_unverified",
        spentAmountCents: 1000,
        purchaseId: "purchase-1",
      });
      expect(consumed.status).toBe("used_unverified");
    });

    it("refuses to consume a card reserved for a different clearance", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const secretId = await seedCardSecret(companyId);
      const card = await seedCard(companyId, secretId, {
        allowedAgentIds: [agentId],
        status: "reserved",
        reservedForClearanceId: "some-other-clearance",
      });

      await expect(
        service().consumeReservation(companyId, card.id, {
          clearanceId: "clearance-1",
          outcome: "used",
          spentAmountCents: 100,
          purchaseId: "purchase-1",
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("never reduces remaining balance below zero", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const secretId = await seedCardSecret(companyId);
      const clearanceId = `clearance-${randomUUID()}`;
      const card = await seedCard(companyId, secretId, {
        allowedAgentIds: [agentId],
        status: "reserved",
        reservedForClearanceId: clearanceId,
        remainingAmountCents: 1000,
      });

      const consumed = await service().consumeReservation(companyId, card.id, {
        clearanceId,
        outcome: "used",
        spentAmountCents: 5000,
        purchaseId: "purchase-1",
      });
      expect(consumed.remainingAmountCents).toBe(0);
    });
  });

  describe("releaseReservation (DUR-4046)", () => {
    it("returns a reserved card to available when the clearance matches", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const secretId = await seedCardSecret(companyId);
      const clearanceId = `clearance-${randomUUID()}`;
      const card = await seedCard(companyId, secretId, {
        allowedAgentIds: [agentId],
        status: "reserved",
        reservedForClearanceId: clearanceId,
        reservedAt: new Date(),
      });

      const released = await service().releaseReservation(companyId, card.id, { clearanceId });
      expect(released.status).toBe("available");
      expect(released.reservedForClearanceId).toBeNull();
    });

    it("is idempotent: releasing an already-available card is a no-op, not an error", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const secretId = await seedCardSecret(companyId);
      const card = await seedCard(companyId, secretId, { allowedAgentIds: [agentId], status: "available" });

      const released = await service().releaseReservation(companyId, card.id, { clearanceId: "whatever" });
      expect(released.status).toBe("available");
    });

    it("does not release a card reserved for a different clearance", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const secretId = await seedCardSecret(companyId);
      const card = await seedCard(companyId, secretId, {
        allowedAgentIds: [agentId],
        status: "reserved",
        reservedForClearanceId: "some-other-clearance",
      });

      const result = await service().releaseReservation(companyId, card.id, { clearanceId: "clearance-1" });
      expect(result.status).toBe("reserved");
      expect(result.reservedForClearanceId).toBe("some-other-clearance");
    });
  });
});
