import {
  DEFAULT_TRADING_RISK_CONFIG,
  deriveTradingRiskConfig,
  type TradingCondition,
  type TradingConditionGroup,
  type TradingIndicatorDefinition,
  type TradingOperand,
  type TradingStrategySpec,
  type TradingTimeframe,
} from "@paperclipai/shared";

/**
 * One place that turns a strategy's rules into plain words. The editor's
 * read-back sentence, the version history and the "what changed" lines all
 * come from here, so the same rules always read the same way. Pure functions
 * of the rules; nothing here touches the network or the clock.
 */

export const TIMEFRAME_WORDS: Record<TradingTimeframe, string> = {
  "15m": "15-minute",
  "1h": "1-hour",
  "4h": "4-hour",
  "1d": "1-day",
};

export const PRICE_FIELD_WORDS = {
  open: "the opening price",
  high: "the highest price",
  low: "the lowest price",
  close: "the closing price",
  volume: "the amount traded",
} as const;

const CANDLES = (n: number) => `${n} candle${n === 1 ? "" : "s"}`;

/** A short name for an indicator, used inside sentences ("the 20-candle average price"). */
export function indicatorPhrase(def: TradingIndicatorDefinition): string {
  switch (def.kind) {
    case "sma":
      return `the ${def.period}-candle average price`;
    case "ema":
      return `the ${def.period}-candle smoothed average price`;
    case "rsi":
      return `the ${def.period}-candle strength meter`;
    case "atr":
      return `the average candle size (${CANDLES(def.period)})`;
    case "adx":
      return def.output === "adx"
        ? `the trend strength (${CANDLES(def.period)})`
        : def.output === "plus_di"
          ? `the upward push (${CANDLES(def.period)})`
          : `the downward push (${CANDLES(def.period)})`;
    case "bb_width":
      return `the width of the price channel (${CANDLES(def.period)})`;
    case "donchian":
      return `the ${def.band === "upper" ? "highest" : def.band === "lower" ? "lowest" : "middle"} price of the previous ${CANDLES(def.period)}`;
    case "vwap":
      return def.anchor === "utc_day" ? "today's volume-weighted average price" : `the volume-weighted average price since the lowest low of the last ${CANDLES(def.lookback)}`;
    case "rvol":
      return `trading activity compared with normal (${CANDLES(def.period)})`;
    case "roc":
      return `the price change over ${CANDLES(def.period)}`;
    case "swing_high":
      return `the highest price of the last ${CANDLES(def.lookback)}`;
    case "swing_low":
      return `the lowest price of the last ${CANDLES(def.lookback)}`;
    default: {
      const exhaustive: never = def;
      return exhaustive;
    }
  }
}

type Indicators = TradingStrategySpec["indicators"];

function operandPhrase(operand: TradingOperand, indicators: Indicators): string {
  if ("ref" in operand) {
    const def = indicators[operand.ref];
    return def ? indicatorPhrase(def) : "a measure that was removed";
  }
  if ("price" in operand) return PRICE_FIELD_WORDS[operand.price];
  return String(operand.value);
}

export function conditionPhrase(condition: TradingCondition, indicators: Indicators): string {
  const left = operandPhrase(condition.left, indicators);
  if (condition.op === "between") {
    return `${left} is between ${operandPhrase(condition.low, indicators)} and ${operandPhrase(condition.high, indicators)}`;
  }
  const verb = condition.op === ">" ? "is above" : condition.op === "<" ? "is below" : condition.op === "crosses_above" ? "moves up past" : "moves down past";
  return `${left} ${verb} ${operandPhrase(condition.right, indicators)}`;
}

