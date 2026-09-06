export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canCreateSkills: boolean;
  canManageOtherAgentsPermissions: boolean;
  canManageCompanySettings: boolean;
  canManageAllWorkspaceRuntimes: boolean;
};

// These are the only capabilities that get a role-derived default. Every
// other permission must be granted explicitly. This is also the single place
// where "ceo" as a job title translates into elevated access -- every
// authorization check elsewhere in the codebase must read one of these named
// booleans off the agent record rather than compare `role` to `"ceo"`
// directly, so a title change or a self-service edit can never silently
// grant or revoke access.
function roleDerivedDefaults(role: string) {
  const isCeo = role.trim().toLowerCase() === "ceo";
  return {
    canCreateAgents: isCeo,
    canCreateSkills: true,
    canManageOtherAgentsPermissions: isCeo,
    canManageCompanySettings: isCeo,
    canManageAllWorkspaceRuntimes: isCeo,
  };
}

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return roleDerivedDefaults(role);
}

function readBooleanOr(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof record[key] === "boolean" ? (record[key] as boolean) : fallback;
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = roleDerivedDefaults(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  const preserved = { ...record };
  return {
    ...preserved,
    canCreateAgents: readBooleanOr(record, "canCreateAgents", defaults.canCreateAgents),
    canCreateSkills: readBooleanOr(record, "canCreateSkills", defaults.canCreateSkills),
    canManageOtherAgentsPermissions: readBooleanOr(
      record,
      "canManageOtherAgentsPermissions",
      defaults.canManageOtherAgentsPermissions,
    ),
    canManageCompanySettings: readBooleanOr(
      record,
      "canManageCompanySettings",
      defaults.canManageCompanySettings,
    ),
    canManageAllWorkspaceRuntimes: readBooleanOr(
      record,
      "canManageAllWorkspaceRuntimes",
      defaults.canManageAllWorkspaceRuntimes,
    ),
  };
}
