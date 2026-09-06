import { eq } from "drizzle-orm";
import { issues, projects, type Db } from "@paperclipai/db";

export type ProjectDeployBranches = { deployBranch?: string; mirrorBranch?: string; projectId: string };

/**
 * Look up the declared deploy/mirror branch pair (DUR-40) for the project any
 * of the given issues belong to (first match wins, mirroring how
 * `resolveApprovalProjectLabel` in routes/approvals.ts picks a project label).
 * Reads `deployPolicy.deployBranch` / `deployPolicy.mirrorBranch` directly off
 * the `projects` row rather than through `parseProjectDeployPolicy`, so a
 * project without an otherwise-valid deploy policy can still declare a
 * mirror branch.
 *
 * Returns null when no linked project declares either branch, in which case
 * the DUR-40 guard/visibility check is a no-op for that project — the branch
 * distinction was never a promise the platform made for it.
 */
async function readProjectDeployBranches(db: Db, projectId: string): Promise<ProjectDeployBranches | null> {
  const projectRow = await db
    .select({ deployPolicy: projects.deployPolicy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .then((rows) => rows[0] ?? null);
  const policy = (projectRow?.deployPolicy ?? null) as Record<string, unknown> | null;
  const mirrorBranch = typeof policy?.mirrorBranch === "string" ? policy.mirrorBranch : undefined;
  const deployBranch = typeof policy?.deployBranch === "string" ? policy.deployBranch : undefined;
  if (mirrorBranch || deployBranch) return { mirrorBranch, deployBranch, projectId };
  return null;
}

export async function resolveProjectDeployBranches(
  db: Db,
  issueIds: string[],
): Promise<ProjectDeployBranches | null> {
  for (const issueId of issueIds) {
    const issueRow = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issueRow?.projectId) continue;
    const result = await readProjectDeployBranches(db, issueRow.projectId);
    if (result) return result;
  }
  return null;
}

/**
 * DUR-227/DUR-238: same lookup as `resolveProjectDeployBranches`, but keyed directly
 * off a project id instead of walking issue links -- both the deploy-approval filing
 * path (routes/approvals.ts) and the carried-issue closer only ever have a deploy
 * approval's `payload.projectId`, not an issue to resolve through.
 */
export async function resolveProjectDeployBranchesByProjectId(
  db: Db,
  projectId: string,
): Promise<ProjectDeployBranches | null> {
  return readProjectDeployBranches(db, projectId);
}
