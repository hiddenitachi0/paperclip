import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * CRM organizations (first slice of DUR-4150)
 * Company-scoped: each record belongs to exactly one company.
 * References to external systems (Shopify, Fiken) go in crm_external_refs.
 */
export const crmOrganizations = pgTable(
  "crm_organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    email: text("email"),
    phone: text("phone"),
    website: text("website"),
    industry: text("industry"),
    employeeCount: text("employee_count"),
    location: text("location"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("crm_organizations_company_id_idx").on(table.companyId),
  }),
);
