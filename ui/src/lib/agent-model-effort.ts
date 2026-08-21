/**
 * Shared "thinking effort" semantics for adapters that support it — the storage
 * key name AND the valid value vocabulary both vary by adapterType. Single
 * source of truth for AgentConfigForm.tsx (one agent) and BulkAgentEditDialog.tsx
 * (many agents), so the two never drift apart.
 */

export const claudeThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X-High" },
  { id: "max", label: "Max" },
] as const;

export const codexThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X-High" },
] as const;

export const openCodeThinkingEffortOptions = [
  { id: "", label: "Auto" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X-High" },
  { id: "max", label: "Max" },
] as const;

export const cursorModeOptions = [
  { id: "", label: "Auto" },
  { id: "plan", label: "Plan" },
  { id: "ask", label: "Ask" },
] as const;

export type ThinkingEffortOption = { id: string; label: string };

/** acpx_local wraps another CLI ("agent"); only its "codex" variant uses codex-shaped effort. */
function acpxWrapsCodex(adapterConfig: Record<string, unknown> | undefined): boolean {
  return String(adapterConfig?.agent ?? "claude") === "codex";
}

/** The adapterConfig key an agent's thinking-effort value is stored under. */
export function getThinkingEffortKey(adapterType: string, adapterConfig?: Record<string, unknown>): string {
  if (adapterType === "codex_local") return "modelReasoningEffort";
  if (adapterType === "acpx_local" && acpxWrapsCodex(adapterConfig)) return "modelReasoningEffort";
  if (adapterType === "cursor") return "mode";
  if (adapterType === "opencode_local") return "variant";
  return "effort";
}

/** The valid value vocabulary for that adapter's thinking-effort key. */
export function getThinkingEffortOptions(
  adapterType: string,
  adapterConfig?: Record<string, unknown>,
): readonly ThinkingEffortOption[] {
  if (adapterType === "codex_local") return codexThinkingEffortOptions;
  if (adapterType === "acpx_local" && acpxWrapsCodex(adapterConfig)) return codexThinkingEffortOptions;
  if (adapterType === "cursor") return cursorModeOptions;
  if (adapterType === "opencode_local") return openCodeThinkingEffortOptions;
  return claudeThinkingEffortOptions;
}

/** Some adapters hide thinking-effort entirely (no such concept for that CLI). */
export function supportsThinkingEffort(adapterType: string): boolean {
  return adapterType !== "gemini_local" && adapterType !== "cursor_cloud";
}
