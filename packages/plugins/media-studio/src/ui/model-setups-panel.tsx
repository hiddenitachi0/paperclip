import { useCallback, useEffect, useMemo, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "./storyline-api.js";
import { FAL_VIDEO_MODELS, type SogniVideoModelRow } from "./video-model-picker.js";
import {
  IMAGE_MODES,
  KIND_NAMES,
  MODE_NAMES,
  RATING_NAMES,
  RATING_PILL,
  RECIPE_CHANGE_NOTE,
  STATUS_HELP,
  STATUS_NAMES,
  STATUS_PILL,
  VIDEO_MODES,
  VIEW_ONLY_NOTE,
  card,
  dangerBtn,
  errorBox,
  field,
  ghostBtn,
  infoBox,
  input,
  muted,
  okBox,
  primaryBtn,
  providerName,
  rangeText,
  secondaryBtn,
  setupsBase,
  setupsFetch,
  splitWords,
  strengthText,
  warnBox,
  type MediaLoraRow,
  type MediaSetupRow,
  type SetupCheck,
  type SetupDraft,
  type SetupKind,
  type SetupMode,
  type SetupProvider,
} from "./setups-api.js";

// Model setups: a named recipe a person picks by name, for example
// "Action" = MiniMax H3 on Sogni with the Better Motion LoRA at 0.8. Owners
// and admins make, change and approve setups; everyone else only looks.
// Agents may only use approved ones. A setup is rated "safe for work" or
// "mature" by the server (a mature model or LoRA, or one nobody has checked,
// makes it mature) and changing an approved setup's recipe sends it back to
// draft. The server's refusals are shown as they are: they are written in
// plain words.

const ACTION_SOGNI_VIDEO_MODELS = "sogni.videoModels";
const ACTION_SOGNI_MODELS = "sogni.models";

type ModelChoice = { id: string; name: string };

const STARTER_SOGNI_VIDEO: ModelChoice[] = [
  { id: "minimax-h3-fl2va-fp8_flf2v", name: "MiniMax H3, start and end picture (takes LoRAs)" },
  { id: "wan3.0-video", name: "Wan 3 (takes no LoRA)" },
];
const STARTER_SOGNI_IMAGE: ModelChoice[] = [{ id: "krea2_turbo_fp8_scaled", name: "Krea 2 Turbo (takes LoRAs)" }];
const FAL_LORA_VIDEO: ModelChoice[] = [
  { id: "minimax/h3/text-to-video/lora", name: "MiniMax H3, from text, with LoRAs" },
  { id: "minimax/h3/reference-to-video/lora", name: "MiniMax H3, from reference pictures, with LoRAs" },
  { id: "fal-ai/wan-flf2v", name: "Wan 2.1, start and end picture, with LoRAs" },
];
const FAL_IMAGE: ModelChoice[] = [
  { id: "fal-ai/flux/dev", name: "FLUX.1 dev" },
  { id: "fal-ai/flux-lora", name: "FLUX.1 with LoRAs" },
  { id: "fal-ai/flux-pro/v1.1", name: "FLUX1.1 pro" },
];

function dedupe(choices: ModelChoice[]): ModelChoice[] {
  const seen = new Set<string>();
  return choices.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

const PROVIDERS_FOR: Record<SetupKind, SetupProvider[]> = { video: ["sogni", "fal"], image: ["sogni", "fal", "higgsfield"] };

/** The settings a person can type; other allowed ones already on a setup are kept as they are. */
const PARAM_FIELDS: Array<{ key: string; label: string; kind: "text" | "number"; hint: string }> = [
  { key: "aspectRatio", label: "Picture shape", kind: "text", hint: 'For example "16:9" or "auto".' },
  { key: "resolution", label: "Size", kind: "text", hint: 'For example "720p".' },
  { key: "durationSeconds", label: "Clip length in seconds", kind: "number", hint: "Leave empty to let the film decide." },
  { key: "fps", label: "Frames per second", kind: "number", hint: "A whole number from 1 to 120." },
  { key: "steps", label: "Steps", kind: "number", hint: "A whole number from 1 to 200. More steps take longer." },
  { key: "guidance", label: "Guidance", kind: "number", hint: "A number from 0 to 50. Higher follows the prompt more closely." },
  { key: "seed", label: "Seed", kind: "number", hint: "A whole number. The same seed repeats a result." },
  { key: "negativePrompt", label: "Words to avoid", kind: "text", hint: "Things the service should keep out of the result." },
];

function emptyDraft(kind: SetupKind): SetupDraft {
  return { kind, name: "", description: "", provider: "sogni", mode: null, modelId: "", loras: [], params: { promptExpansion: false }, tags: [], notes: "" };
}

function draftOf(setup: MediaSetupRow): SetupDraft {
  return {
    kind: setup.kind,
    name: setup.name,
    description: setup.description,
    provider: setup.provider,
    mode: setup.mode,
    modelId: setup.modelId,
    loras: setup.loras.map((l) => ({ loraId: l.loraId, strength: l.strength })),
    params: { promptExpansion: false, ...setup.params },
    tags: setup.tags,
    notes: setup.notes,
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Only what changed, so renaming a setup never trips over a problem that came later. */
function changesOf(draft: SetupDraft, setup: MediaSetupRow): Record<string, unknown> {
  const before = draftOf(setup);
  const body: Record<string, unknown> = {};
  for (const key of ["kind", "name", "description", "provider", "mode", "modelId", "loras", "params", "tags", "notes"] as const) {
    if (!sameJson(draft[key], before[key])) body[key] = draft[key];
  }
  return body;
}

function bodyOf(draft: SetupDraft): Record<string, unknown> {
  return { ...draft, name: draft.name.trim(), description: draft.description.trim(), notes: draft.notes.trim(), modelId: draft.modelId.trim() };
}

export function ModelSetupsPanel({ companyId }: { companyId: string }) {
  const base = setupsBase(companyId);
  const [setups, setSetups] = useState<MediaSetupRow[] | null>(null);
  const [loras, setLoras] = useState<MediaLoraRow[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** "new" for a blank form, a setup id for editing that one. */
  const [editing, setEditing] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<SetupKind>("video");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([
        setupsFetch<{ setups: MediaSetupRow[]; canEdit: boolean }>(`${base}/setups?includeArchived=true`, undefined, "loading the model setups"),
        setupsFetch<{ loras: MediaLoraRow[] }>(`${base}/loras?includeArchived=true`, undefined, "loading the LoRA library"),
      ]);
      setSetups(s.setups);
      setCanEdit(s.canEdit);
      setLoras(l.loras);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await work();
      await load();
      setNotice(message);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const patch = (setup: MediaSetupRow, body: Record<string, unknown>, doing: string, done: string) =>
    run(async () => {
      await setupsFetch(`${base}/setups/${setup.id}`, { method: "PATCH", body: JSON.stringify(body) }, doing);
      return done;
    });

  if (loadError) return <div style={errorBox}>{loadError}</div>;
  if (!setups) return <p style={muted}>Loading the model setups…</p>;

  const active = setups.filter((s) => s.status !== "archived");
  const archived = setups.filter((s) => s.status === "archived");

  const renderCard = (setup: MediaSetupRow) => (
    <SetupCard
      key={setup.id}
      setup={setup}
      canEdit={canEdit}
      busy={busy}
      editing={editing === setup.id}
      confirmingDelete={confirmDeleteId === setup.id}
      onEdit={() => setEditing(editing === setup.id ? null : setup.id)}
      onApprove={() => patch(setup, { status: "approved" }, "approving the setup", `"${setup.name}" is approved. Agents can now pick it for films.`)}
      onUnapprove={() => patch(setup, { status: "draft" }, "sending the setup back to draft", `"${setup.name}" is a draft again. Agents cannot use it until you approve it.`)}
      onArchive={() => patch(setup, { status: "archived" }, "archiving the setup", `"${setup.name}" is archived.`)}
      onRestore={() => patch(setup, { status: "draft" }, "restoring the setup", `"${setup.name}" is restored as a draft. Approve it when you want agents to use it.`)}
      onAskDelete={() => setConfirmDeleteId(setup.id)}
      onCancelDelete={() => setConfirmDeleteId(null)}
      onDelete={() =>
        run(async () => {
          await setupsFetch(`${base}/setups/${setup.id}`, { method: "DELETE" }, "deleting the setup");
          setConfirmDeleteId(null);
          return `"${setup.name}" is deleted.`;
        })
      }
    >
      {canEdit && editing === setup.id ? (
        <SetupForm
          key={setup.id}
          companyId={companyId}
          loras={loras}
          initial={draftOf(setup)}
          approved={setup.status === "approved"}
          busy={busy}
          onSave={(draft) => {
            const body = changesOf(draft, setup);
            if (Object.keys(body).length === 0) {
              setEditing(null);
              setNotice("Nothing was changed.");
              return Promise.resolve(true);
            }
            return run(async () => {
              const saved = await setupsFetch<MediaSetupRow>(`${base}/setups/${setup.id}`, { method: "PATCH", body: JSON.stringify(body) }, "saving the setup");
              setEditing(null);
              return setup.status === "approved" && saved.status === "draft"
                ? `Saved "${saved.name}". Because you changed how it works, it went back to draft. Approve it again when you are happy with it.`
                : `Saved "${saved.name}".`;
            });
          }}
        />
      ) : null}
    </SetupCard>
  );

  return (
    <section aria-label="Model setups" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Model setups</h2>
        <p style={{ ...muted, marginTop: 4 }}>
          A model setup is a recipe with a name, such as "Action": which service and model to use, which LoRAs, and how strong. Agents and films pick a setup by its name. Agents can only pick approved ones.
        </p>
      </div>
      {!canEdit ? <div style={infoBox}>{VIEW_ONLY_NOTE}</div> : null}
      {error ? <div style={errorBox} role="alert">{error}</div> : null}
      {notice ? <div style={okBox} role="status">{notice}</div> : null}

      {canEdit ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            style={editing === "new" && newKind === "video" ? primaryBtn : secondaryBtn}
            onClick={() => {
              setNewKind("video");
              setEditing(editing === "new" && newKind === "video" ? null : "new");
            }}
          >
            New video setup
          </button>
          <button
            type="button"
            style={editing === "new" && newKind === "image" ? primaryBtn : secondaryBtn}
            onClick={() => {
              setNewKind("image");
              setEditing(editing === "new" && newKind === "image" ? null : "new");
            }}
          >
            New picture setup
          </button>
        </div>
      ) : null}
      {canEdit && editing === "new" ? (
        <div style={card}>
          <strong style={{ fontSize: 13 }}>{newKind === "video" ? "New video setup" : "New picture setup"}</strong>
          <SetupForm
            key={`new-${newKind}`}
            companyId={companyId}
            loras={loras}
            initial={emptyDraft(newKind)}
            approved={false}
            busy={busy}
            onSave={(draft) =>
              run(async () => {
                const saved = await setupsFetch<MediaSetupRow>(`${base}/setups`, { method: "POST", body: JSON.stringify({ ...bodyOf(draft), status: "draft" }) }, "saving the setup");
                setEditing(null);
                return `"${saved.name}" is saved as a draft. Approve it when you want agents to use it.`;
              })
            }
          />
        </div>
      ) : null}

      {active.length === 0 ? <p style={muted}>No model setups yet.{canEdit ? " Use a button above to make the first one." : ""}</p> : null}
      {active.map(renderCard)}
      {archived.length > 0 ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Archived ({archived.length})</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>{archived.map(renderCard)}</div>
        </details>
      ) : null}
    </section>
  );
}

function SetupCard(props: {
  setup: MediaSetupRow;
  canEdit: boolean;
  busy: boolean;
  editing: boolean;
  confirmingDelete: boolean;
  onEdit: () => void;
  onApprove: () => Promise<boolean>;
  onUnapprove: () => Promise<boolean>;
  onArchive: () => Promise<boolean>;
  onRestore: () => Promise<boolean>;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => Promise<boolean>;
  children?: React.ReactNode;
}) {
  const { setup, canEdit, busy } = props;
  return (
    <div style={card} data-testid={`setup-${setup.id}`}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>{setup.name}</strong>
        <span style={STATUS_PILL[setup.status]} title={STATUS_HELP[setup.status]}>{STATUS_NAMES[setup.status]}</span>
        <span style={RATING_PILL[setup.contentRating]} title={setup.contentRating === "mature" ? "Only for films marked mature." : "Fine for any film."}>
          {RATING_NAMES[setup.contentRating]}
        </span>
        <span style={muted}>
          {KIND_NAMES[setup.kind]} · {providerName(setup.provider)}
        </span>
      </div>
      <p style={muted}>{STATUS_HELP[setup.status]}</p>
      {setup.description ? <p style={{ margin: 0, fontSize: 13 }}>{setup.description}</p> : null}
      <p style={muted}>
        Model: {setup.modelId}
        {setup.mode ? ` · ${MODE_NAMES[setup.mode]}` : ""}
      </p>
      {setup.loras.length > 0 ? (
        <p style={muted}>
          LoRAs: {setup.loras.map((l) => `${l.name ?? "A LoRA that was removed"} at ${strengthText(l.strength)}`).join(", ")}
        </p>
      ) : (
        <p style={muted}>No LoRAs.</p>
      )}
      <p style={muted}>{setup.billingLabel}.</p>
      {setup.contentRating === "mature" && setup.matureReasons.length > 0 ? (
        <div style={{ ...muted, color: "#862e9c" }}>
          Why it is mature:
          <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
            {setup.matureReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {setup.problems.length > 0 ? (
        <div style={warnBox}>
          It cannot be used right now:
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {setup.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {canEdit ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {setup.status === "draft" ? (
            <button type="button" style={primaryBtn} disabled={busy} onClick={() => void props.onApprove()}>Approve</button>
          ) : null}
          {setup.status === "approved" ? (
            <button type="button" style={ghostBtn} disabled={busy} onClick={() => void props.onUnapprove()}>Send back to draft</button>
          ) : null}
          {setup.status !== "archived" ? (
            <>
              <button type="button" style={ghostBtn} disabled={busy} onClick={props.onEdit}>{props.editing ? "Close" : "Edit"}</button>
              <button type="button" style={ghostBtn} disabled={busy} onClick={() => void props.onArchive()}>Archive</button>
            </>
          ) : (
            <button type="button" style={secondaryBtn} disabled={busy} onClick={() => void props.onRestore()}>Restore</button>
          )}
          {props.confirmingDelete ? (
            <>
              <button type="button" style={dangerBtn} disabled={busy} onClick={() => void props.onDelete()}>Yes, delete "{setup.name}"</button>
              <button type="button" style={ghostBtn} onClick={props.onCancelDelete}>Keep it</button>
            </>
          ) : (
            <button type="button" style={dangerBtn} disabled={busy} onClick={props.onAskDelete}>Delete</button>
          )}
        </div>
      ) : null}
      {props.children}
    </div>
  );
}

/** The model list: a pick-list of known models plus "Other", where the model id can be typed. */
function ModelField(props: { value: string; choices: ModelChoice[]; disabled?: boolean; onChange: (id: string) => void }) {
  const known = props.choices.some((c) => c.id === props.value);
  const [other, setOther] = useState(props.value !== "" && !known);
  return (
    <div style={field}>
      <label style={field}>
        <span>Model</span>
        <select
          style={input}
          aria-label="Model"
          disabled={props.disabled}
          value={other ? "__other" : props.value}
          onChange={(e) => {
            if (e.target.value === "__other") {
              setOther(true);
              return;
            }
            setOther(false);
            props.onChange(e.target.value);
          }}
        >
          <option value="">Pick a model…</option>
          {props.choices.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
          <option value="__other">Another model (type its id)</option>
        </select>
      </label>
      {other ? (
        <input
          style={input}
          aria-label="Model id"
          placeholder="The model's exact id"
          disabled={props.disabled}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
      ) : null}
    </div>
  );
}

function SetupForm(props: {
  companyId: string;
  loras: MediaLoraRow[];
  initial: SetupDraft;
  approved: boolean;
  busy: boolean;
  onSave: (draft: SetupDraft) => Promise<boolean>;
}) {
  const base = setupsBase(props.companyId);
  const listVideoModels = usePluginAction(ACTION_SOGNI_VIDEO_MODELS);
  const listPictureModels = usePluginAction(ACTION_SOGNI_MODELS);
  const [draft, setDraft] = useState<SetupDraft>(props.initial);
  const [tagsText, setTagsText] = useState(props.initial.tags.join(", "));
  const [paramText, setParamText] = useState<Record<string, string>>(() =>
    Object.fromEntries(PARAM_FIELDS.map((f) => [f.key, props.initial.params[f.key] === undefined || props.initial.params[f.key] === null ? "" : String(props.initial.params[f.key])])),
  );
  const [sogniVideo, setSogniVideo] = useState<ModelChoice[]>([]);
  const [sogniImage, setSogniImage] = useState<ModelChoice[]>([]);
  const [check, setCheck] = useState<SetupCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let stop = false;
    if (draft.provider !== "sogni") return;
    if (draft.kind === "video" && sogniVideo.length === 0) {
      listVideoModels({})
        .then((res) => {
          if (stop) return;
          const rows = ((res ?? {}) as { models?: SogniVideoModelRow[] }).models ?? [];
          setSogniVideo(rows.map((r) => ({ id: r.id, name: r.name })));
        })
        .catch(() => undefined);
    }
    if (draft.kind === "image" && sogniImage.length === 0) {
      listPictureModels({})
        .then((res) => {
          if (stop) return;
          const rows = ((res ?? {}) as { models?: Array<{ id: string; name: string; generates?: boolean }> }).models ?? [];
          setSogniImage(rows.filter((r) => r.generates !== false).map((r) => ({ id: r.id, name: r.name })));
        })
        .catch(() => undefined);
    }
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.provider, draft.kind]);

  const choices = useMemo(() => {
    if (draft.provider === "sogni") return dedupe(draft.kind === "video" ? [...STARTER_SOGNI_VIDEO, ...sogniVideo] : [...STARTER_SOGNI_IMAGE, ...sogniImage]);
    if (draft.provider === "fal") {
      return draft.kind === "video"
        ? dedupe([...FAL_LORA_VIDEO, ...FAL_VIDEO_MODELS.filter((m) => m.id !== null).map((m) => ({ id: m.id as string, name: m.name }))])
        : FAL_IMAGE;
    }
    return [];
  }, [draft.provider, draft.kind, sogniVideo, sogniImage]);

  const update = (patch: Partial<SetupDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setCheck(null);
    setCheckError(null);
  };

  const builtParams = useMemo(() => {
    const params: Record<string, unknown> = { ...draft.params };
    const badFields: string[] = [];
    for (const f of PARAM_FIELDS) {
      const text = (paramText[f.key] ?? "").trim();
      if (text === "") {
        delete params[f.key];
      } else if (f.kind === "number") {
        const n = Number(text);
        if (Number.isFinite(n)) params[f.key] = n;
        else badFields.push(f.label);
      } else {
        params[f.key] = text;
      }
    }
    return { params, badFields };
  }, [draft.params, paramText]);

  const full: SetupDraft = { ...draft, params: builtParams.params, tags: splitWords(tagsText) };
  const loraLimit = draft.provider === "sogni" || draft.provider === "fal";
  const usable = props.loras.filter((l) => !l.archivedAt && l.provider === draft.provider);
  const pickedIds = new Set(draft.loras.map((l) => l.loraId));
  const strengthsOk = draft.loras.every((l) => Number.isFinite(l.strength));
  const complete = full.name.trim().length > 0 && full.modelId.trim().length > 0 && builtParams.badFields.length === 0 && strengthsOk;
  const modes = draft.kind === "video" ? VIDEO_MODES : IMAGE_MODES;

  const runCheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      setCheck(await setupsFetch<SetupCheck>(`${base}/setups/check`, { method: "POST", body: JSON.stringify({ ...bodyOf(full), name: full.name.trim() || "Draft" }) }, "checking the setup"));
    } catch (e) {
      setCheck(null);
      setCheckError(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <form
      aria-label="Setup details"
      style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid rgba(128,128,128,0.25)", paddingTop: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (complete) void props.onSave(full);
      }}
    >
      {props.approved ? <div style={warnBox}>{RECIPE_CHANGE_NOTE}</div> : null}
      <label style={field}>
        <span>Name</span>
        <input style={input} aria-label="Setup name" placeholder="For example: Action" value={draft.name} onChange={(e) => update({ name: e.target.value })} />
      </label>
      <label style={field}>
        <span>What it is for</span>
        <textarea style={{ ...input, minHeight: 48 }} aria-label="What it is for" value={draft.description} onChange={(e) => update({ description: e.target.value })} />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 8 }}>
        <label style={field}>
          <span>Makes</span>
          <select
            style={input}
            aria-label="Makes"
            value={draft.kind}
            onChange={(e) => {
              const kind = e.target.value as SetupKind;
              update({ kind, mode: null, modelId: "", loras: [], provider: PROVIDERS_FOR[kind].includes(draft.provider) ? draft.provider : "sogni" });
            }}
          >
            <option value="video">Video</option>
            <option value="image">Pictures</option>
          </select>
        </label>
        <label style={field}>
          <span>Service</span>
          <select
            style={input}
            aria-label="Service"
            value={draft.provider}
            onChange={(e) => update({ provider: e.target.value as SetupProvider, modelId: "", loras: [] })}
          >
            {Array.from(new Set([...PROVIDERS_FOR[draft.kind], draft.provider])).map((p) => (
              <option key={p} value={p}>{providerName(p)}</option>
            ))}
          </select>
        </label>
        <ModelField key={`${draft.provider}-${draft.kind}`} value={draft.modelId} choices={choices} onChange={(modelId) => update({ modelId })} />
        <label style={field}>
          <span>How it works</span>
          <select style={input} aria-label="How it works" value={draft.mode ?? ""} onChange={(e) => update({ mode: e.target.value === "" ? null : (e.target.value as SetupMode) })}>
            <option value="">Work it out from the model</option>
            {modes.map((m) => (
              <option key={m} value={m}>{MODE_NAMES[m]}</option>
            ))}
          </select>
        </label>
      </div>

      <fieldset style={{ border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
        <legend style={{ fontSize: 13, fontWeight: 600 }}>LoRAs</legend>
        {!loraLimit ? <p style={muted}>This service takes no LoRAs.</p> : null}
        {loraLimit && usable.length === 0 ? <p style={muted}>No {providerName(draft.provider)} LoRAs in the library yet. Add some on the LoRA library page first.</p> : null}
        {draft.loras.map((pick, index) => {
          const lora = props.loras.find((l) => l.id === pick.loraId) ?? null;
          const recommended = lora ? rangeText(lora.recommendedMin, lora.recommendedMax) : null;
          return (
            <div key={pick.loraId} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={{ ...field, flex: "1 1 200px" }}>
                <span>LoRA</span>
                <select
                  style={input}
                  aria-label={`LoRA ${index + 1}`}
                  value={pick.loraId}
                  onChange={(e) => {
                    const next = props.loras.find((l) => l.id === e.target.value);
                    update({ loras: draft.loras.map((p, i) => (i === index ? { loraId: e.target.value, strength: next?.strengthDefault ?? p.strength } : p)) });
                  }}
                >
                  {usable.filter((l) => l.id === pick.loraId || !pickedIds.has(l.id)).map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                  {!usable.some((l) => l.id === pick.loraId) ? <option value={pick.loraId}>{lora?.name ?? "A LoRA that was removed"}</option> : null}
                </select>
              </label>
              <label style={{ ...field, width: 120 }}>
                <span>Strength</span>
                <input
                  style={input}
                  aria-label={`Strength ${index + 1}`}
                  inputMode="decimal"
                  value={Number.isNaN(pick.strength) ? "" : String(pick.strength)}
                  onChange={(e) => update({ loras: draft.loras.map((p, i) => (i === index ? { ...p, strength: e.target.value.trim() === "" ? Number.NaN : Number(e.target.value) } : p)) })}
                />
              </label>
              <button type="button" style={ghostBtn} onClick={() => update({ loras: draft.loras.filter((_, i) => i !== index) })}>Remove</button>
              {recommended ? <span style={{ ...muted, flexBasis: "100%" }}>Works best between {recommended}. A strength is a multiplier, not a percentage.</span> : null}
            </div>
          );
        })}
        {loraLimit ? (
          <div>
            <button
              type="button"
              style={secondaryBtn}
              disabled={usable.every((l) => pickedIds.has(l.id)) || draft.loras.length >= 8}
              onClick={() => {
                const next = usable.find((l) => !pickedIds.has(l.id));
                if (next) update({ loras: [...draft.loras, { loraId: next.id, strength: next.strengthDefault }] });
              }}
            >
              Add a LoRA
            </button>
          </div>
        ) : null}
      </fieldset>

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
        <input
          type="checkbox"
          aria-label="Let the service rewrite my prompt"
          checked={draft.params.promptExpansion === true}
          onChange={(e) => update({ params: { ...draft.params, promptExpansion: e.target.checked } })}
        />
        <span>
          Let the service rewrite my prompt
          <span style={{ ...muted, display: "block" }}>Off keeps your words exactly as written.</span>
        </span>
      </label>

      <details>
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>More settings (optional)</summary>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, marginTop: 8 }}>
          {PARAM_FIELDS.map((f) => (
            <label key={f.key} style={field}>
              <span>{f.label}</span>
              <input
                style={input}
                aria-label={f.label}
                inputMode={f.kind === "number" ? "decimal" : undefined}
                value={paramText[f.key] ?? ""}
                onChange={(e) => {
                  setParamText((t) => ({ ...t, [f.key]: e.target.value }));
                  setCheck(null);
                }}
              />
              <span style={muted}>{f.hint}</span>
            </label>
          ))}
        </div>
        <p style={muted}>A setup can never switch off a service's safety filter. The film's safe-for-work or mature mark decides that.</p>
      </details>
      {!strengthsOk ? <div style={errorBox}>Give every LoRA a strength, such as 0.6.</div> : null}
      {builtParams.badFields.length > 0 ? <div style={errorBox}>Type a number for: {builtParams.badFields.join(", ")}.</div> : null}

      <label style={field}>
        <span>Tags (separate with commas)</span>
        <input style={input} aria-label="Tags" value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
      </label>
      <label style={field}>
        <span>Notes</span>
        <textarea style={{ ...input, minHeight: 48 }} aria-label="Notes" value={draft.notes} onChange={(e) => update({ notes: e.target.value })} />
      </label>

      {checkError ? <div style={errorBox} role="alert">{checkError}</div> : null}
      {check ? (
        check.problems.length > 0 ? (
          <div style={errorBox} role="alert">
            This setup cannot be saved yet:
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {check.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div style={okBox} role="status">
            This setup works. It will be rated <strong>{RATING_NAMES[check.contentRating]}</strong>. {check.billingLabel}.
            {check.matureReasons.length > 0 ? (
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {check.matureReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )
      ) : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={secondaryBtn} disabled={checking || !complete} onClick={() => void runCheck()}>
          {checking ? "Checking…" : "Check this setup"}
        </button>
        <button type="submit" style={primaryBtn} disabled={props.busy || !complete}>Save</button>
      </div>
      {!props.approved ? <p style={muted}>A new setup is saved as a draft. Approve it from its card when you want agents to use it.</p> : null}
    </form>
  );
}
