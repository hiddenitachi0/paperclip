import { getThinkingEffortKey } from "@paperclipai/shared";

export const ISSUE_OVERRIDE_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "opencode_local",
]);

export type IssueModelLane = "primary" | "cheap" | "custom";

export interface BuildAssigneeAdapterOverridesInput {
  adapterType: string | null | undefined;
  lane: IssueModelLane;
  modelOverride: string;
  thinkingEffortOverride: string;
  chrome: boolean;
  /** DUR-4144: New Task switch "Plan first on Opus, then build on Sonnet". */
  planFirstOnOpus?: boolean;
}

/**
 * Build the `assigneeAdapterOverrides` payload sent to the issue create API.
 *
 * Lane semantics:
 * - "primary" → no overrides, runs on the agent's primary model.
 * - "cheap"   → `modelProfile: "cheap"` only; the runtime resolves the actual
 *               adapter config from the agent's runtimeConfig + adapter default.
 * - "custom"  → preserves the legacy explicit override path
 *               (`adapterConfig.model`, thinking effort, chrome).
 *
 * `planFirstOnOpus` is independent of lane: it forces the "planner" profile
 * for the first (plan-writing) run regardless of the lane chosen for the
 * build runs that follow, and is only honored by adapters that ship a
 * "planner" model profile (see packages/shared MODEL_PROFILE_KEYS).
 */
export function buildAssigneeAdapterOverrides(
  input: BuildAssigneeAdapterOverridesInput,
): Record<string, unknown> | null {
  const adapterType = input.adapterType ?? null;
  if (!adapterType || !ISSUE_OVERRIDE_ADAPTER_TYPES.has(adapterType)) {
    return null;
  }

  const planFirstOnOpus = input.planFirstOnOpus ? { planFirstOnOpus: true } : null;

  if (input.lane === "primary") {
    return planFirstOnOpus;
  }

  if (input.lane === "cheap") {
    return { modelProfile: "cheap", ...planFirstOnOpus };
  }

  const adapterConfig: Record<string, unknown> = {};
  if (input.modelOverride) adapterConfig.model = input.modelOverride;
  if (input.thinkingEffortOverride) {
    // The key each adapter reads its effort from comes from the one shared
    // per-adapter definition (packages/shared/src/model-effort.ts).
    adapterConfig[getThinkingEffortKey(adapterType)] = input.thinkingEffortOverride;
  }
  if (adapterType === "claude_local" && input.chrome) {
    adapterConfig.chrome = true;
  }

  if (Object.keys(adapterConfig).length === 0) return planFirstOnOpus;
  return { adapterConfig, ...planFirstOnOpus };
}
