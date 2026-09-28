import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySkills } from "@paperclipai/db";
import { RESEARCH_SKILL_KEY, RESEARCH_SKILL_SLUG, buildSkillMentionHref } from "@paperclipai/shared";
import { companySkillService } from "./company-skills.js";
import { logger } from "../middleware/logger.js";

/**
 * The research-and-plan skill as a skill mention for a task description, so
 * the run mounts it for that task only (resolveRunScopedMentionedSkillKeys).
 * Null when the company does not have it (never fails the hand-over).
 */
export async function findResearchSkillLink(db: Db, companyId: string): Promise<string | null> {
  try {
    const find = async () =>
      db
        .select({ id: companySkills.id, slug: companySkills.slug })
        .from(companySkills)
        .where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, RESEARCH_SKILL_KEY)))
        .then((rows) => rows[0] ?? null);
    let row = await find();
    if (!row) {
      // The bundled skills are copied into a company the first time its skills
      // are listed (every run does it); do it now if nothing has yet.
      await companySkillService(db).listFull(companyId);
      row = await find();
    }
    if (!row) return null;
    return `[${RESEARCH_SKILL_SLUG}](${buildSkillMentionHref(row.id, row.slug)})`;
  } catch (err) {
    logger.warn({ err, companyId }, "research task: could not look up the research-and-plan skill");
    return null;
  }
}
