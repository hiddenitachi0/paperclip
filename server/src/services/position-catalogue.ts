// Ready-to-hire positions ("Add from catalogue" on the Positions page) and
// the one-time conversion of the old Brag position into a skill.
//
// The catalogue data itself lives in @paperclipai/shared (position-catalogue.ts)
// so the board UI can show it too. Adding an entry creates an ordinary,
// editable company position (is_builtin = true, provenance only) plus its
// one-click jobs; it never touches an existing position's settings and never
// creates a second copy of a position or job that is already there.
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyAgentRoles, companySkills, jobPositions, jobs } from "@paperclipai/db";
import {
  CATALOGUE_SKILL_KEYS,
  POSITION_CATALOGUE,
  catalogueSkillIdForKey,
  findPositionTemplate,
  type PositionCatalogueEntry,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { createRole, resolveAgentRoleProvisioning } from "./agent-roles.js";

export const BRAG_POSITION_KEY = "brag";
export const CONTENT_VIDEO_PRODUCER_KEY = "content-video-producer";

/** The effective skill keys an agent gets from its position (agents.role_provisioned_skill_keys). */
export function readPositionSkillKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export interface PositionCatalogueListItem extends PositionCatalogueEntry {
  /** The company already has a position with this key. */
  alreadyAdded: boolean;
  existingPositionId: string | null;
  /** Catalogue skills this position uses that the company has not installed yet. */
  missingSkillKeys: string[];
}

type RoleRow = typeof companyAgentRoles.$inferSelect;

async function installedSkillKeys(db: Db, companyId: string): Promise<Set<string>> {
  const rows = await db
    .select({ key: companySkills.key })
    .from(companySkills)
    .where(eq(companySkills.companyId, companyId));
  return new Set(rows.map((row) => row.key));
}

/**
 * Skills of a template that still need installing from the skills catalogue.
 * paperclipai/paperclip/* skills are installed in every company automatically,
 * so they are never reported as missing.
 */
export function missingCatalogueSkills(template: PositionCatalogueEntry, installed: Set<string>): string[] {
  return template.skillKeys.filter((key) => catalogueSkillIdForKey(key) !== null && !installed.has(key));
}

export async function listPositionCatalogue(db: Db, companyId: string): Promise<PositionCatalogueListItem[]> {
  const roles = await db
    .select({ id: companyAgentRoles.id, key: companyAgentRoles.key })
    .from(companyAgentRoles)
    .where(eq(companyAgentRoles.companyId, companyId));
  const roleIdByKey = new Map(roles.map((role) => [role.key, role.id]));
  const installed = await installedSkillKeys(db, companyId);
  return POSITION_CATALOGUE.map((entry) => {
    const existingPositionId = roleIdByKey.get(entry.key) ?? null;
    return {
      ...entry,
      alreadyAdded: existingPositionId !== null,
      existingPositionId,
      missingSkillKeys: missingCatalogueSkills(entry, installed),
    };
  });
}

export interface AddPositionFromCatalogueResult {
  position: RoleRow;
  createdPosition: boolean;
  /** Jobs that did not exist and were created, linked to the position. */
  createdJobs: string[];
  /** Jobs that already existed (same title) and were linked to the position. */
  linkedJobs: string[];
  /** Catalogue skills the position uses that are not installed in the company. */
  missingSkillKeys: string[];
}

async function ensureTemplateJobs(
  db: Db,
  companyId: string,
  positionId: string,
  template: PositionCatalogueEntry,
): Promise<{ createdJobs: string[]; linkedJobs: string[] }> {
  const existingJobs = await db
    .select({ id: jobs.id, title: jobs.title })
    .from(jobs)
    .where(eq(jobs.companyId, companyId));
  const jobIdByTitle = new Map(existingJobs.map((job) => [job.title.trim().toLowerCase(), job.id]));

  const createdJobs: string[] = [];
  const linkedJobs: string[] = [];
  for (const jobDef of template.jobs) {
    const existingId = jobIdByTitle.get(jobDef.title.trim().toLowerCase());
    if (existingId) {
      const inserted = await db
        .insert(jobPositions)
        .values({ companyId, jobId: existingId, positionId })
        .onConflictDoNothing()
        .returning({ id: jobPositions.id });
      if (inserted.length > 0) linkedJobs.push(jobDef.title);
      continue;
    }
    // Inserted directly (not through jobService.create) on purpose, like the
    // Legal Advisor starter pack: a job definition is inert until the
    // company turns Jobs on, so adding a position must not depend on that
    // setting.
    const [created] = await db
      .insert(jobs)
      .values({
        companyId,
        title: jobDef.title,
        instructions: jobDef.instructions,
        status: "active",
        variables: jobDef.variables.map((variable) => ({
          name: variable.name,
          label: variable.label,
          type: variable.type,
          defaultValue: variable.defaultValue ?? null,
          required: variable.required,
          options: variable.options ?? [],
        })),
        runMode: jobDef.runMode,
        modelProfile: jobDef.modelProfile ?? null,
        effort: jobDef.effort ?? null,
        outputFormat: jobDef.outputFormat,
        requiresApproval: jobDef.requiresApproval,
        isBuiltin: true,
      })
      .returning({ id: jobs.id });
    await db.insert(jobPositions).values({ companyId, jobId: created!.id, positionId });
    jobIdByTitle.set(jobDef.title.trim().toLowerCase(), created!.id);
    createdJobs.push(jobDef.title);
  }
  return { createdJobs, linkedJobs };
}

/**
 * Add one catalogue position (and its jobs) to a company. Idempotent: a
 * position that already exists keeps all of its settings; only missing jobs
 * are added and linked to it.
 */
export async function addPositionFromCatalogue(
  db: Db,
  companyId: string,
  templateKey: string,
): Promise<AddPositionFromCatalogueResult> {
  const template = findPositionTemplate(templateKey);
  if (!template) throw notFound("That position is not in the catalogue");

  const [existing] = await db
    .select()
    .from(companyAgentRoles)
    .where(and(eq(companyAgentRoles.companyId, companyId), eq(companyAgentRoles.key, template.key)));

  let position: RoleRow;
  let createdPosition = false;
  if (existing) {
    position = existing;
  } else {
    position = await createRole(db, companyId, {
      name: template.name,
      description: template.description,
      defaultInstructions: template.defaultInstructions,
      defaultGrants: template.defaultGrants,
      skillKeys: template.skillKeys,
      connectorKeys: template.connectorKeys,
      isBuiltin: true,
    });
    createdPosition = true;
  }

  const { createdJobs, linkedJobs } = await ensureTemplateJobs(db, companyId, position.id, template);
  const missingSkillKeys = missingCatalogueSkills(template, await installedSkillKeys(db, companyId));
  return { position, createdPosition, createdJobs, linkedJobs, missingSkillKeys };
}

// ── Brag: a skill, not a position ─────────────────────────────────────────
// DUR-4519 seeded a "Brag" position whose only content was the brag skill.
// Brag is a skill, so it now sits on the Content & Video Producer position.
// This runs at every startup and is a no-op once nothing is left to convert.

// Only the position Paperclip itself seeded is converted: built-in, holding
// exactly the brag skill, with no rights, tool connections or MCP servers.
// A position someone made (or customised) under the key "brag" is left alone,
// so its instructions, grants and connectors are never lost silently.
export function isSeededBragPosition(role: RoleRow): boolean {
  if (role.key !== BRAG_POSITION_KEY || !role.isBuiltin) return false;
  const skillKeys = (role.skillKeys as string[] | null) ?? [];
  const grants = (role.defaultGrants as unknown[] | null) ?? [];
  const connectors = (role.connectorKeys as string[] | null) ?? [];
  const mcp = (role.defaultMcpServers as unknown[] | null) ?? [];
  return (
    skillKeys.length === 1 &&
    skillKeys[0] === CATALOGUE_SKILL_KEYS.brag &&
    grants.length === 0 &&
    connectors.length === 0 &&
    mcp.length === 0
  );
}

export interface BragConversionResult {
  companyId: string;
  bragPositionId: string;
  targetPositionId: string;
  createdTargetPosition: boolean;
  movedAgentIds: string[];
  movedJobIds: string[];
}

export async function convertBragPositionsToSkill(db: Db): Promise<BragConversionResult[]> {
  const bragRoles = (
    await db.select().from(companyAgentRoles).where(eq(companyAgentRoles.key, BRAG_POSITION_KEY))
  ).filter(isSeededBragPosition);

  const results: BragConversionResult[] = [];
  for (const brag of bragRoles) {
    const added = await addPositionFromCatalogue(db, brag.companyId, CONTENT_VIDEO_PRODUCER_KEY);
    const target = added.position;

    // Move every agent that holds the Brag position. Brag never carried
    // rights or tool connections, so there is nothing to revoke; the
    // provisioning pass below grants whatever the target position carries.
    const heldBy = await db
      .select({ id: agents.id, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(and(eq(agents.companyId, brag.companyId), eq(agents.roleId, brag.id)));
    for (const agent of heldBy) {
      const adapterConfig = { ...((agent.adapterConfig as Record<string, unknown> | null) ?? {}) };
      if (!adapterConfig.bootstrapPromptTemplate && target.defaultInstructions) {
        adapterConfig.bootstrapPromptTemplate = target.defaultInstructions;
      }
      await db
        .update(agents)
        .set({
          roleId: target.id,
          adapterConfig,
          roleAppliedMcpServerNames: [],
          roleAppliedPermissionKeys: [],
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agent.id));
      await resolveAgentRoleProvisioning(db, agent.id);
    }

    // Keep any job someone linked to Brag, now linked to the new position.
    const links = await db
      .select({ jobId: jobPositions.jobId })
      .from(jobPositions)
      .where(eq(jobPositions.positionId, brag.id));
    if (links.length > 0) {
      await db
        .insert(jobPositions)
        .values(links.map((link) => ({ companyId: brag.companyId, jobId: link.jobId, positionId: target.id })))
        .onConflictDoNothing();
    }

    await db.delete(companyAgentRoles).where(eq(companyAgentRoles.id, brag.id));

    results.push({
      companyId: brag.companyId,
      bragPositionId: brag.id,
      targetPositionId: target.id,
      createdTargetPosition: added.createdPosition,
      movedAgentIds: heldBy.map((agent) => agent.id),
      movedJobIds: links.map((link) => link.jobId),
    });
  }
  return results;
}

/** Catalogue skill ids ("paperclipai:optional:content:brag") for the given keys. */
export function catalogueSkillIds(skillKeys: string[]): Array<{ key: string; catalogSkillId: string }> {
  return skillKeys.flatMap((key) => {
    const catalogSkillId = catalogueSkillIdForKey(key);
    return catalogSkillId ? [{ key, catalogSkillId }] : [];
  });
}
