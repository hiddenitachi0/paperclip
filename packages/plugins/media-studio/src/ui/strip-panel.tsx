import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, friendlyStorylineError, storylineFetchJson } from "./storyline-api.js";

// Storyline strip (Simple editor, Phase 1; design 2.1): the film as a row of
// clip cards with a transition tile in every gap, and an inspector for the
// selected transition. Talks to /video-storylines/:id/strip and
// /transitions. Standalone ES module (see index.tsx's note): local types and
// styles, no imports from @paperclipai/shared.
//
// Phase 2 (design 2.5-2.7): your own videos and photos as clips (upload,
// trim, hold / slow zoom / animate, consent ticks), drag to reorder, a
// Timeline view with a time ruler and the music lane, and export (picture
// shape, presets, Advanced folded away, title cards, Export again).

type Kind =
  | "cut"
  | "blend"
  | "dissolve"
  | "fade"
  | "ai"
  | "fade_black"
  | "fade_white"
  | "wipe_left"
  | "wipe_right"
  | "slide_left"
  | "slide_right"
  | "circle_open"
  | "zoom_in"
  | "pixelize"
  | "radial";
type AudioMode = "ambient" | "silent" | "bed_only";

export interface StripTake {
  id: string;
  status: "generating" | "ready" | "failed";
  provider: string;
  model: string;
  durationMs: number;
  costCents: number | null;
  reservedCents: number;
  note: string | null;
  error: string | null;
  current: boolean;
  createdAt: string;
}

export interface StripGap {
  id: string | null;
  fromShotId: string;
  toShotId: string;
  kind: Kind;
  aiStyle: string | null;
  durationMs: number;
  plainLine: string | null;
  prompt: string | null;
  userNote: string | null;
  suggestedKind: Kind | null;
  suggestReason: string | null;
  keepSame: { face: boolean; clothes: boolean; location: boolean };
  audioMode: AudioMode;
  model: string | null;
  locked: boolean;
  chosenTakeId: string | null;
  state: "default" | "suggested" | "generating" | "ready" | "failed" | "out_of_date" | "needs_making";
  suggestionOutdated: boolean;
  textOnlyReason: string | null;
  takes: StripTake[];
}

export interface StripModel {
  provider: string;
  model: string;
  label: string;
  minSeconds: number;
  maxSeconds: number;
  centsPerSecond: number;
  soundCentsPerSecond: number | null;
  soundIsFree: boolean;
  note: string;
}

export type ClipKind = "generated" | "uploaded_video" | "still";

export interface StripUpload {
  id: string;
  kind: "video" | "photo";
  status: "processing" | "ready" | "failed";
  fileName: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  byteSize: number;
  wasHdr: boolean;
  wasVariableFrameRate: boolean;
  hasAudio: boolean;
  showsPeople: boolean;
  consentLikeness: boolean;
  consentAdults: boolean;
  error: string | null;
  inUse: boolean;
  createdAt: string;
}

export interface StripClip {
  shotId: string;
  orderIndex: number;
  prompt: string;
  cameraNotes: string | null;
  durationSeconds: number;
  status: string;
  hasClip: boolean;
  hasPoster: boolean;
  clipKind?: ClipKind;
  upload?: StripUpload | null;
  trimInMs?: number | null;
  trimOutMs?: number | null;
  stillMotion?: "hold" | "slow_zoom" | null;
  muted?: boolean;
  volumeDb?: number;
  animateQuoteCents?: number | null;
  errorMessage?: string | null;
}

export type Aspect = "16:9" | "9:16" | "1:1";
export type PresetId = "youtube_16_9" | "reels_9_16" | "square_1_1";

export interface StripExportSettings {
  preset: PresetId;
  fps: 16 | 24 | 25 | 30 | 60;
  fit: "fill" | "fit";
  endFrame: "keep" | "trim";
  quality: "standard" | "high";
  opening: { text: string; seconds: number } | null;
  credits: { text: string; seconds: number } | null;
}

export interface StripMusic {
  musicAssetId: string | null;
  fileName: string | null;
  trimInMs: number;
  trimOutMs: number | null;
  offsetMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  volumeDb: number;
  audioMode: "mix" | "replace";
}

export interface StripFootageSettings {
  storageQuotaBytes: number;
  maxVideoMb: number;
  maxPhotoMb: number;
  maxVideoSeconds: number;
  cleanupDays: number;
  neverSendUploadsToSogni: boolean;
}

export interface StripSummary {
  storylineId: string;
  providerId: string;
  status: string;
  clips: StripClip[];
  gaps: StripGap[];
  models: StripModel[];
  defaultModel: string;
  budget: { capCents: number | null; spentCents: number };
  monthly: { capCents: number; spentCents: number; explanation: string };
  writerProblem: string | null;
  readerLabel: string | null;
  readerProblem: string | null;
  combineProblems: string[];
  canCombineAgain: boolean;
  // Phase 2 (optional so an older server's answer still renders).
  aspect?: Aspect;
  aspectLocked?: boolean;
  exportSettings?: StripExportSettings;
  presets?: Array<{ id: PresetId; label: string; aspect: Aspect; width: number; height: number }>;
  exportWarnings?: string[];
  music?: StripMusic;
  uploads?: StripUpload[];
  storage?: { usedBytes: number; quotaBytes: number };
  footage?: StripFootageSettings;
  totalSeconds?: number;
}

const KIND_LABEL: Record<Kind, string> = {
  cut: "Cut",
  blend: "Smooth blend",
  dissolve: "Grainy dissolve",
  fade: "Soft fade",
  ai: "AI bridge",
  fade_black: "Fade through black",
  fade_white: "Fade through white",
  wipe_left: "Wipe to the left",
  wipe_right: "Wipe to the right",
  slide_left: "Slide to the left",
  slide_right: "Slide to the right",
  circle_open: "Circle opening",
  zoom_in: "Zoom in",
  pixelize: "Pixelate",
  radial: "Clock wipe",
};
/** The free ffmpeg transitions offered under "More…" (no AI, no cost). */
export const MORE_TRANSITIONS: Kind[] = ["fade", "dissolve", "fade_black", "fade_white", "wipe_left", "wipe_right", "slide_left", "slide_right", "circle_open", "zoom_in", "pixelize", "radial"];
const CLIP_KIND_LABEL: Record<ClipKind, string> = { generated: "AI shot", uploaded_video: "Your video", still: "Photo" };
const ASPECT_LABEL: Record<Aspect, string> = { "16:9": "Wide 16:9 (YouTube, TV)", "9:16": "Tall 9:16 (Reels, TikTok, Shorts)", "1:1": "Square 1:1" };
const DEFAULT_PRESETS: NonNullable<StripSummary["presets"]> = [
  { id: "youtube_16_9", label: "YouTube 16:9 1080p", aspect: "16:9", width: 1920, height: 1080 },
  { id: "reels_9_16", label: "Reels / TikTok 9:16", aspect: "9:16", width: 1080, height: 1920 },
  { id: "square_1_1", label: "Square 1:1", aspect: "1:1", width: 1080, height: 1080 },
];
const STATE_LABEL: Record<StripGap["state"], string> = {
  default: "",
  suggested: "Suggested",
  generating: "Generating…",
  ready: "Ready",
  failed: "Failed",
  out_of_date: "Out of date",
  needs_making: "Not made yet",
};
const SHOT_STATUS: Record<string, string> = { draft: "draft", queued: "waiting", rendering: "rendering", done: "done", failed: "failed" };

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };
const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13, whiteSpace: "pre-line" };
const noticeBox: React.CSSProperties = { background: "#fff9db", color: "#7f5f01", padding: "8px 10px", borderRadius: 8, fontSize: 12 };
const muted: React.CSSProperties = { fontSize: 12, color: "#868e96", margin: 0 };

