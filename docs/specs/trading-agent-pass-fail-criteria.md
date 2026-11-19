# Trading agent: pass/fail criteria (DUR-5011)

Replaces the DUR-4227 version, which judged a strategy after "30 days or 20
trades". That is dropped: 20 trades say almost nothing, and a verdict that can
arrive early invites reading luck as skill.

**Every number below is an assumption, awaiting Filip's approval on DUR-5011.**
They come from his decisions on DUR-4890 (3: 620 predictions per version, no
early verdicts; 5: 0.40% fee per side, past-data tests also at double fees).
The numbers live in one place, `TRADING_PASS_FAIL_CRITERIA` in
`packages/shared/src/trading-criteria.ts`. The past-data gate, the metrics
service (the scoreboard endpoint) and the strategy page all read that
constant; this document describes it and must change with it.

## Wording

A result is one of: **Collecting**, **Criteria met**, **Criteria not met**.
An item that cannot be judged says "Could not be judged" and counts against.
The words "promising" and "ready" are not used for a strategy's result, on
screen or in messages. "Criteria met" is a statement about a written list, not
a forecast, and not a decision to use real money. Real money stays locked
server-wide; Filip decides about it later, and only after a strategy has proven
itself positive after fees.

## 1. Past-data gate (before a strategy may start on paper)

All of these, run out of sample on the live price source, at double fees:

| # | Criterion | Assumed number |
| - | --------- | -------------- |
| 1 | Out-of-sample trades | at least 100 |
| 2 | Expectancy at 2x fees (0.80% per side) | above 0 R per trade |
| 3 | Windows that are positive (a window with no trades is not positive) | at least 60% |
| 4 | Beats random entry with the same exposure | beats at least 95% of 300 random-entry runs |
| 5 | A clean holdout read, or confirmation on paper | holdout read for the first time and positive at 2x fees; a repeated read cannot pass alone, forward paper data decides |

The gate also keeps the checks that guard against fooling ourselves (look-ahead,
point-in-time inputs, neighbouring parameters, bull/bear/range coverage,
drawdown within the strategy's own cap). Those are implemented in
`evaluateBacktestGate` and are unchanged by this card. The numbers in 1 to 4
now come from the shared constant.

## 2. Forward paper test

The verdict is computed **once**, when both of these are met. Until then the
page shows "Collecting: x of N" and nothing else; no hit rate, no interval, no
early read.

| # | Criterion | Assumed number |
| - | --------- | -------------- |
| 1 | Independent observations, fixed per version in advance (decision 3) | about 620 |
| 2 | Running time, paused and halted time excluded | at least 3 months (90 days) |

Then every item must hold:

| # | Criterion | Assumed number |
| - | --------- | -------------- |
| 3 | Brier skill, for forecasters with real probabilities only | above 0 (a fixed rule gives a direction, not a probability: "does not apply") |
| 4 | Trade results no worse than the past-data test | forward expectancy above 0 R and not below the past-data out-of-sample expectancy at 2x fees (tolerance 0 R) |
| 5 | Drawdown within the cap | worst forward drawdown at or below the strategy's own `maxDrawdownPct` |

An item that cannot be judged (no gate run to compare with, no trade with a
measurable risk, no cap) counts against "Criteria met". The existing stored
read of hit rate against the decision-time base rate and the three baselines
stays on the scoreboard as before; this card does not change it.

Safety checks that are about the machinery and not the result (no halt on a
circuit breaker or ledger mismatch, every fill inside its price band, large
orders approved before filling) stay on the strategy page next to the criteria.
They do not produce a verdict word.

## What the sample size can and cannot show

Normal approximation, one-sided test at 5%, against a 50% hit rate,
independent observations:

- **620** observations give an **80%** chance of confirming a true 55% hit rate.
- **400** observations give about **64%**.
- A weaker true edge is confirmed less often than that, and a strategy with no
  edge at all is wrongly confirmed about 1 time in 20.

So "Criteria not met" at 620 does not prove there is no edge. It means this
sample did not show one. That is a normal outcome.

## What was removed from the old version

The 30-day / 20-trade window, the buy-and-hold tolerance, the 15% fee cap and
the "five days of daily loss" line are gone as verdict items. Fees are handled
by running every past-data test at double fees and judging forward trades net
of the paper fee. Daily loss and drawdown stay enforced by the risk limits
themselves, and drawdown is criterion 5.

## Questions for Filip (approve or change on DUR-5011)

1. Are the numbers above right as written: 100 trades, 60% positive windows,
   95% against random entry, 620 observations, 90 days, Brier skill above 0?
2. "No worse than the past-data test": compare with the past-data result at
   **2x** fees (assumed, the gate run) or at 1x fees? Zero tolerance, or allow
   a small shortfall?
3. Is 90 days the right reading of "at least 3 months" (versus calendar
   months)?
