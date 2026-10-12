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

// ---------------------------------------------------------------------------
// Reading a thinking-effort value back out of a config, and "Agent default"
// labels for the task model/effort selector.
// ---------------------------------------------------------------------------

const ALL_THINKING_EFFORT_KEYS = ["effort", "modelReasoningEffort", "variant", "mode"] as const;

/**
 * The thinking-effort value stored in an adapterConfig (agent config or task
 * override), read from the key this adapter uses. Codex configs written before
 * the key was settled may carry `reasoningEffort`/`effort`; those are read as a
 * fallback so an old task still shows its level.
 */
export function getThinkingEffortValue(
  adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown> | null | undefined,
  agentAdapterConfig?: Record<string, unknown> | null,
): string {
  if (!adapterConfig) return "";
  const key = getThinkingEffortKey(adapterType, agentAdapterConfig ?? adapterConfig);
  const candidates: unknown[] = [adapterConfig[key]];
  if (key === "modelReasoningEffort") candidates.push(adapterConfig.reasoningEffort, adapterConfig.effort);
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/** Plain label for an effort id ("xhigh" -> "X-High"); unknown ids are shown as typed. */
export function thinkingEffortLabel(value: string): string {
  return LEVEL_LABELS[value] ?? value;
}

/**
 * "Agent default (claude-sonnet-5)" / "Agent default" -- the first entry of the
 * task model/effort dropdowns, meaning "no override, use the agent's own
 * setting". Showing the agent's actual value tells the operator what the task
 * will run on without opening the agent.
 */
export function agentDefaultLabel(value: string | null | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? `Agent default (${trimmed})` : "Agent default";
}

// ---------------------------------------------------------------------------
// Model typo guard against the adapter's model list.
// ---------------------------------------------------------------------------

/**
 * Short names the Claude CLI accepts in place of a full model id. They are
 * never in the adapter's model list, but agents (and older tasks) use them.
 */
const CLAUDE_MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable", "mythos", "opusplan", "default"]);

/** `claude-opus-5[1m]` -> `claude-opus-5` (context-size suffix the CLI understands). */
function stripModelSuffix(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "");
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[] = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    let prev = dist[0]!;
    dist[0] = i;
    for (let j = 1; j < cols; j++) {
      const temp = dist[j]!;
      dist[j] = Math.min(
        dist[j]! + 1,
        dist[j - 1]! + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = temp;
    }
  }
  return dist[cols - 1]!;
}

export interface ModelListValidationInput {
  adapterType: string | null | undefined;
  model: unknown;
  /** The adapter's model list (live or declared). Empty = unknown, nothing is rejected. */
  models: ReadonlyArray<{ id: string }>;
  /**
   * Models that are fine even if missing from the list -- the agent's own
   * saved model and its model-profile models (already in use, so not a typo).
   */
  alsoAllowed?: ReadonlyArray<string | null | undefined>;
}

/**
 * Typo guard for a model name: rejects a model that is not in the adapter's
 * model list, with a plain-language message and a "did you mean" hint. Lenient
 * on purpose -- an empty list, the agent's own models, Claude short names
 * ("opus") and context suffixes ("[1m]") are all accepted -- because a false
 * rejection blocks real work while a typo only fails one run.
 */
export function validateModelAgainstList(input: ModelListValidationInput): string | null {
  const model = input.model;
  if (model === undefined || model === null || model === "") return null;
  if (typeof model !== "string") return null; // shape errors are validateAdapterModelEffort's job
  if (input.models.length === 0) return null;
  const ids = input.models.map((entry) => entry.id);
  const allowed = new Set<string>([
    ...ids,
    ...(input.alsoAllowed ?? []).filter((value): value is string => typeof value === "string" && value.length > 0),
  ]);
  if (allowed.has(model) || allowed.has(stripModelSuffix(model))) return null;
  const isClaude = input.adapterType === "claude_local"
    || (input.adapterType === "acpx_local" && ids.some((id) => id.startsWith("claude")));
  if (isClaude && CLAUDE_MODEL_ALIASES.has(stripModelSuffix(model).toLowerCase())) return null;

  const lower = model.toLowerCase();
  const exactIgnoringCase = ids.find((id) => id.toLowerCase() === lower);
  let suggestion = exactIgnoringCase ?? null;
  if (!suggestion) {
    let best: { id: string; distance: number } | null = null;
    for (const id of ids) {
      const distance = editDistance(lower, id.toLowerCase());
      if (!best || distance < best.distance) best = { id, distance };
    }
    if (best && best.distance <= Math.max(2, Math.floor(best.id.length / 6))) suggestion = best.id;
  }
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : " Pick a model from the list.";
  return `Model "${model}" is not one ${adapterDisplayName(input.adapterType)} offers.${hint}`;
}

// ---------------------------------------------------------------------------
// Flow-down: a sub-task inheriting its parent task's model/effort override.
// ---------------------------------------------------------------------------

export interface InheritedFromMarker {
  issueId: string;
  identifier?: string | null;
}

