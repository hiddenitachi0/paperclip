import { z } from "zod";

/**
 * Watchers: cheap scheduled checks of a market price that tell the operator on
 * Telegram, in a quick agent's voice (and with a picture if asked), only when
 * a rule fires.
 *
 * A check costs no AI at all: the price is fetched from a free source and the
 * rule is evaluated in code. Only an alert costs one quick-agent call (plus
 * one picture when the watcher asks for one).
 *
 * This module is shared by the server (validation, rule wording) and the
 * board UI (the plain-language rule builder), so both say the same thing.
 */

// ─── Sources ─────────────────────────────────────────────────────────────────

export const WATCHER_SOURCES = ["crypto", "us_stock", "oslo_stock"] as const;
export type WatcherSource = (typeof WATCHER_SOURCES)[number];

export interface WatcherSourceInfo {
  source: WatcherSource;
  /** What the operator sees. */
  label: string;
  /** False = shown as "not available yet"; the server refuses new watchers on it. */
  available: boolean;
  /** True when the source needs a key saved as a company secret. */
  needsKey: boolean;
  /** Plain words: where prices come from, or why the source is not available. */
  note: string;
  /** Currency prices are in. */
  currency: string;
  /** The shortest check interval that makes sense for this source (its data or its free limits). */
  minCheckMinutes: number;
  /** What the key is called on screen, when the source needs one. */
  keyLabel: string | null;
  /** How to type a symbol, for the form. */
  symbolHint: string;
}

export const WATCHER_SOURCE_INFO: Record<WatcherSource, WatcherSourceInfo> = {
  crypto: {
    source: "crypto",
    label: "Crypto",
    available: true,
    needsKey: false,
    note: "Prices from CoinGecko (free, no key), with Binance as the backup. Prices in US dollars.",
    currency: "USD",
    minCheckMinutes: 5,
    keyLabel: null,
    symbolHint: "Pick a coin.",
  },
  us_stock: {
    source: "us_stock",
    label: "US stocks",
    available: true,
    needsKey: true,
    note:
      "Prices from Finnhub during US trading hours. Needs a free Finnhub key (sign up at finnhub.io), saved as a company secret. Prices in US dollars.",
    currency: "USD",
    minCheckMinutes: 5,
    keyLabel: "Finnhub key",
    symbolHint: "The ticker, for example AAPL or MSFT.",
  },
  oslo_stock: {
    source: "oslo_stock",
    label: "Oslo Børs (closing prices)",
    available: true,
    needsKey: true,
    note:
      "Closing prices from EODHD, once a day after Oslo Børs closes. Needs a free EODHD key (sign up at eodhd.com; the free plan is for personal use and allows 20 price requests a day). " +
      "There is no free source for Oslo prices during the day, so a 24-hour rule here means \"since the day before's close\". Prices in Norwegian kroner.",
    currency: "NOK",
    minCheckMinutes: 360,
    keyLabel: "EODHD key",
    symbolHint: "The Oslo Børs ticker, for example DNB or EQNR.",
  },
};

/** The coins a crypto watcher can follow, with the id each price source uses. */
export interface WatcherCoin {
  symbol: string;
  name: string;
  /** CoinGecko's coin id (api.coingecko.com /simple/price?ids=...). */
  coingeckoId: string;
  /** Binance spot pair against USDT, the backup source. */
  binancePair: string;
}

