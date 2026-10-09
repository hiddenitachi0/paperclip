import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * DUR-4072 PR1: a named calculation script, company-scoped. The script's
 * actual code lives in its immutable `report_script_versions` rows -- this
 * row is only the stable identity (key/name) versions attach to.
 */
export const reportScripts = pgTable(
  "report_scripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("report_scripts_company_key_uq").on(table.companyId, table.key),
    companyIdx: index("report_scripts_company_idx").on(table.companyId),
  }),
);
