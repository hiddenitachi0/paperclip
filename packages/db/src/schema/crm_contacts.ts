import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * CRM contacts (first slice of DUR-4150)
 * Company-scoped: each record belongs to exactly one company.
 * Activities and facts are linked separately in crm_activities and crm_facts tables.
 * Organizations are linked through crm_contact_org_roles.
 */
export const crmContacts = pgTable(
  "crm_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    title: text("title"),
    notes: text("notes"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("crm_contacts_company_id_idx").on(table.companyId),
    emailIdx: index("crm_contacts_email_idx").on(table.email),
  }),
);
