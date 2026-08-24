import type { agents } from "@paperclipai/db";
import { unprocessable } from "../errors.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The subset of `agents` columns tracked in config revisions (see
// buildConfigSnapshot in server/src/services/agents.ts). Lives here — not in
// services/agents.ts — so this whole module stays free of any dependency
// that existing tests mock narrowly (many test files `vi.doMock` a small
// hand-picked shape of "../services/agents.js"; importing from a fresh,
// nobody-mocks-it-yet module means an agent-config field added here doesn't
// also require updating a dozen unrelated test mocks).
export const CONFIG_REVISION_FIELDS = [
  "name",
  "role",
  "title",
  "icon",
  "tone",
  "personality",
  "reportsTo",
  "capabilities",
  "adapterType",
  "adapterConfig",
  "runtimeConfig",
  "defaultEnvironmentId",
  "budgetMonthlyCents",
  "metadata",
] as const;

export type ConfigRevisionField = (typeof CONFIG_REVISION_FIELDS)[number];

// DUR-57: the self-update guard used to be a hand-maintained deny-list, one
// entry per field someone remembered was dangerous (role, then reportsTo +
// budgetMonthlyCents + runtimeConfig.handOffUnhandledAfterMinutes...). Every
// field left off that list was implicitly agent-settable, including any
// field added to the agent schema afterward. This is the opposite: a named
// allow-list of the config fields reviewed as safe for an agent-authenticated
// caller to set on itself. Anything not named here is refused by default.
//
//  - capabilities: free-text self-description. Not read by any authz,
//    budget, or org-chart decision anywhere in the codebase.
//  - desiredSkills: skill selection is validated against the company's
//    already-reviewed skill catalog before anything installs, so picking
//    from that catalog is not a privilege escalation.
//  - adapterConfig: the agent's own adapter/runtime settings (model, env,
//    timeouts, ...). The specific sub-keys that ARE dangerous — MCP tool
//    connections, instructions bundle path, host-executed workspace
//    commands — are refused unconditionally by the adapter-config guards in
//    server/src/routes/agents.ts regardless of this allow-list.
//  - runtimeConfig: same idea, but scoped further by
//    AGENT_SELF_UPDATE_ALLOWED_RUNTIME_CONFIG_KEYS below, since
//    agentRuntimeConfigSchema ends in an open `.catchall(z.unknown())`.
//
// role, title, reportsTo, adapterType, defaultEnvironmentId,
// budgetMonthlyCents, and metadata are deliberately absent: role is a
// permission grant, reportsTo determines who can override an agent,
// budgetMonthlyCents is its spend ceiling, and none of the others have a
// reviewed self-service use case today.
export const AGENT_SELF_UPDATE_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "capabilities",
  "desiredSkills",
  "adapterConfig",
  "runtimeConfig",
]);

// Sub-keys of runtimeConfig an agent-authenticated caller may set on itself.
// modelProfiles carries only adapterConfig for the "cheap" model fallback,
// itself gated by the same adapter-config guards as top-level adapterConfig.
// Everything else — including handOffUnhandledAfterMinutes and any future
// key the open runtimeConfig catchall accepts — is refused by default.
export const AGENT_SELF_UPDATE_ALLOWED_RUNTIME_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "modelProfiles",
]);

export function agentSelfUpdateDisallowedFields(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((key) => !AGENT_SELF_UPDATE_ALLOWED_FIELDS.has(key));
}

export function agentSelfUpdateDisallowedRuntimeConfigKeys(runtimeConfig: Record<string, unknown>): string[] {
  return Object.keys(runtimeConfig).filter((key) => !AGENT_SELF_UPDATE_ALLOWED_RUNTIME_CONFIG_KEYS.has(key));
}

