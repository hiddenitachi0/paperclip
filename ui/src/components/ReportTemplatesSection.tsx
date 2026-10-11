import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  REPORT_DATASET_LABELS,
  REPORT_PERIOD_KEYWORDS,
  REPORT_PERIOD_LABELS,
  reportDatasetsForKind,
  type DataConnectionSummary,
  type ReportDataItem,
  type ReportDataPreview,
  type ReportDataQueryInput,
  type ReportDataset,
  type ReportTemplate,
} from "@paperclipai/shared";
import { dataConnectionsApi } from "../api/dataConnections";
import { reportsApi } from "../api/reports";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * DUR-4072 PR3: where each report template's data comes from.
 *
 * For each template the owner picks one of the company's own data sources,
 * which data to read from it, and the default period, then presses
 * "Preview data" to see the first rows exactly as the calculation will get
 * them. Paperclip reads the data itself; the key never reaches the page, an
 * agent or the calculation. Every preview is logged with the other data
 * reads. Plain English, no ids.
 */

const SELECT_CLASS = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

/** The name each dataset gets in the calculation's input (`data.<name>`). */
const ITEM_KEYS: Record<ReportDataset, string> = {
  shopify_sales: "sales",
  file: "file",
  fiken_accounts: "accounts",
  fiken_balances: "balances",
  fiken_journal_entries: "journal_entries",
  fiken_invoices: "invoices",
  fiken_contacts_summary: "contacts",
};

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message || fallback;
  return error instanceof Error ? error.message : fallback;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value).slice(0, 80);
  return String(value);
}