export function groupPhrase(group: TradingConditionGroup, indicators: Indicators): string {
  const parts = group.conditions.map((c) => conditionPhrase(c, indicators));
  if (parts.length === 1) return parts[0]!;
  return parts.join(group.match === "all" ? ", and " : ", or ");
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function percent(n: number): string {
  return `${Math.round(n * 100) / 100}%`;
}

function nok(n: number): string {
  return `${Math.round(n).toLocaleString("nb-NO")} NOK`;
}

// ─── One plain sentence per section ───────────────────────────────────────────

export function watchesWords(spec: TradingStrategySpec): string {
  const defs = Object.values(spec.indicators);
  const measures = defs.length === 0 ? "" : ` It measures ${defs.map(indicatorPhrase).join("; ")}.`;
  return `${spec.universe.assets.join(", ")} on ${TIMEFRAME_WORDS[spec.universe.decisionTimeframe]} candles.${measures}`;
}

export function buysWords(spec: TradingStrategySpec): string {
  return `${capitalize(groupPhrase(spec.entry.conditions, spec.indicators))}.`;
}

export function sellsWords(spec: TradingStrategySpec): string {
  const parts: string[] = [];
  const { stop, target, trailing, timeStopBars, conditions } = spec.exit;
  if (stop?.kind === "pct") parts.push(`the price falls ${percent(stop.pct)} below what it paid`);
  if (stop?.kind === "atr") parts.push(`the price falls ${stop.multiple} average candle sizes below what it paid`);
  if (stop?.kind === "below_swing") {
    parts.push(`the price falls under the lowest price of the last ${CANDLES(stop.lookback)}${stop.bufferPct > 0 ? ` (with a ${percent(stop.bufferPct)} margin)` : ""}`);
  }
  if (target?.kind === "r_multiple") parts.push(`it has gained ${target.multiple} times what it risked`);
  if (target?.kind === "pct") parts.push(`the price is ${percent(target.pct)} above what it paid`);
  if (target?.kind === "level") {
    const def = spec.indicators[target.ref];
    parts.push(`the price reaches ${def ? indicatorPhrase(def) : "a level that was removed"}`);
  }
  if (trailing) parts.push(`the price drops ${percent(trailing.distancePct)} from its high, once it is up ${percent(trailing.activateAtPct)}`);
  if (timeStopBars !== undefined) parts.push(`${CANDLES(timeStopBars)} have passed`);
  if (conditions) parts.push(groupPhrase(conditions, spec.indicators));
  if (parts.length === 0) return "It has no way to sell yet.";
  return `Sells when ${parts.join(", or when ")}.`;
}

export function staysOutWords(spec: TradingStrategySpec): string {
  const parts: string[] = [];
  const gate = spec.regimeGate;
  if (gate.trend !== "any") parts.push(gate.trend === "range" ? "only buys when the market moves sideways" : `only buys in a market that is going ${gate.trend}`);
  if (gate.volatility !== "any") parts.push(`only buys when prices are moving ${gate.volatility === "normal" ? "normally" : gate.volatility === "low" ? "a little" : "a lot"}`);
  if (gate.squeeze !== "any") parts.push(gate.squeeze === "yes" ? "only buys when prices are squeezed into a narrow range" : "never buys when prices are squeezed into a narrow range");
  for (const w of spec.stayOut.blackoutWindows) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const days = w.days.length === 0 ? "every day" : w.days.map((d) => dayNames[d]).join(", ");
    parts.push(`does not buy ${days} between ${w.startHourUtc}:00 and ${w.endHourUtc}:00 (UTC)`);
  }
  const cooldown = spec.stayOut.cooldownAfterLosses;
  if (cooldown) parts.push(`takes a break of ${CANDLES(cooldown.bars)} after ${cooldown.losses} losses in a row`);
  if (spec.stayOut.minRelativeVolume !== undefined) parts.push(`waits until trading is at least ${spec.stayOut.minRelativeVolume} times as busy as normal`);
  if (spec.stayOut.maxSpreadPct !== undefined) parts.push(`skips when buying and selling prices are more than ${percent(spec.stayOut.maxSpreadPct)} apart`);
  const jump = spec.stayOut.noEntryAfterJump;
  if (jump) parts.push(`does not buy within ${CANDLES(jump.bars)} of a ${percent(jump.jumpPct)} jump`);
  return parts.length === 0 ? "No extra rules." : `${capitalize(parts.join("; "))}.`;
}

export function neverDoWords(spec: TradingStrategySpec): string {
  const risk = deriveTradingRiskConfig(spec);
  const ask = risk.approvalAboveNok === null ? "Asks you before every buy." : `Asks you before buys of ${nok(risk.approvalAboveNok)} or more.`;
  return `Never puts more than ${nok(risk.maxPositionNok)} in one buy or ${nok(risk.maxTotalExposureNok)} in total, never places more than ${risk.maxOrdersPerDay} orders a day, and stops buying after losing ${nok(risk.dailyLossLimitNok)} in a day or ${percent(risk.maxDrawdownPct)} from its best. Assumes a ${risk.feeRatePct}% fee on every trade. ${ask}`;
}

