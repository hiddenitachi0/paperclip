import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import { Link, useParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { tradingApi, type TradingBacktestRun } from "../api/trading";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { formatDate } from "../lib/utils";
import { PageSkeleton } from "../components/PageSkeleton";
import { TradingDisclaimer } from "../components/TradingDisclaimer";
import { CompareBars, WindowBars } from "../components/TradingBacktestCharts";
import {
  PAPER_ONLY_LABEL,
  coverageLine,
  headlineSentence,
  lookedAtWords,
  percentWords,
  plainGateDetail,
  plainGateLabel,
  readReport,
  signedPercent,
  triedWords,
  type CoinReport,
  type ReadReport,
  type TradeNumbers,
} from "../lib/tradingBacktestWords";

/**
 * The past-data test report, in plain words. The checklist and the verdict
 * come from the server; this page only chooses the words and draws the charts.
 */

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="space-y-3 rounded-lg border border-border p-4" data-testid={testId}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function TickRow({ passed, label, detail }: { passed: boolean | null; label: string; detail: string }) {
  return (
    <li className="flex gap-2.5 py-2">
      {passed === true ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-label="Passed" />
      ) : passed === false ? (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-label="Did not pass" />
      ) : (
        <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-label="Could not be checked" />
      )}
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
    </li>
  );
}

function tradeLine(n: TradeNumbers | null): string {
  if (!n || n.trades === 0) return "No trades";
  const parts = [`${n.trades} ${n.trades === 1 ? "trade" : "trades"}`];
  if (n.hitRate !== null) parts.push(`${percentWords(n.hitRate)} won`);
  if (n.perTradePercent !== null) parts.push(`${signedPercent(n.perTradePercent)} per trade`);
  return parts.join(", ");
}

function CoinCard({ coin }: { coin: CoinReport }) {
  return (
    <li className="space-y-1.5 rounded-md border border-border p-3" data-testid={`coin-${coin.coin}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{coin.coin}</h3>
        {coin.headline ? (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-900 dark:bg-blue-900/30 dark:text-blue-200">Main result</span>
        ) : (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
            Picked after the fact: treat as a hint, not proof
          </span>
        )}
      </div>
      <p className="text-sm">
        <span className="text-muted-foreground">With double fees: </span>
        {tradeLine(coin.doubleFees)}
      </p>
      <p className="text-sm">
        <span className="text-muted-foreground">With normal fees: </span>
        {tradeLine(coin.normalFees)}
      </p>
      <p className={`text-sm ${coin.missingStates.length > 0 ? "font-medium text-amber-800 dark:text-amber-300" : "text-muted-foreground"}`}>{coverageLine(coin)}</p>
    </li>
  );
}

function ReportBody({ run, report, tried, looked }: { run: TradingBacktestRun; report: ReadReport; tried: number | null; looked: number | null }) {
  const passed = report.passed === true;
  const chartCoins = report.coins.filter((c) => c.windows.length > 0);
  const [selected, setSelected] = useState<string | null>(null);
  const coin = chartCoins.find((c) => c.coin === selected) ?? chartCoins.find((c) => c.headline) ?? chartCoins[0] ?? null;
  const rules = useMemo(() => report.items, [report.items]);

  return (
    <div className="space-y-6">
      <div
        className={`rounded-lg border p-4 ${passed ? "border-green-300 bg-green-50 dark:border-green-900 dark:bg-green-950/30" : "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30"}`}
        data-testid="report-verdict"
      >
        <div className="flex items-start gap-2.5">
          {passed ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" aria-hidden="true" /> : <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />}
          <div className="space-y-1">
            <h2 className="text-base font-semibold">{passed ? PAPER_ONLY_LABEL : "Did not pass the past-data checks"}</h2>
            <p className="text-sm" data-testid="report-headline">{headlineSentence(report)}</p>
            {passed ? (
              <p className="text-xs text-muted-foreground">Passing does not mean it will make money later. It only means these rules held up on past prices. This is play money only.</p>
            ) : (
              <p className="text-xs text-muted-foreground">Below you can see which checks failed. A strategy can still be started by the owner with a written reason.</p>
            )}
          </div>
        </div>
      </div>

      <Section title="The checklist" testId="report-checklist">
        <ul className="divide-y divide-border">
          {rules.map((item) => (
            <TickRow key={item.key} passed={item.passed} label={plainGateLabel(item)} detail={plainGateDetail(item, report)} />
          ))}
        </ul>
      </Section>

      <Section title="How much luck could be hiding in this" testId="report-honesty">
        <ul className="list-disc space-y-1.5 pl-5 text-sm">
          <li data-testid="report-tried">
            {tried === null ? "Not known how many versions were tried." : `${triedWords(tried)}.`} The more that are tried, the easier it is for one to look good by pure luck, so the checks get stricter with every try.
          </li>
          <li data-testid="report-looked">
            {looked === null ? "Not known how often the hidden stretch was looked at." : `${lookedAtWords(looked)}.`} That is the last stretch of the past, kept out of sight until the very end. Each extra look makes it a little less fair.
          </li>
        </ul>
      </Section>

      <Section title="Coin by coin" testId="report-coins">
        <p className="text-sm text-muted-foreground">
          BTC and ETH are the main result. Any other coin is shown too, but marked, because it is easy to pick a coin that happened to do well.
        </p>
        <ul className="grid gap-3 sm:grid-cols-2">
          {report.coins.map((c) => (
            <CoinCard key={c.coin} coin={c} />
          ))}
        </ul>
        {report.skippedCoins.length > 0 ? <p className="text-sm text-muted-foreground">Not tested, because there were not enough prices stored: {report.skippedCoins.join(", ")}.</p> : null}
      </Section>

      {coin ? (
        <Section title="Charts" testId="report-charts">
          {chartCoins.length > 1 ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Choose a coin">
              {chartCoins.map((c) => (
                <button
                  key={c.coin}
                  type="button"
                  aria-pressed={c.coin === coin.coin}
                  onClick={() => setSelected(c.coin)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${c.coin === coin.coin ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:bg-muted"}`}
                >
                  {c.coin}
                </button>
              ))}
            </div>
          ) : null}
          <WindowBars windows={coin.windows} coin={coin.coin} />
          {coin.random ? <CompareBars coin={coin.coin} strategy={coin.doubleFees?.perTradePercent ?? null} randomTypical={coin.random.typicalPercent} randomTop={coin.random.topFivePercent} /> : null}
        </Section>
      ) : null}

      <details className="rounded-lg border border-border p-4 text-sm" data-testid="report-glossary">
        <summary className="cursor-pointer font-semibold">What the words mean</summary>
        <dl className="mt-3 space-y-2">
          <div>
            <dt className="font-medium">Periods it had not seen</dt>
            <dd className="text-muted-foreground">The test never judges the rules on the prices they were tuned on. It slides forward in three-month steps and only counts the stretch that comes after.</dd>
          </div>
          <div>
            <dt className="font-medium">Double fees</dt>
            <dd className="text-muted-foreground">Every trade is charged twice the usual fee. If the rules still make money, small cost changes will not ruin them.</dd>
          </div>
          <div>
            <dt className="font-medium">Random guessing</dt>
            <dd className="text-muted-foreground">Buying at random moments and holding for as long as the strategy did. A strategy has to clearly beat this to count.</dd>
          </div>
          <div>
            <dt className="font-medium">Worst drop</dt>
            <dd className="text-muted-foreground">The biggest fall from a high point to a low point inside one test period.</dd>
          </div>
          <div>
            <dt className="font-medium">Rising, falling and sideways markets</dt>
            <dd className="text-muted-foreground">Rules that only worked while prices went up are not safe. The test checks each coin in all three kinds of weather.</dd>
          </div>
          <div>
            <dt className="font-medium">Hidden final stretch</dt>
            <dd className="text-muted-foreground">The most recent year of prices, kept out of sight until the very end, like an exam paper nobody has seen.</dd>
          </div>
        </dl>
      </details>

      <p className="text-xs text-muted-foreground">
        Test run {formatDate(run.finishedAt ?? run.createdAt)}
        {report.timeframe ? `, decisions every ${report.timeframe}` : ""}. Prices from the same source the strategy trades on. The numbers the checks use are starting guesses, and each result is saved with the numbers it was judged by.
      </p>
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

