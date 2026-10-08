import type { HuggingFaceModelEntry, HuggingFaceProviderEntry } from "../api/laneA";

/** Models matching the search text, keeping only tool-capable hosts when asked. Models left with no host drop out. */
export function filterHuggingFacePickerModels(
  models: HuggingFaceModelEntry[],
  opts: { search: string; toolsOnly: boolean },
): HuggingFaceModelEntry[] {
  const words = opts.search.toLowerCase().split(/\s+/).filter(Boolean);
  const out: HuggingFaceModelEntry[] = [];
  for (const m of models) {
    const id = m.id.toLowerCase();
    if (!words.every((w) => id.includes(w))) continue;
    const providers = opts.toolsOnly ? m.providers.filter((p) => p.supportsTools) : m.providers;
    if (providers.length > 0) out.push({ ...m, providers });
  }
  return out;
}

/** Cheapest tool-capable host for a model (by input + output price; hosts with no price sort last). */
export function cheapestToolProvider(model: HuggingFaceModelEntry): HuggingFaceProviderEntry | null {
  const cost = (p: HuggingFaceProviderEntry) =>
    p.inputUsdPerMillion === null || p.outputUsdPerMillion === null
      ? Number.POSITIVE_INFINITY
      : p.inputUsdPerMillion + p.outputUsdPerMillion;
  const capable = model.providers.filter((p) => p.supportsTools);
  if (capable.length === 0) return null;
  return capable.reduce((best, p) => (cost(p) < cost(best) ? p : best));
}

/**
 * Whether the saved choice can use tools. null = unknown (no suffix, a
 * cheapest/fastest/preferred policy, or a model/host not in the list).
 */
export function huggingFaceChoiceSupportsTools(
  models: HuggingFaceModelEntry[],
  model: string,
  suffix: string | null,
): boolean | null {
  if (!suffix || ["cheapest", "fastest", "preferred"].includes(suffix)) return null;
  const entry = models.find((m) => m.id === model);
  const host = entry?.providers.find((p) => p.provider === suffix);
  return host ? host.supportsTools : null;
}