export function stripDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** What one AI version would cost, the same ballpark the server reserves. */
export function stripTakeCostCents(model: StripModel, seconds: number, audioMode: AudioMode): number {
  const s = Math.min(model.maxSeconds, Math.max(model.minSeconds, Math.round(seconds)));
  const perSecond = audioMode === "ambient" && model.soundIsFree && model.soundCentsPerSecond !== null ? model.soundCentsPerSecond : model.centsPerSecond;
  return Math.ceil(s * perSecond);
}

/** The new play order after dragging `id` in front of `beforeId` (null = to the end). */
export function stripMoveClip(order: readonly string[], id: string, beforeId: string | null): string[] {
  if (id === beforeId) return [...order];
  const rest = order.filter((x) => x !== id);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  rest.splice(at < 0 ? rest.length : at, 0, id);
  return rest;
}

/** m:ss for the time ruler and the music lane. */
export function stripClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Ruler tick spacing so a film shows about 6-12 labels. */
export function stripRulerStep(totalSeconds: number): number {
  for (const step of [1, 2, 5, 10, 15, 30, 60, 120, 300]) if (totalSeconds / step <= 12) return step;
  return 600;
}

function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Uploads a file to the storyline (multipart), with plain-English errors. */
async function uploadFootage(apiBase: string, file: File, consent: { showsPeople: boolean; consentLikeness: boolean; consentAdults: boolean }): Promise<StripUpload> {
  const form = new FormData();
  form.append("showsPeople", String(consent.showsPeople));
  form.append("consentLikeness", String(consent.consentLikeness));
  form.append("consentAdults", String(consent.consentAdults));
  form.append("file", file);
  let res: Response;
  try {
    res = await fetch(`${apiBase}/uploads`, { method: "POST", credentials: "include", body: form });
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  if (!res.ok) throw friendlyStorylineError(res.status, await res.text().catch(() => ""), "uploading the file");
  return (await res.json()) as StripUpload;
}

function gapKey(gap: Pick<StripGap, "fromShotId" | "toShotId">): string {
  return `${gap.fromShotId}:${gap.toShotId}`;
}

export function StripPanel(props: { apiBase: string; editable: boolean; onCombineAgain?: () => void | Promise<void> }) {
  const { apiBase, editable } = props;
  const [strip, setStrip] = useState<StripSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [view, setView] = useState<"strip" | "timeline">("strip");
  const [dragging, setDragging] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStrip(await storylineFetchJson<StripSummary>(`${apiBase}/strip`, undefined, "loading the strip"));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a version is being made, or your own clips are being got ready, check every few seconds.
  const working =
    (strip?.gaps.some((g) => g.state === "generating") ?? false) ||
    (strip?.clips.some((c) => c.status === "queued" || c.status === "rendering") ?? false) ||
    ((strip?.uploads ?? []).some((u) => u.status === "processing") ?? false);
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [working, load]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await load();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (!strip) {
    return (
      <div style={card} data-testid="strip-panel">
        <strong style={{ fontSize: 14 }}>Strip</strong>
        {error ? <div style={errorBox}>{error}</div> : <p style={muted}>Loading the strip…</p>}
      </div>
    );
  }

  const clipsById = new Map(strip.clips.map((c) => [c.shotId, c]));
  const gap = strip.gaps.find((g) => gapKey(g) === selected) ?? null;
  const clip = selectedClip ? clipsById.get(selectedClip) ?? null : null;
  const putGap = (g: StripGap, patch: Record<string, unknown>) =>
    run(() => storylineFetchJson(`${apiBase}/transitions`, { method: "PUT", body: JSON.stringify({ fromShotId: g.fromShotId, toShotId: g.toShotId, ...patch }) }, "saving the transition"));
  const order = strip.clips.map((c) => c.shotId);
  const moveTo = (id: string, beforeId: string | null) => {
    const next = stripMoveClip(order, id, beforeId);
    if (next.join() === order.join()) return;
    void run(() => storylineFetchJson(`${apiBase}/order`, { method: "PUT", body: JSON.stringify({ shotIds: next }) }, "moving the clip"));
  };
  const dragProps = (beforeId: string | null) =>
    editable
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (dragging) e.preventDefault();
          },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            if (dragging) moveTo(dragging, beforeId);
            setDragging(null);
          },
        }
      : {};

  return (
    <div style={card} data-testid="strip-panel">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <strong style={{ fontSize: 14 }}>Strip: your clips and the joins between them</strong>
          <p style={muted}>Click a clip or a join to change it. Drag clips to change their order. Nothing is made or paid for until you press a button that shows its price.</p>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <div role="radiogroup" aria-label="View" style={{ display: "flex", gap: 4 }}>
            {(["strip", "timeline"] as const).map((v) => (
              <button key={v} type="button" role="radio" aria-checked={view === v} style={view === v ? secondaryBtn : ghostBtn} onClick={() => setView(v)} data-testid={`strip-view-${v}`}>
                {v === "strip" ? "Strip" : "Timeline"}
              </button>
            ))}
          </div>
          <button
            type="button"
            style={primaryBtn}
            data-testid="strip-combine-again"
            disabled={busy || !strip.canCombineAgain || !props.onCombineAgain}
            title={strip.canCombineAgain ? undefined : "Every clip must be finished and every AI bridge up to date first."}
            onClick={() => props.onCombineAgain && void run(async () => props.onCombineAgain!())}
          >
            Combine the film again
          </button>
        </div>
      </div>
      {strip.combineProblems.length > 0 && (
        <div style={noticeBox} data-testid="strip-combine-problems">
          The film can't be combined yet:
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {strip.combineProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <div style={errorBox}>{error}</div>}

      {view === "strip" ? (
        <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 6, alignItems: "stretch" }} data-testid="strip-row">
          {strip.clips.map((c, index) => {
            const before = index > 0 ? strip.gaps[index - 1] : undefined;
            return (
              <div key={c.shotId} style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                {before && <GapTile gap={before} selected={selected === gapKey(before)} onSelect={() => { setSelected(gapKey(before)); setSelectedClip(null); }} />}
                <ClipCard
                  clip={c}
                  apiBase={apiBase}
                  playing={playing === c.shotId}
                  selected={selectedClip === c.shotId}
                  draggable={editable}
                  onPlay={() => setPlaying(playing === c.shotId ? null : c.shotId)}
                  onSelect={() => { setSelectedClip(c.shotId); setSelected(null); }}
                  onDragStart={() => setDragging(c.shotId)}
                  onDragEnd={() => setDragging(null)}
                  dropProps={dragProps(c.shotId)}
                />
              </div>
            );
          })}
          {strip.clips.length > 0 && editable && (
            <div data-testid="strip-drop-end" {...dragProps(null)} style={{ width: 40, flexShrink: 0, borderRadius: 8, border: dragging ? "2px dashed #1971c2" : "1px dashed transparent" }} aria-label="Drop here to move to the end" />
          )}
          {strip.clips.length === 0 && <p style={muted}>No clips yet. Write and render some shots, or add your own videos and photos below.</p>}
        </div>
      ) : (
        <TimelineView strip={strip} selectedClip={selectedClip} onSelectClip={(id) => { setSelectedClip(id); setSelected(null); }} />
      )}

      {editable && <AddFootage apiBase={apiBase} strip={strip} busy={busy} run={run} afterShotId={selectedClip ?? order[order.length - 1] ?? null} />}

      {clip && (
        <ClipInspector
          key={`${clip.shotId}:${clip.status}:${clip.clipKind}`}
          clip={clip}
          strip={strip}
          apiBase={apiBase}
          editable={editable}
          busy={busy}
          index={order.indexOf(clip.shotId)}
          onMove={(delta) => {
            const i = order.indexOf(clip.shotId);
            const target = i + delta;
            if (target < 0 || target >= order.length) return;
            moveTo(clip.shotId, delta < 0 ? order[target]! : order[target + 1] ?? null);
          }}
          run={run}
          onRemoved={() => setSelectedClip(null)}
        />
      )}

      {gap && (
        <TransitionInspector
          key={gapKey(gap)}
          gap={gap}
          strip={strip}
          from={clipsById.get(gap.fromShotId)!}
          to={clipsById.get(gap.toShotId)!}
          apiBase={apiBase}
          editable={editable}
          busy={busy}
          onPut={(patch) => void putGap(gap, patch)}
          onSuggest={(body) =>
            void run(() =>
              storylineFetchJson(`${apiBase}/transitions/suggest`, { method: "POST", body: JSON.stringify({ fromShotId: gap.fromShotId, toShotId: gap.toShotId, ...body }) }, "asking the AI for a suggestion"),
            )
          }
          onGenerate={(body) =>
            void run(async () => {
              let id = gap.id;
              if (!id) {
                const saved = await storylineFetchJson<StripGap>(`${apiBase}/transitions`, { method: "PUT", body: JSON.stringify({ fromShotId: gap.fromShotId, toShotId: gap.toShotId, kind: "ai" }) }, "saving the transition");
                id = saved.id;
              }
              await storylineFetchJson(`${apiBase}/transitions/${id}/generate`, { method: "POST", body: JSON.stringify(body) }, "making the transition");
            })
          }
          onUse={(takeId) => void run(() => storylineFetchJson(`${apiBase}/transitions/${gap.id}/takes/${takeId}/use`, { method: "POST", body: "{}" }, "choosing that version"))}
        />
      )}

      {strip.music && <MusicLane apiBase={apiBase} strip={strip} editable={editable} busy={busy} run={run} />}
      {strip.exportSettings && <ExportPanel apiBase={apiBase} strip={strip} editable={editable} busy={busy} run={run} />}
    </div>
  );
}

