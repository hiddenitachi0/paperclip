/**
 * Automatic looks ("look rules"): a person's (or a job's) ordered list of
 * rules that pick a saved look by time of day and by keywords in the
 * person's message. Pure functions only: no state, no host calls, so the
 * worker, the looks page and the tests all use the same logic.
 *
 * A rule applies when every condition it has holds:
 *   - it has time windows: now (in the rule set's timezone) is inside one;
 *   - it has keywords: the message contains one of them as whole words.
 * A rule with neither is not allowed. The first applying rule (top of the
 * list first) wins; a rule that does not apply right now is simply skipped,
 * so a lower keyword rule can win over a higher time rule outside its hours.
 */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface LookRuleWindow {
  /** "HH:MM", 24-hour clock. */
  from: string;
  /** "HH:MM" (or "24:00" for the end of the day). Earlier than `from`: the window runs past midnight. */
  to: string;
  /** The days the window STARTS on; empty or missing: every day. */
  days?: Weekday[];
}

export interface LookRule {
  id: string;
  lookId: string;
  enabled: boolean;
  timeWindows?: LookRuleWindow[];
  keywords?: string[];
}

export interface LookRuleSet {
  timezone: string;
  rules: LookRule[];
}

export const DEFAULT_TIMEZONE = "Europe/Oslo";
export const MAX_RULES = 30;
export const MAX_WINDOWS = 6;
export const MAX_KEYWORDS = 20;
export const KEYWORD_MAX = 40;

// ─── Owners ──────────────────────────────────────────────────────────────────
// The same ownership as the memory notebook: a job with a person attached
// shares the person's rules; a job without a person has its own.

export type LookRuleOwnerKey = `persona:${string}` | `agent:${string}`;

export function ownerKeyFor(agent: { id: string; personaId?: string | null }): LookRuleOwnerKey {
  return agent.personaId ? `persona:${agent.personaId}` : `agent:${agent.id}`;
}

export function parseOwnerKey(key: unknown): { kind: "persona" | "agent"; id: string } | null {
  if (typeof key !== "string") return null;
  const match = /^(persona|agent):([A-Za-z0-9-]{1,64})$/.exec(key.trim());
  return match ? { kind: match[1] as "persona" | "agent", id: match[2]! } : null;
}

// ─── Time ────────────────────────────────────────────────────────────────────

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight for "HH:MM" ("24:00" only when `allowEndOfDay`); null when not a time. */
export function timeToMinutes(value: unknown, allowEndOfDay = false): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (allowEndOfDay && text === "24:00") return 24 * 60;
  const match = TIME_PATTERN.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || !timezone.trim() || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY_BY_SHORT: Record<string, Weekday> = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };

/** The weekday and minutes after midnight at `now` in `timezone` (daylight saving included). */
export function localClock(now: Date, timezone: string): { weekday: Weekday; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  return { weekday: WEEKDAY_BY_SHORT[get("weekday")] ?? "mon", minutes: hour * 60 + Number(get("minute")) };
}

function previousDay(day: Weekday): Weekday {
  return WEEKDAYS[(WEEKDAYS.indexOf(day) + 6) % 7]!;
}

function dayAllowed(days: Weekday[] | undefined, day: Weekday): boolean {
  return !days || days.length === 0 || days.includes(day);
}

/**
 * Is the clock inside this window? From is included, to is not ("08:00 to
 * 12:00" ends as 12:00 starts). A window whose end is before its start runs
 * past midnight; its days are the days it starts on, so a Friday 22:00-02:00
 * window still holds at 01:00 on Saturday.
 */
export function windowHolds(window: LookRuleWindow, clock: { weekday: Weekday; minutes: number }): boolean {
  const from = timeToMinutes(window.from);
  const to = timeToMinutes(window.to, true);
  if (from === null || to === null || from === to) return false;
  if (from < to) return clock.minutes >= from && clock.minutes < to && dayAllowed(window.days, clock.weekday);
  if (clock.minutes >= from) return dayAllowed(window.days, clock.weekday);
  if (clock.minutes < to) return dayAllowed(window.days, previousDay(clock.weekday));
  return false;
}

// ─── Keywords ────────────────────────────────────────────────────────────────

const WORD_CHAR = "[\\p{L}\\p{N}_]";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does the text contain the keyword as whole words (any spacing between its words), ignoring case? */
export function containsKeyword(text: string, keyword: string): boolean {
  const words = keyword.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || !text) return false;
  const core = words.map(escapeRegExp).join("\\s+");
  return new RegExp(`(?<!${WORD_CHAR})${core}(?!${WORD_CHAR})`, "iu").test(text);
}

// ─── Choosing ────────────────────────────────────────────────────────────────

