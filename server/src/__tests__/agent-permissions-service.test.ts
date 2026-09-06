import { describe, expect, it } from "vitest";
import {
  agentPermissionsSchema,
  updateAgentPermissionsSchema,
} from "@paperclipai/shared";
import {
  defaultPermissionsForRole,
  normalizeAgentPermissions,
} from "../services/agent-permissions.js";

describe("agent permissions service", () => {
  it("keeps agent-creation authority least-privileged by default", () => {
    expect(defaultPermissionsForRole("ceo").canCreateAgents).toBe(true);
    expect(defaultPermissionsForRole("CTO").canCreateAgents).toBe(false);
    expect(defaultPermissionsForRole("engineering-manager").canCreateAgents).toBe(false);
    expect(defaultPermissionsForRole("engineer").canCreateAgents).toBe(false);
  });

  it("enables skill creation for every role by default", () => {
    expect(defaultPermissionsForRole("ceo").canCreateSkills).toBe(true);
    expect(defaultPermissionsForRole("CTO").canCreateSkills).toBe(true);
    expect(defaultPermissionsForRole("engineering-manager").canCreateSkills).toBe(true);
    expect(defaultPermissionsForRole("engineer").canCreateSkills).toBe(true);
  });

  it("preserves explicit canCreateAgents overrides", () => {
    expect(normalizeAgentPermissions({ canCreateAgents: false }, "cto").canCreateAgents).toBe(false);
    expect(normalizeAgentPermissions({ canCreateAgents: true }, "engineer").canCreateAgents).toBe(true);
  });

  it("defaults missing skill creation permission to true and preserves explicit false", () => {
    expect(normalizeAgentPermissions({}, "engineer").canCreateSkills).toBe(true);
    expect(normalizeAgentPermissions({ canCreateSkills: false }, "ceo").canCreateSkills).toBe(false);
    expect(normalizeAgentPermissions({ canCreateSkills: true }, "engineer").canCreateSkills).toBe(true);
  });

  it("validates skill creation permission with a default-on value", () => {
    expect(agentPermissionsSchema.parse({ canCreateAgents: false }).canCreateSkills).toBe(true);
    expect(agentPermissionsSchema.parse({ canCreateAgents: false, canCreateSkills: false }).canCreateSkills).toBe(false);
    expect(updateAgentPermissionsSchema.parse({
      canCreateAgents: false,
      canAssignTasks: false,
    }).canCreateSkills).toBeUndefined();
    expect(updateAgentPermissionsSchema.parse({
      canCreateAgents: false,
      canCreateSkills: false,
      canAssignTasks: false,
    }).canCreateSkills).toBe(false);
  });

  // These three capabilities replace the old blanket `role === "ceo"` bypass
  // (see server/src/services/authorization.ts, routes/agents.ts,
  // routes/companies.ts, routes/access.ts, routes/workspace-runtime-service-authz.ts).
  // They must default to the same thing the bypass used to grant a "ceo"
  // agent, but -- unlike the bypass -- be overridable per agent regardless of
  // title.
  it("keeps the CEO-equivalent capabilities least-privileged by default for every other role", () => {
    for (const capability of [
      "canManageOtherAgentsPermissions",
      "canManageCompanySettings",
      "canManageAllWorkspaceRuntimes",
    ] as const) {
      expect(defaultPermissionsForRole("ceo")[capability]).toBe(true);
      expect(defaultPermissionsForRole("CEO")[capability]).toBe(true);
      expect(defaultPermissionsForRole("cto")[capability]).toBe(false);
      expect(defaultPermissionsForRole("engineering-manager")[capability]).toBe(false);
      expect(defaultPermissionsForRole("engineer")[capability]).toBe(false);
    }
  });

  it("preserves explicit overrides of the CEO-equivalent capabilities in either direction", () => {
    expect(normalizeAgentPermissions(
      { canManageOtherAgentsPermissions: false },
      "ceo",
    ).canManageOtherAgentsPermissions).toBe(false);
    expect(normalizeAgentPermissions(
      { canManageCompanySettings: false },
      "ceo",
    ).canManageCompanySettings).toBe(false);
    expect(normalizeAgentPermissions(
      { canManageAllWorkspaceRuntimes: false },
      "ceo",
    ).canManageAllWorkspaceRuntimes).toBe(false);

    expect(normalizeAgentPermissions(
      { canManageOtherAgentsPermissions: true },
      "engineer",
    ).canManageOtherAgentsPermissions).toBe(true);
    expect(normalizeAgentPermissions(
      { canManageCompanySettings: true },
      "engineer",
    ).canManageCompanySettings).toBe(true);
    expect(normalizeAgentPermissions(
      { canManageAllWorkspaceRuntimes: true },
      "engineer",
    ).canManageAllWorkspaceRuntimes).toBe(true);
  });

  it("normalizes a raw DB row with no stored permissions the same way for every CEO-equivalent capability", () => {
    // Mirrors what an old agent row (created before these capabilities
    // existed) looks like: an empty permissions blob. This is the exact
    // input authorization.ts's loadAgent and workspace-runtime-service-authz.ts
    // feed through normalizeAgentPermissions for raw DB reads.
    const normalized = normalizeAgentPermissions({}, "ceo");
    expect(normalized.canCreateAgents).toBe(true);
    expect(normalized.canManageOtherAgentsPermissions).toBe(true);
    expect(normalized.canManageCompanySettings).toBe(true);
    expect(normalized.canManageAllWorkspaceRuntimes).toBe(true);
  });
});