function clipKindOf(clip: StripClip): ClipKind {
  return clip.clipKind ?? "generated";
}

function ClipCard(props: {
  clip: StripClip;
  apiBase: string;
  playing: boolean;
  selected?: boolean;
  draggable?: boolean;
  onPlay: () => void;
  onSelect?: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  dropProps?: Record<string, unknown>;
}) {
  const { clip } = props;
  const kind = clipKindOf(clip);
  const preparing = kind !== "generated" && (clip.status === "queued" || clip.status === "rendering");
  // Your own video plays its light preview copy; everything else its clip.
  const playSrc = kind === "uploaded_video" && clip.upload ? `${props.apiBase}/uploads/${clip.upload.id}/preview` : `${props.apiBase}/shots/${clip.shotId}/clip`;
  const statusText = preparing ? "getting ready" : clip.status === "failed" ? "needs a look" : SHOT_STATUS[clip.status] ?? clip.status;
  return (
    <div
      data-testid={`strip-clip-${clip.shotId}`}
      draggable={props.draggable}
      onDragStart={(e) => {
        try {
          e.dataTransfer?.setData("text/plain", clip.shotId);
        } catch {
          // Some browsers refuse custom data; the order is tracked in state anyway.
        }
        props.onDragStart?.();
      }}
      onDragEnd={props.onDragEnd}
      {...(props.dropProps ?? {})}
      style={{
        width: 170,
        flexShrink: 0,
        border: props.selected ? "2px solid #1971c2" : "1px solid rgba(128,128,128,0.35)",
        borderRadius: 8,
        padding: 6,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        cursor: props.draggable ? "grab" : "default",
      }}
    >
      {props.playing && clip.hasClip ? (
        <video src={playSrc} controls autoPlay style={{ width: "100%", borderRadius: 6 }} />
      ) : clip.hasPoster ? (
        <img src={`${props.apiBase}/shots/${clip.shotId}/poster`} alt={`Clip ${clip.orderIndex + 1}`} style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 6 }} />
      ) : (
        <div style={{ width: "100%", aspectRatio: "16 / 9", borderRadius: 6, background: "rgba(128,128,128,0.15)" }} />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 4 }}>
        <strong>{kind === "generated" ? "Shot" : "Clip"} {clip.orderIndex + 1}</strong>
        <span style={{ color: "#868e96" }}>
          {clip.durationSeconds} s · {statusText}
        </span>
      </div>
      <span style={{ color: "#868e96", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={clip.prompt}>
        {CLIP_KIND_LABEL[kind]} · {kind === "still" ? (clip.stillMotion === "slow_zoom" ? "slow zoom" : "held still") : clip.prompt}
      </span>
      {clip.muted && <span style={{ color: "#868e96" }}>Sound off</span>}
      <div style={{ display: "flex", gap: 4 }}>
        {clip.hasClip && (
          <button type="button" style={ghostBtn} onClick={props.onPlay} aria-label={`Play clip ${clip.orderIndex + 1}`}>
            {props.playing ? "Stop" : "Play"}
          </button>
        )}
        {props.onSelect && (
          <button type="button" style={ghostBtn} onClick={props.onSelect} data-testid={`strip-clip-edit-${clip.shotId}`}>
            Edit
          </button>
        )}
      </div>
    </div>
  );
}

