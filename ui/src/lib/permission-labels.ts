import { PERMISSION_KEYS, type PermissionKey } from "@paperclipai/shared";

/**
 * Plain-language labels for permission keys, so the Jobs UI never prints a
 * raw `namespace:action` string on screen (see PipelineLivenessBanner.tsx
 * for the existing violation of this rule — do not repeat it here).
 *
 * `deploys:request` / `merges:request` are not in PERMISSION_KEYS yet
 * (DUR-114 is expected to add them). Their labels are pre-seeded so the
 * rights picker in the Jobs editor is ready the moment the backend adds the
 * keys, without needing a follow-up UI change.
 */
const KNOWN_PERMISSION_LABELS: Record<string, { label: string; description: string }> = {
  "agents:create": {
    label: "Hire agents",
    description: "Create or hire new agents for the company.",
  },
  "skills:create": {
    label: "Manage skills",
    description: "Create, import, or edit company skills.",
  },
  "environments:manage": {
    label: "Manage environments",
    description: "Create and edit shared execution environments.",
  },
  "users:invite": {
    label: "Invite people",
    description: "Invite new people to the company.",
  },
  "users:manage_permissions": {
    label: "Manage people's access",
    description: "Change what other people on the company are allowed to do.",
  },
  "tasks:assign": {
    label: "Assign tasks",
    description: "Assign tasks to agents.",
  },
  "tasks:assign_scope": {
    label: "Assign tasks (limited)",
    description: "Assign tasks within a limited, pre-approved scope.",
  },
  "tasks:manage_active_checkouts": {
    label: "Manage in-progress tasks",
    description: "Take over or release tasks other agents currently have checked out.",
  },
  "pipelines:write": {
    label: "Edit pipelines",
    description: "Create and edit automation pipelines.",
  },
  "joins:approve": {
    label: "Approve join requests",
    description: "Approve people or agents asking to join the company.",
  },
  "deploys:request": {
    label: "Ask to deploy",
    description: "Ask an operator to deploy — cannot approve a deploy alone.",
  },
  "merges:request": {
    label: "Ask to merge",
    description: "Ask an operator to merge a pull request — cannot approve a merge alone.",
  },
};

/** Permission keys that must never appear in a rights picker (deploy/merge approval power). */
const FORBIDDEN_PERMISSION_KEY_PATTERN = /^(deploys|merges):approve$/;

export function permissionLabel(key: string): string {
  const known = KNOWN_PERMISSION_LABELS[key];
  if (known) return known.label;
  // Fallback: turn an unrecognized `namespace:action_name` into a short
  // human phrase instead of ever printing the raw key on screen.
  const [, action] = key.split(":");
  const words = (action ?? key).replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function permissionDescription(key: string): string | null {
  return KNOWN_PERMISSION_LABELS[key]?.description ?? null;
}

/** Permission keys safe to offer in a job's default-rights picker. */
export function selectablePermissionKeys(): PermissionKey[] {
  return PERMISSION_KEYS.filter((key) => !FORBIDDEN_PERMISSION_KEY_PATTERN.test(key));
}

export function isForbiddenPermissionKey(key: string): boolean {
  return FORBIDDEN_PERMISSION_KEY_PATTERN.test(key);
}
