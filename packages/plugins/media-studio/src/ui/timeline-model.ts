// The Storylines timeline editor's arithmetic: where every clip, join, title
// card and the music sit in time, how trims and lengths may change, the time
// ruler, zoom, and what the preview shows at the playhead.
//
// Pure functions only (no React, no fetch) so the timeline can be unit tested.
// Standalone on purpose: this UI bundle cannot import @paperclipai/shared.
// MIN_CLIP_MS / MAX_CLIP_SECONDS copy VIDEO_CLIP_MIN_MS / VIDEO_CLIP_MAX_SECONDS
// (packages/shared/src/video-storyline-clips.ts). Keep them in sync by hand.

export const MIN_CLIP_MS = 500;
export const MAX_CLIP_SECONDS = 60;
/** Zoom steps in pixels per second of film. */
export const ZOOM_LEVELS = [6, 10, 16, 24, 36, 54, 80, 120, 180] as const;
export const DEFAULT_ZOOM_INDEX = 4;
/** The playhead moves this far per arrow key (Shift: NUDGE_BIG_MS). */
export const NUDGE_MS = 100;
export const NUDGE_BIG_MS = 1_000;

export type TimelineClipKind = "generated" | "uploaded_video" | "still";

export interface TimelineClip {
  shotId: string;
  orderIndex: number;
  prompt: string;
  durationSeconds: number;
  status: string;
  storyboardStatus?: string;
  hasClip: boolean;
  hasPoster: boolean;
  clipKind?: TimelineClipKind;
  upload?: { id: string; durationMs: number | null; kind?: string } | null;
  trimInMs?: number | null;
  trimOutMs?: number | null;
  playMs?: number;
  sourceLengthMs?: number | null;
  errorMessage?: string | null;
}

export interface TimelineGap {
  fromShotId: string;
  toShotId: string;
  kind: string;
  durationMs: number;
  state?: string;
}

export interface TimelineTitles {
  opening: { text: string; seconds: number } | null;
  credits: { text: string; seconds: number } | null;
}

export type TimelineItem =
  | { type: "clip"; key: string; clip: TimelineClip; index: number; startMs: number; endMs: number }
  | { type: "bridge"; key: string; gap: TimelineGap; startMs: number; endMs: number }
  | { type: "title"; key: "opening" | "credits"; text: string; startMs: number; endMs: number };

/** A join between two clips, drawn as a marker on the video track. */
export interface TimelineJoin {
  key: string;
  gap: TimelineGap;
  /** Where the marker sits (the middle of a blend, the edge for a cut). */
  atMs: number;
  /** How much the two clips overlap (a blend), 0 for a cut or an AI bridge. */
  overlapMs: number;
}

export interface TimelineLayout {
  items: TimelineItem[];
  clips: Array<Extract<TimelineItem, { type: "clip" }>>;
  joins: TimelineJoin[];
  totalMs: number;
  /** Where the clips start (after an opening title card). */
  clipsStartMs: number;
}

export function clipKindOf(clip: Pick<TimelineClip, "clipKind">): TimelineClipKind {
  return clip.clipKind ?? "generated";
}

/** Whether an AI shot's clip has been made (and so can be trimmed). */
export function isMade(clip: Pick<TimelineClip, "status" | "hasClip">): boolean {
  return clip.status === "done" && clip.hasClip;
}

/** How long a clip plays: the server's answer when it sent one, else worked out from the fields. */
export function clipPlayMs(clip: TimelineClip): number {
  if (typeof clip.playMs === "number" && clip.playMs > 0) return clip.playMs;
  if (clipKindOf(clip) === "uploaded_video" && clip.trimInMs != null && clip.trimOutMs != null) return Math.max(MIN_CLIP_MS, clip.trimOutMs - clip.trimInMs);
  return Math.max(MIN_CLIP_MS, clip.durationSeconds * 1000);
}

function isBlend(kind: string): boolean {
  return kind !== "cut" && kind !== "ai";
}

/**
 * Lays the film out in time, the way it is combined: an opening title card,
 * the clips in order (a blend overlaps the two clips it joins, an AI bridge
 * is its own short clip between them), then the credits.
 */