/** Timeline view: a time ruler, the clips as blocks as long as they play, and the music lane under them. */
function TimelineView(props: { strip: StripSummary; selectedClip: string | null; onSelectClip: (id: string) => void }) {
  const { strip } = props;
  const blocks: Array<{ key: string; label: string; seconds: number; shotId?: string; bridge?: boolean }> = [];
  strip.clips.forEach((c, i) => {
    const before = i > 0 ? strip.gaps[i - 1] : undefined;
    if (before?.kind === "ai") blocks.push({ key: `gap-${before.fromShotId}`, label: "AI bridge", seconds: before.durationMs / 1000, bridge: true });
    blocks.push({ key: c.shotId, label: `${CLIP_KIND_LABEL[clipKindOf(c)]} ${c.orderIndex + 1}`, seconds: c.durationSeconds, shotId: c.shotId });
  });
  const total = Math.max(1, strip.totalSeconds ?? blocks.reduce((s, b) => s + b.seconds, 0));
  const step = stripRulerStep(total);
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += step) ticks.push(t);
  const music = strip.music;
  const musicLeft = music ? Math.min(100, ((music.offsetMs / 1000) / total) * 100) : 0;
  return (
    <div data-testid="strip-timeline" style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
      <div data-testid="timeline-ruler" style={{ position: "relative", height: 16, borderBottom: "1px solid rgba(128,128,128,0.5)" }}>
        {ticks.map((t) => (
          <span key={t} style={{ position: "absolute", left: `${(t / total) * 100}%`, transform: "translateX(-50%)", color: "#868e96" }}>
            {stripClock(t)}
          </span>
        ))}
      </div>
      <div style={{ display: "flex", height: 34 }} aria-label="Clips lane">
        {blocks.map((b) => (
          <button
            key={b.key}
            type="button"
            data-testid={`timeline-block-${b.key}`}
            onClick={() => b.shotId && props.onSelectClip(b.shotId)}
            style={{
              width: `${(b.seconds / total) * 100}%`,
              minWidth: 4,
              border: props.selectedClip === b.shotId ? "2px solid #1971c2" : "1px solid rgba(128,128,128,0.5)",
              background: b.bridge ? "#f3f0ff" : "rgba(25,113,194,0.08)",
              borderRadius: 4,
              overflow: "hidden",
              whiteSpace: "nowrap",
              fontSize: 11,
              color: "inherit",
              padding: "0 4px",
              cursor: b.shotId ? "pointer" : "default",
            }}
            title={`${b.label} · ${b.seconds.toFixed(b.seconds % 1 ? 1 : 0)} s`}
          >
            {b.label}
          </button>
        ))}
      </div>
      <div style={{ position: "relative", height: 26, background: "rgba(128,128,128,0.06)", borderRadius: 4 }} aria-label="Music lane" data-testid="timeline-music-lane">
        {music?.musicAssetId ? (
          <div
            data-testid="timeline-music-block"
            style={{ position: "absolute", left: `${musicLeft}%`, right: 0, top: 2, bottom: 2, background: "#e6fcf5", border: "1px solid #63e6be", borderRadius: 4, padding: "2px 6px", overflow: "hidden", whiteSpace: "nowrap" }}
          >
            ♪ {music.fileName ?? "Music"} · from {stripClock(music.offsetMs / 1000)} · {music.audioMode === "replace" ? "replaces clip sound" : "under clip sound"}
          </div>
        ) : (
          <span style={{ position: "absolute", left: 6, top: 5, color: "#868e96" }}>No music. Pick some below.</span>
        )}
      </div>
    </div>
  );
}

