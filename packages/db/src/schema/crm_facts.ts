import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { crmContacts } from "./crm_contacts.js";
import { crmOrganizations } from "./crm_organizations.js";

/**
 * CRM facts with evidence (first slice of DUR-4150)
 * Company-scoped: records facts (structured data) with source evidence.
 * Each fact has a key-value pair, observed date, and source reference.
 * Source can be a URL or a message ID from the mail secretary.
 * Follows the "facts with evidence" discipline from the research report.
 */
export const crmFacts = pgTable(
  "crm_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => crmContacts.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => crmOrganizations.id, { onDelete: "cascade" }),
    factKey: text("fact_key").notNull(), // e.g. "annual_revenue", "employee_count", "last_order_date"
    value: text("value").notNull(),
    sourceUrl: text("source_url"),
    sourceMessageId: text("source_message_id"), // from mail secretary
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByRunId: uuid("created_by_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("crm_facts_company_id_idx").on(table.companyId),
    contactIdx: index("crm_facts_contact_id_idx").on(table.contactId),
    organizationIdx: index("crm_facts_organization_id_idx").on(table.organizationId),
  }),
);