export function buildTimeline(clips: readonly TimelineClip[], gaps: readonly TimelineGap[], titles?: TimelineTitles | null): TimelineLayout {
  const items: TimelineItem[] = [];
  const joins: TimelineJoin[] = [];
  const clipItems: Array<Extract<TimelineItem, { type: "clip" }>> = [];
  let cursor = 0;
  if (titles?.opening) {
    const ms = Math.max(0, titles.opening.seconds * 1000);
    items.push({ type: "title", key: "opening", text: titles.opening.text, startMs: 0, endMs: ms });
    cursor = ms;
  }
  const clipsStartMs = cursor;
  const gapByPair = new Map(gaps.map((g) => [`${g.fromShotId}:${g.toShotId}`, g]));
  clips.forEach((clip, index) => {
    const length = clipPlayMs(clip);
    let start = cursor;
    if (index > 0) {
      const prev = clipItems[clipItems.length - 1]!;
      const gap = gapByPair.get(`${prev.clip.shotId}:${clip.shotId}`) ?? { fromShotId: prev.clip.shotId, toShotId: clip.shotId, kind: "cut", durationMs: 0 };
      if (gap.kind === "ai") {
        const bridge = Math.max(0, gap.durationMs);
        items.push({ type: "bridge", key: `bridge-${gap.fromShotId}`, gap, startMs: cursor, endMs: cursor + bridge });
        joins.push({ key: `${gap.fromShotId}:${gap.toShotId}`, gap, atMs: cursor + bridge / 2, overlapMs: 0 });
        start = cursor + bridge;
      } else if (isBlend(gap.kind)) {
        // A blend crossfades: the next clip starts before the previous one ends.
        const prevLength = prev.endMs - prev.startMs;
        const overlap = Math.max(0, Math.min(gap.durationMs, prevLength - 100, length - 100));
        start = cursor - overlap;
        joins.push({ key: `${gap.fromShotId}:${gap.toShotId}`, gap, atMs: cursor - overlap / 2, overlapMs: overlap });
      } else {
        joins.push({ key: `${gap.fromShotId}:${gap.toShotId}`, gap, atMs: cursor, overlapMs: 0 });
      }
    }
    const item = { type: "clip" as const, key: clip.shotId, clip, index, startMs: start, endMs: start + length };
    items.push(item);
    clipItems.push(item);
    cursor = item.endMs;
  });
  if (titles?.credits) {
    const ms = Math.max(0, titles.credits.seconds * 1000);
    items.push({ type: "title", key: "credits", text: titles.credits.text, startMs: cursor, endMs: cursor + ms });
    cursor += ms;
  }
  return { items, clips: clipItems, joins, totalMs: cursor, clipsStartMs };
}

/** What is on screen at a moment: the latest item that has started by then (a blend shows the incoming clip). */
export function itemAt(layout: TimelineLayout, ms: number): { item: TimelineItem; offsetMs: number } | null {
  let found: TimelineItem | null = null;
  for (const item of layout.items) {
    if (item.startMs <= ms && ms < item.endMs) found = item;
  }
  if (!found && layout.items.length > 0 && ms >= layout.totalMs) found = layout.items[layout.items.length - 1]!;
  if (!found) return null;
  return { item: found, offsetMs: Math.max(0, Math.min(found.endMs - found.startMs, ms - found.startMs)) };
}

/** The clip the playhead is on (for split, and for selecting by keyboard). */
export function clipAt(layout: TimelineLayout, ms: number): { item: Extract<TimelineItem, { type: "clip" }>; offsetMs: number } | null {
  let found: Extract<TimelineItem, { type: "clip" }> | null = null;
  for (const item of layout.clips) if (item.startMs <= ms && ms < item.endMs) found = item;
  return found ? { item: found, offsetMs: ms - found.startMs } : null;
}

export function clampMs(ms: number, totalMs: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.min(Math.max(0, totalMs), ms));
}

/** m:ss, or m:ss.t with tenths. */
export function formatTime(ms: number, tenths = false): string {
  const safe = Math.max(0, Number.isFinite(ms) ? ms : 0);
  const totalTenths = Math.round(safe / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const rest = totalTenths % 10;
  return `${minutes}:${String(seconds).padStart(2, "0")}${tenths ? `.${rest}` : ""}`;
}

/** Seconds with at most one decimal, no trailing ".0" ("3", "2.5"). */
export function secondsText(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

/** Time-ruler ticks, spaced so labels stay at least `minGapPx` apart at this zoom. */
export function rulerTicks(totalMs: number, pxPerSecond: number, minGapPx = 56): Array<{ ms: number; label: string; major: boolean }> {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * pxPerSecond >= minGapPx) ?? 600;
  const ticks: Array<{ ms: number; label: string; major: boolean }> = [];
  const end = Math.max(totalMs, 1_000);
  for (let i = 0; i * step * 1000 <= end + 1; i += 1) {
    const ms = Math.round(i * step * 1000);
    ticks.push({ ms, label: formatTime(ms, step < 1), major: true });
  }
  return ticks;
}

/** The zoom step that shows the whole film in `widthPx` (the most zoomed-in one that still fits). */
export function fitZoomIndex(totalMs: number, widthPx: number): number {
  const seconds = Math.max(1, totalMs / 1000);
  let best = 0;
  ZOOM_LEVELS.forEach((pps, i) => {
    if (pps * seconds <= Math.max(120, widthPx - 24)) best = i;
  });
  return best;
}

export function zoomIndexStep(index: number, delta: number): number {
  return Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index + delta));
}

