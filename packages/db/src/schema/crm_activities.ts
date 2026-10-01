import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { crmContacts } from "./crm_contacts.js";
import { crmOrganizations } from "./crm_organizations.js";

/**
 * CRM activities / timeline (first slice of DUR-4150)
 * Company-scoped: tracks email, calls, meetings, notes in the contact timeline.
 * All activities have activity_date and are queryable for timeline views.
 * contact_id and organization_id are both nullable (activity may involve both, or neither).
 */
export const crmActivities = pgTable(
  "crm_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => crmContacts.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => crmOrganizations.id, { onDelete: "set null" }),
    type: text("type").notNull(), // email, call, meeting, note, task, other
    title: text("title").notNull(),
    description: text("description"),
    activityDate: timestamp("activity_date", { withTimezone: true }).notNull().defaultNow(),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("crm_activities_company_id_idx").on(table.companyId),
    contactIdx: index("crm_activities_contact_id_idx").on(table.contactId),
    organizationIdx: index("crm_activities_organization_id_idx").on(table.organizationId),
    activityDateIdx: index("crm_activities_activity_date_idx").on(table.activityDate),
    typeCheck: check(
      "crm_activities_type_check",
      sql`${table.type} IN ('email', 'call', 'meeting', 'note', 'task', 'other')`,
    ),
  }),
);
