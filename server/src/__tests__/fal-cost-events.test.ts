import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, costEvents, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { reconcileFalDay, recordFalCostEvent } from "../services/fal-cost-events.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

d("Fal cost events (DUR-4455)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("fal-cost-events");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);
  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Co", issuePrefix: `F${id.slice(0, 5).toUpperCase()}` });
    return id;
  }

  const priceFetch = (unit: string, unitPrice: number, model = "fal-ai/flux/schnell") =>
    vi.fn(async () => json({ prices: [{ endpoint_id: model, unit_price: unitPrice, unit, currency: "USD" }] }));

  it("writes per-megapixel actual cost with micro-USD precision and no key in the row", async () => {
    const companyId = await seedCompany();
    const out = await recordFalCostEvent(db, priceFetch("megapixels", 0.003), {
      companyId, apiKey: "SECRET-FAL-KEY", agentId: null, createdByUserId: "u", model: "fal-ai/flux/schnell",
      usage: { images: 1, megapixels: 0.786432 }, estimateCents: 4, billingCode: "video-storyline-still",
    });
    expect(out).toEqual({ costCents: 1, costMicroUsd: 2359 });
    const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costSource).toBe("estimate");
    expect(JSON.stringify(rows)).not.toContain("SECRET-FAL-KEY");
  });

  it("prices video per second and falls back to the estimate when Fal's price is unavailable", async () => {
    const companyId = await seedCompany();
    await recordFalCostEvent(db, priceFetch("seconds", 0.4, "fal-ai/video"), {
      companyId, apiKey: "k", agentId: null, model: "fal-ai/video", usage: { seconds: 5 }, estimateCents: 100, billingCode: "video-storyline-shot",
    });
    await recordFalCostEvent(db, async () => json({}, 500), {
      companyId, apiKey: "k", agentId: null, model: "fal-ai/video", usage: { seconds: 5 }, estimateCents: 100, billingCode: "video-storyline-shot",
    });
    const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(rows.map((r) => r.costMicroUsd).sort()).toEqual([1_000_000, 2_000_000]);
  });

  it("reconciles a day: confirms within tolerance, adjusts on drift, idempotent, skips without admin scope", async () => {
    const companyId = await seedCompany();
    const day = new Date("2026-09-15T12:00:00Z");
    await db.insert(costEvents).values({ companyId, provider: "fal", biller: "fal", model: "m", costCents: 10, costMicroUsd: 100_000, costSource: "estimate", occurredAt: day });
    const usage = (total: number) => vi.fn(async () => json({ summary: [{ cost_total: total, currency: "USD" }], has_more: false }));

    expect((await reconcileFalDay(db, async () => json({}, 403), { companyId, adminKey: "k", day })).status).toBe("skipped");

    const confirmed = await reconcileFalDay(db, usage(0.1), { companyId, adminKey: "k", day });
    expect(confirmed.status).toBe("confirmed");
    let rows = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costSource).toBe("provider");

    const adjusted = await reconcileFalDay(db, usage(0.25), { companyId, adminKey: "k", day });
    expect(adjusted).toMatchObject({ status: "adjusted", deltaMicroUsd: 150_000 });
    await reconcileFalDay(db, usage(0.25), { companyId, adminKey: "k", day });
    rows = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.model === "reconciliation")?.costMicroUsd).toBe(150_000);
  });

  it("never auto-decreases tracked spend when Fal reports less than recorded (DUR-4493)", async () => {
    const companyId = await seedCompany();
    const day = new Date("2026-09-16T12:00:00Z");
    // Real recorded spend for the day.
    await db.insert(costEvents).values({ companyId, provider: "fal", biller: "fal", model: "m", costCents: 500, costMicroUsd: 5_000_000, costSource: "estimate", occurredAt: day });
    const emptyUsage = vi.fn(async () => json({ summary: [], has_more: false }));

    const result = await reconcileFalDay(db, emptyUsage, { companyId, adminKey: "k", day });
    // The mismatch is still reported (for the soft-incident alert path)...
    expect(result).toMatchObject({ status: "adjusted", billedMicroUsd: 0, recordedMicroUsd: 5_000_000, deltaMicroUsd: -5_000_000 });

    // ...but no cost_events row is written that would zero out the day's real spend.
    const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows.find((r) => r.model === "reconciliation")).toBeUndefined();
  });
});
