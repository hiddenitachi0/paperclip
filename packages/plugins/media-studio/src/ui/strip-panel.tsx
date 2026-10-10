import { useCallback, useEffect, useState } from "react";
import { errorText, storylineFetchJson } from "./storyline-api.js";

// Storyline strip (Simple editor, Phase 1; design 2.1): the film as a row of
// clip cards with a transition tile in every gap, and an inspector for the
// selected transition. Talks to /video-storylines/:id/strip and
// /transitions. Standalone ES module (see index.tsx's note): local types and
// styles, no imports from @paperclipai/shared.

type Kind = "cut" | "blend" | "dissolve" | "fade" | "ai";
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

export interface StripClip {
  shotId: string;
  orderIndex: number;
  prompt: string;
  cameraNotes: string | null;
  durationSeconds: number;
  status: string;
  hasClip: boolean;
  hasPoster: boolean;
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
}

const KIND_LABEL: Record<Kind, string> = { cut: "Cut", blend: "Smooth blend", dissolve: "Grainy dissolve", fade: "Soft fade", ai: "AI bridge" };
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

function gapKey(gap: Pick<StripGap, "fromShotId" | "toShotId">): string {
  return `${gap.fromShotId}:${gap.toShotId}`;
}

export function StripPanel(props: { apiBase: string; editable: boolean; onCombineAgain?: () => void | Promise<void> }) {
  const { apiBase, editable } = props;
  const [strip, setStrip] = useState<StripSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

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

  // While a version is being made, check every few seconds.
  const generating = strip?.gaps.some((g) => g.state === "generating") ?? false;
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [generating, load]);

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
  const putGap = (g: StripGap, patch: Record<string, unknown>) =>
    run(() => storylineFetchJson(`${apiBase}/transitions`, { method: "PUT", body: JSON.stringify({ fromShotId: g.fromShotId, toShotId: g.toShotId, ...patch }) }, "saving the transition"));

  return (
    <div style={card} data-testid="strip-panel">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <strong style={{ fontSize: 14 }}>Strip: your clips and the joins between them</strong>
          <p style={muted}>Click a join to choose how one clip turns into the next. Nothing is made or paid for until you press a button that shows its price.</p>
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

      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 6, alignItems: "stretch" }} data-testid="strip-row">
        {strip.clips.map((clip, index) => {
          const before = index > 0 ? strip.gaps[index - 1] : undefined;
          return (
            <div key={clip.shotId} style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
              {before && <GapTile gap={before} selected={selected === gapKey(before)} onSelect={() => setSelected(gapKey(before))} />}
              <ClipCard clip={clip} apiBase={apiBase} playing={playing === clip.shotId} onPlay={() => setPlaying(playing === clip.shotId ? null : clip.shotId)} />
            </div>
          );
        })}
        {strip.clips.length === 0 && <p style={muted}>No shots yet. Write and render some shots first.</p>}
      </div>

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
    </div>
  );
}

function ClipCard(props: { clip: StripClip; apiBase: string; playing: boolean; onPlay: () => void }) {
  const { clip } = props;
  return (
    <div
      data-testid={`strip-clip-${clip.shotId}`}
      style={{ width: 170, flexShrink: 0, border: "1px solid rgba(128,128,128,0.35)", borderRadius: 8, padding: 6, display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}
    >
      {props.playing && clip.hasClip ? (
        <video src={`${props.apiBase}/shots/${clip.shotId}/clip`} controls autoPlay style={{ width: "100%", borderRadius: 6 }} />
      ) : clip.hasPoster ? (
        <img src={`${props.apiBase}/shots/${clip.shotId}/poster`} alt={`Shot ${clip.orderIndex + 1}`} style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 6 }} />
      ) : (
        <div style={{ width: "100%", aspectRatio: "16 / 9", borderRadius: 6, background: "rgba(128,128,128,0.15)" }} />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 4 }}>
        <strong>Shot {clip.orderIndex + 1}</strong>
        <span style={{ color: "#868e96" }}>
          {clip.durationSeconds} s · {SHOT_STATUS[clip.status] ?? clip.status}
        </span>
      </div>
      <span style={{ color: "#868e96", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={clip.prompt}>
        AI shot · {clip.prompt}
      </span>
      {clip.hasClip && (
        <button type="button" style={ghostBtn} onClick={props.onPlay} aria-label={`Play shot ${clip.orderIndex + 1}`}>
          {props.playing ? "Stop" : "Play"}
        </button>
      )}
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
  const isBlend = gap.kind === "blend" || gap.kind === "dissolve" || gap.kind === "fade";
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
          value={gap.kind === "dissolve" || gap.kind === "fade" ? gap.kind : ""}
          disabled={lockedOut}
          onChange={(e) => e.target.value && props.onPut({ kind: e.target.value })}
        >
          <option value="">More…</option>
          <option value="fade">Soft fade</option>
          <option value="dissolve">Grainy dissolve</option>
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
