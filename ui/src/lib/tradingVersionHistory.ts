import type { TradingStrategySpec } from "@paperclipai/shared";
import type { TradingOrderSummary, TradingVersionSummary } from "../api/trading";
import { describeSpecChanges } from "./tradingSpecWords";
import { parseStoredSpec } from "./tradingRuleBook";

/** What the version list shows for each saved version of a strategy's rules. */

export interface VersionScore {
  /** Sells that closed a trade and carry a result. */
  closedTrades: number;
  wins: number;
  totalPnlNok: number;
  /** Each closed trade, oldest first, with the running total after it. */
  history: Array<{ at: string; pnlNok: number; runningNok: number }>;
}

export function scoreForVersion(versionId: string, orders: TradingOrderSummary[]): VersionScore {
  const closed = orders
    .filter((o) => o.strategyVersionId === versionId && o.side === "sell" && o.status === "filled" && o.realizedPnlNok !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let running = 0;
  const history = closed.map((o) => {
    running += o.realizedPnlNok!;
    return { at: o.createdAt, pnlNok: o.realizedPnlNok!, runningNok: running };
  });
  return { closedTrades: closed.length, wins: closed.filter((o) => o.realizedPnlNok! > 0).length, totalPnlNok: running, history };
}

export type VersionStatusWords = "Running now" | "Waiting for approval" | "Used before" | "Replaced before it was approved";

export function versionStatusWords(version: Pick<TradingVersionSummary, "status" | "approvedAt">): VersionStatusWords {
  if (version.status === "approved") return "Running now";
  if (version.status === "draft") return "Waiting for approval";
  return version.approvedAt ? "Used before" : "Replaced before it was approved";
}

export interface VersionRow {
  version: TradingVersionSummary;
  spec: TradingStrategySpec | null;
  /** Plain sentences; the first version reads "First version." */
  changes: string[];
  statusWords: VersionStatusWords;
  score: VersionScore;
}

/**
 * Newest first. Each version is compared with the closest earlier version
 * that was actually approved at some point, so a draft that was replaced
 * before it ran does not muddy the next one's list of changes.
 */
export function buildVersionRows(versions: TradingVersionSummary[], orders: TradingOrderSummary[]): VersionRow[] {
  const ascending = [...versions].sort((a, b) => a.version - b.version);
  const rows = ascending.map((version, index): VersionRow => {
    const spec = parseStoredSpec(version.spec);
    const earlier = ascending
      .slice(0, index)
      .filter((v) => v.approvedAt !== null)
      .pop();
    const earlierSpec = earlier ? parseStoredSpec(earlier.spec) : null;
    let changes: string[];
    if (!spec) changes = ["These saved rules could not be read."];
    else if (!earlier) changes = ["First version."];
    else if (!earlierSpec) changes = ["The version before could not be read, so there is nothing to compare with."];
    else {
      changes = describeSpecChanges({ spec: earlierSpec, guidelines: earlier!.guidelines }, { spec, guidelines: version.guidelines });
      if (changes.length === 0) changes = ["No changes you would notice."];
    }
    return { version, spec, changes, statusWords: versionStatusWords(version), score: scoreForVersion(version.id, orders) };
  });
  return rows.reverse();
}
