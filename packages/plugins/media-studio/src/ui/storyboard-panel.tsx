import { useCallback, useRef, useState } from "react";
import { errorText, storylineFetchJson } from "./storyline-api.js";
import { SKIP_PICTURES_EXPLANATION, STILL_PICTURE_COST_CENTS, dollars, pictureCounts, plural } from "./storyline-flow.js";

// Standalone ES module (see index.tsx's note): bare specifiers only outside
// this ui/ folder, so the helpers and style palette below are small local
// copies rather than imports from index.tsx (which imports this file).
//
// Step 2 of the guided Storylines flow ("Pictures"): a cheap picture per shot
// that the person reviews before any paid video is made. Talks to the
// server's /video-storylines/:id/storyboard routes -- see
// packages/shared/src/video-storyline-stills.ts for the response shape.
//
// The page owns the summary (the step bar needs it on every step) and the
// actions (step 3's one-click fixes reuse them), so this panel only draws.

/** Plain-English errors for every storyboard call -- see storyline-api.ts. */
const hostFetchJson = storylineFetchJson;

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13, whiteSpace: "pre-line" };
const noticeBox: React.CSSProperties = { background: "#fff9db", color: "#7f5f01", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff", padding: "8px 16px", fontSize: 13 };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const approveBtn: React.CSSProperties = { ...baseBtn, background: "#087f5b", color: "#fff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };
const groupBox: React.CSSProperties = { border: "1px dashed rgba(128,128,128,0.45)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 6 };
const muted: React.CSSProperties = { fontSize: 12, color: "#868e96", margin: 0 };

export interface StoryboardShotSummary {
  id: string;
  orderIndex: number;
  storyboardStatus: "pending" | "approved" | "dropped";
  stillObjectKey: string | null;
  stillContentType: string | null;
  stillByteSize: number | null;
  stillGeneratedAt: string | null;
  stillEstimatedCostCents: number | null;
  stillActualCostCents: number | null;
}

export interface StoryboardSummary {
  storylineId: string;
  providerId: string;
  shots: StoryboardShotSummary[];
  stillTotalCents: number;
  allApproved: boolean;
  videoEstimatedTotalCents: number | null;
  videoSpentCents: number;
  approvalThresholdCents: number | null;
}

/** The parts of a shot (from the scenes/shots list) the storyboard needs to show and edit. */
export interface StoryboardShotText {
  id: string;
  sceneId: string;
  orderIndex: number;
  prompt: string;
  cameraNotes: string | null;
}

function money(cents: number | null): string {
  if (cents === null) return "not worked out yet";
  return dollars(cents);
}

/** True when this shot has at least one non-dropped shot, so "all approved" is meaningful. */
export function storyboardReadyToRender(summary: StoryboardSummary | null): boolean {
  if (!summary) return false;
  return summary.allApproved && summary.shots.some((s) => s.storyboardStatus !== "dropped");
}

/** True when the estimated video cost is over the company's approval limit, so a go-ahead from the owner will be needed. */
export function overApprovalLimit(summary: StoryboardSummary | null): boolean {
  return (
    !!summary &&
    summary.approvalThresholdCents !== null &&
    summary.videoEstimatedTotalCents !== null &&
    summary.videoEstimatedTotalCents > summary.approvalThresholdCents
  );
}

/** The picture badge. Green = picture approved; these are never the purple "AI suggestion" colours. */
export function pictureBadge(shot: Pick<StoryboardShotSummary, "storyboardStatus" | "stillObjectKey">): { label: string; color: string; background: string } {
  if (shot.storyboardStatus === "dropped") return { label: "Left out", color: "#868e96", background: "#f1f3f5" };
  if (shot.storyboardStatus === "approved") {
    return shot.stillObjectKey
      ? { label: "Picture approved", color: "#087f5b", background: "#e6fcf5" }
      : { label: "Approved without picture", color: "#087f5b", background: "#e6fcf5" };
  }
  return shot.stillObjectKey
    ? { label: "Picture needs your OK", color: "#7f5f01", background: "#fff3bf" }
    : { label: "No picture yet", color: "#7f5f01", background: "#fff3bf" };
}

// ─── Actions (shared with step 3's one-click fixes) ──────────────────────

export interface BulkProgress {
  label: string;
  done: number;
  total: number;
}

export interface StoryboardActions {
  busyShotId: string | null;
  bulk: BulkProgress | null;
  error: string | null;
  clearError: () => void;
  makePicture: (shotId: string) => Promise<void>;
  approve: (shotId: string) => Promise<void>;
  approveWithoutPicture: (shotId: string) => Promise<void>;
  drop: (shotId: string) => Promise<void>;
  saveText: (shotId: string, prompt: string, cameraNotes: string | null) => Promise<boolean>;
  /** One shot after another (never in parallel), so a failure stops the batch with one clear message. */
  makeMany: (shotIds: string[]) => Promise<void>;
  approveMany: (shotIds: string[]) => Promise<void>;
  /** Approves each shot on its description alone (withoutStill) -- nothing is made or paid for. */
  skipMany: (shotIds: string[]) => Promise<void>;
  /** Stops a running batch after the shot in progress. */
  stop: () => void;
}

export function useStoryboardActions(opts: {
  base: string;
  /** Reload the storyboard summary (and anything else the page shows). */
  reload: () => Promise<void>;
  /** Called after a shot's text changed, so the page reloads its shot list and estimate. */
  onShotsChanged?: () => void | Promise<void>;
}): StoryboardActions {
  const { base, reload, onShotsChanged } = opts;
  const [busyShotId, setBusyShotId] = useState<string | null>(null);
  const [bulk, setBulk] = useState<BulkProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

  const post = useCallback(
    (shotId: string, what: "still" | "approve" | "drop", body: Record<string, unknown>, action: string) =>
      hostFetchJson(`${base}/shots/${shotId}/${what}`, { method: "POST", body: JSON.stringify(body) }, action),
    [base],
  );

  const runOne = useCallback(
    async (shotId: string, fn: () => Promise<unknown>) => {
      setBusyShotId(shotId);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusyShotId(null);
        await reload();
      }
    },
    [reload],
  );

  const runMany = useCallback(
    async (label: string, shotIds: string[], fn: (shotId: string) => Promise<unknown>) => {
      if (shotIds.length === 0) return;
      setError(null);
      stopRef.current = false;
      for (const [index, shotId] of shotIds.entries()) {
        if (stopRef.current) {
          setError(`Stopped after ${plural(index, "shot")} of ${shotIds.length}. Nothing more was made or charged.`);
          break;
        }
        setBulk({ label, done: index, total: shotIds.length });
        setBusyShotId(shotId);
        try {
          await fn(shotId);
        } catch (e) {
          setError(`Stopped at shot ${index + 1} of ${shotIds.length}: ${errorText(e)}`);
          break;
        }
        // Show each finished picture as it lands, not only at the end.
        await reload();
      }
      setBusyShotId(null);
      setBulk(null);
      await reload();
    },
    [reload],
  );

  return {
    busyShotId,
    bulk,
    error,
    clearError: () => setError(null),
    makePicture: (shotId) => runOne(shotId, () => post(shotId, "still", {}, "making the picture")),
    approve: (shotId) => runOne(shotId, () => post(shotId, "approve", {}, "approving the picture")),
    approveWithoutPicture: (shotId) => runOne(shotId, () => post(shotId, "approve", { withoutStill: true }, "approving the shot")),
    drop: (shotId) => runOne(shotId, () => post(shotId, "drop", {}, "leaving the shot out")),
    saveText: async (shotId, prompt, cameraNotes) => {
      let ok = false;
      await runOne(shotId, async () => {
        await hostFetchJson(`${base}/shots/${shotId}`, { method: "PATCH", body: JSON.stringify({ prompt, cameraNotes }) }, "saving the shot");
        ok = true;
        await onShotsChanged?.();
      });
      return ok;
    },
    makeMany: (ids) => runMany("Making picture", ids, (id) => post(id, "still", {}, "making a picture")),
    approveMany: (ids) => runMany("Approving picture", ids, (id) => post(id, "approve", {}, "approving a picture")),
    skipMany: (ids) => runMany("Skipping picture for shot", ids, (id) => post(id, "approve", { withoutStill: true }, "approving a shot without a picture")),
    stop: () => {
      stopRef.current = true;
    },
  };
}

export function BulkProgressBar({ bulk, onStop }: { bulk: BulkProgress; onStop?: () => void }) {
  const pct = bulk.total > 0 ? Math.round((bulk.done / bulk.total) * 100) : 0;
  return (
    <div data-testid="bulk-progress" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12 }}>
        <span>
          {bulk.label} {Math.min(bulk.done + 1, bulk.total)} of {bulk.total}...
        </span>
        {onStop && (
          <button type="button" style={ghostBtn} onClick={onStop}>
            Stop after this one
          </button>
        )}
      </div>
      <div style={{ height: 6, borderRadius: 3, background: "rgba(128,128,128,0.2)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: "#1971c2" }} />
      </div>
    </div>
  );
}

// ─── The step 2 panel ────────────────────────────────────────────────────

export function StoryboardPanel(props: {
  base: string;
  summary: StoryboardSummary | null;
  /** Problem loading the summary (shown instead of the tiles). */
  loadError: string | null;
  shots: StoryboardShotText[];
  /** False once a render has started: shots can no longer be changed. */
  editable: boolean;
  actions: StoryboardActions;
  /** Moves the person on to step 3. */
  onNext: () => void;
}) {
  const { base, summary, actions } = props;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const [editCamera, setEditCamera] = useState("");
  const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());
  /** "make" = confirming the bulk picture run (shows the cost first); "skip" = explaining what skipping means. */
  const [confirming, setConfirming] = useState<"make" | "skip" | null>(null);

  if (!summary && !props.loadError) {
    return <div style={card}><p style={{ fontSize: 12, margin: 0 }}>Loading the pictures...</p></div>;
  }

  const textById = new Map(props.shots.map((s) => [s.id, s]));
  const sorted = (summary?.shots ?? []).slice().sort((a, b) => a.orderIndex - b.orderIndex);
  const counts = pictureCounts(summary);
  const busy = actions.busyShotId !== null || actions.bulk !== null;
  const makeCost = counts.missing * STILL_PICTURE_COST_CENTS;

  const startEdit = (shot: StoryboardShotText) => {
    setEditingId(shot.id);
    setEditPrompt(shot.prompt);
    setEditCamera(shot.cameraNotes ?? "");
  };

  const unbreak = (ids: string[]) =>
    setBrokenImages((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });

  // The one primary action for this step.
  let primary: { label: string; onClick: () => void; testId: string } | null = null;
  if (props.editable && counts.missing > 0) {
    primary = { label: `Make all ${plural(counts.missing, "missing picture")}`, onClick: () => setConfirming("make"), testId: "pictures-primary-make" };
  } else if (props.editable && counts.waiting > 0) {
    primary = { label: `Approve all ${plural(counts.waiting, "picture")}`, onClick: () => void actions.approveMany(counts.waitingIds), testId: "pictures-primary-approve" };
  } else if (counts.total > 0 && counts.approved === counts.total) {
    primary = { label: "Next: Budget & render", onClick: props.onNext, testId: "pictures-primary-next" };
  }

  const statusLine =
    counts.total === 0
      ? "Every shot is left out. Edit a shot to bring it back."
      : counts.approved === counts.total
        ? `All ${plural(counts.total, "shot")} approved. Next, set the budget and start the render.`
        : [
            `${counts.approved} of ${counts.total} pictures approved.`,
            counts.waiting > 0 ? `${plural(counts.waiting, "picture")} waiting for your OK.` : "",
            counts.missing > 0 ? `${plural(counts.missing, "shot")} without a picture.` : "",
          ]
            .filter(Boolean)
            .join(" ");

  return (
    <div style={card} data-testid="storyboard-panel">
      <div>
        <strong style={{ fontSize: 14 }}>Step 2: Pictures</strong>
        <p style={muted}>
          Check a cheap picture of each shot first (about {dollars(STILL_PICTURE_COST_CENTS)} each). Video is only made for shots you approve, so you don't pay for clips that look wrong.
        </p>
      </div>

      {props.loadError && <div style={errorBox}>{props.loadError}</div>}
      {actions.error && <div style={errorBox} role="alert">{actions.error}</div>}

      {summary && sorted.length > 0 && (
        <p style={{ fontSize: 13, margin: 0, fontWeight: 600 }} data-testid="storyboard-progress">
          {statusLine}
        </p>
      )}
      {summary && sorted.length === 0 && <p style={{ fontSize: 12, margin: 0 }}>Add a shot in step 1 to see its picture here.</p>}

      {actions.bulk && <BulkProgressBar bulk={actions.bulk} onStop={actions.stop} />}

      {confirming === "make" && !actions.bulk && (
        <div style={noticeBox} data-testid="make-pictures-confirm">
          <div>
            This makes {plural(counts.missing, "picture")}, one after another, at about {dollars(STILL_PICTURE_COST_CENTS)} each: about <strong>{dollars(makeCost)}</strong> in all. You can stop at any time; pictures already made are kept.
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              style={{ ...baseBtn, background: "#1971c2", color: "#fff" }}
              disabled={busy}
              onClick={() => {
                setConfirming(null);
                unbreak(counts.missingIds);
                void actions.makeMany(counts.missingIds);
              }}
            >
              Make {plural(counts.missing, "picture")} (about {dollars(makeCost)})
            </button>
            <button type="button" style={ghostBtn} onClick={() => setConfirming(null)}>Cancel</button>
          </div>
        </div>
      )}

      {primary && !actions.bulk && confirming !== "make" && (
        <div>
          <button type="button" style={primaryBtn} data-testid={primary.testId} disabled={busy} onClick={primary.onClick}>
            {primary.label}
          </button>
        </div>
      )}

      {props.editable && (counts.missing > 0 || counts.waiting > 0) && !actions.bulk && (
        <div style={groupBox} data-testid="pictures-other-options">
          <strong style={{ fontSize: 12 }}>Other options for all shots</strong>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {counts.waiting > 0 && counts.missing > 0 && (
              <button type="button" style={approveBtn} disabled={busy} onClick={() => void actions.approveMany(counts.waitingIds)}>
                Approve all {plural(counts.waiting, "picture")} made so far
              </button>
            )}
            {counts.missing > 0 && (
              <button type="button" style={ghostBtn} disabled={busy} onClick={() => setConfirming(confirming === "skip" ? null : "skip")}>
                Skip pictures for all {plural(counts.missing, "remaining shot")}
              </button>
            )}
          </div>
          {confirming === "skip" && (
            <div style={noticeBox} data-testid="skip-pictures-confirm">
              <div>{SKIP_PICTURES_EXPLANATION}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={{ ...baseBtn, background: "#495057", color: "#fff" }}
                  disabled={busy}
                  onClick={() => {
                    setConfirming(null);
                    void actions.skipMany(counts.missingIds);
                  }}
                >
                  Skip pictures for {plural(counts.missing, "shot")}
                </button>
                <button type="button" style={ghostBtn} onClick={() => setConfirming(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {summary && (
        <div data-testid="storyboard-costs" style={{ display: "flex", flexWrap: "wrap", gap: "2px 16px", fontSize: 12, color: "#495057" }}>
          <span>Pictures so far: {money(summary.stillTotalCents)}</span>
          <span>
            {summary.videoSpentCents > 0
              ? `Video spent so far: ${money(summary.videoSpentCents)}${summary.videoEstimatedTotalCents !== null ? ` (estimated ${money(summary.videoEstimatedTotalCents)} in all)` : ""}`
              : `Video will cost about ${money(summary.videoEstimatedTotalCents)} (a ballpark, not a quote)`}
          </span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(190px, 100%), 1fr))", gap: 10 }}>
        {sorted.map((shot) => {
          const text = textById.get(shot.id);
          const badge = pictureBadge(shot);
          const hasPicture = shot.stillObjectKey !== null && !brokenImages.has(shot.id);
          const cost = shot.stillActualCostCents ?? shot.stillEstimatedCostCents;
          const tileBusy = actions.busyShotId === shot.id;
          const editing = editingId === shot.id;
          return (
            <div
              key={shot.id}
              data-testid={`storyboard-tile-${shot.id}`}
              style={{ border: "1px solid rgba(128,128,128,0.3)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 6, opacity: shot.storyboardStatus === "dropped" ? 0.6 : 1 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, fontSize: 12 }}>
                <strong>Shot {shot.orderIndex + 1}</strong>
                <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, color: badge.color, background: badge.background }}>{badge.label}</span>
              </div>
              <div style={{ aspectRatio: "16 / 9", borderRadius: 6, background: "rgba(128,128,128,0.12)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                {tileBusy && actions.bulk?.label === "Making picture" ? (
                  <span style={{ fontSize: 11, color: "#868e96" }}>Making the picture...</span>
                ) : hasPicture ? (
                  <img
                    loading="lazy"
                    alt={`Picture for shot ${shot.orderIndex + 1}`}
                    src={`${base}/shots/${shot.id}/still/content${shot.stillGeneratedAt ? `?v=${encodeURIComponent(shot.stillGeneratedAt)}` : ""}`}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    onError={() => setBrokenImages((prev) => new Set(prev).add(shot.id))}
                  />
                ) : (
                  <span style={{ fontSize: 11, color: "#868e96", padding: 6, textAlign: "center" }}>
                    {shot.stillObjectKey
                      ? "Picture could not be shown"
                      : shot.storyboardStatus === "dropped"
                        ? "Left out of the video"
                        : shot.storyboardStatus === "approved"
                          ? "No picture: starts from the previous clip"
                          : "No picture yet"}
                  </span>
                )}
              </div>
              {text && !editing && <div style={{ fontSize: 12 }}>{text.prompt}{text.cameraNotes ? <span style={{ color: "#868e96" }}> · {text.cameraNotes}</span> : null}</div>}
              <div style={{ fontSize: 11, color: "#868e96" }}>
                {shot.storyboardStatus === "dropped" ? "Not charged" : cost !== null ? `Picture cost: ${money(cost)}` : "Picture not made yet"}
              </div>

              {editing ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <textarea style={{ ...input, minHeight: 50 }} aria-label="What happens in this shot" value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} />
                  <input style={input} aria-label="Camera notes" placeholder="Camera notes (optional)" value={editCamera} onChange={(e) => setEditCamera(e.target.value)} />
                  <p style={{ fontSize: 11, color: "#868e96", margin: 0 }}>Saving clears the current picture and approval. You'll make a new picture and approve it again.</p>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      style={{ ...baseBtn, background: "#1971c2", color: "#fff" }}
                      disabled={tileBusy || !editPrompt.trim()}
                      onClick={async () => {
                        if (await actions.saveText(shot.id, editPrompt.trim(), editCamera.trim() || null)) setEditingId(null);
                      }}
                    >
                      Save changes
                    </button>
                    <button type="button" style={ghostBtn} disabled={tileBusy} onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                props.editable && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {shot.storyboardStatus === "pending" && shot.stillObjectKey && (
                      <button type="button" style={approveBtn} disabled={busy} onClick={() => void actions.approve(shot.id)}>Approve picture</button>
                    )}
                    {shot.storyboardStatus !== "dropped" && (
                      <button
                        type="button"
                        style={secondaryBtn}
                        disabled={busy}
                        onClick={() => {
                          unbreak([shot.id]);
                          void actions.makePicture(shot.id);
                        }}
                      >
                        {shot.stillObjectKey ? "Remake picture" : "Make picture"}
                      </button>
                    )}
                    {shot.storyboardStatus === "pending" && !shot.stillObjectKey && (
                      <button type="button" style={ghostBtn} disabled={busy} title={SKIP_PICTURES_EXPLANATION} onClick={() => void actions.approveWithoutPicture(shot.id)}>
                        Approve without picture
                      </button>
                    )}
                    {text && (
                      <button type="button" style={ghostBtn} disabled={busy} onClick={() => startEdit(text)}>
                        {shot.storyboardStatus === "dropped" ? "Edit to bring back" : "Edit text"}
                      </button>
                    )}
                    {shot.storyboardStatus !== "dropped" && (
                      <button type="button" style={ghostBtn} disabled={busy} title="Leave this shot out of the film. Nothing is charged for it." onClick={() => void actions.drop(shot.id)}>
                        Drop shot
                      </button>
                    )}
                  </div>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
