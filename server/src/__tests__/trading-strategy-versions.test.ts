import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { approvals, companies, createDb, tradingLedgerEntries, tradingOrders, tradingStrategies, tradingStrategyVersions, type Db } from "@paperclipai/db";
import {
  DEFAULT_TRADING_RISK_CONFIG,
  TRADING_STRATEGY_VERSION_APPROVAL_KIND,
  legacySmaCrossoverDocument,
  projectStrategyCache,
  splitStrategyDocument,
  strategyDocumentSchema,
  tradingTimeframeMs,
  type CreateTradingStrategyInput,
  type StrategyDocument,
  type TradingCandle,
  type TradingRiskConfig,
  type TradingRuleConfig,
  type TradingTimeframe,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { approvalService } from "../services/approvals.ts";
import { tradingService } from "../services/trading.ts";
import { digestStrategySpec, readStoredVersion, tradingStrategyVersionService } from "../services/trading-strategy-versions.ts";
import { fakeTradingMarketData } from "../services/trading-market-data.ts";

/**
 * DUR-5002: the versioned rule book end to end -- one source of truth (the tick
 * reads only the active version; rule_config / risk_config are a cache), PATCH
 * files a draft + a card instead of writing, the card is card-only and exactly the
 * stored draft, everything is company-scoped, legacy sma_crossover@1 strategies
 * are converted into grandfathered versions, and every order and ledger row is
 * stamped with the version.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping trading strategy version tests: ${support.reason ?? "unsupported environment"}`);
}

const RULE: TradingRuleConfig = { type: "sma_crossover", version: 1, fastPeriod: 2, slowPeriod: 3, orderSizeFraction: 0.5 };
const RISK: TradingRiskConfig = { ...DEFAULT_TRADING_RISK_CONFIG, approvalAboveNok: 1_000_000_000, feeRatePct: 0.25 };
const INPUT: CreateTradingStrategyInput = { name: "Versioned", asset: "BTC", timeframe: "15m", checkEveryMinutes: 15, startingCashNok: 2_000, ruleConfig: RULE, riskConfig: RISK };
const USER = { actorType: "user" as const, actorId: "owner-1" };

function barsEndingAt(closes: number[], lastOpen: Date, timeframe: TradingTimeframe = "15m"): TradingCandle[] {
  const step = tradingTimeframeMs(timeframe);
  return closes.map((close, i) => ({ openTime: new Date(lastOpen.getTime() - (closes.length - 1 - i) * step), open: close, high: close, low: close, close, volume: 1 }));
}

d("trading strategy versions", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("trading-strategy-versions");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Trading Co", issuePrefix: `V${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    return companyId;
  }

  function service(now = new Date("2026-01-01T00:00:00Z"), candles: TradingCandle[] = barsEndingAt([20, 20, 20, 21], new Date("2025-12-31T23:45:00Z")), quoteUsd = 21) {
    return tradingService(db, { now: () => now, marketData: fakeTradingMarketData({ candles: { BTC: { candles } }, quotes: { BTC: { bidUsd: quoteUsd, askUsd: quoteUsd, at: now } } }) });
  }

  const versionsSvc = () => tradingStrategyVersionService(db);

  /** Approve a version card the only way it can be approved: on the card itself, with the activation hook. */
  async function approveCard(approvalId: string, userId = "owner-1") {
    return approvalService(db).approve(approvalId, userId, null, {
      decidedOnApprovalCard: true,
      tradingStrategyVersion: { activate: (card) => versionsSvc().activateFromCard(card, userId) },
    });
  }

  /** The invariant behind "one source of truth": the cache columns always equal the projection of the active version. */
  async function expectCacheEqualsActive(strategyId: string) {
    const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategyId));
    expect(row!.activeVersionId).toBeTruthy();
    const [version] = await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.id, row!.activeVersionId!));
    expect(version!.status).toBe("approved");
    const stored = readStoredVersion(version!);
    const expected = projectStrategyCache(stored.spec, version!.specDigest, version!.version);
    expect(row!.ruleConfig).toEqual(expected.ruleConfig);
    expect(row!.riskConfig).toEqual(expected.riskConfig);
    return { row: row!, version: version! };
  }

  function authoredDoc(overrides: Partial<StrategyDocument> = {}): StrategyDocument {
    const base = legacySmaCrossoverDocument({ name: "Versioned", asset: "BTC", timeframe: "15m", rule: RULE, risk: RISK });
    return strategyDocumentSchema.parse({ ...base, ...overrides });
  }

  it("creates a strategy with an approved first version and a cache that equals it", async () => {
    const companyId = await seedCompany();
    const trading = service();
    const strategy = await trading.createStrategy(companyId, INPUT, USER);
    const { version } = await expectCacheEqualsActive(strategy.id);
    expect(version).toMatchObject({ version: 1, status: "approved", proposedByType: "user", proposedById: "owner-1", approvedByUserId: "owner-1", grandfathered: false });
    expect(strategy.ruleConfig).toEqual(RULE); // an SMA rule still reads exactly as before
    expect(strategy.riskConfig).toEqual(RISK);
    expect(version.specDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("PATCH with a rule or risk change files a draft and a card and writes nothing live", async () => {
    const companyId = await seedCompany();
    const trading = service();
    const strategy = await trading.createStrategy(companyId, INPUT, USER);
    const before = await expectCacheEqualsActive(strategy.id);

    const patched = await trading.updateStrategy(companyId, strategy.id, { ruleConfig: { ...RULE, fastPeriod: 3, slowPeriod: 5 }, riskConfig: { ...RISK, maxOrdersPerDay: 3 } }, USER);
    expect(patched.pendingVersion).toMatchObject({ version: 2 });
    // The live rule is untouched: the row, its cache and the active pointer are exactly what they were.
    expect(patched.ruleConfig).toEqual(RULE);
    expect(patched.riskConfig).toEqual(RISK);
    expect(patched.activeVersionId).toBe(before.version.id);
    await expectCacheEqualsActive(strategy.id);

    const [draft] = await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.id, patched.pendingVersion!.versionId));
    expect(draft).toMatchObject({ status: "draft", version: 2, proposedByType: "user", proposedById: "owner-1", approvalId: patched.pendingVersion!.approvalId });
    const [card] = await db.select().from(approvals).where(eq(approvals.id, patched.pendingVersion!.approvalId));
    expect(card).toMatchObject({ type: "request_board_approval", status: "pending", companyId });
    expect(card!.payload).toMatchObject({ kind: TRADING_STRATEGY_VERSION_APPROVAL_KIND, strategyVersionId: draft!.id, specDigest: draft!.specDigest, versionNo: 2 });
  });

  it("a name or check-interval edit stays direct and files no card", async () => {
    const companyId = await seedCompany();
    const trading = service();
    const strategy = await trading.createStrategy(companyId, INPUT, USER);
    const patched = await trading.updateStrategy(companyId, strategy.id, { name: "Renamed", checkEveryMinutes: 30 }, USER);
    expect(patched).toMatchObject({ name: "Renamed", checkEveryMinutes: 30, pendingVersion: null });
    expect(await versionsSvc().listVersions(companyId, strategy.id)).toHaveLength(1);
  });

  it("a running strategy keeps trading its active version until the card is approved, then switches", async () => {
    const companyId = await seedCompany();
    // closes [20,20,20,21]: fast 2 / slow 3 crosses up -> a buy under the active version. Under a draft that needs a 50-bar warm-up, nothing could trade.
    const trading = service();
    const strategy = await trading.createStrategy(companyId, INPUT, USER);
    const slow = { ...RULE, fastPeriod: 10, slowPeriod: 50 };
    const patched = await trading.updateStrategy(companyId, strategy.id, { ruleConfig: slow }, USER);
    await trading.setStatus(companyId, strategy.id, "running");
    expect(await trading.tick(new Date("2026-01-01T00:00:00Z"))).toMatchObject({ checked: 1, filled: 1 }); // still the old 2/3 rule
    await trading.setStatus(companyId, strategy.id, "paused");

    await approveCard(patched.pendingVersion!.approvalId);
    const { row, version } = await expectCacheEqualsActive(strategy.id);
    expect(version.version).toBe(2);
    expect(row.ruleConfig).toEqual(slow);
    const all = await versionsSvc().listVersions(companyId, strategy.id);
    expect(all.map((v) => [v.version, v.status])).toEqual([[2, "approved"], [1, "superseded"]]);
    expect(all[0]).toMatchObject({ approvedByUserId: "owner-1" });
    // The activation is on the strategy's ledger, stamped with the new version.
    const [note] = await db.select().from(tradingLedgerEntries).where(and(eq(tradingLedgerEntries.strategyId, strategy.id), sql`${tradingLedgerEntries.detail}->>'reason' = 'strategy_version_activated'`));
    expect(note).toMatchObject({ strategyVersionId: version.id });
  });

  it("stamps every order and ledger row with the version that produced it", async () => {
    const companyId = await seedCompany();
    const trading = service();
    const strategy = await trading.createStrategy(companyId, INPUT, USER);
    await trading.setStatus(companyId, strategy.id, "running");
    await trading.tick(new Date("2026-01-01T00:00:00Z"));
    await trading.setStatus(companyId, strategy.id, "paused");
    const activeId = (await expectCacheEqualsActive(strategy.id)).version.id;
    const orders = await db.select().from(tradingOrders).where(eq(tradingOrders.strategyId, strategy.id));
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o) => o.strategyVersionId === activeId)).toBe(true);
    const ledger = await db.select().from(tradingLedgerEntries).where(eq(tradingLedgerEntries.strategyId, strategy.id));
    expect(ledger.length).toBeGreaterThan(1);
    expect(ledger.every((l) => l.strategyVersionId === activeId)).toBe(true);
    const filled = ledger.find((l) => l.eventType === "order_filled")!;
    expect(filled.detail).toMatchObject({ decision: { reasonCodes: expect.arrayContaining(["entry_conditions_met"]), directionCall: { direction: "up" } } });
  });

  it("refuses to write the cache or the active pointer around the activation transaction", async () => {
    const companyId = await seedCompany();
    const strategy = await service().createStrategy(companyId, INPUT, USER);
    await expect(db.update(tradingStrategies).set({ ruleConfig: { ...RULE, fastPeriod: 4 } }).where(eq(tradingStrategies.id, strategy.id))).rejects.toThrow();
    await expect(db.update(tradingStrategies).set({ riskConfig: { ...RISK, maxOrdersPerDay: 1 } }).where(eq(tradingStrategies.id, strategy.id))).rejects.toThrow();
    await expectCacheEqualsActive(strategy.id);
  });

  it("only the card itself can approve: not through a plain approve, a thread reply or automation", async () => {
    const companyId = await seedCompany();
    const trading = service();
    const strategy = await trading.createStrategy(companyId, INPUT, USER);
    const patched = await trading.updateStrategy(companyId, strategy.id, { riskConfig: { ...RISK, maxOrdersPerDay: 3 } }, USER);
    const id = patched.pendingVersion!.approvalId;
    // No `decidedOnApprovalCard`: what a linked confirmation, automation or any other caller of approve() looks like.
    await expect(approvalService(db).approve(id, "someone")).rejects.toThrow(/approval card itself/);
    // On the card but without the activation hook: still refused, so nothing is "approved" without being switched on.
    await expect(approvalService(db).approve(id, "someone", null, { decidedOnApprovalCard: true })).rejects.toThrow(/owner or admin/);
    const [card] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(card!.status).toBe("pending");
    expect((await expectCacheEqualsActive(strategy.id)).version.version).toBe(1);
  });

  it("nobody can file or resubmit such a card by hand", async () => {
    const companyId = await seedCompany();
    const svc = approvalService(db);
    await expect(
      svc.create(companyId, { type: "request_board_approval", status: "pending", payload: { kind: TRADING_STRATEGY_VERSION_APPROVAL_KIND, strategyVersionId: randomUUID() } }),
    ).rejects.toThrow(/can only be filed by the strategy itself/);
    const trading = service();
    const strategy = await trading.createStrategy(companyId, INPUT, USER);
    const patched = await trading.updateStrategy(companyId, strategy.id, { riskConfig: { ...RISK, maxOrdersPerDay: 3 } }, USER);
    await svc.requestRevision(patched.pendingVersion!.approvalId, "owner-1");
    await expect(svc.resubmit(patched.pendingVersion!.approvalId, { kind: TRADING_STRATEGY_VERSION_APPROVAL_KIND, cardText: "different" })).rejects.toThrow(/can only be filed by the strategy itself/);
  });

  it("a card whose text differs from the stored draft cannot be approved", async () => {
    const companyId = await seedCompany();
    const trading = service();
    const strategy = await trading.createStrategy(companyId, INPUT, USER);
    const patched = await trading.updateStrategy(companyId, strategy.id, { riskConfig: { ...RISK, maxOrdersPerDay: 3 } }, USER);
    const id = patched.pendingVersion!.approvalId;
    const [card] = await db.select().from(approvals).where(eq(approvals.id, id));
    const payload = card!.payload as Record<string, unknown>;
    for (const tampered of [
      { ...payload, cardText: `${String(payload.cardText)}\nAlso: sends all the money away.` },
      { ...payload, specDigest: "f".repeat(64) },
      { ...payload, title: "Approve something harmless" },
      { ...payload, strategyVersionId: randomUUID() },
    ]) {
      await db.update(approvals).set({ payload: tampered }).where(eq(approvals.id, id));
      await expect(approveCard(id)).rejects.toThrow(/not the stored draft|not the approval card/);
    }
    // Put the true card back and it works: the draft itself was never touched.
    await db.update(approvals).set({ payload }).where(eq(approvals.id, id));
    await approveCard(id);
    expect((await expectCacheEqualsActive(strategy.id)).version.version).toBe(2);
  });

  it("the stored draft cannot be edited, so the card cannot drift from it", async () => {
    const companyId = await seedCompany();
    const trading = service();
    const strategy = await trading.createStrategy(companyId, INPUT, USER);
    const patched = await trading.updateStrategy(companyId, strategy.id, { riskConfig: { ...RISK, maxOrdersPerDay: 3 } }, USER);
    const versionId = patched.pendingVersion!.versionId;
    await expect(db.update(tradingStrategyVersions).set({ guidelines: "Buy everything." }).where(eq(tradingStrategyVersions.id, versionId))).rejects.toThrow();
    await expect(db.update(tradingStrategyVersions).set({ specDigest: "a".repeat(64) }).where(eq(tradingStrategyVersions.id, versionId))).rejects.toThrow();
    // Even a row rewritten around the trigger would fail the digest check at approve time and in the tick.
    await db.execute(sql`ALTER TABLE trading_strategy_versions DISABLE TRIGGER trading_strategy_versions_guard`);
    try {
      await db.execute(sql`UPDATE trading_strategy_versions SET guidelines = 'Buy everything.' WHERE id = ${versionId}`);
    } finally {
      await db.execute(sql`ALTER TABLE trading_strategy_versions ENABLE TRIGGER trading_strategy_versions_guard`);
    }
    await expect(approveCard(patched.pendingVersion!.approvalId)).rejects.toThrow(/digest|not the stored draft/);
  });

  it("a new proposal replaces the open draft and withdraws its card", async () => {
    const companyId = await seedCompany();
    const trading = service();
    const strategy = await trading.createStrategy(companyId, INPUT, USER);
    const first = await trading.updateStrategy(companyId, strategy.id, { riskConfig: { ...RISK, maxOrdersPerDay: 3 } }, USER);
    const second = await trading.updateStrategy(companyId, strategy.id, { riskConfig: { ...RISK, maxOrdersPerDay: 2 } }, USER);
    expect(second.pendingVersion!.version).toBe(3);
    const [oldCard] = await db.select().from(approvals).where(eq(approvals.id, first.pendingVersion!.approvalId));
    expect(oldCard!.status).toBe("cancelled");
    const [oldDraft] = await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.id, first.pendingVersion!.versionId));
    expect(oldDraft!.status).toBe("superseded");
    await expect(approveCard(first.pendingVersion!.approvalId)).rejects.toThrow();
    await approveCard(second.pendingVersion!.approvalId);
    expect((await expectCacheEqualsActive(strategy.id)).row.riskConfig).toMatchObject({ maxOrdersPerDay: 2 });
  });

  it("rejecting the card closes the draft and changes nothing live", async () => {
    const companyId = await seedCompany();
    const trading = service();
    const strategy = await trading.createStrategy(companyId, INPUT, USER);
    const patched = await trading.updateStrategy(companyId, strategy.id, { riskConfig: { ...RISK, maxOrdersPerDay: 3 } }, USER);
    await approvalService(db).reject(patched.pendingVersion!.approvalId, "owner-1");
    const [draft] = await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.id, patched.pendingVersion!.versionId));
    expect(draft!.status).toBe("superseded");
    expect((await expectCacheEqualsActive(strategy.id)).version.version).toBe(1);
  });

  it("a no-change PATCH files nothing", async () => {
    const companyId = await seedCompany();
    const trading = service();
    const strategy = await trading.createStrategy(companyId, INPUT, USER);
    const patched = await trading.updateStrategy(companyId, strategy.id, { ruleConfig: RULE, riskConfig: RISK }, USER);
    expect(patched.pendingVersion).toBeNull();
    expect(await versionsSvc().listVersions(companyId, strategy.id)).toHaveLength(1);
  });

  it("an agent may tighten but never loosen; a person may loosen inside the ceiling", async () => {
    const companyId = await seedCompany();
    const strategy = await service().createStrategy(companyId, INPUT, USER);
    const looser = authoredDoc({ risk: { ...RISK, maxOrdersPerDay: RISK.maxOrdersPerDay + 5 } });
    await expect(versionsSvc().proposeVersion(companyId, strategy.id, looser, { type: "agent", id: randomUUID() })).rejects.toThrow(/only tighten/);
    const tighter = authoredDoc({ risk: { ...RISK, maxOrdersPerDay: 2 } });
    const agentId = randomUUID();
    // approvals.requested_by_agent_id has a foreign key to agents; the proposer id is recorded on the version either way.
    await db.execute(sql`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${companyId}, 'Trader')`);
    const proposed = await versionsSvc().proposeVersion(companyId, strategy.id, tighter, { type: "agent", id: agentId });
    expect(proposed.unchanged).toBe(false);
    if (!proposed.unchanged) expect(proposed.version).toMatchObject({ proposedByType: "agent", proposedById: agentId, status: "draft" });
    const byPerson = await versionsSvc().proposeVersion(companyId, strategy.id, looser, { type: "user", id: "owner-1" });
    expect(byPerson.unchanged).toBe(false);
  });

  it("refuses a rule book about another coin or candle size", async () => {
    const companyId = await seedCompany();
    const strategy = await service().createStrategy(companyId, INPUT, USER);
    const eth = authoredDoc();
    eth.universe = { assets: ["ETH"], decisionTimeframe: "15m" };
    await expect(versionsSvc().proposeVersion(companyId, strategy.id, eth, { type: "user", id: "owner-1" })).rejects.toThrow(/does not list BTC/);
    const hourly = authoredDoc();
    hourly.universe = { assets: ["BTC"], decisionTimeframe: "1h" };
    await expect(versionsSvc().proposeVersion(companyId, strategy.id, hourly, { type: "user", id: "owner-1" })).rejects.toThrow(/different candle size/);
  });

  it("is company-scoped: another company can neither see, propose on nor activate a strategy's versions", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const strategy = await service().createStrategy(companyA, INPUT, USER);
    const patched = await service().updateStrategy(companyA, strategy.id, { riskConfig: { ...RISK, maxOrdersPerDay: 3 } }, USER);
    expect(await versionsSvc().listVersions(companyB, strategy.id)).toEqual([]);
    await expect(versionsSvc().proposeVersion(companyB, strategy.id, authoredDoc(), { type: "user", id: "x" })).rejects.toThrow(/not found/i);
    await expect(service().updateStrategy(companyB, strategy.id, { riskConfig: RISK }, USER)).rejects.toThrow(/not found/i);
    // A card presented as company B's can never activate company A's version.
    const [card] = await db.select().from(approvals).where(eq(approvals.id, patched.pendingVersion!.approvalId));
    await expect(versionsSvc().activateFromCard({ id: card!.id, companyId: companyB, payload: card!.payload }, "owner-1")).rejects.toThrow(/not the approval card/);
    expect((await expectCacheEqualsActive(strategy.id)).version.version).toBe(1);
  });

  it("converts a pre-existing sma_crossover@1 strategy into a grandfathered legacy version and stamps its history", async () => {
    const companyId = await seedCompany();
    // A strategy exactly as it was before migration 0262: no active version, unstamped orders and ledger rows.
    const strategyId = randomUUID();
    await db.insert(tradingStrategies).values({
      id: strategyId, companyId, name: "Old SMA", asset: "BTC", timeframe: "15m", ruleConfig: RULE, riskConfig: RISK, startingCashNok: 2_000, cashNok: 2_000, peakEquityNok: 2_000,
    });
    const orderId = randomUUID();
    await db.insert(tradingOrders).values({ id: orderId, companyId, strategyId, side: "buy", status: "rejected", ruleVersion: "sma_crossover@1 · engine 2", signalPriceNok: 100, requestedQuantity: 1 });
    await db.insert(tradingLedgerEntries).values({ companyId, strategyId, orderId, eventType: "risk_block" });

    const first = await versionsSvc().convertLegacyStrategies();
    expect(first.converted).toBeGreaterThanOrEqual(1);
    const { row, version } = await expectCacheEqualsActive(strategyId);
    expect(version).toMatchObject({ version: 1, status: "approved", grandfathered: true, proposedByType: "system", approvedByUserId: null });
    expect(row.ruleConfig).toEqual(RULE); // the cache is untouched: it already said what the version projects to
    const [order] = await db.select().from(tradingOrders).where(eq(tradingOrders.id, orderId));
    expect(order!.strategyVersionId).toBe(version.id);
    const entries = await db.select().from(tradingLedgerEntries).where(eq(tradingLedgerEntries.strategyId, strategyId));
    expect(entries.every((e) => e.strategyVersionId === version.id)).toBe(true);
    expect(digestStrategySpec(readStoredVersion(version).spec, "")).toBe(version.specDigest);

    // Idempotent: a second boot converts nothing and adds no second version.
    await versionsSvc().convertLegacyStrategies();
    expect(await versionsSvc().listVersions(companyId, strategyId)).toHaveLength(1);

    // And it trades exactly as the legacy rule did: the same buy on the same closed bars.
    const trading = service();
    await trading.setStatus(companyId, strategyId, "running");
    expect(await trading.tick(new Date("2026-01-01T00:00:00Z"))).toMatchObject({ checked: 1, filled: 1 });
    await trading.setStatus(companyId, strategyId, "paused");
  });

  it("a strategy with no active version does not trade", async () => {
    const companyId = await seedCompany();
    const strategyId = randomUUID();
    await db.insert(tradingStrategies).values({
      id: strategyId, companyId, name: "Unconverted", asset: "BTC", timeframe: "15m", status: "running", ruleConfig: RULE, riskConfig: RISK, startingCashNok: 2_000, cashNok: 2_000, peakEquityNok: 2_000,
    });
    const later = new Date(Date.now() + 3_600_000); // after the row's default next_check_at (the database clock)
    const trading = service(later);
    const result = await trading.tick(later);
    expect(result).toMatchObject({ checked: expect.any(Number), filled: 0 });
    const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategyId));
    expect(row!.lastTickError).toMatch(/no active rule book/);
    await db.update(tradingStrategies).set({ status: "paused" }).where(eq(tradingStrategies.id, strategyId));
  });

  it("splits guidelines from the engine spec in storage", async () => {
    const companyId = await seedCompany();
    const strategy = await service().createStrategy(companyId, { ...INPUT, document: undefined }, USER);
    const doc = { ...authoredDoc(), guidelines: "Read the news first." };
    const proposed = await versionsSvc().proposeVersion(companyId, strategy.id, doc, { type: "user", id: "owner-1" });
    if (proposed.unchanged) throw new Error("expected a draft");
    expect(proposed.version.guidelines).toBe("Read the news first.");
    expect(JSON.stringify(proposed.version.spec)).not.toContain("Read the news first.");
    const { spec, guidelines } = splitStrategyDocument(doc);
    expect(proposed.version.specDigest).toBe(digestStrategySpec(spec, guidelines));
  });
});
