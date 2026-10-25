import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, storylineFetchJson } from "./storyline-api.js";
import {
  AddFootage,
  ClipInspector,
  ClipSound,
  ExportPanel,
  KIND_LABEL,
  MusicLane,
  STATE_LABEL,
  TransitionInspector,
  stripDollars,
  type Kind,
  type StripClip,
  type StripGap,
  type StripSummary,
} from "./strip-panel.js";
import {
  DEFAULT_ZOOM_INDEX,
  NUDGE_BIG_MS,
  NUDGE_MS,
  ZOOM_LEVELS,
  buildTimeline,
  clampMs,
  clipAt,
  clipKindOf,
  clipLabel,
  clipPlayMs,
  clipStatusText,
  currentTrim,
  dragEdge,
  fitZoomIndex,
  formatTime,
  isMade,
  moveBefore,
  musicSpan,
  nudgeOrder,
  previewAt,
  rulerTicks,
  secondsText,
  splitProblem,
  trimModeOf,
  zoomIndexStep,
  type EdgeChange,
  type TimelineItem,
  type TimelineLayout,
} from "./timeline-model.js";

// Step 4 of the Storylines flow: the timeline editor. The film as tracks in
// time -- title cards, the video clips sized by how long they play (with the
// joins between them), and the music -- with a playhead, a time ruler, zoom,
// a preview of the frame under the playhead, drag to reorder, trim handles,
// split and remove, transitions, the music's start and fades, and an
// inspector for whatever is selected. The total length and what is left to
// pay are always on screen. Keyboard: space plays, arrows move the playhead,
// Alt+arrows move the selected clip, S splits, Delete removes.
//
// Reads /video-storylines/:id/strip (the same summary the export uses) and
// writes through the clip, shot, transition and music routes. Standalone ES
// module: local styles, no host imports.

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const baseBtn: React.CSSProperties = { padding: "6px 10px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "inherit", borderColor: "rgba(128,128,128,0.5)" };
const dangerBtn: React.CSSProperties = { ...ghostBtn, color: "#c92a2a", borderColor: "#ffc9c9" };
const input: React.CSSProperties = { padding: 6, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13, whiteSpace: "pre-line" };
const noticeBox: React.CSSProperties = { background: "#fff9db", color: "#7f5f01", padding: "8px 10px", borderRadius: 8, fontSize: 12 };
const muted: React.CSSProperties = { fontSize: 12, color: "#868e96", margin: 0 };

const LABEL_WIDTH = 64;
const RULER_HEIGHT = 22;
const TITLE_TRACK = 26;
const VIDEO_TRACK = 64;
const MUSIC_TRACK = 34;

const STATUS_COLOR: Record<string, string> = { done: "#2f9e44", failed: "#e03131", rendering: "#1971c2", queued: "#1971c2", draft: "#adb5bd" };

export type TimelineSelection = { type: "clip"; id: string } | { type: "join"; key: string } | { type: "music" } | { type: "title" } | null;

export interface TimelineEditorProps {
  apiBase: string;
  /** Clips, joins and music may be changed (nothing is being made or combined right now). */
  editable: boolean;
  /** AI shots' description and planned length may change (the storyline is not rendering or finished). */
  shotsEditable: boolean;
  /** Bump to make the editor load the strip again (after a change elsewhere on the page). */
  reloadKey?: number;
  /** Called after every change, so the page can refresh its own copies (shots, progress, status). */
  onChanged?: () => void | Promise<void>;
  /** Opens another step of the flow (e.g. "storyboard" to approve a picture). */
  onGoStep?: (step: "pictures" | "render" | "cast") => void;
}

/** A usable strip answer (an unexpected one shows a plain error instead of breaking the page). */
function isStripSummary(value: unknown): value is StripSummary {
  const v = value as Partial<StripSummary> | null;
  return !!v && Array.isArray(v.clips) && Array.isArray(v.gaps) && typeof v.budget === "object" && v.budget !== null;
}

/** The order of the clips after a drop, or null when nothing changes. */
function droppedOrder(order: readonly string[], dragged: string, target: string, after: boolean): string[] | null {
  const i = order.indexOf(target);
  const before = after ? order[i + 1] ?? null : target;
  const next = moveBefore(order, dragged, before === dragged ? order[i + 2] ?? null : before);
  return next.join() === order.join() ? null : next;
}

export function TimelineEditor(props: TimelineEditorProps) {
  const { apiBase, editable } = props;
  const [strip, setStrip] = useState<StripSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<TimelineSelection>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);
  /** A trim or length being dragged: shown live, saved on release. */
  const [edge, setEdge] = useState<{ shotId: string; change: EdgeChange | null } | null>(null);
  /** The music's start or fades being dragged. */
  const [musicDraft, setMusicDraft] = useState<{ offsetMs: number; fadeInMs: number; fadeOutMs: number } | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await storylineFetchJson<StripSummary>(`${apiBase}/strip`, undefined, "loading the timeline");
      if (!isStripSummary(res)) throw new Error("The timeline could not be read from the server. Refresh the page and try again.");
      setStrip(res);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load, props.reloadKey]);

  // While something is being made or got ready, look again every few seconds.
  const working =
    (strip?.gaps.some((g) => g.state === "generating") ?? false) ||
    (strip?.clips.some((c) => c.status === "queued" || c.status === "rendering") ?? false) ||
    (strip?.uploads ?? []).some((u) => u.status === "processing");
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [working, load]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await fn();
        await load();
        await props.onChanged?.();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load, props.onChanged],
  );

  // The clips as they are now, with a trim being dragged shown live.
  const clips: StripClip[] = useMemo(() => {
    const list = strip?.clips ?? [];
    if (!edge?.change) return list;
    return list.map((c) => {
      if (c.shotId !== edge.shotId || !edge.change) return c;
      return edge.change.mode === "trim"
        ? { ...c, trimInMs: edge.change.trimInMs, trimOutMs: edge.change.trimOutMs, playMs: edge.change.playMs }
        : { ...c, durationSeconds: edge.change.seconds, playMs: edge.change.playMs };
    });
  }, [strip, edge]);

  const titles = strip?.exportSettings ? { opening: strip.exportSettings.opening, credits: strip.exportSettings.credits } : null;
  const layout: TimelineLayout = useMemo(() => buildTimeline(clips, strip?.gaps ?? [], titles), [clips, strip?.gaps, titles?.opening, titles?.credits]);
  const totalMs = layout.totalMs;

  // Fit the whole film on first load, then keep the person's zoom.
  useEffect(() => {
    if (zoomIndex !== null || !strip) return;
    const width = scrollerRef.current?.clientWidth || 720;
    setZoomIndex(strip.clips.length > 0 ? fitZoomIndex(totalMs, width) : DEFAULT_ZOOM_INDEX);
  }, [strip, totalMs, zoomIndex]);
  const zi = zoomIndex ?? DEFAULT_ZOOM_INDEX;
  const pps = ZOOM_LEVELS[zi]!;
  const toPx = (ms: number) => (ms / 1000) * pps;
  const contentWidth = Math.max(toPx(totalMs) + 80, 320);

  // Keep the playhead inside the film when it gets shorter.
  useEffect(() => {
    if (playheadMs > totalMs) setPlayheadMs(totalMs);
  }, [totalMs, playheadMs]);

  // Playback: the clock moves the playhead; the preview follows it.
  const playheadRef = useRef(0);
  playheadRef.current = playheadMs;
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = playheadRef.current + (now - last);
      last = now;
      if (next >= totalMs) {
        setPlayheadMs(totalMs);
        setPlaying(false);
        return;
      }
      playheadRef.current = next;
      setPlayheadMs(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, totalMs]);

  // Keep the playhead in view while playing or moving it with the keyboard.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const x = toPx(playheadMs);
    if (x < scroller.scrollLeft + 20 || x > scroller.scrollLeft + scroller.clientWidth - 40) {
      scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 3);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadMs, pps]);

  const order = useMemo(() => (strip?.clips ?? []).map((c) => c.shotId), [strip]);
  const selectedClip = selection?.type === "clip" ? clips.find((c) => c.shotId === selection.id) ?? null : null;
  const selectedJoin = selection?.type === "join" ? strip?.gaps.find((g) => `${g.fromShotId}:${g.toShotId}` === selection.key) ?? null : null;

  const putOrder = useCallback(
    (next: string[]) => run(() => storylineFetchJson(`${apiBase}/order`, { method: "PUT", body: JSON.stringify({ shotIds: next }) }, "moving the clip")),
    [apiBase, run],
  );

  const removeClip = useCallback(
    (clip: StripClip) => {
      const kind = clipKindOf(clip);
      const label = clipLabel(clip);
      const costLine =
        kind === "generated" && clip.estimatedCostCents
          ? isMade(clip)
            ? ` Its clip is deleted; making it again would cost about ${stripDollars(clip.estimatedCostCents)}.`
            : " Its description and picture are deleted."
          : "";
      if (!window.confirm(`Remove ${label} from the film?${costLine}`)) return;
      void run(async () => {
        await storylineFetchJson(`${apiBase}/clips/${clip.shotId}`, { method: "DELETE" }, "removing the clip");
        setSelection(null);
      });
    },
    [apiBase, run],
  );

  const splitAtPlayhead = useCallback(() => {
    const at = clipAt(layout, playheadMs);
    if (!at) {
      setNotice("Put the playhead on a clip to split it there.");
      return;
    }
    const problem = splitProblem(at.item.clip, at.offsetMs);
    if (problem) {
      setNotice(problem);
      return;
    }
    void run(async () => {
      const res = await storylineFetchJson<{ shotId: string }>(
        `${apiBase}/clips/${at.item.clip.shotId}/split`,
        { method: "POST", body: JSON.stringify({ atMs: Math.round(at.offsetMs) }) },
        "splitting the clip",
      );
      setSelection({ type: "clip", id: res.shotId });
    });
  }, [apiBase, layout, playheadMs, run]);

  const saveMusic = useCallback(
    (body: Record<string, unknown>) => run(() => storylineFetchJson(`${apiBase}/music`, { method: "PATCH", body: JSON.stringify(body) }, "saving the music")),
    [apiBase, run],
  );

  const setJoinKind = useCallback(
    (gap: StripGap, kind: Kind) =>
      run(() => storylineFetchJson(`${apiBase}/transitions`, { method: "PUT", body: JSON.stringify({ fromShotId: gap.fromShotId, toShotId: gap.toShotId, kind }) }, "saving the transition")),
    [apiBase, run],
  );

  // ─── Keyboard ───
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (!strip) return;
    const key = e.key;
    if (key === " " || key === "Spacebar") {
      e.preventDefault();
      if (!playing && playheadMs >= totalMs) setPlayheadMs(0);
      setPlaying((p) => !p);
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      e.preventDefault();
      const dir = key === "ArrowLeft" ? -1 : 1;
      if (e.altKey && selection?.type === "clip" && editable) {
        const next = nudgeOrder(order, selection.id, dir as -1 | 1);
        if (next.join() !== order.join()) void putOrder(next);
        return;
      }
      if (e.altKey && selection?.type === "music" && editable && strip.music) {
        const offsetMs = clampMs(strip.music.offsetMs + dir * (e.shiftKey ? NUDGE_BIG_MS : NUDGE_MS), totalMs);
        void saveMusic({ offsetMs });
        return;
      }
      setPlaying(false);
      setPlayheadMs((ms) => clampMs(ms + dir * (e.shiftKey ? NUDGE_BIG_MS : NUDGE_MS), totalMs));
      return;
    }
    if (key === "Home" || key === "End") {
      e.preventDefault();
      setPlayheadMs(key === "Home" ? 0 : totalMs);
      return;
    }
    if ((key === "Delete" || key === "Backspace") && editable && selection) {
      e.preventDefault();
      if (selection.type === "clip" && selectedClip) removeClip(selectedClip);
      else if (selection.type === "join" && selectedJoin && selectedJoin.kind !== "cut") void setJoinKind(selectedJoin, "cut");
      else if (selection.type === "music" && strip.music?.musicAssetId && window.confirm("Remove the music from the film?")) void saveMusic({ musicFileId: null });
      return;
    }
    if ((key === "s" || key === "S") && !e.metaKey && !e.ctrlKey && editable) {
      e.preventDefault();
      splitAtPlayhead();
      return;
    }
    if (key === "+" || key === "=") setZoomIndex(zoomIndexStep(zi, 1));
    else if (key === "-" || key === "_") setZoomIndex(zoomIndexStep(zi, -1));
    else if (key === "Escape") setSelection(null);
  };

  // ─── Pointer: scrub, trims, music ───
  const msFromClientX = (clientX: number) => {
    const rect = contentRef.current?.getBoundingClientRect();
    return clampMs(((clientX - (rect?.left ?? 0)) / pps) * 1000, totalMs);
  };

  const startScrub = (e: React.PointerEvent) => {
    e.preventDefault();
    setPlaying(false);
    setPlayheadMs(msFromClientX(e.clientX));
    const move = (ev: PointerEvent) => setPlayheadMs(msFromClientX(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const commitEdge = useCallback(
    (clip: StripClip, change: EdgeChange) => {
      const kind = clipKindOf(clip);
      if (change.mode === "trim") {
        const { inMs, outMs } = currentTrim(clip);
        if (change.trimInMs === inMs && change.trimOutMs === outMs) return;
        void run(() => storylineFetchJson(`${apiBase}/clips/${clip.shotId}`, { method: "PATCH", body: JSON.stringify({ trimInMs: change.trimInMs, trimOutMs: change.trimOutMs }) }, "trimming the clip"));
        return;
      }
      if (change.seconds === clip.durationSeconds) return;
      if (kind === "still") {
        void run(() => storylineFetchJson(`${apiBase}/clips/${clip.shotId}`, { method: "PATCH", body: JSON.stringify({ holdSeconds: change.seconds }) }, "saving the length"));
      } else {
        void run(() => storylineFetchJson(`${apiBase}/shots/${clip.shotId}`, { method: "PATCH", body: JSON.stringify({ durationSeconds: change.seconds }) }, "saving the shot's length"));
      }
    },
    [apiBase, run],
  );

  const startEdgeDrag = useCallback(
    (e: React.PointerEvent, clip: StripClip, which: "start" | "end") => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      let latest: EdgeChange | null = null;
      setEdge({ shotId: clip.shotId, change: null });
      const move = (ev: PointerEvent) => {
        latest = dragEdge(clip, which, ((ev.clientX - startX) / pps) * 1000);
        setEdge({ shotId: clip.shotId, change: latest });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setEdge(null);
        if (latest) commitEdge(clip, latest);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [pps, commitEdge],
  );

  const startMusicDrag = (e: React.PointerEvent, part: "move" | "fadeIn" | "fadeOut") => {
    if (!editable || !strip?.music?.musicAssetId) return;
    e.preventDefault();
    e.stopPropagation();
    setSelection({ type: "music" });
    const music = strip.music;
    const startX = e.clientX;
    const base = { offsetMs: music.offsetMs, fadeInMs: music.fadeInMs, fadeOutMs: music.fadeOutMs };
    let latest = base;
    const move = (ev: PointerEvent) => {
      const delta = ((ev.clientX - startX) / pps) * 1000;
      const round = (ms: number) => Math.round(ms / 100) * 100;
      latest =
        part === "move"
          ? { ...base, offsetMs: round(clampMs(base.offsetMs + delta, Math.max(0, totalMs - 500))) }
          : part === "fadeIn"
            ? { ...base, fadeInMs: round(Math.max(0, Math.min(30_000, base.fadeInMs + delta))) }
            : { ...base, fadeOutMs: round(Math.max(0, Math.min(30_000, base.fadeOutMs - delta))) };
      setMusicDraft(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setMusicDraft(null);
      const changed = Object.fromEntries(Object.entries(latest).filter(([k, v]) => base[k as keyof typeof base] !== v));
      if (Object.keys(changed).length > 0) void saveMusic(changed);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onSelectClip = useCallback((id: string) => {
    setSelection({ type: "clip", id });
  }, []);

  const onDropOn = useCallback(
    (targetId: string, after: boolean) => {
      if (!dragId) return;
      const next = droppedOrder(order, dragId, targetId, after);
      setDragId(null);
      setDropHint(null);
      if (next) void putOrder(next);
    },
    [dragId, order, putOrder],
  );

  if (!strip) {
    return (
      <div style={card} data-testid="timeline-editor">
        <strong style={{ fontSize: 14 }}>Step 4: Timeline</strong>
        {loadError ? <div style={errorBox}>{loadError}</div> : <p style={muted}>Loading the timeline…</p>}
      </div>
    );
  }

  const aiClips = strip.clips.filter((c) => clipKindOf(c) === "generated");
  const madeCount = aiClips.filter((c) => isMade(c)).length;
  const remaining = strip.remainingRenderCents ?? null;
  const preview = previewAt(layout, playheadMs, apiBase);
  const span = musicSpan(strip.music && musicDraft ? { ...strip.music, ...musicDraft } : strip.music, totalMs);
  const ticks = rulerTicks(totalMs, pps);
  const aspect = strip.aspect ?? "16:9";
  const hasTitles = layout.items.some((i) => i.type === "title");
  const tracksHeight = RULER_HEIGHT + (hasTitles ? TITLE_TRACK : 0) + VIDEO_TRACK + MUSIC_TRACK + 8;
  const advanced = strip.advancedEnabled !== false;

  return (
    <div style={card} data-testid="timeline-editor" tabIndex={0} onKeyDown={onKeyDown} aria-label="Timeline editor">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 14 }}>Step 4: Timeline</strong>
          <p style={muted}>
            Your film from start to end. Drag clips to change the order, drag their edges to make them shorter or longer, and click a join or the music to change it. Changes here are free; nothing is made until you
            press a button that shows its price.
          </p>
        </div>
      </div>

      {/* Always visible: how long the film is and what is left to pay. */}
      <div data-testid="timeline-summary" style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 12, background: "rgba(128,128,128,0.06)", borderRadius: 8, padding: "6px 10px" }}>
        <span>
          Length: <strong data-testid="timeline-total">{formatTime(totalMs, true)}</strong>
        </span>
        <span>
          {strip.clips.length} clip{strip.clips.length === 1 ? "" : "s"}
          {aiClips.length > 0 ? ` (${madeCount} of ${aiClips.length} AI shot${aiClips.length === 1 ? "" : "s"} made)` : ""}
        </span>
        {remaining !== null && (
          <span data-testid="timeline-cost">
            Still to make: <strong>{remaining > 0 ? `about ${stripDollars(remaining)}` : "nothing"}</strong>
          </span>
        )}
        <span>
          Spent {stripDollars(strip.budget.spentCents)}
          {strip.budget.capCents !== null ? ` of ${stripDollars(strip.budget.capCents)} budget` : " (no budget set yet)"}
        </span>
      </div>

      {strip.combineProblems.length > 0 && (
        <div style={noticeBox} data-testid="timeline-combine-problems">
          The film can't be put together yet:
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {strip.combineProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {loadError && <div style={errorBox}>{loadError}</div>}
      {error && (
        <div style={errorBox} role="alert" data-testid="timeline-error">
          {error}
        </div>
      )}
      {notice && (
        <div style={noticeBox} data-testid="timeline-notice">
          {notice}
        </div>
      )}

      {strip.clips.length === 0 ? (
        <div style={noticeBox} data-testid="timeline-empty">
          The timeline is empty. Write or import the script in step 1: every shot becomes a clip here, in order.
          {advanced ? " You can also add your own videos and photos below." : ""}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
            <Monitor preview={preview} aspect={aspect} playing={playing} playheadMs={playheadMs} />
            <div style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }} data-testid="timeline-inspector">
              {!selection && (
                <p style={muted}>
                  Click a clip, a join between two clips, or the music to see and change it here. The preview on the left shows the picture under the playhead.
                </p>
              )}
              {selectedClip && clipKindOf(selectedClip) === "generated" && (
                <AiClipPanel
                  key={`${selectedClip.shotId}:${selectedClip.status}:${selectedClip.durationSeconds}`}
                  clip={selectedClip}
                  strip={strip}
                  apiBase={apiBase}
                  editable={editable}
                  shotsEditable={props.shotsEditable}
                  busy={busy}
                  run={run}
                  onSplit={splitAtPlayhead}
                  onRemove={() => removeClip(selectedClip)}
                  onGoStep={props.onGoStep}
                />
              )}
              {selectedClip && clipKindOf(selectedClip) !== "generated" && (
                <>
                  <ClipInspector
                    key={`${selectedClip.shotId}:${selectedClip.status}:${selectedClip.clipKind}:${selectedClip.trimInMs}:${selectedClip.trimOutMs}`}
                    clip={selectedClip}
                    strip={strip}
                    apiBase={apiBase}
                    editable={editable}
                    busy={busy}
                    index={order.indexOf(selectedClip.shotId)}
                    onMove={(delta) => {
                      const next = nudgeOrder(order, selectedClip.shotId, delta);
                      if (next.join() !== order.join()) void putOrder(next);
                    }}
                    run={run}
                    onRemoved={() => setSelection(null)}
                  />
                  <button type="button" style={{ ...ghostBtn, alignSelf: "flex-start" }} disabled={busy || !editable} onClick={splitAtPlayhead} data-testid="clip-split">
                    Split at the playhead
                  </button>
                </>
              )}
              {selectedJoin && (
                <TransitionInspector
                  key={`${selectedJoin.fromShotId}:${selectedJoin.toShotId}:${selectedJoin.kind}:${selectedJoin.durationMs}`}
                  gap={selectedJoin}
                  strip={strip}
                  from={strip.clips.find((c) => c.shotId === selectedJoin.fromShotId)!}
                  to={strip.clips.find((c) => c.shotId === selectedJoin.toShotId)!}
                  apiBase={apiBase}
                  editable={editable}
                  busy={busy}
                  aiAllowed={advanced}
                  onPut={(patch) =>
                    void run(() =>
                      storylineFetchJson(`${apiBase}/transitions`, { method: "PUT", body: JSON.stringify({ fromShotId: selectedJoin.fromShotId, toShotId: selectedJoin.toShotId, ...patch }) }, "saving the transition"),
                    )
                  }
                  onSuggest={(body) =>
                    void run(() =>
                      storylineFetchJson(`${apiBase}/transitions/suggest`, { method: "POST", body: JSON.stringify({ fromShotId: selectedJoin.fromShotId, toShotId: selectedJoin.toShotId, ...body }) }, "asking the AI for a suggestion"),
                    )
                  }
                  onGenerate={(body) =>
                    void run(async () => {
                      let id = selectedJoin.id;
                      if (!id) {
                        const saved = await storylineFetchJson<StripGap>(
                          `${apiBase}/transitions`,
                          { method: "PUT", body: JSON.stringify({ fromShotId: selectedJoin.fromShotId, toShotId: selectedJoin.toShotId, kind: "ai" }) },
                          "saving the transition",
                        );
                        id = saved.id;
                      }
                      await storylineFetchJson(`${apiBase}/transitions/${id}/generate`, { method: "POST", body: JSON.stringify(body) }, "making the transition");
                    })
                  }
                  onUse={(takeId) => void run(() => storylineFetchJson(`${apiBase}/transitions/${selectedJoin.id}/takes/${takeId}/use`, { method: "POST", body: "{}" }, "choosing that version"))}
                />
              )}
              {selection?.type === "music" && strip.music && <MusicLane apiBase={apiBase} strip={strip} editable={editable} busy={busy} run={run} defaultOpen />}
              {selection?.type === "title" && (
                <p style={muted} data-testid="title-help">
                  The title card and the credits are set in step 5 (Render & export), under Export.
                </p>
              )}
            </div>
          </div>

          {/* Transport and tools */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }} data-testid="timeline-toolbar">
            <button
              type="button"
              style={primaryBtn}
              data-testid="timeline-play"
              aria-label={playing ? "Pause" : "Play"}
              onClick={() => {
                if (!playing && playheadMs >= totalMs) setPlayheadMs(0);
                setPlaying(!playing);
              }}
            >
              {playing ? "❚❚ Pause" : "▶ Play"}
            </button>
            <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }} data-testid="timeline-time">
              {formatTime(playheadMs, true)} / {formatTime(totalMs, true)}
            </span>
            <button type="button" style={ghostBtn} disabled={busy || !editable} onClick={splitAtPlayhead} data-testid="timeline-split" title="Split the clip under the playhead (S)">
              Split
            </button>
            <button
              type="button"
              style={dangerBtn}
              disabled={busy || !editable || !selectedClip}
              onClick={() => selectedClip && removeClip(selectedClip)}
              data-testid="timeline-remove"
              title={selectedClip ? "Remove the selected clip (Delete)" : "Select a clip first"}
            >
              Remove
            </button>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 12 }}>Zoom</span>
            <button type="button" style={ghostBtn} aria-label="Zoom out" data-testid="timeline-zoom-out" disabled={zi === 0} onClick={() => setZoomIndex(zoomIndexStep(zi, -1))}>
              −
            </button>
            <input
              type="range"
              min={0}
              max={ZOOM_LEVELS.length - 1}
              step={1}
              value={zi}
              aria-label="Zoom"
              data-testid="timeline-zoom"
              onChange={(e) => setZoomIndex(Number(e.target.value))}
              style={{ width: 90 }}
            />
            <button type="button" style={ghostBtn} aria-label="Zoom in" data-testid="timeline-zoom-in" disabled={zi === ZOOM_LEVELS.length - 1} onClick={() => setZoomIndex(zoomIndexStep(zi, 1))}>
              +
            </button>
            <button type="button" style={ghostBtn} data-testid="timeline-fit" onClick={() => setZoomIndex(fitZoomIndex(totalMs, scrollerRef.current?.clientWidth || 720))}>
              Fit
            </button>
          </div>

          {/* Tracks */}
          <div style={{ display: "flex", border: "1px solid rgba(128,128,128,0.3)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ width: LABEL_WIDTH, flexShrink: 0, fontSize: 11, color: "#868e96", borderRight: "1px solid rgba(128,128,128,0.3)", background: "rgba(128,128,128,0.05)" }}>
              <div style={{ height: RULER_HEIGHT }} />
              {hasTitles && <div style={{ height: TITLE_TRACK, display: "flex", alignItems: "center", paddingLeft: 6 }}>Text</div>}
              <div style={{ height: VIDEO_TRACK, display: "flex", alignItems: "center", paddingLeft: 6 }}>Video</div>
              <div style={{ height: MUSIC_TRACK, display: "flex", alignItems: "center", paddingLeft: 6 }}>Music</div>
            </div>
            <div ref={scrollerRef} style={{ overflowX: "auto", overflowY: "hidden", flex: 1, minWidth: 0 }} data-testid="timeline-scroller">
              <div ref={contentRef} style={{ position: "relative", width: contentWidth, height: tracksHeight }} data-testid="timeline-content" data-pps={pps}>
                {/* Ruler: click or drag to move the playhead. */}
                <div
                  data-testid="timeline-ruler"
                  onPointerDown={startScrub}
                  style={{ position: "relative", height: RULER_HEIGHT, borderBottom: "1px solid rgba(128,128,128,0.4)", cursor: "pointer", userSelect: "none" }}
                >
                  {ticks.map((t) => (
                    <span key={t.ms} style={{ position: "absolute", left: toPx(t.ms), top: 0, height: RULER_HEIGHT, borderLeft: "1px solid rgba(128,128,128,0.45)", paddingLeft: 3, fontSize: 10, color: "#868e96" }}>
                      {t.label}
                    </span>
                  ))}
                </div>

                {hasTitles && (
                  <div style={{ position: "relative", height: TITLE_TRACK }} aria-label="Title cards">
                    {layout.items
                      .filter((i): i is Extract<TimelineItem, { type: "title" }> => i.type === "title")
                      .map((t) => (
                        <button
                          key={t.key}
                          type="button"
                          data-testid={`timeline-title-${t.key}`}
                          onClick={() => setSelection({ type: "title" })}
                          title={t.text}
                          style={{
                            position: "absolute",
                            left: toPx(t.startMs),
                            width: Math.max(4, toPx(t.endMs - t.startMs) - 2),
                            top: 3,
                            bottom: 3,
                            background: "#fff4e6",
                            border: "1px solid #ffc078",
                            color: "#7f3d00",
                            borderRadius: 4,
                            fontSize: 11,
                            overflow: "hidden",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis",
                            padding: "0 4px",
                            cursor: "pointer",
                          }}
                        >
                          {t.key === "opening" ? "Title: " : "Credits: "}
                          {t.text.split("\n")[0]}
                        </button>
                      ))}
                  </div>
                )}

                {/* Video track: clips sized by how long they play, joins between them. */}
                <div style={{ position: "relative", height: VIDEO_TRACK }} aria-label="Video track" data-testid="timeline-video-track">
                  {layout.items
                    .filter((i): i is Extract<TimelineItem, { type: "bridge" }> => i.type === "bridge")
                    .map((b) => (
                      <div
                        key={b.key}
                        data-testid={`timeline-bridge-${b.gap.fromShotId}`}
                        style={{ position: "absolute", left: toPx(b.startMs), width: Math.max(3, toPx(b.endMs - b.startMs)), top: 6, bottom: 6, background: "#f3f0ff", border: "1px dashed #9775fa", borderRadius: 4, fontSize: 10, color: "#5f3dc4", overflow: "hidden", padding: 2 }}
                      >
                        AI bridge
                      </div>
                    ))}
                  {layout.clips.map((item) => (
                    <ClipBlock
                      key={item.key}
                      item={item}
                      apiBase={apiBase}
                      pps={pps}
                      selected={selection?.type === "clip" && selection.id === item.key}
                      editable={editable && !busy}
                      dragging={dragId === item.key}
                      dropHint={dropHint?.id === item.key ? (dropHint.after ? "after" : "before") : null}
                      onSelect={onSelectClip}
                      onDragStart={setDragId}
                      onDragEnd={() => {
                        setDragId(null);
                        setDropHint(null);
                      }}
                      onDragOverClip={(id, after) => setDropHint((h) => (h?.id === id && h.after === after ? h : { id, after }))}
                      onDropOn={onDropOn}
                      onEdgeDown={startEdgeDrag}
                    />
                  ))}
                  {layout.joins.map((join) => (
                    <button
                      key={join.key}
                      type="button"
                      data-testid={`timeline-join-${join.gap.fromShotId}`}
                      aria-label={`Join between two clips: ${KIND_LABEL[join.gap.kind as Kind] ?? join.gap.kind}`}
                      title={`${KIND_LABEL[join.gap.kind as Kind] ?? join.gap.kind}${join.gap.kind !== "cut" ? ` · ${secondsText(join.gap.durationMs)} s` : ""}${STATE_LABEL[join.gap.state as StripGap["state"]] ? ` · ${STATE_LABEL[join.gap.state as StripGap["state"]]}` : ""}`}
                      onClick={() => setSelection({ type: "join", key: join.key })}
                      style={{
                        position: "absolute",
                        left: toPx(join.atMs) - 11,
                        bottom: -1,
                        width: 22,
                        height: 18,
                        padding: 0,
                        borderRadius: 9,
                        fontSize: 10,
                        fontWeight: 700,
                        cursor: "pointer",
                        zIndex: 3,
                        border: selection?.type === "join" && selection.key === join.key ? "2px solid #1971c2" : `1px solid ${join.gap.state === "out_of_date" || join.gap.state === "failed" ? "#e8590c" : "rgba(128,128,128,0.7)"}`,
                        background: join.gap.kind === "ai" ? "#f3f0ff" : join.gap.kind === "cut" ? "#fff" : "#e7f5ff",
                        color: join.gap.kind === "ai" ? "#5f3dc4" : "#1971c2",
                      }}
                    >
                      {join.gap.kind === "cut" ? "|" : join.gap.kind === "ai" ? "AI" : "◇"}
                    </button>
                  ))}
                </div>

                {/* Music track */}
                <div style={{ position: "relative", height: MUSIC_TRACK, borderTop: "1px solid rgba(128,128,128,0.25)" }} aria-label="Music track" data-testid="timeline-music-track">
                  {span ? (
                    <div
                      data-testid="timeline-music"
                      role="button"
                      tabIndex={-1}
                      aria-label={`Music: ${strip.music?.fileName ?? "music"}, from ${formatTime(span.startMs)}`}
                      onPointerDown={(e) => startMusicDrag(e, "move")}
                      onClick={() => setSelection({ type: "music" })}
                      style={{
                        position: "absolute",
                        left: toPx(span.startMs),
                        width: Math.max(6, toPx(span.endMs - span.startMs)),
                        top: 4,
                        bottom: 4,
                        background: "#e6fcf5",
                        border: selection?.type === "music" ? "2px solid #1971c2" : "1px solid #63e6be",
                        borderRadius: 4,
                        overflow: "hidden",
                        cursor: editable ? "grab" : "pointer",
                        fontSize: 11,
                        color: "#087f5b",
                      }}
                    >
                      <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 10" style={{ position: "absolute", inset: 0 }} aria-hidden>
                        {(() => {
                          const len = Math.max(1, span.endMs - span.startMs);
                          const fi = (span.fadeInMs / len) * 100;
                          const fo = 100 - (span.fadeOutMs / len) * 100;
                          return <polygon points={`0,10 ${fi},2 ${fo},2 100,10`} fill="#96f2d7" opacity={0.7} />;
                        })()}
                      </svg>
                      <span style={{ position: "relative", padding: "0 6px", whiteSpace: "nowrap" }}>♪ {strip.music?.fileName ?? "Music"}</span>
                      {editable && (
                        <>
                          <span
                            data-testid="music-fade-in-handle"
                            title={`Fade in: ${secondsText(span.fadeInMs)} s (drag)`}
                            onPointerDown={(e) => startMusicDrag(e, "fadeIn")}
                            style={{ position: "absolute", left: toPx(span.fadeInMs) - 4, top: 0, width: 8, height: 8, borderRadius: 4, background: "#0ca678", cursor: "ew-resize" }}
                          />
                          <span
                            data-testid="music-fade-out-handle"
                            title={`Fade out: ${secondsText(span.fadeOutMs)} s (drag)`}
                            onPointerDown={(e) => startMusicDrag(e, "fadeOut")}
                            style={{ position: "absolute", right: toPx(span.fadeOutMs) - 4, top: 0, width: 8, height: 8, borderRadius: 4, background: "#0ca678", cursor: "ew-resize" }}
                          />
                        </>
                      )}
                    </div>
                  ) : (
                    <button type="button" style={{ ...ghostBtn, position: "absolute", left: 6, top: 4, fontSize: 11, padding: "3px 8px" }} onClick={() => setSelection({ type: "music" })} data-testid="timeline-add-music">
                      + Add music
                    </button>
                  )}
                </div>

                {/* Playhead */}
                <div
                  data-testid="timeline-playhead"
                  aria-hidden
                  style={{ position: "absolute", left: toPx(playheadMs), top: 0, height: tracksHeight, width: 0, borderLeft: "2px solid #e8590c", pointerEvents: "none", zIndex: 4 }}
                >
                  <div style={{ position: "absolute", left: -6, top: 0, width: 10, height: 10, background: "#e8590c", borderRadius: "0 0 5px 5px" }} />
                </div>
              </div>
            </div>
          </div>
          <p style={muted} data-testid="timeline-keys">
            Keys: Space plays or pauses · ← → move the playhead (Shift: 1 second) · Alt+← → move the selected clip · S splits at the playhead · Delete removes the selected clip · + − zoom.
          </p>
        </>
      )}

      {editable && advanced && (
        <AddFootage
          apiBase={apiBase}
          strip={strip}
          busy={busy}
          run={run}
          afterShotId={selection?.type === "clip" ? selection.id : order[order.length - 1] ?? null}
        />
      )}
    </div>
  );
}

