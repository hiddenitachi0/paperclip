import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CandlestickChart, Pause, Play } from "lucide-react";
import { describeTradingPauseReason, type CreateTradingStrategyInput } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { tradingApi, type TradingStrategySummary } from "../api/trading";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { CreateTradingStrategyDialog } from "../components/CreateTradingStrategyDialog";

/**
 * Trading agent (DUR-4153/DUR-4171/DUR-4227): one page listing every
 * paper-trading strategy for the company, with the kill switch front and
 * center. Board owner/admin may add strategies and pull the switch; any
 * active member can see the list — the same read/write split
 * `server/src/routes/trading.ts` already enforces.
 */

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function StrategyRow({
  strategy,
  canManage,
  busy,
  onToggle,
}: {
  strategy: TradingStrategySummary;
  canManage: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  const running = strategy.status === "running";
  const pauseText = describeTradingPauseReason(strategy.pauseReason);
  return (
    <li className="px-4 py-3" data-testid="trading-strategy-row">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            <Link to={`/trading/${strategy.id}`} className="hover:underline">
              {strategy.name}
            </Link>
            <StatusBadge status={strategy.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            Trades {strategy.asset} with play money — checks every {strategy.checkEveryMinutes} minutes.
          </p>
          {pauseText ? <p className="text-xs text-muted-foreground">{pauseText}</p> : null}
          {strategy.lastTickError ? <p className="text-xs text-destructive">Last check failed: {strategy.lastTickError}</p> : null}
        </div>
        {canManage ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant={running ? "outline" : "default"}
              size="sm"
              onClick={onToggle}
              disabled={busy}
              aria-label={running ? `Stop ${strategy.name}` : `Start ${strategy.name}`}
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
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function Trading() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const role = useCompanyRole(selectedCompanyId);
  const canManage = role.canManageConnections;

  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Trading" }]);
  }, [setBreadcrumbs]);

  const strategiesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.trading.list(selectedCompanyId) : ["trading-strategies", "__none__"],
    queryFn: () => tradingApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 60_000,
  });
  const strategies = strategiesQuery.data ?? [];

  const invalidate = () => {
    if (selectedCompanyId) queryClient.invalidateQueries({ queryKey: queryKeys.trading.list(selectedCompanyId) });
  };

  const create = useMutation({
    mutationFn: (input: Partial<CreateTradingStrategyInput>) => tradingApi.create(selectedCompanyId!, input),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      pushToast({ title: "Strategy added", body: "It starts paused — press Start when you're ready.", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not add the strategy", body: errorMessage(error, ""), tone: "error" }),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "running" | "paused" }) =>
      tradingApi.setStatus(selectedCompanyId!, id, status),
    onSuccess: invalidate,
    onError: (error) => pushToast({ title: "Could not change the strategy", body: errorMessage(error, ""), tone: "error" }),
  });

  const busy = create.isPending || setStatus.isPending;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Trading</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Fixed, code-only rules trade with play money and explain themselves — no real money, no AI on the order
            path. Use Stop any time to halt a strategy immediately.
          </p>
        </div>
        {canManage ? <Button onClick={() => setFormOpen(true)}>Add strategy</Button> : null}
      </div>

      {strategiesQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : strategiesQuery.error ? (
        <div className="py-6 text-sm text-destructive">{errorMessage(strategiesQuery.error, "Could not load the strategies.")}</div>
      ) : strategies.length === 0 ? (
        <EmptyState
          icon={CandlestickChart}
          message={
            canManage
              ? "No trading strategies yet. Add one to start paper trading — no real money involved."
              : "No trading strategies yet. A company owner or admin can add one."
          }
          action={canManage ? "Add strategy" : undefined}
          onAction={canManage ? () => setFormOpen(true) : undefined}
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {strategies.map((strategy) => (
            <StrategyRow
              key={strategy.id}
              strategy={strategy}
              canManage={canManage}
              busy={busy}
              onToggle={() => setStatus.mutate({ id: strategy.id, status: strategy.status === "running" ? "paused" : "running" })}
            />
          ))}
        </ul>
      )}

      {!canManage && strategies.length > 0 ? (
        <p className="text-xs text-muted-foreground">Only a company owner or admin can add strategies or use the kill switch.</p>
      ) : null}

      <CreateTradingStrategyDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        busy={create.isPending}
        onSubmit={(input) => create.mutate(input)}
      />
    </div>
  );
}
