import type { HelperModelOption, HelperSettingsView, ModelOptionStatus } from "@paperclipai/shared";

/**
 * Readiness in the Ask panel's model picker, worded the same way as the
 * other model pickers (ModelReadiness / modelOptionStatus): "✅ Ready",
 * "⚠️ Not installed" (a local model the last model-server reading did not
 * find), "❌ Needs a key". The status itself comes from the server
 * (helper settings), which knows the helper's own keys and the stored
 * model-server readings; nothing here calls a model.
 */

/** Lower is better: ready first, then "check this", then "will not work". */
export function helperStatusRank(status: ModelOptionStatus | null | undefined): number {
  if (!status) return 1;
  if (status.tone === "ok") return 0;
  if (status.kind === "needs_key" || status.kind === "broken") return 3;
  if (status.tone === "fail") return 2;
  return 1;
}

export function helperStatusText(status: ModelOptionStatus | null | undefined): string {
  if (!status) return "";
  if (status.tone === "ok") return "✅ Ready";
  if (status.kind === "needs_key" || status.kind === "broken") return `❌ ${status.label}`;
  return `⚠️ ${status.label}`;
}

export function isHelperStatusReady(status: ModelOptionStatus | null | undefined): boolean {
  return status?.tone === "ok";
}

/** Ready first, then the rest, keeping the server's order (favourites, then name) inside each rank. */
export function sortByReadiness<T extends { option: HelperModelOption }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => helperStatusRank(a.item.option.status) - helperStatusRank(b.item.option.status) || a.index - b.index)
    .map(({ item }) => item);
}

/** The model that will answer: the picked one, else the company's helper default, else Paperclip's built-in default. */
export function effectiveHelperModel(
  settings: HelperSettingsView | undefined,
  entryId: string,
): { option: HelperModelOption | null; name: string; canSeePictures: boolean | null; status: ModelOptionStatus | null } {
  const picked = settings?.models.find((m) => m.id === entryId) ?? null;
  const fallback = settings?.models.find((m) => m.id === settings.defaultDirectoryEntryId) ?? null;
  const option = picked ?? (entryId ? null : fallback);
  if (option) return { option, name: option.name, canSeePictures: option.canSeePictures, status: option.status ?? null };
  return {
    option: null,
    name: settings ? `Paperclip's default (${settings.builtInDefaultLabel})` : "Paperclip's default",
    canSeePictures: settings ? settings.builtInDefaultCanSeePictures : null,
    status: settings?.builtInDefaultStatus ?? null,
  };
}
