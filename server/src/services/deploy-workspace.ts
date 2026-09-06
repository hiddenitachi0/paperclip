import { eq } from "drizzle-orm";
import { projects, type Db } from "@paperclipai/db";

/**
 * DUR-3926: the workspace scripts/deploy-runner.sh actually deploys for a
 * project is `deployPolicy.workspaceId` on the `projects` row. The runner
 * refuses -- silently, from the operator's point of view -- any approved deploy
 * card whose `payload.workspaceId` names a different workspace, and agents
 * routinely paste a repo/checkout workspace id or their own agent id there
 * instead. The filing route uses this to stamp the real deploy workspace onto
 * the card, the same way DUR-284 stamps the branches. Returns null when the
 * project declares no deploy workspace (the caller's value then stands, as
 * before).
 *
 * Lives in its own module (not deploy-branches.ts) so the many route suites
 * that mock deploy-branches.js keep working unchanged.
 */
export async function resolveProjectDeployWorkspaceId(db: Db, projectId: string): Promise<string | null> {
  const projectRow = await db
    .select({ deployPolicy: projects.deployPolicy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .then((rows) => rows[0] ?? null);
  const policy = projectRow?.deployPolicy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const workspaceId = (policy as Record<string, unknown>).workspaceId;
  return typeof workspaceId === "string" && workspaceId.trim() ? workspaceId.trim() : null;
}

/**
 * DUR-3926: an agent that files a `request_board_approval` with a made-up
 * kind such as "deploy_release" or "rollout" gets a card an operator can
 * approve but that nothing ever acts on (the runner only handles
 * `kind:"deploy"`). Catch that at filing time with a plain-language error.
 */
export function describeUnknownDeployLikeKind(kind: unknown): string | null {
  if (typeof kind !== "string") return null;
  const normalized = kind.trim();
  if (!normalized || normalized === "deploy") return null;
  if (!/deploy|release|rollout|ship/i.test(normalized)) return null;
  return (
    `Unknown approval kind "${normalized}". A request to deploy must use kind "deploy" with projectId, ` +
    `workspaceId, commit, title and note, so the deploy runner can act on it once approved. ` +
    `Nothing acts on kind "${normalized}", so the card would sit approved and do nothing.`
  );
}
