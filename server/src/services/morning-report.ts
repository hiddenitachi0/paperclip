import { and, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, morningReportOutbox, runInPooledScope, watcherPricePoints, watchers } from "@paperclipai/db";
import {
  MORNING_REPORT_DEFAULT_PLACE,
  MORNING_REPORT_RSS_FEEDS,
  parseMorningReportSettings,
  type MorningReportHobbyTopic,
  type MorningReportOutboxItem,
  type MorningReportOutboxStatus,
  type MorningReportPriceSymbol,
  type MorningReportSettings,
  type MorningReportSource,
  type MorningReportSportFollow,
  type MorningReportTopic,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { formatWeatherReport } from "./lane-a-tools.js";
import { laneAService } from "./lane-a.js";
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
/** ~1024 output tokens, expressed as the chars-equivalent lane-a.ts's transform() takes (see resolveTransformMaxTokens). */
const MAX_OUTPUT_CHARS_FOR_1024_TOKENS = 1024 * 4;
const HOBBY_MAX_AGE_HOURS = 24 * 7;
const SEARCH_RESULTS_PER_SOURCE = 5;

/** Instructions for the one model call a report costs. The facts travel as data, never in here. */
export const MORNING_REPORT_TASK =
  "You write one daily morning briefing message to the person you work for, in English, using only the facts given below. " +
  "Organize it with short, clearly labelled sections (for example Weather, Headlines, Hobby news, Sport, Prices) in whatever " +
  "order reads best. Use the facts exactly as given: do not invent, round differently, or add any number, headline or fact " +
  "not present below. Keep it skimmable — plain prose or short bullet points, at most a few sentences per section. If a " +
  "section has no facts, leave it out entirely rather than saying there is nothing to report.";

export interface MorningReportServiceDeps extends WebSearchServiceDeps {
  now?: () => Date;
  fetchImpl?: typeof fetch;
  laneA?: { transform: ReturnType<typeof laneAService>["transform"] };
  webSearch?: { search: ReturnType<typeof webSearchService>["search"] };
  /** Test seam: how a claimed report is handed off. Production detaches it onto the pool. */
  dispatch?: (work: () => Promise<void>) => void;
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

function resolvePlace(settings: MorningReportSettings, localDate: string): string {
  if (!settings.placeOverride) return MORNING_REPORT_DEFAULT_PLACE;
  if (settings.placeOverrideUntil && settings.placeOverrideUntil < localDate) return MORNING_REPORT_DEFAULT_PLACE;
  return settings.placeOverride;
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

async function fetchRss(fetchImpl: typeof fetch, url: string, limit: number): Promise<RssItem[]> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
  });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  return parseRssItems(await response.text(), limit);
}

