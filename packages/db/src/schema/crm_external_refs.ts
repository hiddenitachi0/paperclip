import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { crmContacts } from "./crm_contacts.js";
import { crmOrganizations } from "./crm_organizations.js";

/**
 * CRM external references (first slice of DUR-4150)
 * Company-scoped: links to external systems (Shopify, Fiken, dashboard, etc.)
 * Records are referenced, not copied. Sync metadata tracks last update from external system.
 * Composite unique constraint ensures one external ID per (company, system) pair.
 */
export const crmExternalRefs = pgTable(
  "crm_external_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => crmContacts.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => crmOrganizations.id, { onDelete: "cascade" }),
    system: text("system").notNull(), // e.g. "shopify", "fiken", "dashboard", "linkedin"
    externalId: text("external_id").notNull(),
    externalUrl: text("external_url"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("crm_external_refs_company_id_idx").on(table.companyId),
    contactIdx: index("crm_external_refs_contact_id_idx").on(table.contactId),
    organizationIdx: index("crm_external_refs_organization_id_idx").on(table.organizationId),
    externalRefUnique: unique("crm_external_refs_unique").on(table.companyId, table.system, table.externalId),
  }),
);
