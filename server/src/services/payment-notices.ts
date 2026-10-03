/**
 * DUR-4037 (Maja browser step 4): the outbox for the browser/booking flow's
 * plain-language notifications that are not themselves an approval card -- a
 * receipt once a booking went through, or a hand-over ("Filip, this needs a
 * 2FA/BankID/SMS code I can't see"). Modelled directly on `watcher_alerts`
 * (server/src/services/watchers.ts's "Outbox (the Telegram bridge)" section),
 * with the same lifecycle: written `ready` here, the bridge polls `outbox()`,
 * delivers, and calls `ack()`; a row nobody acks within a day is left for the
 * daily sweep to expire, exactly like a watcher alert.
 */

import { and, asc, eq, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { paymentNotices } from "@paperclipai/db";
import type { PaymentNoticeKind, PaymentNoticeOutboxItem } from "@paperclipai/shared";
import { notFound } from "../errors.js";

const OUTBOX_BATCH = 50;
const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PaymentNoticeSummary {
  id: string;
  companyId: string;
  agentId: string;
  kind: PaymentNoticeKind;
  status: string;
  text: string;
  imageFileId: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

function toSummary(row: typeof paymentNotices.$inferSelect): PaymentNoticeSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    kind: row.kind as PaymentNoticeKind,
    status: row.status,
    text: row.text,
    imageFileId: row.imageFileId,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
  };
}

export function paymentNoticesService(db: Db) {
  async function write(input: {
    companyId: string;
    agentId: string;
    kind: PaymentNoticeKind;
    text: string;
    imageFileId?: string | null;
  }): Promise<PaymentNoticeSummary> {
    const [row] = await db
      .insert(paymentNotices)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        kind: input.kind,
        status: "ready",
        text: input.text,
        imageFileId: input.imageFileId ?? null,
      })
      .returning();
    return toSummary(row);
  }

  const writeReceipt = (input: { companyId: string; agentId: string; text: string; imageFileId?: string | null }) =>
    write({ ...input, kind: "booking_receipt" });

  const writePurchaseReceipt = (input: { companyId: string; agentId: string; text: string; imageFileId?: string | null }) =>
    write({ ...input, kind: "purchase_receipt" });

  const writeHandOver = (input: { companyId: string; agentId: string; text: string; imageFileId?: string | null }) =>
    write({ ...input, kind: "hand_over" });

  // ─── Outbox (the Telegram bridge) ──────────────────────────────────────────

  async function outbox(companyId: string): Promise<PaymentNoticeOutboxItem[]> {
    const cutoff = new Date(Date.now() - OUTBOX_MAX_AGE_MS);
    const rows = await db
      .select()
      .from(paymentNotices)
      .where(
        and(
          eq(paymentNotices.companyId, companyId),
          eq(paymentNotices.status, "ready"),
          gte(paymentNotices.createdAt, cutoff),
        ),
      )
      .orderBy(asc(paymentNotices.createdAt))
      .limit(OUTBOX_BATCH);
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      agentId: row.agentId,
      kind: row.kind as PaymentNoticeKind,
      text: row.text,
      imageFileId: row.imageFileId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async function ack(
    companyId: string,
    noticeId: string,
    input: { outcome: "delivered" | "failed"; note?: string },
  ): Promise<PaymentNoticeSummary> {
    const [row] = await db
      .select()
      .from(paymentNotices)
      .where(and(eq(paymentNotices.id, noticeId), eq(paymentNotices.companyId, companyId)));
    if (!row) throw notFound("That notice was not found.");
    // Idempotent, same as watcher_alerts: a retry after a lost answer changes nothing.
    if (row.status !== "ready") return toSummary(row);
    const [updated] = await db
      .update(paymentNotices)
      .set({
        status: input.outcome,
        deliveredAt: input.outcome === "delivered" ? new Date() : null,
        note: input.note ? [row.note, input.note].filter(Boolean).join(" ").slice(0, 300) : row.note,
      })
      .where(and(eq(paymentNotices.id, row.id), eq(paymentNotices.status, "ready")))
      .returning();
    return toSummary(updated ?? row);
  }

  return { writeReceipt, writePurchaseReceipt, writeHandOver, outbox, ack };
}