export interface RuleMatch {
  rule: LookRule;
  /** The rule's position in the list, from 1. */
  position: number;
  /** The window that holds right now, when the rule has windows. */
  window: LookRuleWindow | null;
  /** The keyword found, when the rule has keywords. */
  keyword: string | null;
}

/**
 * The first enabled rule that applies. `texts` are what keywords are looked
 * for in: the person's own message first, then the picture's description.
 * `lookExists` skips a rule whose look is gone.
 */
export function firstApplicableRule(
  set: LookRuleSet | null | undefined,
  input: { now: Date; texts: Array<string | null | undefined>; lookExists?: (lookId: string) => boolean },
): RuleMatch | null {
  if (!set || set.rules.length === 0) return null;
  const clock = localClock(input.now, isValidTimezone(set.timezone) ? set.timezone : DEFAULT_TIMEZONE);
  const texts = input.texts.filter((t): t is string => typeof t === "string" && t.length > 0);
  for (const [index, rule] of set.rules.entries()) {
    if (!rule.enabled) continue;
    if (input.lookExists && !input.lookExists(rule.lookId)) continue;
    const windows = rule.timeWindows ?? [];
    const keywords = rule.keywords ?? [];
    if (windows.length === 0 && keywords.length === 0) continue;
    let window: LookRuleWindow | null = null;
    if (windows.length > 0) {
      window = windows.find((w) => windowHolds(w, clock)) ?? null;
      if (!window) continue;
    }
    let keyword: string | null = null;
    if (keywords.length > 0) {
      keyword = keywords.find((k) => texts.some((text) => containsKeyword(text, k))) ?? null;
      if (!keyword) continue;
    }
    return { rule, position: index + 1, window, keyword };
  }
  return null;
}

// ─── Plain words ─────────────────────────────────────────────────────────────

const DAY_NAME: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** "on weekdays", "at weekends", "on Mon, Wed" or "" (every day). */
export function describeDays(days: Weekday[] | undefined): string {
  const set = new Set(days ?? []);
  if (set.size === 0 || set.size === 7) return "";
  const has = (list: Weekday[]) => list.every((d) => set.has(d)) && set.size === list.length;
  if (has(["mon", "tue", "wed", "thu", "fri"])) return "on weekdays";
  if (has(["sat", "sun"])) return "at weekends";
  return `on ${WEEKDAYS.filter((d) => set.has(d)).map((d) => DAY_NAME[d]).join(", ")}`;
}

/** "08:00–12:00 on weekdays". */
export function describeWindow(window: LookRuleWindow): string {
  const days = describeDays(window.days);
  return `${window.from}–${window.to}${days ? ` ${days}` : ""}`;
}

/** Why this rule applied: "rule: 08:00–12:00 on weekdays", "rule: keyword 'work'" or both. */
export function describeMatch(match: RuleMatch): string {
  const parts: string[] = [];
  if (match.window) parts.push(describeWindow(match.window));
  if (match.keyword) parts.push(`keyword '${match.keyword}'`);
  return `rule: ${parts.join(", ")}`;
}

/** A rule's conditions in words: "from 08:00 to 12:00 on weekdays, when the message says "work"". */
export function describeRuleConditions(rule: LookRule): string {
  const parts: string[] = [];
  const windows = rule.timeWindows ?? [];
  if (windows.length > 0) {
    parts.push(windows.map((w) => `from ${w.from} to ${w.to}${describeDays(w.days) ? ` ${describeDays(w.days)}` : ""}`).join(" or "));
  }
  const keywords = rule.keywords ?? [];
  if (keywords.length > 0) {
    parts.push(`when the message says ${keywords.map((k) => `"${k}"`).join(" or ")}`);
  }
  return parts.join(", and ");
}

// ─── Reading and checking ────────────────────────────────────────────────────

/** A stored rule set, with anything malformed left out (never throws). */
export function normalizeRuleSet(raw: unknown): LookRuleSet {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const timezone = isValidTimezone(value.timezone) ? value.timezone : DEFAULT_TIMEZONE;
  const rules: LookRule[] = [];
  for (const item of Array.isArray(value.rules) ? value.rules : []) {
    try {
      rules.push(checkRule(item));
    } catch {
      // A broken stored rule is dropped rather than breaking every picture.
    }
  }
  return { timezone, rules };
}

/** The company's { ownerKey: rule set } map, malformed owners left out. */
export function normalizeRuleSets(raw: unknown): Record<string, LookRuleSet> {
  const out: Record<string, LookRuleSet> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (parseOwnerKey(key)) out[key] = normalizeRuleSet(value);
  }
  return out;
}

const RULE_ID = /^[A-Za-z0-9-]{1,64}$/;

