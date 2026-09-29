import { boolean, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Company payment settings (migration 0186, DUR-4037 -- Maja browser step 4):
 * the company-wide kill switch the design calls for alongside the per-agent
 * `agents.browser_access` dial ("Everything behind agents.browser_access =
 * book_and_buy (default off) AND the company kill switch"). One row per
 * company, created lazily on first read (see
 * `server/src/services/company-payment-settings.ts`) so a company that never
 * touches this feature never gets one -- absence means "off", exactly like
 * `booking_enabled`'s own default.
 *
 * Scope for this phase is booking only, per the issue -- the purchase-side
 * columns the design's section 6 lists (thresholds, daily/weekly/per-merchant
 * caps, the FX table, merchant allow/deny, warm-up) are a later phase's
 * migration, not added here to avoid a table nobody can populate yet.
 */
export const companyPaymentSettings = pgTable("company_payment_settings", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  bookingEnabled: boolean("booking_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
