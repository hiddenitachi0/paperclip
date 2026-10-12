import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, mailAccounts, mailMessageClassifications, mailMessages, mailUrgencyAlerts } from "@paperclipai/db";
import {
  isMailUrgencyAccount,
  isMailUrgencyHandled,
  type MailUrgencyAlertSummary,
  type MailUrgencyAlertStatus,
  type MailUrgencyCategory,
  type MailUrgencyFeedback,
  type MailUrgencyOutboxItem,
  type MailUrgencySummary,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { mailUrgencyClassifierService, type MailUrgencyClassifier } from "./mail-urgency-classifier.js";

/**
 * DUR-4573: urgency triage for the mail_accounts pipeline (DUR-4194). Called
 * by the account sync tick for each newly stored inbound message:
 *
 *   recipient filter (code) -> classifier (one tool-less model call) ->
 *   store classification -> urgent only: queue one Telegram alert ->
 *   reply warranted: write a never-sent, AI-flagged Paperclip draft.
 *
 * Practice mode: nothing here archives, labels, moves or deletes, and the
 * draft path can only ever call createDraft -- sending stays a human action
 * (mail-accounts.ts sendDraft). No mail body is logged or put in an alert.
 */

export const MAIL_URGENCY_OUTBOX_MAX_AGE_MS = 24 * 3_600_000;
const OUTBOX_BATCH = 20;
const ALERT_FIELD_MAX = 160;

export interface MailUrgencyAccountRef {
  id: string;
  companyId: string;
  emailAddress: string;
  paAgentId: string | null;
}

export interface MailUrgencyMessageRef {
  id: string;
  fromAddress: string;
  subject: string;
  bodyText: string;
  messageId: string | null;
}

export interface MailUrgencyDeps {
  classifier?: MailUrgencyClassifier;
  now?: () => Date;
  /** Writes a Paperclip-only draft as the account's PA agent. Never sends. */
  createReplyDraft?: (
    account: MailUrgencyAccountRef,
    message: MailUrgencyMessageRef,
    body: string,
  ) => Promise<void>;
}

export type MailUrgencyOutcome = "skipped_account" | "not_handled" | "already_classified" | "classified";

function oneLine(value: string, max = ALERT_FIELD_MAX): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Built server-side from sender, subject, summary, reason and a link -- never the body. */
export function buildMailUrgencyAlertText(input: {
  from: string;
  subject: string;
  summary: string;
  reason: string;
  link: string | null;
}): string {
  const lines = [
    "Urgent email",
    `From: ${oneLine(input.from) || "(unknown sender)"}`,
    `Subject: ${oneLine(input.subject) || "(no subject)"}`,
    oneLine(input.summary, 240),
    `Why: ${oneLine(input.reason, 300)}`,
  ];
  if (input.link) lines.push(input.link);
  return lines.join("\n");
}

export function mailUrgencyService(db: Db, deps: MailUrgencyDeps = {}) {
  const classifier = deps.classifier ?? mailUrgencyClassifierService();
  const nowOf = () => deps.now?.() ?? new Date();

  function toSummary(row: typeof mailMessageClassifications.$inferSelect): MailUrgencySummary {
    return {
      urgent: row.urgent,
      category: row.category as MailUrgencyCategory,
      reason: row.reason,
      summary: row.summary,
      classifiedAt: row.classifiedAt.toISOString(),
      operatorFeedback: (row.operatorFeedback as MailUrgencyFeedback | null) ?? null,
    };
  }

  async function alertLink(companyId: string, messageId: string): Promise<string | null> {
    const base = process.env.PAPERCLIP_PUBLIC_URL?.trim().replace(/\/+$/, "");
    if (!base) return null;
    const [company] = await db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId));
    if (!company) return null;
    return `${base}/${company.prefix}/email?message=${messageId}`;
  }

  /**
   * `recipients` is every To/Cc value. Idempotent
   * on message.id: a retried pass finds the stored classification, never
   * calls the model again, never writes a second alert or draft.
   */
  async function processInbound(
    account: MailUrgencyAccountRef,
    message: MailUrgencyMessageRef,
    recipients: readonly string[],
  ): Promise<MailUrgencyOutcome> {
    if (!isMailUrgencyAccount(account.emailAddress)) return "skipped_account";
    // Code-only gate: Nordstrand-only / unrelated mail never reaches the classifier.
    if (!isMailUrgencyHandled(recipients)) return "not_handled";

    const [existing] = await db
      .select()
      .from(mailMessageClassifications)
      .where(eq(mailMessageClassifications.messageId, message.id));
    let row = existing;
    let fresh = false;
    let draftReply: string | null = null;
    if (!row) {
      const { classification, fallback } = await classifier.classify({
        from: message.fromAddress,
        subject: message.subject,
        body: message.bodyText,
      });
      draftReply = fallback ? null : classification.draftReply;
      const [inserted] = await db
        .insert(mailMessageClassifications)
        .values({
          companyId: account.companyId,
          messageId: message.id,
          urgent: classification.urgent,
          category: classification.category,
          reason: classification.reason,
          summary: classification.summary,
          fallback,
          classifiedAt: nowOf(),
        })
        .onConflictDoNothing({ target: [mailMessageClassifications.messageId] })
        .returning();
      fresh = Boolean(inserted);
      row = inserted;
      if (!row) {
        [row] = await db
          .select()
          .from(mailMessageClassifications)
          .where(eq(mailMessageClassifications.messageId, message.id));
      }
    }
    if (!row) return "already_classified";

    // Non-urgent mail produces no alert and no outbox row at all. An urgent
    // row whose alert insert was lost to a crash is healed by the unique
    // (message_id) upsert below on the next pass.
    if (row.urgent) {
      const now = nowOf();
      await db
        .insert(mailUrgencyAlerts)
        .values({
          companyId: account.companyId,
          messageId: message.id,
          status: "ready",
          text: buildMailUrgencyAlertText({
            from: message.fromAddress,
            subject: message.subject,
            summary: row.summary,
            reason: row.reason,
            link: await alertLink(account.companyId, message.id),
          }),
          createdAt: now,
          readyAt: now,
        })
        .onConflictDoNothing({ target: [mailUrgencyAlerts.messageId] });
    }

    if (fresh && draftReply && account.paAgentId && deps.createReplyDraft) {
      try {
        await deps.createReplyDraft(account, message, draftReply);
      } catch (err) {
        logger.warn({ err, accountId: account.id }, "mail-urgency: could not write the reply draft");
      }
    }
    return fresh ? "classified" : "already_classified";
  }

  async function summariesFor(messageIds: string[]): Promise<Map<string, MailUrgencySummary>> {
    const out = new Map<string, MailUrgencySummary>();
    if (messageIds.length === 0) return out;
    const rows = await db
      .select()
      .from(mailMessageClassifications)
      .where(inArray(mailMessageClassifications.messageId, messageIds));
    for (const row of rows) out.set(row.messageId, toSummary(row));
    return out;
  }

  async function setFeedback(
    companyId: string,
    messageId: string,
    feedback: MailUrgencyFeedback | null,
  ): Promise<MailUrgencySummary> {
    const [row] = await db
      .update(mailMessageClassifications)
      .set({ operatorFeedback: feedback })
      .where(and(eq(mailMessageClassifications.messageId, messageId), eq(mailMessageClassifications.companyId, companyId)))
      .returning();
    if (!row) throw notFound("That message has no urgency classification.");
    return toSummary(row);
  }

  // ─── Outbox (the Telegram bridge) ──────────────────────────────────────────

  async function outbox(companyId: string): Promise<MailUrgencyOutboxItem[]> {
    const now = nowOf();
    const cutoff = new Date(now.getTime() - MAIL_URGENCY_OUTBOX_MAX_AGE_MS);
    // A ready alert nobody picked up within a day is never announced late.
    await db
      .update(mailUrgencyAlerts)
      .set({ status: "expired" })
      .where(
        and(
          eq(mailUrgencyAlerts.companyId, companyId),
          eq(mailUrgencyAlerts.status, "ready"),
          lt(mailUrgencyAlerts.readyAt, cutoff),
        ),
      );
    const rows = await db
      .select({ alert: mailUrgencyAlerts, paAgentId: mailAccounts.paAgentId })
      .from(mailUrgencyAlerts)
      .leftJoin(
        mailMessages,
        and(eq(mailMessages.id, mailUrgencyAlerts.messageId), eq(mailMessages.companyId, mailUrgencyAlerts.companyId)),
      )
      .leftJoin(
        mailAccounts,
        and(eq(mailAccounts.id, mailMessages.accountId), eq(mailAccounts.companyId, mailUrgencyAlerts.companyId)),
      )
      .where(
        and(
          eq(mailUrgencyAlerts.companyId, companyId),
          eq(mailUrgencyAlerts.status, "ready"),
          gte(mailUrgencyAlerts.readyAt, cutoff),
        ),
      )
      .orderBy(asc(mailUrgencyAlerts.createdAt))
      .limit(OUTBOX_BATCH);
    return rows.map(({ alert, paAgentId }) => ({
      id: alert.id,
      companyId: alert.companyId,
      messageId: alert.messageId,
      agentId: paAgentId ?? null,
      text: alert.text,
      createdAt: alert.createdAt.toISOString(),
    }));
  }

  async function ack(
    companyId: string,
    alertId: string,
    input: { outcome: "delivered" | "failed"; note?: string },
  ): Promise<MailUrgencyAlertSummary> {
    const [row] = await db
      .select()
      .from(mailUrgencyAlerts)
      .where(and(eq(mailUrgencyAlerts.id, alertId), eq(mailUrgencyAlerts.companyId, companyId)));
    if (!row) throw notFound("That alert was not found.");
    const toAlertSummary = (r: typeof row): MailUrgencyAlertSummary => ({
      id: r.id,
      messageId: r.messageId,
      status: r.status as MailUrgencyAlertStatus,
      createdAt: r.createdAt.toISOString(),
      deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : null,
    });
    // Idempotent: a repeated acknowledgement changes nothing.
    if (row.status !== "ready") return toAlertSummary(row);
    const [updated] = await db
      .update(mailUrgencyAlerts)
      .set({
        status: input.outcome,
        deliveredAt: input.outcome === "delivered" ? nowOf() : null,
        note: input.note ? input.note.slice(0, 300) : row.note,
      })
      .where(and(eq(mailUrgencyAlerts.id, row.id), eq(mailUrgencyAlerts.status, "ready")))
      .returning();
    return toAlertSummary(updated ?? row);
  }

  return { processInbound, summariesFor, setFeedback, outbox, ack };
}

export type MailUrgencyService = ReturnType<typeof mailUrgencyService>;
