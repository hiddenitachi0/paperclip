import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, History, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { Link } from "@/lib/router";
import { tradingApi, type TradingBacktestRunListItem, type TradingStartGate } from "../api/trading";
import { ApiError } from "../api/client";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { startStateWords } from "../lib/tradingBacktestWords";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The "Test on past data" part of a strategy page: the button, the progress
 * while it runs, the last results, and where Start stands. Every word about
 * Start comes from what the server says (the start-gate answer, or the
 * server's own refusal text); this card never decides on its own.
 */

const MIN_REASON = 10;

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

function runWords(run: TradingBacktestRunListItem): { label: string; tone: "good" | "bad" | "neutral" } {
  if (run.status === "queued") return { label: "Waiting for its turn", tone: "neutral" };
  if (run.status === "running") return { label: "Running", tone: "neutral" };
  if (run.status === "failed") return { label: "Did not finish", tone: "bad" };
  if (run.status === "cancelled") return { label: "Withdrawn", tone: "neutral" };
  return run.gatePassed === true ? { label: "Passed", tone: "good" } : { label: run.gatePassed === false ? "Did not pass" : "Finished", tone: run.gatePassed === false ? "bad" : "neutral" };
}

/** Shown when the server refused to start the strategy. The reason is the server's own sentence. */
export function StartBlockedNotice({ reason, canOverride, busy, onOverride }: { reason: string; canOverride: boolean; busy: boolean; onOverride: (reason: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState("");
  const longEnough = text.trim().length >= MIN_REASON;
  return (
    <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30" role="alert" data-testid="start-blocked">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p data-testid="start-blocked-reason">{reason}</p>
      </div>
      {canOverride ? (
        asking ? (
          <div className="space-y-2">
            <label className="block text-xs font-medium" htmlFor="start-override-reason">
              Why should it start anyway? Write at least a sentence. This is saved with your name.
            </label>
            <Textarea id="start-override-reason" value={text} onChange={(e) => setText(e.target.value)} rows={3} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!longEnough || busy} onClick={() => onOverride(text.trim())}>
                Start anyway, on my say-so
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
                Cancel
              </Button>
            </div>
            {!longEnough && text.length > 0 ? <p className="text-xs text-muted-foreground">A little more, please: at least {MIN_REASON} letters.</p> : null}
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setAsking(true)}>
            Start anyway as the owner…
          </Button>
        )
      ) : null}
    </div>
  );
}

function StartState({ gate }: { gate: TradingStartGate }) {
  const words = startStateWords(gate);
  const tone = words.tone === "good" ? "text-green-700 dark:text-green-400" : words.tone === "blocked" ? "text-amber-800 dark:text-amber-300" : "text-foreground";
  return (
    <div className="space-y-0.5" data-testid="start-state" data-basis={gate.basis ?? "none"}>
      <p className={`flex items-start gap-1.5 text-sm font-medium ${tone}`}>
        {words.tone === "good" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : words.tone === "blocked" ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : null}
        {words.title}
      </p>
      {words.detail ? <p className="text-xs text-muted-foreground">{words.detail}</p> : null}
    </div>
  );
}

export function TradingPastDataCard({
  companyId,
  strategyId,
  canManage,
  blockedReason,
  canOverride,
  overrideBusy,
  onOverride,
}: {
  companyId: string;
  strategyId: string;
  canManage: boolean;
  blockedReason: string | null;
  canOverride: boolean;
  overrideBusy: boolean;
  onOverride: (reason: string) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const gateQuery = useQuery({
    queryKey: queryKeys.trading.startGate(companyId, strategyId),
    queryFn: () => tradingApi.startGate(companyId, strategyId),
    refetchInterval: (query) => (query.state.data?.queuedRunId ? 5_000 : false),
  });
  const runsQuery = useQuery({
    queryKey: queryKeys.trading.backtests(companyId, strategyId),
    queryFn: () => tradingApi.backtests(companyId, strategyId),
    refetchInterval: (query) => ((query.state.data ?? []).some((r) => r.status === "queued" || r.status === "running") ? 5_000 : false),
  });
  const runs = runsQuery.data ?? [];
  const active = runs.find((r) => r.status === "queued" || r.status === "running") ?? null;
  const latestDone = runs.find((r) => r.status === "succeeded" && r.purpose === "gate") ?? null;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.trading.startGate(companyId, strategyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.trading.backtests(companyId, strategyId) });
  };
  const queue = useMutation({
    mutationFn: () => tradingApi.queueBacktest(companyId, strategyId),
    onSuccess: refresh,
    onError: (error) => pushToast({ title: "Could not start the test", body: errorText(error, ""), tone: "error" }),
  });
  const withdraw = useMutation({
    mutationFn: (runId: string) => tradingApi.cancelBacktest(companyId, strategyId, runId),
    onSuccess: refresh,
    onError: (error) => pushToast({ title: "Could not withdraw the test", body: errorText(error, ""), tone: "error" }),
  });

  return (
    <div className="space-y-3 rounded-lg border border-border p-4" data-testid="past-data-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Test on past data</h2>
          <p className="text-xs text-muted-foreground">
            Runs the rules it follows now over years of past prices, to see if they hold up in periods they had not seen. A strategy has to pass this before it can start.
          </p>
        </div>
        {canManage ? (
          <Button size="sm" onClick={() => queue.mutate()} disabled={queue.isPending || active !== null}>
            <History className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Test on past data
          </Button>
        ) : null}
      </div>

      {gateQuery.data ? <StartState gate={gateQuery.data} /> : gateQuery.isLoading ? <p className="text-xs text-muted-foreground">Checking where it stands…</p> : null}

      {blockedReason ? <StartBlockedNotice reason={blockedReason} canOverride={canOverride} busy={overrideBusy} onOverride={onOverride} /> : null}

      {active ? (
        <div className="space-y-1.5 rounded-md bg-muted/60 p-3 text-sm" role="status" data-testid="past-data-progress">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            <span>
              {active.status === "queued" ? "Waiting for its turn." : `Running since ${active.startedAt ? timeAgo(active.startedAt) : "a moment ago"}.`} This can take several minutes. You can leave this page; the result will be here when you come back.
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-border" aria-hidden="true">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-foreground/50" />
          </div>
          {active.status === "queued" && canManage ? (
            <Button size="sm" variant="ghost" onClick={() => withdraw.mutate(active.id)} disabled={withdraw.isPending}>
              Withdraw this test
            </Button>
          ) : null}
        </div>
      ) : null}

      {latestDone ? (
        <p className="text-sm" data-testid="past-data-latest">
          {latestDone.gatePassed ? <CheckCircle2 className="mr-1 inline h-4 w-4 text-green-600" aria-hidden="true" /> : <XCircle className="mr-1 inline h-4 w-4 text-destructive" aria-hidden="true" />}
          {latestDone.gatePassed ? "Latest test: passed" : "Latest test: did not pass"} ({latestDone.finishedAt ? timeAgo(latestDone.finishedAt) : "just now"}).{" "}
          <Link to={`/trading/${strategyId}/past-data/${latestDone.id}`} className="font-medium underline">
            Read the report
          </Link>
        </p>
      ) : !active && !runsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">No past-data test has been run for these rules yet.</p>
      ) : null}

      {runs.length > 1 || (runs.length === 1 && !latestDone) ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Earlier tests</summary>
          <ul className="mt-1 space-y-1 text-sm">
            {runs.slice(0, 8).map((r) => {
              const w = runWords(r);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-2">
                  <span className={w.tone === "good" ? "text-green-700 dark:text-green-400" : w.tone === "bad" ? "text-destructive" : "text-muted-foreground"}>{w.label}</span>
                  <span className="text-xs text-muted-foreground">{timeAgo(r.createdAt)}</span>
                  {r.status === "succeeded" ? (
                    <Link to={`/trading/${strategyId}/past-data/${r.id}`} className="text-xs underline">
                      Read the report
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
