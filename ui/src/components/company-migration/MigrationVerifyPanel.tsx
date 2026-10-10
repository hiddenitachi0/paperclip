import { useQuery } from "@tanstack/react-query";
import type { CompanyMigrationCheckStatus } from "@paperclipai/shared";
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { companiesApi } from "../../api/companies";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";

const HEADLINE: Record<CompanyMigrationCheckStatus, string> = {
  ok: "Everything arrived and is ready.",
  warning: "Everything important arrived. A few things are worth a look.",
  problem: "Some things are missing or will not work yet. Each one says how to fix it.",
};

function StatusIcon({ status, className }: { status: CompanyMigrationCheckStatus; className?: string }) {
  if (status === "ok") {
    return <CheckCircle2 className={cn("h-4 w-4 text-emerald-600 dark:text-emerald-400", className)} aria-label="OK" />;
  }
  if (status === "warning") {
    return <AlertTriangle className={cn("h-4 w-4 text-amber-600 dark:text-amber-400", className)} aria-label="Look at this" />;
  }
  return <XCircle className={cn("h-4 w-4 text-destructive", className)} aria-label="Needs fixing" />;
}

/**
 * "Verify destination": a read-only checklist of what arrived in this company
 * after an import (server/src/services/company-migration.ts). It never sends
 * anything to Claude or any other provider, so it costs nothing to run again.
 */
export function MigrationVerifyPanel({ companyId }: { companyId: string }) {
  const query = useQuery({
    queryKey: queryKeys.companies.migrationVerify(companyId),
    queryFn: () => companiesApi.verifyMigration(companyId),
    retry: false,
  });

  return (
    <div className="space-y-3 rounded-md border border-border px-4 py-3" data-testid="migration-verify-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">Verify destination</div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          data-testid="migration-verify-recheck"
        >
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", query.isFetching && "animate-spin")} />
          {query.isFetching ? "Checking..." : "Check again"}
        </Button>
      </div>
      {query.isPending ? (
        <p className="text-xs text-muted-foreground">Checking what arrived...</p>
      ) : query.isError ? (
        <p className="text-xs text-destructive">
          {query.error instanceof Error ? query.error.message : "The check could not run."}
        </p>
      ) : query.data ? (
        <>
          <div className="flex items-center gap-2 text-sm" data-testid="migration-verify-headline">
            <StatusIcon status={query.data.status} />
            {HEADLINE[query.data.status]}
          </div>
          <ul className="space-y-3">
            {query.data.sections.map((section) => (
              <li key={section.key} data-testid={`migration-verify-section-${section.key}`}>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <StatusIcon status={section.status} />
                  {section.title}
                </div>
                <p className="ml-6 text-xs text-muted-foreground">{section.summary}</p>
                {section.items.some((item) => item.status !== "ok") && (
                  <ul className="ml-6 mt-1 space-y-1">
                    {section.items
                      .filter((item) => item.status !== "ok")
                      .map((item, index) => (
                        <li key={`${item.label}-${index}`} className="flex gap-2 text-xs">
                          <StatusIcon status={item.status} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>
                            {item.detail}
                            {item.fixHint && (
                              <span className="block text-muted-foreground">Fix: {item.fixHint}</span>
                            )}
                          </span>
                        </li>
                      ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Checked {new Date(query.data.checkedAt).toLocaleString()}. Nothing was changed and nothing was sent to Claude.
          </p>
        </>
      ) : null}
    </div>
  );
}
