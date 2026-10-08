import { z } from "zod";

/**
 * DUR-4573: urgency triage for a per-person mail account (mail_accounts, the
 * DUR-4194 pipeline -- not the DUR-4093 mail_secretary triage). Code decides
 * whether a message is even eligible (recipient filter, below), one tool-less
 * model call classifies it, and code stores the result and, for urgent mail
 * only, queues a Telegram alert. Practice mode throughout: nothing here
 * archives, labels, moves, deletes or sends anything.
 */

export const MAIL_URGENCY_CATEGORIES = [
  "person",
  "customer",
  "supplier",
  "bank-payment",
  "authority",
  "newsletter",
  "receipt",
  "notification",
  "other",
] as const;
export type MailUrgencyCategory = (typeof MAIL_URGENCY_CATEGORIES)[number];

export const MAIL_URGENCY_FEEDBACK = ["correct", "incorrect"] as const;
export type MailUrgencyFeedback = (typeof MAIL_URGENCY_FEEDBACK)[number];

export const MAIL_URGENCY_ALERT_STATUSES = ["composing", "ready", "delivered", "failed", "expired"] as const;
export type MailUrgencyAlertStatus = (typeof MAIL_URGENCY_ALERT_STATUSES)[number];

/** The only mailbox(es) this pipeline runs for. Any other mail account is never classified or alerted. */
export const MAIL_URGENCY_ACCOUNT_ADDRESSES: readonly string[] = ["filipdurkan@gmail.com"];

/** Addresses (exact) and domains whose mail the pipeline handles / ignores. */
export const MAIL_URGENCY_HANDLED_ADDRESSES: readonly string[] = ["filipdurkan@gmail.com"];
export const MAIL_URGENCY_HANDLED_DOMAINS: readonly string[] = ["durkanagency.com"];
export const MAIL_URGENCY_IGNORED_DOMAINS: readonly string[] = ["nordstrandgruppen.no", "nordstrandmobler.no"];

export const MAIL_URGENCY_MAX_BODY_CHARS = 4_000;
export const MAIL_URGENCY_MAX_OUTPUT_TOKENS = 700;
export const MAIL_URGENCY_FALLBACK_REASON =
  "Could not be classified automatically, so it is flagged for a human look.";

export interface MailUrgencyClassification {
  urgent: boolean;
  reason: string;
  category: MailUrgencyCategory;
  summary: string;
  /** A suggested reply body, only when a reply is warranted. Stored as a never-sent Paperclip draft. */
  draftReply: string | null;
}

export const setMailUrgencyFeedbackSchema = z
  .object({ feedback: z.enum(MAIL_URGENCY_FEEDBACK).nullable() })
  .strict();
export type SetMailUrgencyFeedbackInput = z.infer<typeof setMailUrgencyFeedbackSchema>;

export const ackMailUrgencyOutboxSchema = z
  .object({
    outcome: z.enum(["delivered", "failed"]),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export type AckMailUrgencyOutboxInput = z.infer<typeof ackMailUrgencyOutboxSchema>;

/** What the UI reads next to a message. `urgency` is null for mail the pipeline never classified. */
export interface MailUrgencySummary {
  urgent: boolean;
  category: MailUrgencyCategory;
  reason: string;
  summary: string;
  classifiedAt: string;
  operatorFeedback: MailUrgencyFeedback | null;
}

export interface MailUrgencyOutboxItem {
  id: string;
  companyId: string;
  messageId: string;
  /**
   * The mailbox's personal assistant (its `paAgentId`), if one is linked. The
   * Telegram bridge sends the alert from that agent's own bot, never from the
   * company's default bot; with no assistant it falls back to the default.
   */
  agentId: string | null;
  text: string;
  createdAt: string;
}

export interface MailUrgencyAlertSummary {
  id: string;
  messageId: string;
  status: MailUrgencyAlertStatus;
  createdAt: string;
  deliveredAt: string | null;
}

function addressDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).trim().toLowerCase();
}

/** Pulls bare addresses out of raw header values like `Name <a@b.c>, d@e.f`. */
export function extractMailAddresses(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const matches = value.match(/[^\s<>,;"'()[\]]+@[^\s<>,;"'()[\]]+/g);
    if (matches) out.push(...matches.map((m) => m.toLowerCase().replace(/[.]+$/, "")));
  }
  return out;
}

/**
 * Pure code, runs before any model call. Handled = at least one of the
 * To/Cc addresses (never Delivered-To/X-Original-To: Gmail stamps it on every message and it is forgeable) is filipdurkan@gmail.com or at a
 * durkanagency.com domain. A handled address wins over an ignored one in the
 * same message. Mail with no handled address (ignored-only or neither) is not
 * handled -- never classified, never alerted.
 */
export function isMailUrgencyHandled(recipients: readonly string[]): boolean {
  return extractMailAddresses(recipients).some(
    (address) =>
      MAIL_URGENCY_HANDLED_ADDRESSES.includes(address) ||
      MAIL_URGENCY_HANDLED_DOMAINS.includes(addressDomain(address)),
  );
}

export function isMailUrgencyIgnored(recipients: readonly string[]): boolean {
  return extractMailAddresses(recipients).some((address) =>
    MAIL_URGENCY_IGNORED_DOMAINS.includes(addressDomain(address)),
  );
}

export function isMailUrgencyAccount(emailAddress: string): boolean {
  return MAIL_URGENCY_ACCOUNT_ADDRESSES.includes(emailAddress.trim().toLowerCase());
}
