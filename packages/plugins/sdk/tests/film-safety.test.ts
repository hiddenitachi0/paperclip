import { describe, expect, it } from "vitest";
import {
  FAL_STRICTEST_SAFETY_TOLERANCE,
  FalFlaggedError,
  SAFE_FOR_WORK_AVOID,
  applyLoraRules,
  falFlaggedUsage,
  falResultFlagged,
  falSafetyFields,
  isFalFlaggedError,
  personalLoraNeedsFilterOff,
  readContentMode,
  withSfwNegativePrompt,
  withSfwPositiveWords,
  withSfwPromptWords,
  type SogniLoraInfo,
} from "../src/media/index.js";

function info(id: string, over: Partial<SogniLoraInfo> = {}): SogniLoraInfo {
  return {
    id,
    name: `Name of ${id}`,
    description: "",
    category: "style",
    personal: false,
    modelIds: [],
    min: 0,
    max: 1,
    default: 1,
    step: 0.1,
    recommendedMin: 0,
    recommendedMax: 1,
    rangeLabels: null,
    needsFilterOff: false,
    sexual: false,
    creator: null,
    sourceUrl: null,
    ...over,
  };
}

describe("film safety: rating", () => {
  it("reads anything but exactly 'mature' as sfw", () => {
    expect(readContentMode("mature")).toBe("mature");
    for (const v of ["sfw", "MATURE", "", null, undefined, 1, {}]) expect(readContentMode(v)).toBe("sfw");
  });
});

describe("film safety: SFW words", () => {
  it("adds 'Fully clothed.' and the avoid list once", () => {
    const once = withSfwPromptWords("A woman on a beach");
    expect(once).toContain("Fully clothed.");
    expect(once).toContain(SAFE_FOR_WORK_AVOID);
    expect(withSfwPromptWords(once)).toBe(once);
  });
  it("positive words alone, and the negative prompt only when it fits", () => {
    expect(withSfwPositiveWords("x")).toContain("Fully clothed.");
    expect(withSfwNegativePrompt("blurry", 1000)).toBe(`blurry, ${SAFE_FOR_WORK_AVOID}`);
    expect(withSfwNegativePrompt(null, 1000)).toBe(SAFE_FOR_WORK_AVOID);
    expect(withSfwNegativePrompt("x".repeat(990), 1000)).toBeNull();
  });
});

describe("film safety: LoRA rules", () => {
  const known = [info("krea2-realism"), info("krea2-breast", { category: "slider" }), info("krea2-filter-bypass-3"), info("personal-1", { personal: true, needsFilterOff: true }), info("personal-2", { personal: true })];
  const picks = (...ids: string[]) => ids.map((id) => ({ id, strength: 0.5 }));

  it("refuses a filter-bypass LoRA in SFW and in mature films", () => {
    for (const mode of ["sfw", "mature"] as const) {
      const r = applyLoraRules(picks("krea2-realism", "krea2-filter-bypass-3"), mode, known);
      expect(r.refused.map((x) => x.id)).toEqual(["krea2-filter-bypass-3"]);
      expect(r.kept.map((x) => x.id)).toEqual(["krea2-realism"]);
    }
  });
  it("refuses a bypass LoRA by name even when the catalog could not be read", () => {
    expect(applyLoraRules(picks("krea2-filter-bypass-9"), "mature", null).refused).toHaveLength(1);
  });
  it("drops an anatomy slider in SFW with a note, and keeps it in a mature film", () => {
    const sfw = applyLoraRules(picks("krea2-realism", "krea2-breast"), "sfw", known);
    expect(sfw.kept.map((x) => x.id)).toEqual(["krea2-realism"]);
    expect(sfw.dropped.map((x) => x.reason)).toEqual(["anatomy-slider"]);
    expect(sfw.notes[0]).toMatch(/left out/);
    expect(applyLoraRules(picks("krea2-breast"), "mature", known).kept).toHaveLength(1);
  });
  it("drops a LoRA Sogni flags and an unreviewed one in SFW", () => {
    const r = applyLoraRules(picks("personal-1", "krea2-brand-new"), "sfw", known);
    expect(r.dropped.map((x) => x.reason)).toEqual(["nsfw-flag", "unreviewed"]);
    expect(r.kept).toEqual([]);
  });
  it("keeps the account's own LoRA when Sogni does not flag it, and reads the per-LoRA flag", () => {
    expect(applyLoraRules(picks("personal-2"), "sfw", known).kept).toHaveLength(1);
    expect(personalLoraNeedsFilterOff(known[3])).toBe(true);
    expect(personalLoraNeedsFilterOff(known[4])).toBe(false);
    expect(personalLoraNeedsFilterOff(null)).toBe(true);
  });
});

describe("film safety: Fal fields", () => {
  it("puts the input check on every request", () => {
    for (const m of ["fal-ai/flux/schnell", "fal-ai/kling-video/v3/pro/image-to-video", "fal-ai/flux-pro/kontext/multi"]) {
      expect(falSafetyFields(m)).toEqual({ enable_safety_checker: true });
    }
  });
  it("adds the output check on the Wan endpoints, which default both checks off", () => {
    for (const m of ["fal-ai/wan-i2v-lora", "fal-ai/wan-flf2v", "fal-ai/wan/v2.2-a14b/text-to-video/lora", "fal-ai/wan/v2.2-a14b/image-to-video", "fal-ai/wan-t2v"]) {
      expect(falSafetyFields(m)).toEqual({ enable_safety_checker: true, enable_output_safety_checker: true });
    }
  });
  it("gives Veo 3.1 the strictest safety_tolerance", () => {
    expect(falSafetyFields("fal-ai/veo3.1/image-to-video")).toMatchObject({ enable_safety_checker: true, safety_tolerance: FAL_STRICTEST_SAFETY_TOLERANCE });
    expect(falSafetyFields("fal-ai/veo3")).toMatchObject({ safety_tolerance: "1" });
  });
  it("reads has_nsfw_concepts as a flag or a list", () => {
    expect(falResultFlagged({ has_nsfw_concepts: [false, true] })).toBe(true);
    expect(falResultFlagged({ has_nsfw_concepts: true })).toBe(true);
    expect(falResultFlagged({ has_nsfw_concepts: [false] })).toBe(false);
    expect(falResultFlagged({ images: [] })).toBe(false);
    expect(falResultFlagged(null)).toBe(false);
  });
  it("a flagged picture is a typed error that carries the model and usage, so its cost can be recorded", () => {
    const err = new FalFlaggedError("fal-ai/flux/schnell", falFlaggedUsage({ images: [{ width: 1000, height: 1000 }, { width: 1000, height: 500 }] }));
    expect(isFalFlaggedError(err)).toBe(true);
    expect(err).toMatchObject({ model: "fal-ai/flux/schnell", usage: { images: 2, megapixels: 1.5 }, message: expect.stringContaining("safety check flagged") });
    // By shape too, so a second copy of this module still matches; ordinary errors do not.
    expect(isFalFlaggedError({ falFlagged: true, model: "m", usage: { images: 1 } })).toBe(true);
    expect(isFalFlaggedError(new Error("nope"))).toBe(false);
    expect(isFalFlaggedError(null)).toBe(false);
  });
  it("counts at least one picture, and gives a size only when every picture has one", () => {
    expect(falFlaggedUsage({})).toEqual({ images: 1 });
    expect(falFlaggedUsage({ images: [{ width: 1000, height: 1000 }, {}] })).toEqual({ images: 2 });
  });
});
