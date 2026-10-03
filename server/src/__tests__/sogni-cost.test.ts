import { describe, expect, it, vi } from "vitest";

const createEvent = vi.fn(async () => ({}));
vi.mock("../services/costs.js", () => ({ costService: () => ({ createEvent }) }));

import { readSogniWorkflowCredits, recordSogniCost, sogniCreditsToMicroUsd } from "../services/sogni-cost.js";

describe("sogni cost", () => {
  it("reads actual credits from workflow, usage, or summed steps; ignores estimates", () => {
    expect(readSogniWorkflowCredits({ actualCapacityUnits: 12 })).toBe(12);
    expect(readSogniWorkflowCredits({ steps: [{ cost: 2 }, { cost: { actual: 3 } }] })).toBe(5);
    expect(readSogniWorkflowCredits({ estimated_capacity_units: 9 })).toBeNull();
    expect(readSogniWorkflowCredits(null)).toBeNull();
  });

  it("converts credits with the company price; missing/zero price gives null", () => {
    expect(sogniCreditsToMicroUsd(10, 0.01)).toBe(100_000);
    expect(sogniCreditsToMicroUsd(10, undefined)).toBeNull();
    expect(sogniCreditsToMicroUsd(10, 0)).toBeNull();
  });

  it("records a converted-from-credits row, and records nothing without a price", async () => {
    const base = { companyId: "c", agentId: "a", credits: 10, model: "z-turbo" };
    expect(await recordSogniCost({} as never, { ...base, creditPriceUsd: 0.01 })).toEqual({ recorded: true, costMicroUsd: 100_000 });
    expect(createEvent).toHaveBeenCalledWith("c", expect.objectContaining({ provider: "sogni", costMicroUsd: 100_000, costSource: "converted_from_credits" }));
    createEvent.mockClear();
    expect(await recordSogniCost({} as never, { ...base, creditPriceUsd: 0 })).toEqual({ recorded: false, reason: "credit_price_not_set" });
    expect(await recordSogniCost({} as never, { ...base, credits: null, creditPriceUsd: 0.01 })).toEqual({ recorded: false, reason: "no_credits_reported" });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("skips recording when an idempotent key already has a row", async () => {
    createEvent.mockClear();
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "e1" }] }) }) }) };
    const out = await recordSogniCost(db as never, { companyId: "c", agentId: "a", credits: 10, model: "m", creditPriceUsd: 0.01, billingCode: "video_storyline_render:s1", idempotent: true });
    expect(out).toEqual({ recorded: false, reason: "already_recorded" });
    expect(createEvent).not.toHaveBeenCalled();
  });
});
