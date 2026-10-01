import { z } from "zod";

/**
 * DUR-4194: per-person mail accounts -- a real IMAP/SMTP mailbox that belongs
 * to one human (ownerUserId), never to the company. The whole point (per the
 * DUR-4149 research report) is that an owner/admin cannot read what is in
 * someone's inbox just because they run the company: every read of message
 * content outside the owner's own session goes through the emergency-access
 * route (server/src/services/private-access.ts, targetKind "mail_account"),
 * which always writes a reasoned, visible-to-the-owner audit row first.
 *
 * `paAgentId` is the one agent (if any) allowed to read this inbox and
 * prepare drafts on the owner's behalf -- the same human+PA pairing Lane A
 * uses. A PA agent may never send: sendDraft is board-actor-and-owner only
 * (server/src/services/mail-accounts.ts), so "the AI drafts, a human presses
 * Send" is enforced by actor type, not by convention.
 */

// ─── Accounts ────────────────────────────────────────────────────────────────

export const MAIL_ACCOUNT_MIN_CHECK_MINUTES = 1;
export const MAIL_ACCOUNT_MAX_CHECK_MINUTES = 24 * 60;
export const MAIL_ACCOUNT_DEFAULT_CHECK_MINUTES = 5;
/** How many new messages one sync tick pulls per account; the rest wait for the next tick. */
export const MAIL_ACCOUNT_TICK_BATCH = 50;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const emailAddressField = z.string().trim().min(3).max(320).regex(EMAIL_RE, "Enter a valid email address.");

const mailAccountFields = {
  ownerUserId: z.string().trim().min(1, "Pick who this mailbox belongs to."),
  paAgentId: z.string().uuid().nullable(),
  displayName: z.string().trim().min(1, "Give the mailbox a name, e.g. \"Filip's inbox\".").max(120),
  emailAddress: emailAddressField,
  imapHost: z.string().trim().min(1, "Enter the IMAP server address.").max(255),
  imapPort: z.number().int().min(1).max(65535),
  imapSecure: z.boolean(),
  imapUsername: z.string().trim().min(1, "Enter the IMAP username (usually the email address).").max(320),
  imapMailbox: z.string().trim().min(1).max(200),
  imapCredentialSecretId: z.string().uuid().nullable(),
  smtpHost: z.string().trim().min(1, "Enter the SMTP server address.").max(255),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  smtpUsername: z.string().trim().min(1, "Enter the SMTP username (usually the email address).").max(320),
  smtpCredentialSecretId: z.string().uuid().nullable(),
  enabled: z.boolean(),
  checkEveryMinutes: z
    .number()
    .int()
    .min(MAIL_ACCOUNT_MIN_CHECK_MINUTES, `Check at most every ${MAIL_ACCOUNT_MIN_CHECK_MINUTES} minute(s).`)
    .max(MAIL_ACCOUNT_MAX_CHECK_MINUTES, "Check at least once a day."),
};

export const createMailAccountSchema = z
  .object({
    ...mailAccountFields,
    paAgentId: mailAccountFields.paAgentId.optional().default(null),
    imapPort: mailAccountFields.imapPort.default(993),
    imapSecure: mailAccountFields.imapSecure.default(true),
    imapMailbox: mailAccountFields.imapMailbox.default("INBOX"),
    imapCredentialSecretId: mailAccountFields.imapCredentialSecretId.optional().default(null),
    smtpPort: mailAccountFields.smtpPort.default(587),
    smtpSecure: mailAccountFields.smtpSecure.default(true),
    smtpCredentialSecretId: mailAccountFields.smtpCredentialSecretId.optional().default(null),
    enabled: mailAccountFields.enabled.default(true),
    checkEveryMinutes: mailAccountFields.checkEveryMinutes.default(MAIL_ACCOUNT_DEFAULT_CHECK_MINUTES),
  })
  .strict();
export type CreateMailAccountInput = z.infer<typeof createMailAccountSchema>;

export const updateMailAccountSchema = z
  .object({ ...mailAccountFields })
  .omit({ ownerUserId: true })
  .partial()
  .strict();
export type UpdateMailAccountInput = z.infer<typeof updateMailAccountSchema>;

// ─── Messages ────────────────────────────────────────────────────────────────

export const MAIL_MESSAGE_FOLDERS = ["inbox", "archive", "sent", "drafts", "trash"] as const;
export type MailMessageFolder = (typeof MAIL_MESSAGE_FOLDERS)[number];

export const MAIL_MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export type MailMessageDirection = (typeof MAIL_MESSAGE_DIRECTIONS)[number];

export const moveMailMessageSchema = z
  .object({
    folder: z.enum(MAIL_MESSAGE_FOLDERS),
  })
  .strict();
export type MoveMailMessageInput = z.infer<typeof moveMailMessageSchema>;

export const MAIL_SEARCH_MIN_QUERY_LENGTH = 2;
export const MAIL_SEARCH_MAX_QUERY_LENGTH = 200;
export const MAIL_LIST_DEFAULT_LIMIT = 50;
export const MAIL_LIST_MAX_LIMIT = 200;

// ─── Drafts (compose) ──────────────────────────────────────────────────────────

const addressListField = z.array(emailAddressField).max(50);

const mailDraftFields = {
  toAddresses: addressListField.min(1, "Add at least one recipient."),
  ccAddresses: addressListField,
  subject: z.string().trim().max(500),
  bodyText: z.string().max(200_000),
  bodyHtml: z.string().max(400_000).nullable(),
  inReplyToMessageId: z.string().uuid().nullable(),
  /** True when a PA agent (not the human owner) wrote this draft's current content. */
  aiDrafted: z.boolean(),
};

export const composeMailDraftSchema = z
  .object({
    ...mailDraftFields,
    ccAddresses: mailDraftFields.ccAddresses.optional().default([]),
    subject: mailDraftFields.subject.optional().default(""),
    bodyText: mailDraftFields.bodyText.optional().default(""),
    bodyHtml: mailDraftFields.bodyHtml.optional().default(null),
    inReplyToMessageId: mailDraftFields.inReplyToMessageId.optional().default(null),
    aiDrafted: mailDraftFields.aiDrafted.optional().default(false),
  })
  .strict();
export type ComposeMailDraftInput = z.infer<typeof composeMailDraftSchema>;

export const updateMailDraftSchema = z
  .object({ ...mailDraftFields })
  .omit({ inReplyToMessageId: true })
  .partial()
  .strict();
export type UpdateMailDraftInput = z.infer<typeof updateMailDraftSchema>;

// ─── Emergency access (break-glass) ───────────────────────────────────────────

export const MAIL_ACCOUNT_EMERGENCY_ACCESS_REASON_MIN_LENGTH = 10;

export const mailAccountEmergencyAccessSchema = z
  .object({
    reason: z.string().trim().min(MAIL_ACCOUNT_EMERGENCY_ACCESS_REASON_MIN_LENGTH),
    notify: z.boolean().optional(),
  })
  .strict();
export type MailAccountEmergencyAccessInput = z.infer<typeof mailAccountEmergencyAccessSchema>;