export interface ChildModelEffortInheritanceInput {
  /** The parent task's assigneeAdapterOverrides. */
  parentOverrides: unknown;
  /** Adapter type of the agent working the parent task (null = unassigned/unknown). */
  parentAdapterType: string | null | undefined;
  /** Adapter type of the child's assignee (null = no agent assignee yet). */
  childAdapterType: string | null | undefined;
  /** The child's assignee's saved adapterConfig (needed for acpx effort keys). */
  childAgentAdapterConfig?: Record<string, unknown> | null;
  /**
   * What the creator sent for the child's assigneeAdapterOverrides:
   * `undefined` = nothing (inherit everything), `null` = explicitly "use the
   * agent's own setting" (inherit nothing), an object = explicit settings that
   * win key by key.
   */
  childOverrides: unknown;
  parentIssue: InheritedFromMarker;
}

export interface ChildModelEffortInheritance {
  /** The overrides to store on the child. */
  overrides: Record<string, unknown>;
  /** What was copied from the parent, e.g. { model: "claude-opus-5", effort: "max" }. */
  inherited: Record<string, string>;
  /** Parent settings that were not copied, with a plain reason each. */
  skipped: Array<{ key: string; value: string; reason: string }>;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Decides what a new sub-task inherits from its parent's model/effort override.
 *
 * - Only `model` and the thinking-effort value flow down -- never Chrome,
 *   workspace or other adapter switches, and never a "cheap"/"planner" preset
 *   (those resolve per agent at run time).
 * - Explicit settings on the child win key by key; an explicit `null`, or an
 *   explicit model-lane preset (`modelProfile`), opts out entirely.
 * - A model only flows to a child worked by the same kind of agent (an Opus
 *   model name means nothing to a Codex agent). Effort flows across kinds when
 *   the child's agent understands that level, stored under its own key.
 *
 * Returns null when nothing is inherited.
 */
export function deriveChildModelEffortInheritance(
  input: ChildModelEffortInheritanceInput,
): ChildModelEffortInheritance | null {
  if (input.childOverrides === null) return null;
  const childOverrides = input.childOverrides === undefined ? {} : plainRecord(input.childOverrides);
  if (!childOverrides) return null;
  if (typeof childOverrides.modelProfile === "string" && childOverrides.modelProfile.length > 0) return null;

  const parentConfig = plainRecord(plainRecord(input.parentOverrides)?.adapterConfig);
  if (!parentConfig) return null;

  const childConfig = { ...(plainRecord(childOverrides.adapterConfig) ?? {}) };
  const inherited: Record<string, string> = {};
  const skipped: ChildModelEffortInheritance["skipped"] = [];
  const parentType = input.parentAdapterType ?? null;
  const childType = input.childAdapterType ?? null;
  const sameKind = !parentType || !childType || parentType === childType;

  const parentModel = typeof parentConfig.model === "string" && parentConfig.model.length > 0 ? parentConfig.model : null;
  if (parentModel && !(typeof childConfig.model === "string" && childConfig.model.length > 0)) {
    if (sameKind) {
      childConfig.model = parentModel;
      inherited.model = parentModel;
    } else {
      skipped.push({
        key: "model",
        value: parentModel,
        reason: `the sub-task is worked by a different kind of agent (${adapterDisplayName(childType)}), so the parent's model does not apply`,
      });
    }
  }

  // The parent's effort, read from whichever key the parent's override uses.
  let parentEffort: string | null = null;
  for (const key of ALL_THINKING_EFFORT_KEYS) {
    if (key === "mode") continue;
    const value = parentConfig[key];
    if (typeof value === "string" && value.length > 0) {
      parentEffort = value;
      break;
    }
  }
  const childEffortKey = childType
    ? getThinkingEffortKey(childType, input.childAgentAdapterConfig ?? undefined)
    : (["effort", "modelReasoningEffort", "variant"] as const).find((key) => typeof parentConfig[key] === "string") ?? "effort";
  const childHasEffort = ALL_THINKING_EFFORT_KEYS.some(
    (key) => typeof childConfig[key] === "string" && (childConfig[key] as string).length > 0,
  );
  if (parentEffort && !childHasEffort) {
    const effortOk = !childType
      || (supportsThinkingEffort(childType)
        && isThinkingEffortValid(childType, parentEffort, input.childAgentAdapterConfig ?? undefined));
    if (effortOk && childEffortKey !== "mode") {
      childConfig[childEffortKey] = parentEffort;
      inherited.effort = parentEffort;
    } else {
      skipped.push({
        key: "effort",
        value: parentEffort,
        reason: `${adapterDisplayName(childType)} has no "${parentEffort}" thinking level`,
      });
    }
  }

  if (Object.keys(inherited).length === 0) {
    return skipped.length > 0 ? { overrides: childOverrides, inherited, skipped } : null;
  }
  return {
    overrides: {
      ...childOverrides,
      adapterConfig: childConfig,
      inheritedFrom: {
        issueId: input.parentIssue.issueId,
        ...(input.parentIssue.identifier ? { identifier: input.parentIssue.identifier } : {}),
      },
    },
    inherited,
    skipped,
  };
}
