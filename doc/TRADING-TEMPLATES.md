# Trading strategy templates

The template library of the trading rebuild (DUR-5014, plan DUR-4889 section 7).
Crypto-adapted versions of the daytradelab styles, plus three controls. Code:
`packages/shared/src/trading-templates.ts`. Stored facts: migration
`0270_trading_template_library.sql`.

## What a template is

A spec v2 rule book (unchanged, so its digest and the engine are exactly what
DUR-5002 made them) wrapped in what a spec has no room for:

- its family (`spec.meta.family`) and the **weather it may trade in**
  (`allowedWeather`; the spec's own regime gate must sit inside it, and inside the
  matrix row of its family);
- a thesis, a **works when / fails when** list, a **common-mistakes** list
  (`spec.meta.commonMistakes`), the do/don't guidelines stored with a strategy's
  rule book;
- **starting values marked "to be tested"**: dotted paths into the spec. They are
  guesses until the past-data test has seen them, not findings;
- `simplifications`: what the adaptation leaves out of the original style;
- `requiresData`: data the thesis needs but we do not hold yet. While any is
  missing the template can be tested on price and volume only and can never earn
  the passed label.

Templates are code, not rows: `tradingTemplates()` parses the catalog through the
schema, and `tradingTemplateProblems()` cross-checks each one against the matrix.
The tests fail on any template that stops validating.

## The catalog

| Wave | Template (key) | Family | Allowed weather |
|---|---|---|---|
| First | Trend continuation (`trend_continuation`) | trend | up trend, no squeeze |
| First | Pullback (`pullback`) | trend | up trend, no squeeze |
| First | Breakout: Donchian + squeeze + volume (`breakout`) | breakout | up trend |
| First | Support/resistance bounce (`support_resistance_bounce`) | mean reversion | range only, no squeeze |
| Second | Momentum (`momentum`) | trend | up trend, no squeeze |
| Second | VWAP reclaim, UTC-day anchor (`vwap_reclaim`) | mean reversion | up trend (pullback to VWAP only), no squeeze |
| Experimental | High-volume spike (`high_volume_spike`), needs funding/OI | breakout | up trend |
| Experimental | Opening range, 00:00 UTC (`opening_range`) and US open (`opening_range_us_open`) | breakout | up trend |
| Experimental | Reversal, long-only (`reversal`) | reversal | down trend, no squeeze |
| Controls | Buy and hold, Stay in cash, Random entry | control | always (scoring only) |
| Excluded | Gap-and-go | none | crypto trades around the clock and has no opening gap |

Decisions are on 4-hour candles (decision 4); the US-open variant uses 1-hour
candles. 15-minute candles are research only. Every template carries 620
predictions per version (decision 3). The opening range uses a new indicator,
`session_range` (the high or low of the first N bars after an hour of the UTC
day, usable once those bars have closed and for the rest of that day).

## The eligibility matrix

Written in advance, versioned, stored: `trading_eligibility_matrices` (one
immutable row per version, a trigger refuses any edit or delete). Version 1 is
the plan's table. A change is a new version added to
`KNOWN_ELIGIBILITY_MATRICES`; the seed step refuses to start if a stored version
differs from the code. In a down trend nothing is traded (spot is long-only) but
predictions keep being logged and scored.

## Past-data reports

`trading_template_reports`: one row per report of one template version, built by
the DUR-5008 runner as a gate run (so each report carries the run at 1x and 2x
fees and its gate verdict). Costs, source, as-of time and seed are fixed when the
report is queued. The queue lives in the existing past-data scheduler chain
(`tradingBacktest`): company tests first, then template reports, one at a time, in
a worker thread. Every ten minutes the chain stores the matrix versions and
queues a report for each template that has none for its current rules and the
newest matrix. A failed or "no candles yet" report is tried again after six
hours. Nothing is queued by a request.

A finished report is final (trigger). A report whose template rules have changed
since is shown as out of date and does not count as a pass.

## Wording

A template that passes is labelled **"passed the past-data checks: paper only,
not a recommendation"**. It is never "ready" or "promising"; the tests check the
catalog and every label for those words. A price-only template, a control, a
template with no report and a template whose report is out of date never get the
passed label.

## Lineage

A report reads the holdout like a gate run does. Those reads and the variants it
tried count toward every strategy created from the template, and what a
strategy of the template read counts against the template's next report
(`trading_strategies.template_key`, set once at creation; the backtest store
unions the two).

## API (instance admin only)

Not shown to client companies before the legal check (decision 19), so every
route needs an instance admin whatever company id the path carries:

- `GET /companies/:id/trading/templates`: the library: templates with latest
  report summary and label, the excluded styles with their reason, the matrix and
  its versions.
- `GET /companies/:id/trading/templates/:key` and `.../reports/:reportId`.
- `POST /companies/:id/trading/strategies/from-template` `{ templateKey, asset, name? }`:
  a paused paper strategy whose version 1 is the template as written for one
  coin. It still needs its own past-data test before it may run.

## Rollback

See the header of `0270_trading_template_library.sql`: drop the three tables, the
two functions and the two `trading_strategies` columns. No strategy, order or
ledger row is touched. Old code ignores the columns.
