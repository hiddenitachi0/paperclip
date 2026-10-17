import { useEffect, useState } from "react";

// Storyline directors (Storylines, step 1): the company's named ways of
// writing a storyboard. Owners and admins add, change and delete them;
// everyone else sees them read-only. Copies of the shapes in
// packages/shared/src/video-storyline-directors.ts (this UI bundles
// standalone and cannot import @paperclipai/shared): keep in sync by hand.

export type DirectorFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface DirectorModelReadiness {
  kind: string;
  ready: boolean;
  badge: string;
  warning: string | null;
  runLabel?: string | null;
  rank?: number;
}

export interface DirectorModelView {
  entryId: string;
  name: string | null;
  provider: string | null;
  model: string | null;
  keySecretId: string | null;
  keyReady: boolean;
  keyNote: string;
  canSeePictures: boolean | null;
  toolSupport: { canUseTools: boolean; source: string; reason: string } | null;
  readiness: DirectorModelReadiness | null;
}

export interface StorylineDirector {
  id: string;
  name: string;
  description: string;
  builtinKey: string | null;
  writing: DirectorModelView | null;
  analysis: DirectorModelView | null;
  helper: DirectorModelView | null;
  temperature: number | null;
  thinking: "on" | "off" | null;
  styleInstructions: string;
  defaultVideoProviderId: "fal" | "sogni" | null;
  defaultVideoModel: string | null;
  defaultLookId: string | null;
  defaultShotSeconds: number | null;
  writerMode: "tools" | "text_with_helper" | "text_only" | "no_model";
  writerModeNote: string;
}

export interface DirectorsView {
  directors: StorylineDirector[];
  canEdit: boolean;
}

/** A saved model as GET /model-directory?withReadiness=1 lists it. */
export interface PickerModel {
  id: string;
  name: string;
  provider: string;
  model: string;
  specs?: { vision?: boolean | null; tools?: "yes" | "partial" | "no" | null; openrouterHostsSeen?: Array<{ slug: string; tools: boolean }> | null } | null;
  providerRouting?: { only?: string[]; ignore?: string[] } | null;
  archivedAt?: string | null;
  readiness?: DirectorModelReadiness | null;
}

export type PickerSecret = { id: string; name: string };
export type PickerLook = { id: string; name: string };

/** The plain line the editor shows for a writing model that cannot use tools (same text as the server's). */
export const TEXT_ONLY_EXPLANATION = "This model can't use tools; the helper model does the lookups for it.";

/**
 * Whether a saved model can use tools, from what the picker list knows (the
 * server decides for real, with the company's blocked hosts too). Same rule
 * as savedModelToolSupport in packages/shared: unknown counts as "no".
 */
export function pickerModelCanUseTools(m: PickerModel | null | undefined): boolean | null {
  if (!m) return null;
  if (m.provider === "openrouter" && m.specs?.openrouterHostsSeen && m.specs.openrouterHostsSeen.length > 0) {
    const only = m.providerRouting?.only ?? [];
    const ignore = m.providerRouting?.ignore ?? [];
    const allowed = m.specs.openrouterHostsSeen.filter((h) => (only.length === 0 || only.includes(h.slug)) && !ignore.includes(h.slug));
    return allowed.some((h) => h.tools);
  }
  const tools = m.specs?.tools ?? null;
  if (tools === "no") return false;
  if (tools === "yes" || tools === "partial") return true;
  if (m.provider === "anthropic" || m.provider === "openai" || m.provider === "google") return true;
  return false;
}

/** "✅ Ready · Story model (someorg/storyteller-70b)". */
export function pickerModelOptionText(m: PickerModel): string {
  const text = `${m.name} (${m.model})`;
  return m.readiness ? `${m.readiness.badge} · ${text}` : text;
}

/** One director in a picker: "Action movie · ✅ Ready". */
export function directorOptionText(d: StorylineDirector): string {
  const badge = d.writerMode === "no_model" ? "❌ No writing model" : d.writing?.readiness?.badge ?? (d.writing ? "" : "✅ Company AI model");
  return badge ? `${d.name} · ${badge}` : d.name;
}

