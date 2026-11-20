import type { CommitCiStatus } from "./commit-ci-status.js";

/**
 * DUR-5183: a deploy card is only worth the operator's attention once the checks of the
 * version it ships are green. This turns what GitHub says about the commit's checks into a
 * refusal (or null = let the card through).
 *
 * Same rule as the deploy runner: `none` (no checks set up at all) and `unknown` (GitHub
 * could not be asked) never refuse -- unknown is not evidence of a problem, and a GitHub
 * outage must not become an inability to ask for a deploy.
 */

export const DEPLOY_CI_PENDING_CODE = "deploy_ci_pending";
export const DEPLOY_CI_FAILED_CODE = "deploy_ci_failed";

export interface DeployCiRefusal {
  code: typeof DEPLOY_CI_PENDING_CODE | typeof DEPLOY_CI_FAILED_CODE;
  message: string;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function describeDeployCiRefusal(status: CommitCiStatus): DeployCiRefusal | null {
  if (status.state === "failed") {
    const names = status.failedChecks.length > 0 ? `: ${listWords(status.failedChecks)}` : "";
    return {
      code: DEPLOY_CI_FAILED_CODE,
      message: `This version failed its checks${names}. Fix them and push a new version before filing the card.`,
    };
  }
  if (status.state === "pending") {
    const names = status.pendingChecks.length > 0 ? ` (${listWords(status.pendingChecks)})` : "";
    return {
      code: DEPLOY_CI_PENDING_CODE,
      message: `This version's checks are still running${names}. File the card when they are green.`,
    };
  }
  return null;
}
