/**
 * Plain-language groups for the agent's Skills tab ("Research and writing",
 * "Web and browser", ...). Company skills carry free-form `categories` tags
 * (often empty) plus a slug, a name and a description; this file decides which
 * single group each skill belongs to.
 *
 * Matching is data-driven: every group lists the tags and words that point to
 * it. A skill is placed in three steps, stopping at the first step that finds
 * something:
 *
 *   1. its tags (a tag counts when it equals one of a group's tags or words),
 *   2. its slug and name,
 *   3. its description.
 *
 * Within a step the group with the most distinct hits wins; a tie goes to the
 * group listed first. Words match whole words (a trailing "s"/"es" plural is
 * allowed), so "para" never matches "parallel". Nothing found -> "Other".
 */

export type SkillGroupId =
  | "paperclip-work"
  | "research-writing"
  | "design-review"
  | "coding"
  | "web-browser"
  | "memory-notes"
  | "setup-admin"
  | "other";

export interface SkillGroupDefinition {
  id: SkillGroupId;
  label: string;
  /** Tag values that point to this group (compared after normalising). */
  tags: readonly string[];
  /** Words or short phrases looked for in the tags, slug, name and description. */
  keywords: readonly string[];
}

export const OTHER_SKILL_GROUP: SkillGroupDefinition = {
  id: "other",
  label: "Other",
  tags: [],
  keywords: [],
};

/** Display order of the groups; "Other" is always last. */
export const SKILL_GROUPS: readonly SkillGroupDefinition[] = [
  {
    id: "paperclip-work",
    label: "Paperclip work and planning",
    tags: ["paperclip-operations", "issues", "inbox", "delegation", "governance", "approvals"],
    keywords: [
      "paperclip",
      "task planning",
      "planning",
      "triage",
      "board",
      "create agent",
      "plans to tasks",
      "delegation",
      "hiring",
    ],
  },
  {
    id: "research-writing",
    label: "Research and writing",
    tags: ["release-notes", "communication", "content", "copywriting", "release"],
    keywords: [
      "research",
      "doc",
      "docs",
      "documentation",
      "release notes",
      "release announcement",
      "announcement",
      "changelog",
      "writing",
      "blog",
      "report",
    ],
  },
  {
    id: "design-review",
    label: "Design and review",
    tags: ["product", "prototyping", "svg"],
    keywords: [
      "design",
      "design critique",
      "critique",
      "wireframe",
      "ux",
      "ui",
      "prototype",
      "mockup",
      "accessibility",
    ],
  },
  {
    id: "coding",
    label: "Coding practice",
    tags: ["software-development", "engineering", "quality"],
    keywords: [
      "coding",
      "code",
      "code review",
      "review",
      "guidelines",
      "karpathy",
      "refactor",
      "refactoring",
      "lean",
      "github",
      "pull request",
      "testing",
      "qa",
      "debugging",
    ],
  },
  {
    id: "web-browser",
    label: "Web and browser",
    tags: ["puppeteer", "playwright", "seo"],
    keywords: [
      "browser",
      "browser automation",
      "web",
      "website",
      "link",
      "link checker",
      "crawl",
      "crawler",
      "crawling",
      "scrape",
      "scraping",
      "puppeteer",
      "playwright",
    ],
  },
  {
    id: "memory-notes",
    label: "Memory and notes",
    tags: [],
    keywords: ["memory", "note", "notes", "para", "knowledge", "wiki", "journal", "recall"],
  },
  {
    id: "setup-admin",
    label: "Setup and admin",
    tags: ["infra", "devops", "deployment"],
    keywords: [
      "setup",
      "admin",
      "adapter",
      "ollama",
      "opencode",
      "config",
      "configuration",
      "infrastructure",
      "install",
      "deploy",
      "docker",
      "local model",
    ],
  },
  OTHER_SKILL_GROUP,
];

export interface GroupableSkill {
  key?: string | null;
  slug?: string | null;
  name?: string | null;
  description?: string | null;
  categories?: readonly string[] | null;
}

