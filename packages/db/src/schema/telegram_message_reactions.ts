import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { laneAConversations } from "./lane_a_conversations.js";
import { laneAMessages } from "./lane_a_messages.js";

/**
 * DUR-4344: one person's emoji reaction to a message the Telegram bridge sent.
 * Distinct from `feedback_votes` (issue-comment thumbs): this is quick-chat
 * feedback, keyed by the Telegram message, and is the raw input for the
 * reaction-learning work (DUR-4342b/c).
 *
 * A removed reaction is voided, not deleted: `active` goes false and
 * `removedAt` is set, so the history stays auditable and re-adding the same
 * emoji simply re-activates the same row.
 */
export const telegramMessageReactions = pgTable(
  "telegram_message_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    /** The Telegram user who reacted (a digit string; Telegram ids are 64-bit). */
    telegramUserId: text("telegram_user_id").notNull(),
    telegramChatId: text("telegram_chat_id").notNull(),
    telegramMessageId: integer("telegram_message_id").notNull(),
    conversationId: uuid("conversation_id").references(() => laneAConversations.id, { onDelete: "set null" }),
    /** Our reply (lane_a_messages row) the reaction is about, when the bridge knew it. */
    messageId: uuid("message_id").references(() => laneAMessages.id, { onDelete: "set null" }),
    emoji: text("emoji").notNull(),
    active: boolean("active").notNull().default(true),
    // Picture fields, set only when the reacted message was a picture.
    pictureFileId: uuid("picture_file_id"),
    picturePrompt: text("picture_prompt"),
    pictureLook: text("picture_look"),
    pictureProvider: text("picture_provider"),
    pictureModel: text("picture_model"),
    // DUR-4345: the one short follow-up Maja may ask about a disliked picture.
    followUpAskedAt: timestamp("follow_up_asked_at", { withTimezone: true }),
    followUpAnswer: text("follow_up_answer"),
    followUpAnsweredAt: timestamp("follow_up_answered_at", { withTimezone: true }),
    reactedAt: timestamp("reacted_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("telegram_message_reactions_company_agent_idx").on(
      table.companyId,
      table.agentId,
      table.reactedAt,
    ),
    conversationIdx: index("telegram_message_reactions_conversation_idx").on(table.conversationId),
    uniqueReactionIdx: uniqueIndex("telegram_message_reactions_unique_idx").on(
      table.companyId,
      table.telegramChatId,
      table.telegramMessageId,
      table.telegramUserId,
      table.emoji,
    ),
  }),
);
