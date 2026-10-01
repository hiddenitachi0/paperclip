/**
 * DUR-4187: the product grabber's company-wide on/off switch, same
 * lazy-row-on-first-write shape as `company-payment-settings.ts`. A company
 * that never turns this on never gets a `company_product_grabber_settings`
 * row -- absence reads as "off" (`get()` below), so every existing company
 * sees zero behavior change until a board owner/admin explicitly enables it.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyProductGrabberSettings } from "@paperclipai/db";
import type { ProductGrabberSettings } from "@paperclipai/shared";

export function productGrabberSettingsService(db: Db) {
  async function get(companyId: string): Promise<ProductGrabberSettings> {
    const [row] = await db
      .select({ companyId: companyProductGrabberSettings.companyId, enabled: companyProductGrabberSettings.enabled })
      .from(companyProductGrabberSettings)
      .where(eq(companyProductGrabberSettings.companyId, companyId));
    return row ?? { companyId, enabled: false };
  }

  async function setEnabled(companyId: string, enabled: boolean): Promise<ProductGrabberSettings> {
    const [row] = await db
      .insert(companyProductGrabberSettings)
      .values({ companyId, enabled, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: companyProductGrabberSettings.companyId,
        set: { enabled, updatedAt: new Date() },
      })
      .returning({ companyId: companyProductGrabberSettings.companyId, enabled: companyProductGrabberSettings.enabled });
    return row;
  }

  return { get, setEnabled };
}

export type ProductGrabberSettingsService = ReturnType<typeof productGrabberSettingsService>;