/** Add your own video or photo: consent ticks first when it shows people, then upload; ready uploads can be put in the film. */
function AddFootage(props: { apiBase: string; strip: StripSummary; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void>; afterShotId: string | null }) {
  const { strip } = props;
  const [showsPeople, setShowsPeople] = useState(false);
  const [likeness, setLikeness] = useState(false);
  const [adults, setAdults] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const consentMissing = showsPeople && !(likeness && adults);
  const uploads = strip.uploads ?? [];
  const spare = uploads.filter((u) => !u.inUse);
  const addClip = (uploadId: string) =>
    props.run(() => storylineFetchJson(`${props.apiBase}/clips`, { method: "POST", body: JSON.stringify({ uploadId, ...(props.afterShotId ? { afterShotId: props.afterShotId } : {}) }) }, "adding the clip"));
  const onFile = (file: File) =>
    props.run(async () => {
      const upload = await uploadFootage(props.apiBase, file, { showsPeople, consentLikeness: likeness, consentAdults: adults });
      // Photos are ready at once; videos are converted first and then offered below.
      if (upload.status === "ready") {
        await storylineFetchJson(`${props.apiBase}/clips`, { method: "POST", body: JSON.stringify({ uploadId: upload.id, ...(props.afterShotId ? { afterShotId: props.afterShotId } : {}) }) }, "adding the clip");
      }
      if (fileRef.current) fileRef.current.value = "";
    });
  return (
    <details style={{ fontSize: 12 }} data-testid="add-footage">
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>Add your own video or photo</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
        <p style={muted}>
          Videos up to {strip.footage?.maxVideoMb ?? 300} MB and {Math.round((strip.footage?.maxVideoSeconds ?? 600) / 60)} minutes; photos up to {strip.footage?.maxPhotoMb ?? 20} MB.
          {strip.storage ? ` This company uses ${sizeText(strip.storage.usedBytes)} of ${sizeText(strip.storage.quotaBytes)}.` : ""} Phone HDR colour and uneven frame rates are fixed for you.
        </p>
        <label style={{ display: "flex", gap: 6 }}>
          <input type="checkbox" checked={showsPeople} onChange={(e) => setShowsPeople(e.target.checked)} data-testid="footage-shows-people" />
          It shows real people
        </label>
        {showsPeople && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 18 }}>
            <label style={{ display: "flex", gap: 6 }}>
              <input type="checkbox" checked={likeness} onChange={(e) => setLikeness(e.target.checked)} data-testid="footage-consent-likeness" />
              Everyone shown has agreed to their likeness being used in AI-made video.
            </label>
            <label style={{ display: "flex", gap: 6 }}>
              <input type="checkbox" checked={adults} onChange={(e) => setAdults(e.target.checked)} data-testid="footage-consent-adults" />
              Everyone shown is an adult (18 or older).
            </label>
          </div>
        )}
        <p style={muted}>
          Your clips are only sent to an AI service when you ask for something that needs it (an AI bridge next to them, or animating a photo); before that, every picture is checked for apparent age.
          {strip.footage?.neverSendUploadsToSogni ? " This company never sends your own footage to Sogni." : ""}
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp,image/heic,.mov,.mp4,.heic"
          disabled={props.busy || consentMissing}
          aria-label="Choose a video or photo"
          data-testid="footage-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
          }}
        />
        {consentMissing && <span style={{ color: "#d9480f" }}>Tick both boxes first.</span>}
        {spare.length > 0 && (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }} data-testid="footage-uploads">
            {spare.map((u) => (
              <li key={u.id} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <span>
                  {u.kind === "video" ? "Video" : "Photo"} {u.fileName ? `"${u.fileName}"` : ""} · {u.status === "processing" ? "getting ready…" : u.status === "failed" ? `could not be used: ${u.error ?? ""}` : "ready"}
                  {u.wasHdr ? " · HDR colour fixed" : ""}
                </span>
                {u.status === "ready" && (
                  <button type="button" style={secondaryBtn} disabled={props.busy} onClick={() => void addClip(u.id)} data-testid={`footage-add-${u.id}`}>
                    Add to film
                  </button>
                )}
                <button
                  type="button"
                  style={ghostBtn}
                  disabled={props.busy || u.status === "processing"}
                  onClick={() => void props.run(() => storylineFetchJson(`${props.apiBase}/uploads/${u.id}`, { method: "DELETE" }, "removing the upload"))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

/** One clip: trim (your video), hold / slow zoom / animate (photo), sound, consent, order. */
function ClipInspector(props: {
  clip: StripClip;
  strip: StripSummary;
  apiBase: string;
  editable: boolean;
  busy: boolean;
  index: number;
  onMove: (delta: -1 | 1) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  onRemoved: () => void;
}) {
  const { clip, strip } = props;
  const kind = clipKindOf(clip);
  const disabled = props.busy || !props.editable;
  const upload = clip.upload ?? null;
  const [trimIn, setTrimIn] = useState(((clip.trimInMs ?? 0) / 1000).toFixed(1));
  const [trimOut, setTrimOut] = useState((((clip.trimOutMs ?? clip.durationSeconds * 1000) as number) / 1000).toFixed(1));
  const [hold, setHold] = useState(String(clip.durationSeconds));
  const [prompt, setPrompt] = useState("");
  const [people, setPeople] = useState(upload?.showsPeople ?? false);
  const [likeness, setLikeness] = useState(upload?.consentLikeness ?? false);
  const [adults, setAdults] = useState(upload?.consentAdults ?? false);
  const patch = (body: Record<string, unknown>, doing: string) =>
    void props.run(() => storylineFetchJson(`${props.apiBase}/clips/${clip.shotId}`, { method: "PATCH", body: JSON.stringify(body) }, doing));
  const quote = clip.animateQuoteCents ?? null;
  const sogniBlocked = strip.providerId === "sogni" && strip.footage?.neverSendUploadsToSogni;
  return (
    <div style={{ ...card, background: "rgba(128,128,128,0.04)" }} data-testid="clip-inspector">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>
          {CLIP_KIND_LABEL[kind]} {clip.orderIndex + 1}
          {upload?.fileName ? ` · ${upload.fileName}` : ""}
        </strong>
        <div style={{ display: "flex", gap: 4 }}>
          <button type="button" style={ghostBtn} disabled={disabled || props.index <= 0} onClick={() => props.onMove(-1)} data-testid="clip-move-earlier">
            ← Earlier
          </button>
          <button type="button" style={ghostBtn} disabled={disabled || props.index >= strip.clips.length - 1} onClick={() => props.onMove(1)} data-testid="clip-move-later">
            Later →
          </button>
        </div>
      </div>
      {clip.errorMessage && <div style={noticeBox}>{clip.errorMessage}</div>}

      {kind === "uploaded_video" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }} data-testid="clip-trim">
          <label>
            Start at (s){" "}
            <input style={{ ...input, width: 70 }} type="number" min={0} step={0.1} value={trimIn} disabled={disabled} onChange={(e) => setTrimIn(e.target.value)} aria-label="Start at (seconds)" />
          </label>
          <label>
            End at (s){" "}
            <input style={{ ...input, width: 70 }} type="number" min={0} step={0.1} value={trimOut} disabled={disabled} onChange={(e) => setTrimOut(e.target.value)} aria-label="End at (seconds)" />
          </label>
          <button
            type="button"
            style={secondaryBtn}
            disabled={disabled}
            data-testid="clip-save-trim"
            onClick={() => patch({ trimInMs: Math.round(Number(trimIn) * 1000), trimOutMs: Math.round(Number(trimOut) * 1000) }, "saving the trim")}
          >
            Save trim
          </button>
          {upload?.durationMs ? <span style={muted}>The video is {(upload.durationMs / 1000).toFixed(1)} s long; a clip can be up to 60 s.</span> : null}
        </div>
      )}

      {kind === "still" && (
        <>
          <div role="radiogroup" aria-label="How the photo moves" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
            {(["hold", "slow_zoom"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={(clip.stillMotion ?? "hold") === m}
                style={(clip.stillMotion ?? "hold") === m ? primaryBtn : ghostBtn}
                disabled={disabled}
                data-testid={`clip-motion-${m}`}
                onClick={() => patch({ stillMotion: m }, "saving the photo motion")}
              >
                {m === "hold" ? "Hold still" : "Slow zoom"}
              </button>
            ))}
            <label>
              Show for (s){" "}
              <input style={{ ...input, width: 60 }} type="number" min={1} max={60} value={hold} disabled={disabled} onChange={(e) => setHold(e.target.value)} onBlur={() => Number(hold) !== clip.durationSeconds && patch({ holdSeconds: Math.round(Number(hold)) }, "saving the length")} aria-label="Show for (seconds)" />
            </label>
            <span style={muted}>Free: made on the server.</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }} data-testid="clip-animate">
            <strong>Animate with AI</strong>
            <textarea style={{ ...input, minHeight: 40 }} placeholder="What should move? e.g. The waves roll in slowly, the camera drifts left." value={prompt} disabled={disabled} onChange={(e) => setPrompt(e.target.value)} aria-label="What should move" />
            {sogniBlocked && <span style={{ color: "#d9480f" }}>This storyline uses Sogni, and this company never sends your own footage to Sogni, so it can't be animated here.</span>}
            <button
              type="button"
              style={primaryBtn}
              disabled={disabled || !prompt.trim() || quote === null || Boolean(sogniBlocked)}
              data-testid="clip-animate-button"
              onClick={() =>
                void props.run(() => storylineFetchJson(`${props.apiBase}/clips/${clip.shotId}/animate`, { method: "POST", body: JSON.stringify({ prompt: prompt.trim(), confirmCostCents: quote ?? 0 }) }, "animating the photo"))
              }
            >
              Animate (about {stripDollars(quote ?? 0)})
            </button>
            <span style={muted}>
              Turns the photo into an AI shot that starts on this picture. The cost is held against this film's budget and this company's monthly limit before anything is made. The photo is age-checked first.
            </span>
          </div>
        </>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }} data-testid="clip-sound">
        <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={clip.muted ?? false} disabled={disabled} onChange={(e) => patch({ muted: e.target.checked }, "saving the sound")} data-testid="clip-mute" />
          Mute this clip
        </label>
        <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
          Volume
          <input type="range" min={-30} max={12} step={1} defaultValue={clip.volumeDb ?? 0} disabled={disabled || clip.muted} onMouseUp={(e) => patch({ volumeDb: Number((e.target as HTMLInputElement).value) }, "saving the volume")} onKeyUp={(e) => patch({ volumeDb: Number((e.target as HTMLInputElement).value) }, "saving the volume")} aria-label="Clip volume" data-testid="clip-volume" />
          {clip.volumeDb ?? 0} dB
        </label>
      </div>

      {upload && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }} data-testid="clip-consent">
          <label style={{ display: "flex", gap: 6 }}>
            <input type="checkbox" checked={people} disabled={disabled} onChange={(e) => setPeople(e.target.checked)} />
            It shows real people
          </label>
          {people && (
            <>
              <label style={{ display: "flex", gap: 6, paddingLeft: 18 }}>
                <input type="checkbox" checked={likeness} disabled={disabled} onChange={(e) => setLikeness(e.target.checked)} />
                Everyone shown has agreed to their likeness being used in AI-made video.
              </label>
              <label style={{ display: "flex", gap: 6, paddingLeft: 18 }}>
                <input type="checkbox" checked={adults} disabled={disabled} onChange={(e) => setAdults(e.target.checked)} />
                Everyone shown is an adult (18 or older).
              </label>
            </>
          )}
          <button
            type="button"
            style={{ ...ghostBtn, alignSelf: "flex-start" }}
            disabled={disabled || (people && !(likeness && adults))}
            onClick={() =>
              void props.run(() =>
                storylineFetchJson(`${props.apiBase}/uploads/${upload.id}/consent`, { method: "PATCH", body: JSON.stringify({ showsPeople: people, consentLikeness: people && likeness, consentAdults: people && adults }) }, "saving the ticks"),
              )
            }
          >
            Save ticks
          </button>
        </div>
      )}

      {(kind !== "generated" || upload) && (
        <button
          type="button"
          style={{ ...ghostBtn, alignSelf: "flex-start", color: "#c92a2a" }}
          disabled={disabled}
          data-testid="clip-remove"
          onClick={() =>
            void props.run(async () => {
              await storylineFetchJson(`${props.apiBase}/clips/${clip.shotId}`, { method: "DELETE" }, "removing the clip");
              props.onRemoved();
            })
          }
        >
          Remove from film
        </button>
      )}
    </div>
  );
}

