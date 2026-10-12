import { z } from "zod";

/**
 * Morning report (DUR-4017): a daily briefing a quick agent sends to its
 * operator's Telegram chat at a configured local time — weather, headlines,
 * hobby news, sport, and price moves, written by one model call a day.
 *
 * This module is shared by the server (validation, the tick service) and the
 * board UI (the settings card in ui/src/components/MorningReportSection.tsx),
 * so both agree on the same shape and the same closed lists of sources/
 * topics/symbols.
 */

// ─── Closed choice lists (must match the UI's checkbox groups) ───────────────

export const MORNING_REPORT_SOURCES = [
  "nettavisen",
  "dagbladet",
  "bbc",
  "aljazeera",
  "pcmag",
  "financial_times",
  "android_central",
  "gizmodo",
  "zelda_dungeon",
  "techradar",
  "99bitcoins",
] as const;
export type MorningReportSource = (typeof MORNING_REPORT_SOURCES)[number];

/**
 * RSS feed for every source that has one. A source with no entry here
 * (financial_times) is search-only.
 *
 * DUR-4138: nettavisen's and dagbladet's old URLs both 404 now — verified
 * live (30 Sep 2026) that these two answer 200 with real RSS/XML:
 * nettavisen's own rss.nettavisen.no mirror, and dagbladet's `?lab_viewport=
 * rss` query param on its homepage (Labrador CMS's RSS switch). pcmag and
 * zelda_dungeon are both behind a Cloudflare bot challenge that a normal
 * browser User-Agent does not clear (verified live, same date) — fetchRss
 * falls back to web search for those two, see collectHeadlines.
 */
export const MORNING_REPORT_RSS_FEEDS: Partial<Record<MorningReportSource, string>> = {
  nettavisen: "https://www.nettavisen.no/service/rich-rss",
  dagbladet: "https://www.dagbladet.no/?lab_viewport=rss",
  bbc: "https://feeds.bbci.co.uk/news/world/rss.xml",
  aljazeera: "https://www.aljazeera.com/xml/rss/all.xml",
  pcmag: "https://www.pcmag.com/rss",
  android_central: "https://www.androidcentral.com/rss.xml",
  gizmodo: "https://gizmodo.com/rss",
  zelda_dungeon: "https://www.zeldadungeon.net/feed/",
  techradar: "https://www.techradar.com/rss",
  "99bitcoins": "https://99bitcoins.com/feed/",
};

export const MORNING_REPORT_TOPICS = ["crypto", "ai", "tech", "geopolitics"] as const;
export type MorningReportTopic = (typeof MORNING_REPORT_TOPICS)[number];

export const MORNING_REPORT_HOBBY_TOPICS = ["zelda", "pokemon", "one_piece", "vikings", "medieval", "lego_adults"] as const;
export type MorningReportHobbyTopic = (typeof MORNING_REPORT_HOBBY_TOPICS)[number];

export const MORNING_REPORT_SPORT_FOLLOWS = ["mats_zuccarello_nhl"] as const;
export type MorningReportSportFollow = (typeof MORNING_REPORT_SPORT_FOLLOWS)[number];

export const MORNING_REPORT_PRICE_SYMBOLS = ["BTC", "SOL", "ETH", "DNB.OL"] as const;
export type MorningReportPriceSymbol = (typeof MORNING_REPORT_PRICE_SYMBOLS)[number];

export const MORNING_REPORT_MIN_HEADLINES = 1;
export const MORNING_REPORT_MAX_HEADLINES = 10;

/**
 * DUR-4059: the default places whose weather is shown when no place override
 * is set — Filip's home (Drøbak) and where he works (Oslo). A place override
 * replaces this whole list with the one override place, same as before.
 */
export const MORNING_REPORT_DEFAULT_PLACES = ["Drøbak", "Oslo"] as const;

/**
 * DUR-4138: which picture to use for one report picture (weather or mood) —
 * a saved Media Studio look, a picture model picked directly (bypassing look
 * resolution for the model, e.g. Sogni "Dark Beat"), or the agent's own
 * default look (the same default every other picture the agent makes falls
 * back to — see laneA.makePicture's `look` param with nothing set).
 *
 * Kept in sync by hand with packages/plugins/media-studio/src/providers.ts's
 * PICTURE_SERVICES: packages/shared must not import from packages/plugins.
 */
export const MORNING_REPORT_PICTURE_PROVIDERS = ["fal", "sogni"] as const;
export type MorningReportPictureProvider = (typeof MORNING_REPORT_PICTURE_PROVIDERS)[number];

