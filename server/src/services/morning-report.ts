import { and, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyMemberships,
  laneAConversations,
  laneAMessages,
  morningReportOutbox,
  runInPooledScope,
  watcherPricePoints,
  watchers,
} from "@paperclipai/db";
import {
  MORNING_REPORT_DEFAULT_PLACES,
  MORNING_REPORT_RSS_FEEDS,
  parseMorningReportSettings,
  resolveMorningReportPictureSource,
  WATCHER_SOURCE_INFO,
  type MorningReportFacts,
  type MorningReportFactItem,
  type MorningReportHobbyTopic,
  type MorningReportImageFact,
  type MorningReportOutboxItem,
  type MorningReportOutboxStatus,
  type MorningReportPictureSource,
  type MorningReportPriceFact,
  type MorningReportPricePoint,
  type MorningReportPriceSymbol,
  type MorningReportSettings,
  type MorningReportSource,
  type MorningReportSportFollow,
  type MorningReportTopic,
  type MorningReportWeatherFact,
  type WatcherSource,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { formatWeatherReport } from "./lane-a-tools.js";
import { laneAService } from "./lane-a.js";
import { secretService } from "./secrets.js";
import { webSearchService, type WebSearchServiceDeps } from "./web-search.js";
import { WATCHER_PRICE_SOURCES, isWatcherQuoteError } from "./watcher-sources.js";

/**
 * Morning report: a daily briefing a quick agent sends to its operator's
 * Telegram chat at a configured local time.
 *
 * How a report is generated (tick, from the server's scheduler loop in
 * index.ts, its own single-flight chain like watchers):
 *   1. Every enabled agent whose lease is free is a candidate. Whether it is
 *      actually DUE is decided in code, not SQL: `settings.time` is compared
 *      against the current wall-clock time *in the agent's own timezone*
 *      (Intl.DateTimeFormat resolves the DST offset for us, so 07:00 Europe/
 *      Oslo means the same real moment whether Oslo is on CEST or CET that
 *      day). A due agent is claimed with a conditional UPDATE of
 *      morning_report_lease_until (mirrors watchers.check_lease_until), so a
 *      report is never generated twice by two overlapping ticks.
 *   2. Composing is detached onto the pool (runInPooledScope), so a slow
 *      source fetch or model call never holds the tick's own connection.
 *   3. Weather, headlines, hobby news, sport and prices are fetched in code.
 *      Everything collected becomes ONE quick-agent model call (Lane A
 *      transform) that writes the English report; a source that fails, or an
 *      agent that cannot write it, degrades to the plain facts with a note
 *      instead of losing the day's report.
 *   4. The result is written to morning_report_outbox as 'ready', and
 *      morning_report_last_sent_date is set to today (the agent's local
 *      date), so the same local day never fires twice even if the lease is
 *      somehow already clear again.
 *
 * How it reaches Telegram: the host-side Telegram bridge polls the outbox
 * (ready reports, per company) via the CLI, sends each through the agent's
 * bot, and acknowledges it — the same path watcher_alerts uses.
 */

type AgentRow = typeof agents.$inferSelect;

export const MORNING_REPORT_TICK_BATCH = 200;
export const MORNING_REPORT_LEASE_MS = 10 * 60_000;
/** A ready report nobody picked up in this long is not sent any more (yesterday's news by then). */
export const MORNING_REPORT_OUTBOX_MAX_AGE_MS = 24 * 3_600_000;
const HTTP_TIMEOUT_MS = 8_000;
const OUTBOX_BATCH = 20;
const HOBBY_MAX_AGE_HOURS = 24 * 7;
const SEARCH_RESULTS_PER_SOURCE = 5;
/** How many of a price's most recent watcher readings become its sparkline history (DUR-4059). */
const PRICE_HISTORY_POINTS = 7;

/**
 * Realistic cap for the one model call a report still costs (DUR-4059
 * review): a numbered JSON list of short per-headline summaries plus a short
 * opening genuinely needs more room than the old whole-report call did, so
 * this is deliberately larger than a short answer would need — a smaller cap
 * was exactly what caused the old call to cut off mid-list. Expressed as the
 * chars-equivalent lane-a.ts's transform() takes (see resolveTransformMaxTokens).
 */
const MORNING_REPORT_SUMMARY_MAX_OUTPUT_TOKENS = 3_000;
const MAX_OUTPUT_CHARS_FOR_SUMMARIES = MORNING_REPORT_SUMMARY_MAX_OUTPUT_TOKENS * 4;

/**
 * Instructions for the one model call a report still costs (DUR-4059
 * direction change; DUR-4133 added "mood"; DUR-4138 added "themeKeywords"):
 * the model writes ONLY a short opening, a short mood description, 2-4 theme
 * keywords, and one-sentence summaries for the given headlines, as strict
 * JSON, never the report itself. Every list in the report (weather,
 * headlines, hobby, sport, prices) is rendered by code from the facts, so
 * nothing Filip needs depends on this call succeeding, finishing, or being
 * trusted with formatting/links. "mood" and "themeKeywords" are plain,
 * model-written descriptions (never a quoted headline title): they become
 * the mood picture's prompt, so a quoted headline here is exactly the
 * garbled-text bug DUR-4133 fixed.
 */
export const MORNING_REPORT_SUMMARY_TASK =
  "You write four short things for a daily morning briefing, using only the facts given below: do not invent, round " +
  'differently, or add any number, headline or fact not present below. Answer with ONLY one JSON object, no markdown, ' +
  'no code fences, no commentary, matching exactly this shape: {"opening": "a friendly 3-5 sentence opening for the day, ' +
  'plain text only, mentioning the weather and the most notable news in your own words", "mood": "the overall mood of ' +
  "today's news in at most 8 plain words (for example 'tense but hopeful'), your own description, never a quoted " +
  'headline or title", "themeKeywords": ["2 to 4 short plain words or short phrases capturing today\'s news themes, ' +
  'your own words, never a quoted headline or title (for example [\\"war\\", \\"elections\\"])"], "headlines": [{"n": 1, ' +
  '"summary": "one plain-text sentence summarizing headline 1, using only its title"}, ...one entry per numbered headline ' +
  "given below] }. Plain text only in every string: never HTML, never markdown links, never a URL.";

/** DUR-4138: a stricter retry when the first answer did not parse as JSON — the same task, said more forcefully. The model has no memory of the first answer (each transform() call is stateless), so this cannot literally say "try again"; it just states the constraint harder. */
export const MORNING_REPORT_SUMMARY_TASK_STRICT =
  `${MORNING_REPORT_SUMMARY_TASK} Your answer must be ONLY the JSON object itself: the very first character must be "{" ` +
  'and the very last character must be "}". Nothing else: no prose before or after it, no markdown, no code fences, no ' +
  "explanation of what you are doing.";

export interface MorningReportServiceDeps extends WebSearchServiceDeps {
  now?: () => Date;
  fetchImpl?: typeof fetch;
  laneA?: {
    transform: ReturnType<typeof laneAService>["transform"];
    makePicture: ReturnType<typeof laneAService>["makePicture"];
  };
  webSearch?: { search: ReturnType<typeof webSearchService>["search"] };
  secrets?: { resolveStockDataKey: ReturnType<typeof secretService>["resolveStockDataKey"] };
  /** Test seam: how a claimed report is handed off. Production detaches it onto the pool. */
  dispatch?: (work: () => Promise<void>) => void;
  /**
   * Whether the full briefing page (DUR-4075) is live yet. Defaults to the
   * PAPERCLIP_MORNING_REPORT_BRIEFING_PAGE_ENABLED env var so the link is
   * switched off everywhere until that page ships, without a code change
   * here. A report written while this is false never carries the link, even
   * after it flips true — see MorningReportFacts.briefingPageLive.
   */
  briefingPageLive?: boolean;
}

// ─── Local time, DST-safe ──────────────────────────────────────────────────

/** "HH:MM" and "YYYY-MM-DD" for `date` as seen in `timeZone`, whatever the current UTC offset is. */
export function localDateTimeParts(date: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // Some ICU builds render midnight as "24:00" under hour12:false.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${hour}:${get("minute")}` };
}

/** Whether `settings` should fire right now, and if so, the agent-local date it fires for. */
export function dueMorningReport(
  settings: MorningReportSettings,
  now: Date,
  lastSentDate: string | null,
): { due: false } | { due: true; localDate: string } {
  if (!settings.enabled) return { due: false };
  const { date, time } = localDateTimeParts(now, settings.timezone);
  if (time !== settings.time) return { due: false };
  if (lastSentDate === date) return { due: false };
  return { due: true, localDate: date };
}

/** The place override alone when set (and not expired), otherwise both default places (DUR-4059). */
function resolvePlaces(settings: MorningReportSettings, localDate: string): string[] {
  if (!settings.placeOverride) return [...MORNING_REPORT_DEFAULT_PLACES];
  if (settings.placeOverrideUntil && settings.placeOverrideUntil < localDate) return [...MORNING_REPORT_DEFAULT_PLACES];
  return [settings.placeOverride];
}

// ─── RSS (minimal, dependency-free) ────────────────────────────────────────

export interface RssItem {
  title: string;
  url: string;
  pubDate: string | null;
}

function stripCdata(raw: string): string {
  const match = raw.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return (match ? match[1]! : raw).trim();
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function firstTagContent(block: string, tags: string[]): string | null {
  for (const tag of tags) {
    const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    if (match) return decodeXmlEntities(stripCdata(match[1]!));
  }
  return null;
}

/** RSS 2.0 `<item>` or Atom `<entry>` blocks, whichever the feed uses. Exported for tests. */
export function parseRssItems(xml: string, limit = 30): RssItem[] {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  const items: RssItem[] = [];
  for (const block of blocks) {
    if (items.length >= limit) break;
    const title = firstTagContent(block, ["title"]);
    if (!title) continue;
    let url = firstTagContent(block, ["link"]);
    if (!url) {
      const hrefMatch = block.match(/<link[^>]*href="([^"]+)"/i);
      url = hrefMatch ? decodeXmlEntities(hrefMatch[1]!) : "";
    }
    const pubDate = firstTagContent(block, ["pubDate", "published", "updated"]);
    items.push({ title, url: url ?? "", pubDate });
  }
  return items;
}

/** Same headline from two sources (or the same source twice) collapses to one. Exported for tests. */
export function dedupeHeadlines<T extends { title: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

const TOPIC_KEYWORDS: Record<MorningReportTopic, string[]> = {
  crypto: ["crypto", "bitcoin", "btc", "ethereum", "eth", "blockchain", "token", "coin", "defi"],
  ai: ["ai", "artificial intelligence", "chatgpt", "llm", "openai", "anthropic", "claude", "gemini", "machine learning", "chatbot"],
  tech: ["tech", "software", " app ", "device", "gadget", "chip", "startup", "computer", "smartphone", "gaming"],
  geopolitics: ["market", "election", "war", "trade", "tariff", "economy", "president", "government", "sanction", "inflation"],
};

/** Exported for tests. Empty `topics` means "no filter", not "nothing matches". */
export function matchesMorningReportTopics(title: string, topics: MorningReportTopic[]): boolean {
  if (topics.length === 0) return true;
  const lower = ` ${title.toLowerCase()} `;
  return topics.some((topic) => TOPIC_KEYWORDS[topic].some((kw) => lower.includes(kw)));
}

const NEW_RELEASE_KEYWORDS = [
  "release",
  "released",
  "releases",
  "launch",
  "launches",
  "launched",
  "out now",
  "available now",
  "drops",
  "debut",
  "debuts",
  "arrives",
];
const SPECULATION_KEYWORDS = [
  "rumor",
  "rumour",
  "leak",
  "leaked",
  "leaks",
  "speculat",
  "could",
  "might",
  "possibly",
  "teaser",
  "teases",
  "hints",
  "concept",
];

/** New-release only, no rumours/speculation — Zelda Dungeon posts a lot of the latter. Exported for tests. */
export function looksLikeNewRelease(title: string): boolean {
  const lower = title.toLowerCase();
  if (SPECULATION_KEYWORDS.some((kw) => lower.includes(kw))) return false;
  return NEW_RELEASE_KEYWORDS.some((kw) => lower.includes(kw));
}

function isRecent(pubDate: string | null, now: Date, maxAgeHours: number): boolean {
  if (!pubDate) return true;
  const parsed = new Date(pubDate);
  if (Number.isNaN(parsed.getTime())) return true;
  return now.getTime() - parsed.getTime() <= maxAgeHours * 3_600_000;
}

// ─── Fetching each section ─────────────────────────────────────────────────

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  return response.json();
}

/**
 * DUR-4138: a plain, normal-browser User-Agent and Accept header — some feeds
 * (pcmag, zelda_dungeon) refuse a bare `fetch` User-Agent with a 403 (a
 * Cloudflare bot challenge, verified live: even this header does not clear
 * it, so collectHeadlines falls back to web search for those two instead of
 * retrying here).
 */
const RSS_FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchRss(fetchImpl: typeof fetch, url: string, limit: number): Promise<RssItem[]> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.1",
      "user-agent": RSS_FETCH_USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  return parseRssItems(await response.text(), limit);
}

