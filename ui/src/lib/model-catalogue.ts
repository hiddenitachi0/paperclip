import {
  importModelDirectoryCatalogueSchema,
  LANE_A_PROVIDER_CATALOGUE,
  LANE_A_PROVIDERS,
  MODEL_DIRECTORY_EXPORT_VERSION,
  MODEL_DIRECTORY_IMPORT_MAX,
  MODEL_DIRECTORY_TAG_MAX_LENGTH,
  MODEL_DIRECTORY_TAGS_MAX,
  type LaneAProvider,
  type ModelDirectoryAvailability,
  type ModelDirectoryCatalogueEntry,
  type ModelDirectoryEntry,
  type ModelDirectoryLane,
  type ModelDirectorySpecs,
} from "@paperclipai/shared";

/**
 * Settings > Models as a catalogue: grouping, filtering, duplicate spotting
 * and the short plain-English texts the page shows for each saved model.
 * Pure functions only, so the page stays thin and all of this is tested.
 */

/** The fields of a saved model this module reads. */
export type CatalogueItem = Pick<
  ModelDirectoryEntry,
  | "id"
  | "name"
  | "provider"
  | "model"
  | "baseUrl"
  | "note"
  | "maker"
  | "baseModel"
  | "lane"
  | "availability"
  | "tags"
  | "specs"
  | "favorite"
  | "archivedAt"
>;

// ---------------------------------------------------------------- labels

/** Where a model runs, as the owner would say it. */
export function whereLabel(provider: LaneAProvider): string {
  if (provider === "local") return "On your PC";
  return LANE_A_PROVIDER_CATALOGUE[provider]?.label ?? provider;
}

const LANE_LABELS: Record<ModelDirectoryLane, string> = {
  quick: "Quick chat",
  full: "Full runs",
  both: "Both",
};

/** What a model is meant for. */
export function laneLabel(lane: ModelDirectoryLane | null | undefined): string {
  return lane ? LANE_LABELS[lane] : "Not set";
}

const AVAILABILITY_LABELS: Record<ModelDirectoryAvailability, string> = {
  installed: "Installed",
  downloading: "Downloading",
  planned: "Planned",
  cloud: "Cloud",
};

/** Whether a model is ready to use. */
export function availabilityLabel(availability: ModelDirectoryAvailability | null | undefined): string {
  return availability ? AVAILABILITY_LABELS[availability] : "Not set";
}

// ---------------------------------------------------------------- sorting

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Active before archived, favourites first, then by name. */
export function compareEntries(a: CatalogueItem, b: CatalogueItem): number {
  const archived = Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt));
  if (archived !== 0) return archived;
  const favourite = Number(Boolean(b.favorite)) - Number(Boolean(a.favorite));
  if (favourite !== 0) return favourite;
  return collator.compare(a.name, b.name);
}

function sorted<T extends CatalogueItem>(entries: readonly T[]): T[] {
  return [...entries].sort(compareEntries);
}

// ---------------------------------------------------------------- grouping

export type CatalogueGroupBy = "maker" | "where" | "use" | "none";
export const CATALOGUE_GROUP_BY_OPTIONS: ReadonlyArray<{ value: CatalogueGroupBy; label: string }> = [
  { value: "maker", label: "Maker and base model" },
  { value: "where", label: "Where it runs" },
  { value: "use", label: "What it's for" },
  { value: "none", label: "No grouping" },
];

export function isCatalogueGroupBy(value: unknown): value is CatalogueGroupBy {
  return CATALOGUE_GROUP_BY_OPTIONS.some((option) => option.value === value);
}

export interface CatalogueSubgroup<T extends CatalogueItem = CatalogueItem> {
  key: string;
  /** The base model, or "No base model". */
  title: string;
  /** True for the "No base model" bucket. */
  unset: boolean;
  entries: T[];
}

