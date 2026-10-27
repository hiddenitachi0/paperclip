// DUR-4182: the Jobs feature's "Starter Pack" — a Legal Advisor position with
// three one-press jobs, seeded the same way seedDurStarterJobs (see
// agent-role-seed.ts) seeds the Boss/Developer positions: scoped to Filip's
// own DUR company only, idempotent by key/title, run at every server
// startup, and a silent no-op where that company row does not exist (fresh
// onboarding, e2e tests, other operators' deployments of this fork).
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, jobPositions, jobs } from "@paperclipai/db";
import { LEGAL_ADVISOR_CATALOGUE_JOBS } from "@paperclipai/shared";
import { createRole, listRoles } from "./agent-roles.js";
import { DUR_COMPANY_ID } from "./agent-role-seed.js";

const LEGAL_ADVISOR_ROLE_KEY = "legal-advisor";

// The job texts live in the shared position catalogue, so "Add from
// catalogue" and this seed always create the same jobs.
const LEGAL_ADVISOR_JOBS = LEGAL_ADVISOR_CATALOGUE_JOBS.map((job) => ({
  title: job.title,
  instructions: job.instructions,
  outputFormat: job.outputFormat,
  variables: job.variables.map((variable) => ({
    name: variable.name,
    label: variable.label,
    type: variable.type,
    defaultValue: variable.defaultValue ?? null,
    required: variable.required,
    options: variable.options ?? [],
  })),
}));

export async function seedLegalAdvisorStarterPack(db: Db): Promise<{ createdPosition: boolean; createdJobs: string[] }> {
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, DUR_COMPANY_ID));
  if (!company) {
    return { createdPosition: false, createdJobs: [] };
  }

  const existingRoles = await listRoles(db, DUR_COMPANY_ID);
  let legalAdvisorRole = existingRoles.find((role) => role.key === LEGAL_ADVISOR_ROLE_KEY);
  let createdPosition = false;
  if (!legalAdvisorRole) {
    legalAdvisorRole = await createRole(db, DUR_COMPANY_ID, {
      name: "Legal Advisor",
      description:
        "Reviews, drafts, and compares contracts. Cites clauses, lists risks, and suggests wording — " +
        "never gives a final legal verdict. That decision always stays with the person who asked.",
      isBuiltin: true,
    });
    createdPosition = true;
  }

  const existingJobs = await db
    .select({ id: jobs.id, title: jobs.title })
    .from(jobs)
    .where(and(eq(jobs.companyId, DUR_COMPANY_ID), eq(jobs.isBuiltin, true)));
  const existingTitles = new Set(existingJobs.map((job) => job.title));

  const createdJobs: string[] = [];
  for (const jobDef of LEGAL_ADVISOR_JOBS) {
    if (existingTitles.has(jobDef.title)) continue;
    const [created] = await db
      .insert(jobs)
      .values({
        companyId: DUR_COMPANY_ID,
        title: jobDef.title,
        instructions: jobDef.instructions,
        status: "active",
        variables: jobDef.variables,
        runMode: "full_agent",
        outputFormat: jobDef.outputFormat,
        requiresApproval: false,
        isBuiltin: true,
      })
      .returning();
    await db.insert(jobPositions).values({
      companyId: DUR_COMPANY_ID,
      jobId: created.id,
      positionId: legalAdvisorRole.id,
    });
    createdJobs.push(jobDef.title);
  }

  return { createdPosition, createdJobs };
}

export { LEGAL_ADVISOR_ROLE_KEY };