/** One place's weather: the formatted block (for the facts) and a short "place: conditions" line (for the picture prompt). */
async function fetchOnePlaceWeather(
  fetchImpl: typeof fetch,
  place: string,
): Promise<{ place: string; block: string; condition: string } | { note: string }> {
  try {
    const geo = (await fetchJson(
      fetchImpl,
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`,
    )) as { results?: Array<{ name: string; latitude: number; longitude: number; country?: string; admin1?: string }> };
    const found = geo.results?.[0];
    if (!found) return { note: `Weather: could not find a place called "${place}".` };
    const forecast = await fetchJson(
      fetchImpl,
      `https://api.open-meteo.com/v1/forecast?latitude=${found.latitude}&longitude=${found.longitude}` +
        `&current=temperature_2m,wind_speed_10m,precipitation,weather_code` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code&forecast_days=3&timezone=auto`,
    );
    const block = formatWeatherReport(found, forecast);
    // formatWeatherReport's first line always reads "Now in <where>: <conditions>" — reworded to
    // "<place>: <conditions>" so two places read as a short list in the picture prompt.
    const firstLine = block.split("\n")[0] ?? block;
    const condition = firstLine.replace(/^Now in [^:]+:\s*/, `${place}: `);
    return { place, block, condition };
  } catch (err) {
    return { note: `Weather (${place}): the forecast service did not answer (${err instanceof Error ? err.message : "unknown reason"}).` };
  }
}

/** Every configured place's weather (DUR-4059: Drøbak and Oslo by default, or just the one override place), one fact per place plus a short summary for the weather picture prompt. A place that fails degrades to a note, never losing the others. */
async function fetchWeatherSection(
  fetchImpl: typeof fetch,
  places: string[],
): Promise<{ items: MorningReportWeatherFact[]; conditionsSummary: string | null; notes: string[] }> {
  const results = await Promise.all(places.map((place) => fetchOnePlaceWeather(fetchImpl, place)));
  const items: MorningReportWeatherFact[] = [];
  const conditions: string[] = [];
  const notes: string[] = [];
  for (const result of results) {
    if ("note" in result) notes.push(result.note);
    else {
      items.push({ place: result.place, text: result.block });
      conditions.push(result.condition);
    }
  }
  return {
    items,
    conditionsSummary: conditions.length > 0 ? conditions.join("; ") : null,
    notes,
  };
}

type BraveSearch = (query: string) => Promise<{ title: string; url: string }[]>;

/** DUR-4138: "no more than 3-4 headlines from one source when others have items" — the cap on any single source while at least one other source still has unused items. */
export const MORNING_REPORT_MAX_HEADLINES_PER_SOURCE = 4;

/**
 * DUR-4138: round-robins deduped, on-topic items across their sources so one
 * heavy source (e.g. a source with a large, reliable feed) cannot swamp the
 * final list while other configured sources still have unused items of their
 * own — each source is capped at MORNING_REPORT_MAX_HEADLINES_PER_SOURCE
 * until every other source runs dry, at which point the cap lifts for
 * whichever source is left (filling the day's list is still the priority; a
 * thin day from one source is better than a short one).
 */
export function balanceHeadlinesAcrossSources<T extends { source: MorningReportSource }>(items: T[], maxHeadlines: number): T[] {
  const bySource = new Map<MorningReportSource, T[]>();
  for (const item of items) {
    const list = bySource.get(item.source);
    if (list) list.push(item);
    else bySource.set(item.source, [item]);
  }
  const sources = [...bySource.keys()];
  const nextIndex = new Map<MorningReportSource, number>(sources.map((s) => [s, 0]));
  const taken = new Map<MorningReportSource, number>(sources.map((s) => [s, 0]));
  const result: T[] = [];
  while (result.length < maxHeadlines) {
    let addedThisRound = false;
    for (const source of sources) {
      if (result.length >= maxHeadlines) break;
      const list = bySource.get(source)!;
      const i = nextIndex.get(source)!;
      if (i >= list.length) continue;
      const othersHaveItems = sources.some((s) => s !== source && nextIndex.get(s)! < bySource.get(s)!.length);
      if (taken.get(source)! >= MORNING_REPORT_MAX_HEADLINES_PER_SOURCE && othersHaveItems) continue;
      result.push(list[i]!);
      nextIndex.set(source, i + 1);
      taken.set(source, taken.get(source)! + 1);
      addedThisRound = true;
    }
    if (!addedThisRound) break;
  }
  return result;
}

/**
 * DUR-4059 review: log per source how many items were fetched, survived the
 * topic filter, and were finally kept (after cross-source dedupe, balancing
 * and the maxHeadlines cap), so a thin headline day shows why in the server
 * log — `stats.sourcesChecked`/`itemsFound` in the facts (see composeReport)
 * is the plain-language, operator-facing version of the same count.
 */
async function collectHeadlines(params: {
  sources: MorningReportSource[];
  topics: MorningReportTopic[];
  maxHeadlines: number;
  fetchImpl: typeof fetch;
  braveSearch: BraveSearch;
}): Promise<{ items: { title: string; url: string; source: MorningReportSource }[]; notes: string[] }> {
  const notes: string[] = [];
  const collected: { title: string; url: string; source: MorningReportSource; pubDate: string | null }[] = [];
  const fetchedPerSource = new Map<MorningReportSource, number>();
  for (const source of params.sources) {
    const feed = MORNING_REPORT_RSS_FEEDS[source];
    if (!feed) {
      try {
        const got = await params.braveSearch(`${source} news`);
        fetchedPerSource.set(source, got.length);
        for (const result of got) collected.push({ title: result.title, url: result.url, source, pubDate: null });
      } catch (err) {
        fetchedPerSource.set(source, 0);
        notes.push(`${source}: could not fetch headlines (${err instanceof Error ? err.message : "unknown reason"}).`);
      }
      continue;
    }
    try {
      const got = await fetchRss(params.fetchImpl, feed, 20);
      fetchedPerSource.set(source, got.length);
      for (const item of got) collected.push({ ...item, source });
    } catch (err) {
      // DUR-4138: the feed refused the request (e.g. a Cloudflare bot
      // challenge, like pcmag/zelda_dungeon even with a browser User-Agent) —
      // fall back to web search for this source rather than losing it.
      try {
        const got = await params.braveSearch(`${source} news`);
        fetchedPerSource.set(source, got.length);
        for (const result of got) collected.push({ title: result.title, url: result.url, source, pubDate: null });
      } catch (fallbackErr) {
        fetchedPerSource.set(source, 0);
        notes.push(`${source}: could not fetch headlines (${fallbackErr instanceof Error ? fallbackErr.message : "unknown reason"}).`);
      }
    }
  }
  const onTopic = collected.filter((item) => matchesMorningReportTopics(item.title, params.topics));
  const onTopicPerSource = new Map<MorningReportSource, number>();
  for (const item of onTopic) onTopicPerSource.set(item.source, (onTopicPerSource.get(item.source) ?? 0) + 1);
  const items = balanceHeadlinesAcrossSources(dedupeHeadlines(onTopic), params.maxHeadlines).map(({ title, url, source }) => ({
    title,
    url,
    source,
  }));
  const keptPerSource = new Map<MorningReportSource, number>();
  for (const item of items) keptPerSource.set(item.source, (keptPerSource.get(item.source) ?? 0) + 1);
  for (const source of params.sources) {
    logger.info(
      {
        event: "morning_report.headline_source",
        source,
        fetched: fetchedPerSource.get(source) ?? 0,
        onTopic: onTopicPerSource.get(source) ?? 0,
        kept: keptPerSource.get(source) ?? 0,
      },
      `morning-report: ${source} fetched ${fetchedPerSource.get(source) ?? 0}, ${onTopicPerSource.get(source) ?? 0} on-topic, ${keptPerSource.get(source) ?? 0} kept after dedupe/cap`,
    );
  }
  return { items, notes };
}

async function collectHobbyNews(params: {
  hobbyTopics: MorningReportHobbyTopic[];
  fetchImpl: typeof fetch;
  braveSearch: BraveSearch;
  now: Date;
}): Promise<{ items: { title: string; url: string; source: string }[]; notes: string[] }> {
  if (params.hobbyTopics.length === 0) return { items: [], notes: [] };
  const notes: string[] = [];
  const collected: { title: string; url: string; source: string; pubDate: string | null }[] = [];
  if (params.hobbyTopics.includes("zelda")) {
    try {
      for (const item of await fetchRss(params.fetchImpl, MORNING_REPORT_RSS_FEEDS.zelda_dungeon!, 30)) {
        collected.push({ ...item, source: "zelda_dungeon" });
      }
    } catch {
      // DUR-4138: same Cloudflare-challenge fallback as collectHeadlines.
      try {
        for (const result of await params.braveSearch("zelda news")) {
          collected.push({ title: result.title, url: result.url, source: "zelda_dungeon", pubDate: null });
        }
      } catch (fallbackErr) {
        notes.push(`Hobby (zelda): could not fetch (${fallbackErr instanceof Error ? fallbackErr.message : "unknown reason"}).`);
      }
    }
  }
  for (const topic of params.hobbyTopics.filter((t) => t !== "zelda")) {
    try {
      for (const result of await params.braveSearch(`${topic.replace(/_/g, " ")} new release`)) {
        collected.push({ title: result.title, url: result.url, source: topic, pubDate: null });
      }
    } catch (err) {
      notes.push(`Hobby (${topic}): could not search (${err instanceof Error ? err.message : "unknown reason"}).`);
    }
  }
  const filtered = collected.filter((item) => looksLikeNewRelease(item.title) && isRecent(item.pubDate, params.now, HOBBY_MAX_AGE_HOURS));
  return { items: dedupeHeadlines(filtered).map(({ title, url, source }) => ({ title, url, source })), notes };
}

/** The search query for each followed team/player. Typed as a total map over the union, so a new entry cannot be forgotten. */
const SPORT_FOLLOW_QUERIES: Record<MorningReportSportFollow, string> = {
  mats_zuccarello_nhl: "Mats Zuccarello NHL result news",
};

async function collectSportNews(params: {
  sportFollows: MorningReportSportFollow[];
  braveSearch: BraveSearch;
}): Promise<{ items: { title: string; url: string; source: string }[]; notes: string[] }> {
  if (params.sportFollows.length === 0) return { items: [], notes: [] };
  const notes: string[] = [];
  const collected: { title: string; url: string; source: string }[] = [];
  for (const follow of params.sportFollows) {
    try {
      for (const result of await params.braveSearch(SPORT_FOLLOW_QUERIES[follow])) {
        collected.push({ title: result.title, url: result.url, source: follow });
      }
    } catch (err) {
      notes.push(`Sport (${follow}): could not search (${err instanceof Error ? err.message : "unknown reason"}).`);
    }
  }
  return { items: dedupeHeadlines(collected).slice(0, 5), notes };
}

/**
 * Which live-quote source (and the symbol spelling that source expects) each
 * closed-list price symbol maps to. DNB.OL is Oslo Børs's own spelling; the
 * EODHD source appends ".OL" itself (see osloStockSource in
 * watcher-sources.ts), so it wants the bare "DNB".
 */
const PRICE_SYMBOL_SOURCE: Record<MorningReportPriceSymbol, { source: WatcherSource; sourceSymbol: string }> = {
  BTC: { source: "crypto", sourceSymbol: "BTC" },
  SOL: { source: "crypto", sourceSymbol: "SOL" },
  ETH: { source: "crypto", sourceSymbol: "ETH" },
  "DNB.OL": { source: "oslo_stock", sourceSymbol: "DNB" },
};

/**
 * Prices, direct (DUR-4059): a symbol with watcher history uses it, exactly
 * as before. Otherwise — the common case, since prices must work without
 * Filip ever creating a watcher — this fetches the live quote itself, from
 * the right source for that symbol (crypto needs no key; an Oslo Børs symbol
 * needs the company's EODHD key, read by name, never stored on this call).
 * Earlier code always tried the crypto source here regardless of symbol,
 * which is why DNB.OL never got a fallback price even with a key configured.
 */
async function collectPrices(
  db: Db,
  companyId: string,
  symbols: MorningReportPriceSymbol[],
  fetchImpl: typeof fetch,
  now: Date,
  resolveStockDataKey: (companyId: string) => Promise<string | null>,
): Promise<{ facts: MorningReportPriceFact[]; notes: string[] }> {
  if (symbols.length === 0) return { facts: [], notes: [] };
  const facts: MorningReportPriceFact[] = [];
  const notes: string[] = [];
  for (const symbol of symbols) {
    const mapping = PRICE_SYMBOL_SOURCE[symbol];
    const currency = WATCHER_SOURCE_INFO[mapping.source].currency;
    const rows = await db
      .select({ price: watcherPricePoints.price, observedAt: watcherPricePoints.observedAt })
      .from(watcherPricePoints)
      .innerJoin(watchers, eq(watchers.id, watcherPricePoints.watcherId))
      .where(and(eq(watchers.companyId, companyId), eq(watchers.symbol, symbol)))
      .orderBy(desc(watcherPricePoints.observedAt))
      .limit(50);
    if (rows.length > 0) {
      const latest = rows[0]!;
      // The reading closest to (but not under) 18 hours old stands in for
      // "yesterday's close" without needing a calendar-aware close price.
      const base = rows.find((row) => latest.observedAt.getTime() - row.observedAt.getTime() >= 18 * 3_600_000) ?? null;
      // DUR-4059: a short sparkline history from the same watcher readings
      // already fetched above — oldest first, at most PRICE_HISTORY_POINTS.
      const history: MorningReportPricePoint[] = rows
        .slice(0, PRICE_HISTORY_POINTS)
        .reverse()
        .map((row) => ({ price: row.price, observedAt: row.observedAt.toISOString() }));
      facts.push({
        symbol,
        price: latest.price,
        currency,
        changePercent: base ? ((latest.price - base.price) / base.price) * 100 : null,
        history,
      });
      continue;
    }
    try {
      let quotes;
      if (mapping.source === "oslo_stock") {
        const key = await resolveStockDataKey(companyId);
        if (!key) {
          notes.push(
            `${symbol}: no stock data key is configured for this company, so this price could not be fetched. ` +
              `Save a free EODHD key (eodhd.com) as a company secret named "EODHD" to show it.`,
          );
          continue;
        }
        quotes = await WATCHER_PRICE_SOURCES.oslo_stock.fetchQuotes({ symbols: [mapping.sourceSymbol], key, now }, { fetchImpl });
      } else {
        quotes = await WATCHER_PRICE_SOURCES.crypto.fetchQuotes({ symbols: [mapping.sourceSymbol], now }, { fetchImpl });
      }
      const quote = quotes.get(mapping.sourceSymbol);
      if (quote && !isWatcherQuoteError(quote)) {
        // No watcher history exists yet for this symbol (the common case —
        // prices must work without Filip ever creating a watcher), so there
        // is no cheap sparkline source here; see "Questions for Filip" in
        // the PR for the real 7-day-fetch fast-follow.
        facts.push({
          symbol,
          price: quote.price,
          currency,
          changePercent: quote.reference ? ((quote.price - quote.reference.price) / quote.reference.price) * 100 : null,
          history: [],
        });
      } else {
        notes.push(`${symbol}: ${isWatcherQuoteError(quote) ? quote.message : "no price available right now."}`);
      }
    } catch {
      notes.push(`${symbol}: no price available right now.`);
    }
  }
  return { facts, notes };
}

function formatPriceLine(fact: MorningReportPriceFact): string {
  const price = `${fact.price} ${fact.currency}`;
  if (fact.changePercent === null) return `${fact.symbol}: ${price} (no ~24h-old price yet to compare)`;
  const sign = fact.changePercent >= 0 ? "+" : "";
  return `${fact.symbol}: ${price} (${sign}${fact.changePercent.toFixed(2)}% vs ~24h ago)`;
}

/**
 * DUR-4059 review: every list here is rendered from the facts by code, never
 * by a model, and every section that was configured says something even when
 * it found nothing — a section never just silently disappears, so a thin day
 * is visible instead of looking like a working, uneventful one. `settings` is
 * only used to tell "not configured" (omit the section) apart from
 * "configured but nothing found" (say so in one line).
 */
function renderFullReportText(
  facts: Pick<MorningReportFacts, "opening" | "weather" | "headlines" | "hobby" | "sport" | "prices" | "stats">,
  settings: Pick<MorningReportSettings, "sources" | "hobbyTopics" | "sportFollows" | "priceSymbols">,
): string {
  const parts: string[] = [facts.opening];
  parts.push(facts.weather.length > 0 ? `Weather:\n${facts.weather.map((w) => w.text).join("\n\n")}` : "Weather: unavailable today.");
  if (settings.sources.length > 0) {
    parts.push(
      facts.headlines.length > 0
        ? `Headlines:\n${facts.headlines
            .map((h, i) => `${i + 1}. ${h.title}${h.summary ? ` — ${h.summary}` : ""} (${h.url})`)
            .join("\n")}`
        : "Headlines: no new headlines found today.",
    );
  }
  if (settings.hobbyTopics.length > 0) {
    parts.push(
      facts.hobby.length > 0
        ? `Hobby news:\n${facts.hobby.map((h) => `- ${h.title} (${h.url})`).join("\n")}`
        : "Hobby news: nothing new today.",
    );
  }
  if (settings.sportFollows.length > 0) {
    parts.push(
      facts.sport.length > 0 ? `Sport:\n${facts.sport.map((h) => `- ${h.title} (${h.url})`).join("\n")}` : "Sport: nothing new today.",
    );
  }
  if (settings.priceSymbols.length > 0) {
    parts.push(
      facts.prices.length > 0 ? `Prices:\n${facts.prices.map(formatPriceLine).join("\n")}` : "Prices: unavailable today.",
    );
  }
  if (settings.sources.length > 0) {
    parts.push(`Sources checked: ${facts.stats.sourcesChecked}, headlines found: ${facts.stats.itemsFound}.`);
  }
  return parts.join("\n\n");
}

/** A short, always-safe opening used when the model call fails, is truncated, or is not available. Never a model call. */
function deterministicOpening(places: string[]): string {
  return `Good morning! Here is your briefing for ${places.join(" and ")}.`;
}

/**
 * DUR-4059 direction change: the short, plain-text Telegram teaser — today's
 * weather in both places, the single most important headline, one price
 * move. Built entirely in code, never by a model, and never containing HTML
 * or markdown: the Telegram bridge sends it with no parse_mode, so any stray
 * angle bracket in a headline title is shown literally rather than parsed.
 * The bridge appends the briefing-page link itself, only when
 * facts.briefingPageLive is true — this function never mentions the link.
 */
function buildTeaser(input: {
  weather: MorningReportWeatherFact[];
  headlines: MorningReportFactItem[];
  prices: MorningReportPriceFact[];
}): string {
  const lines: string[] = [];
  lines.push(
    input.weather.length > 0
      ? input.weather.map((w) => (w.text.split("\n")[0] ?? w.text).trim()).join("; ")
      : "Weather: unavailable today.",
  );
  lines.push(input.headlines.length > 0 ? `Top story: ${input.headlines[0]!.title}` : "Headlines: nothing new today.");
  const notable = input.prices.find((p) => p.changePercent !== null) ?? input.prices[0];
  if (notable) lines.push(formatPriceLine(notable));
  return lines.join("\n");
}

/**
 * Neutralizes any HTML the model might produce (DUR-4059 direction change:
 * "no HTML or markdown links from the model are ever rendered as markup") —
 * defense in depth on top of the Telegram bridge never using parse_mode for
 * model-written text: even if a future caller renders this as HTML by
 * mistake, there is no angle bracket left to form a tag.
 */
function sanitizeModelText(text: string, maxLength: number): string {
  return text.replace(/[<>]/g, "").trim().slice(0, maxLength);
}

interface ParsedSummaryResponse {
  opening?: unknown;
  mood?: unknown;
  themeKeywords?: unknown;
  headlines?: unknown;
}

/**
 * DUR-4138: the first *balanced* `{...}` object in `text`, scanning brace
 * depth and skipping over string contents (so a brace-like character inside
 * a quoted string, or trailing prose after the object, cannot break the
 * match). Replaces a plain `/\{[\s\S]*\}/` regex, which is greedy to the
 * LAST `}` in the whole answer — wrong whenever the model adds any prose
 * with its own braces after the real object. Returns null when there is no
 * `{` at all, or the braces never balance (e.g. truncated output).
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Best-effort JSON extraction from a model answer that is supposed to be
 * strict JSON but might carry code fences or stray prose (DUR-4138: Mistral
 * Small over OpenRouter regularly wraps its answer in ```json fences plus a
 * sentence of preamble/postamble even when asked not to). Tries, in order: a
 * fenced code block's own balanced object, the whole answer's first balanced
 * object, then the raw trimmed text (covers a host honoring JSON mode and
 * answering with nothing else). Returns null on anything that does not parse
 * as a JSON object.
 */
function parseSummaryJson(text: string): ParsedSummaryResponse | null {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const extracted = extractFirstJsonObject(fenced[1]!.trim());
    if (extracted) candidates.push(extracted);
  }
  const extractedWhole = extractFirstJsonObject(trimmed);
  if (extractedWhole) candidates.push(extractedWhole);
  candidates.push(trimmed);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ParsedSummaryResponse;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** At most 4 short, plain, non-empty keywords (DUR-4138): the model's theme-keywords answer feeds the mood picture's background, never a quoted headline at length. */
export function sanitizeThemeKeywords(field: unknown): string[] {
  if (!Array.isArray(field)) return [];
  const words: string[] = [];
  for (const entry of field) {
    if (typeof entry !== "string") continue;
    const cleaned = sanitizeModelText(entry, 40);
    if (cleaned) words.push(cleaned);
    if (words.length >= 4) break;
  }
  return words;
}

/** Applies the model's per-headline summaries by position (n is 1-based, matching the numbering the model was given). Any entry that is malformed, out of range, or missing is simply skipped — a headline with no summary is still a complete, safe headline (title + link). */
function applyHeadlineSummaries(
  items: MorningReportFactItem[],
  headlinesField: unknown,
): MorningReportFactItem[] {
  if (!Array.isArray(headlinesField)) return items;
  const summaries = new Map<number, string>();
  for (const entry of headlinesField) {
    if (!entry || typeof entry !== "object") continue;
    const n = (entry as Record<string, unknown>).n;
    const summary = (entry as Record<string, unknown>).summary;
    if (typeof n !== "number" || !Number.isInteger(n)) continue;
    if (typeof summary !== "string" || !summary.trim()) continue;
    summaries.set(n, sanitizeModelText(summary, 400));
  }
  return items.map((item, i) => {
    const summary = summaries.get(i + 1);
    return summary ? { ...item, summary } : item;
  });
}

/** The compact, plain-text digest the one summaries model call reads — titles and short facts only, never a URL (so the model has nothing to turn into a link). */
function buildSummaryDigest(input: {
  places: string[];
  weather: MorningReportWeatherFact[];
  headlines: MorningReportFactItem[];
  prices: MorningReportPriceFact[];
}): string {
  const lines: string[] = [`Places: ${input.places.join(", ")}.`];
  for (const w of input.weather) lines.push(`Weather ${w.place}: ${(w.text.split("\n")[0] ?? w.text).trim()}`);
  if (input.prices.length > 0) lines.push(`Prices: ${input.prices.map(formatPriceLine).join("; ")}`);
  if (input.headlines.length > 0) {
    lines.push("Headlines, numbered (write one summary per number, using only the title given):");
    input.headlines.forEach((h, i) => lines.push(`${i + 1}. ${h.title} [${h.source}]`));
  } else {
    lines.push("Headlines: none today.");
  }
  return lines.join("\n");
}

/** Code-written (no model call): Maja dressed for today's weather, in her own default look — DUR-4133: always fully clothed, regardless of the look. */
function weatherPicturePrompt(agentName: string, places: string[], conditionsSummary: string): string {
  return (
    `A warm, friendly full-body illustration of ${agentName} dressed appropriately for today's weather in ${places.join(" and ")}: ` +
    `${conditionsSummary}. Fully clothed, dressed for the weather, safe for work. Illustration style, no text, no numbers, no logos.`
  );
}

/** "rising"/"falling"/"flat": the average of every price's % change that has one (DUR-4133); null with no price data at all. */
export function priceDirection(prices: MorningReportPriceFact[]): "rising" | "falling" | "flat" | null {
  const changes = prices.map((p) => p.changePercent).filter((c): c is number => c !== null);
  if (changes.length === 0) return null;
  const average = changes.reduce((sum, c) => sum + c, 0) / changes.length;
  if (average > 0.1) return "rising";
  if (average < -0.1) return "falling";
  return "flat";
}

/** At most `maxWords` plain words (DUR-4133): the model's mood answer is a short description, never a headline quoted at length. */
export function sanitizeMoodWords(text: string, maxWords = 8): string {
  const words = sanitizeModelText(text, 200).split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

/** Code-written (no model call), used when the model's mood is missing or the model call failed entirely (DUR-4133): built only from prices and weather, never headlines. */
export function deterministicMood(direction: ReturnType<typeof priceDirection>, conditionsSummary: string | null): string {
  const priceWord = direction === "rising" ? "upbeat" : direction === "falling" ? "subdued" : "steady";
  return conditionsSummary ? `${priceWord}, weather-led` : priceWord;
}

const MOOD_SAD_WORDS = [
  "sad",
  "grim",
  "somber",
  "sombre",
  "bleak",
  "gloomy",
  "tense",
  "dark",
  "worried",
  "anxious",
  "subdued",
  "troubling",
  "troubled",
  "difficult",
  "harsh",
  "war",
  "conflict",
  "crisis",
  "falling",
  "down",
  "negative",
  "concern",
  "concerning",
  "grief",
  "mourning",
];
const MOOD_HAPPY_WORDS = [
  "happy",
  "hopeful",
  "bright",
  "cheerful",
  "calm",
  "positive",
  "upbeat",
  "optimistic",
  "good",
  "great",
  "sunny",
  "joyful",
  "excited",
  "celebratory",
  "rising",
  "up",
  "steady",
  "peaceful",
];

/**
 * DUR-4138: "happy" or "sad" for the mood picture's persona expression — a
 * plain keyword count over the model's own mood phrase (never the headlines
 * themselves), falling back to price direction on a tie or an empty/unclear
 * phrase, matching deterministicMood's existing price-led convention.
 */
export function moodSentiment(mood: string, direction: ReturnType<typeof priceDirection>): "happy" | "sad" {
  const lower = mood.toLowerCase();
  const sadScore = MOOD_SAD_WORDS.filter((w) => lower.includes(w)).length;
  const happyScore = MOOD_HAPPY_WORDS.filter((w) => lower.includes(w)).length;
  if (sadScore > happyScore) return "sad";
  if (happyScore > sadScore) return "happy";
  return direction === "falling" ? "sad" : "happy";
}

/**
 * DUR-4138 (was DUR-4133's abstract/scenic illustration): a visual recap of
 * the day showing the persona itself (via the chosen look — collectImages
 * resolves which one), happy or sad depending on the overall sentiment of
 * today's headlines, with background elements for the day's themes and
 * today's price direction — never quoted headline text, and no text/letters/
 * logos at all (a model painting quoted text as garbled letters is exactly
 * the DUR-4133 bug; theme keywords and mood are always the model's own short
 * words, never a headline title).
 */
function moodPicturePrompt(
  agentName: string,
  mood: string,
  sentiment: "happy" | "sad",
  themeKeywords: string[],
  direction: ReturnType<typeof priceDirection>,
  conditionsSummary: string | null,
): string {
  const expression = sentiment === "happy" ? "a smiling, upbeat expression" : "a subdued, downcast expression";
  const themeClause =
    themeKeywords.length > 0 ? `Background elements reflecting today's news themes: ${themeKeywords.join(", ")}. ` : "";
  const priceClause =
    direction === "rising"
      ? "A small rising green chart or a few coins in the background: prices are up today. "
      : direction === "falling"
        ? "A small falling red chart in the background: prices are down today. "
        : direction === "flat"
          ? "Prices are flat today. "
          : "";
  const weatherClause = conditionsSummary ? `Today's weather: ${conditionsSummary}. ` : "";
  return (
    `A full-body illustration of ${agentName}, ${expression}, a visual recap of today's overall mood: ${mood}. ` +
    `${themeClause}${priceClause}${weatherClause}` +
    "Illustration style, no text, no letters, no words, no numbers, no logos, no watermark."
  );
}

/** The numbered list Filip sees in Telegram's headlines section, so a later "tell me more about number 3" resolves to the right item. */
function conversationMessageForReport(text: string, facts: MorningReportFacts): string {
  if (facts.headlines.length === 0) return text;
  const numbered = facts.headlines.map((h, i) => `${i + 1}. ${h.title} (${h.url})`).join("\n");
  return `${text}\n\nHeadlines, numbered as sent:\n${numbered}`;
}

// ─── The service ────────────────────────────────────────────────────────────

export function morningReportService(db: Db, deps: MorningReportServiceDeps = {}) {
  const laneA = deps.laneA ?? laneAService(db);
  const webSearch = deps.webSearch ?? webSearchService(db, deps);
  const secrets = deps.secrets ?? secretService(db);
  const nowOf = () => deps.now?.() ?? new Date();
  const fetchImpl = deps.fetchImpl ?? fetch;
  // The briefing page (DUR-4075) ships together with this service, so the
  // link is on by default; set PAPERCLIP_MORNING_REPORT_BRIEFING_PAGE_ENABLED=false
  // to keep Telegram teasers link-free.
  const briefingPageLive = deps.briefingPageLive ?? process.env.PAPERCLIP_MORNING_REPORT_BRIEFING_PAGE_ENABLED !== "false";
  const dispatch =
    deps.dispatch ??
    ((work: () => Promise<void>) => {
      void runInPooledScope(db, work).catch((err) => {
        logger.error({ err }, "morning-report: writing a report failed");
      });
    });

  function braveSearchFor(companyId: string, agentId: string): BraveSearch {
    return async (query: string) => {
      const { results } = await webSearch.search(
        companyId,
        { query, count: SEARCH_RESULTS_PER_SOURCE, freshness: "week", news: true },
        { agentId, userId: null, actorType: "system", actorId: "morning-report" },
      );
      return results.map((r) => ({ title: r.title, url: r.url }));
    };
  }

  /**
   * Appends the report as an assistant turn in a fresh Lane A conversation
   * owned by the company's board owner, so a later Telegram reply ("tell me
   * more about number 3") continues the same chat history the normal quick-
   * agent chat path reads (server/src/services/lane-a.ts's
   * loadReplayHistory). The Telegram bridge must still point that chat at
   * this conversationId (it keeps its own token+chat_id mapping) — see the
   * outbox `conversationId` field and scripts/telegram-bridge.py.
   *
   * Never throws: no board owner, the agent not being a quick agent, or any
   * write failure all just mean no conversation link, never a failed report.
   */
  async function appendReportToConversation(agentRow: AgentRow, text: string, facts: MorningReportFacts, now: Date): Promise<string | null> {
    if (!agentRow.laneAEnabled) return null;
    try {
      const [owner] = await db
        .select({ userId: companyMemberships.principalId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, agentRow.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.membershipRole, "owner"),
            eq(companyMemberships.status, "active"),
          ),
        )
        .limit(1);
      if (!owner) return null;
      const [conversation] = await db
        .insert(laneAConversations)
        .values({
          companyId: agentRow.companyId,
          agentId: agentRow.id,
          requestedByUserId: owner.userId,
          requestedByAgentId: null,
          turnCount: 1,
          createdAt: now,
          lastMessageAt: now,
        })
        .returning();
      if (!conversation) return null;
      await db.insert(laneAMessages).values({
        companyId: agentRow.companyId,
        conversationId: conversation.id,
        agentId: agentRow.id,
        role: "assistant",
        content: conversationMessageForReport(text, facts),
        createdAt: now,
      });
      return conversation.id;
    } catch (err) {
      logger.warn({ err, agentId: agentRow.id }, "morning-report: could not link the report into a Lane A conversation");
      return null;
    }
  }

  /** Maja's weather picture and one mood picture, via Media Studio (laneA.makePicture) — the same "quick picture tool" chat pictures use. Never throws: a failed picture just means fewer images, never a failed report. */
  /** DUR-4138: turns one picture's setting into laneA.makePicture's look/model params. "default" passes neither, so the normal resolution chain (named/mentioned/automatic/the agent's own default look) applies — the same thing both report pictures already did before per-picture choice existed. */
  function pictureSourceParams(source: MorningReportPictureSource): { look?: string; model?: string; provider?: string } {
    if (source.kind === "look") return { look: source.lookId };
    if (source.kind === "model") return { model: source.model, provider: source.provider };
    return {};
  }

  async function collectImages(
    agentRow: AgentRow,
    settings: MorningReportSettings,
    places: string[],
    conditionsSummary: string | null,
    mood: string,
    themeKeywords: string[],
    direction: ReturnType<typeof priceDirection>,
    localDate: string,
  ): Promise<{ images: MorningReportImageFact[]; notes: string[] }> {
    const images: MorningReportImageFact[] = [];
    const notes: string[] = [];
    if (!agentRow.laneAEnabled) return { images, notes };
    if (conditionsSummary) {
      try {
        const picture = await laneA.makePicture({
          companyId: agentRow.companyId,
          agentId: agentRow.id,
          prompt: weatherPicturePrompt(agentRow.name, places, conditionsSummary),
          runLabel: `morning-report-weather:${agentRow.id}:${localDate}`,
          // DUR-4138: "fully clothed" and a fixed negative prompt only — never
          // forces the provider's content filter, which follows the chosen
          // look's own setting (or the company/provider default).
          safeForWork: true,
          ...pictureSourceParams(resolveMorningReportPictureSource(settings.weatherPicture)),
        });
        if (picture.ok) images.push({ fileId: picture.fileId, caption: `${agentRow.name}, dressed for today's weather in ${places.join(" and ")}.`, kind: "weather" });
        else notes.push(`No weather picture this time: ${picture.reason}`);
      } catch (err) {
        notes.push(`No weather picture this time: ${err instanceof Error ? err.message.slice(0, 200) : "the picture failed"}.`);
      }
    }
    try {
      const sentiment = moodSentiment(mood, direction);
      const picture = await laneA.makePicture({
        companyId: agentRow.companyId,
        agentId: agentRow.id,
        prompt: moodPicturePrompt(agentRow.name, mood, sentiment, themeKeywords, direction, conditionsSummary),
        runLabel: `morning-report-mood:${agentRow.id}:${localDate}`,
        // DUR-4138 (was DUR-4133's look:"none"): the mood picture now shows
        // the persona, via the chosen look (default: the agent's own default
        // look) — same prompt-only safety as the weather picture, never a
        // forced content filter.
        safeForWork: true,
        ...pictureSourceParams(resolveMorningReportPictureSource(settings.moodPicture)),
      });
      if (picture.ok) images.push({ fileId: picture.fileId, caption: "Today's mood, in one picture.", kind: "mood" });
      else notes.push(`No mood picture this time: ${picture.reason}`);
    } catch (err) {
      notes.push(`No mood picture this time: ${err instanceof Error ? err.message.slice(0, 200) : "the picture failed"}.`);
    }
    return { images, notes };
  }

  // ─── The tick ──────────────────────────────────────────────────────────

  async function claimDueAgents(now: Date): Promise<Array<{ row: AgentRow; localDate: string }>> {
    const candidates = await db
      .select()
      .from(agents)
      .where(
        and(
          sql`${agents.morningReportSettings} ->> 'enabled' = 'true'`,
          or(isNull(agents.morningReportLeaseUntil), lt(agents.morningReportLeaseUntil, now)),
        ),
      )
      .limit(MORNING_REPORT_TICK_BATCH);
    const claimed: Array<{ row: AgentRow; localDate: string }> = [];
    for (const candidate of candidates) {
      const settings = parseMorningReportSettings(candidate.morningReportSettings);
      const decision = dueMorningReport(settings, now, candidate.morningReportLastSentDate);
      if (!decision.due) continue;
      const [row] = await db
        .update(agents)
        .set({ morningReportLeaseUntil: new Date(now.getTime() + MORNING_REPORT_LEASE_MS) })
        .where(
          and(
            eq(agents.id, candidate.id),
            or(isNull(agents.morningReportLeaseUntil), lt(agents.morningReportLeaseUntil, now)),
          ),
        )
        .returning();
      if (row) claimed.push({ row, localDate: decision.localDate });
    }
    return claimed;
  }

  async function expireStaleOutbox(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - MORNING_REPORT_OUTBOX_MAX_AGE_MS);
    const rows = await db
      .update(morningReportOutbox)
      .set({ status: "expired", note: "Not sent: nobody picked it up within a day (is the Telegram bridge running, and has the bot been started?)." })
      .where(and(eq(morningReportOutbox.status, "ready"), lt(morningReportOutbox.readyAt, cutoff)))
      .returning({ id: morningReportOutbox.id });
    return rows.length;
  }

  async function composeReport(
    agentRow: AgentRow,
    settings: MorningReportSettings,
    localDate: string,
    now: Date,
    opts: { isTest?: boolean } = {},
  ): Promise<string> {
    const braveSearch = braveSearchFor(agentRow.companyId, agentRow.id);
    const places = resolvePlaces(settings, localDate);
    const [weather, headlines, hobby, sport, prices] = await Promise.all([
      fetchWeatherSection(fetchImpl, places),
      collectHeadlines({ sources: settings.sources, topics: settings.topics, maxHeadlines: settings.maxHeadlines, fetchImpl, braveSearch }),
      collectHobbyNews({ hobbyTopics: settings.hobbyTopics, fetchImpl, braveSearch, now }),
      collectSportNews({ sportFollows: settings.sportFollows, braveSearch }),
      collectPrices(db, agentRow.companyId, settings.priceSymbols, fetchImpl, now, (companyId) => secrets.resolveStockDataKey(companyId)),
    ]);
    const notes: string[] = [...weather.notes];
    notes.push(...headlines.notes, ...hobby.notes, ...sport.notes, ...prices.notes);

    const stats = { sourcesChecked: settings.sources.length, itemsFound: headlines.items.length };

    // DUR-4059 direction change: the model writes ONLY a short opening and
    // per-headline summaries, as JSON, never the report itself — every list
    // above already exists in full regardless of what happens next. A
    // truncated or unparsable answer is discarded whole (never "half a
    // list"): the deterministic opening and plain title+link headlines are
    // always a complete, safe report on their own.
    let opening = deterministicOpening(places);
    let headlineItems: MorningReportFactItem[] = headlines.items;
    let modelMood: string | null = null;
    let modelThemeKeywords: string[] = [];
    if (!agentRow.laneAEnabled) {
      notes.push("This agent is not a quick agent any more, so headline summaries were not written.");
    } else {
      const targetAgent = {
        id: agentRow.id,
        companyId: agentRow.companyId,
        name: agentRow.name,
        role: agentRow.role,
        laneAEnabled: agentRow.laneAEnabled,
        laneAInstructions: agentRow.laneAInstructions ?? null,
        status: agentRow.status ?? null,
        laneAModel: agentRow.laneAModel ?? null,
        laneAMaxOutputTokens: agentRow.laneAMaxOutputTokens ?? null,
        laneATransformDailyCallCap: agentRow.laneATransformDailyCallCap ?? null,
      };
      const input = buildSummaryDigest({ places, weather: weather.items, headlines: headlines.items, prices: prices.facts });
      try {
        // DUR-4138: ask for JSON mode up front — a host/model that ignores it
        // answers exactly as before, so parseSummaryJson still runs either way.
        const written = await laneA.transform({
          companyId: agentRow.companyId,
          targetAgent,
          input,
          task: MORNING_REPORT_SUMMARY_TASK,
          maxOutputChars: MAX_OUTPUT_CHARS_FOR_SUMMARIES,
          responseFormat: "json_object",
        });
        if (written.truncated) {
          notes.push(
            `${agentRow.name}'s summary was cut off before it finished, so the opening and headlines were sent without it instead of a half-written one.`,
          );
        } else {
          let parsed = parseSummaryJson(written.text);
          if (!parsed) {
            // DUR-4138: retry once with a stricter instruction before falling back to the plain facts.
            try {
              const retry = await laneA.transform({
                companyId: agentRow.companyId,
                targetAgent,
                input,
                task: MORNING_REPORT_SUMMARY_TASK_STRICT,
                maxOutputChars: MAX_OUTPUT_CHARS_FOR_SUMMARIES,
                responseFormat: "json_object",
              });
              if (!retry.truncated) parsed = parseSummaryJson(retry.text);
            } catch {
              // Keep parsed === null; the fallback note below still fires.
            }
          }
          if (!parsed) {
            notes.push(`${agentRow.name} did not answer with the expected JSON, so the opening and headlines were sent without it.`);
          } else {
            if (typeof parsed.opening === "string" && parsed.opening.trim()) {
              opening = sanitizeModelText(parsed.opening, 1200);
            }
            if (typeof parsed.mood === "string" && parsed.mood.trim()) {
              modelMood = sanitizeMoodWords(parsed.mood);
            }
            modelThemeKeywords = sanitizeThemeKeywords(parsed.themeKeywords);
            headlineItems = applyHeadlineSummaries(headlines.items, parsed.headlines);
          }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "unknown reason";
        notes.push(`${agentRow.name} could not write summaries this time (${reason.slice(0, 200)}), so the opening and headlines were sent without it.`);
      }
    }
    if (opts.isTest) opening = `🧪 Test report\n${opening}`;

    // Pictures via Media Studio, after the one summaries model call, never
    // blocking it: a failed picture must never lose the report (DUR-4059).
    // The mood picture's prompt (DUR-4138, was DUR-4133) is built from the
    // model's own mood words and theme keywords when it answered, else
    // purely from prices and weather — never from headline titles.
    const direction = priceDirection(prices.facts);
    const mood = modelMood ?? deterministicMood(direction, weather.conditionsSummary);
    const pictures = await collectImages(agentRow, settings, places, weather.conditionsSummary, mood, modelThemeKeywords, direction, localDate);
    notes.push(...pictures.notes);

    const facts: MorningReportFacts = {
      places,
      weather: weather.items,
      headlines: headlineItems,
      hobby: hobby.items,
      sport: sport.items,
      prices: prices.facts,
      images: pictures.images,
      opening,
      teaser: buildTeaser({ weather: weather.items, headlines: headlineItems, prices: prices.facts }),
      stats,
      briefingPageLive,
      notes,
    };
    const text = renderFullReportText(facts, settings);
    const conversationId = await appendReportToConversation(agentRow, text, facts, now);

    const [inserted] = await db
      .insert(morningReportOutbox)
      .values({
        companyId: agentRow.companyId,
        agentId: agentRow.id,
        status: "ready",
        text,
        facts,
        conversationId,
        note: notes.length > 0 ? notes.join(" ").slice(0, 1000) : null,
        createdAt: now,
        readyAt: now,
      })
      .returning({ id: morningReportOutbox.id });
    if (!opts.isTest) {
      await db
        .update(agents)
        .set({ morningReportLastSentDate: localDate, morningReportLeaseUntil: null })
        .where(eq(agents.id, agentRow.id));
    }
    await logActivity(db, {
      companyId: agentRow.companyId,
      actorType: "system",
      actorId: "morning-report",
      action: "morning_report.sent",
      entityType: "agent",
      entityId: agentRow.id,
      agentId: agentRow.id,
      details: { localDate, isTest: Boolean(opts.isTest) },
    }).catch(() => undefined);
    return inserted!.id;
  }

  function dispatchCompose(row: AgentRow, settings: MorningReportSettings, localDate: string, now: Date) {
    dispatch(async () => {
      try {
        await composeReport(row, settings, localDate, now);
      } catch (err) {
        // The lease expires on its own; the next tick (tomorrow, since
        // last_sent_date is only set on success) tries again.
        logger.error({ err, agentId: row.id }, "morning-report: writing a report failed");
      }
    });
  }

  /**
   * "Send a test report now" (DUR-4059): composes and queues a report right
   * away, ignoring the due-time/lease/once-a-day gate, so Filip can try
   * changes without waiting for 07:00. Runs in the caller's own request (not
   * detached), because the whole point is to see the result immediately.
   * Never marks the day as sent — the real scheduled report still fires.
   */
  async function sendTestReportNow(companyId: string, agentId: string): Promise<MorningReportOutboxItem> {
    const [row] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!row) throw notFound("That agent was not found.");
    const settings = parseMorningReportSettings(row.morningReportSettings);
    const now = nowOf();
    const { date: localDate } = localDateTimeParts(now, settings.timezone);
    const outboxId = await composeReport(row, settings, localDate, now, { isTest: true });
    const [outboxRow] = await db.select().from(morningReportOutbox).where(eq(morningReportOutbox.id, outboxId));
    if (!outboxRow) throw new Error("The test report was written but could not be read back.");
    return toOutboxItem(outboxRow);
  }

  async function tick(now: Date = nowOf()) {
    const expired = await expireStaleOutbox(now);
    const due = await claimDueAgents(now);
    for (const { row, localDate } of due) {
      dispatchCompose(row, parseMorningReportSettings(row.morningReportSettings), localDate, now);
    }
    return { fired: due.length, expired };
  }

  // ─── Outbox (the Telegram bridge) ───────────────────────────────────────

  function toOutboxItem(row: typeof morningReportOutbox.$inferSelect): MorningReportOutboxItem {
    return {
      id: row.id,
      companyId: row.companyId,
      agentId: row.agentId,
      text: row.text,
      facts: row.facts ?? null,
      conversationId: row.conversationId ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async function outbox(companyId: string): Promise<MorningReportOutboxItem[]> {
    const cutoff = new Date(nowOf().getTime() - MORNING_REPORT_OUTBOX_MAX_AGE_MS);
    const rows = await db
      .select()
      .from(morningReportOutbox)
      .where(and(eq(morningReportOutbox.companyId, companyId), eq(morningReportOutbox.status, "ready"), gte(morningReportOutbox.readyAt, cutoff)))
      .orderBy(morningReportOutbox.createdAt)
      .limit(OUTBOX_BATCH);
    return rows.map(toOutboxItem);
  }

  /**
   * One report's facts, for the full briefing page (DUR-4075's child task).
   * Unlike outbox() this is not limited to 'ready'/unexpired rows — the page
   * is read after Telegram has already delivered the report, by which point
   * status has moved on to 'delivered'. Company-scoped like every other route
   * here; the route itself is board-only (see routes/morning-report.ts).
   */
  async function getOne(companyId: string, id: string): Promise<MorningReportOutboxItem> {
    const [row] = await db
      .select()
      .from(morningReportOutbox)
      .where(and(eq(morningReportOutbox.id, id), eq(morningReportOutbox.companyId, companyId)));
    if (!row) throw notFound("That report was not found.");
    return toOutboxItem(row);
  }

  function toStatus(status: string): MorningReportOutboxStatus {
    return status as MorningReportOutboxStatus;
  }

  async function ack(
    companyId: string,
    id: string,
    input: { outcome: "delivered" | "failed"; note?: string },
  ): Promise<{ id: string; status: MorningReportOutboxStatus }> {
    const [row] = await db
      .select()
      .from(morningReportOutbox)
      .where(and(eq(morningReportOutbox.id, id), eq(morningReportOutbox.companyId, companyId)));
    if (!row) throw notFound("That report was not found.");
    // Idempotent: a second acknowledgement (a retry after a lost answer)
    // changes nothing and is not an error.
    if (row.status !== "ready") return { id: row.id, status: toStatus(row.status) };
    const [updated] = await db
      .update(morningReportOutbox)
      .set({
        status: input.outcome,
        deliveredAt: input.outcome === "delivered" ? nowOf() : null,
        note: input.note ? [row.note, input.note].filter(Boolean).join(" ").slice(0, 1000) : row.note,
      })
      .where(and(eq(morningReportOutbox.id, row.id), eq(morningReportOutbox.status, "ready")))
      .returning();
    return { id: (updated ?? row).id, status: toStatus((updated ?? row).status) };
  }

  return { tick, composeReport, sendTestReportNow, outbox, getOne, ack };
}
