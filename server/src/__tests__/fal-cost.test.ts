import { beforeEach, describe, expect, it, vi } from "vitest";

const createEvent = vi.fn(async () => ({}));
vi.mock("../services/costs.js", () => ({ costService: () => ({ createEvent }) }));
const warn = vi.fn();
vi.mock("../middleware/logger.js", () => ({ logger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), error: vi.fn() } }));

import { applyFalActualCost, clearFalPriceCache, computeFalCostMicroUsd, priceFalCall, reconcileFalUsage } from "../services/fal-cost.js";

const KEY = "fal-secret-key-123";
const json = (body: unknown, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  clearFalPriceCache();
  createEvent.mockClear();
  warn.mockClear();
});

describe("computeFalCostMicroUsd", () => {
  it("prices per image, per megapixel, per second, per request", () => {
    expect(computeFalCostMicroUsd({ unit: "image", unitPrice: 0.003 }, { images: 2 })).toBe(6_000);
    expect(computeFalCostMicroUsd({ unit: "megapixels", unitPrice: 0.025 }, { width: 1024, height: 768 })).toBe(Math.round(0.786432 * 0.025 * 1e6));
    expect(computeFalCostMicroUsd({ unit: "second", unitPrice: 0.07 }, { seconds: 5 })).toBe(350_000);
    expect(computeFalCostMicroUsd({ unit: "video", unitPrice: 0.4 }, {})).toBe(400_000);
  });
  it("returns null when the needed usage or unit is missing", () => {
    expect(computeFalCostMicroUsd({ unit: "megapixel", unitPrice: 0.025 }, {})).toBeNull();
    expect(computeFalCostMicroUsd({ unit: "second", unitPrice: 0.07 }, {})).toBeNull();
    expect(computeFalCostMicroUsd({ unit: "parsec", unitPrice: 1 }, { images: 1 })).toBeNull();
  });
});

describe("priceFalCall", () => {
  it("uses Fal's published price, sends the key only as a header, and caches", async () => {
    const f = vi.fn(json({ prices: [{ endpoint_id: "fal-ai/flux/schnell", unit_price: 0.003, unit: "megapixels", currency: "USD" }] }));
    const a = await priceFalCall(f, KEY, "fal-ai/flux/schnell", { width: 1024, height: 768 });
    expect(a).toEqual({ costCents: 0, costMicroUsd: 2359, costSource: "estimate" });
    expect(f.mock.calls[0]![0]).not.toContain(KEY);
    expect(f.mock.calls[0]![1]!.headers).toEqual({ Authorization: `Key ${KEY}` });
    await priceFalCall(f, KEY, "fal-ai/flux/schnell", { width: 512, height: 512 });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("returns null when pricing is unavailable and never logs the key", async () => {
    expect(await priceFalCall(json({}, 403), KEY, "fal-ai/x", { images: 1 })).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });
});

describe("applyFalActualCost", () => {
  it("replaces the estimate on the reserved event with cents + micro-USD + source", async () => {
    const where = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where }));
    const db = { update: () => ({ set }) } as never;
    await applyFalActualCost(db, "evt", { costCents: 35, costMicroUsd: 350_000, costSource: "estimate" });
    expect(set).toHaveBeenCalledWith({ costCents: 35, costMicroUsd: 350_000, costSource: "estimate" });
    expect(where).toHaveBeenCalled();
  });
});

describe("reconcileFalUsage", () => {
  const range = { companyId: "c", adminApiKey: KEY, start: new Date("2026-10-02T00:00:00Z"), end: new Date("2026-10-03T00:00:00Z") };
  function dbWith(recordedMicro: number) {
    return {
      delete: () => ({ where: async () => undefined }),
      select: () => ({ from: () => ({ where: async () => [{ micro: String(recordedMicro) }] }) }),
    } as never;
  }
  it("skips when the key lacks usage scope", async () => {
    expect(await reconcileFalUsage(dbWith(0), json({}, 403), range)).toEqual({ status: "skipped", reason: "usage_api_unavailable" });
    expect(createEvent).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });
  it("books a provider-sourced adjustment for the shortfall only", async () => {
    const r = await reconcileFalUsage(dbWith(300_000), json({ summary: [{ cost_total: 0.4 }, { cost_total: 0.1 }], has_more: false }), range);
    expect(r).toMatchObject({ status: "reconciled", billedMicroUsd: 500_000, adjustmentMicroUsd: 200_000 });
    expect(createEvent).toHaveBeenCalledWith("c", expect.objectContaining({ provider: "fal", costMicroUsd: 200_000, costCents: 20, costSource: "provider" }));
  });
  it("books nothing when recorded already covers billed", async () => {
    await reconcileFalUsage(dbWith(900_000), json({ summary: [{ cost_total: 0.5 }] }), range);
    expect(createEvent).not.toHaveBeenCalled();
  });
});