/** The warning under a director picker, when its models are not ready; null when fine. */
export function directorWarning(d: StorylineDirector | null): string | null {
  if (!d) return null;
  if (d.writerMode === "no_model") return d.writerModeNote;
  for (const [label, m] of [
    ["Writing model", d.writing],
    ["Picture analysis model", d.analysis],
    ["Helper model", d.helper],
  ] as const) {
    if (!m) continue;
    if (!m.name) return `${label}: ${m.keyNote}`;
    if (!m.keyReady) return `${label} "${m.name}": ${m.keyNote}`;
    if (m.readiness && !m.readiness.ready && m.readiness.kind !== "key_per_use" && m.readiness.warning) return `${label} "${m.name}": ${m.readiness.warning}`;
  }
  return null;
}

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const inputStyle: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };
const dangerBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#c92a2a", borderColor: "#ffc9c9" };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 12, whiteSpace: "pre-line" };
const help: React.CSSProperties = { fontSize: 11, color: "#868e96", margin: 0 };
const warn: React.CSSProperties = { fontSize: 11, color: "#b35c00", margin: 0 };
const fieldStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 };

interface Draft {
  name: string;
  description: string;
  writingEntryId: string | null;
  writingKeySecretId: string | null;
  analysisEntryId: string | null;
  analysisKeySecretId: string | null;
  helperEntryId: string | null;
  helperKeySecretId: string | null;
  temperature: string;
  thinking: "" | "on" | "off";
  styleInstructions: string;
  defaultVideoProviderId: "" | "fal" | "sogni";
  defaultVideoModel: string;
  defaultLookId: string;
  defaultShotSeconds: string;
}

function draftOf(d: StorylineDirector | null): Draft {
  return {
    name: d?.name ?? "",
    description: d?.description ?? "",
    writingEntryId: d?.writing?.entryId ?? null,
    writingKeySecretId: d?.writing?.keySecretId ?? null,
    analysisEntryId: d?.analysis?.entryId ?? null,
    analysisKeySecretId: d?.analysis?.keySecretId ?? null,
    helperEntryId: d?.helper?.entryId ?? null,
    helperKeySecretId: d?.helper?.keySecretId ?? null,
    temperature: d?.temperature != null ? String(d.temperature) : "",
    thinking: d?.thinking ?? "",
    styleInstructions: d?.styleInstructions ?? "",
    defaultVideoProviderId: d?.defaultVideoProviderId ?? "",
    defaultVideoModel: d?.defaultVideoModel ?? "",
    defaultLookId: d?.defaultLookId ?? "",
    defaultShotSeconds: d?.defaultShotSeconds != null ? String(d.defaultShotSeconds) : "",
  };
}

/** The request body for a draft (what the server's schema takes). */
export function directorBody(draft: Draft): Record<string, unknown> {
  const temperature = draft.temperature.trim() === "" ? null : Number(draft.temperature);
  const seconds = draft.defaultShotSeconds.trim() === "" ? null : Number(draft.defaultShotSeconds);
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    writingEntryId: draft.writingEntryId,
    writingKeySecretId: draft.writingEntryId ? draft.writingKeySecretId : null,
    analysisEntryId: draft.analysisEntryId,
    analysisKeySecretId: draft.analysisEntryId ? draft.analysisKeySecretId : null,
    helperEntryId: draft.helperEntryId,
    helperKeySecretId: draft.helperEntryId ? draft.helperKeySecretId : null,
    temperature: temperature !== null && Number.isFinite(temperature) ? temperature : null,
    thinking: draft.thinking || null,
    styleInstructions: draft.styleInstructions,
    defaultVideoProviderId: draft.defaultVideoProviderId || null,
    defaultVideoModel: draft.defaultVideoModel.trim() || null,
    defaultLookId: draft.defaultLookId || null,
    defaultShotSeconds: seconds !== null && Number.isInteger(seconds) ? seconds : null,
  };
}

