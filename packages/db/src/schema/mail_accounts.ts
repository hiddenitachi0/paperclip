import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";

/**
 * DUR-4194: per-person mail accounts, step 1 of "work platform: email inside
 * Paperclip" (DUR-4149). Distinct from mail_secretary (migration 0195,
 * DUR-4093): that feature is a read-only duty run that triages one agent's
 * inbox and never shows the owner a real mail client. This is the real
 * client -- inbox, read, search, reply/compose with an AI draft, move,
 * archive, and (human only) send.
 *
 * One row per mailbox. `ownerUserId` is the human it belongs to (a
 * company_memberships.principal_id, like private_access_events.targetUserId
 * -- not a foreign key, because it is not scoped to one membership-status
 * value). Not company-owned: an owner/admin reading this account's messages
 * outside the owner's own session must go through the emergency-access route
 * (server/src/services/private-access.ts, targetKind "mail_account"), which
 * always writes a reasoned audit row first. `paAgentId` is the one agent (if
 * any) allowed to read this inbox and prepare drafts for the owner -- never
 * to send; sendDraft is board-actor-and-owner only, enforced in
 * server/src/services/mail-accounts.ts regardless of this column.
 *
 * IMAP and SMTP credentials are both company secrets, bound through
 * company_secret_bindings (target_type 'mail_account', config_path
 * 'imap_password' / 'smtp_password') -- never stored on this row. The two
 * config paths may point at the same secret (one mailbox password used for
 * both protocols) or different ones.
 *
 * Sync cursor fields (next_check_at/check_lease_until/last_seen_uid) are the
 * same due/lease/cursor shape mail_inboxes and watchers use, so one account
 * is never polled twice at once and a tick only ever asks for messages newer
 * than the last one it synced.
 *
 * mail_messages holds both synced inbound mail and composed outbound mail
 * (drafts and sent), one row per message, `folder` tracking which view it
 * currently belongs to. Move/archive in this feature are LOCAL ONLY for v1 --
 * they relabel folder on our own row, they do not call IMAP MOVE/COPY against
 * the origin mailbox (see "Questions for Filip" in the DUR-4194 PR: whether a
 * later version should mirror moves back to the real mailbox).
 *
 * Rollback: DROP TABLE "mail_messages", then "mail_accounts" (children
 * before the parent they reference). Safe -- nothing outside this migration
 * references either table, so a rollback loses only this feature's mailbox
 * configuration and synced/composed message history, never anything else.
 */
export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    paAgentId: uuid("pa_agent_id").references(() => agents.id, { onDelete: "set null" }),
    displayName: text("display_name").notNull(),
    emailAddress: text("email_address").notNull(),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull().default(993),
    imapSecure: boolean("imap_secure").notNull().default(true),
    imapUsername: text("imap_username").notNull(),
    imapMailbox: text("imap_mailbox").notNull().default("INBOX"),
    imapCredentialSecretId: uuid("imap_credential_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull().default(587),
    smtpSecure: boolean("smtp_secure").notNull().default(true),
    smtpUsername: text("smtp_username").notNull(),
    smtpCredentialSecretId: uuid("smtp_credential_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    enabled: boolean("enabled").notNull().default(true),
    checkEveryMinutes: integer("check_every_minutes").notNull().default(5),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    checkLeaseUntil: timestamp("check_lease_until", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastCheckOk: boolean("last_check_ok"),
    lastCheckMessage: text("last_check_message"),
    // The highest IMAP UID already synced, so a tick only ever fetches
    // messages newer than the last one it saw. Null before the first check.
    lastSeenUid: integer("last_seen_uid"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("mail_accounts_company_idx").on(table.companyId, table.createdAt),
    ownerIdx: index("mail_accounts_owner_idx").on(table.companyId, table.ownerUserId),
    paAgentIdx: index("mail_accounts_pa_agent_idx").on(table.paAgentId),
    dueIdx: index("mail_accounts_due_idx").on(table.enabled, table.nextCheckAt),
    imapPortCheck: check("mail_accounts_imap_port_check", sql`${table.imapPort} > 0 AND ${table.imapPort} < 65536`),
    smtpPortCheck: check("mail_accounts_smtp_port_check", sql`${table.smtpPort} > 0 AND ${table.smtpPort} < 65536`),
    checkEveryCheck: check("mail_accounts_check_every_minutes_check", sql`${table.checkEveryMinutes} >= 1`),
  }),
);

export const mailMessages = pgTable(
  "mail_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => mailAccounts.id, { onDelete: "cascade" }),
    folder: text("folder").notNull().default("inbox"),
    direction: text("direction").notNull(),
    // Set only for a message synced in from IMAP. Null for a draft that has
    // never been fetched back from the server (drafts live only in our own
    // table in v1; see the module doc comment).
    messageUid: integer("message_uid"),
    messageId: text("message_id"),
    inReplyToMessageId: text("in_reply_to_message_id"),
    fromAddress: text("from_address").notNull(),
    toAddresses: jsonb("to_addresses").$type<string[]>().notNull().default([]),
    ccAddresses: jsonb("cc_addresses").$type<string[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    isRead: boolean("is_read").notNull().default(false),
    isDraft: boolean("is_draft").notNull().default(false),
    // True when a PA agent (not the human owner) wrote this draft's current
    // content -- an audit/UI signal, never itself a permission.
    aiDrafted: boolean("ai_drafted").notNull().default(false),
    draftEditedByUserId: text("draft_edited_by_user_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Postgres treats each NULL as distinct, so this never blocks two drafts
    // (both message_uid null) on the same account -- it only dedupes a
    // re-fetched IMAP message against itself.
    accountUidUq: uniqueIndex("mail_messages_account_uid_uq").on(table.accountId, table.messageUid),
    companyFolderIdx: index("mail_messages_company_folder_idx").on(table.companyId, table.accountId, table.folder, table.createdAt),
    messageIdIdx: index("mail_messages_account_message_id_idx").on(table.accountId, table.messageId),
    folderCheck: check("mail_messages_folder_check", sql`${table.folder} IN ('inbox', 'archive', 'sent', 'drafts', 'trash')`),
    directionCheck: check("mail_messages_direction_check", sql`${table.direction} IN ('inbound', 'outbound')`),
  }),
);
