import {
  DEFAULT_TRADING_RISK_CONFIG,
  DEFAULT_TRADING_RULE_CONFIG,
  legacySmaCrossoverSpec,
  tradingRuleBookSchema,
  tradingSpecRequiredBars,
  tradingStrategySpecSchema,
  type TradingAsset,
  type TradingRuleBook,
  type TradingStrategySpec,
  type TradingTimeframe,
} from "@paperclipai/shared";

/** Helpers the strategy editor and the version list share: starting rules, checking, and plain-language problems. */

/** The rules a new strategy starts from: a simple "fast average moves past slow average" strategy the person then reshapes. */
export function starterSpec(name: string, asset: TradingAsset, timeframe: TradingTimeframe): TradingStrategySpec {
  const spec = legacySmaCrossoverSpec({ name: name || "New strategy", asset, timeframe, rule: DEFAULT_TRADING_RULE_CONFIG, risk: DEFAULT_TRADING_RISK_CONFIG });
  // The sample rules are meant to be edited; let the engine work out how much history it needs.
  const { warmupBars: _ignored, ...universe } = spec.universe;
  void _ignored;
  return { ...spec, universe, neverDo: {}, meta: { ...spec.meta, name, thesis: "" } };
}

/** Parses the rules of a stored version; null if they do not pass the current checks. */
export function parseStoredSpec(spec: unknown): TradingStrategySpec | null {
  const parsed = tradingStrategySpecSchema.safeParse(spec);
  return parsed.success ? parsed.data : null;
}

/**
 * After an edit: if the rules fix a history length that is now too short for
 * the slowest measure, lengthen it so the person is not blocked by a number
 * they cannot see.
 */
export function normalizeSpec(spec: TradingStrategySpec): TradingStrategySpec {
  const fixed = spec.universe.warmupBars;
  if (fixed === undefined) return spec;
  try {
    const need = tradingSpecRequiredBars(spec);
    return fixed < need ? { ...spec, universe: { ...spec.universe, warmupBars: Math.min(need, 500) } } : spec;
  } catch {
    return spec;
  }
}

const SECTION_BY_PATH: Record<string, string> = {
  meta: "About this strategy",
  universe: "What it watches",
  indicators: "What it watches",
  entry: "When it buys",
  exit: "When it sells",
  regimeGate: "When it stays out",
  stayOut: "When it stays out",
  neverDo: "Never do",
  sizing: "How much",
  prediction: "What it predicts",
  guidelines: "Your guidelines",
};

const KNOWN_MESSAGES: Array<[RegExp, string]> = [
  [/needs at least one way out/i, "It needs at least one way to sell: a safety stop, a profit goal, a moving stop, a time limit or sell rules."],
  [/Sizing by risk per trade needs a stop/i, "Sizing by what it is willing to lose needs a safety stop. Add one under “When it sells”."],
  [/target in R multiples needs a stop/i, "A profit goal measured against what it risked needs a safety stop. Add one under “When it sells”."],
  [/Measuring in stop distances needs a stop/i, "Measuring in distances to the safety stop needs a safety stop. Add one under “When it sells”."],
  [/target comes before the stop needs both/i, "Predicting whether the profit goal comes before the safety stop needs both a safety stop and a profit goal."],
  [/is not one of the indicators/i, "A rule uses something that is no longer measured. Pick another measure for it."],
  [/slowest indicator needs at least/i, "The slowest measure needs more history than the rules allow. Shorten it."],
  [/longest indicator needs more than/i, "The longest measure needs more than 500 candles of history. Shorten it."],
  [/Give the strategy a name/i, "Give the strategy a name."],
  [/List each coin once/i, "List each coin once."],
];

/** Zod's own wording ("Number must be…", "Invalid input") is not for people. */
const GENERIC_ZOD = /^(Number must|String must|Expected|Invalid|Required|Array must|Too (small|big)|Unrecognized)/;

export function plainProblem(path: Array<string | number>, message: string): string {
  const head = path[0] === "spec" ? path[1] : path[0];
  const section = typeof head === "string" ? SECTION_BY_PATH[head] : undefined;
  const known = KNOWN_MESSAGES.find(([pattern]) => pattern.test(message));
  const field = path.join(".").replace(/^spec\./, "");
  const text = field === "meta.name" && GENERIC_ZOD.test(message) ? "Give the strategy a name."
    : field === "meta.thesis" && GENERIC_ZOD.test(message) ? "Write a few words on why it should work."
    : known ? known[1] : GENERIC_ZOD.test(message) ? "A value is missing or outside what is allowed." : message;
  return section ? `${section}: ${text}` : text;
}

export type RuleBookCheck = { ok: true; book: TradingRuleBook; problems: [] } | { ok: false; problems: string[] };

/** Checks the whole rule book the way the server will, with problems in plain words (one per sentence, no repeats). */
export function checkRuleBook(spec: TradingStrategySpec, guidelines: string): RuleBookCheck {
  const result = tradingRuleBookSchema.safeParse({ spec, guidelines });
  if (result.success) return { ok: true, book: result.data, problems: [] };
  const problems = [...new Set(result.error.issues.map((i) => plainProblem(i.path, i.message)))];
  return { ok: false, problems };
}

export function proposerWords(type: "user" | "agent" | "system"): string {
  return type === "agent" ? "The Trading Analyst" : type === "system" ? "The system" : "A team member";
}