/** Step 5's export block: size and frame rate presets, title card and credits, and "Export again" (free, nothing is re-made). */
export function ExportSection(props: { apiBase: string; editable: boolean; reloadKey?: number; onChanged?: () => void | Promise<void>; /** The storyline's status, so a running export shows here too and the panel refreshes when it ends. */ storylineStatus?: string }) {
  const [strip, setStrip] = useState<StripSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const res = await storylineFetchJson<StripSummary>(`${props.apiBase}/strip`, undefined, "loading the export settings");
      setStrip(isStripSummary(res) ? res : null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [props.apiBase]);
  useEffect(() => {
    void load();
  }, [load, props.reloadKey, props.storylineStatus]);
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await load();
        await props.onChanged?.();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load, props.onChanged],
  );
  if (!strip?.exportSettings) return error ? <div style={errorBox}>{error}</div> : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="export-section">
      {error && (
        <div style={errorBox} role="alert">
          {error}
        </div>
      )}
      {(props.storylineStatus === "ready_to_stitch" || props.storylineStatus === "stitching") && (
        <div style={noticeBox} role="status" data-testid="export-running">
          Exporting your film now. You can follow it under "Progress and your film" above; the download appears there when it is ready.
        </div>
      )}
      {!strip.canCombineAgain && (
        <p style={muted} data-testid="export-when">
          Export settings are used when the film is put together. Once the film is finished, "Export again" makes a new version with these settings for free.
        </p>
      )}
      <ExportPanel key={JSON.stringify(strip.exportSettings)} apiBase={props.apiBase} strip={strip} editable={props.editable} busy={busy} run={run} hideAspect />
    </div>
  );
}

