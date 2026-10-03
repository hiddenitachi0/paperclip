import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { privateAccessEvents } from "@paperclipai/db";
import { badRequest } from "../errors.js";

/**
 * DUR-4094: Filip's emergency-access ("break-glass") rule. Every read of an
 * Employee (light) member's private content that is NOT done through her own
 * account goes through `recordAccess` first -- the written reason is
 * required even when `notify` is false, because that is what later proves
 * why a suspected-misuse or internal-investigation access happened.
 *
 * `notify` never hides a row from `listForCompany` (the owners' full audit
 * view); it only controls whether the row appears in the subject's own
 * `listForSubject` read. There is no separate push/email notification path
 * yet -- see routes/private-access.ts for that assumption.
 */
export const PRIVATE_ACCESS_REASON_MIN_LENGTH = 10;

export type PrivateAccessTargetKind = "lane_a_conversation" | "mail_account";

export function privateAccessService(db: Db) {
  async function recordAccess(params: {
    companyId: string;
    targetUserId: string;
    accessedByUserId: string;
    targetKind: PrivateAccessTargetKind;
    targetId?: string | null;
    reason: string;
    notify?: boolean;
  }) {
    const reason = params.reason.trim();
    if (reason.length < PRIVATE_ACCESS_REASON_MIN_LENGTH) {
      throw badRequest(
        `A written reason (at least ${PRIVATE_ACCESS_REASON_MIN_LENGTH} characters) is required for emergency access.`,
      );
    }
    const notify = params.notify ?? true;
    const now = new Date();
    const [row] = await db
      .insert(privateAccessEvents)
      .values({
        companyId: params.companyId,
        targetUserId: params.targetUserId,
        accessedByUserId: params.accessedByUserId,
        targetKind: params.targetKind,
        targetId: params.targetId ?? null,
        reason,
        notify,
        notifiedAt: notify ? now : null,
        createdAt: now,
      })
      .returning();
    return row;
  }

  /** The owners' full audit view: every row, regardless of `notify`. */
  async function listForCompany(companyId: string) {
    return db
      .select()
      .from(privateAccessEvents)
      .where(eq(privateAccessEvents.companyId, companyId))
      .orderBy(desc(privateAccessEvents.createdAt));
  }

  /** The subject's own "who has read my private stuff" read -- only the rows the rule promised to tell them about. */
  async function listForSubject(companyId: string, subjectUserId: string) {
    return db
      .select()
      .from(privateAccessEvents)
      .where(
        and(
          eq(privateAccessEvents.companyId, companyId),
          eq(privateAccessEvents.targetUserId, subjectUserId),
          eq(privateAccessEvents.notify, true),
        ),
      )
      .orderBy(desc(privateAccessEvents.createdAt));
  }

  return { recordAccess, listForCompany, listForSubject };
}
