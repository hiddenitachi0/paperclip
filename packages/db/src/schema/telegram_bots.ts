import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";

/**
 * DUR-3978 slice 2: a Telegram bot connected to one agent, configured in the
 * app instead of in a root-only JSON file on the host
 * (`/root/paperclip/.telegram-agents.json`).
 *
 * The bot token is NOT stored here. It lives in the ordinary company secret
 * store (`company_secrets` + `company_secret_versions`, encrypted at rest,
 * rotatable, audited through `secret_access_events`) and this row only points
 * at it through `token_secret_id`. That is what makes "the token is never
 * returned by an ordinary read route" enforceable rather than a convention:
 * the read routes select from this table, and the value simply is not in it.
 *
 * `token_hint` is deliberately NOT a secret. A Telegram token is
 * `<numeric bot id>:<secret part>`, and the numeric bot id is public (it is
 * the bot's account id). The hint stores the public half plus the last four
 * characters, which is enough for the operator to recognise which token is
 * which and not enough to use one.
 *
 * `allowed_telegram_user_ids` is the per-bot allowlist the bridge enforces —
 * stored as text, because a Telegram user id is a 64-bit integer and JSON
 * numbers are not.
 *
 * `receives_company_notices` (migration 0178) marks the one bot that gets the
 * company's approvals and questions when no agent's own bot (or its boss's)
 * should — a card the board filed itself, for example. At most one per
 * company (partial unique index). With none marked, the bridge uses the CEO's
 * bot, else the oldest bot.
 *
 * `voice_reply_mode` and `voice` (migration 0182) say when the bot reads its
 * answer aloud ('never', 'when_voice' = when the person sent a voice message,
 * 'always') and with which text-to-speech voice (null = the default voice).
 */
export const telegramBots = pgTable(
  "telegram_bots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenSecretId: uuid("token_secret_id").notNull().references(() => companySecrets.id),
    tokenHint: text("token_hint").notNull().default(""),
    uiBase: text("ui_base"),
    allowedTelegramUserIds: jsonb("allowed_telegram_user_ids").notNull().$type<string[]>().default([]),
    enabled: boolean("enabled").notNull().default(true),
    receivesCompanyNotices: boolean("receives_company_notices").notNull().default(false),
    voiceReplyMode: text("voice_reply_mode").notNull().default("when_voice"),
    voice: text("voice"),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastCheckOk: boolean("last_check_ok"),
    lastCheckUsername: text("last_check_username"),
    lastCheckError: text("last_check_error"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("telegram_bots_company_idx").on(table.companyId),
    // One bot per agent: two bots for the same agent would both answer the
    // same person and both create tasks for the same agent.
    companyAgentUq: uniqueIndex("telegram_bots_company_agent_uq").on(table.companyId, table.agentId),
    tokenSecretUq: uniqueIndex("telegram_bots_token_secret_uq").on(table.tokenSecretId),
    // At most one bot per company gets the company's approvals and questions.
    companyNoticesUq: uniqueIndex("telegram_bots_company_notices_uq")
      .on(table.companyId)
      .where(sql`${table.receivesCompanyNotices}`),
    voiceReplyModeCheck: check(
      "telegram_bots_voice_reply_mode_check",
      sql`${table.voiceReplyMode} IN ('never', 'when_voice', 'always')`,
    ),
  }),
);
