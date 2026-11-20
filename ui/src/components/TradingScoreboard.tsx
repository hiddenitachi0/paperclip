import { useId, useState } from "react";
import type { TradingScoreboard as Scoreboard, TradingScoreboardForecaster } from "../api/trading";
import {
  FEW_SPELLS,
  SCOREBOARD_DISCLAIMER,
  days,
  forecasterName,
  forecasterShortName,
  isRuleForecaster,
  orderForecasters,
  percent,
  percentWithRange,
  scoreboardHeadline,
  spellsWords,
  usd,
  weatherLabel,
  wholeNumber,
  type ScoreboardHeadlineKind,
} from "../lib/tradingScoreboardWords";
import { Legend, useDrawnWidth } from "./TradingBacktestCharts";

/**
 * The prediction scoreboard (DUR-5012). Every number and every word of result
 * comes from the server's scoreboard; this screen only lays it out. While the
 * server says it is still collecting, nothing but counts and times is shown:
 * no hit rate, no win or loss, no result words.
 *
 * Charts follow the house rules: one axis, a legend that names every mark, a
 * focus/hover read-out, a table view, the same blue/red/gray pair as the
 * past-data charts (lighter steps in dark mode), and colour is never the only
 * clue.
 */

const BLUE_FILL = "fill-[#2a78d6] dark:fill-[#3987e5]";
const BLUE_STROKE = "stroke-[#2a78d6] dark:stroke-[#3987e5]";
const RED_FILL = "fill-[#e34948] dark:fill-[#e66767]";
const GRAY_FILL = "fill-[#8a8985] dark:fill-[#8f8e88]";

const HEADLINE_TONE: Record<ScoreboardHeadlineKind, string> = {
  collecting: "border-border bg-muted/40",
  being_worked_out: "border-border bg-muted/40",
  no_better: "border-border bg-muted/40",
  negative_after_fees: "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-900/20",
  passed: "border-blue-300 bg-blue-50 dark:border-blue-900 dark:bg-blue-900/20",
  better_but_checks_open: "border-border bg-muted/40",
};

function ChartTableToggle({ asTable, onToggle }: { asTable: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={onToggle}>
      {asTable ? "Show the chart" : "Show as a table"}
    </button>
  );
}

