import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { modelDirectoryEntries } from "./model_directory_entries.js";

/**
 * "Ask Paperclip" helper settings, one lazy row per company (a company that
 * never opens the Helper settings has no row; absence reads as "Paperclip's
 * built-in default model, no investigation agent, the default investigation
 * limits").
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
  /**
   * Phase 3: the full agent that takes "Investigate deeper" requests from the
   * Ask panel. Each request is an ordinary task assigned to it (origin kind
   * 'helper_investigation'). Null = investigations are off for the company.
   */
  investigationAgentId: uuid("investigation_agent_id").references(() => agents.id, { onDelete: "set null" }),
  /** Most investigations one person may have running at once. Null = HELPER_INVESTIGATION_DEFAULT_MAX_RUNNING. */
  investigationMaxRunning: integer("investigation_max_running"),
  /** Most investigations one person may start in 24 hours. Null = HELPER_INVESTIGATION_DEFAULT_MAX_PER_DAY. */
  investigationMaxPerDay: integer("investigation_max_per_day"),
  /** Most investigations the whole company may start in 24 hours. Null = HELPER_INVESTIGATION_DEFAULT_COMPANY_MAX_PER_DAY. */
  investigationCompanyMaxPerDay: integer("investigation_company_max_per_day"),
  /**
   * An owner/admin's confirmation that the investigation agent can change
   * things: which agent, which of its rights/secrets they saw, who, when.
   * Checked again at every start; a new right or another agent needs a new
   * confirmation. Null = none given.
   */
  investigationAgentWriteAck: jsonb("investigation_agent_write_ack").$type<{
    agentId: string;
    capabilities: string[];
    userId: string | null;
    at: string;
  } | null>(),
  updatedByUserId: text("updated_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