/** The preview: the picture under the playhead (the clip's real frame when it is made). */
function Monitor(props: { preview: ReturnType<typeof previewAt>; aspect: string; playing: boolean; playheadMs: number }) {
  const { preview } = props;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const ratio = props.aspect === "9:16" ? "9 / 16" : props.aspect === "1:1" ? "1 / 1" : "16 / 9";
  const src = preview.kind === "video" ? preview.src : null;
  const time = preview.kind === "video" ? preview.timeSeconds : 0;

  // Follow the playhead: seek while paused (scrubbing), play along while playing.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    const drift = Math.abs((video.currentTime || 0) - time);
    if (!props.playing) {
      if (!video.paused) {
        try {
          video.pause();
        } catch {
          // ignore
        }
      }
      if (drift > 0.04) {
        try {
          video.currentTime = time;
        } catch {
          // Not loaded yet: it seeks once it can (onLoadedMetadata).
        }
      }
      return;
    }
    if (drift > 0.4) {
      try {
        video.currentTime = time;
      } catch {
        // Not loaded yet.
      }
    }
    if (video.paused) {
      try {
        void video.play()?.catch(() => undefined);
      } catch {
        // A browser that refuses to play without a click: the picture still follows the playhead.
      }
    }
  }, [src, time, props.playing]);

  return (
    <div
      data-testid="timeline-monitor"
      style={{ flex: "1 1 320px", maxWidth: props.aspect === "9:16" ? 240 : 520, aspectRatio: ratio, background: "#111", borderRadius: 8, overflow: "hidden", position: "relative", display: "flex", alignItems: "center", justifyContent: "center", color: "#dee2e6" }}
    >
      {preview.kind === "video" && (
        <video
          ref={videoRef}
          key={preview.src}
          src={preview.src}
          preload="auto"
          playsInline
          muted={!props.playing}
          data-testid="timeline-monitor-video"
          onLoadedMetadata={(e) => {
            try {
              e.currentTarget.currentTime = time;
            } catch {
              // ignore
            }
          }}
          style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
        />
      )}
      {preview.kind === "image" && <img src={preview.src} alt="The picture at the playhead" data-testid="timeline-monitor-image" style={{ width: "100%", height: "100%", objectFit: "contain" }} />}
      {(preview.kind === "title" || preview.kind === "empty") && (
        <div data-testid="timeline-monitor-text" style={{ padding: 16, textAlign: "center", fontSize: preview.kind === "title" ? 18 : 12, whiteSpace: "pre-line", maxHeight: "100%", overflow: "hidden" }}>
          {preview.text}
        </div>
      )}
      <span style={{ position: "absolute", right: 6, bottom: 4, fontSize: 11, background: "rgba(0,0,0,0.55)", padding: "1px 5px", borderRadius: 4, fontVariantNumeric: "tabular-nums" }}>{formatTime(props.playheadMs, true)}</span>
    </div>
  );
}