export const WATCHER_CRYPTO_COINS: readonly WatcherCoin[] = [
  { symbol: "BTC", name: "Bitcoin", coingeckoId: "bitcoin", binancePair: "BTCUSDT" },
  { symbol: "ETH", name: "Ethereum", coingeckoId: "ethereum", binancePair: "ETHUSDT" },
  { symbol: "SOL", name: "Solana", coingeckoId: "solana", binancePair: "SOLUSDT" },
  { symbol: "XRP", name: "XRP", coingeckoId: "ripple", binancePair: "XRPUSDT" },
  { symbol: "BNB", name: "BNB", coingeckoId: "binancecoin", binancePair: "BNBUSDT" },
  { symbol: "ADA", name: "Cardano", coingeckoId: "cardano", binancePair: "ADAUSDT" },
  { symbol: "DOGE", name: "Dogecoin", coingeckoId: "dogecoin", binancePair: "DOGEUSDT" },
  { symbol: "TRX", name: "TRON", coingeckoId: "tron", binancePair: "TRXUSDT" },
  { symbol: "AVAX", name: "Avalanche", coingeckoId: "avalanche-2", binancePair: "AVAXUSDT" },
  { symbol: "DOT", name: "Polkadot", coingeckoId: "polkadot", binancePair: "DOTUSDT" },
  { symbol: "LINK", name: "Chainlink", coingeckoId: "chainlink", binancePair: "LINKUSDT" },
  { symbol: "LTC", name: "Litecoin", coingeckoId: "litecoin", binancePair: "LTCUSDT" },
];

export function findWatcherCoin(symbol: string): WatcherCoin | null {
  const wanted = symbol.trim().toUpperCase();
  return WATCHER_CRYPTO_COINS.find((coin) => coin.symbol === wanted) ?? null;
}

/** A US ticker: letters first, then letters, digits, a dot or a dash (BRK.B). */
export const WATCHER_US_STOCK_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;
/** An Oslo Børs ticker as the exchange writes it (DNB, EQNR, AKER-BP is written AKRBP). */
export const WATCHER_OSLO_STOCK_SYMBOL_PATTERN = /^[A-Z][A-Z0-9-]{0,9}$/;

/** The name to use in sentences: "Bitcoin" for BTC, the ticker for a stock. */
export function watcherSymbolName(source: WatcherSource, symbol: string): string {
  if (source === "crypto") return findWatcherCoin(symbol)?.name ?? symbol;
  return symbol;
}

// ─── Limits ──────────────────────────────────────────────────────────────────

/** The shortest time between two checks of one watcher. */
export const WATCHER_MIN_CHECK_MINUTES = 5;
export const WATCHER_MAX_CHECK_MINUTES = 24 * 60;
export const WATCHER_DEFAULT_CHECK_MINUTES = 15;
export const WATCHER_MAX_COOLDOWN_MINUTES = 7 * 24 * 60;
export const WATCHER_DEFAULT_COOLDOWN_MINUTES = 6 * 60;
/** Longest window a percent-change rule can look back over. */
export const WATCHER_MAX_WINDOW_HOURS = 7 * 24;
/** Hard ceiling on alerts (test alerts included) per watcher per UTC day, whatever the rule says. */
export const WATCHER_MAX_ALERTS_PER_DAY = 12;
/** Most watchers one company can have. */
export const WATCHER_MAX_PER_COMPANY = 50;

// ─── Rules ───────────────────────────────────────────────────────────────────

export const WATCHER_RULE_KINDS = ["change", "level", "since_last_alert"] as const;
export type WatcherRuleKind = (typeof WATCHER_RULE_KINDS)[number];

export const watcherRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("change"),
      direction: z.enum(["up", "down", "either"]),
      percent: z.number().min(0.1, "Use at least 0.1%.").max(99, "Use at most 99%."),
      windowHours: z
        .number()
        .int("Use whole hours.")
        .min(1, "Use at least 1 hour.")
        .max(WATCHER_MAX_WINDOW_HOURS, `Use at most ${WATCHER_MAX_WINDOW_HOURS} hours (7 days).`),
    })
    .strict(),
  z
    .object({
      kind: z.literal("level"),
      direction: z.enum(["above", "below"]),
      price: z.number().positive("The price must be above zero.").max(1e12),
    })
    .strict(),
  z
    .object({
      kind: z.literal("since_last_alert"),
      percent: z.number().min(0.1, "Use at least 0.1%.").max(99, "Use at most 99%."),
    })
    .strict(),
]);
export type WatcherRule = z.infer<typeof watcherRuleSchema>;

function formatPercent(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}

