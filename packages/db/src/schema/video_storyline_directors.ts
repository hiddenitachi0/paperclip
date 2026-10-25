import { sql } from "drizzle-orm";
import { check, index, pgTable, real, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { modelDirectoryEntries } from "./model_directory_entries.js";

/**
 * Storyline directors (18 Oct 2026): per-company, named ways of writing a
 * storyboard (see packages/shared/src/video-storyline-directors.ts). Each
 * picks saved models (Settings > Models) for writing, for looking at
 * pictures first, and for doing tool work for a writer that cannot use
 * tools, each with an optional company secret as its key (else the helper's
 * key for that service). A saved model or secret that is deleted leaves the
 * slot empty (ON DELETE SET NULL); the editor then says so.
 *
 * builtin_key marks the two starters every company gets ("tutorial",
 * "action"); they are ordinary rows the company may edit or delete.
 */
export const videoStorylineDirectors = pgTable(
  "video_storyline_directors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    builtinKey: text("builtin_key"),
    writingEntryId: uuid("writing_entry_id").references(() => modelDirectoryEntries.id, { onDelete: "set null" }),
    writingKeySecretId: uuid("writing_key_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    analysisEntryId: uuid("analysis_entry_id").references(() => modelDirectoryEntries.id, { onDelete: "set null" }),
    analysisKeySecretId: uuid("analysis_key_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    helperEntryId: uuid("helper_entry_id").references(() => modelDirectoryEntries.id, { onDelete: "set null" }),
    helperKeySecretId: uuid("helper_key_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    temperature: real("temperature"),
    thinking: text("thinking"),
    styleInstructions: text("style_instructions").notNull().default(""),
    defaultVideoProviderId: text("default_video_provider_id"),
    defaultVideoModel: text("default_video_model"),
    defaultLookId: text("default_look_id"),
    defaultShotSeconds: integer("default_shot_seconds"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("video_storyline_directors_company_idx").on(table.companyId),
    companyNameUq: uniqueIndex("video_storyline_directors_company_name_uq").on(table.companyId, sql`lower(${table.name})`),
    thinkingCheck: check("video_storyline_directors_thinking_check", sql`${table.thinking} IS NULL OR ${table.thinking} IN ('on', 'off')`),
    providerCheck: check(
      "video_storyline_directors_provider_check",
      sql`${table.defaultVideoProviderId} IS NULL OR ${table.defaultVideoProviderId} IN ('fal', 'sogni')`,
    ),
    shotSecondsCheck: check(
      "video_storyline_directors_shot_seconds_check",
      sql`${table.defaultShotSeconds} IS NULL OR (${table.defaultShotSeconds} >= 1 AND ${table.defaultShotSeconds} <= 60)`,
    ),
    temperatureCheck: check(
      "video_storyline_directors_temperature_check",
      sql`${table.temperature} IS NULL OR (${table.temperature} >= 0 AND ${table.temperature} <= 2)`,
    ),
  }),
);
