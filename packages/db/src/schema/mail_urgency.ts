import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { mailMessages } from "./mail_accounts.js";

/**
 * DUR-4573: urgency triage for a per-person mail account.
 *
 * mail_message_classifications: one row per classified inbound message
 * (unique on message_id, so a retried pass can never double-classify).
 * `operator_feedback` is the practice-mode "mark right/wrong" mark from the
 * Email page. Holds the model's one-line summary and reason, never the mail
 * body.
 *
 * mail_urgency_alerts: the Telegram outbox for urgent mail, same shape and
 * lifecycle as watcher_alerts (composing -> ready -> delivered/failed/
 * expired). One alert per message (unique on message_id). `text` is built
 * server-side from sender, subject, summary, reason and a link -- never the
 * body.
 *
 * Rollback: DROP TABLE "mail_urgency_alerts", then "mail_message_classifications".
 * Nothing else references either table; a rollback loses only classification
 * history and unsent alerts, never any mail.
 */
export const mailMessageClassifications = pgTable(
  "mail_message_classifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").notNull().references(() => mailMessages.id, { onDelete: "cascade" }),
    urgent: boolean("urgent").notNull(),
    category: text("category").notNull(),
    reason: text("reason").notNull(),
    summary: text("summary").notNull(),
    // True when the model call or its output failed and the fail-safe (urgent, generic reason) was stored instead.
    fallback: boolean("fallback").notNull().default(false),
    operatorFeedback: text("operator_feedback"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageUq: uniqueIndex("mail_message_classifications_message_uq").on(table.messageId),
    companyUrgentIdx: index("mail_message_classifications_company_urgent_idx").on(table.companyId, table.urgent, table.classifiedAt),
    feedbackCheck: check(
      "mail_message_classifications_feedback_check",
      sql`${table.operatorFeedback} IS NULL OR ${table.operatorFeedback} IN ('correct', 'incorrect')`,
    ),
  }),
);

export const mailUrgencyAlerts = pgTable(
  "mail_urgency_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").notNull().references(() => mailMessages.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("composing"),
    text: text("text").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => ({
    messageUq: uniqueIndex("mail_urgency_alerts_message_uq").on(table.messageId),
    companyStatusIdx: index("mail_urgency_alerts_company_status_idx").on(table.companyId, table.status, table.createdAt),
    statusCheck: check(
      "mail_urgency_alerts_status_check",
      sql`${table.status} IN ('composing', 'ready', 'delivered', 'failed', 'expired')`,
    ),
  }),
);
