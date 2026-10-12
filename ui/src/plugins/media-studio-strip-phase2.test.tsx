// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StripPanel,
  stripClock,
  stripMoveClip,
  stripRulerStep,
  type StripClip,
  type StripSummary,
  type StripUpload,
} from "../../../packages/plugins/media-studio/src/ui/strip-panel";

/**
 * Storyline Simple editor, Phase 2: clip kinds on the strip (AI shot, your
 * video, photo), drag to reorder, the Timeline view with its time ruler and
 * music lane, the clip inspector (trim, photo motion, animate with the cost
 * first, sound, consent), the extra free transitions, and the export panel
 * (picture shape, presets, Advanced, titles, Export again).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "/api/companies/c1/video-storylines/sl-1";
const COMPANY_BASE = "/api/companies/c1/video-storylines";

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

function clips(): StripClip[] {
  return [
    { shotId: "sh-1", orderIndex: 0, prompt: "Anna drinks coffee", cameraNotes: null, durationSeconds: 5, status: "done", hasClip: true, hasPoster: true, clipKind: "generated", upload: null, muted: false, volumeDb: 0, animateQuoteCents: null },
    { shotId: "sh-2", orderIndex: 1, prompt: "Your video", cameraNotes: null, durationSeconds: 4, status: "done", hasClip: true, hasPoster: true, clipKind: "uploaded_video", upload: upload(), trimInMs: 2_000, trimOutMs: 6_000, muted: false, volumeDb: 0, animateQuoteCents: null },
    { shotId: "sh-3", orderIndex: 2, prompt: "Your photo", cameraNotes: null, durationSeconds: 3, status: "queued", hasClip: false, hasPoster: true, clipKind: "still", upload: upload({ id: "up-2", kind: "photo", fileName: "beach.jpg", durationMs: null }), stillMotion: "slow_zoom", muted: false, volumeDb: 0, animateQuoteCents: 50 },
  ];
}

function makeSummary(extra: Partial<StripSummary> = {}): StripSummary {
  const gap = (from: string, to: string) => ({
    id: null,
    fromShotId: from,
    toShotId: to,
    kind: "cut" as const,
    aiStyle: null,
    durationMs: 500,
    plainLine: null,
    prompt: null,
    userNote: null,
    suggestedKind: null,
    suggestReason: null,
    keepSame: { face: true, clothes: true, location: true },
    audioMode: "bed_only" as const,
    model: null,
    locked: false,
    chosenTakeId: null,
    state: "default" as const,
    suggestionOutdated: false,
    textOnlyReason: null,
    takes: [],
  });
  return {
    storylineId: "sl-1",
    providerId: "fal",
    status: "done",
    clips: clips(),
    gaps: [gap("sh-1", "sh-2"), gap("sh-2", "sh-3")],
    models: [],
    defaultModel: "m",
    budget: { capCents: 1000, spentCents: 100 },
    monthly: { capCents: 2000, spentCents: 0, explanation: "x" },
    writerProblem: null,
    readerLabel: null,
    readerProblem: null,
    combineProblems: [],
    canCombineAgain: true,
    aspect: "16:9",
    aspectLocked: true,
    exportSettings: { preset: "youtube_16_9", fps: 30, fit: "fit", endFrame: "keep", quality: "standard", opening: null, credits: null },
    exportWarnings: [],
    music: { musicAssetId: "a-1", fileName: "theme.mp3", trimInMs: 0, trimOutMs: null, offsetMs: 2_000, fadeInMs: 0, fadeOutMs: 0, volumeDb: -18, audioMode: "mix" },
    uploads: [upload(), upload({ id: "up-2", kind: "photo" }), upload({ id: "up-3", kind: "video", status: "processing", inUse: false, fileName: "new.mov" })],
    storage: { usedBytes: 2 * 1024 ** 3, quotaBytes: 5 * 1024 ** 3 },
    footage: { storageQuotaBytes: 5 * 1024 ** 3, maxVideoMb: 300, maxPhotoMb: 20, maxVideoSeconds: 600, cleanupDays: 14, neverSendUploadsToSogni: true },
    totalSeconds: 12,
    ...extra,
  };
}

let summary: StripSummary;
let calls: Array<{ path: string; method: string; body?: unknown }>;
let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  calls = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body });
      if (path === `${BASE}/strip`) return new Response(JSON.stringify(summary));
      if (path === `${COMPANY_BASE}/music-choices`) return new Response(JSON.stringify([{ id: "file-9", name: "Made in Media Studio.mp3", source: "media_studio" }]));
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  root = createRoot(container);
  await act(async () => {
    root!.render(<StripPanel apiBase={BASE} editable onCombineAgain={vi.fn(async () => undefined)} />);
  });
  await act(async () => {});
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const json = (c: { body?: unknown }) => JSON.parse(String(c.body));
const fire = async (el: Element, type: string) => act(async () => void el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })));
async function choose(el: HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  await fire(el, el instanceof HTMLSelectElement ? "change" : "input");
}

describe("pure helpers", () => {
  it("moves a clip in the order, formats the ruler", () => {
    expect(stripMoveClip(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(stripMoveClip(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(stripMoveClip(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(stripClock(75)).toBe("1:15");
    expect(stripRulerStep(12)).toBe(1);
    expect(stripRulerStep(100)).toBe(10);
  });
});

describe("Storyline strip, Phase 2", () => {
  it("shows each clip's kind: AI shot, your video, a photo being got ready", async () => {
    summary = makeSummary();
    await render();
    expect(q("strip-clip-sh-1")!.textContent).toContain("AI shot");
    expect(q("strip-clip-sh-2")!.textContent).toContain("Your video");
    expect(q("strip-clip-sh-3")!.textContent).toContain("Photo · slow zoom");
    expect(q("strip-clip-sh-3")!.textContent).toContain("getting ready");
    // Your own video plays its light preview copy.
    await act(async () => (q("strip-clip-sh-2")!.querySelector("button") as HTMLButtonElement).click());
    expect(container.querySelector("video")!.getAttribute("src")).toBe(`${BASE}/uploads/up-1/preview`);
  });

  it("reorders by drag and drop, and with the Earlier/Later buttons", async () => {
    summary = makeSummary();
    await render();
    await fire(q("strip-clip-sh-3")!, "dragstart");
    await fire(q("strip-clip-sh-1")!, "dragover");
    await fire(q("strip-clip-sh-1")!, "drop");
    let put = calls.find((c) => c.path === `${BASE}/order`)!;
    expect(put.method).toBe("PUT");
    expect(json(put)).toEqual({ shotIds: ["sh-3", "sh-1", "sh-2"] });

    calls.length = 0;
    await act(async () => q("strip-clip-edit-sh-1")!.click());
    await act(async () => q("clip-move-later")!.click());
    put = calls.find((c) => c.path === `${BASE}/order`)!;
    expect(json(put)).toEqual({ shotIds: ["sh-2", "sh-1", "sh-3"] });
  });

  it("shows a Timeline with a time ruler, clip blocks and the music lane", async () => {
    summary = makeSummary();
    await render();
    await act(async () => q("strip-view-timeline")!.click());
    expect(q("timeline-ruler")!.textContent).toContain("0:00");
    expect(q("timeline-ruler")!.textContent).toContain("0:10");
    expect(q("timeline-block-sh-2")!.textContent).toContain("Your video 2");
    expect(q("timeline-music-block")!.textContent).toContain("theme.mp3");
    expect(q("timeline-music-block")!.textContent).toContain("from 0:02");
  });

  it("trims your video and sets its sound", async () => {
    summary = makeSummary();
    await render();
    await act(async () => q("strip-clip-edit-sh-2")!.click());
    const start = container.querySelector('input[aria-label="Start at (seconds)"]') as HTMLInputElement;
    await choose(start, "1.5");
    await act(async () => q("clip-save-trim")!.click());
    expect(json(calls.find((c) => c.path === `${BASE}/clips/sh-2` && c.method === "PATCH")!)).toEqual({ trimInMs: 1_500, trimOutMs: 6_000 });
    await act(async () => (q("clip-mute") as HTMLInputElement).click());
    expect(calls.filter((c) => c.path === `${BASE}/clips/sh-2`).map(json)).toContainEqual({ muted: true });
  });

  it("a photo: slow zoom or hold for free, or animate with the cost shown first", async () => {
    summary = makeSummary();
    await render();
    await act(async () => q("strip-clip-edit-sh-3")!.click());
    await act(async () => q("clip-motion-hold")!.click());
    expect(json(calls.find((c) => c.path === `${BASE}/clips/sh-3`)!)).toEqual({ stillMotion: "hold" });
    const button = q("clip-animate-button") as HTMLButtonElement;
    expect(button.textContent).toBe("Animate (about $0.50)");
    expect(button.disabled).toBe(true); // nothing described yet
    await choose(container.querySelector('textarea[aria-label="What should move"]') as HTMLTextAreaElement, "Waves roll in");
    await act(async () => q("clip-animate-button")!.click());
    const post = calls.find((c) => c.path === `${BASE}/clips/sh-3/animate`);
    expect(post && json(post)).toEqual({ prompt: "Waves roll in", confirmCostCents: 50 });
  });

  it("explains that a Sogni storyline cannot animate your own photo while the company setting is on", async () => {
    summary = makeSummary({ providerId: "sogni" });
    await render();
    await act(async () => q("strip-clip-edit-sh-3")!.click());
    expect(q("clip-animate")!.textContent).toContain("never sends your own footage to Sogni");
  });

  it("asks for both consent ticks before a file showing people can be chosen, and lists uploads still being got ready", async () => {
    summary = makeSummary();
    await render();
    const file = q("footage-file") as HTMLInputElement;
    expect(file.disabled).toBe(false);
    await act(async () => (q("footage-shows-people") as HTMLInputElement).click());
    expect((q("footage-file") as HTMLInputElement).disabled).toBe(true);
    await act(async () => (q("footage-consent-likeness") as HTMLInputElement).click());
    await act(async () => (q("footage-consent-adults") as HTMLInputElement).click());
    expect((q("footage-file") as HTMLInputElement).disabled).toBe(false);
    expect(q("footage-uploads")!.textContent).toContain("getting ready");
    expect(q("add-footage")!.textContent).toContain("2.0 GB of 5.0 GB");
  });

  it("offers the extra free transitions under More…", async () => {
    summary = makeSummary();
    await render();
    await act(async () => q("strip-gap-sh-1")!.click());
    const more = container.querySelector('select[aria-label="More transitions"]') as HTMLSelectElement;
    expect([...more.options].map((o) => o.textContent)).toContain("Wipe to the left");
    await choose(more, "wipe_left");
    expect(json(calls.find((c) => c.path === `${BASE}/transitions` && c.method === "PUT")!)).toEqual({ fromShotId: "sh-1", toShotId: "sh-2", kind: "wipe_left" });
  });

  it("the music lane: pick music made in Media Studio, mix or replace, trim/offset/fades", async () => {
    summary = makeSummary();
    await render();
    const lane = q("music-lane") as HTMLDetailsElement;
    lane.open = true;
    await fire(lane, "toggle");
    await act(async () => {});
    const pick = q("music-pick") as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toContain("Made in Media Studio.mp3 (Media Studio)");
    await choose(pick, "file-9");
    expect(json(calls.find((c) => c.path === `${BASE}/music`)!)).toEqual({ musicFileId: "file-9" });
    await act(async () => q("music-mode-replace")!.click());
    expect(calls.filter((c) => c.path === `${BASE}/music`).map(json)).toContainEqual({ audioMode: "replace" });
    await choose(container.querySelector('input[aria-label="Fade out (s)"]') as HTMLInputElement, "2.5");
    await act(async () => q("music-save")!.click());
    expect(calls.filter((c) => c.path === `${BASE}/music`).map(json)).toContainEqual({ trimInMs: 0, trimOutMs: null, offsetMs: 2_000, fadeInMs: 0, fadeOutMs: 2_500, volumeDb: -18 });
  });

  it("export: shape is fixed once made, presets on the main screen, Advanced folded away, titles, Export again without re-rendering", async () => {
    summary = makeSummary({ exportWarnings: ["This film is 16:9 and the export is 9:16: cropping throws away about 68% of every picture."] });
    await render();
    expect((q("export-aspect") as HTMLSelectElement).disabled).toBe(true);
    expect(q("export-panel")!.textContent).toContain("Fixed: AI pictures and clips have already been made");
    expect(q("export-warning")!.textContent).toContain("68%");
    expect((q("export-advanced") as HTMLDetailsElement).open).toBe(false);
    await act(async () => q("export-preset-reels_9_16")!.click());
    await choose(container.querySelector('select[aria-label="Frames per second"]') as HTMLSelectElement, "24");
    await choose(q("export-opening") as HTMLInputElement, "Summer at the lake");
    await act(async () => q("export-again")!.click());
    const post = calls.find((c) => c.path === `${BASE}/export`)!;
    expect(json(post)).toEqual({
      settings: { preset: "reels_9_16", fps: 24, fit: "fit", endFrame: "keep", quality: "standard", opening: { text: "Summer at the lake", seconds: 3 }, credits: null },
    });
  });

  it("the shape can be picked while nothing is made yet", async () => {
    summary = makeSummary({ aspectLocked: false, canCombineAgain: false });
    await render();
    const aspect = q("export-aspect") as HTMLSelectElement;
    expect(aspect.disabled).toBe(false);
    await choose(aspect, "9:16");
    expect(json(calls.find((c) => c.path === `${BASE}/aspect`)!)).toEqual({ aspect: "9:16" });
    expect((q("export-again") as HTMLButtonElement).disabled).toBe(true);
  });
});