const ClipBlock = memo(function ClipBlock(props: {
  item: Extract<TimelineItem, { type: "clip" }>;
  apiBase: string;
  pps: number;
  selected: boolean;
  editable: boolean;
  dragging: boolean;
  dropHint: "before" | "after" | null;
  onSelect: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOverClip: (id: string, after: boolean) => void;
  onDropOn: (id: string, after: boolean) => void;
  onEdgeDown: (e: React.PointerEvent, clip: StripClip, edge: "start" | "end") => void;
}) {
  const { item, pps } = props;
  const clip = item.clip as StripClip;
  const left = (item.startMs / 1000) * pps;
  const width = Math.max(6, ((item.endMs - item.startMs) / 1000) * pps - 2);
  const mode = trimModeOf(clip);
  const status = clipStatusText(clip);
  const color = STATUS_COLOR[clip.status] ?? "#adb5bd";
  const afterFromEvent = (e: React.DragEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return rect.width > 0 && e.clientX > rect.left + rect.width / 2;
  };
  return (
    <div
      data-testid={`timeline-clip-${clip.shotId}`}
      role="button"
      tabIndex={-1}
      aria-pressed={props.selected}
      aria-label={`${clipLabel(clip)}, ${secondsText(clipPlayMs(clip))} seconds, ${status}`}
      draggable={props.editable}
      onClick={() => props.onSelect(clip.shotId)}
      onDragStart={(e) => {
        try {
          e.dataTransfer?.setData("text/plain", clip.shotId);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        } catch {
          // Some browsers refuse custom data; the order is tracked in state anyway.
        }
        props.onDragStart(clip.shotId);
      }}
      onDragEnd={props.onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        props.onDragOverClip(clip.shotId, afterFromEvent(e));
      }}
      onDrop={(e) => {
        e.preventDefault();
        props.onDropOn(clip.shotId, afterFromEvent(e));
      }}
      title={`${clipLabel(clip)} · ${secondsText(clipPlayMs(clip))} s · ${status}\n${clip.prompt}`}
      style={{
        position: "absolute",
        left,
        width,
        top: 4,
        bottom: 12,
        borderRadius: 6,
        overflow: "hidden",
        cursor: props.editable ? "grab" : "pointer",
        opacity: props.dragging ? 0.5 : 1,
        border: props.selected ? "2px solid #1971c2" : clipKindOf(clip) === "generated" && !isMade(clip) ? "1px dashed rgba(128,128,128,0.8)" : "1px solid rgba(128,128,128,0.6)",
        background: "rgba(25,113,194,0.08)",
        boxShadow: props.dropHint === "before" ? "inset 3px 0 0 #1971c2" : props.dropHint === "after" ? "inset -3px 0 0 #1971c2" : undefined,
        display: "flex",
        alignItems: "stretch",
        fontSize: 11,
        userSelect: "none",
      }}
    >
      {clip.hasPoster && (
        <img
          src={`${props.apiBase}/shots/${clip.shotId}/poster`}
          alt=""
          loading="lazy"
          draggable={false}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none", opacity: isMade(clip) || clipKindOf(clip) !== "generated" ? 1 : 0.6 }}
        />
      )}
      <span
        style={{
          position: "relative",
          margin: 3,
          padding: "1px 5px",
          alignSelf: "flex-start",
          maxWidth: "calc(100% - 6px)",
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
          background: "rgba(255,255,255,0.85)",
          color: "#212529",
          borderRadius: 4,
          lineHeight: 1.3,
        }}
      >
        <strong>{clipLabel(clip)}</strong> · {secondsText(clipPlayMs(clip))} s
      </span>
      <span aria-hidden style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3, background: color }} />
      {props.editable && mode === "trim" && (
        <span data-testid={`trim-start-${clip.shotId}`} title="Drag to trim the start" onPointerDown={(e) => props.onEdgeDown(e, clip, "start")} style={handleStyle("left")} />
      )}
      {props.editable && mode !== "none" && (
        <span
          data-testid={`trim-end-${clip.shotId}`}
          title={mode === "trim" ? "Drag to trim the end" : "Drag to make it longer or shorter"}
          onPointerDown={(e) => props.onEdgeDown(e, clip, "end")}
          style={handleStyle("right")}
        />
      )}
    </div>
  );
});

