import { Link } from "@/lib/router";
import type { TradingOrderSummary, TradingVersionSummary } from "../api/trading";
import { buildVersionRows, type VersionRow } from "../lib/tradingVersionHistory";
import { describeStrategyInWords } from "../lib/tradingSpecWords";
import { proposerWords } from "../lib/tradingRuleBook";
import { formatDate } from "../lib/utils";

function nok(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString("nb-NO")} NOK`;
}

function StatusPill({ words }: { words: VersionRow["statusWords"] }) {
  const tone =
    words === "Running now"
      ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
      : words === "Waiting for approval"
        ? "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
        : "bg-muted text-muted-foreground";
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>{words}</span>;
}

function VersionItem({ row }: { row: VersionRow }) {
  const { version, score } = row;
  return (
    <li className="space-y-3 px-4 py-4" data-testid="strategy-version">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Version {version.version}</h3>
        <StatusPill words={row.statusWords} />
        <span className="text-xs text-muted-foreground">
          {proposerWords(version.proposedByType)} saved this on {formatDate(version.createdAt)}
        </span>
      </div>

      {row.spec ? <p className="text-sm text-muted-foreground">{describeStrategyInWords(row.spec)}</p> : null}

      <div>
        <p className="text-xs font-medium">What changed</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
          {row.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      </div>

      <div data-testid="strategy-version-score">
        <p className="text-xs font-medium">Score</p>
        {score.closedTrades === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">{version.status === "draft" ? "Not started yet. It has no results until it is approved." : "No finished trades yet."}</p>
        ) : (
          <>
            <p className="mt-1 text-sm">
              {score.closedTrades} finished {score.closedTrades === 1 ? "trade" : "trades"}, {score.wins} won. Result so far: <span className="font-medium">{nok(score.totalPnlNok)}</span>.
            </p>
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-muted-foreground">Show each trade</summary>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {score.history.map((h, i) => (
                  <li key={`${h.at}-${i}`}>
                    {formatDate(h.at)}: {nok(h.pnlNok)} (total {nok(h.runningNok)})
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </div>

      {version.status === "draft" && version.approvalId ? (
        <Link to={`/approvals/${version.approvalId}`} className="inline-block text-sm font-medium underline">
          Open the approval card
        </Link>
      ) : null}
    </li>
  );
}

export function TradingStrategyVersions({ versions, orders }: { versions: TradingVersionSummary[]; orders: TradingOrderSummary[] }) {
  const rows = buildVersionRows(versions, orders);
  return (
    <div className="rounded-lg border border-border" data-testid="strategy-versions">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Version history</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Every change to the rules is saved as its own version, with its own results.</p>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">No versions yet.</div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <VersionItem key={row.version.id} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
