// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripTakeCostCents, type StripClip, type StripGap, type StripSummary, type StripUpload } from "../../../packages/plugins/media-studio/src/ui/strip-panel";
import { ExportSection, TimelineEditor } from "../../../packages/plugins/media-studio/src/ui/timeline-editor";
import {
  ZOOM_LEVELS,
  buildTimeline,
  clipAt,
  dragEdge,
  fitZoomIndex,
  formatTime,
  moveBefore,
  musicSpan,
  nudgeOrder,
  previewAt,
  rulerTicks,
  splitProblem,
  trimModeOf,
  type TimelineClip,
} from "../../../packages/plugins/media-studio/src/ui/timeline-model";

/**
 * The Storylines timeline editor (step 4): tracks in time (titles, video
 * clips sized by how long they play with joins between them, music), the
 * playhead, ruler and zoom, a preview of the frame under the playhead, drag
 * to reorder, trim handles, split and remove, transitions, the music's start
 * and fades, the inspector, the always-visible length and cost, and the
 * keyboard. Also the panels it reuses (join inspector, your own footage,
 * music lane, export). Every request is stubbed.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "/api/companies/c1/video-storylines/sl-1";
const COMPANY_BASE = "/api/companies/c1/video-storylines";
const KLING = { provider: "fal", model: "fal-ai/kling-video/v3/standard/image-to-video", label: "Kling 3.0 Standard on Fal", minSeconds: 3, maxSeconds: 15, centsPerSecond: 8.4, soundCentsPerSecond: 12.6, soundIsFree: false, note: "No AI sound." };

function upload(over: Partial<StripUpload> = {}): StripUpload {
  return {
    id: "up-1",
    kind: "video",
    status: "ready",
    fileName: "phone.mov",
    durationMs: 20_000,
    width: 1920,
    height: 1080,
    byteSize: 1_000,
    wasHdr: true,
    wasVariableFrameRate: true,
    hasAudio: true,
    showsPeople: false,
    consentLikeness: false,
    consentAdults: false,
    error: null,
    inUse: true,
    createdAt: "",
    ...over,
  };
}

function gap(from: string, to: string, over: Partial<StripGap> = {}): StripGap {
  return {
    id: null,
    fromShotId: from,
    toShotId: to,
    kind: "cut",
    aiStyle: null,
    durationMs: 500,
    plainLine: null,
    prompt: null,
    userNote: null,
    suggestedKind: null,
    suggestReason: null,
    keepSame: { face: true, clothes: true, location: true },
    audioMode: "bed_only",
    model: null,
    locked: false,
    chosenTakeId: null,
    state: "default",
    suggestionOutdated: false,
    textOnlyReason: null,
    takes: [],
    ...over,
  };
}

function clips(): StripClip[] {
  return [
    // A made AI shot: 5 s clip.
    { shotId: "sh-1", orderIndex: 0, prompt: "Anna drinks coffee", cameraNotes: "Slow push-in", durationSeconds: 5, status: "done", storyboardStatus: "approved", hasClip: true, hasPoster: true, clipKind: "generated", upload: null, muted: false, volumeDb: 0, animateQuoteCents: null, playMs: 5_000, sourceLengthMs: 5_000, providerId: "sogni", model: "ltx25", estimatedCostCents: 40 },
    // Your own video, trimmed to 2-6 s.
    { shotId: "sh-2", orderIndex: 1, prompt: "Your video", cameraNotes: null, durationSeconds: 4, status: "done", hasClip: true, hasPoster: true, clipKind: "uploaded_video", upload: upload(), trimInMs: 2_000, trimOutMs: 6_000, muted: false, volumeDb: 0, animateQuoteCents: null, playMs: 4_000, sourceLengthMs: 20_000 },
    // An AI shot not made yet: 3 s planned.
    { shotId: "sh-3", orderIndex: 2, prompt: "Anna walks out", cameraNotes: null, durationSeconds: 3, status: "draft", storyboardStatus: "approved", hasClip: false, hasPoster: true, clipKind: "generated", upload: null, muted: false, volumeDb: 0, animateQuoteCents: null, playMs: 3_000, sourceLengthMs: null, providerId: "sogni", model: "ltx25", estimatedCostCents: 24 },
    // Your photo, held 3 s.
    { shotId: "sh-4", orderIndex: 3, prompt: "Your photo", cameraNotes: null, durationSeconds: 3, status: "done", hasClip: true, hasPoster: true, clipKind: "still", upload: upload({ id: "up-2", kind: "photo", fileName: "beach.jpg", durationMs: null }), stillMotion: "slow_zoom", muted: false, volumeDb: 0, animateQuoteCents: 50, playMs: 3_000 },
  ];
}

function makeSummary(extra: Partial<StripSummary> = {}): StripSummary {
  return {
    storylineId: "sl-1",
    providerId: "sogni",
    status: "estimated",
    clips: clips(),
    gaps: [gap("sh-1", "sh-2", { kind: "fade", durationMs: 1_000 }), gap("sh-2", "sh-3"), gap("sh-3", "sh-4")],
    models: [KLING],
    defaultModel: KLING.model,
    budget: { capCents: 1000, spentCents: 100 },
    monthly: { capCents: 2000, spentCents: 0, explanation: "x" },
    writerProblem: null,
    readerLabel: "Claude Sonnet",
    readerProblem: null,
    combineProblems: [],
    canCombineAgain: false,
    aspect: "16:9",
    aspectLocked: true,
    exportSettings: { preset: "youtube_16_9", fps: 30, fit: "fit", endFrame: "keep", quality: "standard", opening: null, credits: null },
    exportWarnings: [],
    music: { musicAssetId: "a-1", fileName: "theme.mp3", trimInMs: 0, trimOutMs: null, offsetMs: 2_000, fadeInMs: 1_000, fadeOutMs: 2_000, volumeDb: -18, audioMode: "mix" },
    uploads: [upload(), upload({ id: "up-2", kind: "photo" }), upload({ id: "up-3", kind: "video", status: "processing", inUse: false, fileName: "new.mov" })],
    storage: { usedBytes: 2 * 1024 ** 3, quotaBytes: 5 * 1024 ** 3 },
    footage: { storageQuotaBytes: 5 * 1024 ** 3, maxVideoMb: 300, maxPhotoMb: 20, maxVideoSeconds: 600, cleanupDays: 14, neverSendUploadsToSogni: true },
    totalSeconds: 15,
    remainingRenderCents: 24,
    advancedEnabled: true,
    ...extra,
  };
}

// ─── Pure model ─────────────────────────────────────────────────────────────

describe("timeline model (pure)", () => {
  const list = clips() as TimelineClip[];

  it("lays clips out by how long they play: a blend overlaps, an AI bridge adds time, titles come first and last", () => {
    const layout = buildTimeline(list, [gap("sh-1", "sh-2", { kind: "fade", durationMs: 1_000 }), gap("sh-2", "sh-3", { kind: "ai", durationMs: 3_000 }), gap("sh-3", "sh-4")], {
      opening: { text: "Summer", seconds: 2 },
      credits: { text: "Thanks", seconds: 4 },
    });
    const at = (id: string) => layout.clips.find((c) => c.key === id)!;
    expect([at("sh-1").startMs, at("sh-1").endMs]).toEqual([2_000, 7_000]);
    // The fade starts the next clip 1 s early.
    expect([at("sh-2").startMs, at("sh-2").endMs]).toEqual([6_000, 10_000]);
    // A 3 s AI bridge between clip 2 and 3.
    expect(layout.items.find((i) => i.type === "bridge")).toMatchObject({ startMs: 10_000, endMs: 13_000 });
    expect([at("sh-3").startMs, at("sh-4").endMs]).toEqual([13_000, 19_000]);
    expect(layout.totalMs).toBe(23_000);
    expect(layout.joins.map((j) => [j.gap.kind, j.atMs])).toEqual([
      ["fade", 6_500],
      ["ai", 11_500],
      ["cut", 16_000],
    ]);
    expect(itemKinds(layout.items)).toEqual(["title", "clip", "clip", "bridge", "clip", "clip", "title"]);
  });

  it("finds what is under the playhead and what the preview shows there", () => {
    const layout = buildTimeline(list, []);
    expect(clipAt(layout, 6_500)).toMatchObject({ item: { key: "sh-2" }, offsetMs: 1_500 });
    // A made AI clip shows its own frame; your trimmed video's prepared clip from its start.
    expect(previewAt(layout, 1_000, BASE)).toEqual({ kind: "video", src: `${BASE}/shots/sh-1/clip`, timeSeconds: 1 });
    expect(previewAt(layout, 6_500, BASE)).toEqual({ kind: "video", src: `${BASE}/shots/sh-2/clip`, timeSeconds: 1.5 });
    // Not made yet: its storyboard picture.
    expect(previewAt(layout, 10_000, BASE)).toEqual({ kind: "image", src: `${BASE}/shots/sh-3/poster` });
    const trimmed = buildTimeline([{ ...list[0]!, trimInMs: 1_000, trimOutMs: 4_000, playMs: 3_000 }], []);
    expect(previewAt(trimmed, 500, BASE)).toEqual({ kind: "video", src: `${BASE}/shots/sh-1/clip`, timeSeconds: 1.5 });
  });

  it("trims inside the clip's own length, and changes a not-yet-made shot's length in whole seconds", () => {
    const [made, video, draft, photo] = list as [TimelineClip, TimelineClip, TimelineClip, TimelineClip];
    expect([trimModeOf(made), trimModeOf(video), trimModeOf(draft), trimModeOf(photo)]).toEqual(["trim", "trim", "length", "length"]);
    expect(dragEdge(made, "start", 1_200)).toEqual({ mode: "trim", trimInMs: 1_200, trimOutMs: 5_000, playMs: 3_800 });
    // Never past the end of the footage, never shorter than half a second.
    expect(dragEdge(made, "end", 9_000)).toMatchObject({ trimOutMs: 5_000 });
    expect(dragEdge(made, "start", 9_000)).toMatchObject({ trimInMs: 4_500, playMs: 500 });
    expect(dragEdge(video, "start", -5_000)).toMatchObject({ trimInMs: 0, trimOutMs: 6_000 });
    expect(dragEdge(draft, "end", 2_400)).toEqual({ mode: "length", seconds: 5, playMs: 5_000 });
    expect(dragEdge(draft, "start", 1_000)).toBeNull();
    expect(dragEdge(photo, "end", -9_000)).toMatchObject({ seconds: 1 });
  });

  it("splits only where both parts are long enough", () => {
    const [made, , draft] = list as [TimelineClip, TimelineClip, TimelineClip];
    expect(splitProblem(made, 2_000)).toBeNull();
    expect(splitProblem(made, 200)).toContain("half a second");
    expect(splitProblem(draft, 1_400)).toBeNull();
    expect(splitProblem(draft, 400)).toContain("whole seconds");
  });

  it("ruler, zoom, order and music helpers", () => {
    expect(formatTime(75_400, true)).toBe("1:15.4");
    expect(rulerTicks(10_000, 36).map((t) => t.label)).toEqual(["0:00", "0:02", "0:04", "0:06", "0:08", "0:10"]);
    expect(ZOOM_LEVELS[fitZoomIndex(60_000, 700)]! * 60).toBeLessThanOrEqual(700);
    expect(moveBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(nudgeOrder(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
    expect(nudgeOrder(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(musicSpan({ musicAssetId: "m", fileName: null, trimInMs: 0, trimOutMs: null, offsetMs: 2_000, fadeInMs: 1_000, fadeOutMs: 50_000 }, 12_000)).toEqual({ startMs: 2_000, endMs: 12_000, fadeInMs: 1_000, fadeOutMs: 10_000 });
  });
});

function itemKinds(items: Array<{ type: string }>): string[] {
  return items.map((i) => i.type);
}

// ─── The editor ─────────────────────────────────────────────────────────────

let summary: StripSummary;
let calls: Array<{ path: string; method: string; body?: string }>;
let root: Root | null = null;
let container: HTMLDivElement;
let onChanged: ReturnType<typeof vi.fn<() => Promise<void>>>;
let rafCallbacks: FrameRequestCallback[];

beforeEach(() => {
  calls = [];
  rafCallbacks = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  onChanged = vi.fn<() => Promise<void>>(async () => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (path === `${BASE}/strip`) return new Response(JSON.stringify(summary));
      if (path === `${COMPANY_BASE}/music-choices`) return new Response(JSON.stringify([{ id: "file-9", name: "Made in Media Studio.mp3", source: "media_studio" }]));
      if (path.endsWith("/split")) return new Response(JSON.stringify({ shotId: "sh-new" }), { status: 201 });
      if (path === `${BASE}/transitions`) return new Response(JSON.stringify({ ...summary.gaps[0], id: "t-1" }));
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(props: Partial<Parameters<typeof TimelineEditor>[0]> = {}) {
  root = createRoot(container);
  await act(async () => {
    root!.render(<TimelineEditor apiBase={BASE} editable shotsEditable onChanged={onChanged} {...props} />);
  });
  await act(async () => {});
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const json = (c: { body?: string }) => JSON.parse(String(c.body));
const fire = async (el: Element | Window, type: string, init: MouseEventInit = {}) =>
  act(async () => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })));
const key = async (k: string, init: KeyboardEventInit = {}) =>
  act(async () => void q("timeline-editor")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })));
async function choose(el: HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  await act(async () => void el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })));
}
const pps = () => Number(q("timeline-content")!.getAttribute("data-pps"));
const leftPx = (id: string) => parseFloat(q(id)!.style.left);
const widthPx = (id: string) => parseFloat(q(id)!.style.width);

describe("timeline editor", () => {
  it("shows the tracks with clips sized by duration, the joins, the music, and the length and cost all the time", async () => {
    summary = makeSummary();
    await render();
    expect(q("timeline-total")!.textContent).toBe("0:14.0");
    expect(q("timeline-cost")!.textContent).toContain("about $0.24");
    expect(q("timeline-summary")!.textContent).toContain("1 of 2 AI shots made");
    expect(q("timeline-summary")!.textContent).toContain("Spent $1.00 of $10.00 budget");
    // 5 s, 4 s, 3 s, 3 s: widths follow the length; the 1 s fade overlaps clip 1 and 2.
    const p = pps();
    expect(widthPx("timeline-clip-sh-1")).toBeCloseTo(5 * p - 2);
    expect(widthPx("timeline-clip-sh-3")).toBeCloseTo(3 * p - 2);
    expect(leftPx("timeline-clip-sh-2")).toBeCloseTo(4 * p);
    expect(q("timeline-join-sh-1")!.textContent).toBe("◇");
    expect(q("timeline-join-sh-2")!.textContent).toBe("|");
    expect(q("timeline-music")!.textContent).toContain("theme.mp3");
    expect(leftPx("timeline-music")).toBeCloseTo(2 * p);
    expect(q("timeline-ruler")!.textContent).toContain("0:00");
    // The preview starts on the first clip's own frame.
    expect(q("timeline-monitor-video")!.getAttribute("src")).toBe(`${BASE}/shots/sh-1/clip`);
    // Things that are not made yet look different and say so.
    expect(q("timeline-clip-sh-3")!.getAttribute("aria-label")).toBe("Shot 3, 3 seconds, Not made yet");
  });

  it("says what to do when the timeline is empty", async () => {
    summary = makeSummary({ clips: [], gaps: [], music: { ...makeSummary().music!, musicAssetId: null, fileName: null } });
    await render();
    expect(q("timeline-empty")!.textContent).toContain("Write or import the script in step 1");
  });

  it("scrubs: clicking the ruler moves the playhead and the preview shows that frame", async () => {
    summary = makeSummary();
    await render();
    const p = pps();
    await fire(q("timeline-ruler")!, "pointerdown", { clientX: 6.5 * p });
    await fire(window, "pointerup");
    expect(q("timeline-time")!.textContent).toBe("0:06.5 / 0:14.0");
    expect(leftPx("timeline-playhead")).toBeCloseTo(6.5 * p);
    // 6.5 s is 2.5 s into clip 2 (it starts at 4 s because of the fade).
    expect(q("timeline-monitor-video")!.getAttribute("src")).toBe(`${BASE}/shots/sh-2/clip`);
    await fire(q("timeline-ruler")!, "pointerdown", { clientX: 9 * p });
    await fire(window, "pointerup");
    // Clip 3 is not made yet: its storyboard picture.
    expect(q("timeline-monitor-image")!.getAttribute("src")).toBe(`${BASE}/shots/sh-3/poster`);
  });

  it("zooms in and out, and Fit shows the whole film", async () => {
    summary = makeSummary();
    await render();
    const before = pps();
    await act(async () => q("timeline-zoom-in")!.click());
    expect(pps()).toBeGreaterThan(before);
    expect(widthPx("timeline-clip-sh-1")).toBeCloseTo(5 * pps() - 2);
    await act(async () => q("timeline-zoom-out")!.click());
    await act(async () => q("timeline-zoom-out")!.click());
    expect(pps()).toBeLessThan(before);
    await key("+");
    await key("+");
    expect(pps()).toBeGreaterThan(before);
    await act(async () => q("timeline-fit")!.click());
    expect(pps()).toBe(before);
  });

  it("reorders by dragging a clip onto another", async () => {
    summary = makeSummary();
    await render();
    await fire(q("timeline-clip-sh-4")!, "dragstart");
    await act(async () => void q("timeline-clip-sh-1")!.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true })));
    await act(async () => void q("timeline-clip-sh-1")!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })));
    const put = calls.find((c) => c.path === `${BASE}/order`)!;
    expect(put.method).toBe("PUT");
    expect(json(put)).toEqual({ shotIds: ["sh-4", "sh-1", "sh-2", "sh-3"] });
    expect(onChanged).toHaveBeenCalled();
  });

  it("trims a made clip by dragging its start handle, live, and saves on release", async () => {
    summary = makeSummary();
    await render();
    const p = pps();
    await fire(q("trim-start-sh-1")!, "pointerdown", { clientX: 100 });
    await fire(window, "pointermove", { clientX: 100 + 1.5 * p });
    // Shown live while dragging: 3.5 s left.
    expect(widthPx("timeline-clip-sh-1")).toBeCloseTo(3.5 * p - 2);
    await fire(window, "pointerup", { clientX: 100 + 1.5 * p });
    const patch = calls.find((c) => c.path === `${BASE}/clips/sh-1` && c.method === "PATCH")!;
    expect(json(patch)).toEqual({ trimInMs: 1_500, trimOutMs: 5_000 });
  });

  it("drags the end of a shot that isn't made yet to change its planned length", async () => {
    summary = makeSummary();
    await render();
    expect(q("trim-start-sh-3")).toBeNull();
    const p = pps();
    await fire(q("trim-end-sh-3")!, "pointerdown", { clientX: 300 });
    await fire(window, "pointermove", { clientX: 300 + 2 * p });
    await fire(window, "pointerup");
    expect(json(calls.find((c) => c.path === `${BASE}/shots/sh-3` && c.method === "PATCH")!)).toEqual({ durationSeconds: 5 });
    // A photo's end sets how long it shows.
    await fire(q("trim-end-sh-4")!, "pointerdown", { clientX: 300 });
    await fire(window, "pointermove", { clientX: 300 - 1 * p });
    await fire(window, "pointerup");
    expect(json(calls.find((c) => c.path === `${BASE}/clips/sh-4` && c.method === "PATCH")!)).toEqual({ holdSeconds: 2 });
  });

  it("keyboard: space plays and pauses, arrows move the playhead, Alt+arrows move the clip, S splits, Delete removes", async () => {
    summary = makeSummary();
    await render();
    await key(" ");
    expect(q("timeline-play")!.textContent).toContain("Pause");
    // One animation frame 500 ms later moves the playhead.
    await act(async () => rafCallbacks.shift()!(performance.now() + 500));
    expect(q("timeline-time")!.textContent!.startsWith("0:00.0")).toBe(false);
    await key(" ");
    expect(q("timeline-play")!.textContent).toContain("Play");

    await key("Home");
    await key("ArrowRight", { shiftKey: true });
    await key("ArrowRight", { shiftKey: true });
    await key("ArrowRight");
    expect(q("timeline-time")!.textContent).toBe("0:02.1 / 0:14.0");
    await key("ArrowLeft");
    expect(q("timeline-time")!.textContent).toBe("0:02.0 / 0:14.0");

    await act(async () => q("timeline-clip-sh-1")!.click());
    await key("ArrowRight", { altKey: true });
    expect(json(calls.find((c) => c.path === `${BASE}/order`)!)).toEqual({ shotIds: ["sh-2", "sh-1", "sh-3", "sh-4"] });

    // S splits the clip under the playhead (2 s into clip 1).
    await key("s");
    const split = calls.find((c) => c.path === `${BASE}/clips/sh-1/split`)!;
    expect(json(split)).toEqual({ atMs: 2_000 });

    await act(async () => q("timeline-clip-sh-3")!.click());
    await key("Delete");
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Remove Shot 3 from the film?"));
    expect(calls.some((c) => c.path === `${BASE}/clips/sh-3` && c.method === "DELETE")).toBe(true);
  });

  it("explains instead of splitting too close to a clip's edge", async () => {
    summary = makeSummary();
    await render();
    await key("Home");
    await key("ArrowRight");
    await key("s");
    expect(q("timeline-notice")!.textContent).toContain("half a second");
    expect(calls.some((c) => c.path.endsWith("/split"))).toBe(false);
  });

  it("the AI shot inspector: description, model, status, cost, trim, and make it again with the price first", async () => {
    summary = makeSummary();
    await render();
    await act(async () => q("timeline-clip-sh-1")!.click());
    const panel = q("ai-clip-panel")!;
    expect(panel.textContent).toContain("Anna drinks coffee");
    expect(panel.textContent).toContain("Slow push-in");
    expect(q("ai-clip-status")!.textContent).toBe("Made");
    expect(q("ai-clip-facts")!.textContent).toContain("Sogni · ltx25");
    expect(q("ai-clip-cost")!.textContent).toContain("$0.40");
    expect(q("ai-clip-trim")!.textContent).toContain("Plays 5 s of 5 s");
    await act(async () => q("ai-clip-again")!.click());
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("about $0.40"));
    expect(calls.some((c) => c.path === `${BASE}/shots/sh-1/rerender` && c.method === "POST")).toBe(true);

    // A shot not made yet: its planned length, saved on the shot.
    await act(async () => q("timeline-clip-sh-3")!.click());
    await choose(container.querySelector('input[aria-label="Length in seconds"]') as HTMLInputElement, "6");
    await act(async () => q("ai-clip-save-length")!.click());
    expect(json(calls.find((c) => c.path === `${BASE}/shots/sh-3` && c.method === "PATCH")!)).toEqual({ durationSeconds: 6 });
  });

  it("says why a shot can't be made again, and shows a failed shot's own reason", async () => {
    summary = makeSummary({
      clips: clips().map((c) => (c.shotId === "sh-1" ? { ...c, status: "failed", hasClip: false, storyboardStatus: "pending", errorMessage: "Sogni didn't accept shot 1: Sogni's storage did not take the starting frame (500). Nothing was charged. Try again in a minute." } : c)),
    });
    await render();
    await act(async () => q("timeline-clip-sh-1")!.click());
    expect(q("ai-clip-error")!.textContent).toContain("Nothing was charged");
    const again = q("ai-clip-again") as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    expect(q("ai-clip-panel")!.textContent).toContain("Approve this shot's picture in step 3");
  });

  it("a join: cut or fade from the inspector, Delete turns it back into a cut", async () => {
    summary = makeSummary();
    await render();
    await act(async () => q("timeline-join-sh-2")!.click());
    await act(async () => q("transition-kind-blend")!.click());
    expect(json(calls.find((c) => c.path === `${BASE}/transitions` && c.method === "PUT")!)).toEqual({ fromShotId: "sh-2", toShotId: "sh-3", kind: "blend" });
    calls.length = 0;
    await act(async () => q("timeline-join-sh-1")!.click());
    await key("Delete");
    expect(json(calls.find((c) => c.path === `${BASE}/transitions`)!)).toEqual({ fromShotId: "sh-1", toShotId: "sh-2", kind: "cut" });
  });

  it("without Advanced features an AI bridge can't be picked, and own footage can't be added", async () => {
    summary = makeSummary({ advancedEnabled: false });
    await render();
    await act(async () => q("timeline-join-sh-2")!.click());
    expect((q("transition-kind-ai") as HTMLButtonElement).disabled).toBe(true);
    expect(q("transition-suggest")).toBeNull();
    expect(q("add-footage")).toBeNull();
  });

  it("the music: drag to move its start, drag the fade handle, and the lane's settings", async () => {
    summary = makeSummary();
    await render();
    const p = pps();
    await fire(q("timeline-music")!, "pointerdown", { clientX: 200 });
    await fire(window, "pointermove", { clientX: 200 + 1 * p });
    await fire(window, "pointerup");
    expect(json(calls.find((c) => c.path === `${BASE}/music`)!)).toEqual({ offsetMs: 3_000 });
    calls.length = 0;
    await fire(q("music-fade-in-handle")!, "pointerdown", { clientX: 200 });
    await fire(window, "pointermove", { clientX: 200 + 0.5 * p });
    await fire(window, "pointerup");
    expect(json(calls.find((c) => c.path === `${BASE}/music`)!)).toEqual({ fadeInMs: 1_500 });
    // Selected: its settings open in the inspector.
    await act(async () => {});
    const pick = q("music-pick") as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toContain("Made in Media Studio.mp3 (Media Studio)");
    await act(async () => q("music-mode-replace")!.click());
    expect(calls.filter((c) => c.path === `${BASE}/music`).map(json)).toContainEqual({ audioMode: "replace" });
  });

  it("own footage keeps its inspector: trim, sound, photo motion, animate with the cost first, consent, and More… transitions", async () => {
    summary = makeSummary();
    await render();
    await act(async () => q("timeline-clip-sh-2")!.click());
    await choose(container.querySelector('input[aria-label="Start at (seconds)"]') as HTMLInputElement, "1.5");
    await act(async () => q("clip-save-trim")!.click());
    expect(json(calls.find((c) => c.path === `${BASE}/clips/sh-2` && c.method === "PATCH")!)).toEqual({ trimInMs: 1_500, trimOutMs: 6_000 });
    await act(async () => (q("clip-mute") as HTMLInputElement).click());
    expect(calls.filter((c) => c.path === `${BASE}/clips/sh-2`).map(json)).toContainEqual({ muted: true });

    await act(async () => q("timeline-clip-sh-4")!.click());
    await act(async () => q("clip-motion-hold")!.click());
    expect(calls.filter((c) => c.path === `${BASE}/clips/sh-4`).map(json)).toContainEqual({ stillMotion: "hold" });
    // This company never sends own footage to Sogni, and this storyline uses Sogni.
    expect(q("clip-animate")!.textContent).toContain("never sends your own footage to Sogni");

    await act(async () => q("timeline-join-sh-1")!.click());
    const more = container.querySelector('select[aria-label="More transitions"]') as HTMLSelectElement;
    expect([...more.options].map((o) => o.textContent)).toContain("Wipe to the left");
    await choose(more, "wipe_left");
    expect(calls.filter((c) => c.path === `${BASE}/transitions`).map(json)).toContainEqual({ fromShotId: "sh-1", toShotId: "sh-2", kind: "wipe_left" });

    const file = q("footage-file") as HTMLInputElement;
    expect(file.disabled).toBe(false);
    await act(async () => (q("footage-shows-people") as HTMLInputElement).click());
    expect((q("footage-file") as HTMLInputElement).disabled).toBe(true);
    expect(q("footage-uploads")!.textContent).toContain("getting ready");
  });

  it("an AI bridge join: the cost before anything is made, versions, and Make it", async () => {
    const bridge = gap("sh-1", "sh-2", {
      id: "t-1",
      kind: "ai",
      durationMs: 3000,
      plainLine: "The camera follows Anna out into the rain. 3 s.",
      suggestedKind: "ai",
      suggestReason: "Same place, she keeps moving.",
      model: KLING.model,
      state: "suggested",
    });
    summary = makeSummary({ providerId: "fal", gaps: [bridge, gap("sh-2", "sh-3"), gap("sh-3", "sh-4")] });
    await render();
    expect(q("timeline-bridge-sh-1")).not.toBeNull();
    await act(async () => q("timeline-join-sh-1")!.click());
    expect(q("transition-reason")!.textContent).toContain("Same place, she keeps moving.");
    expect(q("transition-cost")!.textContent).toContain("$0.26");
    expect(stripTakeCostCents(KLING, 3, "bed_only")).toBe(26);
    expect(calls.filter((c) => c.path.endsWith("/generate"))).toHaveLength(0);
    await act(async () => q("transition-generate")!.click());
    expect(json(calls.find((c) => c.path === `${BASE}/transitions/t-1/generate`)!)).toEqual({ confirmCostCents: 26 });
  });

  it("read-only while clips are being made: no handles, no remove", async () => {
    summary = makeSummary({ status: "rendering" });
    await render({ editable: false, shotsEditable: false });
    expect(q("trim-start-sh-1")).toBeNull();
    expect((q("timeline-remove") as HTMLButtonElement).disabled).toBe(true);
    expect((q("timeline-split") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a plain error, not a broken page, when the timeline can't be read", async () => {
    summary = { nonsense: true } as unknown as StripSummary;
    await render();
    expect(q("timeline-editor")!.textContent).toContain("could not be read");
  });
});

describe("export section (step 5)", () => {
  it("presets, titles and Export again without re-rendering; the picture shape lives in step 2", async () => {
    summary = makeSummary({ canCombineAgain: true, exportWarnings: ["This film is 16:9 and the export is 9:16: cropping throws away about 68% of every picture."] });
    root = createRoot(container);
    await act(async () => {
      root!.render(<ExportSection apiBase={BASE} editable />);
    });
    await act(async () => {});
    expect(q("export-aspect")).toBeNull();
    expect(q("export-warning")!.textContent).toContain("68%");
    expect((q("export-advanced") as HTMLDetailsElement).open).toBe(false);
    await act(async () => q("export-preset-reels_9_16")!.click());
    await choose(container.querySelector('select[aria-label="Frames per second"]') as HTMLSelectElement, "24");
    await choose(q("export-opening") as HTMLInputElement, "Summer at the lake");
    await act(async () => q("export-again")!.click());
    expect(json(calls.find((c) => c.path === `${BASE}/export`)!)).toEqual({
      settings: { preset: "reels_9_16", fps: 24, fit: "fit", endFrame: "keep", quality: "standard", opening: { text: "Summer at the lake", seconds: 3 }, credits: null },
    });
  });
});
