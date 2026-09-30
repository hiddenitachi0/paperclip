import { describe, expect, it } from "vitest";
import {
  createVideoShotSchema,
  createVideoStorylineSchema,
  estimateVideoStorylineCostCents,
  VIDEO_PROVIDER_COST_CENTS_PER_SECOND,
} from "./video-storylines.js";

describe("estimateVideoStorylineCostCents", () => {
  it("sums shot durations and multiplies by the provider's cents-per-second", () => {
    const result = estimateVideoStorylineCostCents(
      [{ durationSeconds: 5 }, { durationSeconds: 3 }, { durationSeconds: 2 }],
      "fal",
    );
    expect(result.shotCount).toBe(3);
    expect(result.totalSeconds).toBe(10);
    expect(result.costPerSecondCents).toBe(VIDEO_PROVIDER_COST_CENTS_PER_SECOND.fal);
    expect(result.estimatedTotalCents).toBe(10 * VIDEO_PROVIDER_COST_CENTS_PER_SECOND.fal);
  });

  it("returns zero for an empty shot list rather than throwing", () => {
    const result = estimateVideoStorylineCostCents([], "sogni");
    expect(result).toEqual({ shotCount: 0, totalSeconds: 0, estimatedTotalCents: 0, costPerSecondCents: VIDEO_PROVIDER_COST_CENTS_PER_SECOND.sogni });
  });

  it("never lets a negative duration reduce the total (defensive -- schema should already block this)", () => {
    const result = estimateVideoStorylineCostCents([{ durationSeconds: -5 }, { durationSeconds: 4 }], "fal");
    expect(result.totalSeconds).toBe(4);
  });
});

describe("createVideoStorylineSchema", () => {
  it("defaults provider to fal and budget cap to null", () => {
    const parsed = createVideoStorylineSchema.parse({ title: "My film" });
    expect(parsed.providerId).toBe("fal");
    expect(parsed.budgetCapCents).toBeNull();
    expect(parsed.characterReferenceAssetIds).toEqual([]);
  });

  it("rejects an empty title", () => {
    expect(() => createVideoStorylineSchema.parse({ title: "" })).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() => createVideoStorylineSchema.parse({ title: "x", nope: 1 })).toThrow();
  });
});

describe("createVideoShotSchema", () => {
  const sceneId = "11111111-1111-1111-1111-111111111111";

  it("defaults duration to the standard shot length", () => {
    const parsed = createVideoShotSchema.parse({ sceneId, orderIndex: 0, prompt: "A hero walks in." });
    expect(parsed.durationSeconds).toBe(5);
  });

  it("rejects a duration above the max", () => {
    expect(() =>
      createVideoShotSchema.parse({ sceneId, orderIndex: 0, prompt: "x", durationSeconds: 61 }),
    ).toThrow();
  });

  it("rejects a blank prompt", () => {
    expect(() => createVideoShotSchema.parse({ sceneId, orderIndex: 0, prompt: "  " })).toThrow();
  });
});
