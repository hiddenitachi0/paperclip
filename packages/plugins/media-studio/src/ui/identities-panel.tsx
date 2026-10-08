import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  ACTION_AGE_CHECK_RUN,
  ACTION_AGE_CHECK_STATUS,
  ACTION_EDIT_SEGMENT,
  ACTION_IDENTITIES_ANALYSE,
  ACTION_IDENTITIES_CANDIDATES,
  ACTION_IDENTITIES_CROP,
  ACTION_IDENTITIES_DELETE,
  ACTION_IDENTITIES_LIST,
  ACTION_IDENTITIES_SAVE,
  ACTION_IDENTITIES_USE_CANDIDATE,
  ACTION_IDENTITY_SETTINGS_GET,
  ACTION_IDENTITY_SETTINGS_SAVE,
  ACTION_HIGGSFIELD_SOUL,
  ACTION_IDENTITIES_GENERATION_OPTIONS,
  ACTION_LORA_ATTACH,
  ACTION_LORA_IMPORT_SOGNI,
  ACTION_LORA_PUBLISH,
  ACTION_LORA_RESET,
  ACTION_LORA_STATUS,
  ACTION_LORA_TRAIN,
  ACTION_SOGNI_LORAS,
  ACTION_TRAINED_REMOVE,
  ACTION_TRAINED_STATUS,
  ACTION_TRAINING_SET_ADD,
  ACTION_TRAINING_SET_DOWNLOAD,
  ACTION_TRAINING_SET_GENERATE,
  ACTION_TRAINING_SET_PRESETS,
  ACTION_TRAINING_SET_REMOVE,
  ACTION_TRAINING_SET_SELECT,
  batchEstimateCents,
  callsFor,
  CROP_ROLE_OPTIONS,
  IDENTITY_SHEET_OPTIONS,
  defaultBox,
  fileContentPath,
  formatDollars,
  hostFetchJson,
  listCompanyPictures,
  maskBox,
  moveBox,
  padBox,
  pictureDataUrl,
  resizeBox,
  trainingStatusText,
  uploadPicture,
  visionModelsFirst,
  type Box,
  type CropRole,
} from "./anchor-helpers.js";

// ─── Types (as the worker sends them; see src/identity.ts) ───────────────────

export type IdentityCrop = { role: CropRole; fileId: string; sourceFileId: string | null; box: Box | null };
export type IdentityLora = {
  source: string;
  url: string;
  visibility: "public" | "private";
  baseModel: string;
  triggerWord: string;
  strength: number;
  repo: string | null;
};
export type IdentityTraining = {
  status: "training" | "trained" | "published" | "failed";
  trainedFileIds: string[];
  triggerWord: string;
  steps: number;
  estimatedCostCents: number;
  resultUrl: string | null;
  error: string | null;
};
export type TrainedIdentity = {
  id: string;
  provider: "sogni-lora" | "fal-lora" | "higgsfield-soul";
  ref: string;
  url: string | null;
  variant: string | null;
  triggerWord: string | null;
  strength: number | null;
  status: string;
  createdAt: string;
};
export type LoraPick = { id: string; strength: number };
export type TrainingPicture = {
  fileId: string;
  source: "generated" | "upload";
  service: string | null;
  model: string | null;
  loras: LoraPick[];
  prompt: string | null;
  seed: number | null;
  batchId: string | null;
};
export type TrainingSet = { pictures: TrainingPicture[]; selectedFileIds: string[]; batches: Array<{ id: string; service: string; model: string; count: number; createdAt: string }>; presets: string[] };
export type Identity = {
  id: string;
  name: string;
  nickname: string | null;
  originalFileId: string | null;
  sheet: Record<string, string>;
  crops: IdentityCrop[];
  canonicalFileId: string | null;
  canonicalAsReference: boolean;
  preferredModels: { sogni: string; sogniExtraSlot: string; fal: string | null };
  lora: IdentityLora | null;
  trainedIdentities?: TrainedIdentity[];
  trainingSet?: TrainingSet | null;
  provenance: { model: string | null; seed: number | null; workflowId: string | null; chosenAt: string } | null;
  consent: { likeness: true; adult: true; confirmedBy: string; confirmedAt: string };
  training: IdentityTraining | null;
  updatedAt: string;
};
type ListResponse = {
  identities: Identity[];
  canManage: boolean;
  analysisReady: boolean;
  hfReady: boolean;
  consentText: { likeness: string; adult: string };
  seedExplanation: string;
  training: { steps: number; costCents: number; minPictures: number; maxPictures: number; soulMin: number; soulMax: number; presets: string[] };
  editModels: string[];
  ageCheck?: { explanation: string; costNote: string; model: string | null };
};

export type AgeVerdict = "adult" | "under18" | "unclear";
type AgeRow = { fileId: string; name: string | null; verdict: AgeVerdict | null };

export const AGE_CHECK_EXPLANATION_FALLBACK =
  "Every picture is checked for apparent age before it leaves Paperclip. Pictures that are not clearly of an adult are never sent.";

function ageLabel(verdict: AgeVerdict | null | undefined): string {
  if (verdict === "adult") return "Age checked: adult";
  if (verdict === "under18") return "Refused: may be under 18";
  if (verdict === "unclear") return "Refused: not clearly an adult";
  return "Age not checked yet";
}

type Draft = {
  id: string | null;
  name: string;
  nickname: string;
  originalFileId: string | null;
  sheet: Record<string, string>;
  boxes: Array<{ role: CropRole; box: Box }>;
  crops: IdentityCrop[];
  preferredSogni: string;
  preferredExtra: string;
  preferredFal: string;
  consentLikeness: boolean;
  consentAdult: boolean;
};

const EMPTY: Draft = {
  id: null,
  name: "",
  nickname: "",
  originalFileId: null,
  sheet: {},
  boxes: [],
  crops: [],
  preferredSogni: "krea-identity-edit",
  preferredExtra: "qwen",
  preferredFal: "",
  consentLikeness: false,
  consentAdult: false,
};

export function identityToDraft(identity: Identity): Draft {
  return {
    id: identity.id,
    name: identity.name,
    nickname: identity.nickname ?? "",
    originalFileId: identity.originalFileId,
    sheet: { ...identity.sheet },
    boxes: identity.crops.filter((c) => c.box && c.sourceFileId === identity.originalFileId).map((c) => ({ role: c.role, box: c.box! })),
    crops: identity.crops.map((c) => ({ ...c })),
    preferredSogni: identity.preferredModels.sogni,
    preferredExtra: identity.preferredModels.sogniExtraSlot,
    preferredFal: identity.preferredModels.fal ?? "",
    consentLikeness: true,
    consentAdult: true,
  };
}

export function draftToParams(draft: Draft): Record<string, unknown> {
  return {
    id: draft.id,
    name: draft.name,
    nickname: draft.nickname || null,
    originalFileId: draft.originalFileId,
    sheet: draft.sheet,
    crops: draft.crops,
    preferredModels: { sogni: draft.preferredSogni, sogniExtraSlot: draft.preferredExtra, fal: draft.preferredFal || null },
    ...(draft.id ? {} : { consentLikeness: draft.consentLikeness, consentAdult: draft.consentAdult }),
  };
}