/** "Release Notes", "release_notes" and "release notes" all become "release-notes". */
function normaliseTag(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Lower case, every run of non-letters/digits becomes one space. */
function normaliseWords(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledGroup {
  group: SkillGroupDefinition;
  tagSet: Set<string>;
  keywordPatterns: RegExp[];
}

const COMPILED_GROUPS: CompiledGroup[] = SKILL_GROUPS.filter((group) => group.id !== "other").map((group) => ({
  group,
  tagSet: new Set([...group.tags, ...group.keywords].map(normaliseTag).filter(Boolean)),
  keywordPatterns: group.keywords
    .map(normaliseWords)
    .filter(Boolean)
    .map((keyword) => new RegExp(`(?:^| )${escapeRegExp(keyword)}(?:s|es)?(?= |$)`)),
}));

function countKeywordHits(text: string, patterns: RegExp[]): number {
  if (!text) return 0;
  return patterns.reduce((hits, pattern) => (pattern.test(text) ? hits + 1 : hits), 0);
}

/** The group with the most hits (first listed wins a tie), or null when nothing hit. */
function bestGroup(score: (compiled: CompiledGroup) => number): SkillGroupDefinition | null {
  let best: SkillGroupDefinition | null = null;
  let bestScore = 0;
  for (const compiled of COMPILED_GROUPS) {
    const value = score(compiled);
    if (value > bestScore) {
      best = compiled.group;
      bestScore = value;
    }
  }
  return best;
}

function slugOf(skill: GroupableSkill): string {
  const slug = skill.slug?.trim();
  if (slug) return slug;
  // Company skill keys look like "owner/repo/slug": the last part is the slug.
  const key = skill.key?.trim() ?? "";
  const parts = key.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function skillGroupFor(skill: GroupableSkill): SkillGroupDefinition {
  const tags = (skill.categories ?? []).map(normaliseTag).filter(Boolean);
  if (tags.length > 0) {
    const byTags = bestGroup(({ tagSet }) => new Set(tags.filter((tag) => tagSet.has(tag))).size);
    if (byTags) return byTags;
  }

  const slugAndName = normaliseWords(`${slugOf(skill)} ${skill.name ?? ""}`);
  const byName = bestGroup(({ keywordPatterns }) => countKeywordHits(slugAndName, keywordPatterns));
  if (byName) return byName;

  const description = normaliseWords(skill.description ?? "");
  const byDescription = bestGroup(({ keywordPatterns }) => countKeywordHits(description, keywordPatterns));
  if (byDescription) return byDescription;

  return OTHER_SKILL_GROUP;
}

export interface SkillGroup<T> {
  group: SkillGroupDefinition;
  skills: T[];
  selectedCount: number;
}

function compareByName(a: GroupableSkill, b: GroupableSkill): number {
  const left = (a.name ?? a.slug ?? a.key ?? "").toLowerCase();
  const right = (b.name ?? b.slug ?? b.key ?? "").toLowerCase();
  return left.localeCompare(right);
}

/**
 * Sorts skills into the groups above, leaving out groups with no skills.
 * Inside a group the skills that are on come first, then the rest; each part
 * alphabetical by name.
 */
export function groupSkills<T extends GroupableSkill>(
  skills: readonly T[],
  isSelected: (skill: T) => boolean = () => false,
): SkillGroup<T>[] {
  const byGroup = new Map<SkillGroupId, T[]>();
  for (const skill of skills) {
    const { id } = skillGroupFor(skill);
    const list = byGroup.get(id);
    if (list) list.push(skill);
    else byGroup.set(id, [skill]);
  }

  return SKILL_GROUPS.flatMap((group) => {
    const members = byGroup.get(group.id);
    if (!members || members.length === 0) return [];
    const sorted = sortSelectedFirst(members, isSelected);
    return [{ group, skills: sorted, selectedCount: sorted.filter(isSelected).length }];
  });
}

/** Skills that are on first, then the rest; each part alphabetical by name. */
export function sortSelectedFirst<T extends GroupableSkill>(
  skills: readonly T[],
  isSelected: (skill: T) => boolean,
): T[] {
  return [...skills].sort((a, b) => {
    const selectedOrder = Number(isSelected(b)) - Number(isSelected(a));
    return selectedOrder !== 0 ? selectedOrder : compareByName(a, b);
  });
}

/** Case-insensitive search over a skill's name, slug and description. */
export function matchesSkillSearch(skill: GroupableSkill, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [skill.name, skill.slug, skill.description].some((value) =>
    (value ?? "").toLowerCase().includes(needle),
  );
}

const ABBREVIATIONS = new Set(["e.g.", "i.e.", "etc.", "vs.", "incl.", "approx.", "no."]);

/**
 * The first sentence of a description, for a short one-line preview.
 * `hasMore` says whether anything was cut off (so a "More" toggle is useful).
 * Only the first paragraph is considered; whitespace is collapsed.
 */
export function firstSentence(text: string | null | undefined): { first: string; hasMore: boolean } {
  const full = (text ?? "").replace(/\s+/g, " ").trim();
  if (!full) return { first: "", hasMore: false };

  const firstParagraph = (text ?? "").trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").trim();
  const sentenceEnd = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = sentenceEnd.exec(firstParagraph)) !== null) {
    const end = match.index + 1;
    const lastWord = (firstParagraph.slice(0, end).split(" ").pop() ?? "").toLowerCase().replace(/^[^a-z]+/, "");
    if (ABBREVIATIONS.has(lastWord)) continue;
    const first = firstParagraph.slice(0, end);
    return { first, hasMore: first.length < full.length };
  }
  return { first: firstParagraph, hasMore: firstParagraph.length < full.length };
}

/**
 * Plain text for a one-line preview: drops inline code ticks, bold/italic
 * markers and link syntax ("[docs](https://...)" -> "docs").
 */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, "$1$2");
}