export function howMuchWords(spec: TradingStrategySpec): string {
  return spec.sizing.kind === "fraction_of_cash"
    ? `Puts ${percent(spec.sizing.fraction * 100)} of its available play money into each buy.`
    : `Sizes each buy so that being stopped out loses ${percent(spec.sizing.riskPerTradePct)} of its play money.`;
}

export function predictsWords(spec: TradingStrategySpec): string {
  const p = spec.prediction;
  const horizon = CANDLES(p.horizonBars);
  return p.kind === "direction"
    ? `After each buy, predicts whether the price will be higher or lower ${horizon} later (a move smaller than ${percent(p.flatBandPct)} counts as flat).`
    : `After each buy, predicts whether the sell goal is reached before the stop, within ${horizon}.`;
}

/**
 * The read-back sentence shown at the top of the editor and on the version
 * list: the whole strategy in a few plain sentences.
 */
export function describeStrategyInWords(spec: TradingStrategySpec): string {
  const coins = spec.universe.assets.join(", ");
  const frame = TIMEFRAME_WORDS[spec.universe.decisionTimeframe];
  const itSentence = (text: string) => (text.startsWith("It ") ? text : `It ${text.charAt(0).toLowerCase()}${text.slice(1)}`);
  const stays = staysOutWords(spec);
  return [
    `This strategy watches ${coins} and decides on ${frame} candles.`,
    `It buys when ${groupPhrase(spec.entry.conditions, spec.indicators)}.`,
    itSentence(sellsWords(spec)),
    stays === "No extra rules." ? "" : itSentence(stays),
    itSentence(howMuchWords(spec)),
    "It uses play money only.",
  ]
    .filter(Boolean)
    .join(" ");
}

// ─── What changed between two versions ────────────────────────────────────────

const RISK_LABELS: Array<[keyof typeof DEFAULT_TRADING_RISK_CONFIG, string, (v: number | null) => string]> = [
  ["maxPositionNok", "The most in one buy", (v) => nok(v as number)],
  ["maxTotalExposureNok", "The most held in total", (v) => nok(v as number)],
  ["maxOrdersPerDay", "The most orders a day", (v) => String(v)],
  ["dailyLossLimitNok", "The daily loss that stops buying", (v) => nok(v as number)],
  ["maxDrawdownPct", "The drop from its best that stops buying", (v) => percent(v as number)],
  ["priceBandPct", "How far the price may move before an order is skipped", (v) => percent(v as number)],
  ["approvalAboveNok", "Asks you before buys of", (v) => (v === null ? "every buy" : nok(v))],
  ["feeRatePct", "Fee assumed on every trade", (v) => percent(v as number)],
];

/**
 * The differences between two sets of rules, one plain sentence each. Empty
 * when nothing a person would notice has changed.
 */
export function describeSpecChanges(
  previous: { spec: TradingStrategySpec; guidelines: string },
  next: { spec: TradingStrategySpec; guidelines: string },
): string[] {
  const out: string[] = [];
  const sections: Array<[string, (s: TradingStrategySpec) => string]> = [
    ["What it watches", watchesWords],
    ["When it buys", buysWords],
    ["When it sells", sellsWords],
    ["When it stays out", staysOutWords],
    ["How much", howMuchWords],
    ["What it predicts", predictsWords],
  ];
  for (const [label, describe] of sections) {
    const before = describe(previous.spec);
    const after = describe(next.spec);
    if (before !== after) out.push(`${label} changed. Now: ${after} Before: ${before}`);
  }
  const beforeRisk = deriveTradingRiskConfig(previous.spec);
  const afterRisk = deriveTradingRiskConfig(next.spec);
  for (const [key, label, format] of RISK_LABELS) {
    if (beforeRisk[key] !== afterRisk[key]) out.push(`${label}: ${format(beforeRisk[key])} → ${format(afterRisk[key])}.`);
  }
  if (previous.spec.meta.thesis !== next.spec.meta.thesis) out.push("The reasoning behind the strategy was rewritten.");
  if (previous.guidelines.trim() !== next.guidelines.trim()) out.push("Your notes for the analyst changed.");
  return out;
}
