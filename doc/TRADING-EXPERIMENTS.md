# Trading experiments

The experiment runner of the trading rebuild (DUR-5018, plan DUR-4889). Code:
`server/src/services/trading-experiment-{run,store,worker}.ts`, constants and request
schema in `packages/shared/src/trading-experiment.ts`. Stored facts: migration
`0272_trading_experiments.sql`.

## What an experiment is

A small, capped parameter grid on **one version** of a strategy's rules, run
walk-forward on past data (the DUR-5008 test, as an exploration). The grid varies
indicator settings only (`period`, `lookback`, `stdDev`), up to 3 settings at
once, at most 49 combinations (the rules as written always run too: 50 variants
in all). With no grid, the automatic neighbours run: every indicator length
nudged down and up by a quarter, one at a time. Risk limits, stops, sizing and the
entry/exit logic are never varied, so an experiment cannot recommend loosening a
limit.

Costs, the data horizon, the candle source and the random seed are fixed by the
server (fee 0.40% per side, every number also at double fees, the live candle
source, a seed derived from the rules). The requester chooses only the version
(default: the live one) and the grid.

## What it records

Per experiment (`trading_experiments`):

- `trial_count`: variants this experiment tried; `registry_trial_count`: distinct
  variants ever tried for the strategy and its template when it finished.
  Finished experiments feed the same trial registry as past-data tests, so the
  Deflated Sharpe of every later test counts them: experimenting cannot make a
  strategy look better.
- `deflated_sharpe`: probability for the recommended variant (or the best one
  when there is no change).
- `plateau`: the winner's one-step neighbours in the grid and how many are
  positive out of sample.
- `holdout_reads_lineage`: holdout reads already made in the lineage. An
  experiment makes none (`report.holdoutReads.madeByThisExperiment` is always 0).
- `recommendation`: `recommend` (with the variant, and `recommended_spec` = the
  exact rules) or `no_change`, with every check and why it passed or failed.

A variant is recommended only if it beats the rules as written, is positive after
double fees out of sample with at least 100 trades, has a Deflated Sharpe of at
least 0.95 over the whole lineage's trial count, and at least 75% of its
neighbours (at least 2) are positive too. The numbers live in
`TRADING_EXPERIMENT_RECOMMEND` and are stored with each result.

## Where it runs

In a worker thread with its own small database connection and a capped heap, on
the existing `tradingBacktest` scheduler chain: never the trading tick chain, never
the API's event loop. One heavy job at a time (a company's past-data test goes
first, then an experiment, then a template report). 30-minute wall-clock limit,
enforced by terminating the thread.

## Reproducible

The as-of time is part of the stored parameters and nothing reads the clock, so
the same experiment on the same lineage state gives byte-identical results
(`result_digest`). A rerun that adds no new variant to the registry is identical.

## It is never applied

The result is a suggestion. The only consumer is the Trader's proposal route:
every proposal must cite `experimentId`, and the server rejects it (422, before
any draft or card exists) unless the experiment is of that strategy, finished,
recommended a variant (not "no change"), was run on the strategy's **current live
version**, and its recommended rules are **exactly** the proposed rules. A person
still approves the card.

## Routes

- Board: `GET|POST /companies/:id/trading/strategies/:sid/experiments`,
  `GET .../experiments/:eid`, `POST .../experiments/:eid/cancel` (owner/admin to
  write).
- Trader (designated agent only): `GET|POST /agent-trading/strategies/:sid/experiments`,
  `GET .../experiments/:eid`. MCP tools: `trading_run_experiment`,
  `trading_list_experiments`, `trading_get_experiment`. At most 6 requests per
  strategy per day; at most 5 experiments waiting or running per company.

## Rollback

See the header of `0272_trading_experiments.sql`. Dropping the table loses
experiment results and the variants they added to the trial count; deployed code
refuses every Trader proposal until it is rolled back as well.