function ProgressRow({ label, value, max, detail }: { label: string; value: number; max: number; detail: string }) {
  const share = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">{detail}</span>
      </div>
      <div
        className="mt-1 h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
      >
        <div className="h-full rounded-full bg-[#2a78d6] dark:bg-[#3987e5]" style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-semibold">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// ─── Hit rate against the base rate, baselines side by side ───────────────────

interface HitRow {
  key: string;
  name: string;
  short: string;
  hitRate: number;
  lower: number | null;
  upper: number | null;
  expected: number | null;
  isRule: boolean;
}

function hitRows(forecasters: readonly TradingScoreboardForecaster[]): HitRow[] {
  const rows: HitRow[] = [];
  for (const f of forecasters) {
    const rule = isRuleForecaster(f.forecasterKey);
    // The simple guesses are shown on the very same bars the rules called, so the comparison is fair.
    const hitRate = rule ? f.hitRate : f.hitRateOnRuleBars;
    if (hitRate === null) continue;
    rows.push({
      key: f.forecasterKey,
      name: forecasterName(f.forecasterKey),
      short: forecasterShortName(f.forecasterKey),
      hitRate,
      lower: rule ? (f.hitRateInterval?.lower ?? null) : null,
      upper: rule ? (f.hitRateInterval?.upper ?? null) : null,
      expected: rule ? f.expectedHitRateFromBaseRate : null,
      isRule: rule,
    });
  }
  return rows;
}

export function HitRateChart({ rows }: { rows: HitRow[] }) {
  const [shown, setShown] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();
  const [boxRef, drawn] = useDrawnWidth();
  if (rows.length === 0) return null;

  const W = Math.max(280, drawn);
  const narrow = W < 480;
  const left = narrow ? 112 : 150;
  const right = 14;
  const top = 8;
  const rowH = 34;
  const bottom = 26;
  const H = top + rows.length * rowH + bottom;

  const all = rows.flatMap((r) => [r.hitRate, r.lower, r.upper, r.expected].filter((v): v is number => v !== null)).concat(0.5);
  const lo = Math.max(0, Math.floor((Math.min(...all) - 0.03) * 20) / 20);
  const hi = Math.min(1, Math.ceil((Math.max(...all) + 0.03) * 20) / 20);
  const x = (v: number) => left + ((v - lo) / (hi - lo || 1)) * (W - left - right);
  const ticks = [lo, 0.5, hi].filter((t, i, a) => a.indexOf(t) === i);
  const hovered = shown === null ? null : rows[shown];

  return (
    <figure className="space-y-2" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption id={titleId} className="text-sm font-medium">
          Hit rate against plain guessing
        </figcaption>
        <ChartTableToggle asTable={asTable} onToggle={() => setAsTable((v) => !v)} />
      </div>
      <p className="text-xs text-muted-foreground">
        How often each call about the next move was right. The simple guesses are scored on the very same moments as the rules. The bar on the rules shows the range the true rate is likely to sit in.
      </p>
      {asTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="hit-rate-table">
            <caption className="sr-only">Hit rate of the rules and the simple guesses</caption>
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">Who made the call</th>
                <th scope="col" className="py-1 pr-3 font-medium">Calls right</th>
                <th scope="col" className="py-1 font-medium">What guessing from the recent past gives</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-border/60">
                  <td className="py-1 pr-3">{r.name}</td>
                  <td className="py-1 pr-3">{percentWithRange(r.hitRate, r.lower, r.upper)}</td>
                  <td className="py-1">{r.expected === null ? "—" : percent(r.expected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={boxRef}>
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Chart of the hit rate of the rules and of three simple guesses. Use the table view for the numbers." data-testid="hit-rate-chart">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={top} y2={H - bottom} className={t === 0.5 ? "stroke-foreground/50" : "stroke-border"} strokeWidth={t === 0.5 ? 1.5 : 1} strokeDasharray={t === 0.5 ? "4 3" : "2 4"} />
                <text x={x(t)} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                  {percent(t, 0)}
                </text>
              </g>
            ))}
            {rows.map((r, i) => {
              const cy = top + i * rowH + rowH / 2;
              return (
                <g
                  key={r.key}
                  tabIndex={0}
                  role="img"
                  aria-label={`${r.name}: ${percentWithRange(r.hitRate, r.lower, r.upper)} right`}
                  onMouseEnter={() => setShown(i)}
                  onMouseLeave={() => setShown(null)}
                  onFocus={() => setShown(i)}
                  onBlur={() => setShown(null)}
                  className="outline-none"
                >
                  <rect x={0} y={top + i * rowH} width={W} height={rowH} fill="transparent" />
                  <text x={left - 8} y={cy + 4} textAnchor="end" className="fill-foreground text-[12px]">
                    {narrow ? r.short : r.name}
                  </text>
                  {r.lower !== null && r.upper !== null ? <line x1={x(r.lower)} x2={x(r.upper)} y1={cy} y2={cy} className={BLUE_STROKE} strokeWidth={2} strokeLinecap="round" /> : null}
                  {r.expected !== null ? <circle cx={x(r.expected)} cy={cy} r={8} fill="none" className="stroke-foreground" strokeWidth={1.5} /> : null}
                  <circle cx={x(r.hitRate)} cy={cy} r={5} className={r.isRule ? BLUE_FILL : GRAY_FILL} stroke="var(--background, #fff)" strokeWidth={2} />
                  <text x={Math.min(W - right, x(r.upper ?? r.hitRate) + 12)} y={cy + 4} textAnchor={x(r.upper ?? r.hitRate) + 60 > W ? "end" : "start"} className="fill-foreground text-[11px]">
                    {percent(r.hitRate)}
                  </text>
                </g>
              );
            })}
          </svg>
          <p className="min-h-[1.25rem] text-xs text-muted-foreground" role="status">
            {hovered ? `${hovered.name}: ${percentWithRange(hovered.hitRate, hovered.lower, hovered.upper)} of calls right${hovered.expected !== null ? `. Guessing from the recent past would give ${percent(hovered.expected)}.` : "."}` : ""}
          </p>
        </div>
      )}
      <Legend
        items={[
          { label: "The rules", swatch: "bg-[#2a78d6] dark:bg-[#3987e5] !rounded-full" },
          { label: "Simple guesses, same moments", swatch: "bg-[#8a8985] dark:bg-[#8f8e88] !rounded-full" },
          { label: "Ring: what guessing from the recent past gives", swatch: "border-2 border-foreground !rounded-full" },
          { label: "Dashed line: 50%", swatch: "border-t-2 border-dashed border-foreground/60 !h-0 !w-4" },
        ]}
      />
    </figure>
  );
}

