import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Target, CircleDot, TrendingUp } from "lucide-react";
import { goalAdoptionApi } from "../api/goal-adoption";
import { EmptyState } from "../components/EmptyState";
import { MetricCard } from "../components/MetricCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

const TREND_DAYS = 30;

/**
 * DUR-375 (DUR-315 visibility component): a lightweight, read-only view of
 * how many Durkan issues carry a goal, and how that's trended over the last
 * 30 days. No mutations happen here -- it is purely a reporting surface so
 * the board can see whether DUR-315's goal-adoption push (DUR-376's
 * create/edit form selector, etc.) is moving the needle, without adding any
 * new gate to issue creation itself.
 */
export function GoalAdoption() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Goal Adoption" }]);
  }, [setBreadcrumbs]);

  const { data: snapshot, isLoading: snapshotLoading, error: snapshotError } = useQuery({
    queryKey: queryKeys.goalAdoptionSnapshot(selectedCompanyId ?? ""),
    queryFn: () => goalAdoptionApi.snapshot(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  const { data: trend, isLoading: trendLoading, error: trendError } = useQuery({
    queryKey: queryKeys.goalAdoptionTrend(selectedCompanyId ?? "", TREND_DAYS),
    queryFn: () => goalAdoptionApi.trend(selectedCompanyId!, TREND_DAYS),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view goal adoption." />;
  }

  const isLoading = snapshotLoading || trendLoading;
  const error = snapshotError ?? trendError;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Goal Adoption</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          How many tasks are linked to a goal, and whether that share is improving over time.
        </p>
      </div>

      {isLoading ? (
        <PageSkeleton variant="costs" />
      ) : error ? (
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              icon={CircleDot}
              value={snapshot?.totalIssues ?? 0}
              label="Total tasks"
              description="Non-hidden tasks in this company"
            />
            <MetricCard
              icon={Target}
              value={snapshot?.withGoal ?? 0}
              label="Linked to a goal"
              description="Have a non-null goal"
            />
            <MetricCard
              icon={CircleDot}
              value={snapshot?.withoutGoal ?? 0}
              label="No goal"
              description="Not yet linked to a goal"
            />
            <MetricCard
              icon={TrendingUp}
              value={`${snapshot?.adoptionPercent ?? 0}%`}
              label="Adoption"
              description="Share of tasks linked to a goal"
            />
          </div>

          <GoalAdoptionTrendCard rows={trend ?? []} />
        </>
      )}
    </div>
  );
}

function GoalAdoptionTrendCard({
  rows,
}: {
  rows: { date: string; totalIssues: number; withGoal: number; withoutGoal: number; adoptionPercent: number }[];
}) {
  const hasData = rows.some((row) => row.totalIssues > 0);
  const maxTotal = Math.max(...rows.map((row) => row.totalIssues), 1);

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Adoption trend</CardTitle>
        <CardDescription>
          Cumulative tasks with and without a goal, by the day they were created, over the last {TREND_DAYS} days.
          Attributed to each task's current goal, not a point-in-time snapshot.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-2">
        {!hasData ? (
          <p className="text-sm text-muted-foreground">No tasks in this window yet.</p>
        ) : (
          <div>
            <div className="flex items-end gap-[3px] h-32">
              {rows.map((row) => {
                const heightPct = (row.totalIssues / maxTotal) * 100;
                return (
                  <div
                    key={row.date}
                    className="flex-1 h-full flex flex-col justify-end"
                    title={`${row.date}: ${row.withGoal} of ${row.totalIssues} tasks with a goal (${row.adoptionPercent}%)`}
                  >
                    {row.totalIssues > 0 ? (
                      <div
                        className="flex flex-col-reverse gap-px overflow-hidden"
                        style={{ height: `${heightPct}%`, minHeight: 2 }}
                      >
                        {row.withGoal > 0 && <div className="bg-emerald-500" style={{ flex: row.withGoal }} />}
                        {row.withoutGoal > 0 && <div className="bg-neutral-500" style={{ flex: row.withoutGoal }} />}
                      </div>
                    ) : (
                      <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between mt-1.5">
              <span className="text-[9px] text-muted-foreground tabular-nums">{rows[0]?.date}</span>
              <span className="text-[9px] text-muted-foreground tabular-nums">{rows[rows.length - 1]?.date}</span>
            </div>
            <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-2">
              <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-emerald-500" />
                With goal
              </span>
              <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-neutral-500" />
                No goal
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
