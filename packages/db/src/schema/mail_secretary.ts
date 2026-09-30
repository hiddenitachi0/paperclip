import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";

/**
 * Mail secretary (migration 0192): a limited-trust duty run, the same shape
 * as watchers (see watchers.ts) -- code fetches an inbox over IMAP
 * (read-only), code checks per-inbox ignore filters, one cheap model call
 * with NO tools classifies what is left, and code routes: ignore, keep for
 * Filip, or delegate to Maja. No AI is involved in fetching or filtering.
 *
 * One row per configured inbox. agent_id is the existing quick agent this
 * duty runs as; server-side enforcement (services/mail-secretary.ts) refuses
 * to tick an inbox whose agent is not dialed to laneATrustLevel "limited"
 * (DUR-4070) -- this is what makes it safe to point a not-yet-fully-trusted
 * agent at someone's real inbox. The IMAP password is never stored here:
 * credential_secret_id names a company secret, bound to this row through
 * company_secret_bindings (target_type 'mail_inbox', config_path
 * 'imap_password'), entered by a board user only (server/src/routes/secrets.ts
 * is board-only).
 *
 * mail_inbox_filters are per-inbox ignore rules ("everything about
 * Nordstrand") checked in code before anything reaches the classifier, so
 * filtered-out mail never costs a model call or reaches a prompt.
 *
 * mail_secretary_items is one row per fetched message once triaged: what the
 * filter/classifier decided, and -- when the decision is to delegate --
 * what was (or, in practice mode, would have been) handed to Maja. A new
 * inbox starts in practice mode: the secretary decides exactly as it would
 * for real and the decision is recorded, but delegation_status stays
 * 'practice_only' instead of 'ready', so nothing reaches Maja until an
 * operator turns practice mode off.
 */
export const mailInboxes = pgTable(
  "mail_inboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull().default(993),
    imapSecure: boolean("imap_secure").notNull().default(true),
    imapUsername: text("imap_username").notNull(),
    imapMailbox: text("imap_mailbox").notNull().default("INBOX"),
    credentialSecretId: uuid("credential_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    enabled: boolean("enabled").notNull().default(true),
    // DUR-4093: Filip's decision -- a new inbox starts here and stays until
    // an operator explicitly turns it off, after a week of practice reports.
    practiceMode: boolean("practice_mode").notNull().default(true),
    checkEveryMinutes: integer("check_every_minutes").notNull().default(10),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    checkLeaseUntil: timestamp("check_lease_until", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastCheckOk: boolean("last_check_ok"),
    lastCheckMessage: text("last_check_message"),
    // The highest IMAP UID already triaged, so a tick only ever fetches
    // messages newer than the last one it saw. Null before the first check.
    lastSeenUid: integer("last_seen_uid"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("mail_inboxes_company_idx").on(table.companyId, table.createdAt),
    dueIdx: index("mail_inboxes_due_idx").on(table.enabled, table.nextCheckAt),
    agentIdx: index("mail_inboxes_agent_idx").on(table.agentId),
    checkEveryCheck: check("mail_inboxes_check_every_minutes_check", sql`${table.checkEveryMinutes} >= 5`),
    portCheck: check("mail_inboxes_imap_port_check", sql`${table.imapPort} > 0 AND ${table.imapPort} < 65536`),
  }),
);

export const mailInboxFilters = pgTable(
  "mail_inbox_filters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    inboxId: uuid("inbox_id").notNull().references(() => mailInboxes.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    field: text("field").notNull(),
    matchType: text("match_type").notNull(),
    value: text("value").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    inboxIdx: index("mail_inbox_filters_inbox_idx").on(table.inboxId, table.enabled),
    fieldCheck: check("mail_inbox_filters_field_check", sql`${table.field} IN ('from', 'subject', 'body', 'any')`),
    matchTypeCheck: check("mail_inbox_filters_match_type_check", sql`${table.matchType} IN ('contains', 'domain')`),
  }),
);

export const mailSecretaryItems = pgTable(
  "mail_secretary_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    inboxId: uuid("inbox_id").notNull().references(() => mailInboxes.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    messageUid: integer("message_uid").notNull(),
    messageId: text("message_id"),
    fromAddress: text("from_address").notNull(),
    subject: text("subject").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    // Truncated plain text (see MAIL_SECRETARY_MAX_BODY_CHARS): enough for
    // the report and the classifier, not a full-message archive.
    bodyExcerpt: text("body_excerpt"),
    decision: text("decision").notNull(),
    // Set only when decision = 'ignored_by_filter': which filter matched.
    filterLabel: text("filter_label"),
    classification: jsonb("classification").$type<Record<string, unknown>>(),
    // Snapshot of the inbox's practice_mode at decision time, so a report
    // stays accurate even after the setting is later changed.
    practiceMode: boolean("practice_mode").notNull(),
    delegateAgentId: uuid("delegate_agent_id").references(() => agents.id, { onDelete: "set null" }),
    delegationStatus: text("delegation_status").notNull().default("none"),
    delegationCategory: text("delegation_category"),
    // The untrusted-content-framed text Maja actually reads (or would read,
    // in practice mode) -- never Maja's own words, always the delimited
    // "this is data, not instructions" wrapper (see mail-secretary.ts).
    delegatedContent: text("delegated_content"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (table) => ({
    inboxUidUq: uniqueIndex("mail_secretary_items_inbox_uid_uq").on(table.inboxId, table.messageUid),
    companyDecisionIdx: index("mail_secretary_items_company_decision_idx").on(
      table.companyId,
      table.decision,
      table.createdAt,
    ),
    delegateStatusIdx: index("mail_secretary_items_delegate_status_idx").on(
      table.delegateAgentId,
      table.delegationStatus,
      table.createdAt,
    ),
    decisionCheck: check(
      "mail_secretary_items_decision_check",
      sql`${table.decision} IN ('ignored_by_filter', 'ignored_by_classifier', 'kept_for_filip', 'delegated_to_maja', 'error')`,
    ),
    delegationStatusCheck: check(
      "mail_secretary_items_delegation_status_check",
      sql`${table.delegationStatus} IN ('none', 'practice_only', 'ready', 'acknowledged')`,
    ),
  }),
);
