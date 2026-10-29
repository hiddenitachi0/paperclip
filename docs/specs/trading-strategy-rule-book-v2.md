# Trading strategy rule book v2 (StrategySpec v2)

Status: implemented in DUR-5002 (phase 1 of the trading rebuild, DUR-4889). Paper money only.

## What it is

A strategy's rules are a strict, versioned document (`packages/shared/src/trading-strategy-spec.ts`):
meta (thesis, common mistakes), universe and candle size, an indicator allow-list, a market-condition
gate, entry and exit conditions, stop / target / trailing / time stop, sizing, stay-out rules, `neverDo`
limits, the prediction definition and free-text guidelines. Unknown fields are refused.

- Every risk number is bounded by `TRADING_HARD_CEILING`. `neverDo` can only tighten: it is refused if
  it is above the version's own limit.
- Agent proposals may never loosen the active version (`describeStrategyLoosening`). A person may loosen
  inside the ceiling, because they approve the card.
- Guidelines are stored beside the spec (`guidelines` column) and are never passed to the engine. The
  engine's spec type has no guidelines field and `evaluateStrategy` throws if handed one.

## Engine

`evaluateStrategy(spec, closedBars, positionState)` (`trading-engine.ts`) is pure and deterministic.
It reads only the trailing warm-up window of closed bars the spec needs, so a backtest and the live tick
agree. It returns `{ action, reasonCodes, directionCall, indicatorSnapshot, ... }`, never a probability.
Exits (stop, target, trailing, time stop, exit conditions) go through the exit gate in the tick; entries
through the entry gate.

Indicators (`trading-indicators.ts`) are our own implementations of the textbook definitions, written
without reference to any AGPL or GPL code. Their tests pin them to reference values generated with the
MIT-licensed `trading-signals` package (used only to produce numbers, not a dependency) and to Wilder's
worked RSI example. EMA and ADX agree to 4 decimals / 0.01 because the library seeds its smoothing
differently.

## One source of truth

- `trading_strategy_versions` (migration 0262): immutable rows, draft -> approved -> superseded, with
  proposer (user / agent / system), approver, spec digest and `grandfathered`. A trigger refuses any change
  to a stored version's content and any backwards status move.
- `trading_strategies.active_version_id` is the one version the tick reads. `rule_config` / `risk_config`
  are a cache, written only together with a change of `active_version_id` (trigger), i.e. in the
  activation transaction. `projectStrategyCache` is the single projection.
- `PATCH /trading/strategies/:id`: name and check interval save directly. `ruleConfig`, `riskConfig` or a
  whole `document` file a draft plus an approval card (`pendingVersion` in the response) and write
  nothing live.
- Approval kind `trading_strategy_version` is card-only. The card is built from the stored draft; at
  approve time the card on file must equal the one rebuilt from the stored row. Approving activates exactly
  that version, owner / admin only, signed in on the approvals page (not an agent, the CLI/Telegram,
  an automation, a thread reply or Board chat).
- Every order and ledger row is stamped with `strategy_version_id`. Predictions (a later phase) must
  carry it too.
- Existing `sma_crossover@1` strategies are converted at boot into grandfathered legacy versions
  (`convertLegacyStrategies`), and their history is stamped. A golden test shows identical decisions.
- Creating a strategy (owner / admin only) writes version 1 as approved: the creator wrote the rules.
