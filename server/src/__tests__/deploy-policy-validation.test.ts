import { describe, expect, it } from "vitest";
import type { ProjectDeployPolicy } from "@paperclipai/shared";
import { describeDeployPolicyProblems, formatDeployPolicyProblems } from "../services/deploy-policy-validation.js";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const context = {
  workspaces: [
    { id: WORKSPACE_ID, name: "Main checkout", repoUrl: "https://github.com/acme/dashboard" },
    { id: "33333333-3333-4333-8333-333333333333", name: "Scratch folder", repoUrl: null },
  ],
  agents: [
    { id: AGENT_ID, name: "Release Lead", status: "active" },
    { id: "44444444-4444-4444-8444-444444444444", name: "Old Bot", status: "terminated" },
  ],
};

function policy(overrides: Partial<ProjectDeployPolicy> = {}): ProjectDeployPolicy {
  return {
    enabled: true,
    requestingAgentId: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    deployTargetPath: "/root/dashboard",
    deployKind: "compose_recreate",
    deployServices: ["web", "worker"],
    healthCheckUrl: "https://dashboard.example.com/health",
    rollback: "git_previous",
    ...overrides,
  };
}

describe("describeDeployPolicyProblems", () => {
  it("accepts a complete, enabled policy", () => {
    expect(describeDeployPolicyProblems(policy(), context)).toEqual([]);
  });

  it("lets a half-filled draft be stored while disabled", () => {
    const draft = policy({ enabled: false, workspaceId: "", deployTargetPath: "", healthCheckUrl: "", requestingAgentId: null });
    expect(describeDeployPolicyProblems(draft, context)).toEqual([]);
  });

  it("names every missing field, in plain words, when switching on", () => {
    const problems = describeDeployPolicyProblems(
      policy({ workspaceId: "", deployTargetPath: "", healthCheckUrl: "", deployKind: "custom", deployCommand: "" }),
      context,
    );
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/Choose which workspace to deploy from/);
    expect(problems[1]).toMatch(/folder on the server/);
    expect(problems[2]).toMatch(/health check web address/);
    expect(problems[3]).toMatch(/custom command.*needs the command/);
    for (const problem of problems) {
      expect(problem).not.toMatch(/deployTargetPath|healthCheckUrl|workspaceId|deployCommand/);
    }
  });

  it("reports format problems even while disabled", () => {
    const problems = describeDeployPolicyProblems(
      policy({ enabled: false, deployTargetPath: "dashboard", healthCheckUrl: "/api/health" }),
      context,
    );
    expect(problems).toEqual([
      expect.stringMatching(/full path starting with "\/"/),
      expect.stringMatching(/full web address starting with http/),
    ]);
  });

  it("rejects a workspace from another project and one without a repo", () => {
    expect(describeDeployPolicyProblems(policy({ workspaceId: "55555555-5555-4555-8555-555555555555" }), context)).toEqual([
      expect.stringMatching(/does not belong to this project/),
    ]);
    expect(describeDeployPolicyProblems(policy({ workspaceId: "33333333-3333-4333-8333-333333333333" }), context)).toEqual([
      expect.stringMatching(/"Scratch folder" has no repository address/),
    ]);
  });

  it("rejects a terminated or unknown requesting agent", () => {
    expect(describeDeployPolicyProblems(policy({ requestingAgentId: "44444444-4444-4444-8444-444444444444" }), context)).toEqual([
      expect.stringMatching(/Old Bot, has been terminated/),
    ]);
    expect(describeDeployPolicyProblems(policy({ requestingAgentId: "66666666-6666-4666-8666-666666666666" }), context)).toEqual([
      expect.stringMatching(/not part of this company any more/),
    ]);
  });

  it("keeps compose extras inside the project folder", () => {
    expect(
      describeDeployPolicyProblems(policy({ envFile: "/etc/secrets.env", composeFiles: ["../other/compose.yml", "docker/compose.yml"] }), context),
    ).toEqual([
      expect.stringMatching(/environment file must be a path inside the project folder/),
      expect.stringMatching(/Compose files must be paths inside the project folder/),
    ]);
    expect(describeDeployPolicyProblems(policy({ envFile: ".env", composeFiles: ["docker/compose.yml"] }), context)).toEqual([]);
  });

  it("rejects branch names with spaces and identical deploy/mirror branches", () => {
    expect(describeDeployPolicyProblems(policy({ deployBranch: "my branch" }), context)).toEqual([
      expect.stringMatching(/deploy branch name cannot contain spaces/),
    ]);
    expect(describeDeployPolicyProblems(policy({ deployBranch: "custom", mirrorBranch: "custom" }), context)).toEqual([
      expect.stringMatching(/both "custom"/),
    ]);
  });

  it("rejects service names with spaces", () => {
    expect(describeDeployPolicyProblems(policy({ deployServices: ["web worker"] }), context)).toEqual([
      expect.stringMatching(/Service names cannot contain spaces/),
    ]);
  });
});

describe("formatDeployPolicyProblems", () => {
  it("returns a single problem verbatim and prefixes several", () => {
    expect(formatDeployPolicyProblems(["Only one."])).toBe("Only one.");
    expect(formatDeployPolicyProblems(["One.", "Two."])).toBe("Deploy settings need attention: One. Two.");
  });
});
