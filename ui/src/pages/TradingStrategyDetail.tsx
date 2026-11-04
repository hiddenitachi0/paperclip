import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, HelpCircle, MinusCircle, Pause, Play, Pencil, XCircle } from "lucide-react";
import { TRADING_PASS_FAIL_CRITERIA, describePassFailPower, describeTradingPauseReason, type TradingCriterionState, type TradingForwardVerdictState } from "@paperclipai/shared";
import { Link, useParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { tradingApi } from "../api/trading";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { evaluateTradingSafetyChecks } from "../lib/tradingVerdict";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "../components/StatusBadge";
import { PageSkeleton } from "../components/PageSkeleton";
import { TradingDisclaimer } from "../components/TradingDisclaimer";
import { TradingStrategyVersions } from "../components/TradingStrategyVersions";
import { TradingPastDataCard } from "../components/TradingPastDataCard";
import { startGateRefusal } from "../lib/tradingBacktestWords";
import { describeStrategyInWords } from "../lib/tradingSpecWords";
import { parseStoredSpec } from "../lib/tradingRuleBook";

/**
 * One strategy's dashboard: its current paper balances, the forward test
 * judged against docs/specs/trading-agent-pass-fail-criteria.md, and a plain
 * list of its orders. The kill switch lives here too, not just the list
 * page, since an operator who opened the dashboard to look closer is the
 * most likely person to also want to stop it right away.
 */

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function formatNok(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value).toLocaleString("nb-NO")} NOK`;
}

function VerdictBadge({ state, label }: { state: TradingForwardVerdictState; label: string }) {
  const tone =
    state === "collecting"
      ? "bg-muted text-muted-foreground"
      : state === "criteria_met"
        ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
        : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}

function CriterionIcon({ state }: { state: TradingCriterionState }) {
  if (state === "met") return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />;
  if (state === "not_met") return <XCircle className="h-4 w-4 shrink-0 text-destructive" />;
  if (state === "not_applicable") return <MinusCircle className="h-4 w-4 shrink-0 text-muted-foreground" />;
  return <HelpCircle className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

export function TradingStrategyDetail() {
  const { strategyId } = useParams<{ strategyId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const role = useCompanyRole(selectedCompanyId);
  const canManage = role.canManageConnections;
  // Only the owner (or an instance admin) may start a strategy that has not passed the past-data test; the server checks this again.
  const canOverride = role.role === "owner" || role.isInstanceAdmin;
  const [blockedReason, setBlockedReason] = useState<string | null>(null);

  const strategiesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.trading.list(selectedCompanyId) : ["trading-strategies", "__none__"],
    queryFn: () => tradingApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const strategy = (strategiesQuery.data ?? []).find((s) => s.id === strategyId) ?? null;

  useEffect(() => {
    setBreadcrumbs([{ label: "Trading", href: "/trading" }, { label: strategy?.name ?? "Strategy" }]);
  }, [setBreadcrumbs, strategy?.name]);

  const dashboardQuery = useQuery({
    queryKey: selectedCompanyId && strategyId ? queryKeys.trading.dashboard(selectedCompanyId, strategyId) : ["trading-dashboard", "__none__"],
    queryFn: () => tradingApi.dashboard(selectedCompanyId!, strategyId!),
    enabled: Boolean(selectedCompanyId && strategyId),
    refetchInterval: 60_000,
  });

  const ordersQuery = useQuery({
    queryKey: selectedCompanyId && strategyId ? queryKeys.trading.orders(selectedCompanyId, strategyId) : ["trading-orders", "__none__"],
    queryFn: () => tradingApi.orders(selectedCompanyId!, strategyId!),
    enabled: Boolean(selectedCompanyId && strategyId),
  });

  const versionsQuery = useQuery({
    queryKey: selectedCompanyId && strategyId ? queryKeys.trading.versions(selectedCompanyId, strategyId) : ["trading-versions", "__none__"],
    queryFn: () => tradingApi.versions(selectedCompanyId!, strategyId!),
    enabled: Boolean(selectedCompanyId && strategyId),
  });
  const versions = versionsQuery.data ?? [];
  const liveVersion = versions.find((v) => v.status === "approved") ?? null;
  const waitingVersion = versions.find((v) => v.status === "draft") ?? null;
  const liveSpec = liveVersion ? parseStoredSpec(liveVersion.spec) : null;

  const scoreboardQuery = useQuery({
    queryKey: selectedCompanyId && strategyId ? queryKeys.trading.scoreboard(selectedCompanyId, strategyId) : ["trading-scoreboard", "__none__"],
    queryFn: () => tradingApi.scoreboard(selectedCompanyId!, strategyId!),
    enabled: Boolean(selectedCompanyId && strategyId),
    refetchInterval: 5 * 60_000,
  });
  const criteria = scoreboardQuery.data?.criteria ?? null;

  const safetyChecks = useMemo(() => {
    if (!dashboardQuery.data || !strategy || !ordersQuery.data) return null;
    return evaluateTradingSafetyChecks(dashboardQuery.data, strategy.riskConfig, ordersQuery.data);
  }, [dashboardQuery.data, strategy, ordersQuery.data]);

  const setStatus = useMutation({
    mutationFn: ({ status, overrideReason }: { status: "running" | "paused"; overrideReason?: string }) =>
      tradingApi.setStatus(selectedCompanyId!, strategyId!, status, overrideReason),
    onSuccess: () => {
      setBlockedReason(null);
      if (selectedCompanyId && strategyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.trading.list(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.trading.startGate(selectedCompanyId, strategyId) });
      }
    },
    onError: (error) => {
      const refusal = startGateRefusal(error);
      if (refusal) {
        // The server's own reason is shown on the page, next to the test button, instead of a toast that disappears.
        setBlockedReason(refusal.reason);
        return;
      }
      pushToast({ title: "Could not change the strategy", body: errorMessage(error, ""), tone: "error" });
    },
  });

  if (strategiesQuery.isLoading || dashboardQuery.isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (!strategy) {
    return <div className="py-6 text-sm text-muted-foreground">Strategy not found.</div>;
  }

  const summary = dashboardQuery.data;
  const running = strategy.status === "running";
  const pauseText = describeTradingPauseReason(strategy.pauseReason);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">{strategy.name}</h1>
            <StatusBadge status={strategy.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            Trades {strategy.asset} with play money — checks every {strategy.checkEveryMinutes} minutes.
          </p>
          {pauseText ? <p className="text-xs text-muted-foreground">{pauseText}</p> : null}
          <TradingDisclaimer />
        </div>
        {canManage ? (
          <Button
            variant={running ? "outline" : "default"}
            onClick={() => setStatus.mutate({ status: running ? "paused" : "running" })}
            disabled={setStatus.isPending}
          >
            {running ? (
              <>
                <Pause className="mr-1.5 h-3.5 w-3.5" />
                Stop
              </>
            ) : (
              <>
                <Play className="mr-1.5 h-3.5 w-3.5" />
                Start
              </>
            )}
          </Button>
        ) : null}
      </div>

      <div className="space-y-3 rounded-lg border border-border p-4" data-testid="strategy-rules">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">The rules it follows now</h2>
          {canManage ? (
            <Button asChild variant="outline" size="sm">
              <Link to={`/trading/${strategy.id}/edit`}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Change the rules
              </Link>
            </Button>
          ) : null}
        </div>
        {liveSpec ? (
          <p className="text-sm text-muted-foreground" data-testid="strategy-live-read-back">
            {describeStrategyInWords(liveSpec)}
          </p>
        ) : versionsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <p className="text-sm text-muted-foreground">The rules could not be shown.</p>
        )}
        {waitingVersion ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 p-3 text-sm" data-testid="strategy-waiting-banner">
            <Clock className="h-4 w-4 shrink-0" />
            <span>
              Waiting for approval: version {waitingVersion.version}. The strategy keeps using the rules above until it is approved.
            </span>
            {waitingVersion.approvalId ? (
              <Link to={`/approvals/${waitingVersion.approvalId}`} className="font-medium underline">
                Open the approval card
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>

      {selectedCompanyId && strategyId ? (
        <TradingPastDataCard
          companyId={selectedCompanyId}
          strategyId={strategyId}
          canManage={canManage}
          blockedReason={blockedReason}
          canOverride={canOverride}
          overrideBusy={setStatus.isPending}
          onOverride={(overrideReason) => setStatus.mutate({ status: "running", overrideReason })}
        />
      ) : null}

      {dashboardQuery.error ? (
        <div className="py-6 text-sm text-destructive">{errorMessage(dashboardQuery.error, "Could not load the dashboard.")}</div>
      ) : summary ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Cash" value={formatNok(summary.cashNok)} />
            <StatTile label="Position value" value={formatNok(summary.positionValueNok)} />
            <StatTile label="Total profit/loss" value={formatNok(summary.totalPnlNok)} tone={summary.totalPnlNok >= 0 ? "good" : "bad"} />
            <StatTile
              label="Buy-and-hold would be worth"
              value={summary.buyAndHoldValueNok !== null ? formatNok(summary.buyAndHoldValueNok) : "Unknown"}
            />
            <StatTile label="Fees paid" value={formatNok(summary.feesPaidNok)} />
            <StatTile label="Orders today" value={String(summary.ordersToday)} />
            <StatTile
              label="Last checked"
              value={summary.lastTickAt ? timeAgo(summary.lastTickAt) : "Not checked yet"}
            />
            <StatTile label="Last check error" value={summary.lastTickError ?? "None"} tone={summary.lastTickError ? "bad" : undefined} />
          </div>

          <div className="rounded-lg border border-border p-4">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-semibold">Forward paper test against the written criteria</h2>
              {criteria ? <VerdictBadge state={criteria.state} label={criteria.label} /> : null}
            </div>
            {criteria ? (
              <>
                <p className="mb-3 text-xs text-muted-foreground">{criteria.note}</p>
                <ul className="space-y-1.5">
                  {criteria.items.map((item) => (
                    <li key={item.key} className="flex items-start gap-2 text-sm">
                      <CriterionIcon state={item.state} />
                      <span>
                        {item.label}
                        <span className="block text-xs text-muted-foreground">{item.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-muted-foreground">
                  {describePassFailPower()} {TRADING_PASS_FAIL_CRITERIA.assumptionNote}
                </p>
              </>
            ) : scoreboardQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading the scoreboard.</p>
            ) : (
              <p className="text-xs text-muted-foreground">No approved version of the rules is collecting predictions yet, so there is nothing to judge.</p>
            )}
            {safetyChecks ? (
              <div className="mt-4 border-t border-border pt-3">
                <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">Safety checks (about the machinery, not the result)</h3>
                <ul className="space-y-1.5">
                  {safetyChecks.map((check) => (
                    <li key={check.label} className="flex items-center gap-2 text-sm">
                      <CriterionIcon state={check.ok ? "met" : "not_met"} />
                      {check.label}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <TradingStrategyVersions versions={versions} orders={ordersQuery.data ?? []} />

      <div className="rounded-lg border border-border">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Orders</h2>
        </div>
        {ordersQuery.isLoading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
        ) : ordersQuery.error ? (
          <div className="px-4 py-6 text-sm text-destructive">{errorMessage(ordersQuery.error, "Could not load the orders.")}</div>
        ) : (ordersQuery.data ?? []).length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">No orders yet.</div>
        ) : (
          <ul className="divide-y divide-border">
            {[...(ordersQuery.data ?? [])].reverse().map((order) => (
              <li key={order.id} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium capitalize">{order.side}</span>
                  <span className="text-muted-foreground">{order.status.replace(/_/g, " ")}</span>
                  {order.approvalId ? <span className="text-xs text-muted-foreground">(approved)</span> : null}
                </div>
                <div className="text-right text-muted-foreground">
                  {order.filledPriceNok !== null ? formatNok(order.filledPriceNok) : formatNok(order.signalPriceNok)}
                  <span className="ml-2 text-xs">{timeAgo(order.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-base font-semibold ${tone === "good" ? "text-green-700 dark:text-green-400" : tone === "bad" ? "text-destructive" : ""}`}>
        {value}
      </p>
    </div>
  );
}
