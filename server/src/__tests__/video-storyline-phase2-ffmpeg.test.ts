import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  addMusicBed,
  addMusicBedToFile,
  assertFilterSafePath,
  buildFitFilter,
  buildMusicLaneFilterComplex,
  buildStillClipArgs,
  buildTitleCardArgs,
  buildTrimClipArgs,
  buildUploadTranscodeArgs,
  checkFfmpegAvailable,
  concatListLine,
  fitInside,
  isHdrMedia,
  isVariableFrameRate,
  normalizeClipFilesForStitch,
  normalizeClipsForStitch,
  normalizeLoudnessFile,
  prepareTrimmedClip,
  processUploadedVideo,
  processUploadedVideoFile,
  readProbeJson,
  renderStillClip,
  renderTitleCard,
  sniffAudioContainer,
  sniffVideoContainer,
  stitchClipFiles,
  stitchClipFilesWithTransitions,
  untrustedInputArgs,
  wrapTitleText,
  type ProbedMedia,
} from "../services/video-ffmpeg.ts";
import { cleanVideoTitleText, readVideoExportSettings, videoCropLossPercent } from "@paperclipai/shared";

/**
 * Storyline Simple editor, Phase 2: ffmpeg command building (argument arrays
 * only, no user text in a filter graph), the HDR/VFR upload fix, crop-fill
 * vs letterbox, the music lane and title cards -- the pure builders always,
 * and the real thing when ffmpeg is installed.
 */

const ffmpeg = await checkFfmpegAvailable(true);
const real = ffmpeg ? describe : describe.skip;
const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-phase2-ffmpeg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NASTY = `It's 100% "fun": %{pts} %{localtime} ; [out] , \\ 'quote' $(rm -rf /) \`id\``;

const media = (over: Partial<ProbedMedia> = {}): ProbedMedia => ({
  width: 1920,
  height: 1080,
  durationSeconds: 10,
  nominalFps: 30,
  averageFps: 30,
  colorTransfer: "bt709",
  hasDolbyVision: false,
  hasAudio: true,
  rotation: 0,
  ...over,
});

describe("fill vs fit", () => {
  it("crop-fills a small size mismatch (1280x704 into 1280x720) instead of letterboxing", () => {
    expect(buildFitFilter({ width: 1280, height: 704 }, { width: 1280, height: 720 }, "fit")).toBe("scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720");
  });
  it("letterboxes only a real shape mismatch under Fit, and always crops under Fill", () => {
    expect(buildFitFilter({ width: 1080, height: 1920 }, { width: 1920, height: 1080 }, "fit")).toContain("pad=1920:1080");
    expect(buildFitFilter({ width: 1080, height: 1920 }, { width: 1920, height: 1080 }, "fill")).toContain("crop=1920:1080");
  });
  it("says how much a 16:9 to 9:16 crop throws away", () => {
    expect(videoCropLossPercent({ width: 1920, height: 1080 }, { width: 1080, height: 1920 })).toBe(68);
    expect(videoCropLossPercent({ width: 1080, height: 1080 }, { width: 1080, height: 1080 })).toBe(0);
  });
});

describe("export settings", () => {
  it("reads stored settings strictly with defaults per shape", () => {
    expect(readVideoExportSettings({}, "9:16")).toMatchObject({ preset: "reels_9_16", fps: 30, fit: "fit", endFrame: "keep", quality: "standard", opening: null, credits: null });
    expect(readVideoExportSettings({ preset: "nope", fps: 31, fit: "stretch", quality: "ultra" }, "16:9")).toMatchObject({ preset: "youtube_16_9", fps: 30, fit: "fit", quality: "standard" });
    expect(readVideoExportSettings({ fps: 16, fit: "fill", endFrame: "trim", quality: "high", opening: { text: "Hi", seconds: 99 } }, "1:1")).toMatchObject({
      preset: "square_1_1",
      fps: 16,
      fit: "fill",
      endFrame: "trim",
      quality: "high",
      opening: { text: "Hi", seconds: 15 },
    });
  });
  it("cleans title text of control characters (credits keep their line breaks)", () => {
    expect(cleanVideoTitleText("A\u0000B\u001b[31mC\nD", false, 200)).toBe("A B [31mC D");
    expect(cleanVideoTitleText("Cast\n\u0007Anna\nBen", true, 200)).toBe("Cast\nAnna\nBen");
  });
});

