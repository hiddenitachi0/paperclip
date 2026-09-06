import { pgTable, uuid, boolean, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// DUR-134: the "global" half of the kill switch (item 6) -- stops
// publishing for every persona/account in the company at once, on the next
// publish attempt. Company-scoped rather than instance-wide: this codebase
// is multi-tenant per-company (see company-scope middleware, DUR-277), and
// nothing else in the persona publishing feature is instance-wide, so a
// literal cross-tenant switch would be an odd one-off. One row per company,
// created lazily on first toggle (absence of a row means "not paused").
export const personaPublishingCompanySettings = pgTable(
  "persona_publishing_company_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    publishingPaused: boolean("publishing_paused").notNull().default(false),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedByUserId: text("paused_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("persona_publishing_company_settings_company_uq").on(table.companyId),
  }),
);
