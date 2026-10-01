import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Product grabber (DUR-4151/DUR-4169/DUR-4187): fetches product data + images
 * from a vendor site into a staging list a person approves before anything is
 * used. The grabber itself never writes to a storefront -- approval is the
 * last step this table knows about.
 *
 * `companyProductGrabberSettings` is the per-company on/off switch, same
 * lazy-row-on-first-write shape as `company_payment_settings`: a company that
 * never turns this on never gets a row, and absence reads as "off"
 * (`server/src/services/product-grabber/settings.ts`).
 *
 * `productGrabberStagedItems` is one row per grabbed product, template output
 * (`rawFields`) kept as-extracted so a reviewer can see exactly what the
 * template parsed, not a normalized/lossy projection of it.
 */
export const companyProductGrabberSettings = pgTable("company_product_grabber_settings", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const productGrabberStagedItems = pgTable(
  "product_grabber_staged_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    vendor: text("vendor").notNull(),
    sourceUrl: text("source_url").notNull(),
    rawFields: jsonb("raw_fields").$type<Record<string, unknown>>().notNull(),
    imageUrls: jsonb("image_urls").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("pending"),
    approvedByUserId: text("approved_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("product_grabber_staged_items_company_status_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    companySourceUrlIdx: index("product_grabber_staged_items_company_source_url_idx").on(
      table.companyId,
      table.sourceUrl,
    ),
    statusCheck: check(
      "product_grabber_staged_items_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected')`,
    ),
  }),
);
