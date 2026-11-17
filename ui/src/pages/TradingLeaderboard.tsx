import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { TRADING_EXCLUDED_STYLES } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { tradingApi } from "../api/trading";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { buildLeaderboard, choiceWords, formatRange, formatResult, LUCK_WARNING, RESULT_EXPLAINER, type LeaderboardRow } from "../lib/tradingLeaderboard";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { TradingDisclaimer } from "../components/TradingDisclaimer";
import { Trophy } from "lucide-react";

/**
 * The strategy leaderboard (DUR-5016). It ranks only on evidence the strategy
 * did not get to see while it was being built: trades the shadow run made going
 * forward, checked by the monthly test. Every row shows its range and how many
 * trades are behind it, and the whole list says how many ideas were tried, so a
 * lucky top number is not read as a result. Labels stay neutral on purpose.
 */

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function Row({ row, rank }: { row: LeaderboardRow; rank: number | null }) {
  return (
    <li className="space-y-1.5 px-4 py-3" data-testid="leaderboard-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {rank !== null ? <span className="mr-2 text-muted-foreground">{rank}.</span> : null}
            {row.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {row.familyWords} · {row.asset} · {row.weatherWords}
          </p>
        </div>
        {row.holdsPaperCash ? (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs" data-testid="leaderboard-holds-cash">
            Holds paper cash
          </span>
        ) : null}
      </div>
      {row.tested ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Typical result per trade</dt>
            <dd className="font-medium" data-testid="leaderboard-typical">
              {formatResult(row.typical)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Range</dt>
            <dd data-testid="leaderboard-range">{formatRange(row.low, row.high)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Trades behind it</dt>
            <dd data-testid="leaderboard-trades">{row.trades}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="leaderboard-trades">
          {row.trades} {row.trades === 1 ? "trade" : "trades"} so far. Too few to give a result or a range.
        </p>
      )}
      <p className="text-xs text-muted-foreground" data-testid="leaderboard-status">
        {row.statusWords}.{row.progress ? ` ${row.progress}.` : ""}
      </p>
      {row.shadow ? (
        <p className="text-xs text-muted-foreground" data-testid="leaderboard-shadow">
          Since then: {row.shadow.closed} closed, {row.shadow.open} open. Average at normal fees {formatResult(row.shadow.meanR1x)}, at double fees {formatResult(row.shadow.meanR2x)}.
        </p>
      ) : null}
    </li>
  );
}

export function TradingLeaderboard() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Trading", href: "/trading" }, { label: "Leaderboard" }]);
  }, [setBreadcrumbs]);

  const decisionsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.trading.selectorDecisions(selectedCompanyId) : ["trading-selector-decisions", "__none__"],
    queryFn: () => tradingApi.selectorDecisions(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  // The server lists newest first; the latest monthly check is the one the board shows.
  const latest = decisionsQuery.data?.items[0] ?? null;

  const decisionQuery = useQuery({
    queryKey: selectedCompanyId && latest ? queryKeys.trading.selectorDecision(selectedCompanyId, latest.id) : ["trading-selector-decision", "__none__"],
    queryFn: () => tradingApi.selectorDecision(selectedCompanyId!, latest!.id),
    enabled: Boolean(selectedCompanyId && latest),
  });
  const shadowQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.trading.shadowCells(selectedCompanyId) : ["trading-shadow-cells", "__none__"],
    queryFn: () => tradingApi.shadowCells(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const decision = decisionQuery.data ?? null;
  const board = useMemo(() => (decision ? buildLeaderboard(decision.output, shadowQuery.data?.items ?? []) : null), [decision, shadowQuery.data]);

  const loading = decisionsQuery.isLoading || (latest !== null && decisionQuery.isLoading);
  const error = decisionsQuery.error ?? decisionQuery.error;

  return (
    <div className="mx-auto max-w-3xl space-y-5" data-testid="trading-leaderboard-page">
      <div>
        <h1 className="text-lg font-semibold">Strategy leaderboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Strategies ranked only on trades they made going forward in play money, after fees. Nothing they were built or tuned on counts here.
        </p>
        <div className="mt-1">
          <TradingDisclaimer />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm" role="note" data-testid="leaderboard-luck-warning">
        {LUCK_WARNING}
      </div>

      {loading ? (
        <PageSkeleton variant="list" />
      ) : error ? (
        <div className="py-6 text-sm text-destructive">Could not load the leaderboard. {errorMessage(error)}</div>
      ) : !latest || !board || !decision ? (
        <EmptyState icon={Trophy} message="No results yet. The first monthly check has not run, so there is nothing to rank." />
      ) : (
        <>
          <p className="text-sm text-muted-foreground" data-testid="leaderboard-trials">
            Last monthly check: {new Date(decision.checkpointAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}. It looked at{" "}
            {decision.trials} ideas in all and had enough trades to test {decision.tested}. After allowing for how many were tried, {decision.discoveries}{" "}
            stood out. {choiceWords(decision.output)}
          </p>
          <p className="text-xs text-muted-foreground">{RESULT_EXPLAINER}</p>

          {board.ranked.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground" data-testid="leaderboard-empty-ranked">
              No strategy has enough trades to rank yet.
            </p>
          ) : (
            <ol className="divide-y divide-border rounded-lg border border-border" aria-label="Ranked strategies">
              {board.ranked.map((row, i) => (
                <Row key={row.key} row={row} rank={i + 1} />
              ))}
            </ol>
          )}

          {board.unranked.length > 0 ? (
            <section className="space-y-2" aria-labelledby="leaderboard-unranked-title">
              <h2 id="leaderboard-unranked-title" className="text-sm font-semibold">
                Not ranked yet
              </h2>
              <p className="text-xs text-muted-foreground">Too few trades so far. These are not scored, so no number here is a result.</p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {board.unranked.map((row) => (
                  <Row key={row.key} row={row} rank={null} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <section className="space-y-2" aria-labelledby="leaderboard-excluded-title">
        <h2 id="leaderboard-excluded-title" className="text-sm font-semibold">
          Left out on purpose
        </h2>
        <ul className="space-y-2">
          {TRADING_EXCLUDED_STYLES.map((style) => (
            <li key={style.key} className="rounded-lg border border-dashed border-border p-3 opacity-60" aria-disabled="true" data-testid="leaderboard-excluded">
              <p className="font-medium">{style.name}</p>
              <p className="text-xs text-muted-foreground">{style.reason}</p>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/trading" className="text-sm underline-offset-2 hover:underline">
          Back to Trading
        </Link>
        <TradingDisclaimer />
      </div>
    </div>
  );
}