async function fetchWeatherSection(fetchImpl: typeof fetch, place: string): Promise<{ text: string | null; note: string | null }> {
  try {
    const geo = (await fetchJson(
      fetchImpl,
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`,
    )) as { results?: Array<{ name: string; latitude: number; longitude: number; country?: string; admin1?: string }> };
    const found = geo.results?.[0];
    if (!found) return { text: null, note: `Weather: could not find a place called "${place}".` };
    const forecast = await fetchJson(
      fetchImpl,
      `https://api.open-meteo.com/v1/forecast?latitude=${found.latitude}&longitude=${found.longitude}` +
        `&current=temperature_2m,wind_speed_10m,precipitation,weather_code` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code&forecast_days=3&timezone=auto`,
    );
    return { text: formatWeatherReport(found, forecast), note: null };
  } catch (err) {
    return { text: null, note: `Weather: the forecast service did not answer (${err instanceof Error ? err.message : "unknown reason"}).` };
  }
}

type BraveSearch = (query: string) => Promise<{ title: string; url: string }[]>;

async function collectHeadlines(params: {
  sources: MorningReportSource[];
  topics: MorningReportTopic[];
  maxHeadlines: number;
  fetchImpl: typeof fetch;
  braveSearch: BraveSearch;
}): Promise<{ items: { title: string; url: string; source: MorningReportSource }[]; notes: string[] }> {
  const notes: string[] = [];
  const collected: { title: string; url: string; source: MorningReportSource; pubDate: string | null }[] = [];
  for (const source of params.sources) {
    const feed = MORNING_REPORT_RSS_FEEDS[source];
    try {
      if (feed) {
        for (const item of await fetchRss(params.fetchImpl, feed, 20)) collected.push({ ...item, source });
      } else {
        for (const result of await params.braveSearch(`${source} news`)) {
          collected.push({ title: result.title, url: result.url, source, pubDate: null });
        }
      }
    } catch (err) {
      notes.push(`${source}: could not fetch headlines (${err instanceof Error ? err.message : "unknown reason"}).`);
    }
  }
  const onTopic = collected.filter((item) => matchesMorningReportTopics(item.title, params.topics));
  const items = dedupeHeadlines(onTopic).slice(0, params.maxHeadlines).map(({ title, url, source }) => ({ title, url, source }));
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
    } catch (err) {
      notes.push(`Hobby (zelda): could not fetch (${err instanceof Error ? err.message : "unknown reason"}).`);
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

async function collectPrices(
  db: Db,
  companyId: string,
  symbols: MorningReportPriceSymbol[],
  fetchImpl: typeof fetch,
  now: Date,
): Promise<{ lines: string[]; notes: string[] }> {
  if (symbols.length === 0) return { lines: [], notes: [] };
  const lines: string[] = [];
  const notes: string[] = [];
  for (const symbol of symbols) {
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
      if (base) {
        const change = ((latest.price - base.price) / base.price) * 100;
        lines.push(`${symbol}: ${latest.price} (${change >= 0 ? "+" : ""}${change.toFixed(2)}% vs ~24h ago)`);
      } else {
        lines.push(`${symbol}: ${latest.price} (no ~24h-old price yet to compare)`);
      }
      continue;
    }
    try {
      const quotes = await WATCHER_PRICE_SOURCES.crypto.fetchQuotes({ symbols: [symbol], now }, { fetchImpl });
      const quote = quotes.get(symbol);
      if (quote && !isWatcherQuoteError(quote)) {
        lines.push(`${symbol}: ${quote.price} (no price history yet to compare)`);
      } else {
        notes.push(`${symbol}: no price available (no watcher history, and it is not a known live-quote symbol).`);
      }
    } catch {
      notes.push(`${symbol}: no price available right now.`);
    }
  }
  return { lines, notes };
}

function formatFactsAsPlainText(sections: {
  weather: string | null;
  headlines: { title: string }[];
  hobby: { title: string }[];
  sport: { title: string }[];
  prices: string[];
}): string {
  const parts: string[] = [];
  if (sections.weather) parts.push(`Weather:\n${sections.weather}`);
  if (sections.headlines.length > 0) parts.push(`Headlines:\n${sections.headlines.map((h) => `- ${h.title}`).join("\n")}`);
  if (sections.hobby.length > 0) parts.push(`Hobby news:\n${sections.hobby.map((h) => `- ${h.title}`).join("\n")}`);
  if (sections.sport.length > 0) parts.push(`Sport:\n${sections.sport.map((h) => `- ${h.title}`).join("\n")}`);
  if (sections.prices.length > 0) parts.push(`Prices:\n${sections.prices.join("\n")}`);
  return parts.length > 0 ? parts.join("\n\n") : "Nothing to report today.";
}

// ─── The service ────────────────────────────────────────────────────────────

export function morningReportService(db: Db, deps: MorningReportServiceDeps = {}) {
  const laneA = deps.laneA ?? laneAService(db);
  const webSearch = deps.webSearch ?? webSearchService(db, deps);
  const nowOf = () => deps.now?.() ?? new Date();
  const fetchImpl = deps.fetchImpl ?? fetch;
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

  async function composeReport(agentRow: AgentRow, settings: MorningReportSettings, localDate: string, now: Date): Promise<void> {
    const braveSearch = braveSearchFor(agentRow.companyId, agentRow.id);
    const place = resolvePlace(settings, localDate);
    const [weather, headlines, hobby, sport, prices] = await Promise.all([
      fetchWeatherSection(fetchImpl, place),
      collectHeadlines({ sources: settings.sources, topics: settings.topics, maxHeadlines: settings.maxHeadlines, fetchImpl, braveSearch }),
      collectHobbyNews({ hobbyTopics: settings.hobbyTopics, fetchImpl, braveSearch, now }),
      collectSportNews({ sportFollows: settings.sportFollows, braveSearch }),
      collectPrices(db, agentRow.companyId, settings.priceSymbols, fetchImpl, now),
    ]);
    const notes: string[] = [];
    if (weather.note) notes.push(weather.note);
    notes.push(...headlines.notes, ...hobby.notes, ...sport.notes, ...prices.notes);

    const factsText = formatFactsAsPlainText({
      weather: weather.text,
      headlines: headlines.items,
      hobby: hobby.items,
      sport: sport.items,
      prices: prices.lines,
    });

    let text = factsText;
    if (!agentRow.laneAEnabled) {
      notes.push("This agent is not a quick agent any more, so the facts were sent as they are.");
    } else {
      try {
        const written = await laneA.transform({
          companyId: agentRow.companyId,
          targetAgent: {
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
          },
          input: factsText,
          task: MORNING_REPORT_TASK,
          // One call a day; capped at min(the agent's own laneAMaxOutputTokens,
          // 1024) — transform()'s maxOutputChars already takes the min of the
          // agent's resolved token cap and this chars-equivalent budget (see
          // resolveTransformMaxTokens in lane-a.ts).
          maxOutputChars: MAX_OUTPUT_CHARS_FOR_1024_TOKENS,
        });
        const words = written.text.trim();
        if (words) text = words;
        else notes.push(`${agentRow.name} gave no text, so the facts were sent as they are.`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "unknown reason";
        notes.push(`${agentRow.name} could not write this one (${reason.slice(0, 200)}), so the facts were sent as they are.`);
      }
    }

    await db.insert(morningReportOutbox).values({
      companyId: agentRow.companyId,
      agentId: agentRow.id,
      status: "ready",
      text,
      note: notes.length > 0 ? notes.join(" ").slice(0, 1000) : null,
      createdAt: now,
      readyAt: now,
    });
    await db
      .update(agents)
      .set({ morningReportLastSentDate: localDate, morningReportLeaseUntil: null })
      .where(eq(agents.id, agentRow.id));
    await logActivity(db, {
      companyId: agentRow.companyId,
      actorType: "system",
      actorId: "morning-report",
      action: "morning_report.sent",
      entityType: "agent",
      entityId: agentRow.id,
      agentId: agentRow.id,
      details: { localDate },
    }).catch(() => undefined);
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

  async function tick(now: Date = nowOf()) {
    const expired = await expireStaleOutbox(now);
    const due = await claimDueAgents(now);
    for (const { row, localDate } of due) {
      dispatchCompose(row, parseMorningReportSettings(row.morningReportSettings), localDate, now);
    }
    return { fired: due.length, expired };
  }

  // ─── Outbox (the Telegram bridge) ───────────────────────────────────────

  async function outbox(companyId: string): Promise<MorningReportOutboxItem[]> {
    const cutoff = new Date(nowOf().getTime() - MORNING_REPORT_OUTBOX_MAX_AGE_MS);
    const rows = await db
      .select()
      .from(morningReportOutbox)
      .where(and(eq(morningReportOutbox.companyId, companyId), eq(morningReportOutbox.status, "ready"), gte(morningReportOutbox.readyAt, cutoff)))
      .orderBy(morningReportOutbox.createdAt)
      .limit(OUTBOX_BATCH);
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      agentId: row.agentId,
      text: row.text,
      createdAt: row.createdAt.toISOString(),
    }));
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

  return { tick, composeReport, outbox, ack };
}
