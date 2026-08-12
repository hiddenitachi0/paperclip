import { describe, expect, it } from "vitest";
import { deployPolicySchema } from "./project.js";

describe("deployPolicySchema", () => {
  const valid = {
    enabled: true,
    requestingAgentId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    deployTargetPath: "/root/nordstrand-dashboard",
    deployKind: "compose_recreate" as const,
    deployServices: ["web", "worker"],
    deployCommand: "docker compose up -d --build",
    healthCheckUrl: "/api/health",
    rollback: "git_previous" as const,
  };

  it("accepts a fully configured policy", () => {
    expect(deployPolicySchema.parse(valid)).toEqual(valid);
  });

  it("accepts a minimal disabled policy without the optional fields", () => {
    const { deployServices: _deployServices, deployCommand: _deployCommand, ...minimal } = valid;
    expect(deployPolicySchema.parse(minimal)).toEqual(minimal);
  });

  it("allows a null requestingAgentId", () => {
    expect(deployPolicySchema.parse({ ...valid, requestingAgentId: null }).requestingAgentId).toBeNull();
  });

  it("rejects unknown keys (.strict())", () => {
    expect(() => deployPolicySchema.parse({ ...valid, unexpected: true })).toThrow();
  });

  it("rejects an invalid deployKind or rollback strategy", () => {
    expect(() => deployPolicySchema.parse({ ...valid, deployKind: "not_a_kind" })).toThrow();
    expect(() => deployPolicySchema.parse({ ...valid, rollback: "not_a_strategy" })).toThrow();
  });

  it("requires the non-optional fields", () => {
    const { workspaceId: _workspaceId, ...missingWorkspaceId } = valid;
    expect(() => deployPolicySchema.parse(missingWorkspaceId)).toThrow();
  });
});