export const morningReportPictureSourceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("default") }).strict(),
    z.object({ kind: z.literal("look"), lookId: z.string().trim().min(1).max(120) }).strict(),
    z
      .object({
        kind: z.literal("model"),
        provider: z.enum(MORNING_REPORT_PICTURE_PROVIDERS),
        model: z.string().trim().min(1).max(200),
      })
      .strict(),
  ]);
export type MorningReportPictureSource = z.infer<typeof morningReportPictureSourceSchema>;

export const DEFAULT_MORNING_REPORT_PICTURE_SOURCE: MorningReportPictureSource = { kind: "default" };

function isValidTimeZone(tz: string): boolean {
  try {
    // eslint-disable-next-line no-new -- the constructor is the validation; it throws on an unknown zone.
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const morningReportTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be 24-hour HH:MM, e.g. 07:00.");

const morningReportIsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD.");

/**
 * agents.morning_report_settings, validated. Every field is required in the
 * schema itself (no server-side defaulting): the UI always writes the whole
 * object, and an array field being empty ("I unticked every source") is a
 * real, different choice from that field being absent.
 */
export const morningReportSettingsSchema = z
  .object({
    enabled: z.boolean(),
    time: morningReportTimeSchema,
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(isValidTimeZone, "Not a recognized IANA time zone, e.g. Europe/Oslo."),
    placeOverride: z.string().trim().min(1).max(120).nullable(),
    placeOverrideUntil: morningReportIsoDateSchema.nullable(),
    sources: z.array(z.enum(MORNING_REPORT_SOURCES)).max(MORNING_REPORT_SOURCES.length),
    topics: z.array(z.enum(MORNING_REPORT_TOPICS)).max(MORNING_REPORT_TOPICS.length),
    hobbyTopics: z.array(z.enum(MORNING_REPORT_HOBBY_TOPICS)).max(MORNING_REPORT_HOBBY_TOPICS.length),
    sportFollows: z.array(z.enum(MORNING_REPORT_SPORT_FOLLOWS)).max(MORNING_REPORT_SPORT_FOLLOWS.length),
    priceSymbols: z.array(z.enum(MORNING_REPORT_PRICE_SYMBOLS)).max(MORNING_REPORT_PRICE_SYMBOLS.length),
    maxHeadlines: z.number().int().min(MORNING_REPORT_MIN_HEADLINES).max(MORNING_REPORT_MAX_HEADLINES),
    /**
     * DUR-4138: per-picture look/model choice, added after every other field
     * here went live — `.optional()` (unlike the rest of this object) so an
     * agent's already-saved settings (written before the UI for this existed)
     * still parse instead of falling back to DEFAULT_MORNING_REPORT_SETTINGS
     * whole. Absent reads as `{ kind: "default" }` (the agent's own default
     * look) everywhere this is read — see resolvePictureSource in
     * morning-report.ts.
     */
    weatherPicture: morningReportPictureSourceSchema.optional(),
    moodPicture: morningReportPictureSourceSchema.optional(),
  })
  .strict();
export type MorningReportSettings = z.infer<typeof morningReportSettingsSchema>;

/** What an agent with the feature never configured (column is null) is treated as. */
export const DEFAULT_MORNING_REPORT_SETTINGS: MorningReportSettings = {
  enabled: false,
  time: "07:00",
  timezone: "Europe/Oslo",
  placeOverride: null,
  placeOverrideUntil: null,
  sources: [],
  topics: [],
  hobbyTopics: [],
  sportFollows: [],
  priceSymbols: [],
  maxHeadlines: 10,
  weatherPicture: DEFAULT_MORNING_REPORT_PICTURE_SOURCE,
  moodPicture: DEFAULT_MORNING_REPORT_PICTURE_SOURCE,
};

/** Read agents.morning_report_settings (an open jsonb column) into the typed shape; anything malformed or absent reads as "disabled". */
export function parseMorningReportSettings(value: unknown): MorningReportSettings {
  if (value === null || value === undefined) return DEFAULT_MORNING_REPORT_SETTINGS;
  const parsed = morningReportSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_MORNING_REPORT_SETTINGS;
}

/** DUR-4138: resolves an optional (not-yet-saved) picture-source field to its default — the agent's own default look. */
export function resolveMorningReportPictureSource(source: MorningReportPictureSource | undefined): MorningReportPictureSource {
  return source ?? DEFAULT_MORNING_REPORT_PICTURE_SOURCE;
}

// ─── What the API answers with ───────────────────────────────────────────────

export const MORNING_REPORT_OUTBOX_STATUSES = ["ready", "delivered", "failed", "expired"] as const;
export type MorningReportOutboxStatus = (typeof MORNING_REPORT_OUTBOX_STATUSES)[number];

/** One clickable headline, hobby-news or sport item, with its source kept for the reader. */
export interface MorningReportFactItem {
  title: string;
  url: string;
  source: string;
  /**
   * One-sentence, model-written summary of this item (DUR-4059 direction
   * change) — only ever populated for headlines, and only when the one
   * summaries model call succeeded, was not truncated, and its JSON parsed.
   * Missing/null means "title and link only", which is always safe to send:
   * nothing Filip needs ever depends on this field being present.
   */
  summary?: string | null;
}

/** One historical reading for a price's sparkline — oldest first. */
export interface MorningReportPricePoint {
  price: number;
  observedAt: string;
}

/** One price line: the symbol as the operator picked it (e.g. "DNB.OL"), not the upstream source's own spelling. */
export interface MorningReportPriceFact {
  symbol: string;
  price: number;
  currency: string;
  /** Null when no ~24h-ago reading was available to compare against. */
  changePercent: number | null;
  /** Short history for a sparkline, oldest first. Empty when none was available (see notes for why). */
  history: MorningReportPricePoint[];
}

/** One picture the report carries: Maja dressed for today's weather, or a mood illustration for the news. */
export interface MorningReportImageFact {
  /** issue_attachments id — same fileId shape as a Lane A chat picture (LaneAToolImage). */
  fileId: string;
  caption: string;
  kind: "weather" | "mood";
}

/** One place's weather, now plus up to 3 days — see formatWeatherReport (server/src/services/lane-a-tools.ts). */
export interface MorningReportWeatherFact {
  place: string;
  text: string;
}

/** "sources checked: N, items found: M" — so a thin headline day is visible rather than silently short. */
export interface MorningReportStats {
  sourcesChecked: number;
  itemsFound: number;
}

/**
 * Everything a report is built from, kept structured (not just flattened into
 * prose) so the Telegram bridge can render a short teaser plus a link, and so
 * the full briefing page can show every item with its source, independent of
 * what any model call chose to mention. Every list here is built entirely in
 * code from fetched data — never from a model — so nothing Filip needs can be
 * lost to a model call failing, running out of tokens, or being truncated.
 */
export interface MorningReportFacts {
  /** One place (a place override), or the default two (Drøbak, Oslo) — see MORNING_REPORT_DEFAULT_PLACES. */
  places: string[];
  weather: MorningReportWeatherFact[];
  headlines: MorningReportFactItem[];
  hobby: MorningReportFactItem[];
  sport: MorningReportFactItem[];
  prices: MorningReportPriceFact[];
  images: MorningReportImageFact[];
  /** 3-5 sentence, model-written opening. Falls back to a short deterministic sentence when the model call fails or is truncated. */
  opening: string;
  /**
   * The short (at most a few lines), plain-text teaser sent to Telegram —
   * today's weather in both places, the single most important headline, and
   * one price move. Built entirely in code, never by a model. The Telegram
   * bridge appends the briefing-page link itself, only when briefingPageLive
   * is true.
   */
  teaser: string;
  stats: MorningReportStats;
  /** Whether the full briefing page (DUR-4075) is live yet — the Telegram bridge must not link to it until this is true. */
  briefingPageLive: boolean;
  /** Plain-language notes about anything that degraded (a source down, no key configured, a model call failing or truncating, …). */
  notes: string[];
  /** DUR-4467: "DUR-4378 is 60% done, about 1 day left" lines for in-progress parents with sub-tasks (>=2 done). */
  progressLines?: string[];
}

/** One report waiting in the outbox for the Telegram bridge. */
export interface MorningReportOutboxItem {
  id: string;
  companyId: string;
  /** The quick agent whose bot should send it. */
  agentId: string;
  text: string;
  /** Structured facts for the Telegram bridge's per-section messages and the full briefing page. Null for a report written before DUR-4059. */
  facts: MorningReportFacts | null;
  /**
   * The Lane A conversation the report was appended to as an assistant turn
   * (when the agent is a quick agent and the company has a board owner), so
   * "tell me more about number 3" in Telegram continues the same chat
   * history the report is part of. Null when it could not be created.
   */
  conversationId: string | null;
  createdAt: string;
}

export const ackMorningReportOutboxSchema = z
  .object({
    outcome: z.enum(["delivered", "failed"]),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export type AckMorningReportOutboxInput = z.infer<typeof ackMorningReportOutboxSchema>;
