/**
 * DUR-4037 (Maja browser step 4): the company-wide booking kill switch,
 * alongside the per-agent `agents.browser_access` dial. A company that never
 * touches this feature never gets a `company_payment_settings` row -- absence
 * reads as "off" (`get()` below), and the row is only created the first time
 * a board actor explicitly turns bookings on via `setBookingEnabled`.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyPaymentSettings } from "@paperclipai/db";

export interface CompanyPaymentSettings {
  companyId: string;
  bookingEnabled: boolean;
}

export function companyPaymentSettingsService(db: Db) {
  async function get(companyId: string): Promise<CompanyPaymentSettings> {
    const [row] = await db
      .select({ companyId: companyPaymentSettings.companyId, bookingEnabled: companyPaymentSettings.bookingEnabled })
      .from(companyPaymentSettings)
      .where(eq(companyPaymentSettings.companyId, companyId));
    return row ?? { companyId, bookingEnabled: false };
  }

  async function setBookingEnabled(companyId: string, bookingEnabled: boolean): Promise<CompanyPaymentSettings> {
    const [row] = await db
      .insert(companyPaymentSettings)
      .values({ companyId, bookingEnabled, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: companyPaymentSettings.companyId,
        set: { bookingEnabled, updatedAt: new Date() },
      })
      .returning({ companyId: companyPaymentSettings.companyId, bookingEnabled: companyPaymentSettings.bookingEnabled });
    return row;
  }

  return { get, setBookingEnabled };
}
