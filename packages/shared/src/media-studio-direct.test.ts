import { describe, expect, it } from "vitest";
import {
  createMediaStudioDirectAudioSchema,
  createMediaStudioDirectPictureSchema,
  createMediaStudioDirectVideoSchema,
  estimateMediaStudioDirectCostCents,
  MEDIA_STUDIO_DIRECT_AUDIO_COST_CENTS_PER_SECOND,
  MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS,
  mediaStudioDirectEstimateSchema,
  mediaStudioDirectRewritePromptSchema,
} from "./media-studio-direct.js";
import { VIDEO_PROVIDER_COST_CENTS_PER_SECOND } from "./video-storylines.js";

describe("estimateMediaStudioDirectCostCents", () => {
  it("quotes a flat per-provider cost for a picture, ignoring durationSeconds", () => {
    const result = estimateMediaStudioDirectCostCents({ kind: "picture", provider: "fal", durationSeconds: 999 });
    expect(result).toEqual({ kind: "picture", provider: "fal", estimatedCostCents: MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal });
  });

  it("reuses the video storylines per-second rate for a video, rounding up", () => {
    const result = estimateMediaStudioDirectCostCents({ kind: "video", provider: "fal", durationSeconds: 5 });
    expect(result.estimatedCostCents).toBe(Math.ceil(5 * VIDEO_PROVIDER_COST_CENTS_PER_SECOND.fal));
  });

  it("uses its own per-second rate for audio", () => {
    const result = estimateMediaStudioDirectCostCents({ kind: "audio", provider: "fal", durationSeconds: 8 });
    expect(result.estimatedCostCents).toBe(Math.ceil(8 * MEDIA_STUDIO_DIRECT_AUDIO_COST_CENTS_PER_SECOND.fal));
  });

  it("never lets a missing or negative duration go below zero (defensive -- schema should already block this)", () => {
    expect(estimateMediaStudioDirectCostCents({ kind: "video", provider: "fal" }).estimatedCostCents).toBe(0);
    expect(estimateMediaStudioDirectCostCents({ kind: "audio", provider: "fal", durationSeconds: -10 }).estimatedCostCents).toBe(0);
  });
});

describe("mediaStudioDirectEstimateSchema", () => {
  it("accepts a bare kind/provider pair", () => {
    const parsed = mediaStudioDirectEstimateSchema.parse({ kind: "picture", provider: "fal" });
    expect(parsed).toEqual({ kind: "picture", provider: "fal" });
  });

  it("rejects unknown fields (strict)", () => {
    expect(() => mediaStudioDirectEstimateSchema.parse({ kind: "picture", provider: "fal", nope: 1 })).toThrow();
  });
});

describe("createMediaStudioDirectPictureSchema", () => {
  it("defaults provider to fal and requires a non-empty prompt", () => {
    const parsed = createMediaStudioDirectPictureSchema.parse({ prompt: "a cat" });
    expect(parsed.provider).toBe("fal");
    expect(() => createMediaStudioDirectPictureSchema.parse({ prompt: "" })).toThrow();
  });

  it("accepts confirmBudgetCapCents as a non-negative integer override", () => {
    const parsed = createMediaStudioDirectPictureSchema.parse({ prompt: "a cat", confirmBudgetCapCents: 500 });
    expect(parsed.confirmBudgetCapCents).toBe(500);
    expect(() => createMediaStudioDirectPictureSchema.parse({ prompt: "a cat", confirmBudgetCapCents: -1 })).toThrow();
  });
});

describe("createMediaStudioDirectVideoSchema", () => {
  it("defaults durationSeconds and rejects a duration past the sync-poll ceiling", () => {
    const parsed = createMediaStudioDirectVideoSchema.parse({ prompt: "a dog running" });
    expect(parsed.durationSeconds).toBe(5);
    expect(() => createMediaStudioDirectVideoSchema.parse({ prompt: "x", durationSeconds: 999 })).toThrow();
  });
});

describe("createMediaStudioDirectAudioSchema", () => {
  it("defaults mode to music and durationSeconds to 8", () => {
    const parsed = createMediaStudioDirectAudioSchema.parse({ prompt: "lofi beat" });
    expect(parsed.mode).toBe("music");
    expect(parsed.durationSeconds).toBe(8);
  });
});

describe("mediaStudioDirectRewritePromptSchema", () => {
  it("requires a non-empty prompt and makes kind optional", () => {
    const parsed = mediaStudioDirectRewritePromptSchema.parse({ prompt: "make it better" });
    expect(parsed.kind).toBeUndefined();
    expect(() => mediaStudioDirectRewritePromptSchema.parse({ prompt: "" })).toThrow();
  });
});
