/**
 * DUR-4182 (Positions/Jobs backend): the company-wide switch for the new
 * one-press "Jobs" surface (file-upload variables claimed onto the run's
 * issue, position-linked jobs, the Legal Advisor starter pack). Same lazy-row
 * pattern as company-payment-settings.ts -- a company that never touches this
 * never gets a `company_job_settings` row, and absence reads as "off". The
 * row is only created the first time a board owner/admin explicitly turns it
 * on. Existing Routine CRUD/run behaviour is unaffected either way; this only
 * gates the genuinely new surface area DUR-4182 adds.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyJobSettings } from "@paperclipai/db";

export interface CompanyJobSettings {
  companyId: string;
  jobsEnabled: boolean;
}

export function companyJobSettingsService(db: Db) {
  async function get(companyId: string): Promise<CompanyJobSettings> {
    const [row] = await db
      .select({
        companyId: companyJobSettings.companyId,
        jobsEnabled: companyJobSettings.jobsEnabled,
      })
      .from(companyJobSettings)
      .where(eq(companyJobSettings.companyId, companyId));
    return row ?? { companyId, jobsEnabled: false };
  }

  async function setJobsEnabled(companyId: string, jobsEnabled: boolean): Promise<CompanyJobSettings> {
    const [row] = await db
      .insert(companyJobSettings)
      .values({ companyId, jobsEnabled, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: companyJobSettings.companyId,
        set: { jobsEnabled, updatedAt: new Date() },
      })
      .returning({
        companyId: companyJobSettings.companyId,
        jobsEnabled: companyJobSettings.jobsEnabled,
      });
    return row;
  }

  return { get, setJobsEnabled };
}
