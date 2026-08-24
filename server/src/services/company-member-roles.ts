import { PERMISSION_KEYS } from "@paperclipai/shared";
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";

const HUMAN_COMPANY_MEMBERSHIP_ROLES: HumanCompanyMembershipRole[] = [
  "owner",
  "admin",
  "operator",
  "viewer",
];

export function normalizeHumanRole(
  value: unknown,
  fallback: HumanCompanyMembershipRole = "operator"
): HumanCompanyMembershipRole {
  if (value === "member") return "operator";
  return HUMAN_COMPANY_MEMBERSHIP_ROLES.includes(value as HumanCompanyMembershipRole)
    ? (value as HumanCompanyMembershipRole)
    : fallback;
}

export function grantsForHumanRole(
  role: HumanCompanyMembershipRole
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  switch (role) {
    case "owner":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "skills:create", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "users:manage_permissions", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "joins:approve", scope: null },
        { permissionKey: "deploys:request", scope: null },
        { permissionKey: "merges:request", scope: null },
      ];
    case "admin":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "skills:create", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "joins:approve", scope: null },
        { permissionKey: "deploys:request", scope: null },
        { permissionKey: "merges:request", scope: null },
      ];
    case "operator":
      // DUR-65: deliberately not granted here -- an operator-level human
      // member is not a "boss" by default. Filing a deploy/merge approval as
      // an operator now requires an explicit grant, same as any agent would
      // need. (owner/admin retain it above; see grantsForHumanRole callers.)
      return [{ permissionKey: "tasks:assign", scope: null }];
    case "viewer":
      return [];
  }
}

export function resolveHumanInviteRole(
  defaultsPayload: Record<string, unknown> | null | undefined
): HumanCompanyMembershipRole {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return "operator";
  const scoped = defaultsPayload.human;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return "operator";
  }
  return normalizeHumanRole((scoped as Record<string, unknown>).role, "operator");
}
