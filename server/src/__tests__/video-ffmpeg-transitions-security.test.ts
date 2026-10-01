import { describe, expect, it } from "vitest";
import {
  buildMusicBedFilterComplex,
  buildXfadeFilterComplex,
  clampMusicVolumeDb,
  clampTransitionDurationMs,
  isXfadeTransition,
} from "../services/video-ffmpeg.js";

/**
 * DUR-4196: the ticket's required "ffmpeg argument injection tests
 * (security)" -- exercised here as pure unit tests against the exact
 * string-building functions that feed `-filter_complex`, since this sandbox
 * has no ffmpeg binary to run an end-to-end stitch against (see
 * video-storyline-stitch-service.test.ts's doc comment). Every value these
 * functions embed is either a hardcoded allow-listed transition name or a
 * number formatted by our own toFixed/template -- never a caller string --
 * so there is no code path from a shot prompt/title into the filter graph.
 */

describe("isXfadeTransition", () => {
  it("accepts only the two allow-listed transition names", () => {
    expect(isXfadeTransition("fade")).toBe(true);
    expect(isXfadeTransition("dissolve")).toBe(true);
  });

  it("rejects anything else, including shell/filter metacharacters", () => {
    for (const candidate of ["cut", "", "fade;rm -rf /", "fade]; drawtext=text=pwned", "wipeleft", "FADE", "fade\nacrossfade"]) {
      expect(isXfadeTransition(candidate)).toBe(false);
    }
  });
});

describe("clampTransitionDurationMs", () => {
  it("clamps to the 0-5000ms range", () => {
    expect(clampTransitionDurationMs(-100)).toBe(0);
    expect(clampTransitionDurationMs(500)).toBe(500);
    expect(clampTransitionDurationMs(999_999)).toBe(5_000);
  });

  it("never lets NaN/Infinity through", () => {
    expect(clampTransitionDurationMs(Number.NaN)).toBe(0);
    expect(clampTransitionDurationMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampTransitionDurationMs(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("clampMusicVolumeDb", () => {
  it("clamps to the -60..0 dB range", () => {
    expect(clampMusicVolumeDb(-1000)).toBe(-60);
    expect(clampMusicVolumeDb(-18)).toBe(-18);
    expect(clampMusicVolumeDb(100)).toBe(0);
  });

  it("never lets NaN/Infinity through", () => {
    expect(clampMusicVolumeDb(Number.NaN)).toBe(0);
    expect(clampMusicVolumeDb(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("buildXfadeFilterComplex", () => {
  it("throws rather than building a filter string for a non-allow-listed transition", () => {
    expect(() =>
      // @ts-expect-error -- intentionally passing an invalid value to prove the runtime guard, not just the type guard.
      buildXfadeFilterComplex({ transition: "fade;drawtext=text=pwned", durationSeconds: 1, offsetSeconds: 0, includeAudio: false }),
    ).toThrow(/Unsupported transition/);
  });

  it("formats duration/offset as fixed-precision numbers, never raw caller input", () => {
    const filter = buildXfadeFilterComplex({ transition: "fade", durationSeconds: 0.5, offsetSeconds: 3, includeAudio: false });
    expect(filter).toBe("[0:v][1:v]xfade=transition=fade:duration=0.500:offset=3.000[v]");
  });

  it("clamps an out-of-range duration into ffmpeg's own sane bounds (0.1-5s) even though callers should already clamp ms upstream", () => {
    const tooLong = buildXfadeFilterComplex({ transition: "dissolve", durationSeconds: 999, offsetSeconds: 0, includeAudio: false });
    expect(tooLong).toContain("duration=5.000");
    const tooShort = buildXfadeFilterComplex({ transition: "dissolve", durationSeconds: -5, offsetSeconds: 0, includeAudio: false });
    expect(tooShort).toContain("duration=0.100");
  });

  it("never lets a negative offset through", () => {
    const filter = buildXfadeFilterComplex({ transition: "fade", durationSeconds: 1, offsetSeconds: -50, includeAudio: false });
    expect(filter).toContain("offset=0.000");
  });

  it("appends an acrossfade clause only when both clips have audio", () => {
    const withAudio = buildXfadeFilterComplex({ transition: "fade", durationSeconds: 1, offsetSeconds: 2, includeAudio: true });
    expect(withAudio).toContain("acrossfade");
    const withoutAudio = buildXfadeFilterComplex({ transition: "fade", durationSeconds: 1, offsetSeconds: 2, includeAudio: false });
    expect(withoutAudio).not.toContain("acrossfade");
  });

  it("contains no characters that could terminate or chain past the filter_complex argument", () => {
    const filter = buildXfadeFilterComplex({ transition: "dissolve", durationSeconds: 1.2345, offsetSeconds: 7.891, includeAudio: true });
    expect(filter).not.toMatch(/[`$"'\\\n]/);
  });
});

describe("buildMusicBedFilterComplex", () => {
  it("clamps volume and formats duration as a fixed-precision number", () => {
    const filter = buildMusicBedFilterComplex({ volumeDb: -500, videoDurationSeconds: 12.5, hasExistingAudio: false });
    expect(filter).toBe("[1:a]volume=-60dB,atrim=0:12.500[music]");
  });

  it("adds an amix clause only when the stitched film already has audio", () => {
    const withAudio = buildMusicBedFilterComplex({ volumeDb: -18, videoDurationSeconds: 10, hasExistingAudio: true });
    expect(withAudio).toContain("amix");
    const withoutAudio = buildMusicBedFilterComplex({ volumeDb: -18, videoDurationSeconds: 10, hasExistingAudio: false });
    expect(withoutAudio).not.toContain("amix");
  });

  it("never lets a negative duration through", () => {
    const filter = buildMusicBedFilterComplex({ volumeDb: -18, videoDurationSeconds: -5, hasExistingAudio: false });
    expect(filter).toContain("atrim=0:0.000");
  });

  it("contains no characters that could terminate or chain past the filter_complex argument", () => {
    const filter = buildMusicBedFilterComplex({ volumeDb: -1000, videoDurationSeconds: 999.999, hasExistingAudio: true });
    expect(filter).not.toMatch(/[`$"'\\\n]/);
  });
});
