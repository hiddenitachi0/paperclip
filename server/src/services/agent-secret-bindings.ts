import { LANE_A_API_KEY_CONFIG_PATH, envBindingSchema, type SecretVersionSelector } from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";
import { ENV_KEY_RE } from "./secrets.js";

// DUR-132: server names key the binding configPath (`mcpServers[<name>]...`),
// so a name containing `.`/`]`/etc could forge or collide with another
// configPath. Keep this tight and independent of any display-name rules.
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface AgentSecretBindingSyncService {
  syncSecretRefsForTarget?: (
    companyId: string,
    target: { targetType: "agent"; targetId: string },
    refs: Array<{
      secretId: string;
      configPath: string;
      versionSelector?: SecretVersionSelector;
      required?: boolean;
      label?: string | null;
    }>,
    options?: { replaceAll?: boolean },
  ) => Promise<unknown>;
  syncEnvBindingsForTarget?: (
    companyId: string,
    target: { targetType: "agent"; targetId: string; pathPrefix?: string },
    envValue: unknown,
  ) => Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function collectSecretRefs(adapterConfig: unknown): Array<{
  secretId: string;
  configPath: string;
  versionSelector?: SecretVersionSelector;
}> {
  const config = asRecord(adapterConfig);
  if (!config) return [];
  const refs: Array<{
    secretId: string;
    configPath: string;
    versionSelector?: SecretVersionSelector;
  }> = [];

  const envValue = asRecord(config.env);
  for (const [key, rawBinding] of Object.entries(envValue ?? {})) {
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "secret_ref") continue;
    refs.push({
      secretId: binding.secretId,
      configPath: `env.${key}`,
      versionSelector: binding.version ?? "latest",
    });
  }

  for (const [key, rawBinding] of Object.entries(config)) {
    if (key === "env" || key === "mcpServers" || key === "laneA") continue;
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    if (typeof binding !== "object" || binding === null || binding.type !== "secret_ref") continue;
    refs.push({
      secretId: binding.secretId,
      configPath: key,
      versionSelector: binding.version ?? "latest",
    });
  }

  refs.push(...collectMcpServerSecretRefs(config.mcpServers));
  refs.push(...collectLaneASecretRefs(config.laneA));

  return refs;
}

// DUR-3997: the quick agent's provider key, `adapterConfig.laneA.apiKey`, is
// a secret_ref bound at LANE_A_API_KEY_CONFIG_PATH ("laneA.apiKey"), so the
// quick-agent call can resolve it through the same binding gate and audit
// trail an MCP-server credential goes through (lane-a.ts resolves it with
// consumer agent:<id> at exactly this path). A literal string here is refused
// by the validator (laneAAdapterConfigSchema) before it can be saved.
function collectLaneASecretRefs(rawLaneA: unknown): Array<{
  secretId: string;
  configPath: string;
  versionSelector?: SecretVersionSelector;
}> {
  const laneA = asRecord(rawLaneA);
  if (!laneA) return [];
  const parsed = envBindingSchema.safeParse(laneA.apiKey);
  if (!parsed.success) return [];
  const binding = parsed.data;
  if (typeof binding !== "object" || binding === null || binding.type !== "secret_ref") return [];
  return [
    {
      secretId: binding.secretId,
      configPath: LANE_A_API_KEY_CONFIG_PATH,
      versionSelector: binding.version ?? "latest",
    },
  ];
}

// DUR-132: adapterConfig.mcpServers[*].env / .headers may carry secret_ref
// bindings alongside literal strings, exactly like adapterConfig.env. Binding
// paths are keyed by server name -- `mcpServers[<name>].env.<KEY>` /
// `mcpServers[<name>].headers.<KEY>` -- so assertBindingContext (secrets.ts)
// can authorize resolution per-server the same way it does for env.<KEY>.
function collectMcpServerSecretRefs(rawMcpServers: unknown): Array<{
  secretId: string;
  configPath: string;
  versionSelector?: SecretVersionSelector;
}> {
  if (!Array.isArray(rawMcpServers)) return [];
  const refs: Array<{
    secretId: string;
    configPath: string;
    versionSelector?: SecretVersionSelector;
  }> = [];
  const seenNames = new Set<string>();

  for (const rawEntry of rawMcpServers) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    if (!MCP_SERVER_NAME_RE.test(name)) {
      throw unprocessable(
        `Invalid MCP server name "${name}": names must match ${MCP_SERVER_NAME_RE.source} so they can't ` +
          `collide with or forge another server's secret binding path.`,
      );
    }
    if (seenNames.has(name)) {
      throw unprocessable(`Duplicate MCP server name "${name}": server names must be unique.`);
    }
    seenNames.add(name);

    for (const field of ["env", "headers"] as const) {
      const fieldValue = asRecord(entry[field]);
      if (!fieldValue) continue;
      for (const [key, rawBinding] of Object.entries(fieldValue)) {
        if (!ENV_KEY_RE.test(key)) {
          throw unprocessable(`Invalid MCP server "${name}" ${field} key name: ${key}`);
        }
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) continue;
        const binding = parsed.data;
        if (typeof binding !== "object" || binding === null || binding.type !== "secret_ref") continue;
        refs.push({
          secretId: binding.secretId,
          configPath: `mcpServers[${name}].${field}.${key}`,
          versionSelector: binding.version ?? "latest",
        });
      }
    }
  }

  return refs;
}

export type AgentSecretRef = {
  secretId: string;
  configPath: string;
  versionSelector?: SecretVersionSelector;
};

