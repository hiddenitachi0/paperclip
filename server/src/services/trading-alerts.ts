/**
 * Trading alerts (DUR-5026): the outbox the Telegram bridge polls for the
 * trading routine's safety stops and its top-up / sweep notices. Same
 * lifecycle as payment_notices and watcher_alerts: written `ready` by the
 * server at the moment the fact is known, delivered and acknowledged by the
 * bridge, expired after a day. The text is always built by the server from
 * facts it holds, never from text an agent wrote.
 */

import { and, asc, eq, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tradingAlerts } from "@paperclipai/db";
import type { TradingAlertKind, TradingAlertOutboxItem } from "@paperclipai/shared";
import { notFound } from "../errors.js";

const OUTBOX_BATCH = 50;
const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** What the wallet service needs to queue an alert; swapped for a recorder in tests. */
export interface TradingAlertSink {
  write(input: { companyId: string; walletId: string | null; kind: TradingAlertKind; text: string }): Promise<void>;
}

export function tradingAlertsService(db: Db) {
  async function write(input: { companyId: string; walletId: string | null; kind: TradingAlertKind; text: string }): Promise<void> {
    await db.insert(tradingAlerts).values({ companyId: input.companyId, walletId: input.walletId, kind: input.kind, status: "ready", text: input.text });
  }

  async function outbox(companyId: string): Promise<TradingAlertOutboxItem[]> {
    const cutoff = new Date(Date.now() - OUTBOX_MAX_AGE_MS);
    const rows = await db
      .select()
      .from(tradingAlerts)
      .where(and(eq(tradingAlerts.companyId, companyId), eq(tradingAlerts.status, "ready"), gte(tradingAlerts.createdAt, cutoff)))
      .orderBy(asc(tradingAlerts.createdAt))
      .limit(OUTBOX_BATCH);
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      walletId: row.walletId,
      kind: row.kind,
      text: row.text,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async function ack(companyId: string, alertId: string, input: { outcome: "delivered" | "failed"; note?: string }) {
    const [row] = await db.select().from(tradingAlerts).where(and(eq(tradingAlerts.id, alertId), eq(tradingAlerts.companyId, companyId)));
    if (!row) throw notFound("That alert was not found.");
    // Idempotent: a retry after a lost answer changes nothing.
    if (row.status !== "ready") return { id: row.id, status: row.status };
    const [updated] = await db
      .update(tradingAlerts)
      .set({
        status: input.outcome,
        deliveredAt: input.outcome === "delivered" ? new Date() : null,
        note: input.note ? [row.note, input.note].filter(Boolean).join(" ").slice(0, 300) : row.note,
      })
      .where(and(eq(tradingAlerts.id, row.id), eq(tradingAlerts.status, "ready")))
      .returning();
    return { id: row.id, status: (updated ?? row).status };
  }

  return { write, outbox, ack };
}
