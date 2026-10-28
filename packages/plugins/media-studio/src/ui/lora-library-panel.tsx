import { useCallback, useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "./storyline-api.js";
import {
  LORA_SOURCE_NAMES,
  TAG_HELP,
  TAG_NAMES,
  TAG_PILL,
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
  shortLink,
  splitWords,
  strengthText,
  warnBox,
  type ContentTag,
  type MediaLoraRow,
} from "./setups-api.js";

// The LoRA library: the LoRAs a company has saved, which model setups can use.
// A LoRA is a small add-on that changes how a video or picture model looks or
// moves. Owners and admins add (from Sogni's list or a Fal link), edit, put
// away and delete; everyone else only looks. The server turns away anything
// that would bypass a safety filter, change a person's age, or carry a key in
// its link, and says why in plain words, which is shown as it is.

const ACTION_SOGNI_LORAS = "sogni.loras";

/** The Sogni models that take LoRAs, to ask Sogni "which LoRAs work with this one". */
const SOGNI_LORA_MODELS: Array<{ id: string; label: string }> = [
  { id: "minimax-h3-fl2va-fp8_flf2v", label: "MiniMax H3 (video)" },
  { id: "krea2_turbo_fp8_scaled", label: "Krea 2 (pictures)" },
];

const TAG_CHOICES: ContentTag[] = ["unreviewed", "sfw", "mature"];

type SogniLoraRow = {
  id: string;
  name: string;
  description?: string;
  personal: boolean;
  modelIds?: string[];
  min: number;
  max: number;
  default: number;
  recommendedMin?: number;
  recommendedMax?: number;
  needsFilterOff?: boolean;
  sexual?: boolean;
};

function TagSelect(props: { value: ContentTag; onChange: (tag: ContentTag) => void; label: string; disabled?: boolean }) {
  return (
    <label style={field}>
      <span>{props.label}</span>
      <select style={input} aria-label={props.label} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value as ContentTag)}>
        {TAG_CHOICES.map((t) => (
          <option key={t} value={t}>
            {TAG_NAMES[t]}
          </option>
        ))}
      </select>
      <span style={muted}>{TAG_HELP[props.value]}</span>
    </label>
  );
}

