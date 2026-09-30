import { useEffect } from "react";
import { useParams, Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { morningReportsApi } from "../api/morning-reports";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate } from "../lib/utils";

/**
 * Past morning reports for one agent (DUR-4075). Today this can only show
 * very recent, not-yet-delivered reports — see the note in
 * morningReportsApi.listRecent — because the backend history route Filip's
 * "list of past reports" ask needs is tracked separately on DUR-4080. The
 * page says that plainly instead of silently showing an incomplete list.
 */
export function MorningReportList() {
  const { agentId } = useParams<{ agentId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data: agent } = useQuery({
    queryKey: queryKeys.agents.detail(agentId!),
    queryFn: () => agentsApi.get(agentId!, selectedCompanyId ?? undefined),
    enabled: !!agentId,
  });
  const resolvedCompanyId = agent?.companyId ?? selectedCompanyId;

  const { data: reports, isLoading } = useQuery({
    queryKey: queryKeys.morningReports.listRecent(agentId!),
    queryFn: () => morningReportsApi.listRecent(resolvedCompanyId!, agentId!),
    enabled: !!resolvedCompanyId && !!agentId,
  });

  useEffect(() => {
    if (!agent?.companyId || agent.companyId === selectedCompanyId) return;
    setSelectedCompanyId(agent.companyId, { source: "route_sync" });
  }, [agent?.companyId, selectedCompanyId, setSelectedCompanyId]);

  useEffect(() => {
    setBreadcrumbs([
      { label: agent?.name ?? "Agent", href: agentId ? `/agents/${agentId}` : "/agents/all" },
      { label: "Morning reports" },
    ]);
  }, [setBreadcrumbs, agent, agentId]);

  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">
          {agent?.name ? `${agent.name}'s morning reports` : "Morning reports"}
        </h1>
        <p className="text-sm text-muted-foreground">
          Only reports from the last day that Telegram hasn't delivered yet show up here for now. A full history is
          on its way.
        </p>
      </div>

      {reports && reports.length === 0 && (
        <p className="text-sm text-muted-foreground">No recent reports waiting right now.</p>
      )}

      <div className="space-y-2">
        {reports?.map((report) => (
          <Link key={report.id} to={`/agents/${agentId}/morning-reports/${report.id}`}>
            <Card className="hover:bg-accent/50 transition-colors">
              <CardContent className="py-3 flex items-center justify-between">
                <span className="text-sm font-medium line-clamp-1">{report.text.split("\n")[0]}</span>
                <span className="text-xs text-muted-foreground shrink-0 ml-3">{formatDate(report.createdAt)}</span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
