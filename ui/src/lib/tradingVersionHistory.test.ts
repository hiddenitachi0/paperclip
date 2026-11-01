import { describe, expect, it } from "vitest";
import { buildVersionRows, scoreForVersion, versionStatusWords } from "./tradingVersionHistory";
import { starterSpec } from "./tradingRuleBook";
import type { TradingOrderSummary, TradingVersionSummary } from "../api/trading";

function version(n: number, status: TradingVersionSummary["status"], mutate?: (spec: ReturnType<typeof starterSpec>) => void, approvedAt: string | null = status === "draft" ? null : "2026-10-0" + n + "T10:00:00Z"): TradingVersionSummary {
  const spec = starterSpec("S", "BTC", "4h");
  spec.meta.thesis = "idea";
  mutate?.(spec);
  return { id: `v${n}`, strategyId: "s1", version: n, spec, guidelines: "", status, proposedByType: "user", proposedById: "u", approvedAt, supersededAt: null, approvalId: status === "draft" ? "a1" : null, createdAt: `2026-10-0${n}T09:00:00Z` };
}

function sell(versionId: string, pnl: number | null, at: string): TradingOrderSummary {
  return { id: `o-${at}`, side: "sell", status: "filled", ruleVersion: "x", signalPriceNok: 1, requestedQuantity: 1, filledQuantity: 1, filledPriceNok: 1, feeNok: 0, realizedPnlNok: pnl, rejectionReason: null, approvalId: null, approvalExpiresAt: null, strategyVersionId: versionId, createdAt: at };
}

describe("version history", () => {
  it("scores each version from its own orders only", () => {
    const orders = [sell("v1", 50, "2026-10-02T00:00:00Z"), sell("v1", -20, "2026-10-03T00:00:00Z"), sell("v2", 10, "2026-10-04T00:00:00Z"), sell("v1", null, "2026-10-05T00:00:00Z")];
    const score = scoreForVersion("v1", orders);
    expect(score).toMatchObject({ closedTrades: 2, wins: 1, totalPnlNok: 30 });
    expect(score.history.map((h) => h.runningNok)).toEqual([50, 30]);
  });

  it("lists newest first, with changes in words against the last approved version", () => {
    const v1 = version(1, "superseded");
    const v2 = version(2, "approved", (s) => void (s.sizing = { kind: "fraction_of_cash", fraction: 0.2 }));
    const v3 = version(3, "draft", (s) => void (s.sizing = { kind: "fraction_of_cash", fraction: 0.3 }));
    const rows = buildVersionRows([v1, v3, v2], []);
    expect(rows.map((r) => r.version.version)).toEqual([3, 2, 1]);
    expect(rows[2]!.changes).toEqual(["First version."]);
    expect(rows[1]!.changes[0]).toContain("Puts 20%");
    expect(rows[0]!.changes[0]).toContain("Before: Puts 20%");
    expect(rows.map((r) => r.statusWords)).toEqual(["Waiting for approval", "Running now", "Used before"]);
  });

  it("says when a draft was replaced before it ran", () => {
    expect(versionStatusWords({ status: "superseded", approvedAt: null })).toBe("Replaced before it was approved");
  });
});
