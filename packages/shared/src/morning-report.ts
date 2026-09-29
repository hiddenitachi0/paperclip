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

/** RSS feed for every source that has one. A source with no entry here (financial_times) is search-only. */
export const MORNING_REPORT_RSS_FEEDS: Partial<Record<MorningReportSource, string>> = {
  nettavisen: "https://www.nettavisen.no/rss.xml",
  dagbladet: "https://www.dagbladet.no/rss",
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
};

/** Read agents.morning_report_settings (an open jsonb column) into the typed shape; anything malformed or absent reads as "disabled". */
export function parseMorningReportSettings(value: unknown): MorningReportSettings {
  if (value === null || value === undefined) return DEFAULT_MORNING_REPORT_SETTINGS;
  const parsed = morningReportSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_MORNING_REPORT_SETTINGS;
}

// ─── What the API answers with ───────────────────────────────────────────────

export const MORNING_REPORT_OUTBOX_STATUSES = ["ready", "delivered", "failed", "expired"] as const;
export type MorningReportOutboxStatus = (typeof MORNING_REPORT_OUTBOX_STATUSES)[number];

/** One clickable headline, hobby-news or sport item, with its source kept for the reader. */
export interface MorningReportFactItem {
  title: string;
  url: string;
  source: string;
}

/** One price line: the symbol as the operator picked it (e.g. "DNB.OL"), not the upstream source's own spelling. */
export interface MorningReportPriceFact {
  symbol: string;
  price: number;
  currency: string;
  /** Null when no ~24h-ago reading was available to compare against. */
  changePercent: number | null;
}

/** One picture the report carries: Maja dressed for today's weather, or a mood illustration for the news. */
export interface MorningReportImageFact {
  /** issue_attachments id — same fileId shape as a Lane A chat picture (LaneAToolImage). */
  fileId: string;
  caption: string;
  kind: "weather" | "mood";
}

/**
 * Everything the one model call read facts from, kept structured (not just
 * flattened into the written prose) so the Telegram bridge can render clickable
 * links/photos section by section, and so the full briefing page can show every
 * item with its source, independent of what the model chose to mention.
 */
export interface MorningReportFacts {
  /** One place (a place override), or the default two (Drøbak, Oslo) — see MORNING_REPORT_DEFAULT_PLACES. */
  places: string[];
  weatherText: string | null;
  headlines: MorningReportFactItem[];
  hobby: MorningReportFactItem[];
  sport: MorningReportFactItem[];
  prices: MorningReportPriceFact[];
  images: MorningReportImageFact[];
  /** Plain-language notes about anything that degraded (a source down, no key configured, …). */
  notes: string[];
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
