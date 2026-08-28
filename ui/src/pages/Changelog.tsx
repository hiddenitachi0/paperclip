import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { changeLogApi } from "../api/changeLog";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { PriorityIcon } from "../components/PriorityIcon";
import { PageSkeleton } from "../components/PageSkeleton";
import { ScrollText } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ALL_PROJECTS = "all";
const DAYS_WINDOW = 30;

export function Changelog() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [projectId, setProjectId] = useState<string>(ALL_PROJECTS);

  useEffect(() => {
    setBreadcrumbs([{ label: "Changelog" }]);
  }, [setBreadcrumbs]);

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.changeLog.list(
      selectedCompanyId!,
      projectId === ALL_PROJECTS ? undefined : projectId,
      DAYS_WINDOW,
    ),
    queryFn: () =>
      changeLogApi.list(selectedCompanyId!, {
        projectId: projectId === ALL_PROJECTS ? undefined : projectId,
        days: DAYS_WINDOW,
      }),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const entries = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Fixes and small changes from the last {DAYS_WINDOW} days, newest first.
        </p>
        {(projects?.length ?? 0) > 0 && (
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger size="sm" className="w-48">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
              {(projects ?? []).map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {entries.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ScrollText className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            Nothing fixed or changed in the last {DAYS_WINDOW} days yet.
          </p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="grid gap-3">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{entry.identifier}</span>
                    {entry.projectName && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="truncate">{entry.projectName}</span>
                      </>
                    )}
                  </div>
                  <p className="mt-1 text-sm font-medium text-foreground">{entry.title}</p>
                  {entry.changeLogSummary && (
                    <p className="mt-1.5 text-sm text-muted-foreground whitespace-pre-wrap">
                      {entry.changeLogSummary}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <PriorityIcon priority={entry.priority} showLabel />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {timeAgo(entry.completedAt)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
