import { useCallback, useEffect, useRef, useState } from "react";

// The AI director screen for the Storylines tab: read the whole storyline,
// ask a few questions, then propose better shot descriptions the person can
// accept, edit or reject one by one. Nothing changes until they accept.
//
// Copies of packages/shared/src/video-storyline-director-conversation.ts's
// payload shapes: this UI bundles standalone and cannot import
// @paperclipai/shared. Keep these in sync by hand.

export type DirectorTransition = "cut" | "fade" | "dissolve";

interface ReviewShotFinding {
  shotId: string;
  sceneId: string;
  orderIndex: number;
  issues: string[];
}

interface ReviewPayload {
  summary: string;
  shotFindings: ReviewShotFinding[];
  contradictions: string[];
  continuityRisks: string[];
}

interface QuestionOption {
  id: string;
  label: string;
}

interface DirectorQuestion {
  id: string;
  shotId: string | null;
  prompt: string;
  options: QuestionOption[];
}

interface QuestionBatchPayload {
  questions: DirectorQuestion[];
  doneAsking: boolean;
}

interface ProposalEntry {
  shotId: string;
  proposedPrompt: string;
  proposedCameraNotes: string | null;
  proposedDurationSeconds: number;
  proposedTransitionIn: DirectorTransition | null;
  rationale: string;
}

interface ProposalBatchPayload {
  proposals: ProposalEntry[];
}

interface DirectorMessage {
  id: string;
  role: "director" | "person";
  kind: "review" | "question" | "answer" | "proposal" | "system";
  payload: unknown;
  createdAt: string;
}

export interface DirectorConversation {
  id: string;
  status: "reviewing" | "asking" | "proposing" | "done";
  messages: DirectorMessage[];
}

export interface DirectorShot {
  id: string;
  sceneId: string;
  orderIndex: number;
  prompt: string;
  cameraNotes: string | null;
  durationSeconds: number;
  transitionIn?: DirectorTransition | null;
  proposedPrompt?: string | null;
  proposedCameraNotes?: string | null;
  proposedDurationSeconds?: number | null;
  proposedTransitionIn?: DirectorTransition | null;
  proposalStatus?: string | null;
  promptHistory?: Array<{ prompt: string }>;
}

export interface DirectorScene {
  id: string;
  orderIndex: number;
  title: string;
}

export type DirectorFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

const TRANSITION_LABELS: Record<DirectorTransition, string> = {
  cut: "Straight cut",
  fade: "Fade",
  dissolve: "Dissolve",
};

const MIN_DURATION = 1;
const MAX_DURATION = 60;
const POLL_MS = 3000;

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const inputStyle: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 12 };
const muted: React.CSSProperties = { fontSize: 12, color: "#868e96", margin: 0 };
// AI suggestions are purple on purpose: picture approval (step 2) is green, so
// accepting a suggestion never looks like approving a picture.
const suggestionBadge: React.CSSProperties = { padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 700, color: "#5f3dc4", background: "#f3f0ff", border: "1px solid #d0bfff" };
const suggestionBtn: React.CSSProperties = { ...baseBtn, background: "#7048e8", color: "#fff" };
const suggestionCard: React.CSSProperties = { border: "1px solid #d0bfff", background: "rgba(243,240,255,0.35)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 };

export function directorStatusLabel(status: DirectorConversation["status"]): string {
  switch (status) {
    case "reviewing":
      return "Reading through your storyline...";
    case "asking":
      return "The director has a few questions for you";
    case "proposing":
      return "Writing improved shot descriptions...";
    case "done":
      return "The director is finished";
  }
}

function latestOfKind<T>(messages: DirectorMessage[], kind: DirectorMessage["kind"]): { message: DirectorMessage; payload: T } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].kind === kind) return { message: messages[i], payload: messages[i].payload as T };
  }
  return null;
}

/** The director's latest batch of questions, if the person has not answered it yet. */
export function openQuestions(messages: DirectorMessage[]): DirectorQuestion[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].kind === "answer") return [];
    if (messages[i].kind === "question") return (messages[i].payload as QuestionBatchPayload).questions ?? [];
  }
  return [];
}