describe("upload probe and conversion arguments", () => {
  it("spots HDR phone video (HLG, PQ and Dolby Vision) and variable frame rate", () => {
    const hlg = readProbeJson({
      streams: [{ codec_type: "video", width: 1920, height: 1080, r_frame_rate: "30/1", avg_frame_rate: "2997/100", color_transfer: "arib-std-b67", side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] }, { codec_type: "audio" }],
      format: { duration: "4.5" },
    })!;
    expect(hlg).toMatchObject({ width: 1920, height: 1080, durationSeconds: 4.5, rotation: -90, hasAudio: true });
    expect(isHdrMedia(hlg)).toBe(true);
    expect(isVariableFrameRate(hlg)).toBe(false);
    const dv = readProbeJson({ streams: [{ codec_type: "video", width: 10, height: 10, r_frame_rate: "600/1", avg_frame_rate: "30/1", side_data_list: [{ side_data_type: "DOVI configuration record" }] }] })!;
    expect(isHdrMedia(dv)).toBe(true);
    expect(isVariableFrameRate(dv)).toBe(true);
    expect(isVariableFrameRate({ nominalFps: 30, averageFps: 27.1 })).toBe(true);
    expect(readProbeJson({ streams: [{ codec_type: "audio" }] })).toBeNull();
  });

  it("tone-maps HDR to normal colour, forces the storyline's constant frame rate, drops metadata, and turns portrait phones upright", () => {
    const args = buildUploadTranscodeArgs({ input: "/tmp/x/in", output: "/tmp/x/out.mp4", media: media({ width: 3840, height: 2160, rotation: 90, colorTransfer: "arib-std-b67" }), fps: 25, toneMap: true });
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toContain("tonemap=tonemap=hable");
    expect(vf).toContain("fps=25");
    expect(vf).toContain("scale=1080:1920");
    expect(args).toEqual(expect.arrayContaining(["-fps_mode", "cfr", "-r", "25", "-map_metadata", "-1", "-color_trc", "bt709"]));
    expect(buildUploadTranscodeArgs({ input: "a", output: "b", media: media(), fps: 30, toneMap: false }).join(" ")).not.toContain("tonemap");
    expect(fitInside(640, 480, 0, 1920)).toEqual({ width: 640, height: 480 });
  });

  it("cuts a clip with numbers only and makes photos into a held or slowly zooming clip", () => {
    expect(buildTrimClipArgs({ input: "in", output: "out", startMs: 1500, durationMs: 2250 })).toEqual(expect.arrayContaining(["-ss", "1.500", "-t", "2.250"]));
    const zoom = buildStillClipArgs({ input: "p.jpg", output: "o.mp4", seconds: 2, motion: "slow_zoom", source: { width: 4000, height: 3000 }, target: { width: 1920, height: 1080, fps: 24, fit: "fit" } });
    expect(zoom).toEqual(expect.arrayContaining(["-frames:v", "48"]));
    expect(zoom.join(" ")).toContain("zoompan=z='min(1+0.12*on/48,1.12)'");
    const hold = buildStillClipArgs({ input: "p.jpg", output: "o.mp4", seconds: 3, motion: "hold", source: { width: 1080, height: 1920 }, target: { width: 1920, height: 1080, fps: 30, fit: "fit" } });
    expect(hold).toEqual(expect.arrayContaining(["-loop", "1", "-t", "3"]));
  });
});