function formatHours(hours: number): string {
  if (hours % 24 === 0 && hours >= 24) {
    const days = hours / 24;
    return days === 1 ? "24 hours" : `${days} days`;
  }
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** A price as people write it: "$87,300", "$0.1523", "NOK 312.40". */
export function formatWatcherPrice(price: number, currency: string): string {
  const abs = Math.abs(price);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 8;
  const number = price.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return currency === "USD" ? `$${number}` : `${currency} ${number}`;
}

/** The rule in one plain sentence: "Bitcoin rises 5% or more within 24 hours". */
export function describeWatcherRule(rule: WatcherRule, subject: string, currency = "USD"): string {
  switch (rule.kind) {
    case "change": {
      const verb = rule.direction === "up" ? "rises" : rule.direction === "down" ? "falls" : "moves";
      const tail = rule.direction === "either" ? " (up or down)" : "";
      return `${subject} ${verb} ${formatPercent(rule.percent)} or more${tail} within ${formatHours(rule.windowHours)}`;
    }
    case "level":
      return `${subject} goes ${rule.direction} ${formatWatcherPrice(rule.price, currency)}`;
    case "since_last_alert":
      return `${subject} moves ${formatPercent(rule.percent)} or more (up or down) since the last alert`;
  }
}

// ─── Create / update ─────────────────────────────────────────────────────────

const watcherFields = {
  name: z.string().trim().min(1, "Give the watcher a name.").max(80, "Keep the name to 80 characters."),
  agentId: z.string().uuid("Pick the quick agent that sends the alerts."),
  source: z.enum(WATCHER_SOURCES),
  symbol: z
    .string()
    .trim()
    .min(1, "Pick what to watch.")
    .max(12)
    .transform((value) => value.toUpperCase()),
  rule: watcherRuleSchema,
  checkEveryMinutes: z
    .number()
    .int()
    .min(WATCHER_MIN_CHECK_MINUTES, `Check at most every ${WATCHER_MIN_CHECK_MINUTES} minutes.`)
    .max(WATCHER_MAX_CHECK_MINUTES, "Check at least once a day."),
  cooldownMinutes: z
    .number()
    .int()
    .min(0)
    .max(WATCHER_MAX_COOLDOWN_MINUTES, "Use a quiet time of at most 7 days."),
  enabled: z.boolean(),
  withPicture: z.boolean(),
  /** The company secret holding the source's key (US stocks). Never a key value. */
  keySecretId: z.string().uuid().nullable(),
};

export const createWatcherSchema = z
  .object({
    ...watcherFields,
    checkEveryMinutes: watcherFields.checkEveryMinutes.default(WATCHER_DEFAULT_CHECK_MINUTES),
    cooldownMinutes: watcherFields.cooldownMinutes.default(WATCHER_DEFAULT_COOLDOWN_MINUTES),
    enabled: watcherFields.enabled.default(true),
    withPicture: watcherFields.withPicture.default(false),
    keySecretId: watcherFields.keySecretId.optional().default(null),
  })
  .strict();
export type CreateWatcherInput = z.infer<typeof createWatcherSchema>;

export const updateWatcherSchema = z
  .object({
    name: watcherFields.name,
    agentId: watcherFields.agentId,
    source: watcherFields.source,
    symbol: watcherFields.symbol,
    rule: watcherFields.rule,
    checkEveryMinutes: watcherFields.checkEveryMinutes,
    cooldownMinutes: watcherFields.cooldownMinutes,
    enabled: watcherFields.enabled,
    withPicture: watcherFields.withPicture,
    keySecretId: watcherFields.keySecretId,
  })
  .partial()
  .strict();
export type UpdateWatcherInput = z.infer<typeof updateWatcherSchema>;

/**
 * The part of a watcher that only makes sense as a whole: the symbol must fit
 * the source. Returns a plain sentence, or null when it fits.
 */
export function watcherSymbolProblem(source: WatcherSource, symbol: string): string | null {
  if (!WATCHER_SOURCE_INFO[source].available) {
    return `${WATCHER_SOURCE_INFO[source].label} is not available yet. ${WATCHER_SOURCE_INFO[source].note}`;
  }
  if (source === "crypto") {
    return findWatcherCoin(symbol)
      ? null
      : `Pick one of the listed coins: ${WATCHER_CRYPTO_COINS.map((coin) => coin.symbol).join(", ")}.`;
  }
  if (source === "oslo_stock") {
    return WATCHER_OSLO_STOCK_SYMBOL_PATTERN.test(symbol)
      ? null
      : "Type the Oslo Børs ticker, for example DNB or EQNR.";
  }
  return WATCHER_US_STOCK_SYMBOL_PATTERN.test(symbol)
    ? null
    : "Type the stock's ticker, for example AAPL or MSFT.";
}

/** A check interval below what the source supports, in a plain sentence; null when it fits. */
export function watcherCheckEveryProblem(source: WatcherSource, checkEveryMinutes: number): string | null {
  const min = WATCHER_SOURCE_INFO[source].minCheckMinutes;
  if (checkEveryMinutes >= min) return null;
  const hours = min / 60;
  return `${WATCHER_SOURCE_INFO[source].label} can be checked at most every ${
    min % 60 === 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${min} minutes`
  }.`;
}

/** The rule the form starts with: "moves 5% or more (up or down) within 24 hours". */
export const WATCHER_DEFAULT_RULE: WatcherRule = { kind: "change", direction: "either", percent: 5, windowHours: 24 };

// ─── What the API answers with ───────────────────────────────────────────────

export const WATCHER_ALERT_STATUSES = ["composing", "ready", "delivered", "failed", "expired"] as const;
export type WatcherAlertStatus = (typeof WATCHER_ALERT_STATUSES)[number];

/** The facts of one alert, as computed in code. The agent may word them, never change them. */
export interface WatcherAlertFacts {
  watcherName: string;
  source: WatcherSource;
  symbol: string;
  subject: string;
  currency: string;
  price: number;
  /** The price the move is measured from, when there is one. */
  basePrice: number | null;
  /** Signed percent change from basePrice, when there is one. */
  changePercent: number | null;
  /** Hours the change was measured over, when the rule has a window. */
  windowHours: number | null;
  ruleText: string;
  isTest: boolean;
  observedAt: string;
}

export interface WatcherAlertSummary {
  id: string;
  watcherId: string;
  status: WatcherAlertStatus;
  isTest: boolean;
  text: string | null;
  hasPicture: boolean;
  /** Plain words about anything that did not go to plan (no picture, agent could not write it). */
  note: string | null;
  createdAt: string;
  readyAt: string | null;
  deliveredAt: string | null;
}

export interface WatcherSummary {
  id: string;
  companyId: string;
  agentId: string;
  agentName: string | null;
  name: string;
  source: WatcherSource;
  symbol: string;
  subject: string;
  currency: string;
  rule: WatcherRule;
  ruleText: string;
  checkEveryMinutes: number;
  cooldownMinutes: number;
  enabled: boolean;
  withPicture: boolean;
  keySecretId: string | null;
  lastPrice: number | null;
  lastPriceAt: string | null;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  /** Plain words about the last check when it did not work. */
  lastCheckMessage: string | null;
  lastAlertAt: string | null;
  nextCheckAt: string | null;
  checksToday: number;
  alertsToday: number;
  recentAlerts: WatcherAlertSummary[];
  createdAt: string;
  updatedAt: string;
}

/** One alert waiting in the outbox for the Telegram bridge. */
export interface WatcherOutboxItem {
  id: string;
  companyId: string;
  watcherId: string;
  watcherName: string;
  /** The quick agent whose bot should send it. */
  agentId: string;
  text: string;
  /** A picture in the company's Files (fetched by the bridge with `chat image`), or null. */
  imageFileId: string | null;
  isTest: boolean;
  createdAt: string;
}

export const ackWatcherOutboxSchema = z
  .object({
    outcome: z.enum(["delivered", "failed"]),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export type AckWatcherOutboxInput = z.infer<typeof ackWatcherOutboxSchema>;