function useShotLabels(scenes: DirectorScene[], shots: DirectorShot[]) {
  const sortedScenes = scenes.slice().sort((a, b) => a.orderIndex - b.orderIndex);
  return (shotId: string | null): string => {
    if (!shotId) return "The whole storyline";
    const shot = shots.find((s) => s.id === shotId);
    if (!shot) return "A shot";
    const sceneIdx = sortedScenes.findIndex((s) => s.id === shot.sceneId);
    return `Scene ${sceneIdx + 1}, shot ${shot.orderIndex + 1}`;
  };
}

function formatSeconds(n: number): string {
  return `${n} second${n === 1 ? "" : "s"}`;
}

// ─── Review panel ────────────────────────────────────────────────────────

export function DirectorReviewPanel(props: { review: ReviewPayload; labelFor: (shotId: string | null) => string }) {
  const { review, labelFor } = props;
  const flagged = review.shotFindings.filter((f) => f.issues.length > 0);
  const allClear = flagged.length === 0 && review.contradictions.length === 0 && review.continuityRisks.length === 0;
  return (
    <div style={card} data-testid="director-review">
      <strong style={{ fontSize: 13 }}>What the director noticed</strong>
      <p style={{ fontSize: 13, margin: 0 }}>{review.summary}</p>
      {allClear && <p style={muted}>Nothing is missing or unclear. Your storyline looks ready.</p>}
      {flagged.length > 0 && (
        <div>
          <strong style={{ fontSize: 12 }}>Missing or unclear</strong>
          {flagged.map((f) => (
            <div key={f.shotId} style={{ fontSize: 12, marginTop: 4 }}>
              <span style={{ fontWeight: 600 }}>{labelFor(f.shotId)}</span>
              <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
                {f.issues.map((issue, i) => <li key={i}>{issue}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
      {review.contradictions.length > 0 && (
        <div>
          <strong style={{ fontSize: 12 }}>Things that don't match up</strong>
          <ul style={{ margin: "2px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {review.contradictions.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}
      {review.continuityRisks.length > 0 && (
        <div>
          <strong style={{ fontSize: 12 }}>Things that might look different from shot to shot</strong>
          <ul style={{ margin: "2px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {review.continuityRisks.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Chat panel ──────────────────────────────────────────────────────────

export interface QuestionAnswerDraft {
  youDecide: boolean;
  selectedOptionId: string | null;
  answerText: string;
}

export interface DirectorAnswerBody {
  goodEnough: boolean;
  answers: Array<{ questionId: string; youDecide: boolean; selectedOptionId: string | null; answerText: string | null }>;
}

export function buildAnswerBody(questions: DirectorQuestion[], drafts: Record<string, QuestionAnswerDraft>, goodEnough: boolean): DirectorAnswerBody {
  const answers: DirectorAnswerBody["answers"] = [];
  for (const q of questions) {
    const d = drafts[q.id];
    if (!d) continue;
    const text = d.answerText.trim();
    if (!d.youDecide && !d.selectedOptionId && !text) continue;
    answers.push({
      questionId: q.id,
      youDecide: d.youDecide,
      selectedOptionId: d.youDecide ? null : d.selectedOptionId,
      answerText: d.youDecide || d.selectedOptionId || !text ? null : text,
    });
  }
  return { goodEnough, answers };
}

export function DirectorChatPanel(props: {
  questions: DirectorQuestion[];
  labelFor: (shotId: string | null) => string;
  busy: boolean;
  onSubmit: (body: DirectorAnswerBody) => void;
}) {
  const { questions, labelFor, busy, onSubmit } = props;
  const [drafts, setDrafts] = useState<Record<string, QuestionAnswerDraft>>({});
  const draftFor = (id: string): QuestionAnswerDraft => drafts[id] ?? { youDecide: false, selectedOptionId: null, answerText: "" };
  const setDraft = (id: string, next: Partial<QuestionAnswerDraft>) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...draftFor(id), ...next } }));

  const body = buildAnswerBody(questions, drafts, false);
  return (
    <div style={card} data-testid="director-chat">
      <strong style={{ fontSize: 13 }}>Questions from the director</strong>
      {questions.map((q) => {
        const d = draftFor(q.id);
        return (
          <div key={q.id} style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid rgba(128,128,128,0.15)", paddingTop: 8 }}>
            <div style={{ fontSize: 11, color: "#868e96" }}>{labelFor(q.shotId)}</div>
            <div style={{ fontSize: 13 }}>{q.prompt}</div>
            {q.options.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {q.options.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    aria-pressed={!d.youDecide && d.selectedOptionId === o.id}
                    style={!d.youDecide && d.selectedOptionId === o.id ? primaryBtn : secondaryBtn}
                    onClick={() => setDraft(q.id, { selectedOptionId: o.id, youDecide: false, answerText: "" })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            ) : (
              <textarea
                style={{ ...inputStyle, minHeight: 50 }}
                placeholder="Type your answer"
                aria-label={`Your answer: ${q.prompt}`}
                value={d.answerText}
                onChange={(e) => setDraft(q.id, { answerText: e.target.value, youDecide: false })}
              />
            )}
            <div>
              <button
                type="button"
                aria-pressed={d.youDecide}
                style={d.youDecide ? primaryBtn : ghostBtn}
                onClick={() => setDraft(q.id, { youDecide: !d.youDecide, selectedOptionId: null, answerText: "" })}
              >
                You decide
              </button>
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button type="button" style={primaryBtn} disabled={busy || body.answers.length === 0} onClick={() => onSubmit(body)}>
          Send my answers
        </button>
        <button type="button" style={ghostBtn} disabled={busy} onClick={() => onSubmit(buildAnswerBody(questions, drafts, true))}>
          Good enough, stop asking
        </button>
      </div>
    </div>
  );
}

// ─── Proposals ───────────────────────────────────────────────────────────

interface EditDraft {
  prompt: string;
  cameraNotes: string;
  durationSeconds: number;
  transitionIn: DirectorTransition | "";
}

function SideBySide(props: { label: string; before: string; after: string }) {
  const changed = props.before !== props.after;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(70px, 110px) 1fr 1fr", gap: 8, fontSize: 12, alignItems: "start", overflowWrap: "anywhere" }}>
      <div style={{ color: "#868e96" }}>{props.label}</div>
      <div>{props.before || <span style={{ color: "#868e96" }}>None</span>}</div>
      <div style={changed ? { background: "#ebfbee", borderRadius: 6, padding: "0 4px" } : undefined}>{props.after || <span style={{ color: "#868e96" }}>None</span>}</div>
    </div>
  );
}

function transitionLabel(t: DirectorTransition | null | undefined): string {
  return t ? TRANSITION_LABELS[t] : "";
}

export function ProposalCard(props: {
  shot: DirectorShot;
  label: string;
  rationale: string | null;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onEdit: (body: { prompt: string; cameraNotes: string | null; durationSeconds: number; transitionIn: DirectorTransition | null }) => void;
}) {
  const { shot, label, rationale, busy } = props;
  const proposed: EditDraft = {
    prompt: shot.proposedPrompt ?? shot.prompt,
    cameraNotes: shot.proposedCameraNotes ?? "",
    durationSeconds: shot.proposedDurationSeconds ?? shot.durationSeconds,
    transitionIn: shot.proposedTransitionIn ?? "",
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft>(proposed);

  return (
    <div style={suggestionCard} data-testid={`proposal-${shot.id}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={suggestionBadge}>AI suggestion</span>
        <strong style={{ fontSize: 12 }}>{label}</strong>
      </div>
      {rationale && <p style={muted}>{rationale}</p>}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(70px, 110px) 1fr 1fr", gap: 8, fontSize: 11, fontWeight: 600 }}>
        <div />
        <div>What you wrote</div>
        <div>What the director suggests</div>
      </div>
      <SideBySide label="Description" before={shot.prompt} after={proposed.prompt} />
      <SideBySide label="Camera notes" before={shot.cameraNotes ?? ""} after={proposed.cameraNotes} />
      <SideBySide label="Length" before={formatSeconds(shot.durationSeconds)} after={formatSeconds(proposed.durationSeconds)} />
      <SideBySide label="Change to next shot" before={transitionLabel(shot.transitionIn)} after={transitionLabel(proposed.transitionIn || null)} />
      {editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, background: "rgba(128,128,128,0.06)", borderRadius: 6, padding: 8 }}>
          <textarea
            style={{ ...inputStyle, minHeight: 60 }}
            aria-label="Description"
            value={draft.prompt}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          />
          <input
            style={inputStyle}
            aria-label="Camera notes"
            placeholder="Camera notes (optional)"
            value={draft.cameraNotes}
            onChange={(e) => setDraft({ ...draft, cameraNotes: e.target.value })}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <input
              style={{ ...inputStyle, width: 90 }}
              type="number"
              aria-label="Length in seconds"
              min={MIN_DURATION}
              max={MAX_DURATION}
              value={draft.durationSeconds}
              onChange={(e) => setDraft({ ...draft, durationSeconds: Number(e.target.value) || MIN_DURATION })}
            />
            <select
              style={inputStyle}
              aria-label="Change to next shot"
              value={draft.transitionIn}
              onChange={(e) => setDraft({ ...draft, transitionIn: e.target.value as DirectorTransition | "" })}
            >
              <option value="">No change set</option>
              {(Object.keys(TRANSITION_LABELS) as DirectorTransition[]).map((t) => (
                <option key={t} value={t}>{TRANSITION_LABELS[t]}</option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              style={suggestionBtn}
              disabled={busy || !draft.prompt.trim()}
              onClick={() =>
                props.onEdit({
                  prompt: draft.prompt.trim(),
                  cameraNotes: draft.cameraNotes.trim() || null,
                  durationSeconds: draft.durationSeconds,
                  transitionIn: draft.transitionIn || null,
                })
              }
            >
              Save my changes and use this
            </button>
            <button type="button" style={ghostBtn} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" style={suggestionBtn} disabled={busy} onClick={props.onAccept}>Accept suggestion</button>
            <button
              type="button"
              style={secondaryBtn}
              disabled={busy}
              onClick={() => {
                setDraft(proposed);
                setEditing(true);
              }}
            >
              Edit suggestion
            </button>
            <button type="button" style={ghostBtn} disabled={busy} onClick={props.onReject}>Reject (keep mine)</button>
          </div>
          <p style={{ ...muted, fontSize: 11 }}>Accepting only changes this shot's written description. Its picture is checked separately in step 2.</p>
        </div>
      )}
    </div>
  );
}

// ─── The whole director section ──────────────────────────────────────────

export function AiDirectorSection(props: {
  companyId: string;
  storylineId: string;
  scenes: DirectorScene[];
  shots: DirectorShot[];
  editable: boolean;
  fetchJson: DirectorFetch;
  /** Called after anything that changes shots (accept, edit, restore, ...), so the page reloads them. */
  onShotsChanged: () => Promise<void> | void;
  pollMs?: number;
}) {
  const { companyId, storylineId, scenes, shots, editable, fetchJson, onShotsChanged } = props;
  const base = `/api/companies/${companyId}/video-storylines/${storylineId}`;
  const [conversation, setConversation] = useState<DirectorConversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const labelFor = useShotLabels(scenes, shots);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadConversation = useCallback(async () => {
    try {
      const res = await fetchJson<DirectorConversation | null>(`${base}/director/conversation`);
      if (!mounted.current) return;
      setConversation(res && res.messages ? res : null);
    } catch {
      // No conversation yet for this storyline is normal; show the start button.
      if (mounted.current) setConversation(null);
    } finally {
      if (mounted.current) setLoaded(true);
    }
  }, [base, fetchJson]);

  useEffect(() => {
    setConversation(null);
    setLoaded(false);
    void loadConversation();
  }, [loadConversation]);

  // Poll while the director is working, or waiting on an answer, so new
  // questions and proposals show up without a page refresh.
  const status = conversation?.status ?? null;
  useEffect(() => {
    if (!status || status === "done") return;
    const id = window.setInterval(() => {
      void loadConversation();
      void onShotsChanged();
    }, props.pollMs ?? POLL_MS);
    return () => window.clearInterval(id);
  }, [status, loadConversation, onShotsChanged, props.pollMs]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await loadConversation();
      await onShotsChanged();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const startReview = () => run(() => fetchJson(`${base}/director/review`, { method: "POST", body: JSON.stringify({}) }));
  const sendAnswers = (body: DirectorAnswerBody) =>
    run(() => fetchJson(`${base}/director/conversation/answer`, { method: "POST", body: JSON.stringify(body) }));
  const acceptShot = (shotId: string) => run(() => fetchJson(`${base}/director/proposals/${shotId}/accept`, { method: "POST" }));
  const rejectShot = (shotId: string) => run(() => fetchJson(`${base}/director/proposals/${shotId}/reject`, { method: "POST" }));
  const editShot = (shotId: string, body: unknown) =>
    run(() => fetchJson(`${base}/director/proposals/${shotId}/edit`, { method: "POST", body: JSON.stringify(body) }));
  const acceptAll = () => run(() => fetchJson(`${base}/director/proposals/accept-all`, { method: "POST" }));
  const restoreShot = (shotId: string) => run(() => fetchJson(`${base}/shots/${shotId}/restore-prompt`, { method: "POST" }));

  const messages = conversation?.messages ?? [];
  const review = latestOfKind<ReviewPayload>(messages, "review");
  const questions = conversation?.status === "asking" ? openQuestions(messages) : [];
  const proposalMsg = latestOfKind<ProposalBatchPayload>(messages, "proposal");
  const pending = shots
    .filter((s) => s.proposalStatus === "pending")
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const improved = shots.filter((s) => (s.promptHistory?.length ?? 0) > 0);
  const working = conversation?.status === "reviewing" || conversation?.status === "proposing";

  if (!loaded) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="director-section">
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px" }}>
            <strong style={{ fontSize: 13 }}>AI director (optional)</strong>
            <p style={muted}>
              The director reads your whole storyline, asks a few questions, and suggests clearer shot descriptions. Nothing changes until you accept it.
            </p>
          </div>
          <button type="button" style={primaryBtn} disabled={busy || !editable || working} onClick={() => void startReview()}>
            {conversation ? "Start over with the AI director" : "Improve with AI director"}
          </button>
        </div>
        {conversation && <p style={{ fontSize: 12, margin: 0 }}>{directorStatusLabel(conversation.status)}</p>}
        {error && <div style={errorBox}>{error}</div>}
      </div>

      {review && <DirectorReviewPanel review={review.payload} labelFor={labelFor} />}

      {questions.length > 0 && <DirectorChatPanel key={questions.map((q) => q.id).join(",")} questions={questions} labelFor={labelFor} busy={busy} onSubmit={(b) => void sendAnswers(b)} />}

      {pending.length > 0 && (
        <div style={{ ...card, borderColor: "#d0bfff" }} data-testid="director-proposals">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={suggestionBadge}>AI suggestions</span>
              <strong style={{ fontSize: 13 }}>{pending.length} waiting for you</strong>
            </div>
            <button type="button" style={suggestionBtn} disabled={busy || !editable} onClick={() => void acceptAll()}>
              Accept all suggestions
            </button>
          </div>
          {pending.map((shot) => (
            <ProposalCard
              key={shot.id}
              shot={shot}
              label={labelFor(shot.id)}
              rationale={proposalMsg?.payload.proposals?.find((p) => p.shotId === shot.id)?.rationale ?? null}
              busy={busy || !editable}
              onAccept={() => void acceptShot(shot.id)}
              onReject={() => void rejectShot(shot.id)}
              onEdit={(body) => void editShot(shot.id, body)}
            />
          ))}
        </div>
      )}

      {improved.length > 0 && (
        <div style={card} data-testid="director-improved">
          <strong style={{ fontSize: 13 }}>Shots you've improved</strong>
          <p style={muted}>You can always go back to your own wording.</p>
          {improved.map((shot) => (
            <div key={shot.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, borderTop: "1px solid rgba(128,128,128,0.15)", paddingTop: 6 }}>
              <div>
                <div style={{ fontWeight: 600 }}>{labelFor(shot.id)}</div>
                <div>{shot.prompt}</div>
              </div>
              <button type="button" style={ghostBtn} disabled={busy || !editable} onClick={() => void restoreShot(shot.id)}>
                Restore original
              </button>
            </div>
          ))}
        </div>
      )}

      {conversation?.status === "done" && pending.length === 0 && (
        <div style={card} data-testid="director-done">
          <strong style={{ fontSize: 13 }}>All done with the director</strong>
          <p style={muted}>Your shot descriptions are up to date. Next, make and approve a picture for each shot (step 2).</p>
        </div>
      )}
    </div>
  );
}

// ─── "Advanced features" toggle ──────────────────────────────────────────

export function AdvancedFeaturesToggle(props: {
  enabled: boolean | null;
  busy: boolean;
  error: string | null;
  onChange: (next: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong style={{ fontSize: 12 }}>Advanced features</strong>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={props.enabled === true}
            disabled={props.enabled === null || props.busy}
            onChange={(e) => props.onChange(e.target.checked)}
          />
          Turned on
        </label>
      </div>
      <p style={muted}>
        Adds the AI director, scene changes, background music and quick preview pictures to your storylines.
      </p>
      {props.error && <div style={errorBox}>{props.error}</div>}
    </div>
  );
}