export interface CatalogueGroup<T extends CatalogueItem = CatalogueItem> {
  /** Stable and safe for storage keys and test ids, e.g. "maker-google". */
  key: string;
  title: string;
  /** Every entry of the group, in display order (subgroup by subgroup when there are subgroups). */
  entries: T[];
  /** Only when grouping by maker: one per base model. */
  subgroups?: CatalogueSubgroup<T>[];
}

export const OTHER_MAKER_TITLE = "Other";
export const NO_BASE_MODEL_TITLE = "No base model";

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/ø/g, "o")
      .replace(/æ/g, "ae")
      .replace(/ß/g, "ss")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x"
  );
}

/** Buckets by a case-insensitive label; the first spelling seen becomes the title. */
function bucket<T extends CatalogueItem>(
  entries: readonly T[],
  labelOf: (entry: T) => string | null | undefined,
): { titled: Array<{ norm: string; title: string; entries: T[] }>; missing: T[] } {
  const byNorm = new Map<string, { norm: string; title: string; entries: T[] }>();
  const missing: T[] = [];
  for (const entry of entries) {
    const label = labelOf(entry)?.trim();
    if (!label) {
      missing.push(entry);
      continue;
    }
    const norm = label.toLowerCase();
    const found = byNorm.get(norm);
    if (found) found.entries.push(entry);
    else byNorm.set(norm, { norm, title: label, entries: [entry] });
  }
  const titled = [...byNorm.values()].sort((a, b) => collator.compare(a.title, b.title));
  return { titled, missing };
}

function uniqueKey(used: Set<string>, base: string): string {
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
  used.add(key);
  return key;
}

/** Order the "Where it runs" groups appear in: your PC, then the usual clouds, then the rest. */
const WHERE_ORDER: readonly LaneAProvider[] = [
  "local",
  "openrouter",
  "huggingface",
  ...LANE_A_PROVIDERS.filter((p) => p !== "local" && p !== "openrouter" && p !== "huggingface"),
];

const USE_ORDER: ReadonlyArray<ModelDirectoryLane | null> = ["quick", "full", "both", null];

/**
 * Splits entries into the groups the page shows. Empty groups are left out;
 * "Other" / "No base model" / "Not set" always come last. Inside a group:
 * active before archived, favourites first, then by name.
 */
export function groupEntries<T extends CatalogueItem>(entries: readonly T[], by: CatalogueGroupBy): CatalogueGroup<T>[] {
  const used = new Set<string>();
  if (by === "none") {
    return entries.length === 0 ? [] : [{ key: "all", title: "All models", entries: sorted(entries) }];
  }
  if (by === "where") {
    return WHERE_ORDER.flatMap((provider) => {
      const inGroup = entries.filter((entry) => entry.provider === provider);
      return inGroup.length === 0
        ? []
        : [{ key: uniqueKey(used, `where-${provider}`), title: whereLabel(provider), entries: sorted(inGroup) }];
    });
  }
  if (by === "use") {
    return USE_ORDER.flatMap((lane) => {
      const inGroup = entries.filter((entry) => (entry.lane ?? null) === lane);
      return inGroup.length === 0
        ? []
        : [{ key: uniqueKey(used, `use-${lane ?? "unset"}`), title: laneLabel(lane), entries: sorted(inGroup) }];
    });
  }

  const makers = bucket(entries, (entry) => entry.maker);
  const makerBuckets = [
    ...makers.titled.map((b) => ({ key: `maker-${slug(b.norm)}`, title: b.title, entries: b.entries })),
    ...(makers.missing.length > 0 ? [{ key: "maker-other", title: OTHER_MAKER_TITLE, entries: makers.missing }] : []),
  ];
  return makerBuckets.map((maker) => {
    const groupKey = uniqueKey(used, maker.key);
    const subUsed = new Set<string>();
    const bases = bucket(maker.entries, (entry) => entry.baseModel);
    const subgroups: CatalogueSubgroup<T>[] = [
      ...bases.titled.map((b) => ({
        key: uniqueKey(subUsed, `${groupKey}-${slug(b.norm)}`),
        title: b.title,
        unset: false,
        entries: sorted(b.entries),
      })),
      ...(bases.missing.length > 0
        ? [
            {
              key: uniqueKey(subUsed, `${groupKey}-none`),
              title: NO_BASE_MODEL_TITLE,
              unset: true,
              entries: sorted(bases.missing),
            },
          ]
        : []),
    ];
    return {
      key: groupKey,
      title: maker.title,
      entries: subgroups.flatMap((sub) => sub.entries),
      subgroups,
    };
  });
}

