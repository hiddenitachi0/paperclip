import { describe, expect, it } from "vitest";
import {
  VIDEO_SCRIPT_MAX_REPORTED_ERRORS,
  VIDEO_STORYLINE_SCRIPT_EXAMPLE,
  VIDEO_STORYLINE_SCRIPT_INSTRUCTIONS,
  formatVideoScriptCharacters,
  importVideoStorylineScriptSchema,
  validateVideoStorylineScript,
} from "./video-storyline-script.js";
import { estimateVideoStorylineCostCents, videoRenderDurationSeconds } from "./video-storylines.js";

describe("validateVideoStorylineScript", () => {
  it("accepts the published example and maps it to server field names", () => {
    const result = validateVideoStorylineScript(VIDEO_STORYLINE_SCRIPT_EXAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.script.sceneCount).toBe(2);
    expect(result.script.shotCount).toBe(3);
    expect(result.script.totalSeconds).toBe(20);
    expect(result.script.characters.map((c) => c.name)).toEqual(["Ada", "Bo"]);
    expect(result.script.scenes[0]!.shots[0]).toMatchObject({ cameraNotes: "Slow push-in from the sea toward the cliff.", durationSeconds: 5, transitionIn: "fade" });
  });

  it("fills defaults for optional shot fields", () => {
    const result = validateVideoStorylineScript({ scenes: [{ scene_title: "One", shots: [{ prompt: "  a cat  " }] }] });
    expect(result).toEqual({
      ok: true,
      script: {
        title: null,
        characters: [],
        scenes: [{ title: "One", notes: null, shots: [{ prompt: "a cat", cameraNotes: null, durationSeconds: 5, transitionIn: null }] }],
        sceneCount: 1,
        shotCount: 1,
        totalSeconds: 5,
      },
    });
  });

  it("reports plain, numbered problems per scene and shot", () => {
    const result = validateVideoStorylineScript({
      title: 5,
      characters: { Mia: "" },
      scenes: [
        { scene_title: "ok", shots: [] },
        { shots: [{ prompt: "" }, { prompt: "x".repeat(4001), duration_seconds: 2.5, transition_in: "wipe" }] },
      ],
      extra: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      'Unknown field "extra" at the top of the script (allowed: title, characters, scenes).',
      "title must be text.",
      'Character "Mia": the description must be non-empty text.',
      'Scene 1: needs a "shots" list with at least one shot.',
      "Scene 2: scene_title is missing.",
      "Scene 2, shot 1: prompt is missing or empty.",
      "Scene 2, shot 2: prompt is longer than 4,000 characters.",
      "Scene 2, shot 2: duration_seconds must be a whole number of seconds.",
      "Scene 2, shot 2: transition_in must be one of cut, fade, dissolve.",
    ]);
  });

  it("refuses a non-object and an empty scene list", () => {
    expect(validateVideoStorylineScript("[]")).toEqual({ ok: false, errors: ['The script must be a JSON object with a "scenes" list.'] });
    const empty = validateVideoStorylineScript({ scenes: [] });
    expect(empty.ok).toBe(false);
  });

  it("caps the number of reported problems", () => {
    const shots = Array.from({ length: VIDEO_SCRIPT_MAX_REPORTED_ERRORS + 10 }, () => ({ prompt: "" }));
    const result = validateVideoStorylineScript({ scenes: [{ scene_title: "s", shots }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(VIDEO_SCRIPT_MAX_REPORTED_ERRORS + 1);
    expect(result.errors.at(-1)).toBe("...and 10 more problem(s).");
  });

  it("formats the character sheet stored with the first scene", () => {
    expect(formatVideoScriptCharacters([])).toBeNull();
    expect(formatVideoScriptCharacters([{ name: "Ada", description: "silver hair" }])).toBe("Characters:\n- Ada: silver hair");
  });
});

describe("import request schema", () => {
  it("defaults to append and requires a script", () => {
    expect(importVideoStorylineScriptSchema.parse({ script: {} })).toEqual({ mode: "append", script: {}, dryRun: false });
    expect(() => importVideoStorylineScriptSchema.parse({ mode: "append" })).toThrow();
    expect(() => importVideoStorylineScriptSchema.parse({ mode: "merge", script: {} })).toThrow();
  });
});

describe("clip lengths", () => {
  it("snaps Fal's Kling models to 5 or 10 seconds and leaves other models alone", () => {
    expect([1, 3, 5, 6, 10, 12, 60].map((s) => videoRenderDurationSeconds("fal", null, s))).toEqual([5, 5, 5, 10, 10, 10, 10]);
    // Kling 3.0 takes any whole length from 3 to 15 seconds (Phase 0 fix: it used to be snapped to 5/10).
    expect(videoRenderDurationSeconds("fal", "fal-ai/kling-video/v3/pro/image-to-video", 7)).toBe(7);
    expect(videoRenderDurationSeconds("fal", "fal-ai/kling-video/v3/standard/image-to-video", 1)).toBe(3);
    expect(videoRenderDurationSeconds("fal", "fal-ai/kling-video/v3/standard/image-to-video", 20)).toBe(15);
    expect(videoRenderDurationSeconds("fal", "fal-ai/kling-video/v2.1/pro/image-to-video", 7)).toBe(10);
    expect(videoRenderDurationSeconds("fal", "fal-ai/some-other-model", 7)).toBe(7);
    expect(videoRenderDurationSeconds("sogni", null, 7)).toBe(7);
  });

  it("estimates billed seconds only when the model is given", () => {
    expect(estimateVideoStorylineCostCents([{ durationSeconds: 7 }], "fal").totalSeconds).toBe(7);
    expect(estimateVideoStorylineCostCents([{ durationSeconds: 7 }], "fal", { model: null }).totalSeconds).toBe(10);
  });

  it("puts the real clip lengths and the JSON-only rule in the writer instructions", () => {
    expect(VIDEO_STORYLINE_SCRIPT_INSTRUCTIONS).toContain("5 or 10 seconds");
    expect(VIDEO_STORYLINE_SCRIPT_INSTRUCTIONS).toContain("Return **JSON only**");
    expect(VIDEO_STORYLINE_SCRIPT_INSTRUCTIONS).toContain('"scene_title"');
  });
});
