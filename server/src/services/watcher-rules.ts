import type { WatcherRule } from "@paperclipai/shared";

/**
 * Rule evaluation for watchers: pure code, no AI, no I/O. Given the price
 * just fetched, the watcher's own recent price history and what happened at
 * the last alert, say whether the rule wants an alert now and what the facts
 * are. Cooldown and the daily cap are the caller's business (they decide
 * whether a wanted alert may go out); this only answers "did it happen?".
 *
 * The three rules:
 *
 *   change            "rises / falls / moves X% or more within N hours".
 *                     Measured from the lowest (rise) or highest (fall) price
 *                     seen in the window, so a 5% climb that took three hours
 *                     counts just as much as one that took twenty. The window
 *                     never reaches back past the last alert: after an alert
 *                     the next one needs a fresh X% move from where that one
 *                     was sent, not the same move announced again.
 *   level             "goes above / below a price". Fires once per crossing:
 *                     `alertedThisCrossing` stays true until the price is back
 *                     on the other side of the line.
 *   since_last_alert  "moves X% or more (up or down) since the last alert".
 *                     Before the first alert, measured from the first price
 *                     the watcher recorded.
 *
 * A source that knows an earlier price itself (CoinGecko's 24-hour change,
 * EODHD's previous close) passes it as `reference`; it counts as one more
 * point in the window when it falls inside it, so a new watcher can measure a
 * 24-hour window from its very first check.
 */

export interface WatcherPricePoint {
  at: Date;
  price: number;
}

export interface WatcherRuleInput {
  rule: WatcherRule;
  /** The price just fetched and when the source says it is from. */
  price: number;
  observedAt: Date;
  /** Earlier prices this watcher recorded (any order; points after observedAt are ignored). */
  history: WatcherPricePoint[];
  reference?: { windowHours: number; price: number; at: Date } | null;
  lastAlertAt: Date | null;
  lastAlertPrice: number | null;
  /** Level rule only: an alert already went out for the current crossing. */
  alertedThisCrossing: boolean;
}

export interface WatcherRuleOutcome {
  /** The rule wants an alert now. */
  wantsAlert: boolean;
  /** Level rule: the price is on the alert side of the line right now. */
  conditionNow: boolean;
  /** The price the move is measured from, when there is one. */
  basePrice: number | null;
  basedAt: Date | null;
  /** Signed percent change from basePrice. */
  changePercent: number | null;
  windowHours: number | null;
}

function percentChange(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

/** Floating point must not decide "exactly 5%": 4.9999999 counts as 5. */
const EPSILON = 1e-9;

export function evaluateWatcherRule(input: WatcherRuleInput): WatcherRuleOutcome {
  const { rule, price, observedAt } = input;
  const none: WatcherRuleOutcome = {
    wantsAlert: false,
    conditionNow: false,
    basePrice: null,
    basedAt: null,
    changePercent: null,
    windowHours: null,
  };
  const past = input.history.filter((point) => point.at.getTime() < observedAt.getTime() && point.price > 0);

  if (rule.kind === "level") {
    const conditionNow = rule.direction === "above" ? price >= rule.price : price <= rule.price;
    return {
      ...none,
      wantsAlert: conditionNow && !input.alertedThisCrossing,
      conditionNow,
      basePrice: rule.price,
      changePercent: percentChange(rule.price, price),
    };
  }

  if (rule.kind === "since_last_alert") {
    let base: WatcherPricePoint | null = null;
    if (input.lastAlertPrice !== null && input.lastAlertPrice > 0) {
      base = { price: input.lastAlertPrice, at: input.lastAlertAt ?? observedAt };
    } else if (past.length > 0) {
      base = past.reduce((oldest, point) => (point.at < oldest.at ? point : oldest));
    }
    if (!base) return none;
    const change = percentChange(base.price, price);
    return {
      ...none,
      wantsAlert: Math.abs(change) + EPSILON >= rule.percent,
      conditionNow: Math.abs(change) + EPSILON >= rule.percent,
      basePrice: base.price,
      basedAt: base.at,
      changePercent: change,
    };
  }

  // change within a window
  const windowStartMs = observedAt.getTime() - rule.windowHours * 3_600_000;
  const lastAlertMs = input.lastAlertAt?.getTime() ?? null;
  const startMs = lastAlertMs !== null && lastAlertMs > windowStartMs ? lastAlertMs : windowStartMs;
  const candidates = past.filter((point) => point.at.getTime() >= startMs);
  if (lastAlertMs !== null && lastAlertMs > windowStartMs && input.lastAlertPrice && input.lastAlertPrice > 0) {
    candidates.push({ at: new Date(lastAlertMs), price: input.lastAlertPrice });
  }
  const reference = input.reference;
  if (
    reference &&
    reference.price > 0 &&
    reference.windowHours <= rule.windowHours &&
    reference.at.getTime() >= startMs &&
    reference.at.getTime() < observedAt.getTime()
  ) {
    candidates.push({ at: reference.at, price: reference.price });
  }
  if (candidates.length === 0) return { ...none, windowHours: rule.windowHours };

  const lowest = candidates.reduce((min, point) => (point.price < min.price ? point : min));
  const highest = candidates.reduce((max, point) => (point.price > max.price ? point : max));
  const rise = percentChange(lowest.price, price);
  const fall = percentChange(highest.price, price);
  const rose = rise + EPSILON >= rule.percent;
  const fell = -fall + EPSILON >= rule.percent;

  let pick: { base: WatcherPricePoint; change: number } | null = null;
  if (rule.direction === "up" && rose) pick = { base: lowest, change: rise };
  else if (rule.direction === "down" && fell) pick = { base: highest, change: fall };
  else if (rule.direction === "either" && (rose || fell)) {
    pick = rose && (!fell || rise >= -fall) ? { base: lowest, change: rise } : { base: highest, change: fall };
  }

  if (!pick) {
    // Nothing fired: report the move that matters for this rule, for the page.
    const shown = rule.direction === "down" ? { base: highest, change: fall } : rule.direction === "up" ? { base: lowest, change: rise } : Math.abs(rise) >= Math.abs(fall) ? { base: lowest, change: rise } : { base: highest, change: fall };
    return {
      ...none,
      basePrice: shown.base.price,
      basedAt: shown.base.at,
      changePercent: shown.change,
      windowHours: rule.windowHours,
    };
  }
  return {
    wantsAlert: true,
    conditionNow: true,
    basePrice: pick.base.price,
    basedAt: pick.base.at,
    changePercent: pick.change,
    windowHours: rule.windowHours,
  };
}

/** The longest stretch of history a rule can need, in hours (so the rest can be deleted). */
export function watcherRuleHistoryHours(rule: WatcherRule): number {
  return rule.kind === "change" ? rule.windowHours : 0;
}
