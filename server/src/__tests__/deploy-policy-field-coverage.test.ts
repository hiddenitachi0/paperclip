import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deployPolicySchema } from "@paperclipai/shared";
import { parseProjectDeployPolicy } from "../services/deploy-policy.js";

/**
 * DUR-3974: a project's deploy settings are spelled out in FOUR places that
 * have to agree, and nothing used to make them:
 *
 *   1. `deployPolicySchema`                     — what the API accepts
 *   2. `ProjectDeployPolicy` (workspace-runtime) — what every consumer imports
 *   3. `parseProjectDeployPolicy`                — what survives a DB read
 *   4. `resolve_deploy_vars` in deploy-runner.sh — what the deploy actually uses
 *
 * (1) and (2) are held together by a compile-time assertion in
 * packages/shared/src/validators/project.ts. This file covers (3) and (4),
 * which are runtime/shell code that type-checking cannot reach: a field added
 * to the schema and forgotten in either of them type-checks perfectly and then
 * silently never reaches the box.
 *
 * Both directions are enforced, so neither list can rot: every schema field
 * must be accounted for, and every exemption named here must still be a real
 * schema field.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const DEPLOY_RUNNER = path.join(repoRoot, "scripts", "deploy-runner.sh");

/** One value of the right shape for every field the schema declares. */
const FULLY_POPULATED_POLICY = {
  enabled: true,
  requestingAgentId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  deployTargetPath: "/root/example",
  deployKind: "compose_recreate",
  deployServices: ["web", "worker"],
  deployCommand: "./deploy.sh",
  composeFiles: ["docker/docker-compose.yml"],
  envFile: ".env.prod",
  healthCheckUrl: "https://example.com/api/health",
  appHealthCheckPaths: ["/dashboard", "/reports"],
  rollback: "git_previous",
  deployBranch: "custom",
  mirrorBranch: "master",
  previewCommand: "pnpm dev",
  previewHealthPath: "/",
  mode: "auto_after_review",
  askFirstActions: ["live_data_write"],
  sftpHost: "sftp.example.com",
  sftpPort: 22,
  sftpUsername: "deployer",
  sftpRemotePath: "/var/www/site",
  sftpAllowlist: ["dist/index.html"],
  releaseRetentionCount: 10,
} as const;

/**
 * Fields the deploy runner deliberately does not read, with the reason. A
 * field may only be listed here for a reason that is true of the runner, not
 * because adding it was inconvenient.
 */
const NOT_USED_BY_THE_RUNNER: Record<string, string> = {
  deployBranch: "the runner deploys the workspace's own repoRef; deployBranch gates the merge approval, server-side",
  mirrorBranch: "purely a server-side guard on which branch a merge_pr card may target",
  previewCommand: "previews are started by the server for an undecided card, never by the deploy runner",
  previewHealthPath: "same as previewCommand — it belongs to the preview, not to a deploy",
  // DUR-4068: both of these decide whether an approval needs a board approval
  // card at all -- entirely server-side, before an approved card ever reaches
  // the runner. requestingAgentId, by contrast, IS read by the runner now (to
  // resolve the SFTP credential bound to that agent), so it is deliberately
  // not listed here any more.
  mode: "governs whether a deploy needs a request_board_approval card; decided server-side before the card is even filed",
  askFirstActions: "same as mode — routes specific action categories to a board approval card, server-side only",
  // DUR-4162: the runner trims its own status.jsonl mirror by a flat
  // STATUS_LOG_MAX_LINES env var; it never builds the releases[] history
  // list itself, so it has no reason to read this field.
  releaseRetentionCount: "resolved server-side in deploy-history.ts when building the releases[] list; the runner never reads deploy history",
};

describe("deploy policy fields reach every layer that has to know about them", () => {
  const schemaKeys = Object.keys(deployPolicySchema.shape).sort();

  it("the fixture in this file covers every field the schema declares", () => {
    // Otherwise the round-trip below silently stops proving anything about a
    // newly added field.
    expect(Object.keys(FULLY_POPULATED_POLICY).sort()).toEqual(schemaKeys);
  });

  it("parseProjectDeployPolicy keeps every field the schema accepts", () => {
    const accepted = deployPolicySchema.parse(FULLY_POPULATED_POLICY);
    const parsed = parseProjectDeployPolicy(accepted);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(accepted);
  });

  it("every field is either read by the deploy runner or listed here with a reason", () => {
    const runner = readFileSync(DEPLOY_RUNNER, "utf8");
    const missing = schemaKeys.filter(
      (key) => !NOT_USED_BY_THE_RUNNER[key] && !runner.includes(`"${key}"`),
    );
    expect(
      missing,
      `scripts/deploy-runner.sh never reads ${missing.join(", ")}. Either read it in resolve_deploy_vars ` +
        "or add it to NOT_USED_BY_THE_RUNNER in this file with the reason it is not the runner's business.",
    ).toEqual([]);
  });

  it("nothing is exempted from the runner that is not still a real deploy setting", () => {
    const stale = Object.keys(NOT_USED_BY_THE_RUNNER).filter((key) => !schemaKeys.includes(key));
    expect(stale, `NOT_USED_BY_THE_RUNNER still lists ${stale.join(", ")}, which is no longer a deploy setting`).toEqual([]);
  });

  it("nothing is exempted from the runner that the runner in fact reads", () => {
    const runner = readFileSync(DEPLOY_RUNNER, "utf8");
    const contradicted = Object.keys(NOT_USED_BY_THE_RUNNER).filter((key) => runner.includes(`policy.get("${key}")`));
    expect(contradicted, `the runner does read ${contradicted.join(", ")} — drop it from NOT_USED_BY_THE_RUNNER`).toEqual([]);
  });
});
