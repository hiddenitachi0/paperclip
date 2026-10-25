import { useCallback, useEffect, useRef, useState } from "react";
import { DirectorsEditor, directorOptionText, directorWarning, type DirectorFetch, type DirectorsView, type PickerLook, type StorylineDirector } from "./directors-editor.js";

// The AI story writer (Storylines, step 1): pick a director, write a few
// ideas and pointers, press "Write my storyboard". The director may ask a
// few questions first; then it writes the whole storyboard into the
// storyline. Later requests in the same chat come back as a list of changes
// to accept or reject. Copies of the shapes in
// packages/shared/src/video-storyline-directors.ts (this UI bundles
// standalone): keep in sync by hand.

export interface WriterQuestion {
  id: string;
  question: string;
  options: string[];
}

export interface WriterShotFields {
  prompt: string;
  cameraNotes: string | null;
  durationSeconds: number;
  transitionIn: string | null;
  cast: string[];
}

export interface WriterChange {
  id: string;
  op: "update" | "add" | "remove";
  shotId: string | null;
  shotNumber: number | null;
  afterShotId: string | null;
  before: WriterShotFields | null;
  after: WriterShotFields | null;
  status: "pending" | "accepted" | "rejected";
}

export interface WriterMessage {
  id: string;
  role: "writer" | "person" | "system";
  kind: "brief" | "analysis" | "question" | "answer" | "storyboard" | "change_request" | "change_set" | "note";
  status: "pending" | "applied" | "partly_applied" | "discarded" | null;
  directorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WriterReferenceOption {
  id: string;
  label: string;
  kind: "upload" | "cast";
  blockedReason: string | null;
}

export interface WriterSession {
  storylineId: string;
  directorId: string | null;
  state: "idle" | "asking" | "reviewing";
  messages: WriterMessage[];
  openQuestions: { messageId: string; questions: WriterQuestion[] } | null;
  pendingChangeSetId: string | null;
  referenceOptions: WriterReferenceOption[];
}

export interface WriterEstimate {
  writingCents: number;
  videoCents: number | null;
  summary: string;
  blockedReason: string | null;
}

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const inputStyle: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff", padding: "8px 16px", fontSize: 13 };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 12, whiteSpace: "pre-line" };
const help: React.CSSProperties = { fontSize: 11, color: "#868e96", margin: 0 };
const warn: React.CSSProperties = { fontSize: 11, color: "#b35c00", margin: 0 };
const bubbleWriter: React.CSSProperties = { alignSelf: "flex-start", maxWidth: "92%", background: "#f3f0ff", border: "1px solid #d0bfff", borderRadius: 10, padding: "8px 10px", fontSize: 12, whiteSpace: "pre-line" };
const bubblePerson: React.CSSProperties = { alignSelf: "flex-end", maxWidth: "92%", background: "#e7f5ff", border: "1px solid #a5d8ff", borderRadius: 10, padding: "8px 10px", fontSize: 12, whiteSpace: "pre-line" };

/** A session as the page uses it, whatever an older server (or a test) sent. */
export function normalizeSession(res: Partial<WriterSession> | null | undefined, storylineId: string): WriterSession {
  return {
    storylineId,
    directorId: res?.directorId ?? null,
    state: res?.state === "asking" || res?.state === "reviewing" ? res.state : "idle",
    messages: Array.isArray(res?.messages) ? res!.messages : [],
    openQuestions: res?.openQuestions && Array.isArray(res.openQuestions.questions) ? res.openQuestions : null,
    pendingChangeSetId: res?.pendingChangeSetId ?? null,
    referenceOptions: Array.isArray(res?.referenceOptions) ? res!.referenceOptions : [],
  };
}

function money(cents: number | null | undefined): string {
  if (cents == null) return "";
  return cents < 1 ? "less than $0.01" : `$${(cents / 100).toFixed(2)}`;
}

/** What a change does, in a few words: "Shot 3: changed", "New shot after shot 1", "Remove shot 4". */
export function changeTitle(change: WriterChange, shotNumberOf: (shotId: string | null) => number | null): string {
  if (change.op === "add") {
    const after = shotNumberOf(change.afterShotId);
    return change.afterShotId ? `New shot after shot ${after ?? "?"}` : "New shot at the start";
  }
  const n = change.shotNumber ?? shotNumberOf(change.shotId);
  return change.op === "remove" ? `Remove shot ${n ?? "?"}` : `Shot ${n ?? "?"}: changed`;
}

function fieldsText(f: WriterShotFields | null): string {
  if (!f) return "";
  return [
    f.prompt,
    `${f.durationSeconds}s${f.transitionIn ? ` · ${f.transitionIn} in` : ""}${f.cameraNotes ? ` · camera: ${f.cameraNotes}` : ""}${f.cast.length > 0 ? ` · cast: ${f.cast.join(", ")}` : ""}`,
  ].join("\n");
}

function ChangeSetCard(props: {
  message: WriterMessage;
  shotNumberOf: (shotId: string | null) => number | null;
  editable: boolean;
  busy: boolean;
  onAccept: (changeIds: string[] | undefined) => void;
  onDiscard: () => void;
}) {
  const payload = props.message.payload as {
    note?: string;
    changes: WriterChange[];
    music?: string | null;
    voice?: string | null;
    replaceAll?: { shotCount: number; sceneCount: number; totalSeconds: number } | null;
    secondsBefore?: number;
    secondsAfter?: number;
  };
  const pending = props.message.status === "pending";
  const [picked, setPicked] = useState<Set<string>>(() => new Set(payload.changes.map((c) => c.id)));
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const statusLine =
    props.message.status === "applied"
      ? "Applied."
      : props.message.status === "partly_applied"
        ? "Some changes applied."
        : props.message.status === "discarded"
          ? "Discarded. Nothing was changed."
          : null;
  return (
    <div style={{ ...bubbleWriter, alignSelf: "stretch", maxWidth: "100%" }} data-testid={`change-set-${props.message.id}`}>
      {payload.note ? <div>{payload.note}</div> : null}
      {payload.replaceAll ? (
        <div style={{ marginTop: 6 }} data-testid="replace-all">
          Replace all current shots with a new storyboard: {payload.replaceAll.shotCount} shots in {payload.replaceAll.sceneCount} scene
          {payload.replaceAll.sceneCount === 1 ? "" : "s"}, {payload.secondsBefore ?? 0}s → {payload.replaceAll.totalSeconds}s.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          {payload.changes.length === 0 ? <div>Nothing needs to change.</div> : null}
          {payload.changes.map((change) => (
            <div key={change.id} style={{ background: "rgba(255,255,255,0.6)", border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8, padding: 8 }} data-testid={`change-${change.id}`}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 600 }}>
                {pending ? (
                  <input type="checkbox" aria-label={`Use: ${changeTitle(change, props.shotNumberOf)}`} checked={picked.has(change.id)} disabled={!props.editable || props.busy} onChange={() => toggle(change.id)} />
                ) : null}
                <span>{changeTitle(change, props.shotNumberOf)}</span>
                {!pending ? <span style={{ fontWeight: 400, color: change.status === "accepted" ? "#087f5b" : "#868e96" }}>({change.status === "accepted" ? "accepted" : "not used"})</span> : null}
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8, marginTop: 4 }}>
                {change.before ? (
                  <div>
                    <div style={help}>Now</div>
                    <div style={{ textDecoration: change.op === "remove" ? "line-through" : undefined }}>{fieldsText(change.before)}</div>
                  </div>
                ) : null}
                {change.after ? (
                  <div>
                    <div style={help}>{change.op === "add" ? "New" : "Suggested"}</div>
                    <div>{fieldsText(change.after)}</div>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {payload.secondsBefore != null && payload.secondsAfter != null && payload.secondsBefore !== payload.secondsAfter ? (
            <div style={help}>
              Length: {payload.secondsBefore}s → {payload.secondsAfter}s
            </div>
          ) : null}
        </div>
      )}
      {payload.music ? <div style={{ marginTop: 4 }}>Music idea: {payload.music}</div> : null}
      {payload.voice ? <div>Voice-over idea: {payload.voice}</div> : null}
      {pending ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {payload.replaceAll ? (
            <button type="button" style={secondaryBtn} disabled={!props.editable || props.busy} onClick={() => props.onAccept(undefined)}>
              Use the new storyboard
            </button>
          ) : (
            <>
              <button type="button" style={secondaryBtn} disabled={!props.editable || props.busy || picked.size === 0} onClick={() => props.onAccept([...picked])}>
                Accept selected ({picked.size})
              </button>
              <button type="button" style={ghostBtn} disabled={!props.editable || props.busy} onClick={() => props.onAccept(undefined)}>
                Accept all
              </button>
            </>
          )}
          <button type="button" style={ghostBtn} disabled={props.busy} onClick={props.onDiscard}>
            Discard
          </button>
        </div>
      ) : statusLine ? (
        <div style={{ ...help, marginTop: 4 }}>{statusLine}</div>
      ) : null}
    </div>
  );
}

function QuestionsForm(props: { questions: WriterQuestion[]; busy: boolean; editable: boolean; onSend: (answers: Array<{ questionId: string; answer: string }>, skip: boolean) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <div style={{ ...bubbleWriter, alignSelf: "stretch", maxWidth: "100%" }} data-testid="writer-questions">
      <div style={{ fontWeight: 600 }}>A few questions before I write:</div>
      {props.questions.map((q) => (
        <div key={q.id} style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
          <div>{q.question}</div>
          {q.options.length > 0 ? (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {q.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  style={answers[q.id] === o ? { ...secondaryBtn, borderColor: "#1971c2" } : ghostBtn}
                  disabled={props.busy}
                  onClick={() => setAnswers((a) => ({ ...a, [q.id]: o }))}
                >
                  {o}
                </button>
              ))}
            </div>
          ) : null}
          <input
            style={inputStyle}
            aria-label={`Answer: ${q.question}`}
            placeholder={q.options.length > 0 ? "Or write your own answer" : "Your answer (empty = you decide)"}
            value={answers[q.id] ?? ""}
            disabled={props.busy}
            onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
          />
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        <button
          type="button"
          style={secondaryBtn}
          disabled={props.busy || !props.editable}
          onClick={() => props.onSend(props.questions.map((q) => ({ questionId: q.id, answer: answers[q.id] ?? "" })), false)}
        >
          Send answers
        </button>
        <button
          type="button"
          style={ghostBtn}
          disabled={props.busy || !props.editable}
          onClick={() => props.onSend(props.questions.map((q) => ({ questionId: q.id, answer: answers[q.id] ?? "" })), true)}
        >
          Just write it
        </button>
      </div>
    </div>
  );
}

function MessageView(props: { message: WriterMessage }) {
  const { message } = props;
  const p = message.payload as Record<string, unknown>;
  switch (message.kind) {
    case "brief":
      return (
        <div style={bubblePerson}>
          {String(p.ideas ?? "")}
          {p.targetSeconds ? `\n(about ${p.targetSeconds} seconds)` : ""}
        </div>
      );
    case "change_request":
      return <div style={bubblePerson}>{String(p.request ?? "")}</div>;
    case "answer": {
      const answers = (p.answers as Array<{ question: string; answer: string }>) ?? [];
      return <div style={bubblePerson}>{answers.map((a) => `${a.question}\n→ ${a.answer || "you decide"}`).join("\n")}</div>;
    }
    case "analysis": {
      const skipped = (p.skipped as string[]) ?? [];
      return (
        <details style={{ ...bubbleWriter, background: "#f8f9fa", borderColor: "#dee2e6" }}>
          <summary style={{ cursor: "pointer" }}>
            {Number(p.pictureCount ?? 0) > 0 ? `Looked at ${p.pictureCount} picture${p.pictureCount === 1 ? "" : "s"}` : "Pictures not used"}
            {skipped.length > 0 ? ` (${skipped.length} not sent)` : ""}
          </summary>
          {p.text ? <div style={{ marginTop: 4 }}>{String(p.text)}</div> : null}
          {skipped.map((s) => (
            <div key={s} style={warn}>
              {s}
            </div>
          ))}
        </details>
      );
    }
    case "question":
      return (
        <div style={bubbleWriter}>
          {((p.questions as WriterQuestion[]) ?? []).map((q) => q.question).join("\n")}
        </div>
      );
    case "storyboard": {
      const applied = (p.appliedDefaults as string[]) ?? [];
      return (
        <div style={bubbleWriter} data-testid="writer-storyboard">
          {p.note ? `${p.note}\n` : ""}
          Wrote {String(p.shotCount)} shots in {String(p.sceneCount)} scene{p.sceneCount === 1 ? "" : "s"}, {String(p.totalSeconds)} seconds. The video would cost about{" "}
          {money(p.estimatedCostCents as number)} to render later.
          {p.music ? `\nMusic idea: ${p.music}` : ""}
          {p.voice ? `\nVoice-over idea: ${p.voice}` : ""}
          {applied.length > 0 ? `\nFrom the director's defaults: ${applied.join("; ")}.` : ""}
        </div>
      );
    }
    case "note":
      return (
        <div style={{ ...help, color: p.error ? "#a61e4d" : "#868e96", alignSelf: "center", textAlign: "center" }} data-testid={p.error ? "writer-error-note" : undefined}>
          {String(p.text ?? "")}
          {typeof p.costCents === "number" ? ` (AI cost ${money(p.costCents)})` : ""}
        </div>
      );
    default:
      return null;
  }
}

export function StoryWriterSection(props: {
  companyId: string;
  storylineId: string;
  /** The storyline's director (from the storyline). */
  directorId: string | null;
  shotIds: string[];
  editable: boolean;
  fetchJson: DirectorFetch;
  looks: PickerLook[];
  /** Called after anything that changes shots or the storyline. */
  onChanged: () => Promise<void> | void;
}) {
  const { companyId, storylineId, fetchJson } = props;
  const base = `/api/companies/${companyId}/video-storylines/${storylineId}`;
  const [directors, setDirectors] = useState<DirectorsView | null>(null);
  const [session, setSession] = useState<WriterSession | null>(null);
  const [directorId, setDirectorId] = useState<string | null>(props.directorId);
  const [ideas, setIdeas] = useState("");
  const [targetSeconds, setTargetSeconds] = useState("");
  const [uploadIds, setUploadIds] = useState<string[]>([]);
  const [useCast, setUseCast] = useState(true);
  const [skipQuestions, setSkipQuestions] = useState(false);
  const [request, setRequest] = useState("");
  const [estimate, setEstimate] = useState<WriterEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDirectors, setShowDirectors] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadDirectors = useCallback(async () => {
    try {
      const res = await fetchJson<Partial<DirectorsView> | null>(`/api/companies/${companyId}/video-storylines/directors`);
      if (mounted.current) setDirectors({ directors: Array.isArray(res?.directors) ? res!.directors : [], canEdit: res?.canEdit === true });
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [companyId, fetchJson]);

  const loadSession = useCallback(async () => {
    try {
      const res = await fetchJson<WriterSession | null>(`${base}/writer`);
      if (mounted.current) setSession(normalizeSession(res, storylineId));
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [base, fetchJson]);

  useEffect(() => {
    setSession(null);
    setDirectorId(props.directorId);
    void loadDirectors();
    void loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storylineId]);

  // Pick the storyline's director, else the first one, once the list is in.
  useEffect(() => {
    if (!directors) return;
    if (directorId && directors.directors.some((d) => d.id === directorId)) return;
    setDirectorId(directors.directors[0]?.id ?? null);
  }, [directors, directorId]);

  const hasShots = props.shotIds.length > 0;
  const pictureCount = uploadIds.length + (useCast ? (session?.referenceOptions ?? []).filter((o) => o.kind === "cast" && !o.blockedReason).length : 0);

  // The price before writing, refreshed as the brief changes.
  useEffect(() => {
    const timer = setTimeout(() => {
      const seconds = Number(targetSeconds);
      fetchJson<WriterEstimate>(`${base}/writer/estimate`, {
        method: "POST",
        body: JSON.stringify({
          directorId,
          kind: "write",
          ideas: ideas.slice(0, 6000),
          targetSeconds: targetSeconds.trim() && Number.isInteger(seconds) && seconds >= 5 && seconds <= 1800 ? seconds : null,
          pictureCount,
        }),
      })
        .then((res) => {
          if (mounted.current) setEstimate(res && typeof res.summary === "string" ? res : null);
        })
        .catch(() => {
          if (mounted.current) setEstimate(null);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [base, fetchJson, directorId, ideas, targetSeconds, pictureCount]);

  const run = async (fn: () => Promise<WriterSession | unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (res && typeof res === "object" && "messages" in (res as object)) setSession(normalizeSession(res as WriterSession, storylineId));
      else await loadSession();
      await props.onChanged();
      return true;
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      await loadSession();
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const pickDirector = async (id: string | null) => {
    setDirectorId(id);
    if (!id || !props.editable) return;
    try {
      await fetchJson(`${base}/director`, { method: "PUT", body: JSON.stringify({ directorId: id }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const write = async () => {
    const seconds = Number(targetSeconds);
    const ok = await run(() =>
      fetchJson<WriterSession>(`${base}/writer/write`, {
        method: "POST",
        body: JSON.stringify({
          directorId,
          ideas,
          targetSeconds: targetSeconds.trim() && Number.isInteger(seconds) ? seconds : null,
          referenceUploadIds: uploadIds,
          useCastPictures: useCast,
          skipQuestions,
        }),
      }),
    );
    if (ok) setIdeas("");
  };
  const answer = (answers: Array<{ questionId: string; answer: string }>, skip: boolean) =>
    run(() => fetchJson<WriterSession>(`${base}/writer/answer`, { method: "POST", body: JSON.stringify({ answers, skipQuestions: skip }) }));
  const improve = async () => {
    const ok = await run(() => fetchJson<WriterSession>(`${base}/writer/improve`, { method: "POST", body: JSON.stringify({ request }) }));
    if (ok) setRequest("");
  };
  const accept = (messageId: string, changeIds: string[] | undefined) =>
    run(() => fetchJson<WriterSession>(`${base}/writer/changes/${messageId}/accept`, { method: "POST", body: JSON.stringify(changeIds ? { changeIds } : {}) }));
  const discard = (messageId: string) => run(() => fetchJson<WriterSession>(`${base}/writer/changes/${messageId}/discard`, { method: "POST" }));

  const director: StorylineDirector | null = directors?.directors.find((d) => d.id === directorId) ?? null;
  const shotNumberOf = (shotId: string | null) => {
    if (!shotId) return null;
    const i = props.shotIds.indexOf(shotId);
    return i === -1 ? null : i + 1;
  };
  const state = session?.state ?? "idle";
  const uploads = (session?.referenceOptions ?? []).filter((o) => o.kind === "upload");
  const castOptions = (session?.referenceOptions ?? []).filter((o) => o.kind === "cast");
  const linkedCast = castOptions.filter((o) => !o.blockedReason);
  const blocked = estimate?.blockedReason ?? null;

  return (
    <div style={card} data-testid="story-writer">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 240px" }}>
          <strong style={{ fontSize: 14 }}>AI story writer</strong>
          <p style={help}>Write a few ideas; the director asks what it needs to know, then writes the whole storyboard here. Nothing to copy anywhere.</p>
        </div>
        <button type="button" style={ghostBtn} onClick={() => setShowDirectors((v) => !v)} data-testid="manage-directors">
          {showDirectors ? "Hide directors" : directors?.canEdit ? "Manage directors" : "See directors"}
        </button>
      </div>

      {showDirectors ? (
        <DirectorsEditor companyId={companyId} fetchJson={fetchJson} looks={props.looks} onChanged={() => void loadDirectors()} onClose={() => setShowDirectors(false)} />
      ) : null}

      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
        <span style={{ fontWeight: 600 }}>Director</span>
        <select style={inputStyle} aria-label="Director" data-testid="director-picker" value={directorId ?? ""} disabled={busy || !directors} onChange={(e) => void pickDirector(e.target.value || null)}>
          {(directors?.directors ?? []).length === 0 ? <option value="">No directors yet</option> : null}
          {(directors?.directors ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {directorOptionText(d)}
            </option>
          ))}
        </select>
      </label>
      {director ? (
        <div style={{ fontSize: 11 }}>
          {director.description ? <p style={help}>{director.description}</p> : null}
          <p style={director.writerMode === "tools" ? help : warn} data-testid="director-mode-note">
            {director.writerModeNote}
          </p>
          {directorWarning(director) ? (
            <p style={warn} data-testid="director-warning">
              {directorWarning(director)}
            </p>
          ) : null}
        </div>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 420, overflowY: "auto" }} data-testid="writer-chat">
        {(session?.messages ?? []).map((m) =>
          m.kind === "change_set" ? (
            <ChangeSetCard
              key={m.id}
              message={m}
              shotNumberOf={shotNumberOf}
              editable={props.editable}
              busy={busy}
              onAccept={(ids) => void accept(m.id, ids)}
              onDiscard={() => void discard(m.id)}
            />
          ) : m.kind === "question" && session?.openQuestions?.messageId === m.id ? (
            <QuestionsForm key={m.id} questions={session.openQuestions.questions} busy={busy} editable={props.editable} onSend={(a, skip) => void answer(a, skip)} />
          ) : (
            <MessageView key={m.id} message={m} />
          ),
        )}
        {busy ? (
          <div style={{ ...help, alignSelf: "center" }} data-testid="writer-busy">
            The director is working on it. This can take a minute…
          </div>
        ) : null}
      </div>

      {error ? (
        <div style={errorBox} role="alert">
          {error}
        </div>
      ) : null}

      {state === "idle" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
            <span style={{ fontWeight: 600 }}>{hasShots ? "Ideas for a new storyboard" : "Your ideas and pointers"}</span>
            <textarea
              style={{ ...inputStyle, minHeight: 90 }}
              aria-label="Ideas and pointers"
              data-testid="writer-ideas"
              placeholder="What is it about? Who is it for? About how long? Anything that must be in it?"
              value={ideas}
              disabled={busy || !props.editable}
              onChange={(e) => setIdeas(e.target.value)}
            />
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
              About
              <input
                style={{ ...inputStyle, width: 80 }}
                type="number"
                min={5}
                max={1800}
                aria-label="Target length in seconds"
                placeholder="60"
                value={targetSeconds}
                disabled={busy || !props.editable}
                onChange={(e) => setTargetSeconds(e.target.value)}
              />
              seconds
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
              <input type="checkbox" checked={skipQuestions} disabled={busy} onChange={(e) => setSkipQuestions(e.target.checked)} />
              Write straight away (no questions)
            </label>
          </div>
          {linkedCast.length > 0 || uploads.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }} data-testid="writer-references">
              <span style={{ fontWeight: 600 }}>Pictures the director may look at</span>
              {linkedCast.length > 0 ? (
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={useCast} disabled={busy} onChange={(e) => setUseCast(e.target.checked)} />
                  The cast's saved people ({linkedCast.map((c) => c.label).join(", ")})
                </label>
              ) : null}
              {uploads.map((u) => (
                <label key={u.id} style={{ display: "flex", gap: 6, alignItems: "center" }} title={u.blockedReason ?? undefined}>
                  <input
                    type="checkbox"
                    checked={uploadIds.includes(u.id)}
                    disabled={busy || !!u.blockedReason}
                    onChange={(e) => setUploadIds((ids) => (e.target.checked ? [...ids, u.id] : ids.filter((x) => x !== u.id)))}
                  />
                  {u.label}
                  {u.blockedReason ? <span style={warn}> — {u.blockedReason}</span> : null}
                </label>
              ))}
              <p style={help}>Pictures are only sent after the usual consent and age checks. The picture model describes them in words for the writer.</p>
            </div>
          ) : null}
          {estimate ? (
            <p style={blocked ? warn : help} data-testid="writer-estimate">
              {blocked ?? estimate.summary}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              style={primaryBtn}
              data-testid="write-storyboard"
              disabled={busy || !props.editable || !ideas.trim() || !!blocked || !director || director.writerMode === "no_model"}
              title={!props.editable ? "Wait for the render to finish (or cancel it) first." : undefined}
              onClick={() => void write()}
            >
              {hasShots ? "Write a new storyboard" : "Write my storyboard"}
            </button>
          </div>
          {hasShots ? <p style={help}>A new storyboard is shown as changes first; your current shots stay until you accept it.</p> : null}
          {hasShots ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: "1px solid rgba(128,128,128,0.2)", paddingTop: 8 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                <span style={{ fontWeight: 600 }}>Ask for changes</span>
                <textarea
                  style={{ ...inputStyle, minHeight: 50 }}
                  aria-label="Ask for changes"
                  data-testid="writer-request"
                  placeholder='e.g. "Make shot 3 more dramatic" or "Shorten it to 45 seconds"'
                  value={request}
                  disabled={busy || !props.editable}
                  onChange={(e) => setRequest(e.target.value)}
                />
              </label>
              <div>
                <button type="button" style={secondaryBtn} data-testid="writer-improve" disabled={busy || !props.editable || !request.trim() || !!blocked} onClick={() => void improve()}>
                  Ask the director
                </button>
              </div>
              <p style={help}>Changes come back as a list you accept or reject. Nothing changes until you accept.</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
