import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { telegramBots } from "./telegram_bots.js";

/**
 * Voice messages (migration 0181).
 *
 * `company_speech_settings`: one row per company at most, holding the daily
 * allowances the operator chose. No row means the defaults
 * (SPEECH_DEFAULT_DAILY_TRANSCRIBE_SECONDS / _SPEAK_CHARACTERS in
 * packages/shared). The OpenAI key is NOT here: it is a company secret bound
 * through company_secret_bindings (target_type 'speech', target_id = the
 * company id, config_path 'openai_api_key'), so reading it is authorised and
 * audited like every other credential read.
 *
 * `speech_usage_events`: one row per successful speech call, so the daily
 * allowance can be checked and the operator can see what was used.
 * kind 'transcribe' -> amount is seconds of audio; kind 'speak' -> amount is
 * characters read aloud.
 */
export const companySpeechSettings = pgTable(
  "company_speech_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    dailyTranscribeSecondsCap: integer("daily_transcribe_seconds_cap").notNull().default(3600),
    dailySpeakCharactersCap: integer("daily_speak_characters_cap").notNull().default(50000),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("company_speech_settings_company_uq").on(table.companyId),
    capsCheck: check(
      "company_speech_settings_caps_check",
      sql`${table.dailyTranscribeSecondsCap} >= 0 AND ${table.dailySpeakCharactersCap} >= 0`,
    ),
  }),
);

export const speechUsageEvents = pgTable(
  "speech_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    amount: integer("amount").notNull(),
    model: text("model").notNull(),
    source: text("source").notNull(),
    telegramBotId: uuid("telegram_bot_id").references(() => telegramBots.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKindCreatedIdx: index("speech_usage_events_company_kind_created_idx").on(
      table.companyId,
      table.kind,
      table.createdAt,
    ),
    kindCheck: check("speech_usage_events_kind_check", sql`${table.kind} IN ('transcribe', 'speak')`),
    amountCheck: check("speech_usage_events_amount_check", sql`${table.amount} >= 0`),
  }),
);
