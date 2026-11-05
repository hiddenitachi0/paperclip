import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, tradingLedgerEntries, tradingSelectorConfirmations, tradingSelectorDecisions, tradingShadowCells, tradingShadowTrades, tradingStrategies, type Db } from "@paperclipai/db";
import { seededRandom } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { tradingSelectorService } from "../services/trading-selector.ts";

/**
 * DUR-5015: the selector against a real Postgres. Shadow trades are seeded
 * already closed with the triggers off (the way a long-running instance holds
 * them); everything the selector then writes goes through the real triggers.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping trading selector tests: ${support.reason ?? "unsupported environment"}`);

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const CP1 = new Date(Date.UTC(2026, 1, 1)); // after ~31 days of discovery data
const CP2 = new Date(Date.UTC(2026, 2, 1));
const CP3 = new Date(Date.UTC(2026, 3, 1));
const CP4 = new Date(Date.UTC(2026, 4, 1));

function normals(seed: number, count: number, mean: number): number[] {
  const rand = seededRandom(seed);
  const out: number[] = [];
  while (out.length < count) {
    const u = Math.max(1e-12, rand());
    out.push(mean + Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()));
  }
  return out;
}

d("tradingSelectorService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("trading-selector");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);
  afterAll(async () => {
    await stopDb?.();
  });

  async function company() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Sel Co", issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    return companyId;
  }

  async function cell(companyId: string, name: string, weather = "up", asset = "BTC", firstSeen = new Date(T0 - DAY)) {
    const [row] = await db
      .insert(tradingShadowCells)
      .values({ companyId, templateKey: name, templateVersion: 1, family: "trend", weather, asset, firstSeenAt: firstSeen })
      .returning();
    return row!;
  }

  /** Closed shadow trades: result i entered at start + i*spacing, held 4 hours, resolved right after it closed. */
  async function trades(companyId: string, cellRow: { id: string; templateKey: string; asset: string; weather: string }, results: number[], startMs: number, spacingMs: number, resolvedAt?: Date) {
    const rows = results.map((r, i) => {
      const entry = new Date(startMs + i * spacingMs);
      const exit = new Date(entry.getTime() + 4 * 3_600_000);
      return {
        companyId,
        cellId: cellRow.id,
        templateKey: cellRow.templateKey,
        templateVersion: 1,
        asset: cellRow.asset,
        timeframe: "4h",
        weather: cellRow.weather,
        signalBarCloseAt: entry,
        decidedAt: entry,
        weatherLabel: {},
        status: "closed" as const,
        entryAt: entry,
        exitAt: exit,
        entryPrice: 100,
        exitPrice: 101,
        exitReason: "x",
        barsHeld: 1,
        r1x: r + 0.05,
        r2x: r,
        netReturn1x: 0.01,
        netReturn2x: 0.01,
        resolvedAt: resolvedAt ?? new Date(exit.getTime() + 60_000),
      };
    });
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      for (let i = 0; i < rows.length; i += 400) await tx.insert(tradingShadowTrades).values(rows.slice(i, i + 400));
    });
  }

  /** 20 cells with no edge, plus `lucky` (a hot streak before CP1, then no edge). */
  async function world(opts: { luckyMean: number; freshMean: number; seed: number }) {
    const companyId = await company();
    const keys: Array<{ id: string; name: string }> = [];
    for (let i = 0; i < 20; i++) {
      const c = await cell(companyId, `null${i}`, i % 2 ? "up" : "range", i % 3 ? "BTC" : "ETH");
      keys.push({ id: c.id, name: c.templateKey });
      await trades(companyId, c, normals(opts.seed * 100 + i, 50, 0), T0, 0.5 * DAY); // before CP1
      await trades(companyId, c, normals(opts.seed * 100 + 50 + i, 130, 0), CP1.getTime() + DAY, 0.2 * DAY); // after CP1
    }
    const lucky = await cell(companyId, "lucky");
    await trades(companyId, lucky, normals(opts.seed * 7, 50, opts.luckyMean), T0, 0.5 * DAY);
    await trades(companyId, lucky, normals(opts.seed * 7 + 1, 130, opts.freshMean), CP1.getTime() + DAY, 0.2 * DAY);
    return { companyId, lucky };
  }

  it("writes an immutable decision, opens a confirmation for a cell that passes, and gives it no paper cash yet", async () => {
    const { companyId, lucky } = await world({ luckyMean: 0.9, freshMean: 0, seed: 14 });
    const selector = tradingSelectorService(db);
    const now = new Date(CP1.getTime() + 3_600_000);
    const first = await selector.runCheckpoint(companyId, CP1, now);
    expect(first.created).toBe(true);
    expect(first.output?.choice).toBe("cash");
    expect(first.output?.startedConfirmations).toContain("lucky@1|up|BTC");
    expect(first.output?.riskCaps).toBe("unchanged");
    const [decision] = await db.select().from(tradingSelectorDecisions).where(eq(tradingSelectorDecisions.companyId, companyId));
    expect(decision).toMatchObject({ choice: "cash", rulesVersion: 1, riskCapsChanged: false });
    expect(decision!.trials).toBe(21);
    const confirmations = await db.select().from(tradingSelectorConfirmations).where(eq(tradingSelectorConfirmations.companyId, companyId));
    // Ten percent of false discoveries are allowed by design, so another cell may have opened a window too; none holds cash.
    expect(confirmations.find((c) => c.cellId === lucky.id)).toMatchObject({ status: "running", promoted: false });
    expect(confirmations.every((c) => c.status === "running" && !c.promoted)).toBe(true);
    expect(await selector.promotedCells(companyId)).toEqual([]);
    // Immutable.
    await expect(db.update(tradingSelectorDecisions).set({ choice: "cells" }).where(eq(tradingSelectorDecisions.id, decision!.id))).rejects.toThrow();
    // A second run of the same checkpoint writes nothing new.
    expect((await selector.runCheckpoint(companyId, CP1, new Date(now.getTime() + 60_000))).created).toBe(false);
    expect(await db.select().from(tradingSelectorDecisions).where(eq(tradingSelectorDecisions.companyId, companyId))).toHaveLength(1);
  }, 90_000);

  it("a cell that passed only by luck fails at the confirmation window and never gets paper cash", async () => {
    const { companyId } = await world({ luckyMean: 0.9, freshMean: 0, seed: 14 });
    const selector = tradingSelectorService(db);
    await selector.runCheckpoint(companyId, CP1, new Date(CP1.getTime() + 3_600_000));
    // 130 fresh trades have closed since CP1 (window of 100 is full by CP2).
    const second = await selector.runCheckpoint(companyId, CP2, new Date(CP2.getTime() + 3_600_000));
    const luckyOutcome = second.output!.cells.find((c) => c.key === "lucky@1|up|BTC")!;
    expect(luckyOutcome.windowTrades).toBe(100);
    expect(["confirmation_failed", "confirmed_promoted"]).toContain(luckyOutcome.action);
    // With this seed the fresh window is plain noise: it fails.
    expect(luckyOutcome.action).toBe("confirmation_failed");
    expect(second.output!.promoted).toEqual([]);
    expect(await selector.promotedCells(companyId)).toEqual([]);
    const [confirmation] = await db.select().from(tradingSelectorConfirmations).where(eq(tradingSelectorConfirmations.companyId, companyId));
    expect(confirmation).toMatchObject({ status: "failed", promoted: false });
    // The failed window is final in the database.
    await expect(db.update(tradingSelectorConfirmations).set({ status: "passed", promoted: true }).where(eq(tradingSelectorConfirmations.id, confirmation!.id))).rejects.toThrow();
    // It cannot start over at once: whether or not its old numbers still pass, no new window opens and no cash is given.
    const third = await selector.runCheckpoint(companyId, CP3, new Date(CP3.getTime() + 3_600_000));
    expect(["passed_test_confirmation_blocked", "failed_test"]).toContain(third.output!.cells.find((c) => c.key === "lucky@1|up|BTC")!.action);
    expect(third.output!.startedConfirmations).not.toContain("lucky@1|up|BTC");
    expect(third.output!.promoted).toEqual([]);
  }, 120_000);

  it("a real edge is promoted only after its fresh window, and it can be reproduced from stored data", async () => {
    const { companyId } = await world({ luckyMean: 0.5, freshMean: 0.5, seed: 3 });
    const selector = tradingSelectorService(db);
    await selector.runCheckpoint(companyId, CP1, new Date(CP1.getTime() + 3_600_000));
    const second = await selector.runCheckpoint(companyId, CP2, new Date(CP2.getTime() + 3_600_000));
    expect(second.output!.promoted).toEqual(["lucky@1|up|BTC"]);
    expect(second.output!.choice).toBe("cells");
    expect(await selector.promotedCells(companyId)).toMatchObject([{ cellKey: "lucky@1|up|BTC", templateKey: "lucky", weather: "up", asset: "BTC" }]);

    const decisions = await db.select().from(tradingSelectorDecisions).where(eq(tradingSelectorDecisions.companyId, companyId));
    for (const decision of decisions) {
      const rebuilt = await selector.reproduce(companyId, decision.id);
      expect(rebuilt).toMatchObject({ reproduced: true, rulesDigestMatches: true, inputDigestMatches: true, outputDigestMatches: true });
    }

    // A trade that closed before the checkpoint but was only resolved after the decision was made is not part of that decision, so it cannot change its reproduction.
    const cells = await db.select().from(tradingShadowCells).where(eq(tradingShadowCells.companyId, companyId));
    await trades(companyId, cells[0]!, normals(999, 40, 1), CP1.getTime() + 10 * DAY + 3_600_000, 0.1 * DAY, new Date(CP2.getTime() + 2 * 3_600_000));
    for (const decision of decisions) expect((await selector.reproduce(companyId, decision.id)).reproduced).toBe(true);
  }, 120_000);

  it("refuses a promotion within 7 days after a drawdown stop, then promotes once the wait is over", async () => {
    const { companyId } = await world({ luckyMean: 0.5, freshMean: 0.5, seed: 4 });
    const strategyId = randomUUID();
    await db.insert(tradingStrategies).values({
      id: strategyId,
      companyId,
      name: "S",
      asset: "BTC",
      timeframe: "4h",
      status: "paused",
      ruleConfig: { type: "sma_crossover", version: 1, fastPeriod: 2, slowPeriod: 3, orderSizeFraction: 0.5 },
      riskConfig: {},
      startingCashNok: 2_000,
      cashNok: 2_000,
      peakEquityNok: 2_000,
    });
    const selector = tradingSelectorService(db);
    await selector.runCheckpoint(companyId, CP1, new Date(CP1.getTime() + 3_600_000));
    await db.insert(tradingLedgerEntries).values({ companyId, strategyId, eventType: "circuit_breaker", detail: { cause: "drawdown_limit" }, createdAt: new Date(CP2.getTime() - 2 * DAY) });
    const second = await selector.runCheckpoint(companyId, CP2, new Date(CP2.getTime() + 3_600_000));
    expect(second.output!.cells.find((c) => c.key === "lucky@1|up|BTC")!.action).toBe("confirmed_deferred_after_drawdown");
    expect(second.output!.promoted).toEqual([]);
    expect(await selector.promotedCells(companyId)).toEqual([]);
    // A month later the stop is old: the confirmed cell is promoted without a new window.
    await trades(companyId, (await db.select().from(tradingShadowCells).where(eq(tradingShadowCells.companyId, companyId))).find((c) => c.templateKey === "lucky")!, normals(55, 40, 0.5), CP2.getTime() + DAY, 0.3 * DAY);
    const third = await selector.runCheckpoint(companyId, CP3, new Date(CP3.getTime() + 3_600_000));
    expect(third.output!.promoted).toEqual(["lucky@1|up|BTC"]);
    for (const decision of await db.select().from(tradingSelectorDecisions).where(eq(tradingSelectorDecisions.companyId, companyId))) {
      expect((await selector.reproduce(companyId, decision.id)).reproduced).toBe(true);
    }
  }, 150_000);

  it("is company-scoped: another company's trades never enter a decision, and tick() decides each company once", async () => {
    const a = await world({ luckyMean: 0.9, freshMean: 0, seed: 14 });
    const b = await company();
    const bCell = await cell(b, "only_b");
    await trades(b, bCell, normals(77, 60, 1.5), T0, 0.5 * DAY);
    const selector = tradingSelectorService(db);
    const tick = await selector.tick(new Date(CP1.getTime() + 3_600_000));
    expect(tick.checkpointAt).toBe(CP1.toISOString());
    expect(tick.decisions).toBeGreaterThanOrEqual(2);
    const aDecision = (await db.select().from(tradingSelectorDecisions).where(eq(tradingSelectorDecisions.companyId, a.companyId)))[0]!;
    expect(aDecision.trials).toBe(21);
    const bDecision = (await db.select().from(tradingSelectorDecisions).where(eq(tradingSelectorDecisions.companyId, b)))[0]!;
    expect(bDecision.trials).toBe(1);
    expect((await selector.tick(new Date(CP1.getTime() + 7_200_000))).decisions).toBe(0);
    expect(await selector.listDecisions(b)).toHaveLength(1);
    expect((await selector.shadowSummary(b)).map((c) => c.cellKey)).toEqual(["only_b@1|up|BTC"]);
  }, 150_000);

  it("replays the selector over stored history (walk-forward) without error", async () => {
    const { companyId } = await world({ luckyMean: 0.5, freshMean: 0.5, seed: 6 });
    const report = await tradingSelectorService(db).walkForward(companyId, new Date(CP4.getTime() + DAY));
    expect(report.checkpoints.length).toBeGreaterThanOrEqual(3);
    expect(report.rulesVersion).toBe(1);
  }, 150_000);
});