/** The music lane: pick a file (including music made in Media Studio), trim, start, fades, volume, mix or replace. */
function MusicLane(props: { apiBase: string; strip: StripSummary; editable: boolean; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const music = props.strip.music!;
  const disabled = props.busy || !props.editable;
  const companyBase = props.apiBase.replace(/\/[^/]+$/, "");
  const [choices, setChoices] = useState<Array<{ id: string; name: string; source: string }> | null>(null);
  const [form, setForm] = useState({
    trimIn: (music.trimInMs / 1000).toString(),
    trimOut: music.trimOutMs === null ? "" : (music.trimOutMs / 1000).toString(),
    offset: (music.offsetMs / 1000).toString(),
    fadeIn: (music.fadeInMs / 1000).toString(),
    fadeOut: (music.fadeOutMs / 1000).toString(),
    volume: music.volumeDb,
  });
  const save = (body: Record<string, unknown>) => void props.run(() => storylineFetchJson(`${props.apiBase}/music`, { method: "PATCH", body: JSON.stringify(body) }, "saving the music"));
  const loadChoices = () =>
    void storylineFetchJson<Array<{ id: string; name: string; source: string }>>(`${companyBase}/music-choices`, undefined, "loading music")
      .then(setChoices)
      .catch(() => setChoices([]));
  const ms = (v: string) => Math.max(0, Math.round(Number(v || 0) * 1000));
  return (
    <details style={{ fontSize: 12 }} data-testid="music-lane" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && choices === null && loadChoices()}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>Music: {music.fileName ?? "none"}</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <select
            style={{ ...input, padding: 6 }}
            aria-label="Pick music"
            data-testid="music-pick"
            disabled={disabled}
            value=""
            onChange={(e) => e.target.value && save({ musicFileId: e.target.value === "none" ? null : e.target.value })}
          >
            <option value="">{choices === null ? "Pick music…" : choices.length === 0 ? "No music files yet" : "Pick music…"}</option>
            {(choices ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.source === "media_studio" ? " (Media Studio)" : ""}
              </option>
            ))}
            {music.musicAssetId && <option value="none">No music</option>}
          </select>
          <label style={{ ...ghostBtn, display: "inline-block" }}>
            Upload music…
            <input
              type="file"
              accept="audio/*"
              style={{ display: "none" }}
              disabled={disabled}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                void props.run(async () => {
                  const body = new FormData();
                  body.append("file", f);
                  const res = await fetch(`${companyBase}/music-files`, { method: "POST", credentials: "include", body });
                  if (!res.ok) throw friendlyStorylineError(res.status, await res.text().catch(() => ""), "uploading the music");
                  const chosen = (await res.json()) as { id: string };
                  await storylineFetchJson(`${props.apiBase}/music`, { method: "PATCH", body: JSON.stringify({ musicFileId: chosen.id }) }, "saving the music");
                  setChoices(null);
                });
              }}
            />
          </label>
        </div>
        {music.musicAssetId && (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {([
                ["trimIn", "Music from (s)"],
                ["trimOut", "Music to (s, empty = end)"],
                ["offset", "Starts in the film at (s)"],
                ["fadeIn", "Fade in (s)"],
                ["fadeOut", "Fade out (s)"],
              ] as const).map(([key, label]) => (
                <label key={key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {label}
                  <input style={{ ...input, width: 90 }} type="number" min={0} step={0.1} value={form[key]} disabled={disabled} aria-label={label} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
                </label>
              ))}
              <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                Volume ({form.volume} dB)
                <input type="range" min={-40} max={0} step={1} value={form.volume} disabled={disabled} aria-label="Music volume" onChange={(e) => setForm({ ...form, volume: Number(e.target.value) })} />
              </label>
            </div>
            <div role="radiogroup" aria-label="Music and clip sound" style={{ display: "flex", gap: 6 }}>
              {(["mix", "replace"] as const).map((mode) => (
                <button key={mode} type="button" role="radio" aria-checked={music.audioMode === mode} style={music.audioMode === mode ? primaryBtn : ghostBtn} disabled={disabled} data-testid={`music-mode-${mode}`} onClick={() => save({ audioMode: mode })}>
                  {mode === "mix" ? "Mix under clip sound" : "Replace clip sound"}
                </button>
              ))}
            </div>
            <button
              type="button"
              style={{ ...secondaryBtn, alignSelf: "flex-start" }}
              disabled={disabled}
              data-testid="music-save"
              onClick={() =>
                save({
                  trimInMs: ms(form.trimIn),
                  trimOutMs: form.trimOut.trim() === "" ? null : ms(form.trimOut),
                  offsetMs: ms(form.offset),
                  fadeInMs: Math.min(30_000, ms(form.fadeIn)),
                  fadeOutMs: Math.min(30_000, ms(form.fadeOut)),
                  volumeDb: form.volume,
                })
              }
            >
              Save music settings
            </button>
            <p style={muted}>The music repeats if it is shorter than the film. Each clip's own sound can be muted or turned up or down on the clip.</p>
          </>
        )}
      </div>
    </details>
  );
}

