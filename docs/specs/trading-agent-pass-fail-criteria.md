# Trading agent (DUR-4153/DUR-4171): paper-trading pass/fail criteria

## Context

DUR-4153 (design) and DUR-4171 (implementation) both ask for a dashboard that
shows paper-trading results "against pass/fail criteria written in advance."
DUR-4153 was expected to hand this down from a design document, but it never
produced one before delegating implementation directly to this task (see
DUR-4153's comment thread). Per this feature's own ground rules ("when
something is unclear, state your assumption, choose the safer option, and
continue"), this document is that assumption: a concrete, written-in-advance
definition of what "the strategy is working" means for a single paper
strategy, using only fields the dashboard endpoint
(`GET /companies/:companyId/trading/strategies/:strategyId/dashboard`,
`TradingDashboardSummary` in `packages/shared/src/trading.ts`) already
exposes. Filip (or whoever reviews this PR) should treat these thresholds as
a starting point to confirm or adjust, not a final word -- flagged in
"Questions for Filip" below.

No new endpoint or schema is introduced by this document. Evaluating a
strategy against these criteria is a client-side (UI) read of the existing
dashboard response; nothing here requires the server to compute a verdict.

## Evaluation window

A strategy is only evaluated once it has run long enough for its rule to
have had a fair chance to signal. Minimum window: **30 days of wall-clock
running time** (accumulated `running` time, not counting `paused` or
`halted_risk` gaps) or **20 completed round-trip trades**, whichever comes
first. Below that, the dashboard should show "still gathering data," not a
pass/fail verdict -- a strategy with one lucky trade on day 2 is not "passing."

## Pass criteria (all of the following must hold)

1. **Beats buy-and-hold on a risk-adjusted basis, not just raw return.**
   `totalPnlNok` (realized + unrealized) is compared against
   `buyAndHoldValueNok - startingCashNok`. The strategy passes this check if
   its total return is at least equal to buy-and-hold, OR if it trails
   buy-and-hold by no more than 5 percentage points while its max drawdown
   (see #2) is less than half of buy-and-hold's max drawdown over the same
   window -- i.e. "it's fine to make a bit less than holding, if it did so
   with meaningfully less pain." A strategy that merely matches buy-and-hold
   while taking on equal or greater drawdown has not earned its complexity
   and fails this check.
2. **Max drawdown stays under the strategy's own configured ceiling.**
   Never breaches `riskConfig.maxDrawdownPct` (and never gets anywhere near
   `TRADING_HARD_CEILING.maxDrawdownPct`, the hard 20% ceiling in
   `packages/shared/src/trading.ts`) — if it did, `halted_risk` would have
   already fired and paused it, which itself counts as a fail for this
   evaluation window regardless of PnL before the halt.
3. **No unattended circuit-breaker halts.** `status === "halted_risk"` at
   any point during the window (`pauseReason` of `circuit_breaker` or
   `reconciliation_mismatch`) is an automatic fail for that window, even if
   PnL looks good going in — the point of paper trading is proving the
   *system* is trustworthy, not just the rule's math.
4. **Fees don't eat the edge.** `feesPaidNok` stays under 15% of gross
   realized profit (realized gains before fees). A rule that only "wins" by
   trading so often the fees erase the edge has not found a real signal.
5. **The approval gate never got silently bypassed.** Every order at or
   above `riskConfig.approvalAboveNok` (or, if that started `null`, every
   single order) has a matching `trading_ledger_entries` row showing the
   approval was requested and resolved (approve/reject/expire) before any
   `order_filled` ledger entry for that signal. This is a correctness check
   on the safety mechanism itself, not a performance number, but it belongs
   in "pass/fail" because a strategy that traded despite a missing approval
   record must not be trusted regardless of its PnL.

## Fail criteria (any one of the following is an automatic fail, overriding #1)

- Any `halted_risk` with `pauseReason: "circuit_breaker"` or
  `"reconciliation_mismatch"` during the window (see #3 above).
- `totalPnlNok` below `-1 * riskConfig.dailyLossLimitNok * 5` cumulative
  (i.e. the strategy has, in total, lost more than five days' worth of its
  own configured daily-loss limit) — a slow bleed a single day's circuit
  breaker wouldn't catch.
- Any order filled without price falling inside `riskConfig.priceBandPct` of
  the signal price that produced it (a stale/bad quote getting traded on
  anyway) — checked against `trading_orders.signalPriceNok` vs
  `filledPriceNok`.

## Dashboard presentation (for the Frontend Engineer's follow-up UI work)

Given the above, the dashboard's verdict badge should be one of:
- **Gathering data** — window not yet met.
- **Passing** — all pass criteria hold, no fail criteria hit.
- **Failing** — any fail criterion hit, or a pass criterion does not hold.

The existing `TradingDashboardSummary` fields (`totalPnlNok`,
`buyAndHoldValueNok`, `feesPaidNok`, `status`, `pauseReason`) are sufficient
to compute all of the above in the UI layer except #2 (max drawdown over the
window) and #5 (approval-gate audit), which need the ledger
(`GET .../ledger`) and orders (`GET .../orders`) endpoints already exposed
by this PR. No new backend surface is needed for this document's criteria.

## Questions for Filip

1. Are the specific numeric thresholds above (30-day/20-trade window, 5pp
   buy-and-hold tolerance, 15% fee cap, 5x daily-loss cumulative fail line)
   the right starting point, or do you have numbers in mind from the design
   report (research report 6) that should override these?
2. Should "passing" ever be a signal to relax `riskConfig` limits
   automatically, or must every risk-config change always be a manual
   operator edit (current implementation: always manual, via
   `PATCH .../strategies/:id`)? This document assumes the latter.
