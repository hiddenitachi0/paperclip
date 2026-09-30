import { useEffect, useState } from "react";
import { useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { morningReportsApi } from "../api/morning-reports";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "../lib/utils";
import { buildStandaloneReportHtml, type DownloadImage } from "../lib/morning-report-render";
import { MorningReport } from "../components/MorningReport";

/**
 * Full morning report briefing page (DUR-4075): what the "Full briefing"
 * link at the top of every Telegram morning report points to. Route is
 * unprefixed (`/agents/:agentId/morning-reports/:reportId`) because the
 * Telegram bridge does not know the operator's company prefix when it builds
 * the link — see UnprefixedBoardRedirect in App.tsx for how it resolves to
 * the prefixed route.
 *
 * Shows every fact the report was built from, not just what the model chose
 * to put in the written text, so Filip can check a number or open a source
 * the written version left out. Renders only from structured `facts` via
 * React elements — never dangerouslySetInnerHTML, never model-written HTML —
 * and only ever links out to http(s) URLs (see isSafeExternalUrl) or images
 * from Paperclip's own attachment storage.
 */
export function MorningReportDetail() {
  const { agentId, reportId } = useParams<{ agentId: string; reportId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();

  const { data: agent } = useQuery({
    queryKey: queryKeys.agents.detail(agentId!),
    queryFn: () => agentsApi.get(agentId!, selectedCompanyId ?? undefined),
    enabled: !!agentId,
  });
  const resolvedCompanyId = agent?.companyId ?? selectedCompanyId;

  const {
    data: report,
    isLoading,
    isError,
  } = useQuery({
    queryKey: queryKeys.morningReports.detail(reportId!),
    queryFn: () => morningReportsApi.get(resolvedCompanyId!, reportId!),
    enabled: !!resolvedCompanyId && !!reportId,
  });

  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!agent?.companyId || agent.companyId === selectedCompanyId) return;
    setSelectedCompanyId(agent.companyId, { source: "route_sync" });
  }, [agent?.companyId, selectedCompanyId, setSelectedCompanyId]);

  useEffect(() => {
    setBreadcrumbs([
      { label: agent?.name ?? "Agent", href: agentId ? `/agents/${agentId}` : "/agents/all" },
      { label: "Morning report" },
    ]);
  }, [setBreadcrumbs, agent, agentId]);

  if (isLoading) return <PageSkeleton variant="detail" />;

  if (isError || !report) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="text-lg font-semibold">This report could not be found</h1>
        <p className="text-sm text-muted-foreground">
          It may be older than what is kept, or the link may be wrong. Ask the agent to send another one from its
          Morning report settings.
        </p>
      </div>
    );
  }

  const facts = report.facts;
  const agentName = agent?.name ?? "This agent";

  async function handleDownload() {
    if (!report) return;
    setDownloading(true);
    try {
      const images: DownloadImage[] = [];
      for (const image of facts?.images ?? []) {
        try {
          const res = await fetch(`/api/attachments/${image.fileId}/content`, { credentials: "include" });
          if (!res.ok) continue;
          const blob = await res.blob();
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          images.push({ fileId: image.fileId, caption: image.caption, dataUrl });
        } catch {
          // Skip a picture that failed to fetch; the rest of the download still works.
        }
      }
      const html = buildStandaloneReportHtml(report, agentName, images);
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `morning-report-${formatDate(report.createdAt).replace(/[^\da-zA-Z]+/g, "-")}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      pushToast({ title: "Could not download the report", tone: "error" });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6 pb-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{agent?.name ? `${agent.name}'s morning report` : "Morning report"}</h1>
          <p className="text-sm text-muted-foreground">{formatDate(report.createdAt)}</p>
        </div>
        <Button size="sm" variant="outline" onClick={handleDownload} disabled={downloading} className="shrink-0">
          <Download className="h-4 w-4" />
          {downloading ? "Preparing…" : "Download"}
        </Button>
      </div>

      {facts ? (
        <MorningReport
          facts={facts}
          imageUrl={(fileId) => `/api/attachments/${encodeURIComponent(fileId)}/content`}
          date={new Date(report.createdAt)}
        />
      ) : (
        <Card>
          <CardContent className="pt-6 space-y-3">
            {/* Plain text only: the report text is partly model-written, so it is never rendered as markdown or HTML. */}
            <p className="whitespace-pre-line text-sm leading-relaxed">{report.text}</p>
            <p className="text-sm text-muted-foreground">
              This report was sent before the full briefing page existed, so only the written text above is available.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
