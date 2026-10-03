import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * DUR-4379 (foundation for DUR-4378): the company's "model directory". A saved
 * model setup -- provider, model id, address (local / OpenAI-compatible),
 * OpenRouter host routing, and the defaults a quick agent starts from
 * (thinking, temperature, answer length) -- named once and reused, so
 * switching an agent's model is one click instead of re-typing five fields.
 *
 * The shapes deliberately mirror the agents.lane_a_* columns (provider,
 * model, base_url, provider_routing, thinking, temperature,
 * max_output_tokens) so applying an entry to an agent is a straight copy.
 *
 * No key is ever stored here. Keys stay in company secrets and are bound to
 * the agent (adapterConfig.laneA.apiKey / apiKeyByProvider); an entry only
 * says WHICH provider/model/address, never how to authenticate.
 *
 * `backup_entry_ids` is an ordered list of other entries of the same company
 * (a backup chain, at most LANE_A_BACKUP_MODELS_MAX). It is not a foreign key
 * (jsonb); the service checks every id belongs to the same company on write
 * and tolerates a dangling id on read, as agents.lane_a_no_answer_chain_ids
 * does for its pool.
 *
 * Rollback: DROP TABLE "model_directory_entries". Nothing else references it.
 */
export const modelDirectoryEntries = pgTable(
  "model_directory_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    // Null = the provider's own default address.
    baseUrl: text("base_url"),
    // { only?, order?, ignore?, allowFallbacks? } -- OpenRouter only.
    providerRouting: jsonb("provider_routing").$type<Record<string, unknown>>(),
    // "on" | "off" | null (null = leave the model's own default).
    defaultThinking: text("default_thinking"),
    defaultTemperature: real("default_temperature"),
    defaultMaxOutputTokens: integer("default_max_output_tokens"),
    backupEntryIds: jsonb("backup_entry_ids").$type<string[]>().notNull().default([]),
    note: text("note"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("model_directory_entries_company_idx").on(table.companyId, table.createdAt),
    companyNameUq: uniqueIndex("model_directory_entries_company_name_uq").on(table.companyId, table.name),
    thinkingCheck: check(
      "model_directory_entries_thinking_check",
      sql`${table.defaultThinking} IS NULL OR ${table.defaultThinking} IN ('on', 'off')`,
    ),
  }),
);
