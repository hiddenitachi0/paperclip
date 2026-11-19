/**
 * The pass/fail criteria for a trading strategy (DUR-5011), in one place.
 *
 * Written in advance, before any forward data exists, from Filip's decisions
 * on DUR-4890 (decisions 3 and 5). The prose version is
 * docs/specs/trading-agent-pass-fail-criteria.md; this file is the one source
 * of the numbers. The past-data gate (TRADING_START_GATE), the prediction
 * scoreboard (trading-scoring.ts) and the strategy page all read from here, so
 * changing a number is one visible, reviewed edit and the doc, the metrics and
 * the screen cannot disagree.
 *
 * EVERY NUMBER BELOW IS AN ASSUMPTION until Filip approves it on DUR-5011.
 * The words are neutral on purpose: a result either meets the written
 * criteria or it does not. Nothing here says a strategy is "promising" or
 * "ready"; real money stays locked server-wide and is a separate decision.
 */

export const TRADING_PASS_FAIL_CRITERIA = {
  /** Shown beside any number taken from here, until Filip signs the thresholds off. */
  assumptionNote: "Assumption: this threshold is a proposal awaiting Filip's approval, not an established fact.",

  /** The past-data gate: every check must hold, run at double the paper fee. */
  pastData: {
    minOutOfSampleTrades: 100,
    /** The gate run charges this multiple of the paper fee. */
    gateFeeMultiplier: 2,
    /** Out-of-sample expectancy at that fee must be above this (R per trade). */
    minExpectancyR: 0,
    /** Share of out-of-sample windows that must be positive. A window with no trades is not positive. */
    minPositiveWindowShare: 0.6,
    /** The strategy's per-trade net return must beat this share of the random-entry runs. */
    randomEntryQuantile: 0.95,
  },

  /** The forward paper test. The verdict is computed once, when both the sample size and the running time are met. */
  forward: {
    /** Independent observations per strategy version, fixed with the version in advance (decision 3). */
    targetSamples: 620,
    /** Minimum running time in days (3 months). Paused and halted time does not count. */
    minRunningDays: 90,
    /** Brier skill must be above this. Applies only to forecasters that carry a real probability. */
    minBrierSkill: 0,
    /** Forward expectancy (R per trade) may fall short of the past-data out-of-sample expectancy by at most this much. */
    tradeResultsToleranceR: 0,
    /** Forward expectancy must also be above this (R per trade). */
    minForwardExpectancyR: 0,
  },

  /**
   * What the sample size can detect. Normal approximation, one-sided test at
   * 5%, against a 50% hit rate, independent observations. 620 gives an 80%
   * chance of confirming a true 55% hit rate; 400 gives about 64%. A weaker
   * true edge is confirmed less often, and a strategy with no edge is
   * wrongly confirmed about 1 time in 20.
   */
  power: {
    trueHitRate: 0.55,
    nullHitRate: 0.5,
    oneSidedAlpha: 0.05,
    atTarget: { samples: 620, power: 0.8 },
    atFewer: { samples: 400, power: 0.64 },
  },

  /** The only words used for a result. */
  wording: {
    collecting: "Collecting",
    met: "Criteria met",
    notMet: "Criteria not met",
    couldNotJudge: "Could not be judged",
    notApplicable: "Does not apply",
    /** Never used on screen or in a message about a strategy's result. */
    forbidden: ["promising", "ready"],
  },
} as const;

export type TradingCriterionState = "met" | "not_met" | "could_not_judge" | "not_applicable";

export interface TradingCriterionItem {
  key: string;
  label: string;
  state: TradingCriterionState;
  detail: string;
}

export type TradingForwardVerdictState = "collecting" | "criteria_met" | "criteria_not_met";

export interface TradingForwardCriteriaFacts {
  /** Independent resolved observations of the rule forecaster. */
  samples: number;
  /** Planned sample size of this version (defaults to the shared target). */
  targetSamples?: number;
  /** Running time with paused and halted time taken out. */
  runningDays: number;
  minRunningDays?: number;
  /** Brier skill of the forecaster; null when it has no real probability. */
  brierSkill: number | null;
  /** True when the forecaster carries a real probability (Brier skill applies). */
  hasRealProbabilities: boolean;
  /** Forward expectancy in R per trade at paper fees; null when no trade carried a measurable risk. */
  forwardExpectancyR: number | null;
  /** Out-of-sample expectancy in R per trade at the gate fee, from the version's gate run; null when none exists. */
  pastDataExpectancyR: number | null;
  /** Worst forward drawdown, % of equity; null when no trade closed. */
  forwardDrawdownPct: number | null;
  /** The strategy's own drawdown cap, %. */
  drawdownCapPct: number | null;
}