describe("untrusted uploads are identified by their bytes (security review DUR-4745)", () => {
  it("sniffs video and audio containers and refuses playlists and text", () => {
    const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypqt  0000")]);
    expect(sniffVideoContainer(ftyp)).toBe("mov");
    expect(sniffVideoContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("matroska");
    expect(sniffVideoContainer(Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n"))).toBeNull();
    expect(sniffVideoContainer(Buffer.from("ffconcat version 1.0\nfile /etc/passwd"))).toBeNull();
    expect(sniffAudioContainer(Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000"))).toBe("mp3");
    expect(sniffAudioContainer(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]))).toBe("wav");
    expect(sniffAudioContainer(Buffer.from("#EXTM3U\nhttp://evil/x.mp3\n"))).toBeNull();
  });
  it("opens untrusted files with local files only and the sniffed container", () => {
    expect(untrustedInputArgs("mov")).toEqual(["-protocol_whitelist", "file", "-f", "mov"]);
    const args = buildUploadTranscodeArgs({ input: "in", output: "out", media: media(), fps: 30, toneMap: false, inputFormat: "matroska" });
    expect(args.slice(0, 7)).toEqual(["-y", "-protocol_whitelist", "file", "-f", "matroska", "-i", "in"]);
  });
});

describe("title cards never put user text into the filter graph", () => {
  it("reads the text from a file with expansion off", () => {
    const args = buildTitleCardArgs({ textFile: "/tmp/paperclip-video-storyline-abc123/title.txt", output: "/tmp/o.mp4", seconds: 3, kind: "opening", target: { width: 1920, height: 1080, fps: 30 }, fontFile: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" });
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toContain("drawtext=textfile=/tmp/paperclip-video-storyline-abc123/title.txt:expansion=none");
    expect(args.join("\u0001")).not.toContain("fun");
  });
  it("refuses a path that would need escaping inside a filter graph", () => {
    for (const bad of ["/tmp/a:b.txt", "/tmp/a'b.txt", "/tmp/a,b", "/tmp/[x]", "/tmp/../etc/passwd", "/tmp/a b"]) {
      expect(() => assertFilterSafePath(bad)).toThrow();
    }
    expect(() => buildTitleCardArgs({ textFile: "/tmp/t.txt", output: "o", seconds: 2, kind: "credits", target: { width: 100, height: 100, fps: 30 }, fontFile: "/x/y:z.ttf" })).toThrow();
  });
  it("wraps long lines and cuts words that are too long", () => {
    expect(wrapTitleText("one two three four", 9)).toBe("one two\nthree\nfour");
    expect(wrapTitleText("abcdefghijklmnop", 8)).toBe("abcdefgh\nijklmnop");
  });
});

describe("music lane filter", () => {
  it("trims, loops when short, delays to the start offset, fades and mixes (numbers only)", () => {
    const { filter, output } = buildMusicLaneFilterComplex({
      volumeDb: -12,
      videoDurationSeconds: 30,
      musicDurationSeconds: 20,
      hasExistingAudio: true,
      trimInMs: 2_000,
      trimOutMs: 12_000,
      offsetMs: 5_000,
      fadeInMs: 1_000,
      fadeOutMs: 2_000,
      mode: "mix",
    });
    expect(output).toBe("[aout]");
    expect(filter).toContain("atrim=start=2.000:end=12.000");
    expect(filter).toContain("aloop=loop=-1:size=480000");
    expect(filter).toContain("atrim=0:25.000");
    expect(filter).toContain("afade=t=in:st=0:d=1.000");
    expect(filter).toContain("afade=t=out:st=23.000:d=2.000");
    expect(filter).toContain("volume=-12dB");
    expect(filter).toContain("adelay=delays=5000:all=1");
    expect(filter).toContain("amix=inputs=2:duration=first:dropout_transition=0:normalize=0");
  });
  it("replaces the clips' sound when asked, and clamps nonsense", () => {
    const replace = buildMusicLaneFilterComplex({ volumeDb: 40, videoDurationSeconds: 10, musicDurationSeconds: 60, hasExistingAudio: true, trimOutMs: -5, offsetMs: Number.NaN, mode: "replace" });
    expect(replace.output).toBe("[music]");
    expect(replace.filter).not.toContain("amix");
    expect(replace.filter).not.toContain("aloop");
    expect(replace.filter).toContain("volume=0dB");
    expect(replace.filter).not.toMatch(/NaN|Infinity/);
  });
});

real("real ffmpeg: trim, fps, crop-fill, drawtext, HDR/VFR upload, photo clips, music lane", () => {
  function make(name: string, args: string[]): Buffer {
    const out = path.join(dir, name);
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args, out]);
    return readFileSync(out);
  }
  function probe(buffer: Buffer, entries: string): string {
    const file = path.join(dir, `p-${Math.random().toString(36).slice(2)}.mp4`);
    writeFileSync(file, buffer);
    return execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", entries, "-of", "csv=p=0", file]).toString().trim();
  }
  function duration(buffer: Buffer): number {
    const file = path.join(dir, `d-${Math.random().toString(36).slice(2)}.mp4`);
    writeFileSync(file, buffer);
    return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
  }
  /** Mean brightness of the first frame's top row (0 = black bar). */
  function topRowMean(buffer: Buffer): number {
    const file = path.join(dir, `r-${Math.random().toString(36).slice(2)}.mp4`);
    writeFileSync(file, buffer);
    const raw = execFileSync("ffmpeg", ["-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", "crop=iw:2:0:0,format=gray", "-f", "rawvideo", "-"]);
    return raw.reduce((sum, v) => sum + v, 0) / raw.length;
  }
  const testsrc = (size: string, seconds: number, audio = false) =>
    make(`src-${size}-${seconds}-${audio}.mp4`, [
      "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30`,
      ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000"] : []),
      "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", ...(audio ? ["-c:a", "aac", "-shortest"] : []),
    ]);

  it("cuts a clip to its trim", async () => {
    const clip = await prepareTrimmedClip(testsrc("320x180", 4, true), 1_000, 1_500);
    expect(duration(clip)).toBeGreaterThan(1.3);
    expect(duration(clip)).toBeLessThan(1.7);
  });

  it("assembles at the chosen fps and size, crop-filling a near-match and letterboxing a portrait clip", async () => {
    const near = testsrc("320x176", 1);
    const portrait = testsrc("180x320", 1);
    const out = await normalizeClipsForStitch([near, portrait], [], { width: 320, height: 180, fps: 24, fit: "fit", quality: "standard" });
    expect(probe(out.buffers[0]!, "stream=width,height,r_frame_rate")).toBe("320,180,24/1");
    expect(topRowMean(out.buffers[0]!)).toBeGreaterThan(20); // no bar
    const left = execFileSync("ffmpeg", ["-loglevel", "error", "-i", (writeFileSync(path.join(dir, "pt.mp4"), out.buffers[1]!), path.join(dir, "pt.mp4")), "-frames:v", "1", "-vf", "crop=10:ih:0:0,format=gray", "-f", "rawvideo", "-"]);
    expect(left.reduce((s, v) => s + v, 0) / left.length).toBeLessThan(25); // bars at the side
  });

  it("draws a title card from text that would break a filter graph", async () => {
    const card = await renderTitleCard(NASTY, { seconds: 2, kind: "opening", target: { width: 640, height: 360, fps: 25 } });
    expect(duration(card)).toBeGreaterThan(1.8);
    expect(probe(card, "stream=width,height")).toBe("640,360");
    const credits = await renderTitleCard("Directed by Anna\nMusic: Ben\n%{eif:1/0:d}", { seconds: 2, kind: "credits", target: { width: 360, height: 640, fps: 30 } });
    expect(duration(credits)).toBeGreaterThan(1.8);
  });

  it("turns an HLG, variable-frame-rate phone video into normal colour at a constant storyline fps", async () => {
    const hdr = make("hlg-vfr.mp4", [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-t", "2",
      "-vf", "setpts='if(lt(N,30),N/30,1+(N-30)/15)/TB',setparams=color_trc=arib-std-b67:color_primaries=bt2020:colorspace=bt2020nc", "-fps_mode", "vfr",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]);
    const out = await processUploadedVideo(hdr, { fps: 25, maxSeconds: 60 });
    expect(out.wasHdr).toBe(true);
    expect(out.working.length).toBeGreaterThan(1000);
    expect(probe(out.working, "stream=r_frame_rate,avg_frame_rate,color_transfer").split(",").sort()).toEqual(["25/1", "25/1", "bt709"]);
    expect(out.wasVariableFrameRate).toBe(true);
    expect(out.preview.length).toBeGreaterThan(500);
    expect(out.poster.subarray(0, 2).toString("hex")).toBe("ffd8");
    await expect(processUploadedVideo(hdr, { fps: 25, maxSeconds: 1 })).rejects.toThrow(/allows up to 1 seconds/);
    await expect(processUploadedVideo(Buffer.from("not a video at all"), { fps: 25, maxSeconds: 60 })).rejects.toThrow(/not a video this server can use/);
    // A playlist dressed up as .mp4 never reaches ffmpeg (security review DUR-4745).
    await expect(processUploadedVideo(Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\nfile:///etc/passwd\n"), { fps: 25, maxSeconds: 60 })).rejects.toThrow(/not a video this server can use/);
  });

  it("makes a slowly zooming photo clip of the right length", async () => {
    const photo = make("photo.jpg", ["-f", "lavfi", "-i", "testsrc2=size=400x300", "-frames:v", "1"]);
    const clip = await renderStillClip(photo, { seconds: 2, motion: "slow_zoom", source: { width: 400, height: 300 }, target: { width: 320, height: 180, fps: 24, fit: "fit" } });
    expect(probe(clip, "stream=width,height,nb_frames")).toBe("320,180,48");
  });

  it("lays trimmed, delayed music under the film, or in place of its sound", async () => {
    const film = testsrc("160x120", 3, true);
    const music = make("music.m4a", ["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100", "-t", "1", "-c:a", "aac"]);
    for (const mode of ["mix", "replace"] as const) {
      const out = await addMusicBed({ buffer: film, contentType: "video/mp4" }, { buffer: music, volumeDb: -6, trimInMs: 200, trimOutMs: 800, offsetMs: 500, fadeInMs: 100, fadeOutMs: 300, mode });
      expect(duration(out.buffer)).toBeGreaterThan(2.8);
      expect(duration(out.buffer)).toBeLessThan(3.3);
    }
  });
});

describe("D18: file-based film making", () => {
  it("writes concat list lines that keep a quote in a work-folder path inside its quotes", () => {
    expect(concatListLine("/tmp/work/norm-000001.mp4")).toBe("file '/tmp/work/norm-000001.mp4'");
    expect(concatListLine("/data/Anna's work/a.mp4")).toBe("file '/data/Anna'\\''s work/a.mp4'");
  });
});

real("D18 real ffmpeg: a film made file to file", () => {
  const clipFile = (name: string, seconds: number) => {
    const out = path.join(dir, name);
    execFileSync("ffmpeg", [
      "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out,
    ]);
    return out;
  };
  const seconds = (file: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());

  it("normalizes, joins cuts and a crossfade, adds music and evens the sound without leaving in-between files", async () => {
    const work = mkdtempSync(path.join(os.tmpdir(), "paperclip-d18-film-"));
    try {
      const raw = [clipFile("d18-a.mp4", 2), clipFile("d18-b.mp4", 2), clipFile("d18-c.mp4", 2)];
      const normalized = await normalizeClipFilesForStitch(raw, [], { width: 160, height: 120, fps: 25, fit: "fit", quality: "standard" }, work);
      expect(normalized.paths).toHaveLength(3);
      expect(normalized.durationsSeconds.every((s) => s > 1.8 && s < 2.3)).toBe(true);

      const film = await stitchClipFilesWithTransitions(
        [
          { path: normalized.paths[0]!, transitionIn: "cut", transitionDurationMs: 0 },
          { path: normalized.paths[1]!, transitionIn: "cut", transitionDurationMs: 0 },
          { path: normalized.paths[2]!, transitionIn: "fade", transitionDurationMs: 500 },
        ],
        work,
      );
      // Two cuts and one half-second crossfade: about 5.5 seconds.
      expect(seconds(film)).toBeGreaterThan(5.2);
      expect(seconds(film)).toBeLessThan(5.9);
      // Only the inputs and the finished film are left: every in-between join was removed.
      expect(readdirSync(work).sort()).toEqual([...normalized.paths.map((p) => path.basename(p)), path.basename(film)].sort());

      const music = path.join(work, "music.m4a");
      execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100", "-t", "1", "-c:a", "aac", music]);
      const withMusic = path.join(work, "with-music.mp4");
      await addMusicBedToFile(film, { path: music, volumeDb: -6, mode: "mix" }, withMusic, work);
      expect(seconds(withMusic)).toBeGreaterThan(5.2);

      const evened = path.join(work, "evened.mp4");
      expect(await normalizeLoudnessFile(withMusic, evened, work)).toMatch(/pass/);
      expect(statSync(evened).size).toBeGreaterThan(1000);

      const joined = path.join(work, "joined.mp4");
      await stitchClipFiles(normalized.paths, joined, work);
      expect(seconds(joined)).toBeGreaterThan(5.7);
      expect(readdirSync(work).some((name) => name.startsWith("list-"))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);

  it("converts an uploaded video straight from disk into working copy, preview and poster files", async () => {
    const work = mkdtempSync(path.join(os.tmpdir(), "paperclip-d18-upload-"));
    try {
      const input = clipFile("d18-upload.mp4", 2);
      const out = await processUploadedVideoFile(input, { fps: 25, maxSeconds: 60 }, work);
      expect(path.dirname(out.workingPath)).toBe(work);
      expect(statSync(out.workingPath).size).toBeGreaterThan(1000);
      expect(statSync(out.previewPath).size).toBeGreaterThan(500);
      expect(readFileSync(out.posterPath).subarray(0, 2).toString("hex")).toBe("ffd8");
      expect(out.output.durationSeconds).toBeGreaterThan(1.8);
      const notVideo = path.join(work, "notes.mp4");
      writeFileSync(notVideo, "#EXTM3U\nfile:///etc/passwd\n");
      await expect(processUploadedVideoFile(notVideo, { fps: 25, maxSeconds: 60 }, work)).rejects.toThrow(/not a video this server can use/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
