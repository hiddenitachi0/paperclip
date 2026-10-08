import {
  importModelDirectoryCatalogueSchema,
  LANE_A_PROVIDER_CATALOGUE,
  LANE_A_PROVIDERS,
  laneAModelsForProvider,
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
  type ModelDirectoryRating,
  type CreateModelDirectoryEntry,
  type KnownModelFamily,
  type KnownModelVariant,
  type KnownOllamaTag,
  type KnownOpenRouterOption,
  type KnownHuggingFaceOption,
  type LocalInstalledModel,
  GPU_FIT_HEADROOM,
  KNOWN_MODEL_FAMILIES,
  MODEL_DIRECTORY_RATINGS_MAX,
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
  | "family"
  | "variant"
  | "ratings"
  | "providerRouting"
>;

// ---------------------------------------------------------------- labels

/** Where a model runs, in plain words. "local" = this company's own model server (Ollama or similar). */
export function whereLabel(provider: LaneAProvider): string {
  if (provider === "local") return "On your own computer (local)";
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
  { value: "maker", label: "Maker, model and size" },
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

/** Order the "Where it runs" groups appear in: local, then the usual clouds, then the rest. */
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

/** "cloud" = anything not on the company's own model server. */
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
  /** "Best for": only entries with a score for this criterion (case ignored). */
  criterion?: string;
}

export function hasActiveFilters(filters: CatalogueFilters): boolean {
  return (
    Boolean(filters.search?.trim()) ||
    (filters.where ?? "all") !== "all" ||
    (filters.use ?? "all") !== "all" ||
    (filters.availability ?? "all") !== "all" ||
    (filters.tags?.length ?? 0) > 0 ||
    Boolean(filters.criterion?.trim())
  );
}

function searchText(entry: CatalogueItem): string {
  return [
    entry.name,
    entry.model,
    entry.maker,
    entry.baseModel,
    entry.family,
    entry.variant,
    ...(entry.tags ?? []),
    entry.note,
  ]
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
  const criterion = filters.criterion?.trim().toLowerCase() ?? "";
  return entries.filter((entry) => {
    if (criterion && ratingFor(entry, criterion) === null) return false;
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

/** Model families already used (family, else the older base model), only this maker's when one is given. */
export function familiesInUse(entries: readonly CatalogueItem[], maker?: string | null): string[] {
  const wanted = maker?.trim().toLowerCase();
  return distinctLabels(
    entries
      .filter((entry) => !wanted || (entry.maker ?? "").trim().toLowerCase() === wanted)
      .map((entry) => entry.family ?? entry.baseModel),
  );
}

/**
 * Family suggestions for the edit dialog: the ones in use plus the known ones
 * (only this maker's known ones when the maker is a known maker).
 */
export function knownFamilySuggestions(
  maker: string | null | undefined,
  inUse: readonly string[],
  known: readonly KnownModelFamily[] = KNOWN_MODEL_FAMILIES,
): string[] {
  const wanted = maker?.trim().toLowerCase() ?? "";
  const byMaker = known.filter((family) => family.maker.toLowerCase() === wanted);
  const pool = wanted && byMaker.length > 0 ? byMaker : known;
  return distinctLabels([...inUse, ...pool.map((family) => family.family)]);
}

/** Size suggestions for a family: the known sizes (smallest first), then sizes already used for it. */
export function variantSuggestions(
  family: string | null | undefined,
  entries: readonly CatalogueItem[],
  known: readonly KnownModelFamily[] = KNOWN_MODEL_FAMILIES,
): string[] {
  const wanted = family?.trim().toLowerCase() ?? "";
  if (!wanted) return [];
  const knownFamily = known.find((candidate) => candidate.family.toLowerCase() === wanted);
  const knownSizes = [...(knownFamily?.variants ?? [])].sort((a, b) => a.paramsB - b.paramsB).map((v) => v.variant);
  const used = entries
    .filter((entry) => (entry.family ?? entry.baseModel ?? "").trim().toLowerCase() === wanted)
    .map((entry) => entry.variant);
  const seen = new Set(knownSizes.map((size) => size.toLowerCase()));
  return [...knownSizes, ...distinctLabels(used).filter((size) => !seen.has(size.toLowerCase()))];
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

/** "31 models · 12 local · 19 in the cloud · 3 archived" (archived ones are not in the first three numbers). */
export function countsLine(entries: readonly CatalogueItem[], shown?: number): string {
  const active = entries.filter((entry) => !entry.archivedAt);
  const local = active.filter((entry) => entry.provider === "local").length;
  const archived = entries.length - active.length;
  const parts = [
    `${active.length} ${active.length === 1 ? "model" : "models"}`,
    `${local} local`,
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

// ================================================================ catalogue v2
//
// Maker -> Model family -> Size -> ways to run it. Built from the saved
// entries plus the built-in list of known open models (KNOWN_MODEL_FAMILIES),
// so a family the company has saved once also shows its other sizes, whether
// each fits the graphics card, the `ollama pull` command for a size that is
// not installed, and the bigger cloud sizes as "upgrades".

// ---------------------------------------------------------------- ratings

/** The company's own score for one criterion (case ignored), or null. */
export function ratingFor(entry: Pick<CatalogueItem, "ratings">, criterion: string): number | null {
  const wanted = criterion.trim().toLowerCase();
  if (!wanted) return null;
  const found = (entry.ratings ?? []).find((rating) => rating.criterion.trim().toLowerCase() === wanted);
  return found ? found.score : null;
}

/** Average of all scores, one decimal, or null when there are none. */
export function ratingsAverage(ratings: readonly ModelDirectoryRating[] | null | undefined): number | null {
  const list = ratings ?? [];
  if (list.length === 0) return null;
  return Math.round((list.reduce((sum, rating) => sum + rating.score, 0) / list.length) * 10) / 10;
}

/** "Tool calling 8 · Responsiveness 6". */
export function ratingsLine(ratings: readonly ModelDirectoryRating[] | null | undefined): string {
  return (ratings ?? []).map((rating) => `${rating.criterion} ${rating.score}`).join(" · ");
}

/** Criteria the company already scores models on, for the suggestions and the "Best for" filter. */
export function criteriaInUse(entries: readonly Pick<CatalogueItem, "ratings">[]): string[] {
  return distinctLabels(entries.flatMap((entry) => (entry.ratings ?? []).map((rating) => rating.criterion)));
}

/** Offered even before anyone has scored anything. */
export const SUGGESTED_CRITERIA: readonly string[] = [
  "Tool calling",
  "Responsiveness",
  "Works well on longer conversations",
  "Coding",
  "Writing",
  "Following instructions",
];

export type CatalogueSort = "name" | "rating";

/** The score used for "Sort by rating": the chosen criterion, else the average. */
export function sortScore(entry: Pick<CatalogueItem, "ratings">, criterion?: string | null): number | null {
  return criterion?.trim() ? ratingFor(entry, criterion) : ratingsAverage(entry.ratings);
}

/** Sort order for one list: by name (favourites first), or best score first (unscored last). */
export function compareEntriesBy(sort: CatalogueSort, criterion?: string | null) {
  return (a: CatalogueItem, b: CatalogueItem): number => {
    if (sort === "rating") {
      const archived = Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt));
      if (archived !== 0) return archived;
      const sa = sortScore(a, criterion);
      const sb = sortScore(b, criterion);
      if (sa !== sb) return (sb ?? -1) - (sa ?? -1);
    }
    return compareEntries(a, b);
  };
}

export interface RatingRowIssueInput {
  criterion: string;
  score: number | string;
}

/** Why these score rows cannot be saved, in plain words, or null. Empty rows are ignored. */
export function ratingsIssue(rows: readonly RatingRowIssueInput[]): string | null {
  const filled = rows.filter((row) => row.criterion.trim() !== "");
  if (filled.length > MODEL_DIRECTORY_RATINGS_MAX) return `Keep at most ${MODEL_DIRECTORY_RATINGS_MAX} scores.`;
  const seen = new Set<string>();
  for (const row of filled) {
    const name = row.criterion.trim();
    if (name.length > 40) return `"${name.slice(0, 20)}…" is too long for a score name (at most 40 letters).`;
    const norm = name.toLowerCase();
    if (seen.has(norm)) return `"${name}" has two scores. Keep one.`;
    seen.add(norm);
    const score = typeof row.score === "number" ? row.score : Number(String(row.score).trim().replace(",", "."));
    if (String(row.score).trim() === "" || !Number.isInteger(score) || score < 0 || score > 10) {
      return `The score for "${name}" must be a whole number from 0 to 10.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- known models

export interface KnownMatch {
  family: KnownModelFamily;
  variant: KnownModelVariant;
  ollamaTag?: KnownOllamaTag;
  openrouter?: KnownOpenRouterOption;
  huggingface?: KnownHuggingFaceOption;
}

/** "llama3.2" and "llama3.2:latest" are the same Ollama tag. */
export function normalizeOllamaTag(tag: string): string {
  // Same rule as the shared findKnownVariant: no registry prefix, ":latest" when the last segment has no tag.
  const trimmed = tag.trim().toLowerCase().replace(/^registry\.ollama\.ai\//, "").replace(/^library\//, "");
  const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return lastSegment.includes(":") ? trimmed : `${trimmed}:latest`;
}

function tagNames(tag: KnownOllamaTag): string[] {
  return [tag.tag, ...(tag.aliases ?? [])].map(normalizeOllamaTag);
}

/** Model id without a ":free" / ":featherless-ai" style suffix. */
function idStem(id: string): string {
  return id.trim().toLowerCase().split(":")[0]!;
}

/**
 * Which known model size a provider + model id is, or null. Local tags match
 * any listed alias; OpenRouter and Hugging Face ids match with or without a
 * ":suffix".
 */
export function findKnownMatch(
  provider: LaneAProvider,
  model: string,
  known: readonly KnownModelFamily[] = KNOWN_MODEL_FAMILIES,
): KnownMatch | null {
  const id = model.trim().toLowerCase();
  if (!id) return null;
  for (const family of known) {
    for (const variant of family.variants) {
      if (provider === "local") {
        const tag = variant.ollama.find((candidate) => tagNames(candidate).includes(normalizeOllamaTag(id)));
        if (tag) return { family, variant, ollamaTag: tag };
      } else if (provider === "openrouter") {
        const option =
          variant.openrouter.find((candidate) => candidate.id.toLowerCase() === id) ??
          variant.openrouter.find((candidate) => idStem(candidate.id) === idStem(id));
        if (option) return { family, variant, openrouter: option };
      } else if (provider === "huggingface") {
        const option =
          variant.huggingface.find((candidate) => candidate.model.toLowerCase() === id) ??
          variant.huggingface.find((candidate) => idStem(candidate.model) === idStem(id));
        if (option) return { family, variant, huggingface: option };
      }
    }
  }
  return null;
}

export type GpuFit = "yes" | "tight" | "no";

/**
 * Whether a size fits a graphics card with this much memory: "yes" with room
 * to spare, "tight" when it only just fits, "no" when it is too big (or there
 * is no graphics card: 0 GB), null when either number is unknown. Nothing is
 * assumed while the company has not entered its graphics card memory.
 */
export function gpuFit(minVramGb: number | null | undefined, vramGb: number | null | undefined): GpuFit | null {
  if (typeof minVramGb !== "number" || typeof vramGb !== "number" || !Number.isFinite(vramGb) || vramGb < 0) return null;
  if (vramGb === 0) return "no";
  if (minVramGb <= vramGb * GPU_FIT_HEADROOM) return "yes";
  if (minVramGb <= vramGb) return "tight";
  return "no";
}

/** What to show while the graphics card memory is not set (Settings > Models top). */
export const GPU_NOT_SET_ADVICE = "Set your graphics card memory above to see what fits.";

export function gpuFitLabel(fit: GpuFit | null, vramGb?: number | null): string {
  if (fit === "yes") return "Fits the graphics card";
  if (fit === "tight") return "Just about fits the graphics card";
  if (fit === "no") return vramGb === 0 ? "Needs a graphics card" : "Too big for the graphics card";
  return "";
}

// ---------------------------------------------------------------- run labels

function normalizeAddress(url: string | null | undefined): string {
  return (url ?? "").trim().replace(/\/+$/, "");
}

/** The model hosts an OpenRouter entry is pinned to, or [] for "any host". */
function pinnedHosts(entry: Pick<CatalogueItem, "providerRouting">): string[] {
  return entry.providerRouting?.only ?? [];
}

function hostsText(hosts: readonly string[]): string {
  return hosts.length > 0 ? hosts.join(", ") : "any host";
}

/**
 * How a saved entry runs, as the tree shows it: "Local · llama3.2:3b",
 * "OpenRouter · deepinfra, together", "Hugging Face · featherless-ai".
 */
export function runOptionLabel(entry: Pick<CatalogueItem, "provider" | "model" | "providerRouting">): string {
  if (entry.provider === "local") return `Local · ${entry.model}`;
  if (entry.provider === "openrouter") return `OpenRouter · ${hostsText(pinnedHosts(entry))}`;
  if (entry.provider === "huggingface") {
    const host = entry.model.includes(":") ? entry.model.split(":").slice(1).join(":") : "";
    return host ? `Hugging Face · ${host}` : "Hugging Face";
  }
  return whereLabel(entry.provider);
}

// ---------------------------------------------------------------- names

export const UNSPECIFIED_VARIANT = "Unspecified";
export const NO_FAMILY_TITLE = "Model not set";

/** Maker, family and size of a saved entry, filled in from the known list where the entry leaves them out. */
export function entryIdentity(
  entry: Pick<CatalogueItem, "provider" | "model" | "maker" | "family" | "baseModel" | "variant" | "specs">,
  known: readonly KnownModelFamily[] = KNOWN_MODEL_FAMILIES,
): { maker: string | null; family: string | null; variant: string | null; match: KnownMatch | null } {
  const match = findKnownMatch(entry.provider, entry.model, known);
  return {
    maker: entry.maker?.trim() || match?.family.maker || null,
    family: entry.family?.trim() || entry.baseModel?.trim() || match?.family.family || null,
    variant: entry.variant?.trim() || match?.variant.variant || entry.specs?.params?.trim() || null,
    match,
  };
}

// ---------------------------------------------------------------- tree

export interface KnownRunOption {
  key: string;
  provider: "local" | "openrouter" | "huggingface";
  model: string;
  /** "Local · llama3.2:1b (Q4_K_M, 1.3 GB)", "OpenRouter · deepinfra, together", "Hugging Face". */
  label: string;
  /** Local only: what to type on the computer that runs the model server to download it. */
  pullCommand?: string;
  /**
   * Local only: true when the company has no model server address yet, so
   * the draft has no address and the page asks for it instead of adding.
   */
  needsAddress?: boolean;
  /** OpenRouter only: hosts that support tool calling. */
  hosts?: string[];
  /** Ready to hand to the add dialog. */
  draft: CreateModelDirectoryEntry;
}

export interface UpgradeOption {
  key: string;
  family: string;
  variant: string;
  paramsB: number;
  fit: GpuFit | null;
  /** Set when it fits your graphics card and Ollama has it. */
  local: KnownRunOption | null;
  /** Set when OpenRouter has hosts with tool calling. */
  openrouter: KnownRunOption | null;
  /** True when this size is already saved (any way of running it). */
  saved: boolean;
}

export interface VariantNode<T extends CatalogueItem = CatalogueItem> {
  key: string;
  title: string;
  known: KnownModelVariant | null;
  /** Saved ways to run this size, in display order. */
  entries: T[];
  /** Known ways not saved yet (only when known options are asked for). */
  knownOptions: KnownRunOption[];
  fit: GpuFit | null;
  /** A saved local entry of this size is marked installed. */
  installedLocally: boolean;
  /** For a size Ollama has that is not installed: "ollama pull llama3.2:1b". */
  pullCommand: string | null;
  /** "Too big for the graphics card (needs ~20 GB, this company's has 12 GB) - run it on OpenRouter (hosts with tool calling when last checked: deepinfra, together)". */
  tooBigAdvice: string | null;
  upgrades: UpgradeOption[];
}

export interface FamilyNode<T extends CatalogueItem = CatalogueItem> {
  key: string;
  title: string;
  unset: boolean;
  known: KnownModelFamily | null;
  variants: VariantNode<T>[];
  entries: T[];
}

export interface MakerNode<T extends CatalogueItem = CatalogueItem> {
  key: string;
  title: string;
  families: FamilyNode<T>[];
  entries: T[];
}

export interface ModelTreeOptions {
  known?: readonly KnownModelFamily[];
  /** The company's graphics card memory in GB (0 = none), for fit advice; null = not set, no advice. */
  gpuVramGb?: number | null;
  /** Add the not-yet-saved sizes and ways to run them (default true). */
  includeKnown?: boolean;
  /** Which providers' known options to offer (default: all). */
  knownProviders?: ReadonlyArray<"local" | "openrouter" | "huggingface">;
  /** Address used for local "Add" drafts; null = not set (local options then ask for it). */
  localAddress?: string | null;
  sort?: CatalogueSort;
  criterion?: string | null;
  /** Installed Ollama tags from the last resync: local drafts for these are marked installed. */
  installedTags?: ReadonlySet<string>;
}

/** The address most saved local entries use, or null when there is none. */
export function localAddressOf(entries: readonly Pick<CatalogueItem, "provider" | "baseUrl">[]): string | null {
  return localAddressesInUse(entries)[0] ?? null;
}

/**
 * The address new local setups start from: the company's model server
 * address (Settings > Models), else the one its saved local models use most,
 * else null, and the page asks for it. Never a built-in guess.
 */
export function defaultLocalAddress(
  setting: string | null | undefined,
  entries: readonly Pick<CatalogueItem, "provider" | "baseUrl">[],
): string | null {
  const trimmed = setting?.trim();
  return trimmed ? normalizeAddress(trimmed) : localAddressOf(entries);
}

/**
 * Where "Resync local models" asks: every local address in use plus the
 * company's model server address, without duplicates. Empty = nothing to ask
 * (the page then asks for the address).
 */
export function resyncTargets(
  setting: string | null | undefined,
  entries: readonly Pick<CatalogueItem, "provider" | "baseUrl">[],
): string[] {
  const out = localAddressesInUse(entries);
  const trimmed = setting?.trim();
  if (trimmed && !out.some((address) => address.toLowerCase() === normalizeAddress(trimmed).toLowerCase())) {
    out.unshift(normalizeAddress(trimmed));
  }
  return out;
}

/** Why a local model server address cannot be used, in plain words, or null. Empty = null (not set). */
export function localAddressIssue(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Type the whole address, starting with http:// or https://, e.g. http://192.168.1.20:11434/v1.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "The address must start with http:// or https://.";
  if (url.search || url.hash || url.username || url.password) {
    return "Leave out any ?query, #part or user name and password; just the server address, e.g. http://192.168.1.20:11434/v1.";
  }
  return null;
}

/** True for localhost / 127.x / ::1: that is Paperclip's own server, rarely where the models run. */
export function isLoopbackAddress(text: string): boolean {
  try {
    const host = new URL(text.trim()).hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host.startsWith("127.") || host === "[::1]" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

/** Every distinct local model address in use, most used first. */
export function localAddressesInUse(entries: readonly Pick<CatalogueItem, "provider" | "baseUrl">[]): string[] {
  const counts = new Map<string, { address: string; n: number }>();
  for (const entry of entries) {
    if (entry.provider !== "local" || !entry.baseUrl?.trim()) continue;
    const norm = normalizeAddress(entry.baseUrl).toLowerCase();
    const found = counts.get(norm);
    if (found) found.n += 1;
    else counts.set(norm, { address: normalizeAddress(entry.baseUrl), n: 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).map((item) => item.address);
}

function paramsText(variant: KnownModelVariant): string {
  return variant.variant;
}

/** A ready-made new entry for one known way of running a size. */
export function draftFromKnown(
  family: KnownModelFamily,
  variant: KnownModelVariant,
  how:
    | { provider: "local"; tag: KnownOllamaTag; address: string | null; installed?: boolean; gpuVramGb?: number | null }
    | { provider: "openrouter"; option: KnownOpenRouterOption }
    | { provider: "huggingface"; option: KnownHuggingFaceOption },
): CreateModelDirectoryEntry {
  const common = {
    maker: family.maker,
    family: family.family,
    variant: variant.variant,
    lane: "quick" as const,
    tags: family.uncensored ? ["uncensored"] : [],
    favorite: false,
  };
  const specsBase: ModelDirectorySpecs = {
    params: paramsText(variant),
    ...(variant.contextTokens ? { contextTokens: variant.contextTokens } : {}),
    tools: variant.tools,
    vision: variant.vision,
    thinking: variant.thinking,
    ...(family.license ? { license: family.license } : {}),
  };
  const title = `${family.family} ${variant.variant}`;
  if (how.provider === "local") {
    const fit = gpuFit(variant.minVramGb, how.gpuVramGb);
    return {
      ...common,
      name: `${title} (local)`,
      provider: "local",
      model: how.tag.tag,
      baseUrl: how.address ?? null,
      availability: how.installed ? "installed" : "planned",
      specs: {
        ...specsBase,
        quant: how.tag.quant,
        sizeGb: how.tag.sizeGb,
        ...(fit ? { fitsLocalGpu: fit } : {}),
        pullCommand: `ollama pull ${how.tag.tag}`,
      },
      note: variant.note ?? null,
    };
  }
  if (how.provider === "openrouter") {
    return {
      ...common,
      name: `${title} via OpenRouter`,
      provider: "openrouter",
      model: how.option.id,
      baseUrl: null,
      // No host is picked for the company: the setup's host table and the
      // company's OpenRouter host rules decide (and tool requests only ever
      // go to a host that supports tools).
      providerRouting: null,
      availability: "cloud",
      specs: { ...specsBase, ...(how.option.contextTokens ? { contextTokens: how.option.contextTokens } : {}) },
      note: variant.note ?? null,
    };
  }
  return {
    ...common,
    name: `${title} on Hugging Face`,
    provider: "huggingface",
    model: how.option.model,
    baseUrl: null,
    availability: "cloud",
    specs: specsBase,
    note: how.option.note ?? variant.note ?? null,
  };
}

/** A new entry for an installed Ollama model with no saved entry yet. */
export function draftFromInstalled(
  installed: Pick<LocalInstalledModel, "name" | "sizeGb" | "parameterSize" | "quantization">,
  address: string,
  options: { known?: readonly KnownModelFamily[]; gpuVramGb?: number | null } = {},
): CreateModelDirectoryEntry {
  const match = findKnownMatch("local", installed.name, options.known ?? KNOWN_MODEL_FAMILIES);
  if (match?.ollamaTag) {
    const draft = draftFromKnown(match.family, match.variant, {
      provider: "local",
      tag: match.ollamaTag,
      address,
      installed: true,
      gpuVramGb: options.gpuVramGb,
    });
    // Keep the exact tag Ollama reports ("llama3.2:latest"), so resync matches it.
    return {
      ...draft,
      model: installed.name,
      specs: {
        ...draft.specs,
        ...(installed.quantization ? { quant: installed.quantization } : {}),
        ...(typeof installed.sizeGb === "number" ? { sizeGb: installed.sizeGb } : {}),
      },
    };
  }
  const specs: ModelDirectorySpecs = {};
  if (installed.parameterSize) specs.params = installed.parameterSize;
  if (installed.quantization) specs.quant = installed.quantization;
  if (typeof installed.sizeGb === "number") specs.sizeGb = installed.sizeGb;
  return {
    name: `${installed.name} (local)`,
    provider: "local",
    model: installed.name,
    baseUrl: address,
    availability: "installed",
    lane: "quick",
    variant: installed.parameterSize ?? null,
    tags: [],
    favorite: false,
    specs: Object.keys(specs).length > 0 ? specs : null,
  };
}

function sameKnownLabel(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (text: string | null | undefined) => (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return norm(a) !== "" && norm(a) === norm(b);
}

function savedRuns<T extends CatalogueItem>(entries: readonly T[]) {
  const localTags = new Set(entries.filter((e) => e.provider === "local").map((e) => normalizeOllamaTag(e.model)));
  const routerIds = new Set(entries.filter((e) => e.provider === "openrouter").map((e) => idStem(e.model)));
  const hfIds = new Set(entries.filter((e) => e.provider === "huggingface").map((e) => e.model.trim().toLowerCase()));
  return {
    hasLocal: (tag: KnownOllamaTag) => tagNames(tag).some((name) => localTags.has(name)),
    hasRouter: (option: KnownOpenRouterOption) => routerIds.has(idStem(option.id)),
    hasHf: (option: KnownHuggingFaceOption) => hfIds.has(option.model.trim().toLowerCase()),
  };
}

function knownOptionsFor(
  family: KnownModelFamily,
  variant: KnownModelVariant,
  opts: ModelTreeOptions & { localAddress: string | null },
): KnownRunOption[] {
  const allowed = new Set(opts.knownProviders ?? ["local", "openrouter", "huggingface"]);
  const out: KnownRunOption[] = [];
  if (allowed.has("local")) {
    for (const tag of variant.ollama) {
      const installed = tagNames(tag).some((name) => opts.installedTags?.has(name));
      out.push({
        key: `local-${tag.tag}`,
        provider: "local",
        model: tag.tag,
        label: `Local · ${tag.tag} (${tag.quant}, ${roundOne(tag.sizeGb)} GB)`,
        pullCommand: `ollama pull ${tag.tag}`,
        ...(opts.localAddress ? {} : { needsAddress: true }),
        draft: draftFromKnown(family, variant, {
          provider: "local",
          tag,
          address: opts.localAddress,
          installed,
          gpuVramGb: opts.gpuVramGb,
        }),
      });
    }
  }
  if (allowed.has("openrouter")) {
    for (const option of variant.openrouter) {
      out.push({
        key: `openrouter-${option.id}`,
        provider: "openrouter",
        model: option.id,
        label: `OpenRouter · ${option.toolHosts.length > 0 ? `tools on ${option.toolHosts.join(", ")}` : "no host with tool calling"}`,
        hosts: [...option.toolHosts],
        draft: draftFromKnown(family, variant, { provider: "openrouter", option }),
      });
    }
  }
  if (allowed.has("huggingface")) {
    for (const option of variant.huggingface) {
      const host = option.model.includes(":") ? option.model.split(":").slice(1).join(":") : "";
      out.push({
        key: `huggingface-${option.model}`,
        provider: "huggingface",
        model: option.model,
        label: host ? `Hugging Face · ${host}` : "Hugging Face",
        draft: draftFromKnown(family, variant, { provider: "huggingface", option }),
      });
    }
  }
  return out;
}

/**
 * Bigger sizes of the same family and of the family it derives from, that fit
 * the graphics card or have OpenRouter hosts with tool calling. Same rule as
 * the shared upgradeOptions(), but against the list passed in (so it can be
 * tested) and offering both ways when both apply.
 */
export function upgradesFor<T extends CatalogueItem>(
  family: KnownModelFamily,
  variant: KnownModelVariant,
  allSaved: readonly T[],
  opts: ModelTreeOptions & { localAddress: string | null },
): UpgradeOption[] {
  const known = opts.known ?? KNOWN_MODEL_FAMILIES;
  const parent = family.derivedFrom ? known.find((candidate) => candidate.id === family.derivedFrom) : undefined;
  const relatives = parent && parent.id !== family.id ? [family, parent] : [family];
  const out: UpgradeOption[] = [];
  for (const relative of relatives) {
    for (const bigger of relative.variants) {
      if (bigger.paramsB <= variant.paramsB) continue;
      const fit = gpuFit(bigger.minVramGb, opts.gpuVramGb);
      const tag = fit === "yes" || fit === "tight" ? bigger.ollama[0] : undefined;
      const router = bigger.openrouter.find((option) => option.toolHosts.length > 0);
      if (!tag && !router) continue;
      const saved = allSaved.some((entry) => {
        const match = findKnownMatch(entry.provider, entry.model, known);
        return match?.family.id === relative.id && match.variant.variant === bigger.variant;
      });
      out.push({
        key: `${relative.id}-${bigger.variant}`,
        family: relative.family,
        variant: bigger.variant,
        paramsB: bigger.paramsB,
        fit,
        local: tag
          ? {
              key: `local-${tag.tag}`,
              provider: "local",
              model: tag.tag,
              label: `Local · ${tag.tag}`,
              pullCommand: `ollama pull ${tag.tag}`,
              ...(opts.localAddress ? {} : { needsAddress: true }),
              draft: draftFromKnown(relative, bigger, {
                provider: "local",
                tag,
                address: opts.localAddress,
                gpuVramGb: opts.gpuVramGb,
              }),
            }
          : null,
        openrouter: router
          ? {
              key: `openrouter-${router.id}`,
              provider: "openrouter",
              model: router.id,
              label: `OpenRouter · tools on ${router.toolHosts.join(", ")}`,
              hosts: [...router.toolHosts],
              draft: draftFromKnown(relative, bigger, { provider: "openrouter", option: router }),
            }
          : null,
        saved,
      });
    }
  }
  return out.sort((a, b) => a.paramsB - b.paramsB || collator.compare(a.family, b.family));
}

/**
 * "Too big for the graphics card (needs ~20 GB, this company's has 12 GB) - run it on OpenRouter (hosts with tool calling when last checked: deepinfra, together)",
 * or null (it fits, or the graphics card memory is not set).
 */
export function tooBigAdvice(variant: KnownModelVariant, gpuVramGb: number | null | undefined): string | null {
  if (gpuFit(variant.minVramGb, gpuVramGb) !== "no") return null;
  const head =
    gpuVramGb === 0
      ? `Needs a graphics card with ~${roundOne(variant.minVramGb!)} GB; this company's computer has none (on the processor alone it runs very slowly)`
      : `Too big for the graphics card (needs ~${roundOne(variant.minVramGb!)} GB, this company's has ${roundOne(gpuVramGb!)} GB)`;
  const hosts = [...new Set(variant.openrouter.flatMap((option) => option.toolHosts))];
  if (hosts.length > 0) return `${head} - run it on OpenRouter (hosts with tool calling when last checked: ${hosts.join(", ")})`;
  if (variant.openrouter.length > 0) return `${head} - OpenRouter has it, but no host there is known to support tool calling`;
  return `${head} - no cloud version is known`;
}

function variantSortKey(node: { known: KnownModelVariant | null; title: string }): number {
  if (node.known) return node.known.paramsB;
  const parsed = /([\d.]+)\s*b/i.exec(node.title);
  return parsed ? Number(parsed[1]) : Number.POSITIVE_INFINITY;
}

function bestScore<T extends CatalogueItem>(entries: readonly T[], criterion?: string | null): number {
  return entries.reduce((best, entry) => Math.max(best, sortScore(entry, criterion) ?? -1), -1);
}

/**
 * The three-level tree the Settings > Models page shows: Maker -> Model family
 * -> Size -> ways to run it. Saved entries go where their maker / family /
 * size (or the known list) says. For each family with at least one saved
 * entry, the other known sizes and the known ways of running each size are
 * added (as "Add" options) unless includeKnown is false.
 */
export function buildModelTree<T extends CatalogueItem>(entries: readonly T[], options: ModelTreeOptions = {}): MakerNode<T>[] {
  const known = options.known ?? KNOWN_MODEL_FAMILIES;
  const includeKnown = options.includeKnown ?? true;
  const localAddress = options.localAddress ?? localAddressOf(entries);
  const sort = options.sort ?? "name";
  const compare = compareEntriesBy(sort, options.criterion);
  const opts = { ...options, known, localAddress };

  type Raw = { maker: string | null; family: string | null; variant: string | null; match: KnownMatch | null; entry: T };
  const rows: Raw[] = entries.map((entry) => ({ ...entryIdentity(entry, known), entry }));

  // Maker buckets (case-insensitive, first spelling wins).
  const makerOrder: string[] = [];
  const makerMap = new Map<string, { title: string; rows: Raw[] }>();
  for (const row of rows) {
    const norm = row.maker?.toLowerCase() ?? "";
    let bucketRow = makerMap.get(norm);
    if (!bucketRow) {
      bucketRow = { title: row.maker ?? OTHER_MAKER_TITLE, rows: [] };
      makerMap.set(norm, bucketRow);
      makerOrder.push(norm);
    }
    bucketRow.rows.push(row);
  }

  const usedMakerKeys = new Set<string>();
  const makers: MakerNode<T>[] = [...makerMap.entries()].map(([norm, maker]) => {
    const makerKey = uniqueKey(usedMakerKeys, norm ? `maker-${slug(norm)}` : "maker-other");
    const familyMap = new Map<string, { title: string | null; rows: Raw[] }>();
    for (const row of maker.rows) {
      const fnorm = row.family?.toLowerCase() ?? "";
      const found = familyMap.get(fnorm);
      if (found) found.rows.push(row);
      else familyMap.set(fnorm, { title: row.family, rows: [row] });
    }
    const usedFamilyKeys = new Set<string>();
    const families: FamilyNode<T>[] = [...familyMap.entries()].map(([fnorm, fam]) => {
      const familyKey = uniqueKey(usedFamilyKeys, `${makerKey}-${fnorm ? slug(fnorm) : "none"}`);
      const knownFamily =
        fam.rows.find((row) => row.match && sameKnownLabel(row.match.family.family, fam.title))?.match?.family ??
        known.find((candidate) => sameKnownLabel(candidate.family, fam.title)) ??
        null;

      // Size buckets.
      const variantMap = new Map<string, { title: string; known: KnownModelVariant | null; rows: Raw[] }>();
      const knownVariantOf = (row: Raw): KnownModelVariant | null => {
        if (!knownFamily) return null;
        if (row.match && row.match.family.id === knownFamily.id && (!row.variant || sameKnownLabel(row.variant, row.match.variant.variant))) {
          return row.match.variant;
        }
        return knownFamily.variants.find((candidate) => sameKnownLabel(candidate.variant, row.variant)) ?? null;
      };
      for (const row of fam.rows) {
        const kv = knownVariantOf(row);
        const title = row.variant ?? kv?.variant ?? UNSPECIFIED_VARIANT;
        const vnorm = title.toLowerCase();
        const found = variantMap.get(vnorm);
        if (found) {
          found.rows.push(row);
          found.known ??= kv;
        } else variantMap.set(vnorm, { title, known: kv, rows: [row] });
      }
      if (includeKnown && knownFamily) {
        for (const variant of knownFamily.variants) {
          const vnorm = variant.variant.toLowerCase();
          if (!variantMap.has(vnorm)) variantMap.set(vnorm, { title: variant.variant, known: variant, rows: [] });
        }
      }

      const usedVariantKeys = new Set<string>();
      let variants: VariantNode<T>[] = [...variantMap.entries()].map(([vnorm, v]) => {
        const vEntries = v.rows.map((row) => row.entry).sort(compare);
        const runs = savedRuns(vEntries);
        const knownOptions =
          includeKnown && knownFamily && v.known
            ? knownOptionsFor(knownFamily, v.known, opts).filter((option) =>
                option.provider === "local"
                  ? !v.known!.ollama.some((tag) => tag.tag === option.model && runs.hasLocal(tag))
                  : option.provider === "openrouter"
                    ? !v.known!.openrouter.some((o) => o.id === option.model && runs.hasRouter(o))
                    : !v.known!.huggingface.some((o) => o.model === option.model && runs.hasHf(o)),
              )
            : [];
        const installedLocally = vEntries.some(
          (entry) => entry.provider === "local" && entry.availability === "installed" && !entry.archivedAt,
        );
        const fit = v.known ? gpuFit(v.known.minVramGb, options.gpuVramGb) : null;
        const firstTag = v.known?.ollama[0];
        return {
          key: uniqueKey(usedVariantKeys, `${familyKey}-${slug(vnorm)}`),
          title: v.title,
          known: v.known,
          entries: vEntries,
          knownOptions,
          fit,
          installedLocally,
          pullCommand: !installedLocally && firstTag && fit !== "no" ? `ollama pull ${firstTag.tag}` : null,
          tooBigAdvice: v.known ? tooBigAdvice(v.known, options.gpuVramGb) : null,
          upgrades:
            includeKnown && knownFamily && v.known && vEntries.length > 0
              ? upgradesFor(knownFamily, v.known, entries, opts)
              : [],
        };
      });
      variants = variants.sort((a, b) => {
        if (sort === "rating") {
          const diff = bestScore(b.entries, options.criterion) - bestScore(a.entries, options.criterion);
          if (diff !== 0) return diff;
        }
        const unspecified = Number(a.title === UNSPECIFIED_VARIANT) - Number(b.title === UNSPECIFIED_VARIANT);
        if (unspecified !== 0) return unspecified;
        return variantSortKey(a) - variantSortKey(b) || collator.compare(a.title, b.title);
      });
      const familyEntries = variants.flatMap((variant) => variant.entries);
      return {
        key: familyKey,
        title: fam.title ?? NO_FAMILY_TITLE,
        unset: !fam.title,
        known: knownFamily,
        variants,
        entries: familyEntries,
      };
    });
    families.sort((a, b) => {
      if (a.unset !== b.unset) return a.unset ? 1 : -1;
      if (sort === "rating") {
        const diff = bestScore(b.entries, options.criterion) - bestScore(a.entries, options.criterion);
        if (diff !== 0) return diff;
      }
      return collator.compare(a.title, b.title);
    });
    return {
      key: makerKey,
      title: maker.title,
      families,
      entries: families.flatMap((family) => family.entries),
    };
  });
  return makers.sort((a, b) => {
    const other = Number(a.key === "maker-other") - Number(b.key === "maker-other");
    if (other !== 0) return other;
    if (sort === "rating") {
      const diff = bestScore(b.entries, options.criterion) - bestScore(a.entries, options.criterion);
      if (diff !== 0) return diff;
    }
    return collator.compare(a.title, b.title);
  });
}

// ---------------------------------------------------------------- agent pickers

export interface PickerOption {
  id: string;
  label: string;
}
export interface PickerGroup {
  key: string;
  /** "Meta · Llama 3.2", or the maker alone, or "Other". */
  label: string;
  options: PickerOption[];
}

/** How an entry runs, for a picker: "Local (llama3.2:latest)", "OpenRouter", "Hugging Face". */
export function pickerRunLabel(entry: Pick<CatalogueItem, "provider" | "model">): string {
  if (entry.provider === "local") return `Local (${entry.model})`;
  return whereLabel(entry.provider);
}

/**
 * The option text in the agent pickers: "3B · Local (llama3.2:latest)",
 * plus " — <name>" when the saved name says something the rest does not.
 */
export function pickerOptionLabel(
  entry: CatalogueItem,
  known: readonly KnownModelFamily[] = KNOWN_MODEL_FAMILIES,
): string {
  const identity = entryIdentity(entry, known);
  const parts = [identity.variant, pickerRunLabel(entry)].filter(Boolean).join(" · ");
  const auto = [identity.family, identity.variant].filter(Boolean).join(" ");
  const name = entry.name.trim();
  const redundant = sameKnownLabel(name, auto) || sameKnownLabel(name, identity.family);
  return redundant || !name ? parts : `${parts} — ${name}`;
}

/** Saved models for a picker, grouped as "Maker · Family", each option distinguishable. */
export function pickerGroups(
  entries: readonly CatalogueItem[],
  known: readonly KnownModelFamily[] = KNOWN_MODEL_FAMILIES,
): PickerGroup[] {
  const tree = buildModelTree(entries, { known, includeKnown: false });
  const groups: PickerGroup[] = [];
  for (const maker of tree) {
    for (const family of maker.families) {
      const label = family.unset
        ? maker.key === "maker-other"
          ? OTHER_MAKER_TITLE
          : maker.title
        : maker.key === "maker-other"
          ? family.title
          : `${maker.title} · ${family.title}`;
      const options = family.entries.map((entry) => ({ id: entry.id, label: pickerOptionLabel(entry, known) }));
      // Same text twice (same size, same way to run): add the name so they differ.
      const counts = new Map<string, number>();
      for (const option of options) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
      for (const option of options) {
        const entry = family.entries.find((candidate) => candidate.id === option.id)!;
        if ((counts.get(option.label) ?? 0) > 1 && !option.label.endsWith(` — ${entry.name}`)) {
          option.label = `${option.label} — ${entry.name}`;
        }
      }
      groups.push({ key: family.key, label, options });
    }
  }
  return groups;
}

// ---------------------------------------------------------------- add dialog: model id choices and prefill

export interface ModelIdChoice {
  value: string;
  label: string;
}

/** "claude-sonnet-5" -> Claude Sonnet / 5; "claude-haiku-4-5-20251001" -> Claude Haiku / 4.5. */
export function claudeIdentity(model: string): { family: string; variant: string | null } | null {
  const match = /^claude-(haiku|sonnet|opus)(?:-(\d{1,2}))?(?:-(\d{1,2}))?(?:-\d{6,})?$/i.exec(model.trim());
  if (!match) return null;
  const tier = match[1]!.toLowerCase();
  const family = `Claude ${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
  const variant = match[2] ? (match[3] ? `${match[2]}.${match[3]}` : match[2]) : null;
  return { family, variant };
}

/**
 * The model ids the add dialog offers for a provider: the fixed list for
 * Claude / OpenAI / Google (the only ids those accept), the known OpenRouter
 * and Hugging Face ids, and for local models the tags the last resync found
 * installed, then the known Ollama tags.
 */
export function modelIdChoices(
  provider: LaneAProvider,
  options: { installedTags?: readonly string[]; known?: readonly KnownModelFamily[] } = {},
): ModelIdChoice[] {
  const known = options.known ?? KNOWN_MODEL_FAMILIES;
  const out: ModelIdChoice[] = [];
  const seen = new Set<string>();
  const push = (value: string, label: string, sameAs: readonly string[] = []) => {
    const norms = [value, ...sameAs].map((name) => (provider === "local" ? normalizeOllamaTag(name) : name.toLowerCase()));
    if (norms.some((norm) => seen.has(norm))) return;
    for (const norm of norms) seen.add(norm);
    out.push({ value, label });
  };
  const catalogue = LANE_A_PROVIDER_CATALOGUE[provider];
  for (const id of laneAModelsForProvider(provider)) {
    const pricing = catalogue.models[id];
    const claude = provider === "anthropic" ? claudeIdentity(id) : null;
    const title = claude ? [claude.family, claude.variant].filter(Boolean).join(" ") : pricing?.label ?? id;
    push(id, claude && pricing ? `${title} (${pricing.label.toLowerCase()})` : title);
  }
  if (provider === "local") {
    for (const tag of options.installedTags ?? []) push(tag, "Installed on the model server");
  }
  for (const family of known) {
    for (const variant of family.variants) {
      const title = `${family.family} ${variant.variant}`;
      if (provider === "local") {
        for (const tag of variant.ollama) {
          push(tag.tag, `${title} · ${tag.quant} · ${roundOne(tag.sizeGb)} GB`, tag.aliases ?? []);
        }
      } else if (provider === "openrouter") {
        for (const option of variant.openrouter) {
          push(option.id, option.toolHosts.length > 0 ? title : `${title} (no host with tool calling)`);
        }
      } else if (provider === "huggingface") {
        for (const option of variant.huggingface) push(option.model, title);
      }
    }
  }
  return out;
}

/** What picking a model id fills in on the add dialog. Undefined = leave the field alone. */
export interface ModelPrefill {
  name?: string;
  maker?: string;
  family?: string;
  variant?: string;
  lane?: ModelDirectoryLane;
  availability?: ModelDirectoryAvailability;
  specs?: ModelDirectorySpecs;
  providerRouting?: CreateModelDirectoryEntry["providerRouting"];
  baseUrl?: string;
  note?: string;
}

const CLOUD_MAKERS: Partial<Record<LaneAProvider, string>> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google" };

/**
 * The sensible values for a provider + model id: maker, family, size, a name,
 * facts, what it is for, whether it is ready, OpenRouter hosts with tool
 * calling, and the local address. Uses the built-in model list where it knows
 * the id.
 */
export function prefillForModel(
  provider: LaneAProvider,
  model: string,
  options: {
    installedTags?: readonly string[];
    /** The company's model server address; null/undefined = not set, so no address is filled in. */
    localAddress?: string | null;
    gpuVramGb?: number | null;
    known?: readonly KnownModelFamily[];
  } = {},
): ModelPrefill {
  const id = model.trim();
  const installed = new Set((options.installedTags ?? []).map(normalizeOllamaTag));
  const isInstalled = provider === "local" && id !== "" && installed.has(normalizeOllamaTag(id));
  const localAddress = options.localAddress?.trim() || null;
  const base: ModelPrefill =
    provider === "local"
      ? { ...(localAddress ? { baseUrl: localAddress } : {}), availability: isInstalled ? "installed" : "planned", lane: "quick" }
      : { availability: "cloud", lane: "quick" };
  if (!id) return base;

  if (provider === "anthropic") {
    const claude = claudeIdentity(id);
    const title = claude ? [claude.family, claude.variant].filter(Boolean).join(" ") : id;
    return {
      ...base,
      lane: "both",
      maker: "Anthropic",
      ...(claude ? { family: claude.family } : {}),
      ...(claude?.variant ? { variant: claude.variant } : {}),
      name: title,
      specs: { tools: "yes", vision: true, thinking: "toggle" },
      note: "Runs on Paperclip's own Claude key, so there is no key to add. An agent can still pick its own key under Connections.",
    };
  }
  if (CLOUD_MAKERS[provider]) {
    const label = LANE_A_PROVIDER_CATALOGUE[provider].models[id]?.label;
    return { ...base, maker: CLOUD_MAKERS[provider], name: label ? `${whereLabel(provider)} ${id}` : id };
  }

  const match = findKnownMatch(provider, id, options.known ?? KNOWN_MODEL_FAMILIES);
  if (match) {
    const { family, variant } = match;
    const draft =
      provider === "local"
        ? draftFromKnown(family, variant, {
            provider: "local",
            tag: match.ollamaTag!,
            address: localAddress,
            installed: isInstalled,
            gpuVramGb: options.gpuVramGb,
          })
        : provider === "openrouter"
          ? draftFromKnown(family, variant, { provider: "openrouter", option: match.openrouter! })
          : draftFromKnown(family, variant, { provider: "huggingface", option: match.huggingface! });
    return {
      ...base,
      name: draft.name,
      maker: family.maker,
      family: family.family,
      variant: variant.variant,
      specs: {
        ...draft.specs,
        // The tag typed may be another quant than the first listed; keep the exact one.
        ...(provider === "local" ? { pullCommand: `ollama pull ${id}` } : {}),
      },
      ...(provider === "openrouter" ? { providerRouting: draft.providerRouting ?? null } : {}),
    };
  }
  return {
    ...base,
    name: provider === "local" ? `${id} (local)` : `${id} via ${whereLabel(provider)}`,
    ...(provider === "local" ? { specs: { pullCommand: `ollama pull ${id}` } } : {}),
  };
}
