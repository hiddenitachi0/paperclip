/**
 * DUR-4277: the email UI's company-wide on/off switch, same
 * lazy-row-on-first-write shape as `product-grabber/settings.ts`. A company
 * that never turns this on never gets an `email_company_settings` row --
 * absence reads as "off" (`get()` below), so every existing company sees zero
 * behavior change until a board owner/admin explicitly enables it.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { emailCompanySettings } from "@paperclipai/db";
import type { EmailSettings } from "@paperclipai/shared";

export function emailSettingsService(db: Db) {
  async function get(companyId: string): Promise<EmailSettings> {
    const [row] = await db
      .select({ enabled: emailCompanySettings.enabled })
      .from(emailCompanySettings)
      .where(eq(emailCompanySettings.companyId, companyId));
    return row ?? { enabled: false };
  }

  async function setEnabled(companyId: string, enabled: boolean): Promise<EmailSettings> {
    const [row] = await db
      .insert(emailCompanySettings)
      .values({ companyId, enabled, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: emailCompanySettings.companyId,
        set: { enabled, updatedAt: new Date() },
      })
      .returning({ enabled: emailCompanySettings.enabled });
    return row;
  }

  return { get, setEnabled };
}

export type EmailSettingsService = ReturnType<typeof emailSettingsService>;
