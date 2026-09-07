import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Loader2 } from "lucide-react";
import { Link, useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { checkupsApi, type LatestCheckupResponse, type RunCheckupResponse } from "../api/checkups";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

// DUR-62: where the operator finds the weekly check-up. One card on the
// company dashboard: the open report's headline, how many suggestions still
// wait on them, a link to the report, and "Run check-up now". Everything
// here is written for a person who does not read code.

export function checkupReportHref(report: { id: string; identifier: string | null }) {
  return `/issues/${report.identifier ?? report.id}`;
}

/** The one line under the headline that says whether anything waits on the operator. */
export function describeCheckupSuggestions(latest: LatestCheckupResponse): string {
  if (!latest.report) return "";
  if (latest.suggestionCount === 0) return "Nothing needed doing. The report is just a record.";
  const total = latest.suggestionCount === 1 ? "1 suggestion" : `${latest.suggestionCount} suggestions`;
  switch (latest.suggestionsStatus) {
    case "pending":
      return `${total} waiting for you. Tick the ones you agree with and press accept, or hide the ones you do not want to see for a month.`;
    case "accepted":
      return `You have already decided on the ${total}. Nothing more to do here until the next check-up.`;
    case "rejected":
      return `You turned down the ${total}. Nothing more to do here until the next check-up.`;
    default:
      return total;
  }
}

export function WeeklyCheckupCardView({
  latest,
  running,
  runMessage,
  runError,
  onRun,
}: {
  latest: LatestCheckupResponse | undefined;
  running: boolean;
  runMessage: string | null;
  runError: string | null;
  onRun: () => void;
}) {
  const report = latest?.report ?? null;
  const pending = latest?.pendingSuggestionCount ?? 0;
  const needsDecision = Boolean(report) && pending > 0;

  return (
    <section
      data-testid="weekly-checkup-card"
      data-pending={pending}
      aria-label="This week's check-up"
      className={cn(
        "rounded-xl border px-4 py-3",
        needsDecision ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-card",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <ClipboardCheck
            className={cn("mt-0.5 h-4 w-4 shrink-0", needsDecision ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">This week's check-up</h3>
            {latest === undefined ? (
              <p className="mt-1 text-sm text-muted-foreground">Looking for the latest check-up...</p>
            ) : report ? (
              <>
                <p className="mt-1 text-sm text-foreground" data-testid="weekly-checkup-headline">
                  <Link to={checkupReportHref(report)} className="underline underline-offset-2">
                    {report.title}
                  </Link>
                </p>
                <p className="mt-1 text-xs text-muted-foreground" data-testid="weekly-checkup-suggestions">
                  {describeCheckupSuggestions(latest)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Written {timeAgo(report.createdAt)}.{" "}
                  <Link to={checkupReportHref(report)} className="underline underline-offset-2">
                    Open the report
                  </Link>
                </p>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground" data-testid="weekly-checkup-empty">
                No check-up is open right now. Run one to get a short report on what looks wrong and what to do about it.
                The check-up only writes its report; it never changes anything on its own.
              </p>
            )}
            {runMessage ? (
              <p className="mt-2 text-xs text-foreground" role="status" data-testid="weekly-checkup-message">
                {runMessage}
              </p>
            ) : null}
            {runError ? (
              <p className="mt-2 text-xs text-destructive" role="alert" data-testid="weekly-checkup-error">
                {runError}
              </p>
            ) : null}
          </div>
        </div>
        <Button
          size="sm"
          variant={needsDecision ? "outline" : "default"}
          disabled={running}
          onClick={onRun}
          aria-label="Run check-up now"
        >
          {running ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Checking...
            </>
          ) : (
            "Run check-up now"
          )}
        </Button>
      </div>
    </section>
  );
}

export function WeeklyCheckupCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const latestQuery = useQuery({
    queryKey: queryKeys.checkups.latest(companyId),
    queryFn: async () => {
      try {
        return await checkupsApi.latest(companyId);
      } catch (err) {
        // Not a board user (agent keys, viewers): the card simply does not apply.
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return null;
        throw err;
      }
    },
    retry: false,
  });

  const runMutation = useMutation({
    mutationFn: () => checkupsApi.run(companyId),
    onMutate: () => {
      setRunMessage(null);
      setRunError(null);
    },
    onSuccess: (result: RunCheckupResponse) => {
      setRunMessage(result.message);
      queryClient.invalidateQueries({ queryKey: queryKeys.checkups.latest(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      if (result.reportIssueId) {
        navigate(checkupReportHref({ id: result.reportIssueId, identifier: result.reportIdentifier }));
      }
    },
    onError: (err: unknown) => {
      setRunError(
        err instanceof Error && err.message
          ? `The check-up could not run: ${err.message}`
          : "The check-up could not run. Try again in a moment.",
      );
    },
  });

  // null means "not for this viewer" (an agent key or a viewer without board rights).
  if (latestQuery.data === null) return null;

  if (latestQuery.isError) {
    return (
      <WeeklyCheckupCardView
        latest={{ report: null, suggestionCount: 0, pendingSuggestionCount: 0, suggestionsStatus: "none" }}
        running={runMutation.isPending}
        runMessage={runMessage}
        runError={
          runError
          ?? `Could not load the latest check-up: ${latestQuery.error instanceof Error ? latestQuery.error.message : "request failed"}`
        }
        onRun={() => runMutation.mutate()}
      />
    );
  }

  return (
    <WeeklyCheckupCardView
      latest={latestQuery.data}
      running={runMutation.isPending}
      runMessage={runMessage}
      runError={runError}
      onRun={() => runMutation.mutate()}
    />
  );
}
