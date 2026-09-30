import { eq } from "drizzle-orm";
import { projects, type Db } from "@paperclipai/db";
import type { ProjectDeployAskFirstAction, ProjectDeployPolicyMode } from "@paperclipai/shared";
import { parseProjectDeployPolicy } from "./deploy-policy.js";

/**
 * DUR-4139 (follow-up from the DUR-4136 security review of the deploy policy
 * UI): DUR-4068/DUR-4082 added `deployPolicy.mode` and `.askFirstActions` as
 * storage primitives only -- nothing on the server read them. This is the
 * part that actually enforces them, called from the `kind:"deploy"`
 * `request_board_approval` filing path in routes/approvals.ts, before the
 * card is ever written.
 *
 * Decided ENTIRELY from the project's own board-set `deployPolicy` --
 * `collectDeployPolicyCommandPaths` (workspace-command-authz.ts) keeps
 * `mode`/`askFirstActions` board-only, the same bar as `deployCommand`/
 * `sftpHost`, so nothing here ever reads anything an agent could have just
 * written. A filer (agent or board) supplies no input this function reads at
 * all, by design -- there is no field to lie about.
 *
 * What is enforced today:
 *  - `preview_only` refuses the live deploy request outright (git push and
 *    SFTP both go live; a project in preview-only has no server-enforced
 *    way to reach either).
 *  - A non-empty `askFirstActions` list means the card is always required --
 *    the server has no way to tell, from a commit id alone, whether THIS
 *    deploy is one of the named categories, so it fails closed exactly the
 *    way deploy-change-guard.ts's "unknown never blocks" siblings do it in
 *    reverse: unknown never SKIPS a card either.
 *
 * What is deliberately NOT built here: `auto_after_review` with an empty
 * ask-first list does not yet skip the human decision. Doing that would mean
 * a deploy approval reaching "approved" without a board actor ever deciding
 * it -- server/src/services/merge-pr-automation.ts is the one precedent for
 * approval automation in this codebase, and it is explicitly restricted to
 * `kind:"merge_pr"` only, runs as its own scheduler tick behind its own kill
 * switch (general.mergePrAutomationEnabled, default OFF), and only exists at
 * all because the operator accepted a request_confirmation for it first (see
 * DUR-299/DUR-314 -- rule 3 there: changes to the approval mechanism itself
 * always stop with the operator). `agent-roles.ts`'s DEPLOY_APPROVAL_KEYS
 * hard-codes the same boundary the other direction (no role may ever hold
 * deploys:approve). Building an equivalent for deploy cards needs that same
 * sign-off, not a quiet addition riding along with the ask-first fix -- so
 * `auto_after_review` today behaves like `approval_every_time` until that
 * follow-up lands with its own review.
 */

export interface DeployPolicyDecision {
  /** False when the project's policy refuses this deploy outright (preview_only). */
  allowed: boolean;
  /** Plain-language reason a request is refused. Present exactly when allowed is false. */
  refusalReason?: string;
  mode: ProjectDeployPolicyMode;
  askFirstActions: ProjectDeployAskFirstAction[];
}

const DEFAULT_MODE: ProjectDeployPolicyMode = "approval_every_time";

export function evaluateDeployPolicyForRequest(deployPolicyRaw: unknown): DeployPolicyDecision {
  const deployPolicy = parseProjectDeployPolicy(deployPolicyRaw);
  const mode = deployPolicy?.mode ?? DEFAULT_MODE;
  const askFirstActions = deployPolicy?.askFirstActions ?? [];

  if (mode === "preview_only") {
    return {
      allowed: false,
      refusalReason:
        "This project's deploy policy is set to preview only. Live deploys (git push or SFTP) are disabled -- " +
        "run the project's preview instead, or ask the board to change the deploy mode first.",
      mode,
      askFirstActions,
    };
  }

  return { allowed: true, mode, askFirstActions };
}

/**
 * Fetches the project's current deployPolicy and evaluates it. Separate from
 * `assertDeployRequestProjectExists` in routes/approvals.ts so that function
 * keeps proving only "this id names a real project in this company" --
 * policy enforcement is its own concern with its own test coverage.
 */
export async function evaluateDeployPolicyForProject(
  db: Db,
  projectId: string,
): Promise<DeployPolicyDecision> {
  const projectRow = await db
    .select({ deployPolicy: projects.deployPolicy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .then((rows) => rows[0] ?? null);
  return evaluateDeployPolicyForRequest(projectRow?.deployPolicy ?? null);
}