// ---------------------------------------------------------------- filtering

/** "cloud" = anything not on your PC. */
export type CatalogueWhereFilter = "all" | "cloud" | LaneAProvider;
/** "quick" and "full" also match models marked for both. */
export type CatalogueUseFilter = "all" | ModelDirectoryLane | "unset";
export type CatalogueStatusFilter = "all" | ModelDirectoryAvailability | "unset";

export interface CatalogueFilters {
  search?: string;
  where?: CatalogueWhereFilter;
  use?: CatalogueUseFilter;
  availability?: CatalogueStatusFilter;
  /** Every chosen tag must be on the entry. */
  tags?: readonly string[];
  showArchived?: boolean;
}

export function hasActiveFilters(filters: CatalogueFilters): boolean {
  return (
    Boolean(filters.search?.trim()) ||
    (filters.where ?? "all") !== "all" ||
    (filters.use ?? "all") !== "all" ||
    (filters.availability ?? "all") !== "all" ||
    (filters.tags?.length ?? 0) > 0
  );
}

function searchText(entry: CatalogueItem): string {
  return [entry.name, entry.model, entry.maker, entry.baseModel, ...(entry.tags ?? []), entry.note]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("\n")
    .toLowerCase();
}

/**
 * The entries that pass every filter. Search is case-insensitive and every
 * word must appear somewhere in the name, model id, maker, base model, tags
 * or note. Archived entries only show when `showArchived` is on.
 */
export function filterEntries<T extends CatalogueItem>(entries: readonly T[], filters: CatalogueFilters): T[] {
  const words = (filters.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const where = filters.where ?? "all";
  const use = filters.use ?? "all";
  const availability = filters.availability ?? "all";
  const tags = (filters.tags ?? []).map((tag) => tag.toLowerCase());
  return entries.filter((entry) => {
    if (!filters.showArchived && entry.archivedAt) return false;
    if (where === "cloud" ? entry.provider === "local" : where !== "all" && entry.provider !== where) return false;
    if (use !== "all") {
      const lane = entry.lane ?? null;
      if (use === "unset" ? lane !== null : use === "both" ? lane !== "both" : lane !== use && lane !== "both") {
        return false;
      }
    }
    if (availability !== "all") {
      const value = entry.availability ?? null;
      if (availability === "unset" ? value !== null : value !== availability) return false;
    }
    if (tags.length > 0) {
      const own = new Set((entry.tags ?? []).map((tag) => tag.toLowerCase()));
      if (!tags.every((tag) => own.has(tag))) return false;
    }
    if (words.length > 0) {
      const text = searchText(entry);
      if (!words.every((word) => text.includes(word))) return false;
    }
    return true;
  });
}

/** Every tag in use, sorted. */
export function tagsInUse(entries: readonly CatalogueItem[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.tags ?? []))].sort(collator.compare);
}

function distinctLabels(values: Array<string | null | undefined>): string[] {
  const byNorm = new Map<string, string>();
  for (const value of values) {
    const label = value?.trim();
    if (label && !byNorm.has(label.toLowerCase())) byNorm.set(label.toLowerCase(), label);
  }
  return [...byNorm.values()].sort(collator.compare);
}

/** Makers already used, for the maker suggestions. */
export function makersInUse(entries: readonly CatalogueItem[]): string[] {
  return distinctLabels(entries.map((entry) => entry.maker));
}