function formatDate(date: string): string {
  const at = new Date(`${date}T12:00:00Z`);
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

interface Draft {
  connectionId: string;
  period: string;
  datasets: ReportDataset[];
  splitByProductType: boolean;
  filePath: string;
  fileFormat: "csv" | "json" | "text";
}

function draftFrom(template: ReportTemplate): Draft {
  const items = template.dataQuery?.items ?? [];
  const file = items.find((item): item is Extract<ReportDataItem, { dataset: "file" }> => item.dataset === "file");
  const sales = items.find((item): item is Extract<ReportDataItem, { dataset: "shopify_sales" }> => item.dataset === "shopify_sales");
  return {
    connectionId: template.dataConnectionId ?? "",
    period: template.dataQuery?.period ?? "last_month",
    datasets: items.map((item) => item.dataset),
    splitByProductType: sales?.groupBy === "product_type",
    filePath: file?.path ?? "",
    fileFormat: file?.format ?? "csv",
  };
}

function queryFrom(draft: Draft): ReportDataQueryInput | null {
  if (draft.datasets.length === 0) return null;
  const items = draft.datasets.map((dataset): ReportDataItem => {
    const key = ITEM_KEYS[dataset];
    if (dataset === "file") return { key, dataset, path: draft.filePath.trim(), format: draft.fileFormat };
    if (dataset === "shopify_sales") return { key, dataset, groupBy: draft.splitByProductType ? "product_type" : "none" };
    return { key, dataset } as ReportDataItem;
  });
  return { period: draft.period as ReportDataQueryInput["period"], items };
}

export function PreviewTable({ preview }: { preview: ReportDataPreview }) {
  return (
    <div className="space-y-3" data-testid="report-data-preview">
      <p className="text-xs text-muted-foreground">
        {preview.kindLabel} – {preview.connectionName} · {preview.period.label} ({formatDate(preview.period.from)} –{" "}
        {formatDate(preview.period.to)}). This preview was logged with the other data reads.
      </p>
      {preview.items.map((item) => {
        const first = item.sampleRows[0];
        const columns =
          first && typeof first === "object" && !Array.isArray(first) ? Object.keys(first as Record<string, unknown>).slice(0, 8) : null;
        return (
          <div key={item.key} className="space-y-1" data-testid={`report-data-preview-${item.key}`}>
            <p className="text-sm font-medium">
              {item.label}:{" "}
              {item.ok ? (
                <span className="font-normal">
                  {item.rowCount} {item.rowCount === 1 ? "row" : "rows"}
                  {item.rowCount > item.sampleRows.length ? `, showing the first ${item.sampleRows.length}` : ""}
                </span>
              ) : (
                <span className="font-normal text-destructive">{item.message ?? "Could not be read."}</span>
              )}
            </p>
            {item.ok && item.sampleRows.length > 0 && (
              <div className="max-h-64 overflow-auto rounded border border-border">
                <table className="w-full text-xs">
                  {columns && (
                    <thead>
                      <tr>
                        {columns.map((column) => (
                          <th key={column} className="border-b border-border px-2 py-1 text-left font-medium">
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {item.sampleRows.map((row, index) => (
                      <tr key={index}>
                        {columns ? (
                          columns.map((column) => (
                            <td key={column} className="border-b border-border px-2 py-1 align-top">
                              {cell((row as Record<string, unknown>)[column])}
                            </td>
                          ))
                        ) : (
                          <td className="border-b border-border px-2 py-1">{cell(row)}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TemplateDataCard({
  companyId,
  template,
  connections,
  canManage,
}: {
  companyId: string;
  template: ReportTemplate;
  connections: DataConnectionSummary[];
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(template));
  const [preview, setPreview] = useState<ReportDataPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const usable = connections.filter((connection) => connection.supported);
  const connection = usable.find((entry) => entry.id === draft.connectionId) ?? null;
  const offered = connection ? reportDatasetsForKind(connection.kind) : [];
  const query = queryFrom(draft);
  const fileMissing = draft.datasets.includes("file") && draft.filePath.trim() === "";

  const save = useMutation({
    mutationFn: () =>
      reportsApi.updateTemplate(companyId, template.id, {
        dataConnectionId: draft.connectionId || null,
        dataQuery: draft.connectionId && query ? (query as never) : null,
      }),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.reportTemplates(companyId) });
      pushToast({
        title: updated.isActive
          ? "Saved. The report reads this data from its next run."
          : "Saved. The report is switched off until the company's owner or an admin switches it on again.",
        tone: "success",
      });
    },
    onError: (error) => pushToast({ title: errorText(error, "Could not save."), tone: "error" }),
  });

  const runPreview = useMutation({
    mutationFn: () => reportsApi.previewData(companyId, { dataConnectionId: draft.connectionId, dataQuery: query as never }),
    onMutate: () => {
      setPreview(null);
      setPreviewError(null);
    },
    onSuccess: (result) => setPreview(result),
    onError: (error) => setPreviewError(errorText(error, "The data could not be previewed.")),
  });

  const setConnection = (connectionId: string) => {
    const next = usable.find((entry) => entry.id === connectionId);
    const nextOffered = next ? reportDatasetsForKind(next.kind) : [];
    setDraft((current) => ({ ...current, connectionId, datasets: current.datasets.filter((dataset) => nextOffered.includes(dataset)) }));
    setPreview(null);
  };

  const toggleDataset = (dataset: ReportDataset, on: boolean) => {
    setDraft((current) => ({
      ...current,
      datasets: on ? [...current.datasets.filter((entry) => entry !== dataset), dataset] : current.datasets.filter((entry) => entry !== dataset),
    }));
    setPreview(null);
  };

  const periodOptions: string[] = (REPORT_PERIOD_KEYWORDS as readonly string[]).includes(draft.period)
    ? [...REPORT_PERIOD_KEYWORDS]
    : [...REPORT_PERIOD_KEYWORDS, draft.period];

  return (
    <Card data-testid="report-template-data">
      <CardHeader>
        <CardTitle className="text-sm">
          {template.name} <span className="font-normal text-muted-foreground">· {template.isActive ? "On" : "Off"}</span>
        </CardTitle>
        <CardDescription>Choose where this report&apos;s numbers come from. Paperclip reads the data itself; the calculation and the agent never see a password or key.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <label htmlFor={`report-source-${template.id}`} className="text-sm font-medium">
            Where the data comes from
          </label>
          <select
            id={`report-source-${template.id}`}
            className={SELECT_CLASS}
            value={draft.connectionId}
            onChange={(event) => setConnection(event.target.value)}
          >
            <option value="">No data source</option>
            {usable.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.kindLabel} – {entry.name}
                {entry.status === "active" ? "" : " (not switched on)"}
              </option>
            ))}
          </select>
          {connection && connection.status !== "active" && (
            <p className="text-xs text-muted-foreground">
              This data source is not switched on yet. Press Test on it under Data sources above first.
            </p>
          )}
        </div>

        {connection && (
          <>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Which data to read</legend>
              {offered.map((dataset) => (
                <div key={dataset} className="space-y-1">
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={draft.datasets.includes(dataset)}
                      onChange={(event) => toggleDataset(dataset, event.target.checked)}
                      aria-label={REPORT_DATASET_LABELS[dataset].label}
                    />
                    <span>
                      {REPORT_DATASET_LABELS[dataset].label}
                      <span className="block text-xs text-muted-foreground">{REPORT_DATASET_LABELS[dataset].help}</span>
                    </span>
                  </label>
                  {dataset === "shopify_sales" && draft.datasets.includes(dataset) && (
                    <label className="ml-6 flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={draft.splitByProductType}
                        onChange={(event) => setDraft((current) => ({ ...current, splitByProductType: event.target.checked }))}
                      />
                      Split by product type
                    </label>
                  )}
                  {dataset === "file" && draft.datasets.includes(dataset) && (
                    <div className="ml-6 grid gap-2 sm:grid-cols-[1fr_auto]">
                      <Input
                        aria-label="File name in the connection's folder"
                        placeholder="for example rapporter/salg.csv"
                        value={draft.filePath}
                        onChange={(event) => setDraft((current) => ({ ...current, filePath: event.target.value }))}
                      />
                      <select
                        aria-label="File type"
                        className={SELECT_CLASS}
                        value={draft.fileFormat}
                        onChange={(event) => setDraft((current) => ({ ...current, fileFormat: event.target.value as Draft["fileFormat"] }))}
                      >
                        <option value="csv">Spreadsheet (CSV)</option>
                        <option value="json">JSON</option>
                        <option value="text">Plain text</option>
                      </select>
                    </div>
                  )}
                </div>
              ))}
            </fieldset>

            <div className="space-y-1">
              <label htmlFor={`report-period-${template.id}`} className="text-sm font-medium">
                Period the report covers
              </label>
              <select
                id={`report-period-${template.id}`}
                className={SELECT_CLASS}
                value={draft.period}
                onChange={(event) => setDraft((current) => ({ ...current, period: event.target.value }))}
              >
                {periodOptions.map((period) => (
                  <option key={period} value={period}>
                    {(REPORT_PERIOD_LABELS as Record<string, string>)[period] ?? period}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">Counted in Norwegian time. A single run can still ask for another period.</p>
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || fileMissing || (draft.connectionId !== "" && !query)}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          {canManage ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => runPreview.mutate()}
              disabled={runPreview.isPending || !connection || !query || fileMissing}
            >
              {runPreview.isPending ? "Reading…" : "Preview data"}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">Only the company&apos;s owner or an admin can preview the data.</p>
          )}
        </div>
        {previewError && (
          <p className="text-sm text-destructive" role="alert">
            {previewError}
          </p>
        )}
        {preview && <PreviewTable preview={preview} />}
      </CardContent>
    </Card>
  );
}

export function ReportTemplatesSection({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const templates = useQuery({
    queryKey: queryKeys.companies.reportTemplates(companyId),
    queryFn: () => reportsApi.listTemplates(companyId),
  });
  const connections = useQuery({
    queryKey: queryKeys.companies.dataConnections(companyId),
    queryFn: () => dataConnectionsApi.list(companyId),
  });

  if (templates.isPending || connections.isPending) {
    return <p className="text-sm text-muted-foreground">Loading reports…</p>;
  }
  if (templates.isError) {
    return <p className="text-sm text-muted-foreground">{errorText(templates.error, "Reports could not be loaded.")}</p>;
  }
  if ((templates.data ?? []).length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Reports</CardTitle>
          <CardDescription>
            No report templates yet. Once one has been drafted (with an approved calculation), you choose its data here.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <div className="space-y-4" data-testid="report-templates">
      {(templates.data ?? []).map((template) => (
        <TemplateDataCard key={template.id} companyId={companyId} template={template} connections={connections.data ?? []} canManage={canManage} />
      ))}
    </div>
  );
}
