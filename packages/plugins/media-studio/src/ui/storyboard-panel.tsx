import { useCallback, useEffect, useState } from "react";

// Standalone ES module (see index.tsx's note): bare specifiers only outside
// this ui/ folder, so the helpers and style palette below are small local
// copies rather than imports from index.tsx (which imports this file).
//
// Storyboard (contact sheet) for one storyline: a cheap picture per shot that
// the person reviews before any paid video is made. Talks to the server's
// /video-storylines/:id/storyboard routes -- see
// packages/shared/src/video-storyline-stills.ts for the response shape.

function hostFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, { credentials: "include", headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init }).then(
    async (res) => {
      if (!res.ok) throw new Error((await res.text()) || `Request failed: ${res.status}`);
      return (res.status === 204 ? (undefined as T) : ((await res.json()) as T));
    },
  );
}

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 6 };
const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const noticeBox: React.CSSProperties = { background: "#fff9db", color: "#7f5f01", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const approveBtn: React.CSSProperties = { ...baseBtn, background: "#087f5b", color: "#fff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };

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
  return `$${(cents / 100).toFixed(2)}`;
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

const STATUS_TEXT: Record<StoryboardShotSummary["storyboardStatus"], { label: string; color: string; background: string }> = {
  pending: { label: "Needs your OK", color: "#7f5f01", background: "#fff3bf" },
  approved: { label: "Approved", color: "#087f5b", background: "#e6fcf5" },
  dropped: { label: "Left out", color: "#868e96", background: "#f1f3f5" },
};

export function StoryboardPanel(props: {
  companyId: string;
  storylineId: string;
  shots: StoryboardShotText[];
  /** False once a render has started: shots can no longer be changed. */
  editable: boolean;
  /** True after "Start render" was refused because the owner's go-ahead is still pending. */
  approvalPending: boolean;
  /** Called whenever the summary is (re)loaded so the page can gate "Start render" on it. */
  onSummary: (summary: StoryboardSummary | null) => void;
  /** Called after a shot's text is saved, so the page can refresh its own shot list and cost estimate. */
  onShotsChanged: () => void | Promise<void>;
}) {
  const { companyId, storylineId, onSummary, onShotsChanged } = props;
  const base = `/api/companies/${companyId}/video-storylines/${storylineId}`;
  const [summary, setSummary] = useState<StoryboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyShotId, setBusyShotId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const [editCamera, setEditCamera] = useState("");
  const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await hostFetchJson<StoryboardSummary>(`${base}/storyboard`);
      setSummary(res);
      onSummary(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      onSummary(null);
    }
  }, [base, onSummary]);

  useEffect(() => {
    setSummary(null);
    setEditingId(null);
    void load();
  }, [load]);

  // The shot list changed under us (a shot was added or removed on the page): refresh the sheet too.
  const shotKey = props.shots.map((s) => s.id).join(",");
  useEffect(() => {
    void load();
  }, [shotKey, load]);

  const run = async (shotId: string, action: () => Promise<unknown>) => {
    setBusyShotId(shotId);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyShotId(null);
    }
  };

  const makePicture = (shotId: string) => {
    setBrokenImages((prev) => {
      const next = new Set(prev);
      next.delete(shotId);
      return next;
    });
    return run(shotId, () => hostFetchJson(`${base}/shots/${shotId}/still`, { method: "POST", body: JSON.stringify({}) }));
  };
  const approve = (shotId: string) => run(shotId, () => hostFetchJson(`${base}/shots/${shotId}/approve`, { method: "POST", body: JSON.stringify({}) }));
  const leaveOut = (shotId: string) => run(shotId, () => hostFetchJson(`${base}/shots/${shotId}/drop`, { method: "POST", body: JSON.stringify({}) }));

  const startEdit = (shot: StoryboardShotText) => {
    setEditingId(shot.id);
    setEditPrompt(shot.prompt);
    setEditCamera(shot.cameraNotes ?? "");
  };

  const saveEdit = (shotId: string) =>
    run(shotId, async () => {
      await hostFetchJson(`${base}/shots/${shotId}`, {
        method: "PATCH",
        body: JSON.stringify({ prompt: editPrompt.trim(), cameraNotes: editCamera.trim() || null }),
      });
      setEditingId(null);
      await onShotsChanged();
    });

  if (!summary && !error) {
    return <div style={card}><p style={{ fontSize: 12, margin: 0 }}>Loading the storyboard...</p></div>;
  }

  const textById = new Map(props.shots.map((s) => [s.id, s]));
  const sorted = (summary?.shots ?? []).slice().sort((a, b) => a.orderIndex - b.orderIndex);
  const waitingOn = sorted.filter((s) => s.storyboardStatus === "pending").length;
  const over = overApprovalLimit(summary);

  return (
    <div style={card} data-testid="storyboard-panel">
      <strong style={{ fontSize: 13 }}>Storyboard</strong>
      <p style={{ fontSize: 12, color: "#868e96", margin: 0 }}>
        Check a cheap picture of each shot first. The video is only made for shots you approve, so you don't pay for clips that look wrong.
      </p>
      {error && <div style={errorBox}>{error}</div>}

      {summary && (
        <div data-testid="storyboard-costs" style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
          <span>Pictures so far: {money(summary.stillTotalCents)}</span>
          <span>
            {summary.videoSpentCents > 0
              ? `Video spent so far: ${money(summary.videoSpentCents)}${summary.videoEstimatedTotalCents !== null ? ` (estimated ${money(summary.videoEstimatedTotalCents)} in all)` : ""}`
              : `Video will cost about ${money(summary.videoEstimatedTotalCents)} (a ballpark, not a quote)`}
          </span>
        </div>
      )}

      {over && summary && !props.approvalPending && (
        <div style={noticeBox} data-testid="storyboard-over-limit">
          This video is expected to cost more than your approval limit of {money(summary.approvalThresholdCents)}. When you press Start render, a request will go to the owner and the video waits until it is approved.
        </div>
      )}
      {props.approvalPending && (
        <div style={noticeBox} data-testid="storyboard-approval-pending">
          Waiting for the owner's go-ahead. This video costs more than your approval limit, so it will start once the owner approves the request.
        </div>
      )}

      {summary && sorted.length === 0 && <p style={{ fontSize: 12, margin: 0 }}>Add a shot to see its picture here.</p>}
      {summary && sorted.length > 0 && (
        <p style={{ fontSize: 12, margin: 0 }} data-testid="storyboard-progress">
          {waitingOn === 0
            ? "Every shot is approved or left out. You can start the render."
            : `${waitingOn} shot${waitingOn === 1 ? "" : "s"} still need${waitingOn === 1 ? "s" : ""} your OK before you can start the render.`}
        </p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 10 }}>
        {sorted.map((shot) => {
          const text = textById.get(shot.id);
          const status = STATUS_TEXT[shot.storyboardStatus];
          const hasPicture = shot.stillObjectKey !== null && !brokenImages.has(shot.id);
          const cost = shot.stillActualCostCents ?? shot.stillEstimatedCostCents;
          const busy = busyShotId === shot.id;
          const editing = editingId === shot.id;
          return (
            <div
              key={shot.id}
              data-testid={`storyboard-tile-${shot.id}`}
              style={{ border: "1px solid rgba(128,128,128,0.3)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 6, opacity: shot.storyboardStatus === "dropped" ? 0.6 : 1 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                <strong>Shot {shot.orderIndex + 1}</strong>
                <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, color: status.color, background: status.background }}>{status.label}</span>
              </div>
              <div style={{ aspectRatio: "16 / 9", borderRadius: 6, background: "rgba(128,128,128,0.12)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                {hasPicture ? (
                  <img
                    alt={`Picture for shot ${shot.orderIndex + 1}`}
                    src={`${base}/shots/${shot.id}/still/content${shot.stillGeneratedAt ? `?v=${encodeURIComponent(shot.stillGeneratedAt)}` : ""}`}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    onError={() => setBrokenImages((prev) => new Set(prev).add(shot.id))}
                  />
                ) : (
                  <span style={{ fontSize: 11, color: "#868e96", padding: 6, textAlign: "center" }}>
                    {shot.stillObjectKey ? "Picture could not be shown" : shot.storyboardStatus === "dropped" ? "Left out of the video" : "No picture yet"}
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
                    <button type="button" style={primaryBtn} disabled={busy || !editPrompt.trim()} onClick={() => void saveEdit(shot.id)}>Save changes</button>
                    <button type="button" style={ghostBtn} disabled={busy} onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                props.editable && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {shot.storyboardStatus !== "dropped" && (
                      <button type="button" style={secondaryBtn} disabled={busy} onClick={() => void makePicture(shot.id)}>
                        {shot.stillObjectKey ? "Make a new picture" : "Make picture"}
                      </button>
                    )}
                    {shot.storyboardStatus === "pending" && shot.stillObjectKey && (
                      <button type="button" style={approveBtn} disabled={busy} onClick={() => void approve(shot.id)}>Approve</button>
                    )}
                    {text && (
                      <button type="button" style={ghostBtn} disabled={busy} onClick={() => startEdit(text)}>
                        {shot.storyboardStatus === "dropped" ? "Edit to bring back" : "Edit"}
                      </button>
                    )}
                    {shot.storyboardStatus !== "dropped" && (
                      <button type="button" style={ghostBtn} disabled={busy} onClick={() => void leaveOut(shot.id)}>Leave out</button>
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
