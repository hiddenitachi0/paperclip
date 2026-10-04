import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { budgetIncidents, budgetPolicies, companies, companySecrets, costEvents, costReconciliationRuns, createDb, sogniBalanceSnapshots } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { budgetService } from "../services/budgets.js";
import { runDailyCostReconciliation } from "../services/cost-reconciliation.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const NOW = new Date("2026-09-16T06:00:00Z");
const YESTERDAY = new Date("2026-09-15T12:00:00Z");

d("daily cost reconciliation (DUR-4462)", () => {
  let stop: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const s = await startEmbeddedPostgresTestDatabase("cost-reconciliation");
    stop = s.cleanup;
    db = createDb(s.connectionString);
  }, 90_000);
  afterAll(async () => { await stop?.(); });

  async function setup(opts: { fal?: boolean; sogni?: boolean } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: `R${companyId.slice(0, 5).toUpperCase()}` });
    const secret = async (key: string) => {
      const [row] = await db.insert(companySecrets).values({ companyId, key, name: key }).returning();
      return row!.id;
    };
    const config: Record<string, unknown> = { sogniCreditPriceUsd: 0.01 };
    if (opts.fal) config.falAdminKeySecretRef = await secret("fal-admin");
    if (opts.sogni) config.sogniKeySecretRef = await secret("sogni");
    return { companyId, config };
  }
  const run = (config: Record<string, unknown>, falFetch = vi.fn(async () => json({}, 403)), sogniFetch = vi.fn(async () => json({}, 401))) => {
    const resolveSecret = vi.fn(async () => "KEY");
    return {
      resolveSecret, falFetch, sogniFetch,
      go: () => runDailyCostReconciliation(db, { getConfig: async () => config, resolveSecret, falFetch, sogniFetch, now: () => NOW }),
    };
  };
  const balance = (settled: string) => vi.fn(async () => json({ status: "success", data: { spark: { settled } } }));
  const usage = (total: number) => vi.fn(async () => json({ summary: [{ cost_total: total, currency: "USD" }], has_more: false }));

  it("skips cleanly with no admin key, no Sogni key and no snapshot: no calls, no rows", async () => {
    const { config } = await setup();
    const r = run(config);
    expect(await r.go()).toEqual([]);
    expect(r.falFetch).not.toHaveBeenCalled();
    expect(r.sogniFetch).not.toHaveBeenCalled();
    expect(r.resolveSecret).not.toHaveBeenCalled();
  });

  it("a failing Fal call writes no run row (retried next tick); a first Sogni look stores a baseline only", async () => {
    const { companyId, config } = await setup({ fal: true, sogni: true });
    const r = run(config, vi.fn(async () => json({}, 403)), balance("100"));
    const [o] = await r.go();
    expect(o).toMatchObject({ companyId, fal: "skipped", sogni: "baseline" });
    const runs = await db.select().from(costReconciliationRuns).where(eq(costReconciliationRuns.companyId, companyId));
    expect(runs.map((x) => `${x.provider}:${x.status}`)).toEqual(["sogni:baseline"]);
    const [snap] = await db.select().from(sogniBalanceSnapshots).where(eq(sogniBalanceSnapshots.companyId, companyId));
    expect(snap?.spark).toBe(100);
    // Same day again: Sogni is already done, Fal is retried.
    const again = await run(config, vi.fn(async () => json({}, 403)), balance("90")).go();
    expect(again[0]).toMatchObject({ fal: "skipped", sogni: "already_done" });
  });

  it("runs Fal (once per day) and Sogni, and files the owner notice above the threshold only", async () => {
    const { companyId, config } = await setup({ fal: true, sogni: true });
    await db.insert(costEvents).values({ companyId, provider: "fal", biller: "fal", model: "m", costCents: 10, costMicroUsd: 100_000, costSource: "estimate", occurredAt: YESTERDAY });
    await db.insert(sogniBalanceSnapshots).values({ companyId, spark: 100, observedAt: new Date(NOW.getTime() - 24 * 3600_000) });
    // Alert at 50 cents, warn at 80% => 40 cents.
    await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId, metric: "cost_reconciliation_mismatch_cents", windowKind: "calendar_day_utc", amount: 50, warnPercent: 80, hardStopEnabled: false, notifyEnabled: true });

    // Fal matches (10 cents) and Sogni dropped 3 credits unrecorded at $0.01 = 3 cents: below threshold.
    const quiet = run(config, usage(0.1), balance("97"));
    const [o1] = await quiet.go();
    expect(o1).toMatchObject({ fal: "reconciled", sogni: "reconciled" });
    expect(await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, companyId))).toHaveLength(0);
    expect(quiet.resolveSecret).toHaveBeenCalledTimes(2);

    // Re-run the same day: nothing is called again.
    const second = run(config, usage(5), balance("0"));
    expect((await second.go())[0]).toMatchObject({ fal: "already_done", sogni: "already_done" });
    expect(second.falFetch).not.toHaveBeenCalled();
    expect(second.sogniFetch).not.toHaveBeenCalled();

    // Next day Fal billed $1.00 against 10 cents recorded: 90 cents mismatch >= 40.
    const later = new Date(NOW.getTime() + 24 * 3600_000);
    await db.insert(costEvents).values({ companyId, provider: "fal", biller: "fal", model: "m", costCents: 10, costMicroUsd: 100_000, costSource: "estimate", occurredAt: NOW });
    const loud = await runDailyCostReconciliation(db, { getConfig: async () => config, resolveSecret: async () => "KEY", falFetch: usage(1), sogniFetch: balance("97"), now: () => later });
    expect(loud[0]).toMatchObject({ fal: "reconciled" });
    const incidents = await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, companyId));
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ thresholdType: "soft", metric: "cost_reconciliation_mismatch_cents", amountObserved: 90 });
    // The policy summary observes the same figure (what the budgets page shows).
    const summary = await budgetService(db).upsertPolicy(companyId, { scopeType: "company", scopeId: companyId, metric: "cost_reconciliation_mismatch_cents", windowKind: "calendar_month_utc", amount: 1000, warnPercent: 80, hardStopEnabled: false, notifyEnabled: true, isActive: true }, null);
    expect(summary.observedAmount).toBe(90);
  });
});
