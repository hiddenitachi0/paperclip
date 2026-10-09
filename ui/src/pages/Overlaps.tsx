import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Layers } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { overlapsApi, type OverlapSummary, type OverlapTask } from "../api/overlaps";
import { overlapAdvice, overlapWhat } from "../lib/overlap-words";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";

/**
 * Overlaps: open tasks that change the same file or want the same database
 * change number. Nothing is blocked; this is an early heads-up.
 */

function statusWords(status: string | null): string {
  if (!status) return "";
  return status.replace(/_/g, " ");
}

function TaskCell({ task }: { task: OverlapTask }) {
  const label = task.identifier ?? "Task";
  return (
    <div className="min-w-0 space-y-0.5">
      <Link
        to={`/issues/${task.identifier ?? task.id}`}
        className="block truncate text-sm font-medium hover:underline"
      >
        <span className="text-muted-foreground">{label}</span> {task.title}
      </Link>
      <div className="text-xs text-muted-foreground">
        {[statusWords(task.status), task.assigneeName ? `with ${task.assigneeName}` : "nobody assigned"]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </div>
  );
}

export function OverlapRow({ overlap }: { overlap: OverlapSummary }) {
  return (
    <li className="space-y-2 px-4 py-3" data-testid="overlap-row">
      <div className="font-medium">{overlapWhat(overlap)}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TaskCell task={overlap.issueA} />
        <TaskCell task={overlap.issueB} />
      </div>
      <p className="text-xs text-muted-foreground">
        {overlapAdvice(overlap)} Spotted {timeAgo(overlap.firstDetectedAt)}.
      </p>
    </li>
  );
}

export function Overlaps() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "Overlaps" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.overlaps.list(selectedCompanyId!),
    queryFn: () => overlapsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
  });

  if (!selectedCompanyId) return <EmptyState icon={Layers} message="Pick a company to see overlapping work." />;
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Overlaps</h1>
        <p className="text-sm text-muted-foreground">
          Tasks that are changing the same thing. Nothing is blocked. This is a heads-up so the work can be put in order.
        </p>
      </div>
      {error ? (
        <p className="text-sm text-destructive">Could not load overlaps. Try again in a moment.</p>
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Layers} message="No overlapping work right now." />
      ) : (
        <ul className="divide-y divide-border rounded border border-border">
          {data.map((o) => (
            <OverlapRow key={o.id} overlap={o} />
          ))}
        </ul>
      )}
    </div>
  );
}