// Diffs a candidate config patch against the agent's current row, restricted
// to the tracked config fields, so callers only see the fields a change
// would actually touch. Used to authorize a config-revision rollback against
// the SAME allow-list the PATCH route enforces (see
// assertAgentSelfUpdateAllowed in server/src/routes/agents.ts) — a rollback
// that leaves a field unchanged should not be treated as "setting" it.
export function computeChangedConfigFields(
  existing: Record<string, unknown>,
  patch: Partial<typeof agents.$inferInsert>,
): Partial<Record<ConfigRevisionField, unknown>> {
  const changed: Partial<Record<ConfigRevisionField, unknown>> = {};
  for (const field of CONFIG_REVISION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    if (JSON.stringify(existing[field]) !== JSON.stringify(patch[field])) {
      changed[field] = patch[field];
    }
  }
  return changed;
}

// Normalizes a stored config-revision snapshot (agentConfigRevisions.afterConfig)
// back into an update patch. Used both by agentService(db).rollbackConfigRevision
// to actually perform a rollback, and by the route layer (via
// computeChangedConfigFields above) to work out which fields a rollback would
// change *before* performing it, so the two never disagree about what a
// rollback does.
export function configPatchFromSnapshot(snapshot: unknown): Partial<typeof agents.$inferInsert> {
  if (!isPlainRecord(snapshot)) throw unprocessable("Invalid revision snapshot");

  if (typeof snapshot.name !== "string" || snapshot.name.length === 0) {
    throw unprocessable("Invalid revision snapshot: name");
  }
  if (typeof snapshot.role !== "string" || snapshot.role.length === 0) {
    throw unprocessable("Invalid revision snapshot: role");
  }
  if (typeof snapshot.adapterType !== "string" || snapshot.adapterType.length === 0) {
    throw unprocessable("Invalid revision snapshot: adapterType");
  }
  if (typeof snapshot.budgetMonthlyCents !== "number" || !Number.isFinite(snapshot.budgetMonthlyCents)) {
    throw unprocessable("Invalid revision snapshot: budgetMonthlyCents");
  }

  const patch: Partial<typeof agents.$inferInsert> = {
    name: snapshot.name,
    role: snapshot.role,
    title: typeof snapshot.title === "string" || snapshot.title === null ? snapshot.title : null,
    reportsTo:
      typeof snapshot.reportsTo === "string" || snapshot.reportsTo === null ? snapshot.reportsTo : null,
    capabilities:
      typeof snapshot.capabilities === "string" || snapshot.capabilities === null
        ? snapshot.capabilities
        : null,
    adapterType: snapshot.adapterType,
    adapterConfig: isPlainRecord(snapshot.adapterConfig) ? snapshot.adapterConfig : {},
    runtimeConfig: isPlainRecord(snapshot.runtimeConfig) ? snapshot.runtimeConfig : {},
    defaultEnvironmentId:
      typeof snapshot.defaultEnvironmentId === "string" || snapshot.defaultEnvironmentId === null
        ? snapshot.defaultEnvironmentId
        : null,
    budgetMonthlyCents: Math.max(0, Math.floor(snapshot.budgetMonthlyCents)),
    metadata: isPlainRecord(snapshot.metadata) || snapshot.metadata === null ? snapshot.metadata : null,
  };

  // icon, tone, and personality were added to CONFIG_REVISION_FIELDS after
  // this table started recording revisions, so every pre-existing revision
  // row's snapshot lacks these keys. Only set them when the snapshot
  // actually has the key — an unconditional `?? null` would wipe a legacy
  // agent's icon (or a tone/personality set after the fact but before its
  // next revision) on the first rollback to any revision that predates this
  // change.
  if (Object.prototype.hasOwnProperty.call(snapshot, "icon")) {
    patch.icon = typeof snapshot.icon === "string" || snapshot.icon === null ? snapshot.icon : null;
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, "tone")) {
    patch.tone = typeof snapshot.tone === "string" || snapshot.tone === null ? snapshot.tone : null;
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, "personality")) {
    patch.personality =
      typeof snapshot.personality === "string" || snapshot.personality === null ? snapshot.personality : null;
  }

  return patch;
}