/** Base models already used (only this maker's when one is given), for the base model suggestions. */
export function baseModelsInUse(entries: readonly CatalogueItem[], maker?: string | null): string[] {
  const wanted = maker?.trim().toLowerCase();
  return distinctLabels(
    entries
      .filter((entry) => !wanted || (entry.maker ?? "").trim().toLowerCase() === wanted)
      .map((entry) => entry.baseModel),
  );
}

/** Cloud providers that have at least one entry, in the usual order. */
export function cloudProvidersInUse(entries: readonly CatalogueItem[]): LaneAProvider[] {
  return WHERE_ORDER.filter((provider) => provider !== "local" && entries.some((entry) => entry.provider === provider));
}

// ---------------------------------------------------------------- duplicates

function sameModelKey(entry: CatalogueItem): string {
  const address = (entry.baseUrl ?? "").trim().toLowerCase().replace(/\/+$/, "");
  return [entry.provider, entry.model.trim().toLowerCase(), address].join("\u0000");
}

/**
 * Entries that point at the very same model (same provider, model id and
 * address; case and a trailing slash ignored). Maps an entry id to the names
 * of the OTHER entries it matches; entries without a twin are not in the map.
 */
export function findDuplicates(entries: readonly CatalogueItem[]): Map<string, string[]> {
  const byKey = new Map<string, CatalogueItem[]>();
  for (const entry of entries) {
    const key = sameModelKey(entry);
    const list = byKey.get(key);
    if (list) list.push(entry);
    else byKey.set(key, [entry]);
  }
  const result = new Map<string, string[]>();
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    for (const entry of list) {
      result.set(
        entry.id,
        list.filter((other) => other.id !== entry.id).map((other) => other.name),
      );
    }
  }
  return result;
}

/** The chip text for a duplicate: "Same model as Maja local" or "Same model as Maja local +2". */
export function duplicateLabel(names: readonly string[]): string {
  if (names.length === 0) return "";
  return `Same model as ${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ""}`;
}

// ---------------------------------------------------------------- texts

