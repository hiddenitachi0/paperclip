import { z } from "zod";

/**
 * Payment notices (DUR-4037, Maja browser step 4): the outbox for the
 * booking/purchase flow's plain-language notifications that are not
 * themselves an approval card -- a receipt after a booking went through, or a
 * hand-over ("Filip, I hit a login step I can't do -- 2FA/BankID/SMS").
 * Modelled directly on `watcher_alerts` (`packages/shared/src/watchers.ts`),
 * with one difference: nothing here is written by a quick agent after the
 * fact, so there is no `composing` state -- every notice is written `ready`
 * by the server, with agent-supplied text always quoted rather than trusted
 * as fact (same rule as a booking approval's `agentSummary`).
 */

export const PAYMENT_NOTICE_KINDS = ["booking_receipt", "hand_over"] as const;
export type PaymentNoticeKind = (typeof PAYMENT_NOTICE_KINDS)[number];

export const PAYMENT_NOTICE_STATUSES = ["ready", "delivered", "failed", "expired"] as const;
export type PaymentNoticeStatus = (typeof PAYMENT_NOTICE_STATUSES)[number];

export interface PaymentNoticeOutboxItem {
  id: string;
  companyId: string;
  agentId: string;
  kind: PaymentNoticeKind;
  text: string;
  /** A same-company attachment id (GET /api/attachments/:id/content), or null. */
  imageFileId: string | null;
  createdAt: string;
}

export const ackPaymentNoticeOutboxSchema = z
  .object({
    outcome: z.enum(["delivered", "failed"]),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export type AckPaymentNoticeOutboxInput = z.infer<typeof ackPaymentNoticeOutboxSchema>;
