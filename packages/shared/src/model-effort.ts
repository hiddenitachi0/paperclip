/**
 * Single source of truth for "thinking effort" across adapters.
 *
 * Both the adapterConfig KEY an effort value lives under and the VALUE
 * vocabulary differ per adapter type:
 *
 * - claude_local (and acpx_local wrapping Claude): `effort` — low/medium/high/xhigh/max
 * - codex_local (and acpx_local wrapping Codex):   `modelReasoningEffort` — minimal/low/medium/high/xhigh
 * - opencode_local:                                `variant` — minimal/low/medium/high/xhigh/max
 * - cursor:                                        `mode` — plan/ask (a mode, not really an effort)
 * - everything else:                               `effort` — free-form text, never validated
 *
 * Used by the agent form, the bulk agent editor, the new-task dialog, the task
 * properties panel, AND server-side validation (agent + task validators), so
 * the lists can never drift apart again.
 */

export const CLAUDE_THINKING_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_THINKING_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export const OPENCODE_THINKING_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const CURSOR_MODE_LEVELS = ["plan", "ask"] as const;

export type ThinkingEffortKey = "effort" | "modelReasoningEffort" | "variant" | "mode";
export type ThinkingEffortVocabulary = "claude" | "codex" | "opencode" | "cursor_mode" | "free";
export type ThinkingEffortOption = { id: string; label: string };

const LEVEL_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
  plan: "Plan",
  ask: "Ask",
};

const VOCABULARY_LEVELS: Record<Exclude<ThinkingEffortVocabulary, "free">, readonly string[]> = {
  claude: CLAUDE_THINKING_EFFORT_LEVELS,
  codex: CODEX_THINKING_EFFORT_LEVELS,
  opencode: OPENCODE_THINKING_EFFORT_LEVELS,
  cursor_mode: CURSOR_MODE_LEVELS,
};

/** Plain-language name of the tool behind an adapter, for error messages. */
const ADAPTER_DISPLAY_NAMES: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  opencode_local: "OpenCode",
  cursor: "Cursor",
  acpx_local: "ACP",
};

/** acpx_local wraps another CLI ("agent"); only its "codex" variant uses codex-shaped effort. */
function acpxWrapsCodex(adapterConfig: Record<string, unknown> | undefined): boolean {
  return String(adapterConfig?.agent ?? "claude") === "codex";
}

/** The adapterConfig key an agent's thinking-effort value is stored under. */
export function getThinkingEffortKey(
  adapterType: string | null | undefined,
  adapterConfig?: Record<string, unknown>,
): ThinkingEffortKey {
  if (adapterType === "codex_local") return "modelReasoningEffort";
  if (adapterType === "acpx_local" && acpxWrapsCodex(adapterConfig)) return "modelReasoningEffort";
  if (adapterType === "cursor") return "mode";
  if (adapterType === "opencode_local") return "variant";
  return "effort";
}

/** Which value vocabulary applies to that adapter's effort key. */
export function getThinkingEffortVocabulary(
  adapterType: string | null | undefined,
  adapterConfig?: Record<string, unknown>,
): ThinkingEffortVocabulary {
  if (adapterType === "claude_local") return "claude";
  if (adapterType === "codex_local") return "codex";
  if (adapterType === "opencode_local") return "opencode";
  if (adapterType === "cursor") return "cursor_mode";
  if (adapterType === "acpx_local") return acpxWrapsCodex(adapterConfig) ? "codex" : "claude";
  return "free";
}

/**
 * The valid effort levels for an adapter, or `null` when the adapter accepts any
 * text (we have no list to check against, so nothing is rejected server-side).
 */
export function getThinkingEffortLevels(
  adapterType: string | null | undefined,
  adapterConfig?: Record<string, unknown>,
): readonly string[] | null {
  const vocabulary = getThinkingEffortVocabulary(adapterType, adapterConfig);
  if (vocabulary === "free") return null;
  return VOCABULARY_LEVELS[vocabulary];
}