function roundOne(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** 131072 -> "128K", 1000000 -> "1M". */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${roundOne(tokens / 1_000_000)}M`;
  if (tokens >= 1000) {
    const k = tokens % 1000 === 0 ? tokens / 1000 : tokens % 1024 === 0 ? tokens / 1024 : Math.round(tokens / 1000);
    return `${k}K`;
  }
  return String(tokens);
}

/**
 * One short line with the facts that help pick a model, e.g.
 * "27B · Q4_K_M · 16.5 GB · 128K context · fits your GPU: tight · tools: yes · vision".
 * Empty when nothing is known.
 */
export function describeSpecs(specs: ModelDirectorySpecs | null | undefined): string {
  if (!specs) return "";
  const parts: string[] = [];
  if (specs.params?.trim()) parts.push(specs.params.trim());
  if (specs.quant?.trim()) parts.push(specs.quant.trim());
  if (typeof specs.sizeGb === "number") parts.push(`${roundOne(specs.sizeGb)} GB`);
  if (typeof specs.contextTokens === "number" && specs.contextTokens > 0) {
    parts.push(`${formatContextTokens(specs.contextTokens)} context`);
  }
  if (specs.fitsLocalGpu) parts.push(`fits your GPU: ${specs.fitsLocalGpu}`);
  if (specs.tools) parts.push(`tools: ${specs.tools}`);
  if (specs.vision) parts.push("vision");
  if (specs.thinking === "yes") parts.push("thinking");
  if (specs.thinking === "toggle") parts.push("thinking on/off");
  return parts.join(" · ");
}

/** The first non-empty line of a note, and whether there is more after it. */
export function noteFirstLine(note: string | null | undefined): { first: string; more: boolean } {
  const lines = (note ?? "").split(/\r?\n/).map((line) => line.trim());
  const index = lines.findIndex((line) => line !== "");
  if (index < 0) return { first: "", more: false };
  return { first: lines[index]!, more: lines.slice(index + 1).some((line) => line !== "") };
}

/** "31 models · 12 on your PC · 19 in the cloud · 3 archived" (archived ones are not in the first three numbers). */
export function countsLine(entries: readonly CatalogueItem[], shown?: number): string {
  const active = entries.filter((entry) => !entry.archivedAt);
  const local = active.filter((entry) => entry.provider === "local").length;
  const archived = entries.length - active.length;
  const parts = [
    `${active.length} ${active.length === 1 ? "model" : "models"}`,
    `${local} on your PC`,
    `${active.length - local} in the cloud`,
  ];
  if (archived > 0) parts.push(`${archived} archived`);
  if (shown !== undefined) parts.push(`${shown} shown`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------- tags input

/** "Uncensored, vision, , vision" -> ["uncensored", "vision"]. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** Why these tags cannot be saved, in plain words, or null. */
export function tagsIssue(tags: readonly string[]): string | null {
  if (tags.length > MODEL_DIRECTORY_TAGS_MAX) return `Use at most ${MODEL_DIRECTORY_TAGS_MAX} tags.`;
  const long = tags.find((tag) => tag.length > MODEL_DIRECTORY_TAG_MAX_LENGTH);
  if (long) return `The tag "${long}" is too long (at most ${MODEL_DIRECTORY_TAG_MAX_LENGTH} letters).`;
  return null;
}

// ---------------------------------------------------------------- export / import

/** paperclip-models-<company>-<yyyy-mm-dd>.json, using the local date. */
export function catalogueFileName(companyName: string | null | undefined, date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const company = companyName?.trim() ? slug(companyName) : "company";
  return `paperclip-models-${company}-${day}.json`;
}

export type ParsedCatalogueFile =
  | { ok: true; entries: ModelDirectoryCatalogueEntry[] }
  | { ok: false; error: string };

const NOT_A_MODEL_LIST = "This file is not a list of models. Pick a file made with Export on this page.";

/**
 * Reads an exported models file (or a bare list of entries) and checks it
 * the same way the server will, so problems show before anything is sent.
 */
export function parseCatalogueFile(text: string): ParsedCatalogueFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: NOT_A_MODEL_LIST };
  }
  const object = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const entries = Array.isArray(raw) ? raw : object?.entries;
  if (!Array.isArray(entries)) return { ok: false, error: NOT_A_MODEL_LIST };
  if (object && object.version !== undefined && object.version !== MODEL_DIRECTORY_EXPORT_VERSION) {
    return { ok: false, error: "This file was made by a different version of Paperclip and cannot be read here." };
  }
  if (entries.length === 0) return { ok: false, error: "This file has no models in it." };
  if (entries.length > MODEL_DIRECTORY_IMPORT_MAX) {
    return { ok: false, error: `This file has ${entries.length} models. Import at most ${MODEL_DIRECTORY_IMPORT_MAX} at a time.` };
  }
  const parsed = importModelDirectoryCatalogueSchema.safeParse({ entries });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const index = issue?.path[0] === "entries" && typeof issue.path[1] === "number" ? issue.path[1] : null;
    const name =
      index !== null && entries[index] && typeof (entries[index] as { name?: unknown }).name === "string"
        ? ` ("${(entries[index] as { name: string }).name}")`
        : "";
    const field = issue && issue.path.length > 2 ? ` ${issue.path.slice(2).join(".")}:` : ":";
    const where = index !== null ? `Model ${index + 1}${name}${field}` : "This file:";
    return { ok: false, error: `${where} ${issue?.message ?? "something is not right."}` };
  }
  return { ok: true, entries: parsed.data.entries };
}

/** Which names in the file are new and which already exist here (name match ignores case). */
export function importPreview(
  fileEntries: ReadonlyArray<{ name: string }>,
  existing: ReadonlyArray<{ name: string }>,
): { fresh: string[]; existing: string[] } {
  const here = new Set(existing.map((entry) => entry.name.trim().toLowerCase()));
  const fresh: string[] = [];
  const already: string[] = [];
  for (const entry of fileEntries) {
    (here.has(entry.name.trim().toLowerCase()) ? already : fresh).push(entry.name);
  }
  return { fresh, existing: already };
}
