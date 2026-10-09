import { pgTable, uuid, text, jsonb, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { dataConnections } from "./data_connections.js";
import { reportScriptVersions } from "./report_script_versions.js";

/**
 * DUR-4072 PR2: a report template -- the instructions, layout and pinned
 * script a report run follows, one per company. A template only ever points
 * at an `approved` script version (enforced in the service layer): drafting
 * a template against an unapproved version is fine, but a run never starts
 * against one, the same "never live without Filip's approval" rule PR1's
 * script versions carry.
 *
 * `dataConnectionId` is optional (nullable): the data source for a template
 * may not exist yet (see DUR-4058's open question about where Nordstrand's
 * numbers come from) -- a template without one simply cannot be run yet.
 */
export const reportTemplates = pgTable(
  "report_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** Plain-English instructions for the commentary step: what the report is for, tone, audience. */
    instructions: text("instructions").notNull(),
    /** Section order / headings for the generated document; free-form JSON, not rendered logic. */
    layout: jsonb("layout").$type<Record<string, unknown>>().notNull().default({}),
    dataConnectionId: uuid("data_connection_id").references(() => dataConnections.id, { onDelete: "set null" }),
    scriptVersionId: uuid("script_version_id").notNull().references(() => reportScriptVersions.id, { onDelete: "restrict" }),
    /** Off until a company owner/admin switches it on (agents may draft templates, never enable them). */
    isActive: boolean("is_active").notNull().default(false),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("report_templates_company_key_uq").on(table.companyId, table.key),
    companyIdx: index("report_templates_company_idx").on(table.companyId),
  }),
);