// ─── Trims and lengths ────────────────────────────────────────────────────

/**
 * What dragging a clip's edges does:
 *  - "trim": a made AI clip or your own video, inside its full length;
 *  - "length": an AI shot not made yet (its planned length, whole seconds)
 *    or a photo (how long it shows): only the end edge;
 *  - "none": nothing to change (e.g. a clip being made right now).
 */
export function trimModeOf(clip: TimelineClip): "trim" | "length" | "none" {
  if (clip.status === "queued" || clip.status === "rendering") return "none";
  const kind = clipKindOf(clip);
  if (kind === "uploaded_video") return clip.upload?.durationMs ? "trim" : "none";
  if (kind === "still") return "length";
  if (isMade(clip)) return clip.sourceLengthMs ? "trim" : "none";
  return "length";
}

export type EdgeChange =
  | { mode: "trim"; trimInMs: number; trimOutMs: number; playMs: number }
  | { mode: "length"; seconds: number; playMs: number };

/** The full length a trimmable clip can reach. */
export function sourceLengthOf(clip: TimelineClip): number | null {
  if (clipKindOf(clip) === "uploaded_video") return clip.upload?.durationMs ?? clip.sourceLengthMs ?? null;
  return clip.sourceLengthMs ?? null;
}

/** The clip's current in/out inside its full length (trim mode). */
export function currentTrim(clip: TimelineClip): { inMs: number; outMs: number } {
  const full = sourceLengthOf(clip) ?? clipPlayMs(clip);
  const inMs = Math.max(0, clip.trimInMs ?? 0);
  const outMs = Math.min(full, clip.trimOutMs ?? full);
  return { inMs, outMs };
}

/**
 * Moving one edge of a clip by `deltaMs` (from where it was when the drag
 * began), kept inside what the clip allows: at least half a second, at most
 * 60 seconds, never past the start or end of the footage.
 */
export function dragEdge(clip: TimelineClip, edge: "start" | "end", deltaMs: number): EdgeChange | null {
  const mode = trimModeOf(clip);
  if (mode === "none") return null;
  if (mode === "length") {
    if (edge === "start") return null;
    const seconds = Math.max(1, Math.min(MAX_CLIP_SECONDS, Math.round((clip.durationSeconds * 1000 + deltaMs) / 1000)));
    return { mode: "length", seconds, playMs: seconds * 1000 };
  }
  const full = sourceLengthOf(clip);
  if (!full) return null;
  const { inMs, outMs } = currentTrim(clip);
  let nextIn = inMs;
  let nextOut = outMs;
  if (edge === "start") {
    nextIn = Math.round(Math.max(0, Math.max(outMs - MAX_CLIP_SECONDS * 1000, Math.min(outMs - MIN_CLIP_MS, inMs + deltaMs))));
  } else {
    nextOut = Math.round(Math.min(full, Math.min(inMs + MAX_CLIP_SECONDS * 1000, Math.max(inMs + MIN_CLIP_MS, outMs + deltaMs))));
  }
  return { mode: "trim", trimInMs: nextIn, trimOutMs: nextOut, playMs: nextOut - nextIn };
}

/** Why a clip can't be split here (plain words), or null when it can. */
export function splitProblem(clip: TimelineClip, offsetMs: number): string | null {
  const kind = clipKindOf(clip);
  if (clip.status === "queued" || clip.status === "rendering") return "This clip is being made right now. Split it once it is ready.";
  const length = clipPlayMs(clip);
  const wholeSeconds = kind === "still" || (kind === "generated" && !isMade(clip));
  if (wholeSeconds) {
    const first = Math.round(offsetMs / 1000);
    if (first < 1 || clip.durationSeconds - first < 1) {
      return kind === "still"
        ? "A photo is split in whole seconds, and each part needs at least 1 second. Move the playhead."
        : "An AI shot that isn't made yet is split in whole seconds, and each part needs at least 1 second. Move the playhead.";
    }
    return null;
  }
  if (offsetMs < MIN_CLIP_MS || length - offsetMs < MIN_CLIP_MS) return "Move the playhead a little further from the clip's edges: each part needs at least half a second.";
  return null;
}