/**
 * Dropdown options for an adapter: an "auto/default" entry (empty id) followed by
 * the adapter's levels. Free-form adapters get the Claude-shaped list as a
 * suggestion only — see getThinkingEffortLevels for what is actually enforced.
 */
export function getThinkingEffortOptions(
  adapterType: string | null | undefined,
  adapterConfig?: Record<string, unknown>,
  options: { autoLabel?: string } = {},
): readonly ThinkingEffortOption[] {
  const levels = getThinkingEffortLevels(adapterType, adapterConfig) ?? CLAUDE_THINKING_EFFORT_LEVELS;
  return [
    { id: "", label: options.autoLabel ?? "Auto" },
    ...levels.map((id) => ({ id, label: LEVEL_LABELS[id] ?? id })),
  ];
}

/** Some adapters hide thinking-effort entirely (no such concept for that CLI). */
export function supportsThinkingEffort(adapterType: string | null | undefined): boolean {
  return adapterType !== "gemini_local" && adapterType !== "cursor_cloud";
}

/** True when `value` is an accepted effort for this adapter (empty = "auto" is always fine). */
export function isThinkingEffortValid(
  adapterType: string | null | undefined,
  value: unknown,
  adapterConfig?: Record<string, unknown>,
): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string") return false;
  const levels = getThinkingEffortLevels(adapterType, adapterConfig);
  if (!levels) return true;
  return levels.includes(value);
}

function adapterDisplayName(adapterType: string | null | undefined): string {
  if (!adapterType) return "this agent";
  return ADAPTER_DISPLAY_NAMES[adapterType] ?? adapterType;
}

const MAX_MODEL_NAME_LENGTH = 200;

export interface ModelEffortValidationInput {
  adapterType: string | null | undefined;
  /** The adapterConfig (or override adapterConfig) whose model/effort keys to check. */
  adapterConfig: unknown;
  /**
   * When checking a task override the effort key is looked up from the agent's
   * own saved config (an acpx agent's `agent` field lives there, not on the
   * override). Optional; defaults to `adapterConfig`.
   */
  agentAdapterConfig?: Record<string, unknown> | null;
}

/**
 * Typo guard for model + thinking effort. Returns a plain-language error, or
 * `null` when everything is acceptable. Empty strings are accepted as
 * "use the default" (the UI clears a field by writing "").
 */
export function validateAdapterModelEffort(input: ModelEffortValidationInput): string | null {
  const config = input.adapterConfig;
  if (config === undefined || config === null) return null;
  if (typeof config !== "object" || Array.isArray(config)) {
    return "Agent settings must be a set of named values.";
  }
  const record = config as Record<string, unknown>;
  const agentConfig = input.agentAdapterConfig ?? record;

  const model = record.model;
  if (model !== undefined && model !== null) {
    if (typeof model !== "string") {
      return "Model must be written as text, for example \"claude-sonnet-4-5\".";
    }
    if (model.length > MAX_MODEL_NAME_LENGTH) {
      return `Model name is too long (over ${MAX_MODEL_NAME_LENGTH} characters). Pick a model from the list.`;
    }
    if (model.trim() !== model || /\s/.test(model)) {
      return `Model "${model}" contains spaces. Pick a model from the list, for example "claude-sonnet-4-5".`;
    }
  }

  const key = getThinkingEffortKey(input.adapterType, agentConfig);
  const value = record[key];
  if (value === undefined || value === null || value === "") return null;
  const name = adapterDisplayName(input.adapterType);
  if (typeof value !== "string") {
    return `Thinking effort for ${name} must be written as text, for example "high".`;
  }
  const levels = getThinkingEffortLevels(input.adapterType, agentConfig);
  if (!levels) return null;
  if (levels.includes(value)) return null;
  const closest = levels.find((level) => level.toLowerCase() === value.trim().toLowerCase());
  const hint = closest ? ` Did you mean "${closest}"?` : "";
  const what = key === "mode" ? "Mode" : "Thinking effort";
  return `${what} "${value}" is not a level ${name} understands.${hint} Choose one of: ${levels.join(", ")}.`;
}
