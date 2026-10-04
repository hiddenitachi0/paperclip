import { describe, expect, it, vi } from "vitest";
import { computeFalCostMicroUsd, falPricingClient, fetchFalUsageSummary, microUsdToCents, normalizeFalUnit } from "../services/fal-pricing.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("fal pricing (DUR-4455)", () => {
  it("normalizes Fal unit labels", () => {
    expect(normalizeFalUnit("images")).toBe("images");
    expect(normalizeFalUnit("megapixels")).toBe("megapixels");
    expect(normalizeFalUnit("video seconds")).toBe("seconds");
    expect(normalizeFalUnit("characters")).toBeNull();
  });

  it("computes cost per image, megapixel and second", () => {
    expect(computeFalCostMicroUsd({ unit: "images", unitPrice: 0.04 }, { images: 3 })).toBe(120_000);
    expect(computeFalCostMicroUsd({ unit: "megapixels", unitPrice: 0.003 }, { images: 1, megapixels: 0.786432 })).toBe(2_359);
    expect(computeFalCostMicroUsd({ unit: "seconds", unitPrice: 0.5 }, { seconds: 5 })).toBe(2_500_000);
    // usage that does not cover the billing unit is unpriceable, never guessed
    expect(computeFalCostMicroUsd({ unit: "megapixels", unitPrice: 0.003 }, { images: 1 })).toBeNull();
    expect(computeFalCostMicroUsd({ unit: null, unitPrice: 1 }, { images: 1 })).toBeNull();
  });

  it("rounds legacy cents up so a non-zero cost never records as 0", () => {
    expect(microUsdToCents(2_359)).toBe(1);
    expect(microUsdToCents(0)).toBe(0);
    expect(microUsdToCents(120_000)).toBe(12);
  });

  it("prices a call from the published price, sends the key only as a header, and caches per scope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ prices: [{ endpoint_id: "fal-ai/flux/schnell", unit_price: 0.003, unit: "megapixels", currency: "USD" }] }));
    const client = falPricingClient(fetchImpl);
    const priced = await client.priceCall("SECRET-KEY", "fal-ai/flux/schnell", { megapixels: 1 }, "co-1");
    expect(priced?.costMicroUsd).toBe(3_000);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("SECRET-KEY");
    expect((init.headers as Record<string, string>).Authorization).toBe("Key SECRET-KEY");
    await client.priceCall("SECRET-KEY", "fal-ai/flux/schnell", { megapixels: 1 }, "co-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await client.priceCall("SECRET-KEY", "fal-ai/flux/schnell", { megapixels: 1 }, "co-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns null (caller falls back to the estimate) on pricing failure, bad id or non-USD", async () => {
    const failing = falPricingClient(async () => jsonResponse({}, 500));
    expect(await failing.priceCall("k", "fal-ai/flux/schnell", { images: 1 }, "c")).toBeNull();
    const throwing = falPricingClient(async () => { throw new Error("boom k"); });
    expect(await throwing.priceCall("k", "fal-ai/flux/schnell", { images: 1 }, "c")).toBeNull();
    const fetchImpl = vi.fn();
    expect(await falPricingClient(fetchImpl).priceCall("k", "https://evil/x", { images: 1 }, "c")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    const eur = falPricingClient(async () => jsonResponse({ prices: [{ endpoint_id: "a/b", unit_price: 1, unit: "images", currency: "EUR" }] }));
    expect(await eur.priceCall("k", "a/b", { images: 1 }, "c")).toBeNull();
  });

  it("sums the usage summary and yields null without admin scope", async () => {
    const ok = await fetchFalUsageSummary(
      async () => jsonResponse({ summary: [{ cost_total: 1.5, currency: "USD" }, { cost_total: 0.25, currency: "USD" }], has_more: false }),
      "admin",
      { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-10-02T00:00:00Z") },
    );
    expect(ok?.totalMicroUsd).toBe(1_750_000);
    const denied = await fetchFalUsageSummary(async () => jsonResponse({}, 403), "k", { start: new Date(), end: new Date() });
    expect(denied).toBeNull();
  });
});
