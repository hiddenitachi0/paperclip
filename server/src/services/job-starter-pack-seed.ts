// DUR-4182: the Jobs feature's "Starter Pack" — a Legal Advisor position with
// three one-press jobs, seeded the same way seedDurStarterJobs (see
// agent-role-seed.ts) seeds the Boss/Developer positions: scoped to Filip's
// own DUR company only, idempotent by key/title, run at every server
// startup, and a silent no-op where that company row does not exist (fresh
// onboarding, e2e tests, other operators' deployments of this fork).
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, companyAgentRoles, jobPositions, jobs } from "@paperclipai/db";
import { createRole, listRoles } from "./agent-roles.js";
import { DUR_COMPANY_ID } from "./agent-role-seed.js";

const LEGAL_ADVISOR_ROLE_KEY = "legal-advisor";

const LEGAL_ADVISOR_JOBS: Array<{ title: string; instructions: string; outputFormat: string }> = [
  {
    title: "Revise contract",
    outputFormat: "redline",
    instructions:
      "Revise the attached contract for the stated goal.\n\n" +
      "Checklist (work through every item):\n" +
      "- [ ] Read the whole contract before changing anything\n" +
      "- [ ] Identify every clause that conflicts with the stated goal or applicable law\n" +
      "- [ ] Propose specific wording changes, clause by clause\n" +
      "- [ ] List every risk the current wording creates, even ones you did not change\n" +
      "- [ ] Cite the exact clause number/heading for every point you raise\n\n" +
      "Output: a clause-by-clause list. For each clause you touch, cite it (e.g. \"Clause 4.2 "
      + "(Termination)\"), explain the risk in the current wording, and suggest replacement wording.\n\n"
      + "Hard rule: never give a final legal verdict (\"this contract is valid/enforceable/safe to "
      + "sign\"). Flag open risks and suggest wording; the decision to sign stays with the person who "
      + "asked for this.",
  },
  {
    title: "Draft new contract",
    outputFormat: "markdown_document",
    instructions:
      "Draft a new contract for the stated purpose and parties.\n\n" +
      "Checklist (work through every item):\n" +
      "- [ ] Confirm the parties, purpose, term, and governing law given in the request\n" +
      "- [ ] Include the standard clauses that purpose/jurisdiction requires\n" +
      "- [ ] Cite the clause number/heading for every provision you call out as important\n" +
      "- [ ] List the risks of each major clause (e.g. termination, liability, IP assignment)\n" +
      "- [ ] Suggest wording options where more than one reasonable approach exists\n\n" +
      "Hard rule: never give a final legal verdict (\"this contract is valid/enforceable/ready to "
      + "sign\"). Present the draft with its tradeoffs and open risks; the decision to use it stays "
      + "with the person who asked for this.",
  },
  {
    title: "Compare two versions",
    outputFormat: "markdown_document",
    instructions:
      "Compare the two attached contract versions.\n\n" +
      "Checklist (work through every item):\n" +
      "- [ ] Diff the two versions clause by clause, not just by visible text changes\n" +
      "- [ ] Cite the clause number/heading for every difference you report\n" +
      "- [ ] List the risk each change introduces or removes\n" +
      "- [ ] Suggest wording where a changed clause is ambiguous or one-sided\n" +
      "- [ ] Flag any clause removed entirely between versions\n\n" +
      "Hard rule: never give a final legal verdict (\"version B is safe/ready to sign\"). Report "
      + "differences and risks with citations; the decision stays with the person who asked for this.",
  },
];

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
        variables: [],
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