// ─── Styles (a local copy, like edit-tab.tsx) ────────────────────────────────

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 13 };
const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const help: React.CSSProperties = { fontSize: 12, opacity: 0.75 };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const okBox: React.CSSProperties = { background: "#e6fcf5", color: "#087f5b", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const warnBox: React.CSSProperties = { background: "#fff9db", color: "#8f5a00", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const dangerBtn: React.CSSProperties = { ...baseBtn, background: "#f03e3e", color: "#fff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "inherit", borderColor: "#ced4da" };
const thumb: React.CSSProperties = { width: 96, height: 96, objectFit: "cover", borderRadius: 6, display: "block", border: "1px solid rgba(128,128,128,0.35)" };
const row: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── Crop editor ─────────────────────────────────────────────────────────────

/**
 * The picture with one box per crop. Drag a box to move it; drag its corner
 * to resize it. The same picture can give several crops (face, body, outfit).
 */
export function CropEditor(props: {
  src: string;
  boxes: Array<{ role: CropRole; box: Box }>;
  onChange: (boxes: Array<{ role: CropRole; box: Box }>) => void;
  disabled?: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; mode: "move" | "resize"; startX: number; startY: number; start: Box } | null>(null);
  const boxesRef = useRef(props.boxes);
  boxesRef.current = props.boxes;

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      const el = frame.current;
      if (!d || !el) return;
      const rect = el.getBoundingClientRect();
      const dx = (e.clientX - d.startX) / Math.max(1, rect.width);
      const dy = (e.clientY - d.startY) / Math.max(1, rect.height);
      const next = boxesRef.current.map((b, i) => (i === d.index ? { ...b, box: d.mode === "move" ? moveBox(d.start, dx, dy) : resizeBox(d.start, dx, dy) } : b));
      props.onChange(next);
    };
    const onUp = () => {
      drag.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [props]);

  const start = (index: number, mode: "move" | "resize") => (e: React.PointerEvent) => {
    if (props.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { index, mode, startX: e.clientX, startY: e.clientY, start: props.boxes[index]!.box };
  };

  return (
    <div ref={frame} style={{ position: "relative", display: "inline-block", maxWidth: "100%", userSelect: "none", touchAction: "none" }} aria-label="Crop editor">
      <img src={props.src} alt="The person's picture" style={{ display: "block", maxWidth: "100%", maxHeight: 520 }} draggable={false} />
      {props.boxes.map((b, i) => {
        const color = CROP_ROLE_OPTIONS.find((o) => o.value === b.role)?.color ?? "#333";
        return (
          <div
            key={`${b.role}-${i}`}
            role="group"
            aria-label={`${b.role} box`}
            onPointerDown={start(i, "move")}
            style={{
              position: "absolute",
              left: `${b.box.x * 100}%`,
              top: `${b.box.y * 100}%`,
              width: `${b.box.w * 100}%`,
              height: `${b.box.h * 100}%`,
              border: `2px solid ${color}`,
              background: `${color}22`,
              cursor: props.disabled ? "default" : "move",
              boxSizing: "border-box",
            }}
          >
            <span style={{ position: "absolute", left: 0, top: 0, background: color, color: "#fff", fontSize: 11, padding: "1px 4px" }}>
              {CROP_ROLE_OPTIONS.find((o) => o.value === b.role)?.label ?? b.role}
            </span>
            <span
              aria-label={`Resize ${b.role} box`}
              onPointerDown={start(i, "resize")}
              style={{ position: "absolute", right: -6, bottom: -6, width: 12, height: 12, background: color, borderRadius: 2, cursor: "nwse-resize" }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ─── Picture picker ──────────────────────────────────────────────────────────

function PicturePicker(props: { companyId: string; onPick: (fileId: string) => void; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pictures, setPictures] = useState<Array<{ fileId: string; title: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open || pictures) return;
    listCompanyPictures(props.companyId).then(setPictures).catch((e) => setError(errText(e)));
  }, [open, pictures, props.companyId]);
  const onUpload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      props.onPick(await uploadPicture(props.companyId, file, file.name));
      setOpen(false);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={row}>
        <button type="button" style={secondaryBtn} disabled={props.disabled || busy} onClick={() => fileInput.current?.click()}>
          {busy ? "Uploading…" : props.label ?? "Upload a picture"}
        </button>
        <button type="button" style={ghostBtn} disabled={props.disabled} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide Files" : "Pick from Files"}
        </button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={(e) => void onUpload(e.target.files?.[0])} />
      </div>
      {error ? <div style={errorBox}>{error}</div> : null}
      {open ? (
        <div style={{ ...row, maxHeight: 240, overflowY: "auto" }}>
          {pictures === null ? <span style={help}>Loading…</span> : pictures.length === 0 ? <span style={help}>No pictures in Files yet.</span> : null}
          {(pictures ?? []).map((p) => (
            <button key={p.fileId} type="button" title={p.title} style={{ padding: 0, border: "none", background: "none", cursor: "pointer" }} onClick={() => { props.onPick(p.fileId); setOpen(false); }}>
              <img src={fileContentPath(p.fileId)} alt={p.title} style={{ ...thumb, width: 72, height: 72 }} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ─── Settings ────────────────────────────────────────────────────────────────

type SavedModel = { id: string; name: string; provider: string; model: string; baseUrl: string | null; specs?: { vision?: boolean | null } | null; archivedAt?: string | null };
type Secret = { id: string; name: string };
type AnalysisSetting = { entryId: string; label: string | null; keySecretId: string | null };
type Settings = { analysis: AnalysisSetting | null; hfTokenSecretId: string | null; hfNamespace: string | null };

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  huggingface: "Hugging Face",
  local: "own model server",
};

export function IdentitySettingsPanel({ companyId, onSaved }: { companyId: string; onSaved?: () => void }) {
  const getSettings = usePluginAction(ACTION_IDENTITY_SETTINGS_GET);
  const saveSettings = usePluginAction(ACTION_IDENTITY_SETTINGS_SAVE);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [models, setModels] = useState<SavedModel[]>([]);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    getSettings({})
      .then((r) => {
        const res = r as { settings: Settings; canManage: boolean };
        setSettings(res.settings);
        setCanManage(res.canManage);
      })
      .catch((e) => setError(errText(e)));
    hostFetchJson<SavedModel[]>(`/api/companies/${companyId}/model-directory`).then((m) => setModels(visionModelsFirst(m))).catch(() => setModels([]));
    hostFetchJson<Secret[]>(`/api/companies/${companyId}/secrets`).then(setSecrets).catch(() => setSecrets([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);
  if (!settings) return error ? <div style={errorBox}>{error}</div> : <div style={help}>Loading settings…</div>;
  const a = settings.analysis;
  const picked = a ? models.find((m) => m.id === a.entryId) ?? null : null;
  const setA = (next: AnalysisSetting | null) => setSettings({ ...settings, analysis: next });
  const pickEntry = (id: string) => {
    const m = models.find((x) => x.id === id);
    setA(m ? { entryId: m.id, label: m.name, keySecretId: a?.keySecretId ?? null } : null);
  };
  const onSave = async () => {
    setError(null);
    setSaved(false);
    try {
      const res = (await saveSettings({ analysis: a, hfTokenSecretId: settings.hfTokenSecretId, hfNamespace: settings.hfNamespace })) as { settings: Settings };
      setSettings(res.settings);
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setError(errText(e));
    }
  };
  const disabled = !canManage;
  return (
    <div style={card} aria-label="Identity settings">
      <strong>Identity settings</strong>
      <div style={help}>
        For this company only. {canManage ? "" : "Only an owner or admin can change these."}
      </div>
      <div style={field}>
        <span>Analysis model (must be able to see pictures)</span>
        <span style={help}>
          "Analyse picture" sends the uploaded picture to this model. It describes stable physical traits and suggests crop boxes; it never
          says who the person is. Pick one of the company's saved models (Settings &gt; Models). Paperclip's server makes the call, so a
          model on the company's own model server (for example Ollama on your own computer) works too, the same way it does for quick agents.
        </span>
        <select style={input} disabled={disabled} value={a?.entryId ?? ""} onChange={(e) => pickEntry(e.target.value)} aria-label="Analysis model">
          <option value="">{models.length === 0 ? "No saved models yet: add one in Settings > Models" : "Pick a saved model…"}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.model}, {PROVIDER_NAMES[m.provider] ?? m.provider}){m.specs?.vision === true ? ", can see pictures" : ""}
            </option>
          ))}
          {a && !picked && models.length > 0 ? <option value={a.entryId}>{a.label ?? "A saved model that no longer exists"}</option> : null}
        </select>
        {a && !picked && models.length > 0 ? (
          <span style={help}>The saved model picked here is gone from Settings &gt; Models. Pick another one.</span>
        ) : null}
        <label style={field}>
          <span>Key for the analysis model</span>
          <select style={input} disabled={disabled || !a} value={a?.keySecretId ?? ""} onChange={(e) => a && setA({ ...a, keySecretId: e.target.value || null })}>
            <option value="">{picked?.provider === "local" ? "No key (own model server)" : picked?.provider === "anthropic" ? "No key (use Paperclip's own Claude key, if the instance has one)" : "No key"}</option>
            {secrets.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <span style={help}>
            A company secret (Company settings &gt; Secrets) with the key for the model's service. A model on your own model server usually
            needs none. It is read on the server for each analysis and never shown here. Each analysis is added to the company's costs.
          </span>
        </label>
      </div>
      <label style={field}>
        <span>Hugging Face token (for publishing LoRAs)</span>
        <select style={input} disabled={disabled} value={settings.hfTokenSecretId ?? ""} onChange={(e) => setSettings({ ...settings, hfTokenSecretId: e.target.value || null })}>
          <option value="">None</option>
          {secrets.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <span style={help}>Only needed to publish a trained LoRA. The token needs write access. Published LoRAs are public (Sogni can only import public files).</span>
      </label>
      <label style={field}>
        <span>Hugging Face account or organisation (optional)</span>
        <input style={input} disabled={disabled} placeholder="Empty: the token's own account" value={settings.hfNamespace ?? ""} onChange={(e) => setSettings({ ...settings, hfNamespace: e.target.value || null })} />
      </label>
      {error ? <div style={errorBox}>{error}</div> : null}
      {saved ? <div style={okBox}>Saved.</div> : null}
      {canManage ? (
        <div>
          <button type="button" style={primaryBtn} onClick={() => void onSave()}>Save settings</button>
        </div>
      ) : null}
    </div>
  );
}

// ─── Generate with (service, model, LoRAs) ───────────────────────────────────

type Service = "sogni" | "fal" | "higgsfield";
export type GenerationOptions = {
  services: Record<Service, boolean>;
  models: Record<Service, string[]>;
  priceCents: Record<string, number | null>;
  priceNotes: Record<Service, string>;
  reservedPerCallCents: number;
  perCall: Record<Service, number>;
  higgsfieldNote: string;
};
export type GenerateChoice = { service: Service; model: string; loras: LoraPick[] };
const SERVICE_NAMES: Record<Service, string> = { sogni: "Sogni", fal: "Fal.ai", higgsfield: "Higgsfield" };

/** The starting choice: the identity's preferred Sogni model when Sogni has a key, else the first service that has one. */
export function defaultChoice(identity: Identity, options: GenerationOptions | null): GenerateChoice {
  const service: Service = !options || options.services.sogni ? "sogni" : options.services.fal ? "fal" : options.services.higgsfield ? "higgsfield" : "sogni";
  const model = service === "sogni" ? identity.preferredModels.sogni : service === "fal" ? identity.preferredModels.fal ?? options?.models.fal[0] ?? "" : "soul";
  return { service, model, loras: [] };
}

/** Plain-words estimate for N pictures with this choice. */
export function estimateText(options: GenerationOptions, choice: GenerateChoice, pictures: number): string {
  const calls = callsFor(pictures, options.perCall[choice.service]);
  const reserved = formatDollars(calls * options.reservedPerCallCents);
  const cents = batchEstimateCents(options.priceCents[choice.model], pictures);
  const price = cents === null ? options.priceNotes[choice.service] : `About ${formatDollars(cents)} at ${SERVICE_NAMES[choice.service]} (${options.priceNotes[choice.service]})`;
  return `${pictures} pictures in ${calls} ${calls === 1 ? "call" : "calls"}. ${price} Media Studio reserves ${reserved} against its spending limit.`;
}

type SogniLoraRow = { id: string; name: string; min: number; max: number; default: number; personal: boolean };

export function GenerateWith(props: { options: GenerationOptions; value: GenerateChoice; onChange: (c: GenerateChoice) => void; pictures: number; disabled?: boolean }) {
  const { options, value } = props;
  const listLoras = usePluginAction(ACTION_SOGNI_LORAS);
  const [loras, setLoras] = useState<SogniLoraRow[] | null>(null);
  const [checks, setChecks] = useState<Array<{ id: string; fit: string; name: string }>>([]);
  useEffect(() => {
    if (value.service !== "sogni" || !value.model) {
      setLoras(null);
      return;
    }
    let stop = false;
    Promise.resolve()
      .then(() => listLoras({ modelId: value.model, picked: value.loras.map((l) => ({ id: l.id })) }))
      .then((r) => {
        if (stop) return;
        const res = (r ?? {}) as { loras?: SogniLoraRow[]; checks?: Array<{ id: string; fit: string; name: string }> };
        setLoras((res.loras ?? []).filter((l) => !l.personal));
        setChecks(res.checks ?? []);
      })
      .catch(() => !stop && setLoras([]));
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.service, value.model]);
  const services = (Object.keys(SERVICE_NAMES) as Service[]).filter((s) => options.services[s]);
  const misfits = checks.filter((c) => c.fit !== "fits" && value.loras.some((l) => l.id === c.id));
  return (
    <div style={{ ...card, gap: 6 }} aria-label="Generate with">
      <strong>Generate with</strong>
      {services.length === 0 ? <div style={errorBox}>No picture service has a key yet. The company's owner or an admin adds them in Media Studio's Settings tab.</div> : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
        <label style={field}>
          <span>Picture service</span>
          <select
            style={input}
            disabled={props.disabled}
            value={value.service}
            onChange={(e) => {
              const service = e.target.value as Service;
              props.onChange({ service, model: options.models[service][0] ?? "", loras: [] });
            }}
          >
            {services.map((s) => (
              <option key={s} value={s}>{SERVICE_NAMES[s]}</option>
            ))}
          </select>
        </label>
        <label style={field}>
          <span>Model</span>
          <select style={input} disabled={props.disabled} value={value.model} onChange={(e) => props.onChange({ ...value, model: e.target.value, loras: value.service === "sogni" ? value.loras : [] })}>
            {options.models[value.service].map((m, i) => (
              <option key={m} value={m}>{m}{i === 0 ? " (keeps faces best)" : ""}</option>
            ))}
          </select>
        </label>
      </div>
      {value.service === "higgsfield" ? <div style={warnBox}>{options.higgsfieldNote}</div> : null}
      {value.service === "sogni" ? (
        <div style={field}>
          <span>LoRAs (optional)</span>
          {loras === null ? <span style={help}>Loading LoRAs…</span> : loras.length === 0 ? <span style={help}>Sogni lists no public LoRAs for this model.</span> : null}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 180, overflowY: "auto" }}>
            {(loras ?? []).map((l) => {
              const picked = value.loras.find((p) => p.id === l.id);
              return (
                <label key={l.id} style={{ ...row, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    disabled={props.disabled}
                    checked={Boolean(picked)}
                    onChange={(e) => props.onChange({ ...value, loras: e.target.checked ? [...value.loras, { id: l.id, strength: l.default }] : value.loras.filter((p) => p.id !== l.id) })}
                  />
                  {l.name}
                  {picked ? (
                    <input
                      type="number"
                      style={{ ...input, width: 80, padding: 4 }}
                      min={l.min}
                      max={l.max}
                      step={0.05}
                      value={picked.strength}
                      onChange={(e) => props.onChange({ ...value, loras: value.loras.map((p) => (p.id === l.id ? { ...p, strength: Number(e.target.value) } : p)) })}
                      aria-label={`Strength of ${l.name}`}
                    />
                  ) : null}
                </label>
              );
            })}
          </div>
          {misfits.length > 0 ? <div style={warnBox}>Not made for this model: {misfits.map((m) => m.name).join(", ")}. Remove them or pick another model.</div> : null}
          <span style={help}>Your own Sogni LoRAs are not offered here: Sogni only runs them with its content filter off.</span>
        </div>
      ) : (
        <span style={help}>{SERVICE_NAMES[value.service]} takes no LoRAs here.</span>
      )}
      {services.includes(value.service) ? <div style={help}>{estimateText(options, value, props.pictures)}</div> : null}
    </div>
  );
}

function useGenerationOptions(): GenerationOptions | null {
  const load = usePluginAction(ACTION_IDENTITIES_GENERATION_OPTIONS);
  const [options, setOptions] = useState<GenerationOptions | null>(null);
  useEffect(() => {
    Promise.resolve()
      .then(() => load({}))
      .then((r) => setOptions(r && typeof r === "object" && "services" in r && "models" in r ? (r as GenerationOptions) : null))
      .catch(() => setOptions(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return options;
}

// ─── Candidates ──────────────────────────────────────────────────────────────

type Candidate = { imageDataUrl: string; kind: string; model: string; service: string; workflowId: string | null; seed: number | null };

function CandidatesSection({ identity, companyId, seedExplanation, onChanged }: { identity: Identity; companyId: string; seedExplanation: string; onChanged: (i: Identity) => void }) {
  const makeCandidates = usePluginAction(ACTION_IDENTITIES_CANDIDATES);
  const useCandidate = usePluginAction(ACTION_IDENTITIES_USE_CANDIDATE);
  const options = useGenerationOptions();
  const [choice, setChoice] = useState<GenerateChoice | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asReference, setAsReference] = useState(identity.canonicalAsReference);
  const current = choice ?? defaultChoice(identity, options);

  const make = async () => {
    setBusy("make");
    setError(null);
    setCandidates([]);
    try {
      const out: Candidate[] = [];
      for (const kind of ["portrait", "full-body"]) {
        const res = (await makeCandidates({ identityId: identity.id, kind, ...current })) as { candidates: Candidate[]; prompt: string };
        out.push(...res.candidates.slice(0, 2));
        setCandidates([...out]);
        setPrompt(res.prompt);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const choose = async (c: Candidate, index: number) => {
    setBusy(`use-${index}`);
    setError(null);
    try {
      const fileId = await uploadPicture(companyId, c.imageDataUrl, `${identity.name.replace(/[^A-Za-z0-9-]+/g, "-")}-${c.kind}.png`);
      const res = (await useCandidate({ identityId: identity.id, fileId, model: c.model, workflowId: c.workflowId, prompt, addAsReference: asReference })) as { identity: Identity };
      onChanged(res.identity);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div style={card} aria-label="Candidates">
      <strong>Canonical picture</strong>
      <div style={help}>
        Make 4 candidates (2 front portraits and 2 full-body pictures on a plain background) from the crops, and pick the one that looks most like
        the person. It is kept as the identity's main picture. {seedExplanation}
      </div>
      {identity.canonicalFileId ? (
        <div style={row}>
          <img src={fileContentPath(identity.canonicalFileId)} alt="Chosen picture" style={thumb} />
          <div style={help}>
            Chosen{identity.provenance?.model ? ` (made with ${identity.provenance.model}` : ""}
            {identity.provenance?.model ? `; for re-rendering only: seed ${identity.provenance.seed ?? "none (picture edits take no seed)"})` : ""}.
          </div>
        </div>
      ) : null}
      {options ? <GenerateWith options={options} value={current} onChange={setChoice} pictures={4} disabled={busy !== null} /> : null}
      <label style={{ ...row, fontSize: 13 }}>
        <input type="checkbox" checked={asReference} onChange={(e) => setAsReference(e.target.checked)} /> Also send the chosen picture as an extra face picture when the model has room
      </label>
      <div style={row}>
        <button type="button" style={primaryBtn} disabled={busy !== null} onClick={() => void make()}>
          {busy === "make" ? "Making…" : candidates.length > 0 ? "Re-roll (4 new ones)" : "Make 4 candidates"}
        </button>
      </div>
      {error ? <div style={errorBox}>{error}</div> : null}
      <div style={row}>
        {candidates.map((c, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
            <img src={c.imageDataUrl} alt={`Candidate ${i + 1}`} style={{ ...thumb, width: 160, height: 200 }} />
            <button type="button" style={secondaryBtn} disabled={busy !== null} onClick={() => void choose(c, i)}>
              {busy === `use-${i}` ? "Saving…" : "Use this one"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Training set and "Train with" ───────────────────────────────────────────

const PROVIDER_LABEL: Record<TrainedIdentity["provider"], string> = { "sogni-lora": "Sogni LoRA", "fal-lora": "LoRA file (Fal)", "higgsfield-soul": "Higgsfield Soul ID" };

function provenanceText(p: TrainingPicture): string {
  if (p.source === "upload") return "Own photo";
  const loras = p.loras.length > 0 ? `, LoRAs ${p.loras.map((l) => `${l.id} at ${l.strength}`).join(", ")}` : "";
  const seed = p.seed !== null ? `, seed ${p.seed}` : "";
  return `${p.service ?? "?"} ${p.model ?? ""}${loras}${seed}`;
}

function downloadBase64(filename: string, contentType: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Actions that send pictures out (their errors show under "Train with"). */
const SENDING_ACTIONS = new Set(["ages", "train", "status", "publish", "import", "attach", "reset", "soul", "download"]);

function TrainingSection(props: { identity: Identity; companyId: string; info: ListResponse; onChanged: (i: Identity) => void }) {
  const { identity, companyId, info } = props;
  const generate = usePluginAction(ACTION_TRAINING_SET_GENERATE);
  const add = usePluginAction(ACTION_TRAINING_SET_ADD);
  const select = usePluginAction(ACTION_TRAINING_SET_SELECT);
  const removePictures = usePluginAction(ACTION_TRAINING_SET_REMOVE);
  const savePresets = usePluginAction(ACTION_TRAINING_SET_PRESETS);
  const download = usePluginAction(ACTION_TRAINING_SET_DOWNLOAD);
  const train = usePluginAction(ACTION_LORA_TRAIN);
  const status = usePluginAction(ACTION_LORA_STATUS);
  const publish = usePluginAction(ACTION_LORA_PUBLISH);
  const importSogni = usePluginAction(ACTION_LORA_IMPORT_SOGNI);
  const attach = usePluginAction(ACTION_LORA_ATTACH);
  const reset = usePluginAction(ACTION_LORA_RESET);
  const soul = usePluginAction(ACTION_HIGGSFIELD_SOUL);
  const trainedStatus = usePluginAction(ACTION_TRAINED_STATUS);
  const trainedRemove = usePluginAction(ACTION_TRAINED_REMOVE);
  const ageStatus = usePluginAction(ACTION_AGE_CHECK_STATUS);
  const ageRun = usePluginAction(ACTION_AGE_CHECK_RUN);
  const options = useGenerationOptions();
  const set: TrainingSet = identity.trainingSet ?? { pictures: [], selectedFileIds: [], batches: [], presets: info.training.presets };
  const [choice, setChoice] = useState<GenerateChoice | null>(null);
  const [presetsText, setPresetsText] = useState(set.presets.join("\n"));
  const [batchSize, setBatchSize] = useState(24);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [made, setMade] = useState(0);
  const [trigger, setTrigger] = useState(identity.training?.triggerWord || `${identity.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}_person`.slice(0, 30));
  const [costOk, setCostOk] = useState(false);
  const [repo, setRepo] = useState(`${identity.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-lora`);
  const [publicOk, setPublicOk] = useState(false);
  const [manualId, setManualId] = useState("");
  const [variant, setVariant] = useState<"soul-2" | "soul-cinematic">("soul-2");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [ages, setAges] = useState<Record<string, AgeVerdict | null>>({});
  const [ageProgress, setAgeProgress] = useState<string | null>(null);
  const ownPhotos = useRef<HTMLInputElement>(null);
  const training = identity.training;
  const trained = identity.trainedIdentities ?? [];
  const selected = new Set(set.selectedFileIds);
  const current = choice ?? defaultChoice(identity, options);
  const presets = presetsText.split("\n").map((p) => p.trim()).filter(Boolean);
  const ageText = info.ageCheck?.explanation ?? AGE_CHECK_EXPLANATION_FALLBACK;
  const pictureKey = set.pictures.map((p) => p.fileId).join(",");

  const noteAges = (rows: AgeRow[] | undefined) => {
    if (!rows || rows.length === 0) return;
    setAges((prev) => ({ ...prev, ...Object.fromEntries(rows.map((r) => [r.fileId, r.verdict])) }));
  };

  // What is already known about each picture (free: no model is called).
  useEffect(() => {
    if (set.pictures.length === 0) return;
    let stop = false;
    void (async () => {
      try {
        const res = (await ageStatus({ fileIds: set.pictures.map((p) => p.fileId) })) as { pictures?: AgeRow[] } | undefined;
        if (!stop) noteAges(res?.pictures);
      } catch {
        // Shown again when an action checks the pictures.
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pictureKey]);

  /**
   * Every picture must be clearly of an adult before it leaves Paperclip.
   * Pictures not checked yet are checked here one at a time (one analysis
   * call each), with progress; the server checks again before sending.
   */
  const ensureAdults = async (fileIds: string[]) => {
    const refusedText = (rows: AgeRow[]) =>
      `Nothing was sent. ${rows.length === 1 ? "This picture is" : "These pictures are"} not clearly of an adult: ${rows
        .map((r) => `${r.name ?? `picture ${fileIds.indexOf(r.fileId) + 1}`} (${r.verdict === "under18" ? "may be under 18" : "not clearly an adult"})`)
        .join(", ")}. Untick or remove ${rows.length === 1 ? "it" : "them"}. ${ageText}`;
    const status = (await ageStatus({ fileIds })) as { pictures?: AgeRow[] } | undefined;
    const rows = status?.pictures ?? [];
    noteAges(rows);
    const refused = rows.filter((r) => r.verdict === "under18" || r.verdict === "unclear");
    if (refused.length > 0) throw new Error(refusedText(refused));
    const missing = fileIds.filter((id) => rows.find((r) => r.fileId === id)?.verdict !== "adult");
    try {
      for (const [i, id] of missing.entries()) {
        setAgeProgress(`Checking apparent age: ${i + 1} of ${missing.length} (one analysis call per picture not checked before)…`);
        const res = (await ageRun({ fileIds: [id] })) as { pictures?: AgeRow[] } | undefined;
        noteAges(res?.pictures);
        const row = res?.pictures?.find((r) => r.fileId === id);
        if (!row || row.verdict !== "adult") throw new Error(refusedText([row ?? { fileId: id, name: null, verdict: "unclear" }]));
      }
    } finally {
      setAgeProgress(null);
    }
  };

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    setErrorKey(key);
    try {
      const res = (await fn()) as { identity?: Identity; progress?: string | null } | undefined;
      if (res?.identity) props.onChanged(res.identity);
      if (res && "progress" in res) setProgress(res.progress ?? null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (training?.status !== "training") return;
    let stop = false;
    const tick = async () => {
      try {
        const res = (await status({ identityId: identity.id })) as { identity: Identity; progress: string | null };
        if (stop) return;
        setProgress(res.progress);
        if (res.identity.training?.status !== "training") props.onChanged(res.identity);
      } catch {
        // The next check may work.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 20_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [training?.status, identity.id]);

  const makeBatch = () =>
    run("batch", async () => {
      if (presets.length === 0) throw new Error("Add at least one variation.");
      const perCall = options?.perCall[current.service] ?? 2;
      const uploaded: Array<{ fileId: string; provenance: unknown }> = [];
      const used: string[] = [];
      setMade(0);
      for (let i = 0; uploaded.length < batchSize; i += 1) {
        const prompt = presets[i % presets.length]!;
        const count = Math.min(perCall, batchSize - uploaded.length);
        const res = (await generate({ identityId: identity.id, ...current, prompt, count })) as { pictures: Array<{ imageDataUrl: string } & Record<string, unknown>> };
        used.push(prompt);
        for (const [n, p] of res.pictures.entries()) {
          if (uploaded.length >= batchSize) break;
          const fileId = await uploadPicture(companyId, p.imageDataUrl, `${repo}-set-${uploaded.length + 1}-${n + 1}.png`);
          const { imageDataUrl: _drop, ...provenance } = p;
          uploaded.push({ fileId, provenance });
          setMade(uploaded.length);
        }
        if (i > batchSize * 2) break; // a service that keeps sending nothing
      }
      return add({ identityId: identity.id, pictures: uploaded, batch: { ...current, prompts: used } });
    });

  const addOwn = (files: FileList | null) =>
    run("own", async () => {
      if (!files || files.length === 0) return undefined;
      const pictures = [];
      for (const f of Array.from(files).slice(0, 40)) pictures.push({ fileId: await uploadPicture(companyId, f, f.name), provenance: { source: "upload" } });
      return add({ identityId: identity.id, pictures });
    });

  const toggle = (fileId: string) => {
    const next = new Set(selected);
    if (next.has(fileId)) next.delete(fileId);
    else next.add(fileId);
    void run("select", () => select({ identityId: identity.id, fileIds: [...next] }));
  };

  if (!info.canManage) {
    return (
      <div style={card}>
        <strong>Trained identities</strong>
        <div style={help}>{trained.length > 0 ? trained.map((t) => `${PROVIDER_LABEL[t.provider]} (${t.status})`).join(", ") : "None yet. An owner or admin can make a training set and train one."}</div>
      </div>
    );
  }

  return (
    <>
      <div style={card} aria-label="Training set">
        <strong>Training set</strong>
        <div style={help}>
          Pictures to teach a service this person: generate batches from the chosen picture with any service (each picture remembers how it was made),
          add your own photos, then tick the 12 to 25 that truly look like the person. The same set can train a Sogni/Fal LoRA, a Higgsfield Soul ID,
          or be downloaded.
        </div>
        {options ? <GenerateWith options={options} value={current} onChange={setChoice} pictures={batchSize} disabled={busy !== null} /> : null}
        <label style={field}>
          <span>Variations (one per line; used in turn)</span>
          <textarea style={{ ...input, minHeight: 110 }} value={presetsText} onChange={(e) => setPresetsText(e.target.value)} disabled={busy !== null} />
          <span style={help}>Angles, outfits, lighting, expressions, places. Each line becomes one request.</span>
        </label>
        <div style={row}>
          <button type="button" style={ghostBtn} disabled={busy !== null} onClick={() => void run("presets", () => savePresets({ identityId: identity.id, presets }))}>
            Save variations
          </button>
          <label style={{ ...row, fontSize: 13 }}>
            Batch size
            <input type="number" min={1} max={40} style={{ ...input, width: 70 }} value={batchSize} onChange={(e) => setBatchSize(Math.min(40, Math.max(1, Number(e.target.value) || 1)))} />
          </label>
          <button type="button" style={primaryBtn} disabled={busy !== null || !identity.crops.some((c) => c.role === "face")} onClick={() => void makeBatch()}>
            {busy === "batch" ? `Making… (${made} of ${batchSize})` : "Generate batch"}
          </button>
          <button type="button" style={secondaryBtn} disabled={busy !== null} onClick={() => ownPhotos.current?.click()}>
            {busy === "own" ? "Adding…" : "Add own photos"}
          </button>
          <input ref={ownPhotos} type="file" multiple accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={(e) => void addOwn(e.target.files)} />
        </div>
        {error && !SENDING_ACTIONS.has(errorKey ?? "") ? <div style={errorBox}>{error}</div> : null}
        {set.pictures.length > 0 ? (
          <>
            <div style={help}>
              Ticked: {selected.size} of {set.pictures.length}. {set.batches.length} {set.batches.length === 1 ? "batch" : "batches"} so far.
            </div>
            <div style={row}>
              {set.pictures.map((p) => (
                <label key={p.fileId} style={{ position: "relative", cursor: "pointer" }} title={provenanceText(p)}>
                  <img src={fileContentPath(p.fileId)} alt="Training picture" style={{ ...thumb, outline: selected.has(p.fileId) ? "3px solid #2f9e44" : "none" }} />
                  <input type="checkbox" checked={selected.has(p.fileId)} disabled={busy !== null} onChange={() => toggle(p.fileId)} style={{ position: "absolute", top: 4, left: 4 }} aria-label="Use for training" />
                  <span style={{ ...help, display: "block", maxWidth: 96, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{provenanceText(p)}</span>
                  <span
                    style={{ ...help, display: "block", maxWidth: 96, color: ages[p.fileId] === "adult" ? "#2f9e44" : ages[p.fileId] ? "#a61e4d" : undefined }}
                    data-age={ages[p.fileId] ?? "unchecked"}
                  >
                    {ageLabel(ages[p.fileId])}
                  </span>
                </label>
              ))}
            </div>
            <div>
              <button
                type="button"
                style={ghostBtn}
                disabled={busy !== null}
                onClick={() => void run("prune", () => removePictures({ identityId: identity.id, fileIds: set.pictures.filter((p) => !selected.has(p.fileId)).map((p) => p.fileId) }))}
              >
                Remove the unticked pictures
              </button>
            </div>
          </>
        ) : null}
      </div>

      <div style={card} aria-label="Train with">
        <strong>Train with</strong>
        <div style={warnBox} aria-label="Age check">
          {ageText} {info.ageCheck?.costNote ?? "Pictures not checked before take one analysis call each."}
          {info.ageCheck?.model ? ` Checked with ${info.ageCheck.model}.` : ""}
        </div>
        {ageProgress ? <div style={help} role="status">{ageProgress}</div> : null}
        <div>
          <button
            type="button"
            style={ghostBtn}
            disabled={busy !== null || selected.size === 0}
            onClick={() =>
              void run("ages", async () => {
                await ensureAdults(set.selectedFileIds);
                return undefined;
              })
            }
          >
            {busy === "ages" ? "Checking…" : `Check the age of the ${selected.size} ticked pictures`}
          </button>
        </div>
        {error && SENDING_ACTIONS.has(errorKey ?? "") ? <div style={errorBox}>{error}</div> : null}
        <label style={field}>
          <span>Trigger word</span>
          <input style={input} value={trigger} onChange={(e) => setTrigger(e.target.value)} />
          <span style={help}>A made-up word that means "this person" to a LoRA (also written into the downloaded captions).</span>
        </label>

        <div style={{ ...card, gap: 6 }} aria-label="Fal LoRA">
          <strong>A. LoRA (Fal.ai, for Sogni and Fal)</strong>
          <div style={help}>
            Trains a Krea 2 LoRA on Fal.ai from the ticked pictures (at least {info.training.minPictures}), then publishes it to Hugging Face and imports it into Sogni.
          </div>
          <div style={warnBox}>{trainingStatusText(training?.status, progress)}</div>
          {training?.error ? <div style={errorBox}>{training.error}</div> : null}
          {training?.status !== "training" ? (
            <>
              <label style={{ ...row, fontSize: 13 }}>
                <input type="checkbox" checked={costOk} onChange={(e) => setCostOk(e.target.checked)} /> Training costs about {formatDollars(info.training.costCents)} on Fal.ai ({info.training.steps} steps
                at $0.003 a step). Start it.
              </label>
              <div>
                <button
                  type="button"
                  style={primaryBtn}
                  disabled={busy !== null || !costOk || selected.size < info.training.minPictures}
                  onClick={() =>
                    void run("train", async () => {
                      await ensureAdults(set.selectedFileIds);
                      return train({ identityId: identity.id, triggerWord: trigger, confirmCostCents: info.training.costCents });
                    })
                  }
                >
                  {busy === "train" ? "Starting…" : "Train the LoRA"}
                </button>
              </div>
            </>
          ) : (
            <div>
              <button type="button" style={ghostBtn} disabled={busy !== null} onClick={() => void run("status", () => status({ identityId: identity.id }))}>Check now</button>
            </div>
          )}
          {training?.status === "trained" ? (
            <>
              <div style={warnBox}>
                Publishing makes the LoRA PUBLIC on Hugging Face: anyone can download it. Sogni can only import public files today. Only publish a LoRA
                of a person who agreed to this (or a fictional/AI-made person).
              </div>
              <label style={field}>
                <span>Repository name</span>
                <input style={input} value={repo} onChange={(e) => setRepo(e.target.value)} />
              </label>
              <label style={{ ...row, fontSize: 13 }}>
                <input type="checkbox" checked={publicOk} onChange={(e) => setPublicOk(e.target.checked)} /> I understand anyone can download it.
              </label>
              <div style={row}>
                <button type="button" style={primaryBtn} disabled={busy !== null || !publicOk || !info.hfReady} onClick={() =>
                    void run("publish", async () => {
                      await ensureAdults(training?.trainedFileIds ?? []);
                      return publish({ identityId: identity.id, repoName: repo, confirmPublic: true });
                    })
                  }>
                  {busy === "publish" ? "Publishing…" : "Publish to Hugging Face"}
                </button>
                {!info.hfReady ? <span style={help}>Pick a Hugging Face token in the identity settings first.</span> : null}
              </div>
            </>
          ) : null}
          {identity.lora ? (
            <div style={row}>
              <span style={help}>
                Published: <a href={identity.lora.url} target="_blank" rel="noreferrer">{identity.lora.repo ?? identity.lora.url}</a> ({identity.lora.visibility}).
              </span>
              <button type="button" style={secondaryBtn} disabled={busy !== null} onClick={() => void run("import", () => importSogni({ identityId: identity.id }))}>
                Import into Sogni
              </button>
            </div>
          ) : null}
          <div style={help}>
            Already imported into Sogni by hand (Personal LoRAs, Import, base model Krea 2 Identity Edit; needs Sogni Unlimited)? Paste its id:
          </div>
          <div style={row}>
            <input style={input} placeholder="personal-…" value={manualId} onChange={(e) => setManualId(e.target.value)} />
            <button type="button" style={ghostBtn} disabled={busy !== null || !manualId.trim()} onClick={() => void run("attach", () => attach({ identityId: identity.id, sogniLoraId: manualId.trim(), triggerWord: trigger }))}>
              Attach
            </button>
            {training && training.status !== "training" ? (
              <button type="button" style={ghostBtn} disabled={busy !== null} onClick={() => void run("reset", () => reset({ identityId: identity.id }))}>Clear the LoRA training</button>
            ) : null}
          </div>
        </div>

        <div style={{ ...card, gap: 6 }} aria-label="Higgsfield Soul ID">
          <strong>B. Higgsfield Soul ID</strong>
          <div style={help}>
            Uploads {info.training.soulMin} to {info.training.soulMax} ticked face pictures to Higgsfield and makes a Soul ID. Higgsfield then keeps this person in
            its Soul pictures (it takes no reference pictures, so outfit pictures and rooms go through Sogni or Fal.ai).
          </div>
          <div style={row}>
            <select style={input} value={variant} onChange={(e) => setVariant(e.target.value === "soul-cinematic" ? "soul-cinematic" : "soul-2")} aria-label="Soul ID kind">
              <option value="soul-2">For pictures (Soul 2)</option>
              <option value="soul-cinematic">For video (Soul Cinematic)</option>
            </select>
            <button
              type="button"
              style={primaryBtn}
              disabled={busy !== null || selected.size < info.training.soulMin || selected.size > info.training.soulMax || !(options?.services.higgsfield ?? false)}
              onClick={() =>
                void run("soul", async () => {
                  await ensureAdults(set.selectedFileIds);
                  return soul({ identityId: identity.id, variant });
                })
              }
            >
              {busy === "soul" ? "Uploading…" : "Make a Soul ID"}
            </button>
            {!(options?.services.higgsfield ?? false) ? <span style={help}>The company's owner or an admin adds the Higgsfield key in Media Studio's Settings tab first.</span> : null}
          </div>
          <div style={help}>
            The kind is kept with the Soul ID; Higgsfield's API documentation does not say how to ask for one or the other, so it is a label for now.
          </div>
        </div>

        <div style={{ ...card, gap: 6 }} aria-label="Download training set">
          <strong>C. Download the training set (.zip)</strong>
          <div style={help}>The ticked pictures with a caption file each and a README saying where each picture came from, for training anywhere else.</div>
          <div>
            <button
              type="button"
              style={secondaryBtn}
              disabled={busy !== null || selected.size === 0}
              onClick={() =>
                void run("download", async () => {
                  await ensureAdults(set.selectedFileIds);
                  const res = (await download({ identityId: identity.id, triggerWord: trigger })) as { filename: string; contentType: string; contentBase64: string };
                  downloadBase64(res.filename, res.contentType, res.contentBase64);
                  return undefined;
                })
              }
            >
              {busy === "download" ? "Packing…" : `Download ${selected.size} pictures`}
            </button>
          </div>
        </div>
      </div>

      <div style={card} aria-label="Trained identities">
        <strong>Trained identities</strong>
        <div style={help}>What the trainings produced. A look with this person uses the newest ready one per service, unless the look picks another.</div>
        {trained.length === 0 ? <div style={help}>None yet.</div> : null}
        {trained.map((t) => (
          <div key={t.id} style={row}>
            <span style={{ fontSize: 13 }}>
              {PROVIDER_LABEL[t.provider]}: <code>{t.ref.length > 60 ? `${t.ref.slice(0, 57)}…` : t.ref}</code> ({t.status}){t.variant ? `, ${t.variant}` : ""}
              {t.triggerWord ? `, trigger word ${t.triggerWord}` : ""}
            </span>
            <button type="button" style={ghostBtn} disabled={busy !== null} onClick={() => void run(`rm-${t.id}`, () => trainedRemove({ identityId: identity.id, trainedId: t.id }))}>Remove</button>
          </div>
        ))}
        {trained.some((t) => t.status !== "ready" && t.status !== "completed" && t.status !== "failed") ? (
          <div>
            <button type="button" style={ghostBtn} disabled={busy !== null} onClick={() => void run("tstatus", () => trainedStatus({ identityId: identity.id }))}>Check status</button>
          </div>
        ) : null}
        <div style={help}>
          Your own Sogni LoRAs are used only with a look an owner or admin saved with Sogni's content filter off (Sogni requires that).
        </div>
      </div>
    </>
  );
}

// ─── The tab ─────────────────────────────────────────────────────────────────

export function IdentitiesPanel({ context }: { context: PluginHostContext }) {
  const companyId = context.companyId;
  const list = usePluginAction(ACTION_IDENTITIES_LIST);
  const save = usePluginAction(ACTION_IDENTITIES_SAVE);
  const remove = usePluginAction(ACTION_IDENTITIES_DELETE);
  const analyse = usePluginAction(ACTION_IDENTITIES_ANALYSE);
  const crop = usePluginAction(ACTION_IDENTITIES_CROP);
  const segment = usePluginAction(ACTION_EDIT_SEGMENT);
  const [info, setInfo] = useState<ListResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<Identity | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = (await list({})) as ListResponse;
      setInfo(res);
      setOpen((o) => (o ? res.identities.find((i) => i.id === o.id) ?? null : o));
    } catch (e) {
      setError(errText(e));
    }
  }, [list]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!companyId) return <div style={errorBox}>Open Media Studio from inside a company.</div>;
  if (!info) return error ? <div style={errorBox}>{error}</div> : <div style={help}>Loading…</div>;

  const updated = (identity: Identity) => {
    setOpen(identity);
    setInfo((i) => (i ? { ...i, identities: i.identities.map((x) => (x.id === identity.id ? identity : x)) } : i));
  };

  const step = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const onAnalyse = () =>
    step("analyse", async () => {
      if (!draft?.originalFileId) return;
      const res = (await analyse({ fileId: draft.originalFileId })) as
        | { ok: true; sheet: Record<string, string>; crops: { face: Box; body: Box | null; outfit: Box | null }; model: string }
        | { ok: false; blocked: boolean; message: string };
      if (!res.ok) {
        setError(res.message);
        if (res.blocked) setDraft((d) => (d ? { ...d, originalFileId: null, boxes: [], crops: [] } : d));
        return;
      }
      const boxes: Draft["boxes"] = [{ role: "face", box: res.crops.face }];
      if (res.crops.body) boxes.push({ role: "body", box: res.crops.body });
      if (res.crops.outfit) boxes.push({ role: "outfit", box: res.crops.outfit });
      setDraft((d) => (d ? { ...d, sheet: { ...d.sheet, ...res.sheet }, boxes } : d));
      setNotice(`Filled in by ${res.model}. Check every field and box: you can change them all.`);
    });

  const onFindWithSogni = (role: CropRole) =>
    step(`find-${role}`, async () => {
      if (!draft?.originalFileId) return;
      const imageDataUrl = await pictureDataUrl(draft.originalFileId);
      const text = role === "face" ? "the person's face and hair" : role === "body" ? "the whole person" : role === "outfit" ? "the person's clothing" : "the person";
      const res = (await segment({ imageDataUrl, text })) as { imageDataUrl: string };
      const img = new Image();
      img.src = res.imageDataUrl;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const c2d = canvas.getContext("2d");
      if (!c2d) throw new Error("This browser cannot read the selection.");
      c2d.drawImage(img, 0, 0);
      const box = maskBox(c2d.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      if (!box) throw new Error("Sogni did not find that in the picture. Draw the box yourself.");
      const padded = role === "face" ? padBox(box) : box;
      setDraft((d) => (d ? { ...d, boxes: [...d.boxes.filter((b) => b.role !== role), { role, box: padded }] } : d));
    });

  const onMakeCrops = () =>
    step("crop", async () => {
      if (!draft?.originalFileId || draft.boxes.length === 0) return;
      const res = (await crop({ fileId: draft.originalFileId, boxes: draft.boxes })) as { crops: Array<{ role: CropRole; box: Box; imageDataUrl: string }> };
      const crops: IdentityCrop[] = [];
      for (const c of res.crops) {
        const fileId = await uploadPicture(companyId, c.imageDataUrl, `${(draft.name || "person").replace(/[^A-Za-z0-9-]+/g, "-")}-${c.role}.png`);
        crops.push({ role: c.role, fileId, sourceFileId: draft.originalFileId, box: c.box });
      }
      setDraft((d) => (d ? { ...d, crops: [...d.crops.filter((x) => !crops.some((n) => n.role === x.role)), ...crops] } : d));
      setNotice("Crops saved to Files. Save the identity to keep them.");
    });

  const onSave = () =>
    step("save", async () => {
      if (!draft) return;
      const res = (await save(draftToParams(draft))) as { identity: Identity; identities: Identity[] };
      setInfo((i) => (i ? { ...i, identities: res.identities } : i));
      setDraft(null);
      setOpen(res.identity);
    });

  const onDelete = (identity: Identity) =>
    step("delete", async () => {
      if (typeof window !== "undefined" && !window.confirm(`Delete "${identity.name}"? Looks that use this person keep working without them.`)) return;
      const res = (await remove({ id: identity.id })) as { identities: Identity[] };
      setInfo((i) => (i ? { ...i, identities: res.identities } : i));
      setOpen(null);
    });

  // ── Editor ──
  if (draft) {
    const isNew = draft.id === null;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-label="Identity editor">
        <div style={row}>
          <strong style={{ fontSize: 15 }}>{isNew ? "New identity" : `Edit ${draft.name}`}</strong>
          <button type="button" style={ghostBtn} onClick={() => setDraft(null)}>Cancel</button>
        </div>
        <div style={card}>
          <strong>1. The person's picture</strong>
          <div style={help}>One clear picture of one person. The same picture can give several crops (face, body, outfit).</div>
          <PicturePicker companyId={companyId} disabled={busy !== null} onPick={(fileId) => setDraft((d) => (d ? { ...d, originalFileId: fileId, boxes: [], crops: [] } : d))} />
          {draft.originalFileId ? (
            <>
              <div style={row}>
                <button type="button" style={secondaryBtn} disabled={busy !== null || !info.analysisReady} onClick={() => void onAnalyse()}>
                  {busy === "analyse" ? "Analysing…" : "Analyse picture"}
                </button>
                {!info.analysisReady ? (
                  <span style={help}>Pick an analysis model in the identity settings first (or fill everything in yourself).</span>
                ) : (
                  <span style={help}>Fills in the description and suggests the boxes. It never says who the person is.</span>
                )}
              </div>
              <div style={row}>
                {CROP_ROLE_OPTIONS.map((o) => (
                  <span key={o.value} style={{ display: "inline-flex", gap: 4 }}>
                    <button
                      type="button"
                      style={{ ...ghostBtn, borderColor: o.color }}
                      title={o.help}
                      disabled={busy !== null}
                      onClick={() =>
                        setDraft((d) =>
                          d ? { ...d, boxes: d.boxes.some((b) => b.role === o.value) ? d.boxes.filter((b) => b.role !== o.value) : [...d.boxes, { role: o.value, box: defaultBox(o.value) }] } : d,
                        )
                      }
                    >
                      {draft.boxes.some((b) => b.role === o.value) ? `Remove ${o.label.toLowerCase()} box` : `Add ${o.label.toLowerCase()} box`}
                    </button>
                    {o.value !== "other" ? (
                      <button type="button" style={ghostBtn} disabled={busy !== null} title="Let Sogni find it (a paid Sogni call)" onClick={() => void onFindWithSogni(o.value)}>
                        {busy === `find-${o.value}` ? "Finding…" : "Find"}
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
              <CropEditor src={fileContentPath(draft.originalFileId)} boxes={draft.boxes} onChange={(boxes) => setDraft((d) => (d ? { ...d, boxes } : d))} disabled={busy !== null} />
              <div style={help}>Drag a box to move it; drag its corner to resize it. Face is sent first, body second; outfit only for looks that keep the same outfit.</div>
              <div>
                <button type="button" style={primaryBtn} disabled={busy !== null || draft.boxes.length === 0} onClick={() => void onMakeCrops()}>
                  {busy === "crop" ? "Cutting…" : "Make crops"}
                </button>
              </div>
              {draft.crops.length > 0 ? (
                <div style={row}>
                  {draft.crops.map((c) => (
                    <div key={c.fileId} style={{ textAlign: "center", fontSize: 12 }}>
                      <img src={fileContentPath(c.fileId)} alt={`${c.role} crop`} style={thumb} />
                      {CROP_ROLE_OPTIONS.find((o) => o.value === c.role)?.label}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <div style={card}>
          <strong>2. Name and description</strong>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
            <label style={field}>
              <span>Name</span>
              <input style={input} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label style={field}>
              <span>Nickname (optional)</span>
              <input style={input} value={draft.nickname} onChange={(e) => setDraft({ ...draft, nickname: e.target.value })} />
              <span style={help}>A request that says the name or nickname uses this person.</span>
            </label>
          </div>
          <div style={help}>Stable physical traits only. These stay the same in every picture of this person.</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
            {IDENTITY_SHEET_OPTIONS.map((f) => (
              <label key={f.key} style={field}>
                <span>{f.label}</span>
                <input style={input} placeholder={f.placeholder} value={draft.sheet[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, sheet: { ...draft.sheet, [f.key]: e.target.value } })} />
              </label>
            ))}
          </div>
        </div>

        <details style={card}>
          <summary style={{ fontWeight: 600, cursor: "pointer" }}>Models (optional)</summary>
          <div style={help}>Used when a look with this person picks no model. Krea Identity Edit keeps faces best (2 pictures); qwen takes 3 when a look needs an extra picture.</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
            <label style={field}>
              <span>Sogni model</span>
              <select style={input} value={draft.preferredSogni} onChange={(e) => setDraft({ ...draft, preferredSogni: e.target.value })}>
                {info.editModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
            <label style={field}>
              <span>Sogni model when an extra picture is needed</span>
              <select style={input} value={draft.preferredExtra} onChange={(e) => setDraft({ ...draft, preferredExtra: e.target.value })}>
                {info.editModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
            <label style={field}>
              <span>Fal.ai model (optional)</span>
              <input style={input} placeholder="Empty: Fal's normal picture editor" value={draft.preferredFal} onChange={(e) => setDraft({ ...draft, preferredFal: e.target.value })} />
            </label>
          </div>
        </details>

        <div style={card}>
          <strong>3. Confirm</strong>
          {isNew ? (
            <>
              <label style={{ ...row, fontSize: 13 }}>
                <input type="checkbox" checked={draft.consentLikeness} onChange={(e) => setDraft({ ...draft, consentLikeness: e.target.checked })} /> {info.consentText.likeness}
              </label>
              <label style={{ ...row, fontSize: 13 }}>
                <input type="checkbox" checked={draft.consentAdult} onChange={(e) => setDraft({ ...draft, consentAdult: e.target.checked })} /> {info.consentText.adult}
              </label>
              <div style={help}>Both are required. They are saved with the identity, with who confirmed them and when.</div>
            </>
          ) : (
            <div style={help}>Confirmed when the identity was made.</div>
          )}
          {error ? <div style={errorBox}>{error}</div> : null}
          {notice ? <div style={okBox}>{notice}</div> : null}
          <div>
            <button
              type="button"
              style={primaryBtn}
              disabled={busy !== null || !draft.name.trim() || (isNew && (!draft.consentLikeness || !draft.consentAdult))}
              onClick={() => void onSave()}
            >
              {busy === "save" ? "Saving…" : "Save identity"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── One identity ──
  if (open) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-label="Identity details">
        <div style={row}>
          <button type="button" style={ghostBtn} onClick={() => setOpen(null)}>All identities</button>
          <strong style={{ fontSize: 15 }}>{open.name}{open.nickname ? ` ("${open.nickname}")` : ""}</strong>
          {info.canManage ? (
            <>
              <button type="button" style={secondaryBtn} onClick={() => setDraft(identityToDraft(open))}>Edit</button>
              <button type="button" style={dangerBtn} disabled={busy !== null} onClick={() => void onDelete(open)}>Delete</button>
            </>
          ) : null}
        </div>
        {error ? <div style={errorBox}>{error}</div> : null}
        <div style={card}>
          <div style={row}>
            {open.crops.map((c) => (
              <div key={c.fileId} style={{ textAlign: "center", fontSize: 12 }}>
                <img src={fileContentPath(c.fileId)} alt={`${c.role} crop`} style={thumb} />
                {CROP_ROLE_OPTIONS.find((o) => o.value === c.role)?.label}
              </div>
            ))}
          </div>
          <div style={help}>
            {IDENTITY_SHEET_OPTIONS.filter((f) => open.sheet[f.key]).map((f) => `${f.label}: ${open.sheet[f.key]}`).join(" · ") || "No description yet."}
          </div>
          <div style={help}>
            Confirmed by {open.consent.confirmedBy} on {new Date(open.consent.confirmedAt).toLocaleDateString()}: "{info.consentText.likeness}" and "{info.consentText.adult}"
          </div>
        </div>
        {info.canManage ? <CandidatesSection identity={open} companyId={companyId} seedExplanation={info.seedExplanation} onChanged={updated} /> : null}
        <TrainingSection identity={open} companyId={companyId} info={info} onChanged={updated} />
      </div>
    );
  }

  // ── List ──
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-label="Identities">
      <div style={help}>
        An identity is a saved person (fictional or AI-made, or a real adult who gave written consent). Pick it in a look, or name the person in a
        request, and every picture starts from the same face and body pictures.
      </div>
      <div style={row}>
        {info.canManage ? (
          <button type="button" style={primaryBtn} onClick={() => { setError(null); setDraft({ ...EMPTY }); }}>
            New identity
          </button>
        ) : (
          <span style={help}>Only an owner or admin can add identities.</span>
        )}
        <button type="button" style={ghostBtn} onClick={() => setShowSettings((s) => !s)}>{showSettings ? "Hide settings" : "Identity settings"}</button>
      </div>
      {showSettings ? <IdentitySettingsPanel companyId={companyId} onSaved={() => void load()} /> : null}
      {error ? <div style={errorBox}>{error}</div> : null}
      {info.identities.length === 0 ? <div style={help}>No identities yet.</div> : null}
      <div style={row}>
        {info.identities.map((identity) => {
          const pic = identity.canonicalFileId ?? identity.crops.find((c) => c.role === "face")?.fileId ?? identity.originalFileId;
          return (
            <button key={identity.id} type="button" style={{ ...card, cursor: "pointer", background: "none", color: "inherit", alignItems: "center", width: 140 }} onClick={() => setOpen(identity)}>
              {pic ? <img src={fileContentPath(pic)} alt={identity.name} style={thumb} /> : null}
              <span style={{ fontSize: 13, fontWeight: 600 }}>{identity.name}</span>
              {(identity.trainedIdentities ?? []).some((t) => t.status === "ready" || t.status === "completed") ? <span style={help}>Trained</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
