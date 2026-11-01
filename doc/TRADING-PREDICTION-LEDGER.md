# Trading prediction ledger (DUR-5010)

Every call a forecaster makes is written down **before** its outcome is known,
resolved once from closed candles, and scored against simple baselines with
rules fixed in advance. Migration `0267_trading_predictions`; code in
`server/src/services/trading-evaluator.ts` and
`packages/shared/src/trading-scoring.ts`.

## Tables

| Table | Scope | What it is |
|---|---|---|
| `trading_predictions` | company (RLS, both lists of 0164) | One row per forecaster, strategy, version, coin and bar. Unique key `(forecaster_key, strategy_id, spec_version, asset, bar_close_at)`. |
| `trading_prediction_verdicts` | company (RLS, both lists) | Insert-only. One verdict per strategy, version and forecaster. |
| `trading_evaluator_state` | instance-wide (login-role list only) | One row: the evaluator's last heartbeat and boot time. |
| `trading_ledger_entries` | existing | Gains the event type `evaluator_gap`. |

The database protects `trading_predictions` with a trigger:

- `decided_at` is the server's clock (within 5 minutes of it), never the caller's.
- The data a call used must end before it was made (`data_cutoff_at < decided_at`) and no later than the bar's close; the outcome must not be known yet (`decided_at < resolves_at`).
- No forecast column ever changes. The outcome columns (`resolved_at`, `outcome`, `realized_return`, `mfe`, `mae`, `resolver_version`, `independent`) are written once, together, no earlier than `resolves_at`; a resolved row is frozen.
- `DELETE` is untouched, so the cascades from companies and strategies work. Every foreign key is `ON DELETE CASCADE` (a `SET NULL` would be an update of a forecast column). App code has no delete path.
- `probability` needs a `probability_source` (`model`, `llm`, `fitted_out_of_sample`); a fixed rule carries none.

`trading_prediction_verdicts` is refused by the database before the planned sample size
(independent resolved predictions) and the minimum test period have passed. Until a row
exists the status is `collecting`.

## Definitions (stored with the version before any data)

- **Resolution:** the close at `bar_close_at + horizon` against the reference close at `bar_close_at`.
- **Flat band:** `flatBandPct` from the version's `prediction` block (default half the round-trip cost, 0.45%). Flat outcomes are left out of the hit rate and reported.
- **Base rate:** share of "up" outcomes over the trailing 90 days, using only bars whose horizon had closed at decision time (kept in the row's `indicator_snapshot.baseRateUp`). The evaluator reads the last 720 closed bars, so on 1h bars the window is shorter than 90 days.
- **Direction only for fixed rules.** Brier score, log loss and calibration exist only for forecasters with a real probability.
- **R unit:** the stop distance, or 1 ATR(14) at the decision bar.
- **Sample size and running time:** `prediction.targetSamples` (default 620) and `prediction.minRunningDays` (default 90) in the version's spec, so they are fixed with the approved version. Both must be reached; the verdict is computed once.
- **What a fixed rule "calls":** the rule is run on the newest closed bar as if flat (an entry is an "up" call) and as if long with only its rule exits armed (a rule exit is a "down" call). Stops, targets and trailing are trade management and are scored as trades. Both on one bar: no call.

## Restarts

The evaluator is its own scheduler chain (`tradingEvaluator`, off with `PAPERCLIP_TRADING_EVALUATOR_ENABLED=false`). It places no orders and files no cards. The paper order path still pauses on restart (DUR-4171); the evaluator starts by itself. Each boot writes an `evaluator_gap` ledger entry per live strategy for the time since the last heartbeat. A bar that closed before the boot is never predicted. **Running time = calendar time minus gap time**; the scoreboard shows both.

## Reading it

`GET /api/companies/:companyId/trading/strategies/:strategyId/scoreboard[?version=N]`. While collecting it shows "x of N" and **no** hit rate or interval. After the verdict it shows hit rate with a block-bootstrap interval (blocks = predictions sharing a decision time, so coins sharing a timestamp stay together), effective sample size, base rate, baselines on the same bars, per-regime hit rates with the number of regime spells behind them, and trade metrics.

## Retention and backup

Kept for as long as the strategy exists; nothing prunes it. Estimated size: about 6 calls per coin per day on 4h bars times 4 forecasters per strategy, roughly 9,000 rows a year per strategy including baselines, a few MB with the indicator snapshots. Include `trading_predictions`, `trading_prediction_verdicts` and `trading_evaluator_state` in the offsite-backup plan with the rest of the trading data (the candle store is the large one; see `TRADING-CANDLE-STORE.md`).

## Rollback

In the header of `0267_trading_predictions.sql`. Drops the three tables and the two functions, deletes `evaluator_gap` ledger rows and restores the old event-type list. No order, strategy or other ledger row is touched.