// ─── Average win against average loss, after fees ─────────────────────────────

export function WinLossBars({ averageWin, averageLoss }: { averageWin: number | null; averageLoss: number | null }) {
  const titleId = useId();
  const [boxRef, drawn] = useDrawnWidth();
  if (averageWin === null && averageLoss === null) {
    return <p className="text-sm text-muted-foreground">No trade has closed yet, so there is no average win or loss to show.</p>;
  }
  const loss = averageLoss === null ? null : Math.abs(averageLoss);
  const W = Math.max(280, drawn);
  const left = W < 480 ? 92 : 130;
  const right = 70;
  const rowH = 34;
  const H = rowH * 2 + 6;
  const max = Math.max(averageWin ?? 0, loss ?? 0) || 1;
  const bars = [
    { key: "win", label: "Average win", value: averageWin, fill: BLUE_FILL, text: averageWin === null ? "No wins yet" : usd(averageWin) },
    { key: "loss", label: "Average loss", value: loss, fill: RED_FILL, text: loss === null ? "No losses yet" : `-${usd(loss)}` },
  ];
  return (
    <figure className="space-y-2" aria-labelledby={titleId}>
      <figcaption id={titleId} className="text-sm font-medium">
        Average win against average loss, after fees
      </figcaption>
      <div ref={boxRef}>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Average win ${bars[0]!.text}, average loss ${bars[1]!.text}, both after fees.`} data-testid="win-loss-chart">
          <line x1={left} x2={left} y1={0} y2={H} className="stroke-foreground/40" strokeWidth={1.5} />
          {bars.map((b, i) => {
            const cy = 3 + i * rowH + rowH / 2;
            const w = b.value === null ? 0 : Math.max(2, (b.value / max) * (W - left - right));
            return (
              <g key={b.key}>
                <text x={left - 8} y={cy + 4} textAnchor="end" className="fill-foreground text-[12px]">
                  {b.label}
                </text>
                {b.value === null ? null : <rect x={left} y={cy - 8} width={w} height={16} rx={4} className={b.fill} />}
                <text x={left + w + 8} y={cy + 4} className="fill-foreground text-[11px]">
                  {b.text}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <Legend
        items={[
          { label: "Average win", swatch: "bg-[#2a78d6] dark:bg-[#3987e5]" },
          { label: "Average loss", swatch: "bg-[#e34948] dark:bg-[#e66767]" },
        ]}
      />
    </figure>
  );
}

// ─── Calibration: only for forecasters that give a real probability ───────────

export function CalibrationChart({ forecaster }: { forecaster: TradingScoreboardForecaster }) {
  const [shown, setShown] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();
  const [boxRef, drawn] = useDrawnWidth();
  const probability = forecaster.probability;
  if (!probability) return null;
  const points = probability.calibration.filter((c) => c.count > 0);
  const S = Math.min(Math.max(240, drawn), 360);
  const pad = 34;
  const x = (v: number) => pad + v * (S - pad - 18);
  const y = (v: number) => S - pad - v * (S - pad - 18);
  const hovered = shown === null ? null : points[shown];
  const maxCount = Math.max(1, ...points.map((p) => p.count));

  return (
    <figure className="space-y-2" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption id={titleId} className="text-sm font-medium">
          Does "70% sure" really mean 70%? {forecasterName(forecaster.forecasterKey)}
        </figcaption>
        <ChartTableToggle asTable={asTable} onToggle={() => setAsTable((v) => !v)} />
      </div>
      <p className="text-xs text-muted-foreground">
        Each dot groups calls made with a similar level of confidence. A dot on the diagonal line means the confidence was honest. Bigger dots hold more calls.
      </p>
      {asTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="calibration-table">
            <caption className="sr-only">Stated confidence against how often the market went up</caption>
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">Confidence it goes up</th>
                <th scope="col" className="py-1 pr-3 font-medium">Calls</th>
                <th scope="col" className="py-1 font-medium">How often it went up</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.bucket} className="border-b border-border/60">
                  <td className="py-1 pr-3">{percent(p.from, 0)} to {percent(p.to, 0)}</td>
                  <td className="py-1 pr-3">{p.count}</td>
                  <td className="py-1">{percent(p.observedUpShare)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={boxRef}>
          <svg viewBox={`0 0 ${S} ${S}`} className="mx-auto h-auto w-full max-w-[360px]" role="img" aria-label="Calibration chart: how sure the forecaster said it was against how often the market went up." data-testid="calibration-chart">
            {[0, 0.5, 1].map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={y(0)} y2={y(1)} className="stroke-border" strokeWidth={1} strokeDasharray="2 4" />
                <line x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} strokeDasharray="2 4" />
                <text x={x(t)} y={S - 14} textAnchor="middle" className="fill-muted-foreground text-[11px]">{percent(t, 0)}</text>
                <text x={pad - 6} y={y(t) + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">{percent(t, 0)}</text>
              </g>
            ))}
            <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} className="stroke-foreground/50" strokeWidth={1.5} strokeDasharray="4 3" />
            <text x={S / 2} y={S - 1} textAnchor="middle" className="fill-muted-foreground text-[10px]">How sure it said it was</text>
            {points.map((p, i) => (
              <g
                key={p.bucket}
                tabIndex={0}
                role="img"
                aria-label={`Around ${percent(p.meanForecast, 0)} sure, ${p.count} calls, went up ${percent(p.observedUpShare, 0)} of the time`}
                onMouseEnter={() => setShown(i)}
                onMouseLeave={() => setShown(null)}
                onFocus={() => setShown(i)}
                onBlur={() => setShown(null)}
                className="outline-none"
              >
                <circle cx={x(p.meanForecast)} cy={y(p.observedUpShare)} r={14} fill="transparent" />
                <circle cx={x(p.meanForecast)} cy={y(p.observedUpShare)} r={4 + 5 * Math.sqrt(p.count / maxCount)} className={BLUE_FILL} stroke="var(--background, #fff)" strokeWidth={2} opacity={shown === null || shown === i ? 1 : 0.55} />
              </g>
            ))}
          </svg>
          <p className="min-h-[1.25rem] text-xs text-muted-foreground" role="status">
            {hovered ? `Around ${percent(hovered.meanForecast, 0)} sure, ${hovered.count} calls: it went up ${percent(hovered.observedUpShare, 0)} of the time.` : ""}
          </p>
        </div>
      )}
      <Legend
        items={[
          { label: "Groups of calls", swatch: "bg-[#2a78d6] dark:bg-[#3987e5] !rounded-full" },
          { label: "Dashed diagonal: honest confidence", swatch: "border-t-2 border-dashed border-foreground/60 !h-0 !w-4" },
        ]}
      />
    </figure>
  );
}

// ─── Per market weather ───────────────────────────────────────────────────────

function WeatherTable({ forecaster }: { forecaster: TradingScoreboardForecaster }) {
  const rows = forecaster.byRegime ?? [];
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No market weather was recorded with these calls.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid={`weather-table-${forecaster.forecasterKey}`}>
        <caption className="sr-only">Hit rate in each kind of market weather for {forecasterName(forecaster.forecasterKey)}</caption>
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">Market weather</th>
            <th scope="col" className="py-1 pr-3 font-medium">Calls right</th>
            <th scope="col" className="py-1 pr-3 font-medium">Calls scored</th>
            <th scope="col" className="py-1 font-medium">Separate stretches</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.regime} className="border-b border-border/60">
              <td className="py-1 pr-3">{weatherLabel(r.regime)}</td>
              <td className="py-1 pr-3">{percent(r.hitRate)}</td>
              <td className="py-1 pr-3">{wholeNumber(r.scored)}</td>
              <td className="py-1">
                {spellsWords(r.spells)}
                {r.spells < FEW_SPELLS ? <span className="block text-xs text-muted-foreground">Too few to say much</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── The page section ────────────────────────────────────────────────────────

export function TradingScoreboardSection({ board }: { board: Scoreboard }) {
  const headline = scoreboardHeadline(board);
  const ready = board.status.status === "ready";
  const forecasters = orderForecasters(board.forecasters);
  const rule = forecasters.find((f) => isRuleForecaster(f.forecasterKey)) ?? null;
  const status = board.status;
  const time = board.time ?? { runningMs: status.runningMs, calendarMs: status.calendarMs, gapMs: Math.max(0, status.calendarMs - status.runningMs) };
  const minDays = board.plan?.minRunningDays ?? Math.round(status.minRunningMs / 86_400_000);
  const probabilistic = forecasters.filter((f) => f.probability !== null);
  const rows = hitRows(forecasters);

  return (
    <section className="space-y-4 rounded-lg border border-border p-4" aria-label="Prediction scoreboard" data-testid="trading-scoreboard">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Prediction scoreboard</h2>
        {board.version !== null ? <span className="text-xs text-muted-foreground">Version {board.version} of the rules</span> : null}
      </div>

      <div className={`rounded-lg border p-3 ${HEADLINE_TONE[headline.kind]}`} data-testid="scoreboard-headline" data-kind={headline.kind}>
        <p className="text-base font-semibold">{headline.text}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{headline.detail}</p>
      </div>

      <div className="space-y-3">
        <ProgressRow
          label="Independent predictions scored"
          value={status.samples}
          max={status.targetSamples}
          detail={`${wholeNumber(status.samples)} of ${wholeNumber(status.targetSamples)}`}
        />
        <ProgressRow
          label="Running time"
          value={time.runningMs}
          max={status.minRunningMs || minDays * 86_400_000}
          detail={`${days(time.runningMs)} of ${minDays} days running`}
        />
        <p className="text-xs text-muted-foreground" data-testid="scoreboard-time">
          Running time: {days(time.runningMs)}. Calendar time: {days(time.calendarMs)}. Time spent paused or stopped does not count as running time.
        </p>
      </div>

      {rule ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Fact label="Calls made" value={wholeNumber(rule.calls)} hint={`${wholeNumber(rule.pending)} still waiting for the outcome`} />
          <Fact label="Independent observations" value={wholeNumber(rule.independentResolved)} hint="Calls far enough apart not to overlap" />
          <Fact label="Effective observations" value={wholeNumber(rule.effectiveSampleSize)} hint="After allowing for calls that repeat each other" />
          <Fact label="Coverage" value={rule.coverage === null ? "—" : percent(rule.coverage, 0)} hint="Share of moments the rules made a call" />
        </div>
      ) : null}

      {!ready ? (
        <p className="text-sm text-muted-foreground" data-testid="scoreboard-collecting-note">
          Hit rates, wins and losses, and the market weather breakdown appear here once the fixed number of predictions and the running time are both reached.
        </p>
      ) : (
        <>
          <div className="space-y-4 border-t border-border pt-4">
            <HitRateChart rows={rows} />
            {rule && rule.expectedHitRateFromBaseRate !== null ? (
              <p className="text-xs text-muted-foreground">
                The rules were right {percent(rule.hitRate)} of the time. Always guessing what has been more common lately would give {percent(rule.expectedHitRateFromBaseRate)}.
              </p>
            ) : null}
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            {board.trades ? (
              <>
                <WinLossBars averageWin={board.trades.averageWinUsd} averageLoss={board.trades.averageLossUsd} />
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Fact label="Trades closed" value={wholeNumber(board.trades.trades)} />
                  <Fact label="Trades that made money" value={board.trades.winRate === null ? "—" : percent(board.trades.winRate, 0)} />
                  <Fact label="Fees paid" value={usd(board.trades.feesUsd)} />
                  <Fact label="Result after fees" value={usd(board.trades.netPnlUsd)} />
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No trade has closed yet, so there is no average win or loss to show.</p>
            )}
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            {probabilistic.length > 0 ? (
              probabilistic.map((f) => <CalibrationChart key={f.forecasterKey} forecaster={f} />)
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="no-calibration-note">
                No confidence chart: the rules give a direction (up or down), not a percentage, so there is nothing to check for honesty.
              </p>
            )}
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            <h3 className="text-sm font-medium">Hit rate in each kind of market weather</h3>
            <p className="text-xs text-muted-foreground">
              Weather changes slowly, so a score can rest on only a handful of separate stretches. Look at the last column before trusting a number.
            </p>
            {forecasters.map((f) =>
              isRuleForecaster(f.forecasterKey) ? (
                <div key={f.forecasterKey} className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{forecasterName(f.forecasterKey)}</p>
                  <WeatherTable forecaster={f} />
                </div>
              ) : null,
            )}
            {forecasters.some((f) => !isRuleForecaster(f.forecasterKey) && f.byRegime) ? (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground underline underline-offset-2">Show the simple guesses by weather too</summary>
                <div className="mt-2 space-y-3">
                  {forecasters
                    .filter((f) => !isRuleForecaster(f.forecasterKey))
                    .map((f) => (
                      <div key={f.forecasterKey} className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">{forecasterName(f.forecasterKey)}</p>
                        <WeatherTable forecaster={f} />
                      </div>
                    ))}
                </div>
              </details>
            ) : null}
          </div>
        </>
      )}

      <p className="border-t border-border pt-3 text-xs text-muted-foreground" data-testid="scoreboard-disclaimer">
        {SCOREBOARD_DISCLAIMER}
      </p>
    </section>
  );
}
