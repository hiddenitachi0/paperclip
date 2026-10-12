import type { FlowStepKey, ReadinessFix, ReadinessItem, StepStatus } from "./storyline-flow.js";
import { dollars } from "./storyline-flow.js";

// Drawing pieces of the guided Storylines flow (see storyline-flow.ts for the
// logic): the step bar, step 3's "what is missing" checklist, and step 4's
// film panel. Standalone ES module -- local style copies, no host imports.

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff", padding: "8px 16px", fontSize: 13 };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };
const dangerGhostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#c92a2a", borderColor: "#ffc9c9" };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13, whiteSpace: "pre-line" };
const okBox: React.CSSProperties = { background: "#e6fcf5", color: "#087f5b", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const muted: React.CSSProperties = { fontSize: 12, color: "#868e96", margin: 0 };

const STATE_COLORS: Record<StepStatus["state"], { dot: string; text: string }> = {
  done: { dot: "#087f5b", text: "#087f5b" },
  ready: { dot: "#1971c2", text: "#1971c2" },
  working: { dot: "#1971c2", text: "#1971c2" },
  attention: { dot: "#e8590c", text: "#d9480f" },
  todo: { dot: "#adb5bd", text: "#868e96" },
};

export function StepBar(props: { steps: StepStatus[]; active: FlowStepKey; onSelect: (key: FlowStepKey) => void }) {
  return (
    <nav aria-label="Storyline steps" data-testid="step-bar" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 6 }}>
      {props.steps.map((step) => {
        const active = step.key === props.active;
        const colors = STATE_COLORS[step.state];
        return (
          <button
            key={step.key}
            type="button"
            data-testid={`step-${step.key}`}
            aria-current={active ? "step" : undefined}
            onClick={() => props.onSelect(step.key)}
            style={{
              textAlign: "left",
              padding: "8px 10px",
              borderRadius: 8,
              cursor: "pointer",
              border: active ? "2px solid #1971c2" : "1px solid rgba(128,128,128,0.35)",
              background: active ? "#e7f5ff" : "transparent",
              color: "inherit",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700 }}>
              <span
                aria-hidden
                style={{ width: 20, height: 20, borderRadius: 10, background: colors.dot, color: "#fff", fontSize: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
              >
                {step.state === "done" ? "✓" : step.number}
              </span>
              {step.title}
            </span>
            <span style={{ fontSize: 11, color: colors.text }} data-testid={`step-${step.key}-status`}>
              {step.status}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export function SuggestionsBanner(props: { count: number; onReview?: () => void }) {
  if (props.count <= 0) return null;
  return (
    <div
      data-testid="suggestions-banner"
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", background: "#f3f0ff", color: "#5f3dc4", border: "1px solid #d0bfff", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
    >
      <span>
        <strong>
          {props.count} AI suggestion{props.count === 1 ? "" : "s"} waiting.
        </strong>{" "}
        The AI director proposed new wording for {props.count === 1 ? "a shot" : "some shots"}. Accepting changes the text only; it does not approve any picture.
      </span>
      {props.onReview && (
        <button type="button" style={{ ...baseBtn, background: "#7048e8", color: "#fff" }} onClick={props.onReview}>
          Review suggestions
        </button>
      )}
    </div>
  );
}

export function ReadinessChecklist(props: {
  items: ReadinessItem[];
  busy: boolean;
  onFix: (fix: ReadinessFix) => void;
}) {
  if (props.items.length === 0) {
    return (
      <div style={okBox} data-testid="readiness-ready">
        Everything is ready. Start the render when you are.
      </div>
    );
  }
  return (
    <ul data-testid="readiness-list" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      {props.items.map((item) => (
        <li
          key={item.id}
          data-testid={`readiness-${item.id}`}
          style={{
            border: `1px solid ${item.blocking ? "#ffc9c9" : "#ffe066"}`,
            background: item.blocking ? "#fff5f5" : "#fff9db",
            borderRadius: 8,
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 12,
          }}
        >
          <span>
            <strong style={{ color: item.blocking ? "#c92a2a" : "#7f5f01" }}>{item.blocking ? "Needed: " : "Good to know: "}</strong>
            {item.text}
          </span>
          {item.fixes.length > 0 && (
            <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {item.fixes.map((fix, i) => (
                <button key={`${fix.kind}-${i}`} type="button" style={i === 0 ? secondaryBtn : ghostBtn} disabled={props.busy} onClick={() => props.onFix(fix)}>
                  {fix.label}
                </button>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ─── Step 4: Film ────────────────────────────────────────────────────────

export interface FilmStoryline {
  id: string;
  title: string;
  status: string;
  finalObjectKey: string | null;
  finalByteSize: number | null;
  finalDurationSeconds: number | null;
  spentCents: number;
  budgetCapCents: number | null;
  stitchBlockedReason: string | null;
  errorMessage: string | null;
  qualityCheckedAt?: string | null;
  qualityCheckIssues?: Array<{ message: string }> | null;
}

export interface FilmProgress {
  totalShots: number;
  doneShots: number;
  failedShots: number;
  renderingShots: number;
  spentCents: number;
  budgetCapCents: number | null;
  stitchBlockedReason: string | null;
  shots: Array<{ id: string; orderIndex: number; status: string; attempt: number; errorMessage: string | null }>;
}

function shotStatusText(status: string): string {
  switch (status) {
    case "draft":
      return "Not started";
    case "queued":
      return "Waiting to render";
    case "rendering":
      return "Rendering now";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

const SHOT_COLORS: Record<string, string> = { done: "#087f5b", failed: "#c92a2a", rendering: "#1971c2", queued: "#1971c2" };

export function FilmPanel(props: {
  storyline: FilmStoryline;
  progress: FilmProgress | null;
  videoUrl: string;
  busy: boolean;
  onRetryShot: (shotId: string) => void;
  onCombineAgain: () => void;
  onCancel: () => void;
  onGoRender: () => void;
  onRefresh: () => void;
}) {
  const { storyline, progress } = props;
  const status = storyline.status;
  const total = progress?.totalShots ?? 0;
  const done = progress?.doneShots ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const hasFilm = !!storyline.finalObjectKey && (status === "done" || status === "needs_attention");
  const issues = storyline.qualityCheckIssues ?? [];

  let headline: string;
  let primary: { label: string; onClick?: () => void; href?: string } | null = null;
  switch (status) {
    case "rendering":
      headline = `Rendering clip ${Math.min(done + 1, Math.max(total, 1))} of ${total}. This runs in the background; you can leave the page.`;
      primary = { label: "Refresh", onClick: props.onRefresh };
      break;
    case "ready_to_stitch":
      headline = "All clips are done. They will be combined into one film in a moment.";
      primary = { label: "Refresh", onClick: props.onRefresh };
      break;
    case "stitching":
      headline = "Combining the clips into one film...";
      primary = { label: "Refresh", onClick: props.onRefresh };
      break;
    case "done":
      headline = "Your film is ready.";
      primary = { label: "Download film", href: props.videoUrl };
      break;
    case "needs_attention":
      headline = "Your film is made, but the automatic quality check found problems. Watch it, then combine the clips again if needed.";
      primary = { label: "Combine again", onClick: props.onCombineAgain };
      break;
    case "paused":
      headline = `Paused with ${done} of ${total} clips done (usually the budget limit was reached). Finished clips are kept.`;
      primary = { label: "Continue: check budget & render", onClick: props.onGoRender };
      break;
    case "failed":
      headline = "The render failed. Finished clips are kept; fix what is listed and start again.";
      primary = { label: "Go to Budget & render", onClick: props.onGoRender };
      break;
    case "cancelled":
      headline = done > 0 ? `Cancelled. ${done} of ${total} clips are kept.` : "Cancelled.";
      primary = { label: "Go to Budget & render", onClick: props.onGoRender };
      break;
    default:
      headline = "Nothing has been rendered yet. Start the render in step 3.";
      primary = { label: "Go to Budget & render", onClick: props.onGoRender };
  }

  return (
    <div style={card} data-testid="film-panel">
      <div>
        <strong style={{ fontSize: 14 }}>Step 4: Film</strong>
        <p style={{ fontSize: 13, margin: "2px 0 0" }} data-testid="film-headline">{headline}</p>
      </div>

      {primary && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {primary.href ? (
            <a href={primary.href} download={`${storyline.title || "video-storyline"}.mp4`} style={{ ...primaryBtn, textDecoration: "none", display: "inline-block" }}>
              {primary.label}
              {storyline.finalByteSize ? ` (${(storyline.finalByteSize / (1024 * 1024)).toFixed(1)} MB)` : ""}
            </a>
          ) : (
            <button type="button" style={primaryBtn} disabled={props.busy} onClick={primary.onClick}>
              {primary.label}
            </button>
          )}
          {status === "rendering" && (
            <button type="button" style={dangerGhostBtn} disabled={props.busy} onClick={props.onCancel}>
              Cancel render
            </button>
          )}
        </div>
      )}

      {storyline.errorMessage && status !== "needs_attention" && <div style={errorBox}>{storyline.errorMessage}</div>}
      {(progress?.stitchBlockedReason ?? storyline.stitchBlockedReason) && <div style={errorBox}>{progress?.stitchBlockedReason ?? storyline.stitchBlockedReason}</div>}

      {(status === "done" || status === "needs_attention") && (
        <div style={status === "done" ? okBox : errorBox} data-testid="quality-check">
          {status === "done" ? (
            "The automatic quality check passed."
          ) : issues.length > 0 ? (
            <>
              Quality check found {issues.length} problem{issues.length === 1 ? "" : "s"}:
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {issues.map((issue, i) => <li key={i}>{issue.message}</li>)}
              </ul>
            </>
          ) : (
            storyline.errorMessage ?? "Quality check found problems."
          )}
        </div>
      )}

      {hasFilm && (
        <>
          <video controls style={{ width: "100%", borderRadius: 8, background: "#000" }} src={props.videoUrl} data-testid="film-video" />
          {status === "needs_attention" && (
            <a href={props.videoUrl} download={`${storyline.title || "video-storyline"}.mp4`} style={{ color: "#1971c2", fontSize: 12 }}>
              Download this version anyway
            </a>
          )}
        </>
      )}

      {progress && total > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="film-progress">
          <div style={{ height: 8, borderRadius: 4, background: "rgba(128,128,128,0.2)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: "#087f5b" }} />
          </div>
          <p style={{ fontSize: 12, margin: 0 }}>
            {done} of {total} clips done
            {progress.renderingShots > 0 ? `, ${progress.renderingShots} rendering now` : ""}
            {progress.failedShots > 0 ? `, ${progress.failedShots} failed` : ""}. Spent {dollars(progress.spentCents)}
            {progress.budgetCapCents !== null ? ` of ${dollars(progress.budgetCapCents)}` : ""}.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {progress.shots.map((shot) => (
              <div key={shot.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12, flexWrap: "wrap" }} data-testid={`film-shot-${shot.id}`}>
                <span>
                  Shot {shot.orderIndex + 1}: <span style={{ color: SHOT_COLORS[shot.status] ?? "#868e96", fontWeight: 600 }}>{shotStatusText(shot.status)}</span>
                  {shot.errorMessage ? ` (${shot.errorMessage})` : ""}
                </span>
                {shot.status === "failed" && (
                  <button type="button" style={ghostBtn} disabled={props.busy} onClick={() => props.onRetryShot(shot.id)}>
                    Try this shot again
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {!progress && <p style={muted}>No render progress yet.</p>}
    </div>
  );
}
