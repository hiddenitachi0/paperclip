import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, approvals, companies, createDb, tradingLedgerEntries, tradingOrders, tradingStrategies, tradingStrategyVersions, type Db } from "@paperclipai/db";
import {
  TRADING_STRATEGY_VERSION_APPROVAL_KIND,
  canonicalTradingJson,
  tradingCacheForVersion,
  tradingTimeframeMs,
  type CreateTradingStrategyInput,
  type TradingCandle,
  type TradingRiskConfig,
  type TradingRuleConfig,
  type TradingStrategySpecInput,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { approvalService } from "../services/approvals.ts";
import { tradingService } from "../services/trading.ts";
import { fakeTradingMarketData } from "../services/trading-market-data.ts";
import { tradingRuleBookDigest } from "../services/trading-versions.ts";

/**
 * DUR-5002: the rule-book versions, end to end against a real database.
 *
 * One source of truth (the tick reads only the active version; rule_config and
 * risk_config are a cache that always equals it), a change to the rules is
 * only ever a draft plus a card the service files from the stored row, the
 * card cannot be made to show anything else, and approving it activates
 * exactly that stored version.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping trading versions tests: ${support.reason ?? "unsupported environment"}`);
}

const RULE: TradingRuleConfig = { type: "sma_crossover", version: 1, fastPeriod: 2, slowPeriod: 3, orderSizeFraction: 0.5 };
const FOUR_H = tradingTimeframeMs("4h");
const USER = { actorType: "user" as const, actorId: "owner-1" };

function riskConfig(overrides: Partial<TradingRiskConfig> = {}): TradingRiskConfig {
  return {
    maxPositionNok: 5_000,
    maxTotalExposureNok: 15_000,
    maxOrdersPerDay: 20,
    dailyLossLimitNok: 1_000,
    maxDrawdownPct: 20,
    priceBandPct: 5,
    approvalAboveNok: 1_000_000_000,
    feeRatePct: 0.25,
    ...overrides,
  };
}

function barsEndingAt(closes: number[], lastOpen: Date, ranges: Array<{ high?: number; low?: number }> = []): TradingCandle[] {
  return closes.map((close, i) => ({
    openTime: new Date(lastOpen.getTime() - (closes.length - 1 - i) * FOUR_H),
    open: close,
    high: ranges[i]?.high ?? close,
    low: ranges[i]?.low ?? close,
    close,
    volume: 1,
  }));
}

const INPUT: CreateTradingStrategyInput = {
  name: "Versioned",
  asset: "BTC",
  timeframe: "4h",
  checkEveryMinutes: 15,
  startingCashNok: 2_000,
  ruleConfig: RULE,
  riskConfig: riskConfig(),
};

const T_BUY = new Date("2026-01-01T04:00:00Z"); // the last bar opened 00:00 and closed 04:00
const BUY_BARS = barsEndingAt([20, 20, 20, 21], new Date(T_BUY.getTime() - FOUR_H));

/** A spec with a 5% stop on top of the same 2/3 crossover. */
function stopSpec(overrides: Record<string, unknown> = {}): TradingStrategySpecInput {
  return {
    specVersion: 2,
    meta: { name: "Versioned", family: "trend", thesis: "A crossover with a stop." },
    universe: { assets: ["BTC"], decisionTimeframe: "4h" },
    indicators: { fast: { kind: "sma", period: 2 }, slow: { kind: "sma", period: 3 } },
    entry: { conditions: { match: "all", conditions: [{ left: { ref: "fast" }, op: "crosses_above", right: { ref: "slow" } }] } },
    exit: { stop: { kind: "pct", pct: 5 }, conditions: { match: "all", conditions: [{ left: { ref: "fast" }, op: "crosses_below", right: { ref: "slow" } }] } },
    sizing: { kind: "fraction_of_cash", fraction: 0.5 },
    neverDo: riskConfig(),
    prediction: { horizonBars: 6, kind: "direction", flatBandPct: 0.25, rUnit: "atr_at_entry" },
    ...overrides,
  } as TradingStrategySpecInput;
}

d("trading rule-book versions", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("trading-versions");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Trading Co",
      issuePrefix: `V${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function service(now: Date, candles: TradingCandle[] = BUY_BARS, quoteUsd = 21) {
    return tradingService(db, {
      now: () => now,
      marketData: fakeTradingMarketData({ candles: { BTC: { candles } }, quotes: { BTC: { bidUsd: quoteUsd, askUsd: quoteUsd, at: now } } }),
    });
  }

  async function versionRows(strategyId: string) {
    return db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.strategyId, strategyId)).orderBy(tradingStrategyVersions.version);
  }

  /** The invariant: the two cache columns equal what the active version stands for, and the active version is approved. */
  async function expectCacheEqualsActiveVersion(strategyId: string) {
    const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategyId));
    expect(row!.activeVersionId).not.toBeNull();
    const [version] = await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.id, row!.activeVersionId!));
    expect(version!.status).toBe("approved");
    expect(version!.strategyId).toBe(strategyId);
    const expected = tradingCacheForVersion({ spec: version!.spec as never, versionId: version!.id, versionNumber: version!.version, specDigest: version!.specDigest });
    expect(canonicalTradingJson(row!.ruleConfig)).toBe(canonicalTradingJson(expected.ruleConfig));
    expect(canonicalTradingJson(row!.riskConfig)).toBe(canonicalTradingJson(expected.riskConfig));
    expect(tradingRuleBookDigest({ spec: version!.spec as never, guidelines: version!.guidelines })).toBe(version!.specDigest);
    const approved = (await versionRows(strategyId)).filter((v) => v.status === "approved");
    expect(approved).toHaveLength(1);
  }

  async function cardOf(approvalId: string) {
    return (await db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]!;
  }

  describe("creation and conversion", () => {
    it("creating a strategy stores its rules as an approved version 1 and the cache equals it", async () => {
      const companyId = await seedCompany();
      const strategy = await service(T_BUY).createStrategy(companyId, INPUT, USER);
      const [v1, ...rest] = await versionRows(strategy.id);
      expect(rest).toHaveLength(0);
      expect(v1).toMatchObject({ version: 1, status: "approved", proposedByType: "user", proposedById: "owner-1", approvedByUserId: "owner-1", grandfathered: false });
      expect(strategy.activeVersionId).toBe(v1!.id);
      await expectCacheEqualsActiveVersion(strategy.id);
    });

    it("converts a strategy that predates versions into an approved, grandfathered version 1, once", async () => {
      const companyId = await seedCompany();
      const [legacy] = await db
        .insert(tradingStrategies)
        .values({ companyId, name: "Old", asset: "BTC", timeframe: "15m", ruleConfig: RULE, riskConfig: riskConfig(), startingCashNok: 2_000, cashNok: 2_000, peakEquityNok: 2_000 })
        .returning();
      expect(legacy!.activeVersionId).toBeNull();
      const trading = service(T_BUY);
      const first = await trading.versions.convertLegacyStrategies();
      expect(first.converted).toBeGreaterThanOrEqual(1);
      const versions = await versionRows(legacy!.id);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ version: 1, status: "approved", grandfathered: true, proposedByType: "system", approvedByUserId: null });
      expect(versions[0]!.approvedAt).not.toBeNull();
      await expectCacheEqualsActiveVersion(legacy!.id);
      const ledger = await db.select().from(tradingLedgerEntries).where(eq(tradingLedgerEntries.strategyId, legacy!.id));
      expect(ledger.map((e) => (e.detail as { reason?: string }).reason)).toContain("strategy_version_activated");
      expect(ledger.every((e) => e.strategyVersionId === versions[0]!.id)).toBe(true);
      // second run: nothing left to convert for this strategy
      await trading.versions.convertLegacyStrategies();
      expect(await versionRows(legacy!.id)).toHaveLength(1);
    });

    it("a converted strategy trades exactly as before, converted lazily by the first tick", async () => {
      const companyId = await seedCompany();
      const [legacy] = await db
        .insert(tradingStrategies)
        .values({ companyId, name: "Old", asset: "BTC", timeframe: "4h", status: "running", nextCheckAt: T_BUY, ruleConfig: RULE, riskConfig: riskConfig(), startingCashNok: 2_000, cashNok: 2_000, peakEquityNok: 2_000 })
        .returning();
      const trading = service(T_BUY);
      expect(await trading.tick(T_BUY)).toMatchObject({ checked: 1, filled: 1, blocked: 0 });
      const row = await trading.requireStrategy(companyId, legacy!.id);
      expect(row.activeVersionId).not.toBeNull();
      expect(row.cashNok).toBeCloseTo(2_000 - 1_000 - 2.5, 6); // 50% of cash, 0.25% fee: the old arithmetic
      const [order] = await trading.listOrders(companyId, legacy!.id);
      expect(order).toMatchObject({ side: "buy", status: "filled", ruleVersion: "sma_crossover@1 · engine 2", strategyVersionId: row.activeVersionId });
      await expectCacheEqualsActiveVersion(legacy!.id);
      await trading.setStatus(companyId, legacy!.id, "paused");
    });
  });

  describe("a change to the rules is a draft and a card, never a write", () => {
    it("PATCH with a rule change leaves the running rule alone; the card is filed from the stored draft", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const strategy = await trading.createStrategy(companyId, INPUT, USER);
      await trading.setStatus(companyId, strategy.id, "running");

      const patched = await trading.updateStrategy(companyId, strategy.id, { name: "Renamed", ruleConfig: { ...RULE, fastPeriod: 5, slowPeriod: 9 } }, USER);
      expect(patched.name).toBe("Renamed"); // a name edit stays direct
      expect(patched.ruleConfig).toEqual(RULE); // the rule did not change
      expect(patched.activeVersionId).toBe(strategy.activeVersionId);
      expect(patched.pendingVersion).toMatchObject({ outcome: "drafted", versionNumber: 2 });
      await expectCacheEqualsActiveVersion(strategy.id);

      const [v1, v2] = await versionRows(strategy.id);
      expect(v1!.status).toBe("approved");
      expect(v2).toMatchObject({ status: "draft", version: 2, proposedByType: "user", approvalId: patched.pendingVersion!.approvalId });
      const card = await cardOf(v2!.approvalId!);
      expect(card).toMatchObject({ type: "request_board_approval", status: "pending", companyId });
      expect(card.payload).toMatchObject({ kind: TRADING_STRATEGY_VERSION_APPROVAL_KIND, strategyId: strategy.id, versionId: v2!.id, versionNumber: 2, specDigest: v2!.specDigest });
      expect(String((card.payload as { summary: string }).summary)).toContain("SMA(5)");

      // The running strategy still decides with the OLD rule: 2/3 crossover buys, a 5/9 rule would still be warming up.
      expect(await trading.tick(T_BUY)).toMatchObject({ filled: 1 });
      await trading.setStatus(companyId, strategy.id, "paused");
    });

    it("a risk-only PATCH is also a draft; approving the card makes it live and the cache follows", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const strategy = await trading.createStrategy(companyId, INPUT, USER);
      const patched = await trading.updateStrategy(companyId, strategy.id, { riskConfig: riskConfig({ maxPositionNok: 800 }) }, USER);
      expect(patched.riskConfig).toEqual(riskConfig());
      const approvalId = patched.pendingVersion!.approvalId!;

      const result = await trading.versions.approveFromCard(companyId, approvalId, "owner-2");
      expect(result.version).toMatchObject({ version: 2, status: "approved", approvedByUserId: "owner-2" });
      expect(result.strategy.activeVersionId).toBe(result.version.id);
      expect(result.strategy.riskConfig).toEqual(riskConfig({ maxPositionNok: 800 }));
      expect(result.strategy.ruleConfig).toEqual(RULE); // still the plain crossover
      const [v1, v2] = await versionRows(strategy.id);
      expect(v1!.status).toBe("superseded");
      expect(v1!.supersededAt).not.toBeNull();
      expect(v2!.status).toBe("approved");
      await expectCacheEqualsActiveVersion(strategy.id);
      const notes = (await db.select().from(tradingLedgerEntries).where(eq(tradingLedgerEntries.strategyId, strategy.id))).filter((e) => (e.detail as { reason?: string }).reason === "strategy_version_activated");
      expect(notes).toHaveLength(1);
      expect(notes[0]!.strategyVersionId).toBe(v2!.id);
      // approving the same card again is harmless
      await trading.versions.approveFromCard(companyId, approvalId, "owner-2");
      expect((await versionRows(strategy.id)).filter((v) => v.status === "approved")).toHaveLength(1);
    });

    it("answers 'unchanged' for the rules already in force and 'already_pending' for an open identical draft", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const strategy = await trading.createStrategy(companyId, INPUT, USER);
      const same = await trading.updateStrategy(companyId, strategy.id, { ruleConfig: RULE, riskConfig: riskConfig() }, USER);
      expect(same.pendingVersion).toBeUndefined();
      expect(await versionRows(strategy.id)).toHaveLength(1);

      const body = { spec: stopSpec(), guidelines: "Only when calm." };
      const first = await trading.versions.proposeVersion(companyId, strategy.id, body, { type: "user", id: "u1" });
      const again = await trading.versions.proposeVersion(companyId, strategy.id, body, { type: "user", id: "u1" });
      expect(first.outcome).toBe("drafted");
      expect(again.outcome).toBe("already_pending");
      expect(await versionRows(strategy.id)).toHaveLength(2);
    });

    it("a newer proposal supersedes the open draft and closes its card", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const strategy = await trading.createStrategy(companyId, INPUT, USER);
      const a = await trading.versions.proposeVersion(companyId, strategy.id, { spec: stopSpec(), guidelines: "" }, { type: "user", id: "u1" });
      const b = await trading.versions.proposeVersion(companyId, strategy.id, { spec: stopSpec({ exit: { stop: { kind: "pct", pct: 3 } } }), guidelines: "" }, { type: "user", id: "u1" });
      if (a.outcome !== "drafted" || b.outcome !== "drafted") throw new Error("expected two drafts");
      const rows = await versionRows(strategy.id);
      expect(rows.map((r) => [r.version, r.status])).toEqual([[1, "approved"], [2, "superseded"], [3, "draft"]]);
      expect((await cardOf(a.approvalId)).status).toBe("cancelled");
      expect((await cardOf(b.approvalId)).status).toBe("pending");
      await expect(trading.versions.approveFromCard(companyId, a.approvalId, "owner-1")).rejects.toThrow(/replaced by a newer proposal|no open approval/);
      await expectCacheEqualsActiveVersion(strategy.id);
    });

    it("refuses rules for another coin or timeframe, and invalid rules, without storing anything", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const strategy = await trading.createStrategy(companyId, INPUT, USER);
      const propose = (spec: TradingStrategySpecInput) => trading.versions.proposeVersion(companyId, strategy.id, { spec, guidelines: "" }, { type: "user", id: "u1" });
      await expect(propose(stopSpec({ universe: { assets: ["ETH"], decisionTimeframe: "4h" } }))).rejects.toThrow(/one coin/);
      await expect(propose(stopSpec({ universe: { assets: ["BTC", "ETH"], decisionTimeframe: "4h" } }))).rejects.toThrow(/one coin/);
      await expect(propose(stopSpec({ universe: { assets: ["BTC"], decisionTimeframe: "1h" } }))).rejects.toThrow(/4h candles/);
      await expect(propose(stopSpec({ neverDo: { maxPositionNok: 6_000 } }))).rejects.toThrow(/not valid/);
      await expect(propose(stopSpec({ extra: true }))).rejects.toThrow(/not valid/);
      expect(await versionRows(strategy.id)).toHaveLength(1);
    });

    it("an agent can tighten the limits but never loosen them", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const strategy = await trading.createStrategy(companyId, { ...INPUT, riskConfig: riskConfig({ maxPositionNok: 1_000 }) }, USER);
      const agent = { type: "agent" as const, id: randomUUID() };
      await db.insert(agents).values({ id: agent.id, companyId, name: "Trading Analyst", role: "analyst" });
      await expect(trading.versions.proposeVersion(companyId, strategy.id, { spec: stopSpec({ neverDo: riskConfig({ maxPositionNok: 2_000 }) }), guidelines: "" }, agent)).rejects.toThrow(/never loosen[\s\S]*maxPositionNok/);
      await expect(trading.versions.proposeVersion(companyId, strategy.id, { spec: stopSpec({ neverDo: riskConfig({ maxPositionNok: 1_000, feeRatePct: 0.05 }) }), guidelines: "" }, agent)).rejects.toThrow(/feeRatePct/);
      const tighter = await trading.versions.proposeVersion(companyId, strategy.id, { spec: stopSpec({ neverDo: riskConfig({ maxPositionNok: 500 }) }), guidelines: "" }, agent);
      expect(tighter.outcome).toBe("drafted");
      if (tighter.outcome !== "drafted") return;
      expect(tighter.version).toMatchObject({ proposedByType: "agent", proposedById: agent.id });
      expect((await cardOf(tighter.approvalId)).requestedByAgentId).toBe(agent.id);
      // a person may loosen (within the hard ceiling): it is their card to approve
      const person = await trading.versions.proposeVersion(companyId, strategy.id, { spec: stopSpec({ neverDo: riskConfig({ maxPositionNok: 2_000 }) }), guidelines: "" }, { type: "user", id: "u1" });
      expect(person.outcome).toBe("drafted");
    });
  });

  describe("the card shows the stored draft and nothing else", () => {
    async function draftWithCard(trading: ReturnType<typeof service>, companyId: string) {
      const strategy = await trading.createStrategy(companyId, INPUT, USER);
      const result = await trading.versions.proposeVersion(companyId, strategy.id, { spec: stopSpec(), guidelines: "No trading at night." }, { type: "user", id: "u1" });
      if (result.outcome !== "drafted") throw new Error("expected a draft");
      return { strategy, version: result.version, approvalId: result.approvalId };
    }

    it("builds every word of the card from the stored row, including the guidelines and the digest", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const { version, approvalId } = await draftWithCard(trading, companyId);
      const card = await cardOf(approvalId);
      const payload = card.payload as Record<string, unknown>;
      expect(payload.specDigest).toBe(version.specDigest);
      expect(payload.guidelines).toBe("No trading at night.");
      expect(payload.readBack).toEqual(expect.arrayContaining([expect.stringContaining("stop 5% below the entry")]));
      const source = await trading.versions.getCardSource(companyId, approvalId);
      expect(source).toMatchObject({ matchesCard: true, storedRulesMatchDigest: true, status: "draft", versionNumber: 2 });
    });

    it.each([
      ["a changed summary", { summary: "Totally harmless change." }],
      ["a changed read-back", { readBack: ["When it buys: always."] }],
      ["a changed digest", { specDigest: "f".repeat(64) }],
      ["changed guidelines", { guidelines: "Buy everything." }],
      ["another version number", { versionNumber: 9 }],
      ["a changed plain summary", { plainSummary: "Nothing to see here." }],
    ])("refuses to activate when the card carries %s, and nothing changes", async (_label, change) => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const { strategy, version, approvalId } = await draftWithCard(trading, companyId);
      const card = await cardOf(approvalId);
      await db.update(approvals).set({ payload: { ...(card.payload as object), ...change } }).where(eq(approvals.id, approvalId));
      await expect(trading.versions.approveFromCard(companyId, approvalId, "owner-1")).rejects.toThrow(/does not show the stored rules/);
      const source = await trading.versions.getCardSource(companyId, approvalId);
      expect(source.matchesCard).toBe(false);
      expect((await versionRows(strategy.id)).find((v) => v.id === version.id)!.status).toBe("draft");
      expect((await trading.requireStrategy(companyId, strategy.id)).activeVersionId).toBe(strategy.activeVersionId);
      await expectCacheEqualsActiveVersion(strategy.id);
    });

    it("tolerates a renamed strategy and extra keys on the card, and still activates exactly the stored version", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const { strategy, version, approvalId } = await draftWithCard(trading, companyId);
      await trading.updateStrategy(companyId, strategy.id, { name: "Renamed later" }, USER);
      const card = await cardOf(approvalId);
      await db.update(approvals).set({ payload: { ...(card.payload as object), note: "extra" } }).where(eq(approvals.id, approvalId));
      const result = await trading.versions.approveFromCard(companyId, approvalId, "owner-1");
      expect(result.version.id).toBe(version.id);
      await expectCacheEqualsActiveVersion(strategy.id);
    });

    it("the database refuses to edit a stored version, so the text a card was made from cannot drift", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const { version } = await draftWithCard(trading, companyId);
      await expect(db.update(tradingStrategyVersions).set({ guidelines: "changed" }).where(eq(tradingStrategyVersions.id, version.id))).rejects.toThrow();
      await expect(db.update(tradingStrategyVersions).set({ spec: { not: "the spec" } }).where(eq(tradingStrategyVersions.id, version.id))).rejects.toThrow();
      await expect(db.update(tradingStrategyVersions).set({ specDigest: "e".repeat(64) }).where(eq(tradingStrategyVersions.id, version.id))).rejects.toThrow();
    });

    it("an approved version is immutable", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const { strategy, approvalId } = await draftWithCard(trading, companyId);
      const { version } = await trading.versions.approveFromCard(companyId, approvalId, "owner-1");
      await expect(db.update(tradingStrategyVersions).set({ guidelines: "later" }).where(eq(tradingStrategyVersions.id, version.id))).rejects.toThrow();
      await expect(db.update(tradingStrategyVersions).set({ status: "draft" }).where(eq(tradingStrategyVersions.id, version.id))).rejects.toThrow();
      await expectCacheEqualsActiveVersion(strategy.id);
    });

    it("a card from another company does not exist for you", async () => {
      const companyId = await seedCompany();
      const other = await seedCompany();
      const trading = service(T_BUY);
      const { strategy, approvalId } = await draftWithCard(trading, companyId);
      await expect(trading.versions.approveFromCard(other, approvalId, "owner-1")).rejects.toThrow(/not the approval card of any strategy version/);
      await expect(trading.versions.getCardSource(other, approvalId)).rejects.toThrow(/not linked/);
      await expect(trading.versions.listVersions(other, strategy.id)).rejects.toThrow(/not found/i);
      await expect(trading.versions.proposeVersion(other, strategy.id, { spec: stopSpec(), guidelines: "" }, { type: "user", id: "u" })).rejects.toThrow(/not found/i);
      await expect(trading.updateStrategy(other, strategy.id, { ruleConfig: RULE }, USER)).rejects.toThrow(/not found/i);
    });
  });

  describe("the approval kind is card-only", () => {
    it("is refused through create, resubmit and every approve path except the card's own route", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const strategy = await trading.createStrategy(companyId, INPUT, USER);
      const result = await trading.versions.proposeVersion(companyId, strategy.id, { spec: stopSpec(), guidelines: "" }, { type: "user", id: "u1" });
      if (result.outcome !== "drafted") throw new Error("expected a draft");
      const svc = approvalService(db);
      const { isApprovalCardOnlyKind } = await import("../services/approvals.ts");
      const card = await cardOf(result.approvalId);
      expect(isApprovalCardOnlyKind(card)).toBe(true);

      // nobody can write such a card by hand
      await expect(
        svc.create(companyId, { type: "request_board_approval", status: "pending", payload: { kind: TRADING_STRATEGY_VERSION_APPROVAL_KIND, specDigest: result.version.specDigest } }),
      ).rejects.toThrow(/can only be filed by the strategy itself/);
      // thread replies, automations and Telegram all end in approve() without the card flag
      await expect(svc.approve(result.approvalId, "owner-1", null)).rejects.toThrow(/approval card itself/);
      // even on the card, the card does not turn green unless the stored version is live with this digest
      await expect(svc.approve(result.approvalId, "owner-1", null, { decidedOnApprovalCard: true })).rejects.toThrow(/owner or admin from the approval card/);
      expect((await cardOf(result.approvalId)).status).toBe("pending");
      // a revision request cannot be turned into a rewritten card
      await db.update(approvals).set({ status: "revision_requested" }).where(eq(approvals.id, result.approvalId));
      await expect(svc.resubmit(result.approvalId, { kind: TRADING_STRATEGY_VERSION_APPROVAL_KIND, summary: "different" })).rejects.toThrow(/can only be filed by the strategy itself/);
      await expect(svc.resubmit(result.approvalId)).rejects.toThrow(/can only be filed by the strategy itself/);
      await db.update(approvals).set({ status: "pending" }).where(eq(approvals.id, result.approvalId));

      // the real path: activate the stored draft, then the card can be marked approved
      await trading.versions.approveFromCard(companyId, result.approvalId, "owner-1");
      const decided = await svc.approve(result.approvalId, "owner-1", null, { decidedOnApprovalCard: true });
      expect(decided.approval.status).toBe("approved");
    });

    it("a forged card for a version that is not live is refused even on the card route", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const strategy = await trading.createStrategy(companyId, INPUT, USER);
      const result = await trading.versions.proposeVersion(companyId, strategy.id, { spec: stopSpec(), guidelines: "" }, { type: "user", id: "u1" });
      if (result.outcome !== "drafted") throw new Error("expected a draft");
      const [forged] = await db
        .insert(approvals)
        .values({ companyId, type: "request_board_approval", status: "pending", payload: { kind: TRADING_STRATEGY_VERSION_APPROVAL_KIND, specDigest: result.version.specDigest, versionId: result.version.id } })
        .returning();
      await expect(approvalService(db).approve(forged!.id, "owner-1", null, { decidedOnApprovalCard: true })).rejects.toThrow(/owner or admin from the approval card/);
      await expect(trading.versions.approveFromCard(companyId, forged!.id, "owner-1")).rejects.toThrow(/not the approval card/);
      expect((await trading.requireStrategy(companyId, strategy.id)).activeVersionId).toBe(strategy.activeVersionId);
    });
  });

  describe("the tick reads only the active version", () => {
    it("ignores the cache columns", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const strategy = await trading.createStrategy(companyId, INPUT, USER);
      await trading.setStatus(companyId, strategy.id, "running");
      // somebody scribbles over the cache: a rule that never trades and a position cap of 1 NOK
      await db
        .update(tradingStrategies)
        .set({ ruleConfig: { type: "sma_crossover", version: 1, fastPeriod: 100, slowPeriod: 200, orderSizeFraction: 0.01 }, riskConfig: riskConfig({ maxPositionNok: 1 }) })
        .where(eq(tradingStrategies.id, strategy.id));
      expect(await trading.tick(T_BUY)).toMatchObject({ filled: 1, blocked: 0 });
      const row = await trading.requireStrategy(companyId, strategy.id);
      expect(row.cashNok).toBeCloseTo(2_000 - 1_000 - 2.5, 6); // the version's 50% and 5000 NOK cap, not the scribble
      await trading.setStatus(companyId, strategy.id, "paused");
    });

    it("stamps every order and ledger row with the version, and a new version restamps from its activation on", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const strategy = await trading.createStrategy(companyId, INPUT, USER);
      await trading.setStatus(companyId, strategy.id, "running");
      expect(await trading.tick(T_BUY)).toMatchObject({ filled: 1 });
      const v1 = strategy.activeVersionId!;
      const orders = await db.select().from(tradingOrders).where(eq(tradingOrders.strategyId, strategy.id));
      expect(orders.map((o) => o.strategyVersionId)).toEqual([v1]);
      const ledger = await db.select().from(tradingLedgerEntries).where(eq(tradingLedgerEntries.strategyId, strategy.id));
      expect(ledger.length).toBeGreaterThan(0);
      expect(ledger.every((e) => e.strategyVersionId === v1)).toBe(true);

      const patched = await trading.updateStrategy(companyId, strategy.id, { riskConfig: riskConfig({ maxOrdersPerDay: 10 }) }, USER);
      const { version: v2 } = await trading.versions.approveFromCard(companyId, patched.pendingVersion!.approvalId!, "owner-1");
      await trading.setStatus(companyId, strategy.id, "paused");
      await trading.setStatus(companyId, strategy.id, "running");
      const later = (await db.select().from(tradingLedgerEntries).where(eq(tradingLedgerEntries.strategyId, strategy.id))).filter((e) => e.eventType === "kill_switch");
      expect(later.map((e) => e.strategyVersionId)).toEqual(expect.arrayContaining([v1, v2.id]));
      await trading.setStatus(companyId, strategy.id, "paused");
    });

    it("runs a rule book with a stop end to end: levels are kept with the position and the stop sells it", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const strategy = await trading.createStrategy(companyId, INPUT, USER);
      const proposed = await trading.versions.proposeVersion(companyId, strategy.id, { spec: stopSpec(), guidelines: "" }, { type: "user", id: "u1" });
      if (proposed.outcome !== "drafted") throw new Error("expected a draft");
      const { version } = await trading.versions.approveFromCard(companyId, proposed.approvalId, "owner-1");
      const live = await trading.requireStrategy(companyId, strategy.id);
      expect(live.ruleConfig).toMatchObject({ type: "strategy_spec", specVersion: 2, versionId: version.id, versionNumber: 2 });
      await expectCacheEqualsActiveVersion(strategy.id);

      await trading.setStatus(companyId, strategy.id, "running");
      expect(await trading.tick(T_BUY)).toMatchObject({ filled: 1 });
      const opened = await trading.requireStrategy(companyId, strategy.id);
      expect(opened.positionQuantity).toBeGreaterThan(0);
      expect(opened.positionLevels).toMatchObject({ versionId: version.id, entryPrice: 21, highestPrice: 21 });
      expect((opened.positionLevels as { stopPrice: number }).stopPrice).toBeCloseTo(21 * 0.95, 8);
      const [buy] = await trading.listOrders(companyId, strategy.id);
      expect(buy).toMatchObject({ side: "buy", strategyVersionId: version.id, ruleVersion: `strategy_spec@v2 · engine 2` });

      // Four hours later a bar dips to 19.5 (below the 19.95 stop) but closes at 20.2: no crossover, only the stop applies.
      const t2 = new Date(T_BUY.getTime() + FOUR_H);
      const dip = barsEndingAt([20, 20, 21, 20.2], new Date(t2.getTime() - FOUR_H), [{}, {}, {}, { high: 21.4, low: 19.5 }]);
      const seller = service(t2, dip, 20.2);
      expect(await seller.tick(t2)).toMatchObject({ checked: 1, filled: 1 });
      const closed = await seller.requireStrategy(companyId, strategy.id);
      expect(closed.positionQuantity).toBeCloseTo(0, 9);
      expect(closed.positionLevels).toBeNull();
      const orders = await seller.listOrders(companyId, strategy.id);
      expect(orders.map((o) => [o.side, o.status])).toEqual([["buy", "filled"], ["sell", "filled"]]);
      expect(orders[1]!.strategyVersionId).toBe(version.id);
      await seller.setStatus(companyId, strategy.id, "paused");
    });

    it("re-derives the protective levels when a new version goes live under an open position", async () => {
      const companyId = await seedCompany();
      const trading = service(T_BUY);
      const strategy = await trading.createStrategy(companyId, INPUT, USER); // plain crossover: no stop
      await trading.setStatus(companyId, strategy.id, "running");
      expect(await trading.tick(T_BUY)).toMatchObject({ filled: 1 });
      expect((await trading.requireStrategy(companyId, strategy.id)).positionLevels).toMatchObject({ stopPrice: null });

      const proposed = await trading.versions.proposeVersion(companyId, strategy.id, { spec: stopSpec(), guidelines: "" }, { type: "user", id: "u1" });
      if (proposed.outcome !== "drafted") throw new Error("expected a draft");
      const { version } = await trading.versions.approveFromCard(companyId, proposed.approvalId, "owner-1");
      // The next tick, with a bar that dips under 5% below the entry price, must apply the NEW stop to the position that is already open.
      const t2 = new Date(T_BUY.getTime() + FOUR_H);
      const dip = barsEndingAt([20, 20, 21, 20.2], new Date(t2.getTime() - FOUR_H), [{}, {}, {}, { high: 21.4, low: 19.5 }]);
      const seller = service(t2, dip, 20.2);
      expect(await seller.tick(t2)).toMatchObject({ checked: 1, filled: 1 });
      const orders = await seller.listOrders(companyId, strategy.id);
      expect(orders.map((o) => o.side)).toEqual(["buy", "sell"]);
      expect(orders[1]!.strategyVersionId).toBe(version.id);
      await seller.setStatus(companyId, strategy.id, "paused");
    });
  });
});