// DUR-3980: every secret_ref an agent record's adapterConfig carries, keyed
// by the same configPath its company_secret_bindings row uses.
export function collectAgentAdapterConfigSecretRefs(adapterConfig: unknown): AgentSecretRef[] {
  return collectSecretRefs(adapterConfig);
}

// DUR-3980: secret_refs inside runtimeConfig.modelProfiles[*].adapterConfig.
// At run time a model profile's adapterConfig is merged over the agent's own
// (heartbeat resolveModelProfileApplication) and resolved against the AGENT's
// bindings, so these use the same inner configPath (`env.KEY`) as the agent's
// own adapterConfig refs.
export function collectRuntimeConfigModelProfileSecretRefs(runtimeConfig: unknown): AgentSecretRef[] {
  const modelProfiles = asRecord(asRecord(runtimeConfig)?.modelProfiles);
  if (!modelProfiles) return [];
  const refs: AgentSecretRef[] = [];
  for (const rawProfile of Object.values(modelProfiles)) {
    refs.push(...collectSecretRefs(asRecord(rawProfile)?.adapterConfig));
  }
  return refs;
}

// All secret_refs an agent record carries (adapterConfig + model profiles).
// `lenient` swallows malformed legacy data (e.g. an old invalid MCP server
// name) instead of throwing -- used only when reading what an agent ALREADY
// holds or once held, never when validating what is being saved.
export function collectAgentRecordSecretRefs(
  record: { adapterConfig: unknown; runtimeConfig: unknown },
  options?: { lenient?: boolean },
): AgentSecretRef[] {
  if (!options?.lenient) {
    return [
      ...collectAgentAdapterConfigSecretRefs(record.adapterConfig),
      ...collectRuntimeConfigModelProfileSecretRefs(record.runtimeConfig),
    ];
  }
  const refs: AgentSecretRef[] = [];
  try {
    refs.push(...collectAgentAdapterConfigSecretRefs(record.adapterConfig));
  } catch {
    // malformed legacy adapterConfig: contributes nothing
  }
  try {
    refs.push(...collectRuntimeConfigModelProfileSecretRefs(record.runtimeConfig));
  } catch {
    // malformed legacy runtimeConfig: contributes nothing
  }
  return refs;
}

// A saved password is "held" at a specific place: the same secret moved to a
// different configPath is a new attachment, not the one the agent was given.
export function agentSecretRefKey(ref: { secretId: string; configPath: string }): string {
  return `${ref.configPath} ${ref.secretId}`;
}

// DUR-3980: agent-facing refusal. Names the real way to get a credential:
// a credential_request approval (FORK.md Feature 5), which a board member
// fulfils by providing the value and attaching it to the agent.
export function agentSecretRefRefusal(companyId: string, refs: Array<{ configPath: string }>) {
  const paths = [...new Set(refs.map((ref) => ref.configPath))].sort();
  return forbidden(
    `Agents cannot attach a saved password they were not given (${paths.join(", ")}). ` +
      `Only a board member can attach one. To ask for a credential you need, file a credential request: ` +
      `POST /api/companies/${companyId}/approvals with type "credential_request" and ` +
      `payload { "name", "envKey", "description" } saying what it is for. ` +
      `A board member provides the value and attaches it to you. ` +
      `You can still keep or remove saved passwords you already have.`,
    { code: "agent_secret_ref_not_held", configPaths: paths },
  );
}

// DUR-132: identity of whoever is saving the agent record. When the actor is
// itself an agent (not a board user), a save of a DIFFERENT agent's record
// (including one it is in the process of creating, whose id necessarily
// differs from the actor's own agentId) may carry no secret_ref at all.
// DUR-3980: saving its OWN record, an agent may keep or remove saved
// passwords it already holds but never add one -- that gate runs before the
// write, in agentService (assertAgentActorAddsNoSecretRefs), because it needs
// the record's previous state. Board actors are unaffected by both.
export type AgentSecretBindingActor = {
  actorType: "agent" | "user";
  agentId?: string | null;
};

export async function syncAgentAdapterEnvBindings(input: {
  secretsSvc: AgentSecretBindingSyncService;
  companyId: string;
  agentId: string;
  adapterConfig: unknown;
  actor?: AgentSecretBindingActor;
  // DUR-143: secret refs carried by this agent's granted tool-library
  // entries (see collectMcpToolLibrarySecretRefs in mcp-tool-library.ts).
  // Folded into the same replaceAll sync as adapterConfig-derived refs so a
  // save that touches only adapterConfig can never wipe tool-granted
  // bindings out from under an unrelated save.
  extraRefs?: Array<{
    secretId: string;
    configPath: string;
    versionSelector?: SecretVersionSelector;
  }>;
}) {
  const refs = [...collectSecretRefs(input.adapterConfig), ...(input.extraRefs ?? [])];
  if (
    input.actor?.actorType === "agent" &&
    refs.length > 0 &&
    input.actor.agentId !== input.agentId
  ) {
    throw forbidden(
      "An agent may only bind a saved password (secret_ref) to its own agent record, not to another agent's.",
    );
  }
  if (input.secretsSvc.syncSecretRefsForTarget) {
    await input.secretsSvc.syncSecretRefsForTarget(
      input.companyId,
      { targetType: "agent", targetId: input.agentId },
      refs,
      { replaceAll: true },
    );
    return;
  }
  const envValue = asRecord(asRecord(input.adapterConfig)?.env);
  await input.secretsSvc.syncEnvBindingsForTarget?.(
    input.companyId,
    { targetType: "agent", targetId: input.agentId },
    envValue,
  );
}