/** Export: the picture shape (before anything is made), presets, Advanced folded away, title cards, Export again. */
function ExportPanel(props: { apiBase: string; strip: StripSummary; editable: boolean; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const { strip } = props;
  const settings = strip.exportSettings!;
  const presets = strip.presets ?? DEFAULT_PRESETS;
  const disabled = props.busy || !props.editable;
  const [draft, setDraft] = useState<StripExportSettings>(settings);
  const [opening, setOpening] = useState(settings.opening?.text ?? "");
  const [credits, setCredits] = useState(settings.credits?.text ?? "");
  const body = (): Record<string, unknown> => ({
    preset: draft.preset,
    fps: draft.fps,
    fit: draft.fit,
    endFrame: draft.endFrame,
    quality: draft.quality,
    opening: opening.trim() ? { text: opening.trim(), seconds: draft.opening?.seconds ?? 3 } : null,
    credits: credits.trim() ? { text: credits.trim(), seconds: draft.credits?.seconds ?? 5 } : null,
  });
  const canExport = strip.canCombineAgain;
  return (
    <div style={{ ...card, background: "rgba(128,128,128,0.03)" }} data-testid="export-panel">
      <strong style={{ fontSize: 13 }}>Picture shape and export</strong>
      <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        Picture shape
        <select
          style={{ ...input, padding: 6 }}
          value={strip.aspect ?? "16:9"}
          disabled={disabled || strip.aspectLocked}
          data-testid="export-aspect"
          aria-label="Picture shape"
          onChange={(e) => void props.run(() => storylineFetchJson(`${props.apiBase}/aspect`, { method: "PUT", body: JSON.stringify({ aspect: e.target.value }) }, "saving the picture shape"))}
        >
          {(Object.keys(ASPECT_LABEL) as Aspect[]).map((a) => (
            <option key={a} value={a}>
              {ASPECT_LABEL[a]}
            </option>
          ))}
        </select>
        <span style={muted}>
          {strip.aspectLocked ? "Fixed: AI pictures and clips have already been made in this shape." : "Choose it before anything is made; the AI makes every picture and clip in this shape."}
        </span>
      </label>
      <div role="radiogroup" aria-label="Export preset" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {presets.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={draft.preset === p.id} style={draft.preset === p.id ? primaryBtn : ghostBtn} disabled={disabled} data-testid={`export-preset-${p.id}`} onClick={() => setDraft({ ...draft, preset: p.id })}>
            {p.label}
          </button>
        ))}
      </div>
      {(strip.exportWarnings ?? []).map((w) => (
        <div key={w} style={noticeBox} data-testid="export-warning">
          {w}
        </div>
      ))}
      <details style={{ fontSize: 12 }} data-testid="export-advanced">
        <summary style={{ cursor: "pointer" }}>Advanced</summary>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
          <label>
            Frames per second{" "}
            <select style={{ ...input, padding: 4 }} value={draft.fps} disabled={disabled} aria-label="Frames per second" onChange={(e) => setDraft({ ...draft, fps: Number(e.target.value) as StripExportSettings["fps"] })}>
              {[16, 24, 25, 30, 60].map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label>
            Pictures that don't fit{" "}
            <select style={{ ...input, padding: 4 }} value={draft.fit} disabled={disabled} aria-label="Fill or fit" onChange={(e) => setDraft({ ...draft, fit: e.target.value as "fill" | "fit" })}>
              <option value="fit">Fit (show all, bars if needed)</option>
              <option value="fill">Fill (crop the edges)</option>
            </select>
          </label>
          <label>
            End frame{" "}
            <select style={{ ...input, padding: 4 }} value={draft.endFrame} disabled={disabled} aria-label="End frame" onChange={(e) => setDraft({ ...draft, endFrame: e.target.value as "keep" | "trim" })}>
              <option value="keep">Keep</option>
              <option value="trim">Trim (drop the repeated picture between AI shots)</option>
            </select>
          </label>
          <label>
            Quality{" "}
            <select style={{ ...input, padding: 4 }} value={draft.quality} disabled={disabled} aria-label="Quality" onChange={(e) => setDraft({ ...draft, quality: e.target.value as "standard" | "high" })}>
              <option value="standard">Standard (faster)</option>
              <option value="high">High (slower, cleaner)</option>
            </select>
          </label>
        </div>
      </details>
      <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        Title card at the start (optional)
        <input style={input} value={opening} maxLength={200} disabled={disabled} onChange={(e) => setOpening(e.target.value)} placeholder="e.g. Summer at the lake" data-testid="export-opening" />
      </label>
      <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        Credits at the end (optional, one line each)
        <textarea style={{ ...input, minHeight: 50 }} value={credits} maxLength={1500} disabled={disabled} onChange={(e) => setCredits(e.target.value)} placeholder={"Filmed by Anna\nMusic: Media Studio"} data-testid="export-credits" />
      </label>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" style={secondaryBtn} disabled={disabled} data-testid="export-save" onClick={() => void props.run(() => storylineFetchJson(`${props.apiBase}/export-settings`, { method: "PATCH", body: JSON.stringify(body()) }, "saving the export settings"))}>
          Save export settings
        </button>
        <button
          type="button"
          style={primaryBtn}
          disabled={disabled || !canExport}
          title={canExport ? undefined : "The film must be finished first (every clip ready, every AI bridge up to date)."}
          data-testid="export-again"
          onClick={() => void props.run(() => storylineFetchJson(`${props.apiBase}/export`, { method: "POST", body: JSON.stringify({ settings: body() }) }, "exporting the film"))}
        >
          Export again (free, no re-rendering)
        </button>
      </div>
    </div>
  );
}

