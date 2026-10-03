import { describe, expect, it } from "vitest";
import {
  STILL_IMAGE_PROVIDER_COST_CENTS_PER_IMAGE,
  approveStoryboardShotSchema,
  dropStoryboardShotSchema,
  estimateStoryboardCostCents,
  generateStoryboardStillSchema,
  updateVideoStorylineApprovalThresholdSchema,
} from "./video-storyline-stills.js";

describe("estimateStoryboardCostCents", () => {
  it("charges one image per non-dropped shot at the provider's per-image rate", () => {
    const result = estimateStoryboardCostCents(
      [{ storyboardStatus: "pending" }, { storyboardStatus: "approved" }, { storyboardStatus: "pending" }],
      "fal",
    );
    expect(result.shotCount).toBe(3);
    expect(result.costPerImageCents).toBe(STILL_IMAGE_PROVIDER_COST_CENTS_PER_IMAGE.fal);
    expect(result.estimatedTotalCents).toBe(3 * STILL_IMAGE_PROVIDER_COST_CENTS_PER_IMAGE.fal);
  });

  it("excludes dropped shots from both the count and the total", () => {
    const result = estimateStoryboardCostCents(
      [{ storyboardStatus: "approved" }, { storyboardStatus: "dropped" }, { storyboardStatus: "dropped" }],
      "sogni",
    );
    expect(result.shotCount).toBe(1);
    expect(result.estimatedTotalCents).toBe(STILL_IMAGE_PROVIDER_COST_CENTS_PER_IMAGE.sogni);
  });

  it("returns zero for an empty shot list rather than throwing", () => {
    const result = estimateStoryboardCostCents([], "fal");
    expect(result).toEqual({ shotCount: 0, costPerImageCents: STILL_IMAGE_PROVIDER_COST_CENTS_PER_IMAGE.fal, estimatedTotalCents: 0 });
  });

  it("is a much cheaper per-unit rate than the video price table (the whole point of a storyboard still)", () => {
    expect(STILL_IMAGE_PROVIDER_COST_CENTS_PER_IMAGE.fal).toBeLessThan(10);
    expect(STILL_IMAGE_PROVIDER_COST_CENTS_PER_IMAGE.sogni).toBeLessThan(10);
  });
});

describe("storyboard action validators", () => {
  it("accept an empty body for generate/approve/drop", () => {
    expect(generateStoryboardStillSchema.parse({})).toEqual({});
    expect(approveStoryboardShotSchema.parse({})).toEqual({});
    expect(dropStoryboardShotSchema.parse({})).toEqual({});
  });

  it("reject unknown fields (strict)", () => {
    expect(() => approveStoryboardShotSchema.parse({ nope: 1 })).toThrow();
    expect(() => dropStoryboardShotSchema.parse({ nope: 1 })).toThrow();
  });
});

describe("updateVideoStorylineApprovalThresholdSchema", () => {
  it("accepts a non-negative integer threshold", () => {
    expect(updateVideoStorylineApprovalThresholdSchema.parse({ thresholdCents: 5_000 })).toEqual({ thresholdCents: 5_000 });
  });

  it("accepts null to turn the threshold off", () => {
    expect(updateVideoStorylineApprovalThresholdSchema.parse({ thresholdCents: null })).toEqual({ thresholdCents: null });
  });

  it("rejects a negative threshold", () => {
    expect(() => updateVideoStorylineApprovalThresholdSchema.parse({ thresholdCents: -1 })).toThrow();
  });

  it("rejects a non-integer threshold", () => {
    expect(() => updateVideoStorylineApprovalThresholdSchema.parse({ thresholdCents: 1.5 })).toThrow();
  });
});