function ModelPicker(props: {
  label: string;
  explain: string;
  testId: string;
  models: PickerModel[];
  secrets: PickerSecret[];
  entryId: string | null;
  keySecretId: string | null;
  disabled: boolean;
  emptyLabel: string;
  onChange: (entryId: string | null, keySecretId: string | null) => void;
  extra?: (picked: PickerModel | null) => React.ReactNode;
}) {
  const picked = props.models.find((m) => m.id === props.entryId) ?? null;
  const sorted = props.models.slice().sort((a, b) => (a.readiness?.rank ?? 1.5) - (b.readiness?.rank ?? 1.5));
  return (
    <div style={fieldStyle}>
      <label style={fieldStyle}>
        <span style={{ fontWeight: 600 }}>{props.label}</span>
        <span style={help}>{props.explain}</span>
        <select
          style={inputStyle}
          data-testid={props.testId}
          disabled={props.disabled}
          value={props.entryId ?? ""}
          onChange={(e) => props.onChange(e.target.value || null, props.keySecretId)}
        >
          <option value="">{props.emptyLabel}</option>
          {sorted.map((m) => (
            <option key={m.id} value={m.id}>
              {pickerModelOptionText(m)}
            </option>
          ))}
          {props.entryId && !picked ? <option value={props.entryId}>A saved model that no longer exists</option> : null}
        </select>
      </label>
      {picked?.readiness && !picked.readiness.ready && picked.readiness.kind !== "key_per_use" && picked.readiness.warning ? (
        <p style={warn}>
          {picked.readiness.badge}. {picked.readiness.warning}
        </p>
      ) : null}
      {props.extra?.(picked)}
      {props.entryId ? (
        <label style={fieldStyle}>
          <span>Key for this model</span>
          <select style={inputStyle} disabled={props.disabled} value={props.keySecretId ?? ""} onChange={(e) => props.onChange(props.entryId, e.target.value || null)}>
            <option value="">{picked?.provider === "local" ? "No key (own model server)" : "The helper's key for this service (Company settings → General → Helper)"}</option>
            {props.secrets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

export function DirectorForm(props: {
  director: StorylineDirector | null;
  models: PickerModel[];
  secrets: PickerSecret[];
  looks: PickerLook[];
  canEdit: boolean;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(props.director));
  useEffect(() => setDraft(draftOf(props.director)), [props.director]);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const disabled = !props.canEdit || props.busy;
  const writer = props.models.find((m) => m.id === draft.writingEntryId) ?? null;
  const helper = props.models.find((m) => m.id === draft.helperEntryId) ?? null;
  const writerTools = pickerModelCanUseTools(writer);
  const helperTools = pickerModelCanUseTools(helper);
  return (
    <div style={card} data-testid="director-form">
      <strong style={{ fontSize: 13 }}>{props.director ? `Edit "${props.director.name}"` : "New director"}</strong>
      <label style={fieldStyle}>
        <span style={{ fontWeight: 600 }}>Name</span>
        <input style={inputStyle} aria-label="Director name" disabled={disabled} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Product demo" />
      </label>
      <label style={fieldStyle}>
        <span style={{ fontWeight: 600 }}>Description</span>
        <input style={inputStyle} aria-label="Director description" disabled={disabled} value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="What kind of films this director makes" />
      </label>
      <ModelPicker
        label="Writing model"
        explain="Writes the storyboard and asks the follow-up questions. Any saved model works, also one that can't look at pictures or use tools."
        testId="director-writing-model"
        models={props.models}
        secrets={props.secrets}
        entryId={draft.writingEntryId}
        keySecretId={draft.writingKeySecretId}
        disabled={disabled}
        emptyLabel="The company's AI director model (Company settings → General → Helper)"
        onChange={(entryId, keySecretId) => set({ writingEntryId: entryId, writingKeySecretId: keySecretId })}
        extra={(picked) =>
          picked && writerTools === false ? (
            <p style={warn} data-testid="director-text-only-note">
              {TEXT_ONLY_EXPLANATION}
              {draft.helperEntryId ? "" : " Pick a helper model below that can use tools."}
            </p>
          ) : null
        }
      />
      <ModelPicker
        label="Picture analysis model (optional)"
        explain="Looks at the reference pictures and the cast's pictures first, and writes a plain description for the writing model. Must be able to see pictures. Pictures are only sent after the usual consent and age checks."
        testId="director-analysis-model"
        models={props.models}
        secrets={props.secrets}
        entryId={draft.analysisEntryId}
        keySecretId={draft.analysisKeySecretId}
        disabled={disabled}
        emptyLabel="None (the writing model looks, if it can see pictures)"
        onChange={(entryId, keySecretId) => set({ analysisEntryId: entryId, analysisKeySecretId: keySecretId })}
        extra={(picked) => (picked && picked.specs?.vision === false ? <p style={warn}>This model can't look at pictures. Pick one that can.</p> : null)}
      />
      <ModelPicker
        label="Helper model for lookups (optional)"
        explain="Only used when the writing model can't use tools: it looks things up for the writer (cast, looks, shots, cost) and fixes its answer when the format is off. Pick one that can use tools."
        testId="director-helper-model"
        models={props.models}
        secrets={props.secrets}
        entryId={draft.helperEntryId}
        keySecretId={draft.helperKeySecretId}
        disabled={disabled}
        emptyLabel="None (Paperclip looks things up itself)"
        onChange={(entryId, keySecretId) => set({ helperEntryId: entryId, helperKeySecretId: keySecretId })}
        extra={(picked) => (picked && helperTools === false ? <p style={warn}>This model can't use tools either, so it can't help. Pick one that can.</p> : null)}
      />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label style={{ ...fieldStyle, flex: "1 1 140px" }}>
          <span style={{ fontWeight: 600 }}>Creativity (0 to 2)</span>
          <input style={inputStyle} type="number" step="0.1" min={0} max={2} aria-label="Creativity" disabled={disabled} value={draft.temperature} placeholder="Model default" onChange={(e) => set({ temperature: e.target.value })} />
          <span style={help}>Higher is more surprising. Left out where the model does not take it.</span>
        </label>
        <label style={{ ...fieldStyle, flex: "1 1 140px" }}>
          <span style={{ fontWeight: 600 }}>Thinking</span>
          <select style={inputStyle} aria-label="Thinking" disabled={disabled} value={draft.thinking} onChange={(e) => set({ thinking: e.target.value as Draft["thinking"] })}>
            <option value="">Model default</option>
            <option value="on">On (slower, more careful)</option>
            <option value="off">Off (faster)</option>
          </select>
          <span style={help}>Only where the model supports it.</span>
        </label>
      </div>
      <label style={fieldStyle}>
        <span style={{ fontWeight: 600 }}>Style instructions</span>
        <span style={help}>Tone, pacing, shot length, camera language and structure. The writer follows these for every storyline with this director.</span>
        <textarea style={{ ...inputStyle, minHeight: 110 }} aria-label="Style instructions" disabled={disabled} value={draft.styleInstructions} onChange={(e) => set({ styleInstructions: e.target.value })} />
      </label>
      <strong style={{ fontSize: 12 }}>Defaults for a new storyboard</strong>
      <span style={help}>Put on the storyline the first time this director writes it, unless the storyline already has its own.</span>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label style={{ ...fieldStyle, flex: "1 1 140px" }}>
          <span>Video service</span>
          <select style={inputStyle} aria-label="Default video service" disabled={disabled} value={draft.defaultVideoProviderId} onChange={(e) => set({ defaultVideoProviderId: e.target.value as Draft["defaultVideoProviderId"] })}>
            <option value="">Keep the storyline's</option>
            <option value="fal">Fal.ai</option>
            <option value="sogni">Sogni</option>
          </select>
        </label>
        <label style={{ ...fieldStyle, flex: "2 1 200px" }}>
          <span>Video model (optional)</span>
          <input style={inputStyle} aria-label="Default video model" disabled={disabled || !draft.defaultVideoProviderId} value={draft.defaultVideoModel} placeholder="The service's default" onChange={(e) => set({ defaultVideoModel: e.target.value })} />
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label style={{ ...fieldStyle, flex: "2 1 200px" }}>
          <span>Picture look</span>
          <select style={inputStyle} aria-label="Default picture look" disabled={disabled} value={draft.defaultLookId} onChange={(e) => set({ defaultLookId: e.target.value })}>
            <option value="">No default look</option>
            {props.looks.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
            {draft.defaultLookId && !props.looks.some((l) => l.id === draft.defaultLookId) ? <option value={draft.defaultLookId}>A look that no longer exists</option> : null}
          </select>
        </label>
        <label style={{ ...fieldStyle, flex: "1 1 120px" }}>
          <span>Shot length (seconds)</span>
          <input style={inputStyle} type="number" min={1} max={60} aria-label="Default shot length" disabled={disabled} value={draft.defaultShotSeconds} placeholder="5" onChange={(e) => set({ defaultShotSeconds: e.target.value })} />
        </label>
      </div>
      {props.canEdit ? (
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" style={primaryBtn} disabled={disabled || !draft.name.trim()} onClick={() => props.onSave(directorBody(draft))}>
            Save director
          </button>
          <button type="button" style={ghostBtn} disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <p style={help}>Only an owner or admin can change directors.</p>
      )}
    </div>
  );
}

/** The company's directors: list, add, edit, delete (owners and admins). */
export function DirectorsEditor(props: {
  companyId: string;
  fetchJson: DirectorFetch;
  looks: PickerLook[];
  onChanged?: () => void;
  onClose?: () => void;
}) {
  const base = `/api/companies/${props.companyId}/video-storylines/directors`;
  const [view, setView] = useState<DirectorsView | null>(null);
  const [models, setModels] = useState<PickerModel[]>([]);
  const [secrets, setSecrets] = useState<PickerSecret[]>([]);
  const [editing, setEditing] = useState<StorylineDirector | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setView(await props.fetchJson<DirectorsView>(base));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
    props
      .fetchJson<PickerModel[]>(`/api/companies/${props.companyId}/model-directory?withReadiness=1`)
      .then((m) => setModels((m ?? []).filter((x) => !x.archivedAt)))
      .catch(() => setModels([]));
    props
      .fetchJson<PickerSecret[]>(`/api/companies/${props.companyId}/secrets`)
      .then((s) => setSecrets(s ?? []))
      .catch(() => setSecrets([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.companyId]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(null);
      await load();
      props.onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (body: Record<string, unknown>) =>
    run(() =>
      editing && editing !== "new"
        ? props.fetchJson(`${base}/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : props.fetchJson(base, { method: "POST", body: JSON.stringify(body) }),
    );
  const remove = (d: StorylineDirector) => {
    if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(`Delete the director "${d.name}"? Storylines that use it keep their shots.`)) return;
    void run(() => props.fetchJson(`${base}/${d.id}`, { method: "DELETE" }));
  };

  return (
    <div style={card} data-testid="directors-editor">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div>
          <strong style={{ fontSize: 13 }}>Directors</strong>
          <p style={help}>Each director writes storyboards its own way: which AI models it uses and its style. For this company only.</p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {view?.canEdit ? (
            <button type="button" style={primaryBtn} disabled={busy} onClick={() => setEditing("new")}>
              Add director
            </button>
          ) : null}
          {props.onClose ? (
            <button type="button" style={ghostBtn} onClick={props.onClose}>
              Close
            </button>
          ) : null}
        </div>
      </div>
      {error ? (
        <div style={errorBox} role="alert">
          {error}
        </div>
      ) : null}
      {!view ? <p style={help}>Loading directors…</p> : null}
      {view && !view.canEdit ? <p style={help}>Only an owner or admin can add, change or delete directors.</p> : null}
      {editing === "new" ? (
        <DirectorForm director={null} models={models} secrets={secrets} looks={props.looks} canEdit={!!view?.canEdit} busy={busy} onSave={save} onCancel={() => setEditing(null)} />
      ) : null}
      {(view?.directors ?? []).map((d) =>
        editing !== "new" && editing?.id === d.id ? (
          <DirectorForm key={d.id} director={d} models={models} secrets={secrets} looks={props.looks} canEdit={!!view?.canEdit} busy={busy} onSave={save} onCancel={() => setEditing(null)} />
        ) : (
          <div key={d.id} style={{ border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8, padding: 10, display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }} data-testid={`director-row-${d.id}`}>
            <div style={{ flex: "1 1 220px", minWidth: 0, fontSize: 12 }}>
              <strong style={{ fontSize: 13 }}>{d.name}</strong>
              {d.description ? <div>{d.description}</div> : null}
              <div style={{ color: "#868e96" }}>
                Writes with {d.writing?.name ? `"${d.writing.name}"` : d.writing ? "a saved model that no longer exists" : "the company's AI director model"}
                {d.analysis?.name ? ` · looks at pictures with "${d.analysis.name}"` : ""}
                {d.helper?.name ? ` · helper "${d.helper.name}"` : ""}
              </div>
              <div style={{ color: d.writerMode === "tools" ? "#868e96" : "#b35c00" }}>{d.writerModeNote}</div>
              {directorWarning(d) ? <div style={{ color: "#b35c00" }}>{directorWarning(d)}</div> : null}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
              <button type="button" style={ghostBtn} disabled={busy} onClick={() => setEditing(d)}>
                {view?.canEdit ? "Edit" : "View"}
              </button>
              {view?.canEdit ? (
                <button type="button" style={dangerBtn} disabled={busy} onClick={() => remove(d)}>
                  Delete
                </button>
              ) : null}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