function GapTile(props: { gap: StripGap; selected: boolean; onSelect: () => void }) {
  const { gap } = props;
  const stale = gap.state === "out_of_date" || gap.state === "failed";
  const seconds = gap.kind === "cut" ? "" : ` · ${(gap.durationMs / 1000).toFixed(gap.durationMs % 1000 === 0 ? 0 : 1)} s`;
  return (
    <button
      type="button"
      data-testid={`strip-gap-${gap.fromShotId}`}
      onClick={props.onSelect}
      aria-pressed={props.selected}
      style={{
        width: 96,
        flexShrink: 0,
        borderRadius: 8,
        cursor: "pointer",
        padding: 6,
        fontSize: 11,
        textAlign: "left",
        color: "inherit",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 2,
        border: props.selected ? "2px solid #1971c2" : `1px dashed ${stale ? "#e8590c" : "rgba(128,128,128,0.6)"}`,
        background: gap.kind === "ai" ? "#f3f0ff" : "transparent",
      }}
    >
      <strong>
        {KIND_LABEL[gap.kind]}
        {seconds}
      </strong>
      {gap.locked && <span>Locked</span>}
      {STATE_LABEL[gap.state] && <span style={{ color: stale ? "#d9480f" : "#868e96" }}>{STATE_LABEL[gap.state]}</span>}
      {gap.kind === "ai" && gap.plainLine && <span style={{ color: "#5f3dc4", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{gap.plainLine}</span>}
    </button>
  );
}

function TransitionInspector(props: {
  gap: StripGap;
  strip: StripSummary;
  from: StripClip;
  to: StripClip;
  apiBase: string;
  editable: boolean;
  busy: boolean;
  onPut: (patch: Record<string, unknown>) => void;
  onSuggest: (body: { plainLine?: string; note?: string }) => void;
  onGenerate: (body: { note?: string; confirmCostCents: number }) => void;
  onUse: (takeId: string) => void;
}) {
  const { gap, strip } = props;
  const [plainLine, setPlainLine] = useState(gap.plainLine ?? "");
  const [prompt, setPrompt] = useState(gap.prompt ?? "");
  const [note, setNote] = useState("");
  const [playingTake, setPlayingTake] = useState<string | null>(null);
  const model = strip.models.find((m) => m.model === (gap.model ?? strip.defaultModel)) ?? strip.models[0] ?? null;
  const disabled = props.busy || !props.editable;
  const lockedOut = disabled || gap.locked;
  const isBlend = gap.kind === "blend" || MORE_TRANSITIONS.includes(gap.kind);
  const [seconds, setSeconds] = useState(gap.durationMs / 1000);
  const commitLength = (value: number) => {
    if (Math.round(value * 1000) !== gap.durationMs) props.onPut({ durationMs: Math.round(value * 1000) });
  };
  const costCents = model ? stripTakeCostCents(model, seconds, gap.audioMode) : null;
  const hasTake = gap.takes.length > 0;
  const generatingNow = gap.state === "generating";

  return (
    <div style={{ ...card, background: "rgba(128,128,128,0.04)" }} data-testid="transition-inspector">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>
          From shot {props.from.orderIndex + 1} to shot {props.to.orderIndex + 1}
        </strong>
        <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={gap.locked} disabled={disabled} onChange={(e) => props.onPut({ locked: e.target.checked })} data-testid="transition-lock" />
          Lock (never changed by suggestions)
        </label>
      </div>

      {gap.state === "out_of_date" && (
        <div style={noticeBox} data-testid="transition-out-of-date">
          A clip next to this join changed, so this AI bridge no longer fits. Make it again, or switch to Cut or Smooth blend. The film can't be combined until you do.
        </div>
      )}
      {gap.textOnlyReason && <p style={{ ...muted, color: "#7f5f01" }} data-testid="transition-text-only">{gap.textOnlyReason}</p>}
      {gap.suggestionOutdated && <p style={muted}>The clips changed since this suggestion was written. Ask again for a fresh one.</p>}

      {/* 1. What happens */}
      <label style={{ fontSize: 12, fontWeight: 600 }} htmlFor={`what-${gap.fromShotId}`}>
        What happens
      </label>
      <textarea
        id={`what-${gap.fromShotId}`}
        style={{ ...input, minHeight: 50 }}
        value={plainLine}
        placeholder="Ask the AI for a suggestion, or write what should happen between the two clips."
        disabled={lockedOut}
        onChange={(e) => setPlainLine(e.target.value)}
        data-testid="transition-plain-line"
      />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          style={secondaryBtn}
          disabled={lockedOut || Boolean(strip.writerProblem)}
          data-testid="transition-suggest"
          onClick={() => props.onSuggest(plainLine.trim() && plainLine !== gap.plainLine ? { plainLine } : {})}
        >
          {gap.plainLine ? (plainLine !== gap.plainLine ? "Rewrite the AI prompt from my sentence" : "Ask the AI again") : "Let the AI look at this join"}
        </button>
        <span style={muted}>
          Uses this company's own AI{strip.readerLabel ? ` (it looks at the clips with "${strip.readerLabel}")` : ""}; a few cents at most.
        </span>
      </div>
      {strip.writerProblem && <div style={noticeBox} data-testid="transition-writer-problem">{strip.writerProblem}</div>}
      {!strip.writerProblem && strip.readerProblem && !gap.textOnlyReason && <p style={muted}>{strip.readerProblem}</p>}

      {/* 2. The three choices */}
      <div role="radiogroup" aria-label="How to join" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {(["cut", "blend", "ai"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={gap.kind === kind}
            disabled={lockedOut}
            data-testid={`transition-kind-${kind}`}
            style={gap.kind === kind ? primaryBtn : ghostBtn}
            onClick={() => props.onPut({ kind })}
          >
            {KIND_LABEL[kind]}
            {gap.suggestedKind === kind ? " (suggested)" : ""}
          </button>
        ))}
        <select
          style={{ ...input, padding: 6 }}
          aria-label="More transitions"
          value={MORE_TRANSITIONS.includes(gap.kind) ? gap.kind : ""}
          disabled={lockedOut}
          onChange={(e) => e.target.value && props.onPut({ kind: e.target.value })}
        >
          <option value="">More…</option>
          {MORE_TRANSITIONS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      {gap.suggestedKind && gap.suggestReason && (
        <p style={muted} data-testid="transition-reason">
          AI suggests {KIND_LABEL[gap.suggestedKind]}: {gap.suggestReason}
        </p>
      )}

      {/* 3. Length */}
      {(isBlend || gap.kind === "ai") && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12 }} htmlFor={`len-${gap.fromShotId}`}>
            Length: <strong>{seconds.toFixed(isBlend ? 1 : 0)} s</strong>
          </label>
          <input
            id={`len-${gap.fromShotId}`}
            type="range"
            data-testid="transition-length"
            min={gap.kind === "ai" && model ? model.minSeconds : 0.1}
            max={gap.kind === "ai" && model ? model.maxSeconds : 5}
            step={gap.kind === "ai" ? 1 : 0.1}
            value={seconds}
            disabled={lockedOut}
            onChange={(e) => setSeconds(Number(e.target.value))}
            onMouseUp={(e) => commitLength(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => commitLength(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commitLength(Number((e.target as HTMLInputElement).value))}
          />
          {gap.kind === "ai" && model && <span style={muted}>{model.label} makes {model.minSeconds}–{model.maxSeconds} s.</span>}
        </div>
      )}

      {gap.kind === "ai" && model && (
        <>
          {/* 4. Keep the same */}
          <div style={{ display: "flex", gap: 10, fontSize: 12, flexWrap: "wrap" }}>
            <span>Keep the same:</span>
            {(["face", "clothes", "location"] as const).map((k) => (
              <label key={k} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input type="checkbox" checked={gap.keepSame[k]} disabled={lockedOut} onChange={(e) => props.onPut({ keepSame: { ...gap.keepSame, [k]: e.target.checked } })} />
                {k === "face" ? "Face" : k === "clothes" ? "Clothes" : "Location"}
              </label>
            ))}
          </div>

          {/* 5. Cost before anything is made */}
          <p style={{ fontSize: 12, margin: 0 }} data-testid="transition-cost">
            Making this costs about <strong>{stripDollars(costCents ?? 0)}</strong> ({model.label}, {Math.round(seconds)} s). This film has spent {stripDollars(strip.budget.spentCents)}
            {strip.budget.capCents !== null ? ` of its ${stripDollars(strip.budget.capCents)} budget` : ""}; AI transitions this month: {stripDollars(strip.monthly.spentCents)} of {stripDollars(strip.monthly.capCents)}.
          </p>
          <p style={muted}>{model.note}</p>

          {/* 6. Versions */}
          {hasTake && (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }} data-testid="transition-versions">
              {gap.takes
                .slice()
                .reverse()
                .map((take, i) => (
                  <li key={take.id} style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>Version {i + 1}</strong>
                    <span>
                      {take.status === "generating" ? "being made…" : take.status === "failed" ? `failed: ${take.error ?? "no reason given"}` : take.current ? "ready" : "ready, made for older clips"}
                    </span>
                    <span style={{ color: "#868e96" }}>{stripDollars(take.costCents ?? take.reservedCents)}</span>
                    {take.note && <span style={{ color: "#868e96" }}>“{take.note}”</span>}
                    {gap.chosenTakeId === take.id && <span style={{ color: "#087f5b", fontWeight: 700 }}>In use</span>}
                    {take.status === "ready" && (
                      <button type="button" style={ghostBtn} onClick={() => setPlayingTake(playingTake === take.id ? null : take.id)}>
                        {playingTake === take.id ? "Stop" : "Play"}
                      </button>
                    )}
                    {take.status === "ready" && gap.chosenTakeId !== take.id && (
                      <button type="button" style={secondaryBtn} disabled={lockedOut} onClick={() => props.onUse(take.id)} data-testid={`transition-use-${take.id}`}>
                        Use this one
                      </button>
                    )}
                    {playingTake === take.id && gap.id && (
                      <video src={`${props.apiBase}/transitions/${gap.id}/takes/${take.id}/content`} controls autoPlay style={{ width: "100%", maxWidth: 360, borderRadius: 6 }} />
                    )}
                  </li>
                ))}
            </ul>
          )}

          {/* 7. Make it / Try another */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {hasTake && (
              <input style={{ ...input, flex: "1 1 200px" }} placeholder="Note for the next try (optional), e.g. slower, no camera spin" value={note} disabled={lockedOut} onChange={(e) => setNote(e.target.value)} aria-label="Note for the next try" />
            )}
            <button
              type="button"
              style={primaryBtn}
              data-testid="transition-generate"
              disabled={lockedOut || generatingNow || costCents === null}
              onClick={() => props.onGenerate({ ...(note.trim() ? { note: note.trim() } : {}), confirmCostCents: costCents ?? 0 })}
            >
              {generatingNow ? "Being made…" : `${hasTake ? "Try another" : "Make it"} (about ${stripDollars(costCents ?? 0)})`}
            </button>
          </div>

          {/* 8. Exact prompt, folded */}
          <details style={{ fontSize: 12 }}>
            <summary style={{ cursor: "pointer" }}>Show exact AI prompt</summary>
            <textarea style={{ ...input, minHeight: 90, width: "100%", marginTop: 6 }} value={prompt} disabled={lockedOut} onChange={(e) => setPrompt(e.target.value)} aria-label="Exact AI prompt" />
            <button type="button" style={ghostBtn} disabled={lockedOut || prompt === (gap.prompt ?? "")} onClick={() => props.onPut({ prompt })}>
              Save prompt
            </button>
          </details>
        </>
      )}
    </div>
  );
}
