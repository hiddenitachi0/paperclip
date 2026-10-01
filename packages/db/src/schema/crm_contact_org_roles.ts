import { index, pgTable, text, timestamp, uuid, date } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { crmContacts } from "./crm_contacts.js";
import { crmOrganizations } from "./crm_organizations.js";

/**
 * CRM contact-organization relationship with role
 * Company-scoped: join table for contacts and organizations.
 * Tracks roles, start/end dates for employment or relationships.
 */
export const crmContactOrgRoles = pgTable(
  "crm_contact_org_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull().references(() => crmContacts.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").notNull().references(() => crmOrganizations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    startDate: date("start_date"),
    endDate: date("end_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    contactIdx: index("crm_contact_org_roles_contact_id_idx").on(table.contactId),
    organizationIdx: index("crm_contact_org_roles_organization_id_idx").on(table.organizationId),
  }),
);
