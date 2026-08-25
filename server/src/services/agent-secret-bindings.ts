import { envBindingSchema, type SecretVersionSelector } from "@paperclipai/shared";
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
    if (key === "env" || key === "mcpServers") continue;
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

  return refs;
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

// DUR-132: identity of whoever is saving the agent record. When the actor is
// itself an agent (not a board user), it may only ever add a secret_ref
// while saving *its own* agent record -- never while creating or patching a
// different agent (including one it is in the process of creating, whose id
// necessarily differs from the actor's own agentId). Board actors are
// unaffected.
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