function numberOrNull(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function LoraLibraryPanel({ companyId }: { companyId: string }) {
  const base = setupsBase(companyId);
  const [loras, setLoras] = useState<MediaLoraRow[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<"sogni" | "fal" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await setupsFetch<{ loras: MediaLoraRow[]; canEdit: boolean }>(`${base}/loras?includeArchived=true`, undefined, "loading the LoRA library");
      setLoras(res.loras);
      setCanEdit(res.canEdit);
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

  const create = (body: Record<string, unknown>, name: string) =>
    run(async () => {
      await setupsFetch(`${base}/loras`, { method: "POST", body: JSON.stringify(body) }, "adding the LoRA");
      return `"${name}" is in your library. Add it to a model setup to use it.`;
    });

  if (loadError) return <div style={errorBox}>{loadError}</div>;
  if (!loras) return <p style={muted}>Loading the LoRA library…</p>;

  const active = loras.filter((l) => !l.archivedAt);
  const archived = loras.filter((l) => l.archivedAt);

  return (
    <section aria-label="LoRA library" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>LoRA library</h2>
        <p style={{ ...muted, marginTop: 4 }}>
          A LoRA is a small add-on that changes how a video or picture model moves or looks. Save the ones you like here, then add them to a model setup.
        </p>
      </div>
      {!canEdit ? <div style={infoBox}>{VIEW_ONLY_NOTE}</div> : null}
      {error ? <div style={errorBox} role="alert">{error}</div> : null}
      {notice ? <div style={okBox} role="status">{notice}</div> : null}

      {canEdit ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={adding === "sogni" ? primaryBtn : secondaryBtn} onClick={() => setAdding(adding === "sogni" ? null : "sogni")}>
            Add from Sogni's list
          </button>
          <button type="button" style={adding === "fal" ? primaryBtn : secondaryBtn} onClick={() => setAdding(adding === "fal" ? null : "fal")}>
            Add a Fal link
          </button>
        </div>
      ) : null}
      {canEdit && adding === "sogni" ? <AddFromSogni existing={loras} busy={busy} onAdd={create} /> : null}
      {canEdit && adding === "fal" ? (
        <AddFalLink
          busy={busy}
          onAdd={async (body, name) => {
            if (await create(body, name)) setAdding(null);
          }}
        />
      ) : null}

      {active.length === 0 ? <p style={muted}>No LoRAs saved yet.{canEdit ? " Use one of the buttons above to add the first." : ""}</p> : null}
      {active.map((lora) => (
        <LoraCard
          key={lora.id}
          lora={lora}
          canEdit={canEdit}
          busy={busy}
          editing={editingId === lora.id}
          confirmingDelete={confirmDeleteId === lora.id}
          onEdit={() => setEditingId(editingId === lora.id ? null : lora.id)}
          onAskDelete={() => setConfirmDeleteId(lora.id)}
          onCancelDelete={() => setConfirmDeleteId(null)}
          onSave={(body) =>
            run(async () => {
              await setupsFetch(`${base}/loras/${lora.id}`, { method: "PATCH", body: JSON.stringify(body) }, "saving the LoRA");
              setEditingId(null);
              return `Saved "${lora.name}". If you changed its safe-for-work mark or prompt words, approved setups that use it went back to draft and need approving again.`;
            })
          }
          onArchive={() =>
            run(async () => {
              await setupsFetch(`${base}/loras/${lora.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) }, "archiving the LoRA");
              return `"${lora.name}" is archived. Setups that use it cannot be used until you swap it for another LoRA.`;
            })
          }
          onRestore={() =>
            run(async () => {
              await setupsFetch(`${base}/loras/${lora.id}`, { method: "PATCH", body: JSON.stringify({ archived: false }) }, "restoring the LoRA");
              return `"${lora.name}" is restored to the library.`;
            })
          }
          onDelete={() =>
            run(async () => {
              await setupsFetch(`${base}/loras/${lora.id}`, { method: "DELETE" }, "deleting the LoRA");
              setConfirmDeleteId(null);
              return `"${lora.name}" is deleted.`;
            })
          }
        />
      ))}

      {archived.length > 0 ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Archived ({archived.length})</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {archived.map((lora) => (
              <LoraCard
                key={lora.id}
                lora={lora}
                canEdit={canEdit}
                busy={busy}
                editing={false}
                confirmingDelete={confirmDeleteId === lora.id}
                onEdit={() => undefined}
                onAskDelete={() => setConfirmDeleteId(lora.id)}
                onCancelDelete={() => setConfirmDeleteId(null)}
                onSave={async () => false}
                onArchive={async () => false}
                onRestore={() =>
                  run(async () => {
                    await setupsFetch(`${base}/loras/${lora.id}`, { method: "PATCH", body: JSON.stringify({ archived: false }) }, "restoring the LoRA");
                    return `"${lora.name}" is restored to the library.`;
                  })
                }
                onDelete={() =>
                  run(async () => {
                    await setupsFetch(`${base}/loras/${lora.id}`, { method: "DELETE" }, "deleting the LoRA");
                    setConfirmDeleteId(null);
                    return `"${lora.name}" is deleted.`;
                  })
                }
              />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function LoraCard(props: {
  lora: MediaLoraRow;
  canEdit: boolean;
  busy: boolean;
  editing: boolean;
  confirmingDelete: boolean;
  onEdit: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
  onArchive: () => Promise<boolean>;
  onRestore: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const { lora, canEdit, busy } = props;
  const recommended = rangeText(lora.recommendedMin, lora.recommendedMax);
  const tag = lora.effectiveContentTag;
  return (
    <div style={card} data-testid={`lora-${lora.id}`}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>{lora.name}</strong>
        <span style={TAG_PILL[tag]} title={TAG_HELP[tag]}>{TAG_NAMES[tag]}</span>
        <span style={muted}>
          {providerName(lora.provider)} · {LORA_SOURCE_NAMES[lora.source]}
        </span>
      </div>
      {lora.source === "url" ? <p style={{ ...muted, wordBreak: "break-all" }}>{shortLink(lora.ref)}</p> : null}
      {lora.notes ? <p style={{ ...muted, color: "inherit", opacity: 0.8 }}>{lora.notes}</p> : null}
      <p style={muted}>
        Starts at strength {strengthText(lora.strengthDefault)}
        {recommended ? ` (works best between ${recommended})` : ""}.
        {lora.triggerWords.length > 0 ? ` Words to put in the prompt: ${lora.triggerWords.join(", ")}.` : ""}
      </p>
      {lora.contentNote ? <div style={warnBox}>{lora.contentNote}</div> : null}
      {tag === "unreviewed" ? <p style={muted}>Setups that use this LoRA count as mature until it is checked.</p> : null}
      {canEdit ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {lora.archivedAt ? (
            <button type="button" style={secondaryBtn} disabled={busy} onClick={() => void props.onRestore()}>Restore</button>
          ) : (
            <>
              <button type="button" style={ghostBtn} disabled={busy} onClick={props.onEdit}>{props.editing ? "Close" : "Edit"}</button>
              <button type="button" style={ghostBtn} disabled={busy} onClick={() => void props.onArchive()}>Archive</button>
            </>
          )}
          {props.confirmingDelete ? (
            <>
              <button type="button" style={dangerBtn} disabled={busy} onClick={() => void props.onDelete()}>Yes, delete "{lora.name}"</button>
              <button type="button" style={ghostBtn} onClick={props.onCancelDelete}>Keep it</button>
            </>
          ) : (
            <button type="button" style={dangerBtn} disabled={busy} onClick={props.onAskDelete}>Delete</button>
          )}
        </div>
      ) : null}
      {canEdit && props.editing ? <EditLora lora={lora} busy={busy} onSave={props.onSave} /> : null}
    </div>
  );
}

function EditLora(props: { lora: MediaLoraRow; busy: boolean; onSave: (body: Record<string, unknown>) => Promise<boolean> }) {
  const { lora } = props;
  const [name, setName] = useState(lora.name);
  const [notes, setNotes] = useState(lora.notes);
  const [words, setWords] = useState(lora.triggerWords.join(", "));
  const [tag, setTag] = useState<ContentTag>(lora.contentTag === "refused" ? "mature" : lora.contentTag);
  const [start, setStart] = useState(String(lora.strengthDefault));
  const [low, setLow] = useState(lora.strengthMin === null ? "" : String(lora.strengthMin));
  const [high, setHigh] = useState(lora.strengthMax === null ? "" : String(lora.strengthMax));
  const [recLow, setRecLow] = useState(lora.recommendedMin === null ? "" : String(lora.recommendedMin));
  const [recHigh, setRecHigh] = useState(lora.recommendedMax === null ? "" : String(lora.recommendedMax));
  const startNumber = numberOrNull(start);
  const valid = name.trim().length > 0 && startNumber !== null;
  return (
    <form
      style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid rgba(128,128,128,0.25)", paddingTop: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void props.onSave({
          name: name.trim(),
          notes: notes.trim(),
          triggerWords: splitWords(words),
          contentTag: tag,
          strengthDefault: startNumber,
          strengthMin: numberOrNull(low),
          strengthMax: numberOrNull(high),
          recommendedMin: numberOrNull(recLow),
          recommendedMax: numberOrNull(recHigh),
        });
      }}
    >
      <label style={field}>
        <span>Name</span>
        <input style={input} aria-label="LoRA name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label style={field}>
        <span>Notes</span>
        <textarea style={{ ...input, minHeight: 56 }} aria-label="LoRA notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <label style={field}>
        <span>Words to put in the prompt (separate with commas)</span>
        <input style={input} aria-label="Prompt words" value={words} onChange={(e) => setWords(e.target.value)} />
      </label>
      <TagSelect label="Is it safe for work?" value={tag} onChange={setTag} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        <label style={field}>
          <span>Starting strength</span>
          <input style={input} aria-label="Starting strength" inputMode="decimal" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label style={field}>
          <span>Lowest strength allowed</span>
          <input style={input} aria-label="Lowest strength allowed" inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} />
        </label>
        <label style={field}>
          <span>Highest strength allowed</span>
          <input style={input} aria-label="Highest strength allowed" inputMode="decimal" value={high} onChange={(e) => setHigh(e.target.value)} />
        </label>
        <label style={field}>
          <span>Works best from</span>
          <input style={input} aria-label="Works best from" inputMode="decimal" value={recLow} onChange={(e) => setRecLow(e.target.value)} />
        </label>
        <label style={field}>
          <span>Works best up to</span>
          <input style={input} aria-label="Works best up to" inputMode="decimal" value={recHigh} onChange={(e) => setRecHigh(e.target.value)} />
        </label>
      </div>
      <p style={muted}>Strength is a multiplier, not a percentage: 0.6 means 60% as strong as the LoRA's full effect at 1.</p>
      <div>
        <button type="submit" style={primaryBtn} disabled={props.busy || !valid}>Save changes</button>
      </div>
    </form>
  );
}

function AddFromSogni(props: { existing: MediaLoraRow[]; busy: boolean; onAdd: (body: Record<string, unknown>, name: string) => Promise<boolean> }) {
  const listLoras = usePluginAction(ACTION_SOGNI_LORAS);
  const [modelId, setModelId] = useState(SOGNI_LORA_MODELS[0]!.id);
  const [rows, setRows] = useState<SogniLoraRow[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [tag, setTag] = useState<ContentTag>("unreviewed");

  const show = async () => {
    setLoading(true);
    setProblem(null);
    try {
      const res = (await listLoras({ modelId })) as { loras?: SogniLoraRow[]; note?: string | null };
      setRows(res.loras ?? []);
      setNote(res.note ?? null);
    } catch (e) {
      setRows(null);
      setProblem(errorText(e));
    } finally {
      setLoading(false);
    }
  };
  const have = new Set(props.existing.filter((l) => l.provider === "sogni").map((l) => l.ref));
  return (
    <div style={card}>
      <strong style={{ fontSize: 13 }}>Add from Sogni's list</strong>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={field}>
          <span>Which Sogni model is it for?</span>
          <select style={input} aria-label="Sogni model" value={modelId} onChange={(e) => { setModelId(e.target.value); setRows(null); }}>
            {SOGNI_LORA_MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
        <button type="button" style={secondaryBtn} disabled={loading} onClick={() => void show()}>
          {loading ? "Loading…" : "Show the LoRAs"}
        </button>
      </div>
      <TagSelect label="Mark the LoRA you add as" value={tag} onChange={setTag} />
      {problem ? <div style={errorBox}>{problem}</div> : null}
      {note ? <p style={muted}>{note}</p> : null}
      {rows && rows.length === 0 ? <p style={muted}>Sogni lists no LoRAs for this model right now.</p> : null}
      {rows?.map((row) => (
        <div key={row.id} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", borderTop: "1px solid rgba(128,128,128,0.2)", paddingTop: 6 }}>
          <div style={{ flex: "1 1 220px" }}>
            <strong style={{ fontSize: 13 }}>{row.name}</strong>
            {row.personal ? <span style={muted}> · yours</span> : null}
            {row.description ? <p style={muted}>{row.description}</p> : null}
            {row.needsFilterOff || row.sexual ? <p style={{ ...muted, color: "#862e9c" }}>Sogni marks this one as mature. It will be added as mature.</p> : null}
          </div>
          {have.has(row.id) ? (
            <span style={muted}>Already in your library</span>
          ) : (
            <button
              type="button"
              style={primaryBtn}
              disabled={props.busy}
              aria-label={`Add ${row.name}`}
              onClick={() =>
                void props.onAdd(
                  {
                    provider: "sogni",
                    source: row.personal ? "personal" : "catalog",
                    ref: row.id,
                    name: row.name,
                    notes: row.description ?? "",
                    compatibleModelIds: (row.modelIds ?? []).slice(0, 100),
                    contentTag: row.needsFilterOff || row.sexual ? "mature" : tag,
                    providerNsfw: row.needsFilterOff === true,
                    providerSexual: row.sexual === true,
                    strengthMin: row.min,
                    strengthMax: row.max,
                    strengthDefault: row.default,
                    recommendedMin: row.recommendedMin ?? null,
                    recommendedMax: row.recommendedMax ?? null,
                  },
                  row.name,
                )
              }
            >
              Add
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function AddFalLink(props: { busy: boolean; onAdd: (body: Record<string, unknown>, name: string) => Promise<void> }) {
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [start, setStart] = useState("0.6");
  const [tag, setTag] = useState<ContentTag>("unreviewed");
  const startNumber = numberOrNull(start);
  const valid = link.trim().length > 0 && name.trim().length > 0 && startNumber !== null;
  return (
    <form
      style={card}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void props.onAdd({ provider: "fal", source: "url", ref: link.trim(), name: name.trim(), contentTag: tag, strengthDefault: startNumber }, name.trim());
      }}
    >
      <strong style={{ fontSize: 13 }}>Add a Fal link</strong>
      <label style={field}>
        <span>Link to the LoRA file</span>
        <input style={input} aria-label="Link to the LoRA file" placeholder="https://huggingface.co/…/lora.safetensors" value={link} onChange={(e) => setLink(e.target.value)} />
        <span style={muted}>A plain https link (Hugging Face or Civitai). Do not use a link that has a key or password in it: agents can see these links.</span>
      </label>
      <label style={field}>
        <span>Name</span>
        <input style={input} aria-label="Name for the LoRA" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label style={field}>
        <span>Starting strength</span>
        <input style={input} aria-label="Starting strength for the new LoRA" inputMode="decimal" value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <TagSelect label="Is it safe for work?" value={tag} onChange={setTag} />
      <div>
        <button type="submit" style={primaryBtn} disabled={props.busy || !valid}>Add to library</button>
      </div>
    </form>
  );
}
