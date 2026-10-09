import type { MailMessageFolder, MailUrgencySummary } from "@paperclipai/shared";

/**
 * DUR-4195: response shapes for the mail-accounts API added in DUR-4194
 * (server/src/services/mail-accounts.ts). The input/validation schemas for
 * this API already live in @paperclipai/shared (mail-accounts.ts); the
 * response summaries below mirror that service's return types 1:1 so the UI
 * stays typed without reaching into server/src directly.
 */

export interface MailAccountSummary {
  id: string;
  ownerUserId: string;
  paAgentId: string | null;
  displayName: string;
  emailAddress: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUsername: string;
  imapMailbox: string;
  hasImapCredential: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  hasSmtpCredential: boolean;
  enabled: boolean;
  checkEveryMinutes: number;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
  consecutiveFailures: number;
  createdAt: string;
}

export interface MailMessageSummary {
  id: string;
  accountId: string;
  folder: MailMessageFolder;
  direction: "inbound" | "outbound";
  messageId: string | null;
  inReplyToMessageId: string | null;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  isRead: boolean;
  isDraft: boolean;
  aiDrafted: boolean;
  receivedAt: string | null;
  sentAt: string | null;
  createdAt: string;
  /** Urgency check result; missing/null for mail that was never checked. */
  urgency?: MailUrgencySummary | null;
}

/**
 * DUR-4277 (child of DUR-4195): company-scoped on/off switch for this
 * feature, mirroring ProductGrabberSettings (packages/shared/src/product-grabber.ts).
 * Until that lands, getSettings() treats any non-200 as disabled so the
 * feature stays off by default rather than erroring.
 */
export interface EmailSettings {
  enabled: boolean;
}