function handleStyle(side: "left" | "right"): React.CSSProperties {
  return { position: "absolute", [side]: 0, top: 0, bottom: 0, width: 8, cursor: "ew-resize", background: "rgba(25,113,194,0.35)", zIndex: 2 } as React.CSSProperties;
}

/** The selected AI shot: description, model, length, status, cost, make again, split and remove. */
function AiClipPanel(props: {
  clip: StripClip;
  strip: StripSummary;
  apiBase: string;
  editable: boolean;
  shotsEditable: boolean;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  onSplit: () => void;
  onRemove: () => void;
  onGoStep?: TimelineEditorProps["onGoStep"];
}) {
  const { clip, apiBase } = props;
  const made = isMade(clip);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(clip.prompt);
  const [camera, setCamera] = useState(clip.cameraNotes ?? "");
  const [seconds, setSeconds] = useState(String(clip.durationSeconds));
  const trim = currentTrim(clip);
  const [trimIn, setTrimIn] = useState(secondsText(trim.inMs));
  const [trimOut, setTrimOut] = useState(secondsText(trim.outMs));
  const disabled = props.busy || !props.editable;
  const working = clip.status === "queued" || clip.status === "rendering";
  const approved = clip.storyboardStatus === undefined || clip.storyboardStatus === "approved";
  const cost = clip.estimatedCostCents ?? null;
  const playMs = clipPlayMs(clip);
  const patchShot = (body: Record<string, unknown>, doing: string) =>
    props.run(() => storylineFetchJson(`${apiBase}/shots/${clip.shotId}`, { method: "PATCH", body: JSON.stringify(body) }, doing));
  const patchClip = (body: Record<string, unknown>, doing: string) =>
    void props.run(() => storylineFetchJson(`${apiBase}/clips/${clip.shotId}`, { method: "PATCH", body: JSON.stringify(body) }, doing));

  let againReason: string | null = null;
  if (!props.editable) againReason = "Wait until the clips being made right now are finished.";
  else if (!approved) againReason = "Approve this shot's picture in step 3 (Storyboard) first.";
  else if (working) againReason = "This shot is being made right now.";

  return (
    <div style={{ ...card, background: "rgba(128,128,128,0.04)" }} data-testid="ai-clip-panel">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>{clipLabel(clip)} · AI shot</strong>
        <span data-testid="ai-clip-status" style={{ fontSize: 12, fontWeight: 600, color: STATUS_COLOR[clip.status] ?? "#868e96" }}>
          {clipStatusText(clip)}
        </span>
      </div>
      {clip.errorMessage && (
        <div style={errorBox} data-testid="ai-clip-error">
          {clip.errorMessage}
        </div>
      )}
      {!approved && (
        <div style={noticeBox}>
          This shot's picture isn't approved yet, so it won't be made.{" "}
          {props.onGoStep && (
            <button type="button" style={{ ...ghostBtn, padding: "2px 8px" }} onClick={() => props.onGoStep?.("pictures")}>
              Go to the storyboard
            </button>
          )}
        </div>
      )}

      {!editing ? (
        <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
          <span>
            <strong>What happens:</strong> {clip.prompt}
          </span>
          {clip.cameraNotes && (
            <span>
              <strong>Camera:</strong> {clip.cameraNotes}
            </span>
          )}
          {props.shotsEditable && (
            <button type="button" style={{ ...ghostBtn, alignSelf: "flex-start" }} disabled={props.busy} onClick={() => setEditing(true)} data-testid="ai-clip-edit">
              Change the description
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
          <textarea style={{ ...input, minHeight: 60 }} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="What happens in this shot" />
          <input style={input} value={camera} onChange={(e) => setCamera(e.target.value)} placeholder="Camera (optional)" aria-label="Camera notes" />
          <span style={{ color: "#d9480f" }}>Saving a new description means this shot's picture is made and approved again in step 3 before the shot can be made.</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              style={primaryBtn}
              disabled={props.busy || !prompt.trim()}
              onClick={() =>
                void patchShot({ prompt: prompt.trim(), cameraNotes: camera.trim() || null }, "saving the description").then(() => setEditing(false))
              }
            >
              Save
            </button>
            <button type="button" style={ghostBtn} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }} data-testid="ai-clip-facts">
        <span>
          <strong>Video service:</strong> {clip.providerId === "sogni" ? "Sogni" : clip.providerId === "fal" ? "Fal.ai" : "default"}
          {clip.model ? ` · ${clip.model}` : " · its standard model"}
          <span style={{ color: "#868e96" }}> (change it in step 5, under Video settings)</span>
        </span>
        {cost !== null && (
          <span data-testid="ai-clip-cost">
            <strong>Cost to make:</strong> about {stripDollars(cost)}
          </span>
        )}
      </div>

      {/* Length: planned length before it is made, trim after. */}
      {!made ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 12 }} data-testid="ai-clip-length">
          <label>
            Length (seconds){" "}
            <input
              style={{ ...input, width: 70 }}
              type="number"
              min={1}
              max={60}
              value={seconds}
              disabled={props.busy || !props.shotsEditable || working}
              onChange={(e) => setSeconds(e.target.value)}
              aria-label="Length in seconds"
            />
          </label>
          <button
            type="button"
            style={secondaryBtn}
            disabled={props.busy || !props.shotsEditable || working || Number(seconds) === clip.durationSeconds || !(Number(seconds) >= 1 && Number(seconds) <= 60)}
            onClick={() => void patchShot({ durationSeconds: Math.round(Number(seconds)) }, "saving the shot's length")}
            data-testid="ai-clip-save-length"
          >
            Save length
          </button>
          {playMs !== clip.durationSeconds * 1000 && (
            <span style={muted}>
              This model makes {secondsText(playMs)}-second clips, so it plays (and is paid for) as {secondsText(playMs)} s.
            </span>
          )}
          {!props.shotsEditable && <span style={muted}>The length can't change while the film is being made or once it is finished.</span>}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 12 }} data-testid="ai-clip-trim">
          <span>
            Plays {secondsText(playMs)} s of {secondsText(clip.sourceLengthMs ?? playMs)} s.
          </span>
          <label>
            Start at (s){" "}
            <input style={{ ...input, width: 64 }} type="number" min={0} step={0.1} value={trimIn} disabled={disabled} onChange={(e) => setTrimIn(e.target.value)} aria-label="Start at (seconds)" />
          </label>
          <label>
            End at (s){" "}
            <input style={{ ...input, width: 64 }} type="number" min={0} step={0.1} value={trimOut} disabled={disabled} onChange={(e) => setTrimOut(e.target.value)} aria-label="End at (seconds)" />
          </label>
          <button
            type="button"
            style={secondaryBtn}
            disabled={disabled}
            data-testid="ai-clip-save-trim"
            onClick={() => patchClip({ trimInMs: Math.round(Number(trimIn) * 1000), trimOutMs: Math.round(Number(trimOut) * 1000) }, "trimming the clip")}
          >
            Save trim
          </button>
          {(clip.trimInMs != null || clip.trimOutMs != null) && (
            <button type="button" style={ghostBtn} disabled={disabled} onClick={() => patchClip({ trimInMs: 0, trimOutMs: null }, "undoing the trim")} data-testid="ai-clip-reset-trim">
              Use the whole clip
            </button>
          )}
        </div>
      )}

      {made && <ClipSound clip={clip} disabled={disabled} onPatch={(body, doing) => patchClip(body, doing)} />}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {(made || clip.status === "failed") && (
          <button
            type="button"
            style={secondaryBtn}
            data-testid="ai-clip-again"
            disabled={props.busy || againReason !== null}
            title={againReason ?? undefined}
            onClick={() => {
              const price = cost !== null ? ` It costs about ${stripDollars(cost)}.` : "";
              if (!window.confirm(`Make ${clipLabel(clip)} again?${price} The new clip replaces the current one.`)) return;
              void props.run(() => storylineFetchJson(`${apiBase}/shots/${clip.shotId}/rerender`, { method: "POST" }, "making the shot again"));
            }}
          >
            {clip.status === "failed" ? "Try this shot again" : "Make this clip again"}
            {cost !== null ? ` (about ${stripDollars(cost)})` : ""}
          </button>
        )}
        <button type="button" style={ghostBtn} disabled={disabled || working} onClick={props.onSplit} data-testid="clip-split">
          Split at the playhead
        </button>
        <button type="button" style={dangerBtn} disabled={disabled || working} onClick={props.onRemove} data-testid="clip-remove">
          Remove from film
        </button>
      </div>
      {againReason && (made || clip.status === "failed") && <p style={muted}>{againReason}</p>}
    </div>
  );
}
