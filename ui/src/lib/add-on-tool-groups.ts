/**
 * Grouping and short descriptions for "Tools from add-ons" on an agent's
 * Tools tab.
 *
 * Each add-on tool goes under the group its add-on gives it (`category`,
 * e.g. "Pictures"); a tool without one goes under its add-on's name, and a
 * tool with neither under "Other tools". The media groups come first in a
 * fixed order (Pictures, Picture editing, Video and sound), then the rest
 * alphabetically, with "Other tools" last. Inside a group the tools keep
 * the order the server listed them in (the add-on's own order).
 */

export const OTHER_TOOLS_GROUP = "Other tools";

const FIXED_GROUP_ORDER = ["Pictures", "Picture editing", "Video and sound"];

export interface AddOnToolLike {
  name: string;
  category?: string | null;
  pluginDisplayName?: string | null;
}

export interface AddOnToolGroup<T extends AddOnToolLike> {
  title: string;
  /** Stable, storage-safe key for remembering the group's open/closed state. */
  key: string;
  tools: T[];
}

export function addOnToolGroupTitle(tool: AddOnToolLike): string {
  const category = tool.category?.trim();
  if (category) return category;
  const plugin = tool.pluginDisplayName?.trim();
  if (plugin) return plugin;
  return OTHER_TOOLS_GROUP;
}

export function addOnToolGroupKey(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "group";
}

function groupRank(title: string): number {
  const fixed = FIXED_GROUP_ORDER.findIndex((entry) => entry.toLowerCase() === title.toLowerCase());
  if (fixed >= 0) return fixed;
  if (title === OTHER_TOOLS_GROUP) return FIXED_GROUP_ORDER.length + 2;
  return FIXED_GROUP_ORDER.length + 1;
}

export function groupAddOnTools<T extends AddOnToolLike>(tools: readonly T[]): AddOnToolGroup<T>[] {
  // Groups whose names differ only in case or punctuation ("Pictures" and
  // "pictures") are one group, under the first spelling seen.
  const byKey = new Map<string, { title: string; tools: T[] }>();
  for (const tool of tools) {
    const title = addOnToolGroupTitle(tool);
    const key = addOnToolGroupKey(title);
    const entry = byKey.get(key);
    if (entry) entry.tools.push(tool);
    else byKey.set(key, { title, tools: [tool] });
  }
  return [...byKey.entries()]
    .sort(
      ([, a], [, b]) =>
        groupRank(a.title) - groupRank(b.title) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    )
    .map(([key, entry]) => ({ title: entry.title, key, tools: entry.tools }));
}

/**
 * Split a description into its first sentence and the rest. A sentence ends
 * at ".", "!" or "?" followed by a space and a capital letter, digit or
 * quote, so "Fal.ai", "0.5" and "e.g. a sofa" do not cut it short. Text
 * with no such break is all first sentence.
 */
export function splitFirstSentence(text: string): { first: string; rest: string } {
  const trimmed = text.trim();
  const match = /^([\s\S]*?[.!?])\s+(?=[A-Z0-9"“'])/.exec(trimmed);
  if (!match) return { first: trimmed, rest: "" };
  const first = match[1]!;
  return { first, rest: trimmed.slice(match[0].length).trim() };
}

/**
 * The new ticked list when a whole group is turned on (add every tool in it)
 * or off (remove every tool in it); ticks outside the group are kept.
 */
export function selectionWithGroup(current: readonly string[], groupToolNames: readonly string[], turnOn: boolean): string[] {
  if (turnOn) return [...new Set([...current, ...groupToolNames])];
  const remove = new Set(groupToolNames);
  return current.filter((name) => !remove.has(name));
}
