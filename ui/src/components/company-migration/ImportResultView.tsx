import type { CompanyPortabilityImportResult } from "@paperclipai/shared";
import { CheckCircle2, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeScopedSecretKey } from "../../lib/company-migration";
import { MigrationVerifyPanel } from "./MigrationVerifyPanel";

function names(result: CompanyPortabilityImportResult) {
  return {
    agents: Object.fromEntries(result.agents.map((agent) => [agent.slug, agent.name])),
    projects: Object.fromEntries(result.projects.map((project) => [project.slug, project.name])),
  };
}

/**
 * After an import: what arrived, which secrets came along, and the "Verify
 * destination" checklist, before the person opens the company.
 */
export function ImportResultView({
  result,
  onOpenCompany,
}: {
  result: CompanyPortabilityImportResult;
  onOpenCompany: () => void;
}) {
  const created = result.agents.filter((agent) => agent.action !== "skipped");
  const skipped = result.agents.filter((agent) => agent.action === "skipped");
  const projectCount = result.projects.filter((project) => project.action !== "skipped").length;
  const report = result.secretsReport;
  const labelNames = names(result);

  return (
    <div className="space-y-4 px-5 py-5" data-testid="import-result-view">
      <div className="flex items-center gap-2 text-base font-semibold">
        <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
        Import complete: {result.company.name}
      </div>
      <p className="text-sm text-muted-foreground">
        {created.length} agent{created.length === 1 ? "" : "s"} and {projectCount} project
        {projectCount === 1 ? "" : "s"} brought in.
        {skipped.length > 0 && ` ${skipped.length} agent${skipped.length === 1 ? " was" : "s were"} skipped.`}
      </p>

      {report && (report.arrived.length > 0 || report.notArrived.length > 0) && (
        <div className="space-y-2 rounded-md border border-border px-4 py-3" data-testid="import-secrets-summary">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="h-4 w-4" />
            Secrets
          </div>
          {report.arrived.length > 0 ? (
            <div>
              <p className="text-xs text-muted-foreground">
                {report.arrived.length} secret{report.arrived.length === 1 ? "" : "s"} arrived and{" "}
                {report.arrived.length === 1 ? "is" : "are"} saved in this company:
              </p>
              <ul className="mt-1 space-y-0.5" data-testid="import-secrets-arrived">
                {report.arrived.map((key) => {
                  const label = describeScopedSecretKey(key, labelNames);
                  return (
                    <li key={key} className="text-xs">
                      <span className="font-mono">{label.key}</span>{" "}
                      <span className="text-muted-foreground">for {label.owner}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {report.carried ? "The secrets file did not hold any of the secrets this company needs." : "No secrets came along."}
            </p>
          )}
          {report.notArrived.length > 0 && (
            <div>
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {report.notArrived.length} secret{report.notArrived.length === 1 ? "" : "s"} still need
                {report.notArrived.length === 1 ? "s" : ""} a value. Enter {report.notArrived.length === 1 ? "it" : "them"} on
                the agent's or project's settings:
              </p>
              <ul className="mt-1 space-y-0.5" data-testid="import-secrets-not-arrived">
                {report.notArrived.map((key) => {
                  const label = describeScopedSecretKey(key, labelNames);
                  return (
                    <li key={key} className="text-xs">
                      <span className="font-mono">{label.key}</span>{" "}
                      <span className="text-muted-foreground">for {label.owner}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {result.warnings.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          {result.warnings.map((warning) => (
            <div key={warning} className="text-xs text-amber-600 dark:text-amber-400">{warning}</div>
          ))}
        </div>
      )}

      <MigrationVerifyPanel companyId={result.company.id} />

      <Button size="sm" onClick={onOpenCompany} data-testid="import-open-company">
        Open {result.company.name}
      </Button>
    </div>
  );
}
