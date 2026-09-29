/**
 * DUR-4037 (Maja browser step 4): the company-wide booking kill switch,
 * alongside the per-agent `agents.browser_access` dial. DUR-4046 (step 6)
 * adds `purchasesEnabled`, the same shape but independent -- a company may
 * want bookings on without ever letting an agent spend from a card, or vice
 * versa. A company that never touches this feature never gets a
 * `company_payment_settings` row -- absence reads as "off" for both switches
 * (`get()` below), and the row is only created the first time a board actor
 * explicitly turns one of them on.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyPaymentSettings } from "@paperclipai/db";

export interface CompanyPaymentSettings {
  companyId: string;
  bookingEnabled: boolean;
  purchasesEnabled: boolean;
}

export function companyPaymentSettingsService(db: Db) {
  async function get(companyId: string): Promise<CompanyPaymentSettings> {
    const [row] = await db
      .select({
        companyId: companyPaymentSettings.companyId,
        bookingEnabled: companyPaymentSettings.bookingEnabled,
        purchasesEnabled: companyPaymentSettings.purchasesEnabled,
      })
      .from(companyPaymentSettings)
      .where(eq(companyPaymentSettings.companyId, companyId));
    return row ?? { companyId, bookingEnabled: false, purchasesEnabled: false };
  }

  async function setBookingEnabled(companyId: string, bookingEnabled: boolean): Promise<CompanyPaymentSettings> {
    const [row] = await db
      .insert(companyPaymentSettings)
      .values({ companyId, bookingEnabled, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: companyPaymentSettings.companyId,
        set: { bookingEnabled, updatedAt: new Date() },
      })
      .returning({
        companyId: companyPaymentSettings.companyId,
        bookingEnabled: companyPaymentSettings.bookingEnabled,
        purchasesEnabled: companyPaymentSettings.purchasesEnabled,
      });
    return row;
  }

  async function setPurchasesEnabled(companyId: string, purchasesEnabled: boolean): Promise<CompanyPaymentSettings> {
    const [row] = await db
      .insert(companyPaymentSettings)
      .values({ companyId, purchasesEnabled, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: companyPaymentSettings.companyId,
        set: { purchasesEnabled, updatedAt: new Date() },
      })
      .returning({
        companyId: companyPaymentSettings.companyId,
        bookingEnabled: companyPaymentSettings.bookingEnabled,
        purchasesEnabled: companyPaymentSettings.purchasesEnabled,
      });
    return row;
  }

  return { get, setBookingEnabled, setPurchasesEnabled };
}
