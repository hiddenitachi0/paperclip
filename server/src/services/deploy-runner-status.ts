import { existsSync, readFileSync, statSync } from "node:fs";

// scripts/deploy-runner.sh (DUR-44) mirrors every comment attempt it makes —
// delivered or not — into this JSONL file inside the server container's own
// volume, so an agent without host/docker access can see recent runner
// activity instead of needing a human to read deploy-runner.log by hand.
export const DEPLOY_RUNNER_STATUS_PATH =
  process.env.PAPERCLIP_DEPLOY_RUNNER_STATUS_PATH?.trim() || "/paperclip/deploy-runner/status.jsonl";

// The runner itself trims this file to ~500 lines after every write; a file
// far larger than that means something is wrong with the trim step, so
// refuse to load it into memory rather than risk an unbounded read.
const MAX_STATUS_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export type DeployRunnerStatusEntry = {
  ts: string;
  approvalId: string;
  companyId: string;
  commentDelivered: boolean;
  body: string;
  // DUR-152: optional structured outcome alongside the free-text `body` a
  // human reads. `scripts/deploy-runner.sh` sets this to "carried" when it
  // determines (via a real `git merge-base --is-ancestor` check, not string
  // matching) that this approval's own target commit already shipped as
  // part of a different approval's deploy — so a consumer of this log can
  // confirm the change is live without depending on the runner's literal
  // success sentence, which a superseded approval's comment never contains.
  outcome?: string;
  // The commit this entry's outcome pertains to, when known.
  commit?: string;
};

function isDeployRunnerStatusEntry(value: unknown): value is DeployRunnerStatusEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ts === "string" &&
    typeof v.approvalId === "string" &&
    typeof v.companyId === "string" &&
    typeof v.commentDelivered === "boolean" &&
    typeof v.body === "string" &&
    (v.outcome === undefined || typeof v.outcome === "string") &&
    (v.commit === undefined || typeof v.commit === "string")
  );
}

export function readDeployRunnerStatus(companyId: string, limit?: number): DeployRunnerStatusEntry[] {
  const boundedLimit =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), MAX_LIMIT)
      : DEFAULT_LIMIT;

  if (!existsSync(DEPLOY_RUNNER_STATUS_PATH)) return [];
  if (statSync(DEPLOY_RUNNER_STATUS_PATH).size > MAX_STATUS_FILE_BYTES) return [];

  const raw = readFileSync(DEPLOY_RUNNER_STATUS_PATH, "utf8");
  const entries: DeployRunnerStatusEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // The file mixes every company's deploy activity — filter here, not just
    // by access control, or one company could read another's deploy history.
    if (isDeployRunnerStatusEntry(parsed) && parsed.companyId === companyId) {
      entries.push(parsed);
    }
  }
  return entries.slice(-boundedLimit);
}
