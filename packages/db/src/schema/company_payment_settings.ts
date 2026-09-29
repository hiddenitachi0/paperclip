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
 * `purchasesEnabled` added by migration 0188 (DUR-4046, Maja browser step
 * 6): a separate company-wide switch from `bookingEnabled` -- a company may
 * want the (free, Filip-approved-every-time) booking flow on without ever
 * letting an agent spend from a card, or vice versa -- so the two are not
 * folded into one flag. The threshold/caps/FX-table values themselves stay
 * the shared hardcoded defaults (`packages/shared/src/payment-card-threshold.ts`)
 * for this phase; only the on/off switch lives here. Everything else the
 * design's section 6 lists (merchant allow/deny, warm-up) is a later phase's
 * migration, not added here to avoid a table nobody can populate yet.
 */
export const companyPaymentSettings = pgTable("company_payment_settings", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  bookingEnabled: boolean("booking_enabled").notNull().default(false),
  purchasesEnabled: boolean("purchases_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