export function TradingBacktestReport() {
  const { strategyId, runId } = useParams<{ strategyId: string; runId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const strategiesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.trading.list(selectedCompanyId) : ["trading-strategies", "__none__"],
    queryFn: () => tradingApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const strategy = (strategiesQuery.data ?? []).find((s) => s.id === strategyId) ?? null;

  const runQuery = useQuery({
    queryKey: selectedCompanyId && strategyId && runId ? queryKeys.trading.backtest(selectedCompanyId, strategyId, runId) : ["trading-backtest", "__none__"],
    queryFn: () => tradingApi.backtest(selectedCompanyId!, strategyId!, runId!),
    enabled: Boolean(selectedCompanyId && strategyId && runId),
    refetchInterval: (query) => (query.state.data?.status === "queued" || query.state.data?.status === "running" ? 5_000 : false),
  });
  const gateQuery = useQuery({
    queryKey: selectedCompanyId && strategyId ? queryKeys.trading.startGate(selectedCompanyId, strategyId) : ["trading-start-gate", "__none__"],
    queryFn: () => tradingApi.startGate(selectedCompanyId!, strategyId!),
    enabled: Boolean(selectedCompanyId && strategyId),
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Trading", href: "/trading" },
      { label: strategy?.name ?? "Strategy", href: strategyId ? `/trading/${strategyId}` : "/trading" },
      { label: "Past-data test" },
    ]);
  }, [setBreadcrumbs, strategy?.name, strategyId]);

  if (runQuery.isLoading) return <PageSkeleton variant="dashboard" />;
  const run = runQuery.data ?? null;
  const report = run ? readReport(run) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <Link to={strategyId ? `/trading/${strategyId}` : "/trading"} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
          Back to {strategy?.name ?? "the strategy"}
        </Link>
        <h1 className="text-lg font-semibold">Test on past data</h1>
        <p className="text-sm text-muted-foreground">How these rules would have done on prices from the past, in periods they had not been tuned on.</p>
        <TradingDisclaimer />
      </div>

      {runQuery.error ? (
        <div className="py-6 text-sm text-destructive">{errorMessage(runQuery.error, "Could not load this test.")}</div>
      ) : !run ? null : run.status === "queued" || run.status === "running" ? (
        <div className="rounded-lg border border-border p-4 text-sm" role="status" data-testid="report-waiting">
          {run.status === "queued" ? "This test is waiting for its turn. This page updates by itself." : "This test is running. It can take several minutes. This page updates by itself."}
        </div>
      ) : run.status !== "succeeded" || !report ? (
        <div className="rounded-lg border border-border p-4 text-sm" data-testid="report-no-result">
          {run.status === "cancelled" ? "This test was withdrawn before it started." : "This test did not finish."} {run.error ?? ""} You can start a new one from the strategy page.
        </div>
      ) : (
        <ReportBody run={run} report={report} tried={gateQuery.data?.variantsTried ?? report.variantsInHistory} looked={gateQuery.data?.holdoutReads ?? null} />
      )}
    </div>
  );
}
