import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Pause, Play, XCircle } from "lucide-react";
import { describeTradingPauseReason } from "@paperclipai/shared";
import { useParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { tradingApi } from "../api/trading";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { evaluateTradingVerdict } from "../lib/tradingVerdict";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "../components/StatusBadge";
import { PageSkeleton } from "../components/PageSkeleton";

/**
 * One strategy's dashboard: its current paper balances, the pass/fail
 * verdict from docs/specs/trading-agent-pass-fail-criteria.md, and a plain
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

function VerdictBadge({ verdict }: { verdict: "gathering_data" | "passing" | "failing" }) {
  if (verdict === "gathering_data") {
    return <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">Gathering data</span>;
  }
  if (verdict === "passing") {
    return (
      <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-300">
        Passing
      </span>
    );
  }
  return (
    <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-300">
      Failing
    </span>
  );
}

export function TradingStrategyDetail() {
  const { strategyId } = useParams<{ strategyId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const role = useCompanyRole(selectedCompanyId);
  const canManage = role.canManageConnections;

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

  const verdict = useMemo(() => {
    if (!dashboardQuery.data || !strategy || !ordersQuery.data) return null;
    return evaluateTradingVerdict(dashboardQuery.data, strategy.riskConfig, strategy.createdAt, ordersQuery.data);
  }, [dashboardQuery.data, strategy, ordersQuery.data]);

  const setStatus = useMutation({
    mutationFn: (status: "running" | "paused") => tradingApi.setStatus(selectedCompanyId!, strategyId!, status),
    onSuccess: () => {
      if (selectedCompanyId) queryClient.invalidateQueries({ queryKey: queryKeys.trading.list(selectedCompanyId) });
    },
    onError: (error) => pushToast({ title: "Could not change the strategy", body: errorMessage(error, ""), tone: "error" }),
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
        </div>
        {canManage ? (
          <Button
            variant={running ? "outline" : "default"}
            onClick={() => setStatus.mutate(running ? "paused" : "running")}
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
              <h2 className="text-sm font-semibold">Pass/fail verdict</h2>
              {verdict ? <VerdictBadge verdict={verdict.verdict} /> : null}
            </div>
            {verdict ? (
              <>
                <p className="mb-3 text-xs text-muted-foreground">{verdict.windowNote}</p>
                {verdict.checks.length > 0 ? (
                  <ul className="space-y-1.5">
                    {verdict.checks.map((check) => (
                      <li key={check.label} className="flex items-center gap-2 text-sm">
                        {check.ok ? (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
                        ) : (
                          <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                        )}
                        {check.label}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Still loading orders to compute the verdict.</p>
            )}
          </div>
        </>
      ) : null}

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
