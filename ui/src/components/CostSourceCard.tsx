import type { CostSourceBreakdown } from "@paperclipai/shared";
import { providerDisplayName } from "../lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function formatMicroUsd(micro: number): string {
  const usd = micro / 1_000_000;
  const abs = Math.abs(usd);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  return `${usd < 0 ? "-" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Plain-language label for how a cost figure was worked out. */
export function costSourceLabel(source: string): { label: string; exact: boolean } {
  switch (source) {
    case "provider":
      return { label: "Exact (from provider)", exact: true };
    case "converted_from_credits":
      return { label: "Exact (credits used, converted to dollars)", exact: true };
    case "catalogue":
      return { label: "Estimated (from price list)", exact: false };
    case "static_table":
      return { label: "Estimated (from built-in prices)", exact: false };
    default:
      return { label: "Estimated", exact: false };
  }
}

export function CostSourceCard({ data }: { data: CostSourceBreakdown | undefined }) {
  const sources = data?.sources ?? [];
  const checks = data?.reconciliation ?? [];
  const providers = Array.from(new Set(sources.map((row) => row.provider)));

  return (
    <Card data-testid="cost-source-card">
      <CardHeader>
        <CardTitle className="text-base">How reliable are these costs?</CardTitle>
        <CardDescription>
          Each figure is marked as exact (the provider told us the price) or estimated (we worked it out).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No spending in this period.</p>
        ) : (
          providers.map((provider) => {
            const rows = sources.filter((row) => row.provider === provider);
            const total = rows.reduce((sum, row) => sum + row.costMicroUsd, 0);
            return (
              <div key={provider} data-testid={`cost-provider-${provider}`} className="space-y-1">
                <div className="flex items-baseline justify-between text-sm font-medium">
                  <span>{providerDisplayName(provider)}</span>
                  <span className="tabular-nums">{formatMicroUsd(total)}</span>
                </div>
                {rows.map((row) => {
                  const { label, exact } = costSourceLabel(row.costSource);
                  return (
                    <div key={row.costSource} className="flex items-center justify-between pl-3 text-xs text-muted-foreground">
                      <span className={exact ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                        {label}
                      </span>
                      <span className="tabular-nums">{formatMicroUsd(row.costMicroUsd)}</span>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}

        {checks.length > 0 && (
          <div className="space-y-2 border-t border-border pt-3">
            <h4 className="text-sm font-medium">Our numbers vs. what the provider says</h4>
            {checks.map((check) => {
              const mismatch = check.checked && Math.abs(check.differenceMicroUsd) >= 10_000;
              return (
                <div key={check.provider} data-testid={`cost-check-${check.provider}`} className="text-sm">
                  <div className="flex items-center justify-between">
                    <span>{providerDisplayName(check.provider)}</span>
                    {!check.checked ? (
                      <span className="text-muted-foreground">Not checked yet</span>
                    ) : mismatch ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        Differs by {formatMicroUsd(Math.abs(check.differenceMicroUsd))}
                      </span>
                    ) : (
                      <span className="text-emerald-600 dark:text-emerald-400">Matches</span>
                    )}
                  </div>
                  {check.checked && (
                    <p className="text-xs text-muted-foreground">
                      We tracked {formatMicroUsd(check.trackedMicroUsd)}; {providerDisplayName(check.provider)} says{" "}
                      {formatMicroUsd(check.providerSaysMicroUsd)}.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