// ─── Order ────────────────────────────────────────────────────────────────

/** The new play order after dragging `id` in front of `beforeId` (null = to the end). */
export function moveBefore(order: readonly string[], id: string, beforeId: string | null): string[] {
  if (id === beforeId) return [...order];
  const rest = order.filter((x) => x !== id);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  rest.splice(at < 0 ? rest.length : at, 0, id);
  return rest;
}

/** One place earlier (-1) or later (+1); the same order when it can't move. */
export function nudgeOrder(order: readonly string[], id: string, delta: -1 | 1): string[] {
  const i = order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return [...order];
  const next = [...order];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

// ─── Music ────────────────────────────────────────────────────────────────

export interface TimelineMusic {
  musicAssetId: string | null;
  fileName: string | null;
  trimInMs: number;
  trimOutMs: number | null;
  offsetMs: number;
  fadeInMs: number;
  fadeOutMs: number;
}

/** Where the music plays: from its start in the film to the end (it repeats when shorter), with its fades. */
export function musicSpan(music: TimelineMusic | null | undefined, totalMs: number): { startMs: number; endMs: number; fadeInMs: number; fadeOutMs: number } | null {
  if (!music?.musicAssetId) return null;
  const startMs = clampMs(music.offsetMs, totalMs);
  const endMs = Math.max(startMs, totalMs);
  const length = endMs - startMs;
  return { startMs, endMs, fadeInMs: Math.min(music.fadeInMs, length), fadeOutMs: Math.min(music.fadeOutMs, length) };
}

// ─── Preview ──────────────────────────────────────────────────────────────

export type PreviewSource =
  | { kind: "video"; src: string; timeSeconds: number }
  | { kind: "image"; src: string }
  | { kind: "title"; text: string }
  | { kind: "empty"; text: string };

/** What the preview shows at the playhead: the clip's video at that moment, else its picture, else its description. */
export function previewAt(layout: TimelineLayout, ms: number, apiBase: string): PreviewSource {
  const found = itemAt(layout, ms);
  if (!found) return { kind: "empty", text: "Nothing on the timeline yet." };
  const { item, offsetMs } = found;
  if (item.type === "title") return { kind: "title", text: item.text };
  if (item.type === "bridge") return { kind: "empty", text: "AI bridge between two clips (shown in the finished film)." };
  const clip = item.clip;
  const kind = clipKindOf(clip);
  if (kind === "uploaded_video" && clip.hasClip && clip.status === "done") {
    // Your video's prepared clip is already cut to its trim.
    return { kind: "video", src: `${apiBase}/shots/${clip.shotId}/clip`, timeSeconds: offsetMs / 1000 };
  }
  if (kind === "uploaded_video" && clip.upload) {
    return { kind: "video", src: `${apiBase}/uploads/${clip.upload.id}/preview`, timeSeconds: ((clip.trimInMs ?? 0) + offsetMs) / 1000 };
  }
  if (kind === "generated" && isMade(clip)) {
    return { kind: "video", src: `${apiBase}/shots/${clip.shotId}/clip`, timeSeconds: ((clip.trimInMs ?? 0) + offsetMs) / 1000 };
  }
  if (clip.hasPoster) return { kind: "image", src: `${apiBase}/shots/${clip.shotId}/poster` };
  return { kind: "empty", text: clip.prompt || "No picture yet." };
}

/** Plain status words for a clip. */
export function clipStatusText(clip: TimelineClip): string {
  const kind = clipKindOf(clip);
  if (kind !== "generated") {
    if (clip.status === "queued" || clip.status === "rendering") return "Getting ready";
    if (clip.status === "failed") return "Needs a look";
    return "Ready";
  }
  switch (clip.status) {
    case "done":
      return "Made";
    case "queued":
      return "Waiting to be made";
    case "rendering":
      return "Being made";
    case "failed":
      return "Failed";
    default:
      return "Not made yet";
  }
}

export function clipLabel(clip: TimelineClip): string {
  const kind = clipKindOf(clip);
  const n = clip.orderIndex + 1;
  return kind === "generated" ? `Shot ${n}` : kind === "uploaded_video" ? `Your video ${n}` : `Photo ${n}`;
}
