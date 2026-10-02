import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { Link, useParams } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { projectsApi } from "../api/projects";
import { deployRunnerApi, type ProjectDeployHistoryListStatus } from "../api/deployRunner";
import { ApiError } from "../api/client";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { queryKeys } from "../lib/queryKeys";
import { shortSha } from "../lib/rollback-deploy";
import { timeAgo } from "../lib/timeAgo";

const ALL_STATUSES = "all";
const PAGE_SIZE = 20;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

/**
 * DUR-4272: the full, filterable release history for a project -- every
 * deploy attempt the runner recorded, pass and fail, not just the
 * current/previous pair the project page's rollback card shows.
 */
export function ProjectDeployHistoryPage() {
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const projectId = routeProjectId ?? "";

  const [status, setStatus] = useState<string>(ALL_STATUSES);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);

  // Any filter change starts the list over from the first page.
  useEffect(() => {
    setOffset(0);
  }, [status, from, to]);

  const projectQuery = useQuery({
    queryKey: queryKeys.projects.detail(projectId),
    queryFn: () => projectsApi.get(projectId, selectedCompanyId ?? undefined),
    enabled: Boolean(projectId) && Boolean(selectedCompanyId),
  });
  const project = projectQuery.data;
  const companyId = project?.companyId ?? selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([
      ...(project ? [{ label: project.name, href: `/projects/${projectId}` }] : []),
      { label: "Deploy history" },
    ]);
  }, [setBreadcrumbs, project, projectId]);

  const filters = useMemo(
    () => ({
      status: status === ALL_STATUSES ? undefined : (status as ProjectDeployHistoryListStatus),
      from: from || undefined,
      to: to || undefined,
    }),
    [status, from, to],
  );

  const historyQuery = useQuery({
    queryKey: queryKeys.projects.deployHistoryList(companyId, projectId, filters, { limit: PAGE_SIZE, offset }),
    queryFn: () => deployRunnerApi.projectDeployHistoryList(companyId, projectId, filters, { limit: PAGE_SIZE, offset }),
    enabled: Boolean(companyId) && Boolean(projectId),
  });

  const entries = historyQuery.data?.entries ?? [];
  const pagination = historyQuery.data?.pagination;
  const hasFilters = status !== ALL_STATUSES || Boolean(from) || Boolean(to);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Deploy history</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {project ? `Every version the deploy runner has put live for ${project.name}, newest first.` : "Loading..."}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger size="sm" className="w-40" aria-label="Filter by status">
            <SelectValue placeholder="All results" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STATUSES}>All results</SelectItem>
            <SelectItem value="pass">Succeeded</SelectItem>
            <SelectItem value="fail">Failed</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          From
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-auto"
            aria-label="From date"
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          To
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-auto"
            aria-label="To date"
          />
        </label>
      </div>

      {historyQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : historyQuery.error ? (
        <p className="text-sm text-destructive" data-testid="deploy-history-page-error">
          Could not load the deploy history: {errorMessage(historyQuery.error, "something went wrong")}.
        </p>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={History}
          message={
            hasFilters
              ? "No deploys match these filters."
              : "No deploys have been recorded for this project yet."
          }
        />
      ) : (
        <>
          <ul className="divide-y divide-border rounded-lg border border-border" data-testid="deploy-history-list">
            {entries.map((entry) => (
              <li
                key={`${entry.approvalId}-${entry.deployedAt}`}
                className="flex items-center justify-between gap-4 px-4 py-3"
                data-testid="deploy-history-page-row"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{entry.commit ? shortSha(entry.commit) : "unknown commit"}</span>
                    <Badge variant={entry.status === "pass" ? "secondary" : "destructive"}>
                      {entry.status === "pass" ? "Succeeded" : "Failed"}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{timeAgo(entry.deployedAt)}</p>
                </div>
                <Link
                  to={`/approvals/${entry.approvalId}`}
                  className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  See the deploy card
                </Link>
              </li>
            ))}
          </ul>

          {pagination ? (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Showing {pagination.offset + 1}-{pagination.offset + entries.length} of {pagination.total}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pagination.offset === 0}
                  onClick={() => setOffset(Math.max(0, pagination.offset - PAGE_SIZE))}
                >
                  Newer
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!pagination.hasMore}
                  onClick={() => setOffset(pagination.offset + PAGE_SIZE)}
                >
                  Older
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
