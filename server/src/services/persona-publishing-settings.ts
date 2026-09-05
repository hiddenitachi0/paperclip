// DUR-134: the company-wide half of the publishing kill switch (item 6).
// One row per company, created lazily on first toggle -- absence of a row
// means "not paused" (see persona_publishing_company_settings' schema
// comment). Checked by persona-publisher.ts at the top of every publish
// attempt, alongside the per-persona and per-account halves.
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { personaPublishingCompanySettings } from "@paperclipai/db";

export type PersonaPublishingCompanySettingsRow = typeof personaPublishingCompanySettings.$inferSelect;

export function personaPublishingSettingsService(db: Db) {
  async function getSettings(companyId: string): Promise<PersonaPublishingCompanySettingsRow | null> {
    const [row] = await db
      .select()
      .from(personaPublishingCompanySettings)
      .where(eq(personaPublishingCompanySettings.companyId, companyId));
    return row ?? null;
  }

  async function isPublishingPaused(companyId: string): Promise<boolean> {
    const settings = await getSettings(companyId);
    return settings?.publishingPaused ?? false;
  }

  async function setPublishingPaused(
    companyId: string,
    publishingPaused: boolean,
    pausedByUserId: string | null,
  ): Promise<PersonaPublishingCompanySettingsRow> {
    const existing = await getSettings(companyId);
    const now = new Date();
    if (!existing) {
      const [created] = await db
        .insert(personaPublishingCompanySettings)
        .values({
          companyId,
          publishingPaused,
          pausedAt: publishingPaused ? now : null,
          pausedByUserId: publishingPaused ? pausedByUserId : null,
        })
        .returning();
      return created!;
    }

    const [updated] = await db
      .update(personaPublishingCompanySettings)
      .set({
        publishingPaused,
        pausedAt: publishingPaused ? now : null,
        pausedByUserId: publishingPaused ? pausedByUserId : null,
        updatedAt: now,
      })
      .where(eq(personaPublishingCompanySettings.id, existing.id))
      .returning();
    return updated!;
  }

  return { getSettings, isPublishingPaused, setPublishingPaused };
}
