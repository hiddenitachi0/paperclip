import { describe, expect, it } from "vitest";
import { TRADING_PASS_FAIL_CRITERIA, describePassFailPower, evaluateForwardCriteria, type TradingForwardCriteriaFacts } from "./trading-criteria.js";
import { TRADING_DEFAULT_MIN_RUNNING_DAYS, TRADING_DEFAULT_TARGET_SAMPLES } from "./trading-scoring.js";
import { TRADING_BACKTEST_COSTS, TRADING_START_GATE } from "./trading-backtest.js";

const ready: TradingForwardCriteriaFacts = {
  samples: 620,
  runningDays: 91,
  brierSkill: 0.04,
  hasRealProbabilities: true,
  forwardExpectancyR: 0.2,
  pastDataExpectancyR: 0.15,
  forwardDrawdownPct: 6,
  drawdownCapPct: 10,
};

const normalCdf = (z: number) => {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
};
const power = (n: number, trueP: number, nullP: number, zAlpha: number) => {
  const critical = nullP + zAlpha * Math.sqrt((nullP * (1 - nullP)) / n);
  return 1 - normalCdf((critical - trueP) / Math.sqrt((trueP * (1 - trueP)) / n));
};

describe("shared pass/fail criteria", () => {
  it("is the one source for the gate and the scoreboard defaults", () => {
    expect(TRADING_DEFAULT_TARGET_SAMPLES).toBe(TRADING_PASS_FAIL_CRITERIA.forward.targetSamples);
    expect(TRADING_DEFAULT_MIN_RUNNING_DAYS).toBe(TRADING_PASS_FAIL_CRITERIA.forward.minRunningDays);
    expect(TRADING_START_GATE.minOutOfSampleTrades).toBe(TRADING_PASS_FAIL_CRITERIA.pastData.minOutOfSampleTrades);
    expect(TRADING_START_GATE.minPositiveWindowShare).toBe(TRADING_PASS_FAIL_CRITERIA.pastData.minPositiveWindowShare);
    expect(TRADING_BACKTEST_COSTS.gateFeeMultiplier).toBe(TRADING_PASS_FAIL_CRITERIA.pastData.gateFeeMultiplier);
  });

  it("states a power that matches the normal approximation", () => {
    const p = TRADING_PASS_FAIL_CRITERIA.power;
    expect(power(p.atTarget.samples, p.trueHitRate, p.nullHitRate, 1.645)).toBeCloseTo(p.atTarget.power, 1);
    expect(power(p.atFewer.samples, p.trueHitRate, p.nullHitRate, 1.645)).toBeCloseTo(p.atFewer.power, 1);
    expect(describePassFailPower()).toBe("620 independent observations give an 80% chance of confirming a true 55% hit rate; 400 give about 64%.");
  });

  it("never uses the forbidden words", () => {
    const w = TRADING_PASS_FAIL_CRITERIA.wording;
    const text = [w.collecting, w.met, w.notMet, w.couldNotJudge, w.notApplicable, evaluateForwardCriteria(ready).note, evaluateForwardCriteria({ ...ready, samples: 3 }).note].join(" ").toLowerCase();
    for (const word of w.forbidden) expect(text).not.toContain(word);
  });
});

describe("evaluateForwardCriteria", () => {
  it("collects, and judges nothing else, until BOTH the sample size and the running time are met", () => {
    for (const facts of [{ ...ready, samples: 619 }, { ...ready, runningDays: 89.9 }, { ...ready, samples: 700, runningDays: 10 }]) {
      const r = evaluateForwardCriteria(facts);
      expect(r.state).toBe("collecting");
      expect(r.items.map((i) => i.key)).toEqual(["samples", "running_time"]);
    }
  });

  it("is 'criteria met' when everything holds", () => {
    const r = evaluateForwardCriteria(ready);
    expect(r.state).toBe("criteria_met");
    expect(r.label).toBe("Criteria met");
  });

  it("fails on Brier skill at or below 0", () => {
    expect(evaluateForwardCriteria({ ...ready, brierSkill: 0 }).state).toBe("criteria_not_met");
    expect(evaluateForwardCriteria({ ...ready, brierSkill: -0.1 }).state).toBe("criteria_not_met");
  });

  it("does not apply Brier skill to a fixed rule", () => {
    const r = evaluateForwardCriteria({ ...ready, brierSkill: null, hasRealProbabilities: false });
    expect(r.state).toBe("criteria_met");
    expect(r.items.find((i) => i.key === "brier_skill")?.state).toBe("not_applicable");
  });

  it("fails when forward trades are worse than the past-data test, or not positive", () => {
    expect(evaluateForwardCriteria({ ...ready, forwardExpectancyR: 0.1 }).state).toBe("criteria_not_met");
    expect(evaluateForwardCriteria({ ...ready, forwardExpectancyR: -0.05, pastDataExpectancyR: -0.2 }).state).toBe("criteria_not_met");
  });

  it("counts what could not be judged against, never for", () => {
    const noGate = evaluateForwardCriteria({ ...ready, pastDataExpectancyR: null });
    expect(noGate.state).toBe("criteria_not_met");
    expect(noGate.items.find((i) => i.key === "trade_results")?.state).toBe("could_not_judge");
    expect(evaluateForwardCriteria({ ...ready, forwardDrawdownPct: null }).state).toBe("criteria_not_met");
  });

  it("fails on drawdown over the cap", () => {
    expect(evaluateForwardCriteria({ ...ready, forwardDrawdownPct: 10.1 }).state).toBe("criteria_not_met");
    expect(evaluateForwardCriteria({ ...ready, forwardDrawdownPct: 10 }).state).toBe("criteria_met");
  });

  it("uses a version's own planned numbers when given", () => {
    expect(evaluateForwardCriteria({ ...ready, samples: 400, targetSamples: 400 }).state).toBe("criteria_met");
  });
});
