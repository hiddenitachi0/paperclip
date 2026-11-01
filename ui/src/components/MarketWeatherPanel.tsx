import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatRegimeDay, type TradingRegimeSpell } from "@paperclipai/shared";
import { tradingApi, type MarketWeatherItem } from "../api/trading";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";

/**
 * Market weather (DUR-5013): one plain line per coin saying what the price has
 * been doing lately. It describes the past only and never says what to do, so
 * the wording stays neutral on purpose.
 */

const TREND_WORDS = { uptrend: "Going up", downtrend: "Going down", ranging: "Moving sideways" } as const;
const SWING_WORDS = { low: "calm swings", normal: "normal swings", high: "big swings" } as const;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function spellLine(spell: TradingRegimeSpell, now: Date): string {
  const parts: string[] = [TREND_WORDS[spell.trend], SWING_WORDS[spell.volatility]];
  if (spell.squeeze) parts.push("unusually quiet");
  const length = spell.days === 1 ? "1 day" : `${spell.days} days`;
  return `${parts.join(", ")} — from ${formatRegimeDay(spell.startDay, now)}, ${length}`;
}

function CoinHistory({ companyId, item }: { companyId: string; item: MarketWeatherItem }) {
  const query = useQuery({
    queryKey: queryKeys.trading.marketWeatherHistory(companyId, item.asset),
    queryFn: () => tradingApi.marketWeatherHistory(companyId, item.asset, 5),
    staleTime: 5 * 60_000,
  });
  if (query.isLoading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (query.error || !query.data) {
    return <p className="text-xs text-destructive">Could not load the history. {query.error ? errorMessage(query.error) : ""}</p>;
  }
  const { spells, flips } = query.data;
  const now = new Date();
  return (
    <div className="space-y-1" data-testid="market-weather-history">
      <p className="text-xs text-muted-foreground">
        {flips.spells === 1
          ? "The weather has stayed the same for the whole stored history."
          : `The weather has changed ${flips.spells - 1} times over ${flips.days} stored days.`}
      </p>
      <ul className="space-y-0.5 text-xs">
        {spells.map((spell) => (
          <li key={spell.spellNo}>{spellLine(spell, now)}</li>
        ))}
      </ul>
    </div>
  );
}

function CoinRow({ companyId, item }: { companyId: string; item: MarketWeatherItem }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="px-4 py-2.5" data-testid="market-weather-row">
      <p className="text-sm">{item.text}</p>
      {item.squeeze ? (
        <p className="mt-0.5 text-xs text-muted-foreground" data-testid="market-weather-squeeze">
          Prices have barely moved lately. A bigger move can follow, up or down.
        </p>
      ) : null}
      <button
        type="button"
        className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide recent changes" : `Show recent changes for ${item.name}`}
      </button>
      {open ? (
        <div className="mt-1.5">
          <CoinHistory companyId={companyId} item={item} />
        </div>
      ) : null}
    </li>
  );
}

export function MarketWeatherPanel({ companyId }: { companyId: string }) {
  const query = useQuery({
    queryKey: queryKeys.trading.marketWeather(companyId),
    queryFn: () => tradingApi.marketWeather(companyId),
    refetchInterval: 10 * 60_000,
  });
  const items = query.data?.items ?? [];

  return (
    <section className="space-y-2" aria-labelledby="market-weather-title" data-testid="market-weather">
      <div>
        <h2 id="market-weather-title" className="text-sm font-semibold">
          Market weather
        </h2>
        <p className="text-xs text-muted-foreground">
          What each coin's price has been doing lately. It looks back at finished days only — it is not a tip about what
          happens next.
        </p>
      </div>
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : query.error ? (
        <p className="text-sm text-destructive">Could not load the market weather. {errorMessage(query.error)}</p>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground" data-testid="market-weather-empty">
          Market weather appears once the price history is stored.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((item) => (
            <CoinRow key={item.asset} companyId={companyId} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}
