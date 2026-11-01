import { useEffect, useId, useRef, useState } from "react";
import { signedPercent, type WindowResult } from "../lib/tradingBacktestWords";

/**
 * Two small charts for the past-data test report, following the house chart
 * rules: one axis, thin rounded bars on a zero line, blue for "made money" and
 * red for "lost money" (the blue/red pair, gray at zero), a legend that names
 * both, a hover/focus tooltip, a table view for anyone who prefers numbers, and
 * the same blue/red in dark mode as lighter steps. Colour is never the only
 * clue: the tooltip, the table and the "no trades" marker all say it in words.
 */

const UP = "fill-[#2a78d6] dark:fill-[#3987e5]";
const DOWN = "fill-[#e34948] dark:fill-[#e66767]";
const NEUTRAL = "fill-[#8a8985] dark:fill-[#8f8e88]";

/** The drawn width of an element, so a chart is laid out at its real size and its text stays readable on a phone. 640 until measured. */
function useDrawnWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function monthLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
}

function periodWords(w: WindowResult): string {
  return `${monthLabel(w.testStart)} to ${monthLabel(w.testEnd)}`;
}

export function Legend({ items }: { items: Array<{ label: string; swatch: string }> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span className={`inline-block h-2.5 w-2.5 rounded-sm ${item.swatch}`} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** One bar per test period: the average result per trade, after double fees. */
export function WindowBars({ windows, coin }: { windows: WindowResult[]; coin: string }) {
  const [shown, setShown] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();
  const [boxRef, drawn] = useDrawnWidth();
  if (windows.length === 0) {
    return <p className="text-sm text-muted-foreground">{coin} had no test periods: there was not enough history.</p>;
  }

  const W = Math.max(280, drawn);
  const H = 210;
  const left = 46;
  const right = 8;
  const top = 12;
  const bottom = 26;
  const values = windows.flatMap((w) => (w.perTradePercent === null ? [] : [w.perTradePercent]));
  const maxV = Math.max(0.1, ...values);
  const minV = Math.min(0, ...values);
  const span = maxV - minV || 1;
  const y = (v: number) => top + ((maxV - v) / span) * (H - top - bottom);
  const slot = (W - left - right) / windows.length;
  const barW = Math.min(26, slot * 0.6);
  const zero = y(0);
  const labelEvery = Math.max(1, Math.ceil(windows.length / Math.max(2, Math.floor((W - left - right) / 64))));
  const hovered = shown === null ? null : windows[shown];

  return (
    <figure className="space-y-2" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption id={titleId} className="text-sm font-medium">
          Result in each test period: {coin}
        </figcaption>
        <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => setAsTable((v) => !v)}>
          {asTable ? "Show the chart" : "Show as a table"}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">Average result per trade, after double fees. Each bar is one three-month stretch the rules had not seen.</p>

      {asTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="window-table">
            <caption className="sr-only">Result in each test period for {coin}</caption>
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">Period</th>
                <th scope="col" className="py-1 pr-3 font-medium">Trades</th>
                <th scope="col" className="py-1 pr-3 font-medium">Per trade</th>
                <th scope="col" className="py-1 font-medium">Worst drop</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((w) => (
                <tr key={w.index} className="border-b border-border/60">
                  <td className="py-1 pr-3">{periodWords(w)}</td>
                  <td className="py-1 pr-3">{w.trades}</td>
                  <td className="py-1 pr-3">{w.perTradePercent === null ? "No trades" : signedPercent(w.perTradePercent)}</td>
                  <td className="py-1">{w.worstDropPercent === null ? "—" : signedPercent(-w.worstDropPercent, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative" ref={boxRef}>
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Bar chart of the result in each test period for ${coin}. Use the table view for the numbers.`} data-testid="window-chart">
            {[maxV, 0, minV < 0 ? minV : null].map((tick, i) =>
              tick === null ? null : (
                <g key={i}>
                  <line x1={left} x2={W - right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? "stroke-foreground/40" : "stroke-border"} strokeWidth={tick === 0 ? 1.5 : 1} strokeDasharray={tick === 0 ? undefined : "2 4"} />
                  <text x={left - 6} y={y(tick) + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
                    {signedPercent(tick, 1)}
                  </text>
                </g>
              ),
            )}
            {windows.map((w, i) => {
              const cx = left + slot * i + slot / 2;
              const v = w.perTradePercent;
              const isShown = shown === i;
              return (
                <g
                  key={w.index}
                  tabIndex={0}
                  role="img"
                  aria-label={`${periodWords(w)}: ${v === null ? "no trades" : `${signedPercent(v)} per trade`}`}
                  onMouseEnter={() => setShown(i)}
                  onMouseLeave={() => setShown(null)}
                  onFocus={() => setShown(i)}
                  onBlur={() => setShown(null)}
                  className="outline-none"
                >
                  {/* A wide invisible target, bigger than the bar itself. */}
                  <rect x={cx - slot / 2} y={top} width={slot} height={H - top - bottom} fill="transparent" />
                  {v === null ? (
                    <circle cx={cx} cy={zero} r={4} className={`${NEUTRAL}`} />
                  ) : (
                    <rect
                      x={cx - barW / 2}
                      y={v >= 0 ? y(v) : zero}
                      width={barW}
                      height={Math.max(2, Math.abs(y(v) - zero))}
                      rx={3}
                      className={v >= 0 ? UP : DOWN}
                      opacity={shown === null || isShown ? 1 : 0.55}
                    />
                  )}
                  {i % labelEvery === 0 ? (
                    <text x={cx} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                      {monthLabel(w.testStart)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          {hovered ? (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md"
              style={{ left: `${Math.min(88, Math.max(12, ((left + slot * (shown! + 0.5)) / W) * 100))}%`, top: 0 }}
              role="status"
            >
              <p className="font-medium">{periodWords(hovered)}</p>
              <p className="text-muted-foreground">
                {hovered.perTradePercent === null ? "No trades, so this period does not count as a win." : `${signedPercent(hovered.perTradePercent)} per trade, ${hovered.trades} ${hovered.trades === 1 ? "trade" : "trades"}`}
              </p>
            </div>
          ) : null}
        </div>
      )}
      <Legend
        items={[
          { label: "Made money", swatch: "bg-[#2a78d6] dark:bg-[#3987e5]" },
          { label: "Lost money", swatch: "bg-[#e34948] dark:bg-[#e66767]" },
          { label: "No trades", swatch: "bg-[#8a8985] dark:bg-[#8f8e88] !rounded-full" },
        ]}
      />
    </figure>
  );
}

/** The strategy against two kinds of random guessing, on one scale. Plain HTML bars so the labels wrap and stay readable on a phone. */
export function CompareBars({ coin, strategy, randomTypical, randomTop }: { coin: string; strategy: number | null; randomTypical: number | null; randomTop: number | null }) {
  const rows = [
    { label: "This strategy", value: strategy, tone: "up" as const },
    { label: "Random guessing, typical", value: randomTypical, tone: "grey" as const },
    { label: "Random guessing, best 5%", value: randomTop, tone: "grey" as const },
  ];
  const known = rows.flatMap((r) => (r.value === null ? [] : [r.value]));
  if (known.length === 0) return null;
  const maxV = Math.max(0.05, ...known);
  const minV = Math.min(0, ...known);
  const span = maxV - minV;
  const zeroPct = (-minV / span) * 100;
  return (
    <figure className="space-y-2" data-testid="compare-chart">
      <figcaption className="text-sm font-medium">Against random guessing: {coin}</figcaption>
      <p className="text-xs text-muted-foreground">Average result per trade, after double fees. Random guessing buys at random moments and holds for as long as the strategy did.</p>
      <ul className="space-y-2">
        {rows.map((r) =>
          r.value === null ? null : (
            <li key={r.label} className="space-y-0.5">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span>{r.label}</span>
                <span className="font-medium tabular-nums">{signedPercent(r.value)}</span>
              </div>
              <div className="relative h-3.5 rounded-sm bg-muted/50" role="img" aria-label={`${r.label}: ${signedPercent(r.value)} per trade`}>
                <div className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: `${zeroPct}%` }} />
                <div
                  className={`absolute inset-y-0 rounded-[3px] ${r.tone === "up" ? (r.value >= 0 ? "bg-[#2a78d6] dark:bg-[#3987e5]" : "bg-[#e34948] dark:bg-[#e66767]") : "bg-[#8a8985] dark:bg-[#8f8e88]"}`}
                  style={{ left: `${r.value >= 0 ? zeroPct : zeroPct - (Math.abs(r.value) / span) * 100}%`, width: `${Math.max(1, (Math.abs(r.value) / span) * 100)}%` }}
                />
              </div>
            </li>
          ),
        )}
      </ul>
    </figure>
  );
}
