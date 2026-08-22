import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { routineTriggers } from "./routines.js";
import { issues } from "./issues.js";

/**
 * Conversation -> task mapping for the customer-inbox door (DUR-68/DUR-93):
 * "a reply must not become a second task". The pushing source sends a
 * conversation id (a Gmail thread id, for example) alongside each message
 * id; this table remembers which task a conversation is already attached
 * to, scoped per trigger since two different inbox doors could reuse the
 * same conversation id from two different sources.
 *
 * `issueId` cascades on delete so a hard-deleted issue (the routine
 * dispatch rollback path) frees the conversation for a fresh mapping
 * instead of leaving a dangling unique-index conflict behind.
 */

export const customerInboxConversations = pgTable(
  "customer_inbox_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    routineTriggerId: uuid("routine_trigger_id").notNull().references(() => routineTriggers.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    linkedIssueId: uuid("linked_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    triggerConversationUq: uniqueIndex("customer_inbox_conversations_trigger_conversation_uq").on(
      table.routineTriggerId,
      table.conversationId,
    ),
    linkedIssueIdx: index("customer_inbox_conversations_linked_issue_idx").on(table.linkedIssueId),
  }),
);
