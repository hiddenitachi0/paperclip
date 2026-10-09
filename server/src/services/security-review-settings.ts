/**
 * DUR-4566: which agent is "the company's security reviewer" -- the only
 * agent (alongside a board user) who may record a merge-card security-review
 * verdict. Same lazy-row-on-first-write shape as `email/settings.ts`: a
 * company that never sets this has no row, and absence reads as
 * `{ securityReviewerAgentId: null }`.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySecurityReviewSettings } from "@paperclipai/db";
import type { SecurityReviewSettings } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export function securityReviewSettingsService(db: Db) {
  async function get(companyId: string): Promise<SecurityReviewSettings> {
    const [row] = await db
      .select({ securityReviewerAgentId: companySecurityReviewSettings.securityReviewerAgentId })
      .from(companySecurityReviewSettings)
      .where(eq(companySecurityReviewSettings.companyId, companyId));
    return row ?? { securityReviewerAgentId: null };
  }

  async function setReviewerAgentId(
    companyId: string,
    securityReviewerAgentId: string | null,
  ): Promise<SecurityReviewSettings> {
    if (securityReviewerAgentId) {
      const [agent] = await db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, securityReviewerAgentId));
      if (!agent || agent.companyId !== companyId) {
        throw unprocessable("That agent is not part of this company.");
      }
    }
    const [row] = await db
      .insert(companySecurityReviewSettings)
      .values({ companyId, securityReviewerAgentId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: companySecurityReviewSettings.companyId,
        set: { securityReviewerAgentId, updatedAt: new Date() },
      })
      .returning({ securityReviewerAgentId: companySecurityReviewSettings.securityReviewerAgentId });
    return row;
  }

  return { get, setReviewerAgentId };
}

export type SecurityReviewSettingsService = ReturnType<typeof securityReviewSettingsService>;
