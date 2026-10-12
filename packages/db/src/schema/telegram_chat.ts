import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { telegramBots } from "./telegram_bots.js";
import { laneAConversations } from "./lane_a_conversations.js";

/**
 * Hermes parity, slice 1 (migration 0246): two-way Telegram chat about company
 * data for PEOPLE, not just the bot's operator.
 *
 * Three tables:
 *
 *  - telegram_person_links: one row per Paperclip person. A person makes a
 *    one-time code on their own profile page and sends `/link CODE` to the
 *    company's Telegram bot; the bridge passes the code with the sender's
 *    Telegram user id (which only Telegram can vouch for), and the code proves
 *    the Paperclip side. Only the code's SHA-256 is stored, it lives 15
 *    minutes and works once. Instance-wide (no company_id): the link says
 *    "this Telegram account is this person"; which company a question is about
 *    always comes from the bot it was sent to, never from the person or the
 *    message.
 *
 *  - telegram_chat_settings: per company, owner/admin only. Which bot answers
 *    linked people, which quick agent answers first, which full agent takes a
 *    question the quick agent cannot answer, and how many questions one person
 *    may ask per day.
 *
 *  - telegram_chat_requests: one row per question a linked person asked. It
 *    is the per-person daily counter, the audit of who asked what through
 *    which bot, and the outbox for answers that take a while: a question handed
 *    to the full agent waits here ('waiting') until its task is finished, then
 *    the agent's answer is written in ('ready') after the person's right to see
 *    that task is checked again, and the host-side bridge polls, sends and
 *    acknowledges it ('delivered'/'failed'), the same poll pattern as
 *    morning_report_outbox. No inbound port anywhere.
 */
export const telegramPersonLinks = pgTable(
  "telegram_person_links",
  {
    userId: text("user_id").primaryKey(),
    telegramUserId: text("telegram_user_id"),
    telegramUsername: text("telegram_username"),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    linkCodeHash: text("link_code_hash"),
    linkCodeExpiresAt: timestamp("link_code_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One Telegram account belongs to at most one person.
    telegramUserUq: uniqueIndex("telegram_person_links_telegram_user_uq")
      .on(table.telegramUserId)
      .where(sql`${table.telegramUserId} IS NOT NULL`),
    linkCodeHashIdx: index("telegram_person_links_code_hash_idx").on(table.linkCodeHash),
  }),
);

export const telegramChatSettings = pgTable(
  "telegram_chat_settings",
  {
    companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    botId: uuid("bot_id").references(() => telegramBots.id, { onDelete: "set null" }),
    quickAgentId: uuid("quick_agent_id").references(() => agents.id, { onDelete: "set null" }),
    fullAgentId: uuid("full_agent_id").references(() => agents.id, { onDelete: "set null" }),
    dailyQuestionsPerPerson: integer("daily_questions_per_person").notNull().default(30),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dailyCapCheck: check(
      "telegram_chat_settings_daily_cap_check",
      sql`${table.dailyQuestionsPerPerson} BETWEEN 1 AND 500`,
    ),
  }),
);

export const telegramChatRequests = pgTable(
  "telegram_chat_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    botId: uuid("bot_id").notNull().references(() => telegramBots.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    telegramUserId: text("telegram_user_id").notNull(),
    chatId: text("chat_id").notNull(),
    question: text("question").notNull(),
    // 'quick' = the quick agent answered in the same call; 'task' = handed to
    // the full agent (or a colleague the quick agent handed it to).
    route: text("route").notNull(),
    quickAgentId: uuid("quick_agent_id").references(() => agents.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => laneAConversations.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    status: text("status").notNull(),
    answerText: text("answer_text"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => ({
    companyUserCreatedIdx: index("telegram_chat_requests_company_user_created_idx").on(
      table.companyId,
      table.userId,
      table.createdAt,
    ),
    companyStatusIdx: index("telegram_chat_requests_company_status_idx").on(table.companyId, table.status, table.createdAt),
    routeCheck: check("telegram_chat_requests_route_check", sql`${table.route} IN ('quick', 'task')`),
    statusCheck: check(
      "telegram_chat_requests_status_check",
      sql`${table.status} IN ('asking', 'answered', 'waiting', 'ready', 'delivered', 'failed', 'expired')`,
    ),
  }),
);