export interface TradingForwardCriteriaResult {
  state: TradingForwardVerdictState;
  /** The headline in the approved words. */
  label: string;
  items: TradingCriterionItem[];
  /** One plain sentence on what the result means and what it does not. */
  note: string;
}

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * The forward paper test against the written criteria. Until BOTH the sample
 * size and the running time are met it returns "collecting" and no judgement
 * on the other items: an early read would be an early verdict. After that,
 * "criteria met" needs every applicable item to be met; an item that could
 * not be judged counts against, never for.
 */
export function evaluateForwardCriteria(facts: TradingForwardCriteriaFacts): TradingForwardCriteriaResult {
  const c = TRADING_PASS_FAIL_CRITERIA;
  const target = facts.targetSamples ?? c.forward.targetSamples;
  const minDays = facts.minRunningDays ?? c.forward.minRunningDays;
  const samplesMet = facts.samples >= target;
  const daysMet = facts.runningDays >= minDays;

  const base: TradingCriterionItem[] = [
    { key: "samples", label: `${target} independent observations`, state: samplesMet ? "met" : "not_met", detail: `${facts.samples} of ${target}.` },
    { key: "running_time", label: `At least ${minDays} days of running time (paused time excluded)`, state: daysMet ? "met" : "not_met", detail: `${round(facts.runningDays, 1)} of ${minDays} days.` },
  ];

  if (!samplesMet || !daysMet) {
    return {
      state: "collecting",
      label: c.wording.collecting,
      items: base,
      note: "No verdict is computed until both the sample size and the running time are reached. Early numbers are not a result.",
    };
  }

  const items: TradingCriterionItem[] = [...base];

  if (!facts.hasRealProbabilities) {
    items.push({ key: "brier_skill", label: "Brier skill above 0", state: "not_applicable", detail: "This forecaster gives a direction, not a probability, so Brier skill is not computed for it." });
  } else if (facts.brierSkill === null) {
    items.push({ key: "brier_skill", label: "Brier skill above 0", state: "could_not_judge", detail: "No Brier skill could be computed (base rates were not recorded)." });
  } else {
    items.push({ key: "brier_skill", label: "Brier skill above 0", state: facts.brierSkill > c.forward.minBrierSkill ? "met" : "not_met", detail: `Brier skill ${round(facts.brierSkill)}.` });
  }

  if (facts.forwardExpectancyR === null || facts.pastDataExpectancyR === null) {
    items.push({
      key: "trade_results",
      label: "Trade results no worse than the past-data test",
      state: "could_not_judge",
      detail: facts.pastDataExpectancyR === null ? "This version has no finished past-data gate run to compare with." : "No forward trade carried a measurable risk, so expectancy in R could not be computed.",
    });
  } else {
    const floor = Math.max(c.forward.minForwardExpectancyR, facts.pastDataExpectancyR - c.forward.tradeResultsToleranceR);
    items.push({
      key: "trade_results",
      label: "Trade results no worse than the past-data test",
      state: facts.forwardExpectancyR > c.forward.minForwardExpectancyR && facts.forwardExpectancyR >= floor ? "met" : "not_met",
      detail: `Forward expectancy ${round(facts.forwardExpectancyR)} R per trade; past-data test at ${c.pastData.gateFeeMultiplier}x fees ${round(facts.pastDataExpectancyR)} R.`,
    });
  }

  if (facts.forwardDrawdownPct === null || facts.drawdownCapPct === null) {
    items.push({ key: "drawdown", label: "Drawdown within the cap", state: "could_not_judge", detail: "No closed trade or no cap, so drawdown could not be measured." });
  } else {
    items.push({ key: "drawdown", label: "Drawdown within the cap", state: facts.forwardDrawdownPct <= facts.drawdownCapPct ? "met" : "not_met", detail: `Worst drawdown ${round(facts.forwardDrawdownPct, 1)}% against a cap of ${facts.drawdownCapPct}%.` });
  }

  const allMet = items.every((item) => item.state === "met" || item.state === "not_applicable");
  return {
    state: allMet ? "criteria_met" : "criteria_not_met",
    label: allMet ? c.wording.met : c.wording.notMet,
    items,
    note: allMet
      ? "Every written criterion is met on this sample. That is not a prediction of future results, and real money stays locked until Filip decides."
      : "At least one written criterion is not met or could not be judged. A result of 'not met' is a normal, useful outcome.",
  };
}

/** The sentence about statistical power, built from the numbers above so the doc and screen cannot drift. */
export function describePassFailPower(): string {
  const p = TRADING_PASS_FAIL_CRITERIA.power;
  return `${p.atTarget.samples} independent observations give an ${Math.round(p.atTarget.power * 100)}% chance of confirming a true ${Math.round(p.trueHitRate * 100)}% hit rate; ${p.atFewer.samples} give about ${Math.round(p.atFewer.power * 100)}%.`;
}
