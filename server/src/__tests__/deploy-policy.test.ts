import { describe, expect, it } from "vitest";
import { parseProjectDeployPolicy } from "../services/deploy-policy.ts";

describe("deploy policy helpers", () => {
  it("returns null for empty/non-object input", () => {
    expect(parseProjectDeployPolicy(null)).toBeNull();
    expect(parseProjectDeployPolicy(undefined)).toBeNull();
    expect(parseProjectDeployPolicy({})).toBeNull();
    expect(parseProjectDeployPolicy("nope")).toBeNull();
  });

  it("parses a fully configured policy", () => {
    expect(
      parseProjectDeployPolicy({
        enabled: true,
        requestingAgentId: "33333333-3333-4333-8333-333333333333",
        workspaceId: "44444444-4444-4444-8444-444444444444",
        deployTargetPath: "/root/nordstrand-dashboard",
        deployKind: "compose_recreate",
        deployServices: ["web", "worker"],
        deployCommand: "docker compose up -d --build",
        healthCheckUrl: "/api/health",
        rollback: "git_previous",
      }),
    ).toEqual({
      enabled: true,
      requestingAgentId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "44444444-4444-4444-8444-444444444444",
      deployTargetPath: "/root/nordstrand-dashboard",
      deployKind: "compose_recreate",
      deployServices: ["web", "worker"],
      deployCommand: "docker compose up -d --build",
      healthCheckUrl: "/api/health",
      rollback: "git_previous",
    });
  });

  it("parses composeFiles and envFile for non-root compose layouts", () => {
    expect(
      parseProjectDeployPolicy({
        enabled: true,
        requestingAgentId: null,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        deployTargetPath: "/root/paperclip",
        deployKind: "compose_build_swap",
        deployServices: ["server"],
        composeFiles: ["docker/docker-compose.yml", "docker/docker-compose.prod.yml"],
        envFile: ".env",
        healthCheckUrl: "/api/health",
        rollback: "git_previous",
      }),
    ).toEqual({
      enabled: true,
      requestingAgentId: null,
      workspaceId: "44444444-4444-4444-8444-444444444444",
      deployTargetPath: "/root/paperclip",
      deployKind: "compose_build_swap",
      deployServices: ["server"],
      composeFiles: ["docker/docker-compose.yml", "docker/docker-compose.prod.yml"],
      envFile: ".env",
      healthCheckUrl: "/api/health",
      rollback: "git_previous",
    });
  });

  it("parses deployBranch and mirrorBranch (DUR-40)", () => {
    expect(
      parseProjectDeployPolicy({
        enabled: true,
        requestingAgentId: null,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        deployTargetPath: "/root/paperclip",
        deployKind: "compose_build_swap",
        healthCheckUrl: "/api/health",
        rollback: "git_previous",
        deployBranch: "custom",
        mirrorBranch: "master",
      }),
    ).toEqual({
      enabled: true,
      requestingAgentId: null,
      workspaceId: "44444444-4444-4444-8444-444444444444",
      deployTargetPath: "/root/paperclip",
      deployKind: "compose_build_swap",
      healthCheckUrl: "/api/health",
      rollback: "git_previous",
      deployBranch: "custom",
      mirrorBranch: "master",
    });
  });

  it("drops a non-string deployBranch and mirrorBranch", () => {
    const result = parseProjectDeployPolicy({
      workspaceId: "44444444-4444-4444-8444-444444444444",
      deployBranch: 42,
      mirrorBranch: ["not-a-string"],
    });
    expect(result?.deployBranch).toBeUndefined();
    expect(result?.mirrorBranch).toBeUndefined();
  });

  it("drops a non-array composeFiles and non-string envFile", () => {
    const result = parseProjectDeployPolicy({
      workspaceId: "44444444-4444-4444-8444-444444444444",
      composeFiles: "not-an-array",
      envFile: 42,
    });
    expect(result?.composeFiles).toBeUndefined();
    expect(result?.envFile).toBeUndefined();
  });

  it("defaults invalid/missing enum fields and drops invalid optional fields", () => {
    const result = parseProjectDeployPolicy({
      enabled: false,
      requestingAgentId: 42,
      workspaceId: "44444444-4444-4444-8444-444444444444",
      deployKind: "not_a_real_kind",
      rollback: "not_a_real_strategy",
      deployServices: "not-an-array",
    });
    expect(result).toEqual({
      enabled: false,
      requestingAgentId: null,
      workspaceId: "44444444-4444-4444-8444-444444444444",
      deployTargetPath: "",
      deployKind: "custom",
      healthCheckUrl: "",
      rollback: "none",
    });
  });
});
