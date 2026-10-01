import { pgTable, uuid, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * DUR-4277: the email UI's per-company on/off switch (gates DUR-4195 so the
 * email frontend ships "behind a setting, off by default" per DUR-4149). Same
 * lazy-row-on-first-write shape as `company_product_grabber_settings`: a
 * company that never turns this on never gets a row, and absence reads as "off"
 * (`server/src/services/email/settings.ts`), so every existing company sees
 * zero behavior change until a board owner/admin explicitly enables it.
 */
export const emailCompanySettings = pgTable(
  "email_company_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("email_company_settings_company_uq").on(table.companyId),
  }),
);
