import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { modelDirectoryEntries } from "./model_directory_entries.js";

/**
 * "Ask Paperclip" helper settings, one lazy row per company (a company that
 * never opens the Helper settings has no row; absence reads as "Paperclip's
 * built-in default model, no investigation agent").
 *
 * The helper's model keys are NOT here: they are company_secret_bindings rows
 * (target_type 'helper', target_id = the company id).
 */
export const companyHelperSettings = pgTable("company_helper_settings", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  /** The saved model the helper answers with when the person picks none. Null = built-in default. */
  defaultDirectoryEntryId: uuid("default_directory_entry_id").references(() => modelDirectoryEntries.id, {
    onDelete: "set null",
  }),
  /** Phase 3 (reserved): the full agent that takes "investigate this deeper" requests. Stored, not used yet. */
  investigationAgentId: uuid("investigation_agent_id").references(() => agents.id, { onDelete: "set null" }),
  updatedByUserId: text("updated_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