function checkWindow(raw: unknown, position: string): LookRuleWindow {
  const w = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const from = timeToMinutes(w.from);
  const to = timeToMinutes(w.to, true);
  if (from === null || to === null) throw new Error(`${position}: times are written like 08:00 or 17:30.`);
  if (from === to) throw new Error(`${position}: the start and end time are the same.`);
  let days: Weekday[] | undefined;
  if (w.days !== undefined && w.days !== null) {
    if (!Array.isArray(w.days) || w.days.some((d) => !(WEEKDAYS as readonly unknown[]).includes(d))) {
      throw new Error(`${position}: the days could not be read. Pick them again.`);
    }
    const picked = new Set(w.days as Weekday[]);
    if (picked.size === 0) throw new Error(`${position}: pick at least one day.`);
    days = picked.size === 7 ? undefined : WEEKDAYS.filter((d) => picked.has(d));
  }
  return { from: String(w.from).trim(), to: String(w.to).trim(), ...(days ? { days } : {}) };
}

/** Check one rule from the looks page; throws a plain sentence when it cannot be saved. */
export function checkRule(raw: unknown, position = "This rule", makeId: () => string = () => crypto.randomUUID()): LookRule {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!r) throw new Error(`${position} could not be read. Reload the page.`);
  const lookId = typeof r.lookId === "string" ? r.lookId.trim() : "";
  if (!lookId) throw new Error(`${position}: pick a look.`);
  const rawWindows = r.timeWindows ?? [];
  if (!Array.isArray(rawWindows)) throw new Error(`${position}: the times could not be read. Add them again.`);
  if (rawWindows.length > MAX_WINDOWS) throw new Error(`${position}: use at most ${MAX_WINDOWS} times.`);
  const timeWindows = rawWindows.map((w, i) => checkWindow(w, rawWindows.length > 1 ? `${position}, time ${i + 1}` : position));
  const rawKeywords = r.keywords ?? [];
  if (!Array.isArray(rawKeywords)) throw new Error(`${position}: the keywords could not be read. Add them again.`);
  const keywords: string[] = [];
  for (const item of rawKeywords) {
    const keyword = typeof item === "string" ? item.trim().replace(/\s+/g, " ") : "";
    if (!keyword) continue;
    if (keyword.length > KEYWORD_MAX) throw new Error(`${position}: keep each keyword under ${KEYWORD_MAX} characters.`);
    if (!/[\p{L}\p{N}]/u.test(keyword)) throw new Error(`${position}: a keyword needs at least one letter or number.`);
    if (!keywords.some((k) => k.toLowerCase() === keyword.toLowerCase())) keywords.push(keyword);
  }
  if (keywords.length > MAX_KEYWORDS) throw new Error(`${position}: use at most ${MAX_KEYWORDS} keywords.`);
  if (timeWindows.length === 0 && keywords.length === 0) {
    throw new Error(`${position} needs a time or a keyword (or both); otherwise it would always apply. Use the default look for that.`);
  }
  const id = typeof r.id === "string" && RULE_ID.test(r.id) ? r.id : makeId();
  return {
    id,
    lookId,
    enabled: r.enabled !== false,
    ...(timeWindows.length > 0 ? { timeWindows } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
  };
}

/** Check a whole rule set from the looks page; throws a plain sentence when it cannot be saved. */
export function checkRuleSet(raw: { timezone?: unknown; rules?: unknown }, lookIds: Set<string>): LookRuleSet {
  const timezone = raw.timezone === undefined || raw.timezone === null || raw.timezone === "" ? DEFAULT_TIMEZONE : raw.timezone;
  if (!isValidTimezone(timezone)) throw new Error("Pick a time zone from the list.");
  if (!Array.isArray(raw.rules)) throw new Error("The rules could not be read. Reload the page.");
  if (raw.rules.length > MAX_RULES) throw new Error(`Keep it to ${MAX_RULES} rules or fewer.`);
  const rules: LookRule[] = [];
  const seen = new Set<string>();
  raw.rules.forEach((item, i) => {
    const rule = checkRule(item, `Rule ${i + 1}`);
    if (!lookIds.has(rule.lookId)) throw new Error(`Rule ${i + 1}: that look no longer exists. Reload the page.`);
    if (seen.has(rule.id)) rule.id = crypto.randomUUID();
    seen.add(rule.id);
    rules.push(rule);
  });
  return { timezone, rules };
}

/** The rule sets with every rule that points at a deleted look taken out. */
export function withoutLook(sets: Record<string, LookRuleSet>, lookId: string): { sets: Record<string, LookRuleSet>; changed: boolean } {
  let changed = false;
  const out: Record<string, LookRuleSet> = {};
  for (const [key, set] of Object.entries(sets)) {
    const rules = set.rules.filter((rule) => rule.lookId !== lookId);
    if (rules.length !== set.rules.length) changed = true;
    out[key] = { ...set, rules };
  }
  return { sets: out, changed };
}
