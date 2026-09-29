import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { paymentNoticesService } from "../services/payment-notices.ts";
import { companyPaymentSettingsService } from "../services/company-payment-settings.ts";

/**
 * Payment notices outbox + company booking kill switch (DUR-4037, migration
 * 0186). Real Postgres with every migration applied, so this also proves the
 * migration itself (constraints, defaults) is correct, not just the service.
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping payment notices service tests: ${support.reason ?? "unsupported environment"}`);
}

d("paymentNoticesService + companyPaymentSettingsService", () => {
  let db: Db;
  let stopDb: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("payment-notices");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Booking Co",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agent = await agentService(db).create(companyId, {
      name: "Maja",
      role: "general",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    return { companyId, agentId: agent.id };
  }

  it("writes a receipt and a hand-over as separate outbox kinds, ready for the bridge to pick up", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const notices = paymentNoticesService(db);

    const receipt = await notices.writeReceipt({ companyId, agentId, text: "Booking confirmed on example.com." });
    const handOver = await notices.writeHandOver({ companyId, agentId, text: "Need a 2FA code." });

    expect(receipt).toMatchObject({ companyId, agentId, kind: "booking_receipt", status: "ready" });
    expect(handOver).toMatchObject({ companyId, agentId, kind: "hand_over", status: "ready" });

    const listed = await notices.outbox(companyId);
    expect(listed.map((n) => n.id).sort()).toEqual([receipt.id, handOver.id].sort());
  });

  it("acknowledges a notice exactly once, idempotently, and drops it from the outbox", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const notices = paymentNoticesService(db);
    const receipt = await notices.writeReceipt({ companyId, agentId, text: "Booking confirmed." });

    const ack1 = await notices.ack(companyId, receipt.id, { outcome: "delivered" });
    expect(ack1.status).toBe("delivered");
    // A retried ack (e.g. after a lost response) changes nothing -- same result, not an error.
    const ack2 = await notices.ack(companyId, receipt.id, { outcome: "failed" });
    expect(ack2.status).toBe("delivered");
    expect(await notices.outbox(companyId)).toHaveLength(0);
  });

  it("scopes the outbox and ack to the requesting company", async () => {
    const a = await seedCompanyAndAgent();
    const b = await seedCompanyAndAgent();
    const notices = paymentNoticesService(db);
    await notices.writeReceipt({ companyId: a.companyId, agentId: a.agentId, text: "For company A." });

    expect(await notices.outbox(b.companyId)).toHaveLength(0);
    const [rowForA] = await notices.outbox(a.companyId);
    await expect(notices.ack(b.companyId, rowForA!.id, { outcome: "delivered" })).rejects.toMatchObject({ status: 404 });
  });

  it("reads booking_enabled as false for a company that never touched the setting, and persists a flip", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const settings = companyPaymentSettingsService(db);

    expect(await settings.get(companyId)).toEqual({ companyId, bookingEnabled: false });

    const enabled = await settings.setBookingEnabled(companyId, true);
    expect(enabled).toEqual({ companyId, bookingEnabled: true });
    expect(await settings.get(companyId)).toEqual({ companyId, bookingEnabled: true });

    const disabled = await settings.setBookingEnabled(companyId, false);
    expect(disabled).toEqual({ companyId, bookingEnabled: false });
  });
});
