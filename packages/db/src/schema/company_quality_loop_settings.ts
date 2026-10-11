import { boolean, foreignKey, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { modelDirectoryEntries } from "./model_directory_entries.js";

/**
 * Agent quality loops (server/src/services/quality-loops.ts), one lazy row per company.
 * No row = every quality loop OFF: companies that existed before this table keep their
 * behaviour until someone opts in. A newly created company gets a row with the
 * suggested defaults (QUALITY_LOOPS_NEW_COMPANY_DEFAULTS in @paperclipai/shared).
 */
export const companyQualityLoopSettings = pgTable(
  "company_quality_loop_settings",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Extra self-check passes per task before review/done (0-3). 0 = off. */
    selfReviewPasses: integer("self_review_passes").notNull().default(0),
    /** Independent finish check on an agent's move to done. */
    doneCheckEnabled: boolean("done_check_enabled").notNull().default(false),
    /** "Not done" rounds before the person is asked (1-3). Null = default (2). */
    doneCheckMaxRounds: integer("done_check_max_rounds"),
    /** Saved model the finish check uses. Null = the helper's default saved model. */
    doneCheckDirectoryEntryId: uuid("done_check_directory_entry_id"),
    /** Agent that reviews new code tasks before done (review stage). Null = none. */
    defaultReviewerAgentId: uuid("default_reviewer_agent_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Short explicit names: the generated ones would pass Postgres's 63-character limit
  // and be silently truncated, which breaks the migration's re-run guard.
  (table) => ({
    doneCheckEntryFk: foreignKey({
      name: "cqls_done_check_entry_fk",
      columns: [table.doneCheckDirectoryEntryId],
      foreignColumns: [modelDirectoryEntries.id],
    }).onDelete("set null"),
    defaultReviewerFk: foreignKey({
      name: "cqls_default_reviewer_agent_fk",
      columns: [table.defaultReviewerAgentId],
      foreignColumns: [agents.id],
    }).onDelete("set null"),
  }),
);
