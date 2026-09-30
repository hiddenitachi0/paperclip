import { useEffect, useState } from "react";
import { useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { morningReportsApi } from "../api/morning-reports";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { MarkdownBody } from "../components/MarkdownBody";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { formatDate } from "../lib/utils";
import { isSafeExternalUrl, summarizeCoverage, buildStandaloneReportHtml, type DownloadImage } from "../lib/morning-report-render";
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
  const coverage = facts ? summarizeCoverage(facts) : null;

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

      <Card>
        <CardContent className="pt-6">
          {/* Plain text only: the opening is partly model-written, so it is
              never rendered as markdown or HTML (no links or markup from the model). */}
          <p className="whitespace-pre-line text-sm leading-relaxed">{facts?.opening || report.text}</p>
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

          {facts.weather.length > 0 && (
            <ReportSection title="Weather" subtitle={facts.places.length > 0 ? facts.places.join(", ") : undefined} defaultOpen>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {facts.weather.map((w) => (
                  <div key={w.place} className="rounded-md border p-3">
                    <p className="text-sm font-medium">{w.place}</p>
                    <p className="whitespace-pre-line text-sm text-muted-foreground">{w.text}</p>
                  </div>
                ))}
              </div>
            </ReportSection>
          )}

          <FactSection title="Headlines" items={facts.headlines} />
          <FactSection title="Hobby news" items={facts.hobby} />
          <FactSection title="Sport" items={facts.sport} />

          {facts.prices.length > 0 && (
            <ReportSection title="Prices" defaultOpen>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {facts.prices.map((price) => (
                  <div key={price.symbol} className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{price.symbol}</span>
                      {price.changePercent !== null && (
                        <span
                          className={
                            price.changePercent >= 0
                              ? "text-xs font-medium text-green-600 dark:text-green-400"
                              : "text-xs font-medium text-red-600 dark:text-red-400"
                          }
                        >
                          {price.changePercent >= 0 ? "+" : ""}
                          {price.changePercent.toFixed(2)}%
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {price.price} {price.currency}
                    </p>
                    <PriceSparkline points={price.history} rising={(price.changePercent ?? 0) >= 0} />
                  </div>
                ))}
              </div>
            </ReportSection>
          )}

          {facts.notes.length > 0 && (
            <ReportSection title="Notes" defaultOpen>
              <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
                {facts.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </ReportSection>
          )}

          {coverage && (
            <p className="text-xs text-muted-foreground border-t border-border pt-3">
              {coverage.sourcesChecked} source{coverage.sourcesChecked === 1 ? "" : "s"} checked, {coverage.itemsFound}{" "}
              item{coverage.itemsFound === 1 ? "" : "s"} found.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** A collapsible card section — every fact section can be closed to keep the phone-width page scannable. */
function ReportSection({
  title,
  subtitle,
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="overflow-hidden">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between px-6 py-4 text-left">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">{children}</CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function FactSection({ title, items }: { title: string; items: MorningReportFactItem[] }) {
  if (items.length === 0) return null;
  return (
    <ReportSection title={title} defaultOpen>
      <ol className="space-y-3 text-sm">
        {items.map((item, i) => (
          <li key={`${item.url}-${i}`} className="flex gap-2.5">
            <span className="text-muted-foreground font-medium shrink-0">{i + 1}.</span>
            <div className="space-y-0.5">
              <p className="font-medium">{item.title}</p>
              {item.summary ? <p className="text-sm text-muted-foreground">{item.summary}</p> : null}
              <p className="text-xs text-muted-foreground">{item.source}</p>
              {isSafeExternalUrl(item.url) ? (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline inline-block"
                >
                  Read the full story
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">Link unavailable</span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </ReportSection>
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

/** A small 7-day line for one price, oldest first. Nothing when there are fewer than two points. */
function PriceSparkline({ points, rising }: { points: Array<{ price: number; observedAt: string }>; rising: boolean }) {
  if (points.length < 2) return null;
  const width = 120;
  const height = 28;
  const prices = points.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const path = prices
    .map((price, i) => {
      const x = (i / (prices.length - 1)) * width;
      const y = height - ((price - min) / span) * (height - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      role="img"
      aria-label={`Price over the last ${points.length} readings`}
      viewBox={`0 0 ${width} ${height}`}
      className={rising ? "mt-2 h-7 w-full text-green-600 dark:text-green-400" : "mt-2 h-7 w-full text-red-600 dark:text-red-400"}
      preserveAspectRatio="none"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
