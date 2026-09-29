import { useEffect } from "react";
import { useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { morningReportsApi } from "../api/morning-reports";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { MarkdownBody } from "../components/MarkdownBody";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "../lib/utils";
import type { MorningReportFactItem, MorningReportImageFact } from "@paperclipai/shared";

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
 * the written version left out.
 */
export function MorningReportDetail() {
  const { agentId, reportId } = useParams<{ agentId: string; reportId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

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

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{agent?.name ? `${agent.name}'s morning report` : "Morning report"}</h1>
        <p className="text-sm text-muted-foreground">{formatDate(report.createdAt)}</p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <MarkdownBody>{report.text}</MarkdownBody>
        </CardContent>
      </Card>

      {!facts && (
        <p className="text-sm text-muted-foreground">
          This report was sent before the full briefing page existed, so only the written text above is available.
        </p>
      )}

      {facts && (
        <>
          {facts.images.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {facts.images.map((image) => (
                <MorningReportImage key={image.fileId} image={image} />
              ))}
            </div>
          )}

          {facts.weatherText && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Weather</CardTitle>
              </CardHeader>
              <CardContent className="whitespace-pre-line text-sm">{facts.weatherText}</CardContent>
            </Card>
          )}

          <FactSection title="Headlines" items={facts.headlines} />
          <FactSection title="Hobby news" items={facts.hobby} />
          <FactSection title="Sport" items={facts.sport} />

          {facts.prices.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Prices</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5 text-sm">
                  {facts.prices.map((price) => (
                    <li key={price.symbol} className="flex items-center justify-between">
                      <span className="font-medium">{price.symbol}</span>
                      <span className="text-muted-foreground">
                        {price.price} {price.currency}
                        {price.changePercent !== null && (
                          <span className={price.changePercent >= 0 ? "text-green-600 dark:text-green-400 ml-2" : "text-red-600 dark:text-red-400 ml-2"}>
                            {price.changePercent >= 0 ? "+" : ""}
                            {price.changePercent.toFixed(2)}%
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {facts.notes.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
                  {facts.notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function FactSection({ title, items }: { title: string; items: MorningReportFactItem[] }) {
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5 text-sm">
          {items.map((item, i) => (
            <li key={`${item.url}-${i}`}>
              <a href={item.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                {item.title}
              </a>
              <span className="text-muted-foreground"> — {item.source}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function MorningReportImage({ image }: { image: MorningReportImageFact }) {
  return (
    <figure className="space-y-1.5">
      <img
        src={`/api/attachments/${image.fileId}/content`}
        alt={image.caption}
        className="w-full rounded-lg border border-border"
      />
      <figcaption className="text-xs text-muted-foreground">{image.caption}</figcaption>
    </figure>
  );
}
