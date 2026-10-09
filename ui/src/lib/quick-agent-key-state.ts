import {
  laneABackupKeySlot,
  normalizeLaneAProvider,
  type LaneAProvider,
  type ModelKeyState,
} from "@paperclipai/shared";

/**
 * Which key a quick agent would send for a model, in the words the readiness
 * checklist uses. Mirrors the server: the main model uses the main key (a
 * provider switch restores the agent's saved key for the new provider), a
 * backup uses laneABackupKeySlot (the main key on the main model's own
 * provider and address, the agent's key for the backup's provider otherwise,
 * never a key sent to an address it was not picked for).
 */

export interface AgentKeys {
  /** The main model's provider and address. */
  main: { provider: LaneAProvider; baseUrl: string | null };
  /** A usable main key is picked (the saved secret still exists). */
  hasMainKey: boolean;
  /** The agent's usable keys per provider (adapterConfig.laneA.apiKeyByProvider). */
  providerKeys: Partial<Record<LaneAProvider, unknown>>;
  /** The address each of those keys was saved with. */
  stashedBaseUrls?: Partial<Record<LaneAProvider, string | null>>;
  /** Paperclip's own Claude key: true set, false not set, null/undefined not known (assume set). */
  instanceClaudeKey?: boolean | null;
}

function claude(keys: AgentKeys): ModelKeyState {
  return keys.instanceClaudeKey === false ? "paperclip_missing" : "paperclip";
}

/** The key the agent would use if this model became its MAIN model. */
export function mainModelKeyState(providerRaw: string, keys: AgentKeys): ModelKeyState {
  const provider = normalizeLaneAProvider(providerRaw);
  if (provider === "local") return "not_needed";
  const has = provider === keys.main.provider ? keys.hasMainKey : Boolean(keys.providerKeys[provider]);
  if (has) return "set";
  return provider === "anthropic" ? claude(keys) : "missing";
}

/** The key the agent would use for this model as a BACKUP. */
export function backupKeyState(backup: { provider: string; baseUrl?: string | null }, keys: AgentKeys): ModelKeyState {
  const provider = normalizeLaneAProvider(backup.provider);
  if (provider === "local") return "not_needed";
  const slot = laneABackupKeySlot(
    { provider, baseUrl: backup.baseUrl ?? null },
    keys.main,
    keys.stashedBaseUrls?.[provider] ?? null,
  );
  if (slot === "main" && keys.hasMainKey) return "set";
  if (slot === "provider" && keys.providerKeys[provider]) return "set";
  if (provider === "anthropic") return claude(keys);
  if (slot === "none" && (provider === keys.main.provider ? keys.hasMainKey : Boolean(keys.providerKeys[provider]))) {
    return "wrong_address";
  }
  return "missing";
}
