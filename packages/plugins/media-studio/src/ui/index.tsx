import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginCompanySettingsPageProps, PluginDetailTabProps, PluginHostContext, PluginPageProps, PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction, useHostNavigation, PluginConfigForm } from "@paperclipai/plugin-sdk/ui";
import { MediaStudioEditTab } from "./edit-tab.js";
import { StoryboardPanel, storyboardReadyToRender, type StoryboardSummary } from "./storyboard-panel.js";
import { AdvancedFeaturesToggle, AiDirectorSection } from "./director-panel.js";
import { errorText, storylineFetchJson } from "./storyline-api.js";
import { ScriptImportDialog, ScriptInstructionsDialog } from "./script-import.js";

// The plugin UI is served as a standalone ES module, so it must not import from
// sibling plugin files (only bare specifiers resolve). Keep these in sync with
// manifest.ts / providers.ts.
const PLUGIN_ID = "paperclip.media-studio";
const MAIN_PAGE_ROUTE = "media-studio";
const ACTION_GENERATE = "generate";
const PROVIDER = "media-studio";
const ACTION_LOOKS_LIST = "looks.list";
const ACTION_SETTINGS_ACCESS = "settings.access";
const ACTION_LOOKS_SAVE = "looks.save";
const ACTION_LOOKS_DELETE = "looks.delete";
const ACTION_LOOK_DEFAULTS_LIST = "looks.defaults.list";
const ACTION_LOOK_DEFAULTS_SET = "looks.defaults.set";
const ACTION_LOOK_RULES_LIST = "lookRules.list";
const ACTION_LOOK_RULES_SAVE = "lookRules.save";
const ACTION_LOOK_RULES_PREVIEW = "lookRules.preview";
const ACTION_SOGNI_MODELS = "sogni.models";
const ACTION_SOGNI_LORAS = "sogni.loras";
const ACTION_LOOK_PROMPT_PREVIEW = "looks.previewPrompt";

// Copies of look-prompt.ts (a test checks they match): what each reference
// picture is for, and the character sheet's fields.
export const REFERENCE_ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "face", label: "Face" },
  { value: "body", label: "Body" },
  { value: "outfit", label: "Outfit" },
  { value: "style", label: "Style/aesthetic" },
  { value: "background", label: "Background" },
  { value: "other", label: "Other" },
];
export const SHEET_FIELD_OPTIONS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: "hair", label: "Hair", placeholder: "long, blonde, loose waves" },
  { key: "face", label: "Face", placeholder: "small, petite nose, red lips" },
  { key: "eyes", label: "Eyes", placeholder: "narrow, green" },
  { key: "body", label: "Body", placeholder: "slim, tall" },
  { key: "skin", label: "Skin", placeholder: "fair, light freckles" },
  { key: "outfit", label: "Outfit", placeholder: "cream knit sweater, dark jeans" },
  { key: "accessories", label: "Accessories", placeholder: "thin gold necklace" },
  { key: "expression", label: "Expression/pose defaults", placeholder: "soft smile, relaxed" },
  { key: "setting", label: "Setting/background", placeholder: "bright Scandinavian living room" },
  { key: "artStyle", label: "Art style", placeholder: "natural photograph" },
  { key: "lighting", label: "Lighting", placeholder: "soft daylight from a window" },
  { key: "camera", label: "Camera/framing", placeholder: "eye level, 50 mm, waist up" },
  { key: "avoid", label: "Always avoid", placeholder: "text, watermarks, extra fingers" },
];
const SHEET_FIELD_MAX = 300;
const DEFAULT_SAMPLE_REQUEST = "reading a book by the window";

type GenerationResult = {
  provider: string;
  contentType: string;
  imageUrl?: string;
  imageDataUrl?: string;
  meta?: Record<string, unknown>;
};

type WorkProduct = {
  id: string;
  title: string;
  provider: string;
  url: string | null;
  status: string;
  reviewState: string;
  summary: string | null;
  metadata: Record<string, unknown> | null;
};

function hostFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  }).then(async (res) => {
    if (!res.ok) throw new Error((await res.text()) || `Request failed: ${res.status}`);
    return (res.status === 204 ? (undefined as T) : ((await res.json()) as T));
  });
}

function imageSrc(wp: WorkProduct): string | null {
  if (wp.url) return wp.url;
  const dataUrl = wp.metadata?.imageDataUrl;
  return typeof dataUrl === "string" ? dataUrl : null;
}

const STATUS_TONE: Record<string, { bg: string; fg: string; label: string }> = {
  ready_for_review: { bg: "#fff4e6", fg: "#b45309", label: "Needs review" },
  approved: { bg: "#e6fcf5", fg: "#087f5b", label: "Approved" },
  changes_requested: { bg: "#fff0f6", fg: "#a61e4d", label: "Changes requested" },
  merged: { bg: "#e7f5ff", fg: "#1971c2", label: "Posted" },
};

export function MediaStudioIssueTab({ context }: PluginDetailTabProps) {
  const issueId = context.entityId;
  const companyId = context.companyId;
  const generate = usePluginAction(ACTION_GENERATE);

  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<GenerationResult | null>(null);
  const [items, setItems] = useState<WorkProduct[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await hostFetchJson<WorkProduct[]>(`/api/issues/${issueId}/work-products`);
      setItems(all.filter((w) => w.provider === PROVIDER));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [issueId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      setBusy(key);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const onGenerate = () =>
    run("generate", async () => {
      if (!prompt.trim()) throw new Error("Enter a prompt first.");
      const result = (await generate({ prompt })) as GenerationResult;
      setPreview(result);
    });

  const onSubmit = () =>
    run("submit", async () => {
      if (!preview || !companyId) throw new Error("Generate a preview first.");
      const title = prompt.trim().slice(0, 80) || "Generated image";
      // 1) File the board approval, linked to this issue (surfaces in the Now view's Needs-you lane).
      const approval = await hostFetchJson<{ id: string }>(
        `/api/companies/${companyId}/approvals`,
        {
          method: "POST",
          body: JSON.stringify({
            type: "request_board_approval",
            payload: { title: `Approve image: ${title}`, summary: prompt.trim() },
            issueIds: [issueId],
          }),
        },
      );
      // 2) Save the work product in a review state, linking the approval.
      await hostFetchJson(`/api/issues/${issueId}/work-products`, {
        method: "POST",
        body: JSON.stringify({
          type: "artifact",
          provider: PROVIDER,
          title,
          url: preview.imageUrl ?? null,
          status: "ready_for_review",
          reviewState: "needs_board_review",
          summary: prompt.trim(),
          metadata: {
            prompt: prompt.trim(),
            generatedBy: preview.provider,
            contentType: preview.contentType,
            imageDataUrl: preview.imageDataUrl ?? null,
            approvalId: approval.id,
          },
        }),
      });
      setPreview(null);
      await load();
    });

  const approvalIdOf = (wp: WorkProduct) =>
    typeof wp.metadata?.approvalId === "string" ? (wp.metadata.approvalId as string) : null;

  const onApprove = (wp: WorkProduct) =>
    run(`approve-${wp.id}`, async () => {
      const approvalId = approvalIdOf(wp);
      if (approvalId) await hostFetchJson(`/api/approvals/${approvalId}/approve`, { method: "POST", body: "{}" });
      await hostFetchJson(`/api/work-products/${wp.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "approved", reviewState: "approved" }),
      });
      await load();
    });

  const onRequestChanges = (wp: WorkProduct) =>
    run(`changes-${wp.id}`, async () => {
      const approvalId = approvalIdOf(wp);
      if (approvalId)
        await hostFetchJson(`/api/approvals/${approvalId}/request-revision`, { method: "POST", body: "{}" });
      await hostFetchJson(`/api/work-products/${wp.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "changes_requested", reviewState: "changes_requested" }),
      });
      await load();
    });

  const onRegenerate = (wp: WorkProduct) => {
    const p = typeof wp.metadata?.prompt === "string" ? (wp.metadata.prompt as string) : "";
    setPrompt(p);
    setPreview(null);
    setError(null);
  };

  // The approval gate in action: only an approved image can be posted.
  const onPost = (wp: WorkProduct) =>
    run(`post-${wp.id}`, async () => {
      const src = imageSrc(wp);
      const body = src
        ? `Approved media: **${wp.title}**\n\n![${wp.title}](${src})`
        : `Approved media: **${wp.title}**`;
      await hostFetchJson(`/api/issues/${issueId}/comments`, { method: "POST", body: JSON.stringify({ body }) });
      await hostFetchJson(`/api/work-products/${wp.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "merged", isPrimary: true }),
      });
      await load();
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, fontSize: 13 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Media Studio</div>
        <div style={{ color: "#868e96" }}>
          Generate an image, then require a board approval before it can be posted.
        </div>
      </div>

      {error ? (
        <div style={{ background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8 }}>{error}</div>
      ) : null}

      {/* Generate */}
      <div style={{ border: "1px solid #e9ecef", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the image to generate…"
          rows={3}
          style={{ width: "100%", resize: "vertical", padding: 8, borderRadius: 8, border: "1px solid #ced4da", fontFamily: "inherit" }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" onClick={onGenerate} disabled={busy === "generate"} style={primaryBtn}>
            {busy === "generate" ? "Generating…" : "Generate"}
          </button>
          {preview ? (
            <button type="button" onClick={onSubmit} disabled={busy === "submit"} style={secondaryBtn}>
              {busy === "submit" ? "Submitting…" : "Submit for approval"}
            </button>
          ) : null}
        </div>
        {preview ? (
          <img
            src={preview.imageUrl ?? preview.imageDataUrl}
            alt="preview"
            style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid #e9ecef" }}
          />
        ) : null}
      </div>

      {/* Existing media + approval gate */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontWeight: 600 }}>Media ({items.length})</div>
        {items.length === 0 ? (
          <div style={{ color: "#868e96" }}>No generated media yet.</div>
        ) : (
          items.map((wp) => {
            const tone = STATUS_TONE[wp.status] ?? { bg: "#f1f3f5", fg: "#495057", label: wp.status };
            const src = imageSrc(wp);
            return (
              <div key={wp.id} style={{ border: "1px solid #e9ecef", borderRadius: 10, padding: 12, display: "flex", gap: 12 }}>
                {src ? (
                  <img src={src} alt={wp.title} style={{ width: 120, height: 90, objectFit: "cover", borderRadius: 8, border: "1px solid #e9ecef" }} />
                ) : null}
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{wp.title}</span>
                    <span style={{ background: tone.bg, color: tone.fg, borderRadius: 999, padding: "2px 8px", fontSize: 11, whiteSpace: "nowrap" }}>{tone.label}</span>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {wp.status === "ready_for_review" ? (
                      <>
                        <button type="button" onClick={() => onApprove(wp)} disabled={busy === `approve-${wp.id}`} style={approveBtn}>Approve</button>
                        <button type="button" onClick={() => onRequestChanges(wp)} disabled={busy === `changes-${wp.id}`} style={dangerBtn}>Request changes</button>
                        <button type="button" onClick={() => onRegenerate(wp)} style={ghostBtn}>Regenerate</button>
                      </>
                    ) : wp.status === "approved" ? (
                      <>
                        <button type="button" onClick={() => onPost(wp)} disabled={busy === `post-${wp.id}`} style={primaryBtn}>Post</button>
                        <button type="button" onClick={() => onRegenerate(wp)} style={ghostBtn}>Regenerate</button>
                      </>
                    ) : wp.status === "changes_requested" ? (
                      <button type="button" onClick={() => onRegenerate(wp)} style={ghostBtn}>Regenerate</button>
                    ) : (
                      <span style={{ color: "#868e96" }}>Posted to the issue thread.</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
      <div style={{ color: "#adb5bd", fontSize: 11 }}>Plugin: {PLUGIN_ID}</div>
    </div>
  );
}

// ─── Company settings → Media Studio looks ───────────────────────────────────

type LookLora = { id: string; name: string; strength: number };

type Look = {
  id: string;
  name: string;
  style: string;
  model: string | null;
  modelName?: string | null;
  provider?: "fal" | "sogni" | null;
  seed: number | null;
  referenceFileIds: string[];
  referenceRoles?: string[];
  sheet?: Record<string, string>;
  loras?: LookLora[];
  guidance?: number | null;
  negativePrompt?: string | null;
  size?: string | null;
  safeContentFilter?: boolean;
  updatedAt: string;
};

const SERVICE_LABEL: Record<string, string> = { fal: "Fal.ai", sogni: "Sogni" };

type LooksResponse = { looks: Look[]; canManage?: boolean; maxReferenceFiles?: number; defaults?: Record<string, string> };

export type LookAgent = { id: string; name: string; title: string | null };
type LookDefaultsResponse = { agents?: LookAgent[]; defaults?: Record<string, string>; canManage?: boolean };

type CompanyImage = { fileId: string; title: string; src: string };

// Sogni's catalog as the worker sends it (see sogni-catalog.ts; keep in sync).
export type SogniRange = { min: number; max: number; default: number; step?: number; decimals?: number };

export type SogniModel = {
  id: string;
  name: string;
  tags: string[];
  tier: string | null;
  generates: boolean;
  takesReferences: boolean;
  workersOnline: number | null;
  contentFilter: "off-required" | "mature" | null;
  width: SogniRange | null;
  height: SogniRange | null;
  steps: SogniRange | null;
  guidance: SogniRange | null;
  negativePrompt: { default: string } | null;
  hasLoras: boolean | null;
  creator: string | null;
  sourceUrl: string | null;
  variant: boolean;
  /** How many reference pictures a look with this model can keep (the worker works it out). */
  referenceLimit?: number;
};

export type SogniLora = {
  id: string;
  name: string;
  description: string;
  category: string | null;
  personal: boolean;
  modelIds: string[];
  min: number;
  max: number;
  default: number;
  step: number;
  recommendedMin: number;
  recommendedMax: number;
  rangeLabels: { min: string; max: string } | null;
  needsFilterOff: boolean;
  creator: string | null;
  sourceUrl: string | null;
};

type SogniModelsResponse = { models: SogniModel[]; live: boolean; maxLoras?: number; note?: string | null };
export type PromptPreviewResult = {
  request: string;
  prompt: string;
  negativePrompt: string | null;
  service: string;
  model: string | null;
  references: Array<{ position: number; role: string; label: string }>;
  leftOut: string[];
};

function roleLabel(role: string | undefined): string {
  return REFERENCE_ROLE_OPTIONS.find((o) => o.value === role)?.label ?? "Other";
}

type SogniLorasResponse = { modelId: string; loras: SogniLora[]; maxLoras?: number; personal?: string; note?: string | null };

const ATTACHMENT_PATH = /^\/api\/attachments\/([0-9a-f-]{36})\/content$/i;

function fileContentPath(fileId: string) {
  return `/api/attachments/${fileId}/content`;
}

function thumbnailPathFor(contentPath: string): string {
  return contentPath.replace(/\/content$/, "/thumbnail");
}

export type LookDraft = {
  id: string | null;
  name: string;
  style: string;
  provider: string;
  model: string;
  seed: string;
  referenceFileIds: string[];
  /** One per reference picture, same order (missing: "other"). */
  referenceRoles?: string[];
  /** Character sheet fields (missing: empty). */
  sheet?: Record<string, string>;
  loras: LookLora[];
  guidance: string;
  negativePrompt: string;
  width: string;
  height: string;
  safeContentFilter: boolean;
};

const EMPTY_DRAFT: LookDraft = {
  id: null,
  name: "",
  style: "",
  provider: "",
  model: "",
  seed: "",
  referenceFileIds: [],
  referenceRoles: [],
  sheet: {},
  loras: [],
  guidance: "",
  negativePrompt: "",
  width: "",
  height: "",
  safeContentFilter: true,
};

/** At most this many models are listed at once; searching narrows the rest. */
const MODEL_LIST_LIMIT = 60;
const DEFAULT_MAX_LORAS = 8;

/** Models matching a search (name, id or tag). Untagged builds of other models only show when asked for. */
export function filterSogniModels(models: SogniModel[], query: string, showVariants: boolean): SogniModel[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((model) => {
    if (model.variant && !showVariants) return false;
    const haystack = `${model.name} ${model.id} ${model.tags.join(" ")}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function workersText(model: SogniModel): string {
  if (model.workersOnline === null) return "Workers not known";
  if (model.workersOnline === 0) return "No workers online now";
  return `${model.workersOnline} worker${model.workersOnline === 1 ? "" : "s"} online`;
}

function showNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export function rangeText(range: SogniRange): string {
  if (range.min === range.max) return `always ${showNumber(range.min)}`;
  return `${showNumber(range.min)} to ${showNumber(range.max)} (usually ${showNumber(range.default)})`;
}

/** What to tell the owner about the Sensitive content filter for a model; null when nothing special. */
export function modelFilterNotice(model: SogniModel | null): string | null {
  if (model?.contentFilter === "off-required") {
    return "This model only works with the Sensitive content filter off. Turn the filter off below, or its pictures may be stopped.";
  }
  if (model?.contentFilter === "mature") {
    return "Sogni marks this model as made for mature pictures. With the filter on, some of its pictures may be stopped.";
  }
  return null;
}

/** Keep a strength inside the LoRA's own range. */
export function clampStrength(value: number, lora: Pick<SogniLora, "min" | "max">): number {
  if (!Number.isFinite(value)) return lora.min;
  return Math.min(lora.max, Math.max(lora.min, value));
}

/** The LoRA's default strength (for the account's own LoRAs, above 0). */
export function startingStrength(lora: SogniLora): number {
  const value = clampStrength(lora.default, lora);
  return lora.personal && value <= 0 ? Math.min(1, lora.max) : value;
}

/** One role per picked picture, in order ("other" where none is picked). */
export function draftRoles(draft: Pick<LookDraft, "referenceFileIds" | "referenceRoles">): string[] {
  return draft.referenceFileIds.map((_, i) => draft.referenceRoles?.[i] || "other");
}

/** The sheet's filled-in fields, trimmed. */
export function draftSheet(draft: Pick<LookDraft, "sheet">): Record<string, string> {
  const sheet: Record<string, string> = {};
  for (const field of SHEET_FIELD_OPTIONS) {
    const value = draft.sheet?.[field.key]?.trim();
    if (value) sheet[field.key] = value;
  }
  return sheet;
}

/** How many reference pictures this look can keep: 4, or the chosen Sogni model's own limit (3 when unknown). */
export function referenceLimitFor(provider: string, model: SogniModel | null, fallback: number): number {
  if (provider !== "sogni") return fallback;
  return model?.referenceLimit ?? 3;
}

/** A new random seed for "Lock seed". */
export function randomSeed(): string {
  return String(Math.floor(Math.random() * 4_294_967_295));
}

/** Turn the form into what looks.save takes. Only Sogni looks carry LoRAs and model settings. */
export function draftToSaveParams(draft: LookDraft): Record<string, unknown> {
  const sogni = draft.provider === "sogni";
  const size = sogni && draft.width.trim() && draft.height.trim() ? `${draft.width.trim()}x${draft.height.trim()}` : null;
  return {
    id: draft.id,
    name: draft.name,
    style: draft.style,
    provider: draft.provider || null,
    model: draft.model,
    seed: draft.seed.trim() === "" ? null : draft.seed.trim(),
    referenceFileIds: draft.referenceFileIds,
    referenceRoles: draftRoles(draft),
    sheet: draftSheet(draft),
    loras: sogni ? draft.loras.map(({ id, strength }) => ({ id, strength })) : [],
    guidance: sogni && draft.guidance.trim() !== "" ? draft.guidance.trim() : null,
    negativePrompt: sogni && draft.negativePrompt.trim() ? draft.negativePrompt.trim() : null,
    size,
    safeContentFilter: sogni ? draft.safeContentFilter : true,
  };
}

function lookToDraft(look: Look): LookDraft {
  const [width, height] = (look.size ?? "").split("x");
  return {
    id: look.id,
    name: look.name,
    style: look.style,
    provider: look.provider ?? "",
    model: look.model ?? "",
    seed: look.seed === null ? "" : String(look.seed),
    referenceFileIds: [...look.referenceFileIds],
    referenceRoles: look.referenceFileIds.map((_, i) => look.referenceRoles?.[i] ?? "other"),
    sheet: { ...(look.sheet ?? {}) },
    loras: (look.loras ?? []).map((lora) => ({ ...lora })),
    guidance: typeof look.guidance === "number" ? String(look.guidance) : "",
    negativePrompt: look.negativePrompt ?? "",
    width: width && height ? width : "",
    height: width && height ? height : "",
    safeContentFilter: look.safeContentFilter !== false,
  };
}

function ExternalLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "#1971c2" }}>
      {children}
    </a>
  );
}

function Chip({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "good" | "warn" }) {
  const colors = tone === "good" ? { bg: "#e6fcf5", fg: "#087f5b" } : tone === "warn" ? { bg: "#fff4e6", fg: "#b45309" } : { bg: "rgba(128,128,128,0.15)", fg: "inherit" };
  return <span style={{ background: colors.bg, color: colors.fg, borderRadius: 999, padding: "1px 8px", fontSize: 11, whiteSpace: "nowrap" }}>{children}</span>;
}

/** Searchable list of Sogni's models, with the chosen model's details under it. */
export function SogniModelPicker(props: {
  models: SogniModel[] | null;
  value: string;
  onPick: (model: SogniModel | null) => void;
  note?: string | null;
  disabled?: boolean;
}) {
  const { models, value, onPick, note, disabled } = props;
  const [query, setQuery] = useState("");
  const [showVariants, setShowVariants] = useState(false);
  const chosen = models?.find((m) => m.id === value) ?? null;
  const matches = models ? filterSogniModels(models, query, showVariants) : [];
  const shown = matches.slice(0, MODEL_LIST_LIMIT);
  return (
    <div style={field}>
      <span>Sogni model</span>
      {note ? <div style={{ opacity: 0.75, fontSize: 12 }}>{note}</div> : null}
      {models === null ? (
        <div style={{ opacity: 0.7 }}>Loading Sogni's models…</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ ...input, flex: "1 1 220px" }}
              placeholder={`Search ${models.length} models, for example "dark beast" or "anime"`}
              aria-label="Search Sogni models"
              disabled={disabled}
            />
            <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
              <input type="checkbox" checked={showVariants} onChange={(e) => setShowVariants(e.target.checked)} disabled={disabled} />
              Also show other builds (Mac and smaller versions)
            </label>
            {value ? (
              <button type="button" style={ghostBtn} onClick={() => onPick(null)} disabled={disabled}>
                Use the normal model
              </button>
            ) : null}
          </div>
          <div role="listbox" aria-label="Sogni models" style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto", border: "1px solid rgba(128,128,128,0.35)", borderRadius: 8, padding: 4 }}>
            {shown.length === 0 ? <div style={{ opacity: 0.7, padding: 6 }}>No model matches "{query}".</div> : null}
            {shown.map((model) => {
              const picked = model.id === value;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={picked}
                  disabled={disabled}
                  onClick={() => onPick(model)}
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    flexWrap: "wrap",
                    textAlign: "left",
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: picked ? "2px solid #1971c2" : "1px solid transparent",
                    background: picked ? "rgba(25,113,194,0.08)" : "transparent",
                    color: "inherit",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{model.name}</span>
                  <Chip tone={model.workersOnline ? "good" : model.workersOnline === 0 ? "warn" : "plain"}>{workersText(model)}</Chip>
                  {model.hasLoras ? <Chip>LoRAs</Chip> : null}
                  {!model.generates ? <Chip>Changes reference pictures</Chip> : null}
                  {model.contentFilter === "off-required" ? <Chip tone="warn">Filter off only</Chip> : null}
                  {model.tags.filter((tag) => tag !== "standard").map((tag) => (
                    <Chip key={tag}>{tag}</Chip>
                  ))}
                </button>
              );
            })}
          </div>
          {matches.length > shown.length ? (
            <div style={{ opacity: 0.7, fontSize: 12 }}>
              Showing {shown.length} of {matches.length} models. Type in the search box to find others.
            </div>
          ) : null}
        </>
      )}
      {value && !chosen && models !== null ? (
        <div style={{ opacity: 0.75, fontSize: 12 }}>Current model: {value} (not in Sogni's list right now).</div>
      ) : null}
      {chosen ? <SogniModelDetails model={chosen} /> : null}
    </div>
  );
}

function SogniModelDetails({ model }: { model: SogniModel }) {
  const notice = modelFilterNotice(model);
  return (
    <div style={{ ...card, gap: 4, fontSize: 12 }} aria-label="Chosen model">
      <div>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{model.name}</span> <span style={{ opacity: 0.7 }}>({model.id})</span>
      </div>
      <div style={{ opacity: 0.8 }}>
        {workersText(model)}
        {model.creator ? <> · Made by {model.creator}</> : null}
        {model.sourceUrl ? <> · <ExternalLink href={model.sourceUrl}>About this model</ExternalLink></> : null}
      </div>
      <div style={{ opacity: 0.8 }}>
        {model.width && model.height
          ? `Picture size: width ${rangeText(model.width)}, height ${rangeText(model.height)}.`
          : "Picture size: Sogni's usual sizes."}
        {model.steps ? ` Steps: ${rangeText(model.steps)} (Sogni picks them).` : ""}
        {model.guidance ? ` Guidance: ${rangeText(model.guidance)}.` : " Guidance cannot be changed for this model."}
      </div>
      {!model.generates ? (
        <div style={{ opacity: 0.8 }}>This model changes existing pictures: the look needs reference pictures.</div>
      ) : null}
      {notice ? <div style={{ color: "#b45309" }}>{notice}</div> : null}
    </div>
  );
}

/** The LoRAs on a look: add, remove, and set each one's strength inside its own range. */
export function SogniLoraSection(props: {
  model: SogniModel | null;
  available: SogniLora[] | null;
  picked: LookLora[];
  onChange: (next: LookLora[]) => void;
  maxLoras: number;
  filterOn: boolean;
  note?: string | null;
  disabled?: boolean;
}) {
  const { model, available, picked, onChange, maxLoras, filterOn, note, disabled } = props;
  const [adding, setAdding] = useState("");
  if (!model) {
    return (
      <div style={field}>
        <span>LoRAs</span>
        <div style={{ opacity: 0.7 }}>Pick a Sogni model first; LoRAs belong to one model.</div>
      </div>
    );
  }
  const addable = (available ?? []).filter((lora) => !picked.some((p) => p.id === lora.id));
  const full = picked.length >= maxLoras;
  const add = () => {
    const lora = addable.find((l) => l.id === adding);
    if (!lora || full) return;
    onChange([...picked, { id: lora.id, name: lora.name, strength: startingStrength(lora) }]);
    setAdding("");
  };
  return (
    <div style={field} aria-label="LoRAs">
      <span>
        LoRAs ({picked.length} of at most {maxLoras})
      </span>
      <div style={{ opacity: 0.75, fontSize: 12 }}>
        A LoRA nudges the model toward a style or trait. They are used in this order. Sogni does not add a LoRA's trigger
        words for you: if a LoRA's page says it needs a trigger word, put it in the style words above.
      </div>
      {note ? <div style={{ opacity: 0.75, fontSize: 12 }}>{note}</div> : null}
      {picked.map((pick, index) => {
        const lora = available?.find((l) => l.id === pick.id) ?? null;
        const step = lora?.step ?? 0.05;
        return (
          <div key={pick.id} style={{ ...card, gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
              <span style={{ fontWeight: 600 }}>
                {index + 1}. {lora?.name ?? pick.name}
                {lora?.personal ? " (your own)" : ""}
              </span>
              <button type="button" style={ghostBtn} disabled={disabled} onClick={() => onChange(picked.filter((p) => p.id !== pick.id))}>
                Remove
              </button>
            </div>
            {lora ? (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {lora.rangeLabels ? <span style={{ fontSize: 11, opacity: 0.7 }}>{lora.rangeLabels.min}</span> : null}
                  <input
                    type="range"
                    min={lora.min}
                    max={lora.max}
                    step={step}
                    value={pick.strength}
                    disabled={disabled}
                    aria-label={`Strength of ${lora.name}`}
                    onChange={(e) =>
                      onChange(picked.map((p) => (p.id === pick.id ? { ...p, strength: clampStrength(Number(e.target.value), lora) } : p)))
                    }
                    style={{ flex: 1 }}
                  />
                  {lora.rangeLabels ? <span style={{ fontSize: 11, opacity: 0.7 }}>{lora.rangeLabels.max}</span> : null}
                  <input
                    type="number"
                    min={lora.min}
                    max={lora.max}
                    step={step}
                    value={pick.strength}
                    disabled={disabled}
                    aria-label={`Strength number of ${lora.name}`}
                    onChange={(e) =>
                      onChange(picked.map((p) => (p.id === pick.id ? { ...p, strength: clampStrength(Number(e.target.value), lora) } : p)))
                    }
                    style={{ ...input, width: 80 }}
                  />
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  Strength {showNumber(lora.min)} to {showNumber(lora.max)}; its maker recommends {showNumber(lora.recommendedMin)} to{" "}
                  {showNumber(lora.recommendedMax)}.
                  {lora.creator ? ` By ${lora.creator}.` : ""} <ExternalLink href={lora.sourceUrl}>LoRA page (trigger words, examples)</ExternalLink>
                </div>
                {lora.needsFilterOff && filterOn ? (
                  <div style={{ color: "#b45309", fontSize: 12 }}>This LoRA only works with the Sensitive content filter off.</div>
                ) : null}
              </>
            ) : (
              <div style={{ fontSize: 12, color: "#b45309" }}>
                {available === null ? `Strength ${showNumber(pick.strength)}.` : `This LoRA does not work with ${model.name}. Remove it, or pick another model.`}
              </div>
            )}
          </div>
        );
      })}
      {available === null ? (
        <div style={{ opacity: 0.7 }}>Loading the LoRAs for {model.name}…</div>
      ) : available.length === 0 ? (
        <div style={{ opacity: 0.7 }}>Sogni has no LoRAs for {model.name} right now.</div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={adding} onChange={(e) => setAdding(e.target.value)} style={{ ...input, flex: "1 1 220px" }} disabled={disabled || full} aria-label="LoRA to add">
            <option value="">{full ? `The most a picture can use is ${maxLoras}` : "Pick a LoRA to add…"}</option>
            {addable.map((lora) => (
              <option key={lora.id} value={lora.id}>
                {lora.name}
                {lora.personal ? " (your own)" : ""}
                {lora.needsFilterOff ? " (filter off only)" : ""}
              </option>
            ))}
          </select>
          <button type="button" style={secondaryBtn} onClick={add} disabled={disabled || full || !adding}>
            Add LoRA
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * "Default look per agent": one row per agent with a select of the saved
 * looks or None. Saving is immediate; only an owner/admin can change it.
 */
export function LookDefaultsSection(props: {
  looks: Look[];
  agents: LookAgent[] | null;
  defaults: Record<string, string>;
  canManage: boolean;
  savingAgentId: string | null;
  error: string | null;
  onPick: (agentId: string, lookId: string) => void;
}) {
  const { looks, agents, defaults, canManage, savingAgentId, error, onPick } = props;
  return (
    <section aria-label="Default look per agent" style={{ ...card, gap: 8 }}>
      <div style={{ fontWeight: 600 }}>Default look per agent</div>
      <div style={{ opacity: 0.7, fontSize: 12 }}>
        When this agent makes a picture without naming a look, it uses this one. A look named in the request still wins.
      </div>
      {error ? <div style={errorBox}>{error}</div> : null}
      {agents === null ? (
        error ? null : <div style={{ opacity: 0.7 }}>Loading the agents…</div>
      ) : agents.length === 0 ? (
        <div style={{ opacity: 0.7 }}>This company has no agents yet.</div>
      ) : looks.length === 0 ? (
        <div style={{ opacity: 0.7 }}>Save a look first; then you can make it an agent's default.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {agents.map((agent) => (
            <label key={agent.id} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 180px" }}>
                {agent.name}
                {agent.title ? <span style={{ opacity: 0.6 }}> · {agent.title}</span> : null}
              </span>
              <select
                aria-label={`Default look for ${agent.name}`}
                value={defaults[agent.id] ?? ""}
                disabled={!canManage || savingAgentId !== null}
                onChange={(e) => onPick(agent.id, e.target.value)}
                style={{ ...input, flex: "1 1 200px" }}
              >
                <option value="">None</option>
                {looks.map((look) => (
                  <option key={look.id} value={look.id}>
                    {look.name}
                  </option>
                ))}
              </select>
              {savingAgentId === agent.id ? <span style={{ fontSize: 12, opacity: 0.7 }}>Saving…</span> : null}
            </label>
          ))}
        </div>
      )}
      {!canManage ? (
        <div style={{ opacity: 0.7, fontSize: 12 }}>Only the company's owner or an admin can change an agent's default look.</div>
      ) : null}
    </section>
  );
}

// ─── Automatic looks (look rules) ────────────────────────────────────────────
//
// A person's (or a job's) ordered list of rules: "from 08:00 to 12:00 use look
// X", "when the message says 'work' use look Y". The worker decides what fits
// (the preview asks it), so the page and the pictures can never disagree.
// Every change is saved at once; only an owner/admin can change anything.

export const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];
const WEEKDAY_LABEL: Record<WeekdayKey, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

export type RuleWindow = { from: string; to: string; days?: WeekdayKey[] };
export type LookRuleUi = { id?: string; lookId: string; enabled: boolean; timeWindows?: RuleWindow[]; keywords?: string[] };
export type RuleSetUi = { timezone: string; rules: LookRuleUi[] };
export type RuleOwnerJob = { id: string; name: string; title: string | null; defaultLookId: string | null };
export type RuleOwner = { key: string; kind: "persona" | "agent"; name: string; jobs: RuleOwnerJob[] };
type LookRulesListResponse = { owners?: RuleOwner[]; ruleSets?: Record<string, RuleSetUi>; defaultTimezone?: string; canManage?: boolean };
type LookRulesPreview = {
  timezone: string;
  localTime: string;
  rule: { id: string; position: number; lookId: string; lookName: string; why: string } | null;
  fallbacks: Array<{ agentId: string; agentName: string; lookName: string | null }>;
};

const FALLBACK_TIMEZONE = "Europe/Oslo";
const COMMON_TIMEZONES = ["Europe/Oslo", "Europe/Stockholm", "Europe/Copenhagen", "Europe/Helsinki", "Europe/London", "Europe/Berlin", "UTC", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Every time zone the browser knows, with the common ones first and the current one always there. */
export function timezoneOptions(current: string): string[] {
  let all: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    all = intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
  } catch {
    all = [];
  }
  return [...new Set([current, ...COMMON_TIMEZONES, ...all].filter(Boolean))];
}

/** "on weekdays", "at weekends", "on Mon, Wed" or "" (every day). */
export function daysInWords(days: WeekdayKey[] | undefined): string {
  const set = new Set(days ?? []);
  if (set.size === 0 || set.size === 7) return "";
  const exactly = (list: WeekdayKey[]) => set.size === list.length && list.every((d) => set.has(d));
  if (exactly(["mon", "tue", "wed", "thu", "fri"])) return "on weekdays";
  if (exactly(["sat", "sun"])) return "at weekends";
  return `on ${WEEKDAY_KEYS.filter((d) => set.has(d)).map((d) => WEEKDAY_LABEL[d]).join(", ")}`;
}

/** The rule in one sentence: "Night, from 20:00 to 02:00 at weekends, when the message says "party"". */
export function ruleInWords(rule: LookRuleUi, looks: Array<{ id: string; name: string }>): string {
  const name = looks.find((l) => l.id === rule.lookId)?.name ?? "A look that no longer exists";
  const parts: string[] = [];
  const windows = rule.timeWindows ?? [];
  if (windows.length > 0) {
    parts.push(windows.map((w) => `from ${w.from} to ${w.to}${daysInWords(w.days) ? ` ${daysInWords(w.days)}` : ""}`).join(" or "));
  }
  const keywords = rule.keywords ?? [];
  if (keywords.length > 0) parts.push(`when the message says ${keywords.map((k) => `"${k}"`).join(" or ")}`);
  return `${name}, ${parts.join(", and ") || "no time or keyword yet"}`;
}

/** A rule the worker would accept: a look, and a time or a keyword, with every time written as HH:MM. */
export function ruleIsReady(rule: LookRuleUi): boolean {
  const windows = rule.timeWindows ?? [];
  const keywords = (rule.keywords ?? []).filter((k) => k.trim());
  if (!rule.lookId || (windows.length === 0 && keywords.length === 0)) return false;
  return windows.every((w) => HHMM.test(w.from) && HHMM.test(w.to) && w.from !== w.to && (w.days === undefined || w.days.length > 0));
}

/** Move one rule to another place in the list (drag and drop, or the up/down buttons). */
export function moveRule<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

function toggleDay(days: WeekdayKey[] | undefined, day: WeekdayKey): WeekdayKey[] {
  const current = new Set(days && days.length > 0 ? days : WEEKDAY_KEYS);
  if (current.has(day)) current.delete(day);
  else current.add(day);
  return WEEKDAY_KEYS.filter((d) => current.has(d));
}

/** One rule's look, times and keywords. Used for a saved rule (each change saved) and for a new one. */
function LookRuleEditor(props: {
  rule: LookRuleUi;
  looks: Array<{ id: string; name: string }>;
  disabled: boolean;
  label: string;
  onChange: (rule: LookRuleUi) => void;
}) {
  const { rule, looks, disabled, label, onChange } = props;
  const [keywordText, setKeywordText] = useState("");
  const windows = rule.timeWindows ?? [];
  const keywords = rule.keywords ?? [];
  const conditionCount = windows.length + keywords.length;

  const setWindow = (index: number, patch: Partial<RuleWindow>) =>
    onChange({ ...rule, timeWindows: windows.map((w, i) => (i === index ? { ...w, ...patch } : w)) });
  const addKeyword = () => {
    const keyword = keywordText.trim().replace(/\s+/g, " ");
    if (!keyword) return;
    setKeywordText("");
    if (keywords.some((k) => k.toLowerCase() === keyword.toLowerCase())) return;
    onChange({ ...rule, keywords: [...keywords, keyword] });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span>Use the look</span>
        <select
          aria-label={`Look for ${label}`}
          value={rule.lookId}
          disabled={disabled}
          onChange={(e) => onChange({ ...rule, lookId: e.target.value })}
          style={{ ...input, flex: "1 1 180px" }}
        >
          {looks.some((l) => l.id === rule.lookId) ? null : <option value={rule.lookId}>Pick a look</option>}
          {looks.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, opacity: 0.8 }}>At these times (leave out for any time)</span>
        {windows.map((w, i) => (
          <div key={i} role="group" aria-label={`Time ${i + 1} for ${label}`} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span>From</span>
            <input type="time" aria-label="From" value={w.from} disabled={disabled} onChange={(e) => setWindow(i, { from: e.target.value })} style={input} />
            <span>up to</span>
            <input type="time" aria-label="Up to" value={w.to} disabled={disabled} onChange={(e) => setWindow(i, { to: e.target.value })} style={input} />
            <span style={{ display: "flex", gap: 2 }}>
              {WEEKDAY_KEYS.map((day) => {
                const on = !w.days || w.days.length === 0 || w.days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    disabled={disabled}
                    onClick={() => {
                      const days = toggleDay(w.days, day);
                      setWindow(i, { days: days.length === 7 ? undefined : days });
                    }}
                    style={{ ...baseBtn, padding: "4px 6px", background: on ? "#1971c2" : "transparent", color: on ? "#fff" : "inherit", borderColor: "#a5d8ff" }}
                  >
                    {WEEKDAY_LABEL[day]}
                  </button>
                );
              })}
            </span>
            <button
              type="button"
              style={ghostBtn}
              disabled={disabled || conditionCount <= 1}
              title={conditionCount <= 1 ? "A rule needs a time or a keyword" : undefined}
              onClick={() => onChange({ ...rule, timeWindows: windows.filter((_, j) => j !== i) })}
            >
              Remove time
            </button>
            {w.from && w.to && w.to < w.from ? <span style={{ fontSize: 12, opacity: 0.7 }}>(runs past midnight)</span> : null}
          </div>
        ))}
        {!disabled && windows.length < 6 ? (
          <div>
            <button type="button" style={secondaryBtn} onClick={() => onChange({ ...rule, timeWindows: [...windows, { from: "09:00", to: "17:00" }] })}>
              Add a time
            </button>
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, opacity: 0.8 }}>When the person's message says (any of these words; leave out for any message)</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {keywords.map((keyword) => (
            <span key={keyword} style={{ display: "inline-flex", gap: 4, alignItems: "center", padding: "2px 8px", borderRadius: 999, background: "rgba(25,113,194,0.12)" }}>
              {keyword}
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove keyword ${keyword}`}
                  disabled={conditionCount <= 1}
                  title={conditionCount <= 1 ? "A rule needs a time or a keyword" : undefined}
                  onClick={() => onChange({ ...rule, keywords: keywords.filter((k) => k !== keyword) })}
                  style={{ border: "none", background: "none", cursor: "pointer", color: "inherit", padding: 0 }}
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
          {!disabled ? (
            <>
              <input
                aria-label={`New keyword for ${label}`}
                value={keywordText}
                maxLength={40}
                placeholder="work"
                onChange={(e) => setKeywordText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addKeyword();
                  }
                }}
                style={{ ...input, width: 140 }}
              />
              <button type="button" style={secondaryBtn} onClick={addKeyword} disabled={!keywordText.trim()}>
                Add keyword
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function AutomaticLooksSection(props: { looks: Array<{ id: string; name: string }>; defaults: Record<string, string> }) {
  const { looks, defaults } = props;
  const listRules = usePluginAction(ACTION_LOOK_RULES_LIST);
  const saveRules = usePluginAction(ACTION_LOOK_RULES_SAVE);
  const previewRules = usePluginAction(ACTION_LOOK_RULES_PREVIEW);

  const [owners, setOwners] = useState<RuleOwner[] | null>(null);
  const [sets, setSets] = useState<Record<string, RuleSetUi>>({});
  const [defaultTimezone, setDefaultTimezone] = useState(FALLBACK_TIMEZONE);
  const [canManage, setCanManage] = useState(false);
  const [ownerKey, setOwnerKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState<LookRuleUi | null>(null);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<LookRulesPreview | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const saveSeq = useRef(0);
  const lookIds = looks.map((l) => l.id).join(",");

  // Reloaded when the looks change: deleting a look also deletes its rules.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = ((await listRules({})) ?? {}) as LookRulesListResponse;
        if (cancelled) return;
        const list = res.owners ?? [];
        setOwners(list);
        setSets(res.ruleSets ?? {});
        setDefaultTimezone(res.defaultTimezone ?? FALLBACK_TIMEZONE);
        setCanManage(res.canManage === true);
        setOwnerKey((key) => (list.some((o) => o.key === key) ? key : (list[0]?.key ?? "")));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [listRules, lookIds]);

  const owner = owners?.find((o) => o.key === ownerKey) ?? null;
  const set: RuleSetUi = sets[ownerKey] ?? { timezone: defaultTimezone, rules: [] };
  const defaultsKey = Object.entries(defaults).map(([a, l]) => `${a}=${l}`).join(",");

  // "Right now this would pick": asked of the worker, a moment after typing stops.
  useEffect(() => {
    if (!ownerKey) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        try {
          const res = (await previewRules({ ownerKey, message })) as LookRulesPreview | undefined;
          if (!cancelled) setPreview(res && Array.isArray(res.fallbacks) ? res : null);
        } catch {
          if (!cancelled) setPreview(null);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [previewRules, ownerKey, message, savedCount, defaultsKey, lookIds]);

  /** Save the owner's whole list at once (the order is the priority). Shown at once; put back if saving fails. */
  const persist = async (next: RuleSetUi) => {
    const key = ownerKey;
    const before = sets[key];
    setSets((all) => ({ ...all, [key]: next }));
    if (!next.rules.every(ruleIsReady)) return; // Saved once every time is filled in.
    const seq = ++saveSeq.current;
    setSaving(true);
    setError(null);
    try {
      const res = (await saveRules({ ownerKey: key, timezone: next.timezone, rules: next.rules })) as { ruleSet?: RuleSetUi };
      if (seq === saveSeq.current && res.ruleSet) setSets((all) => ({ ...all, [key]: res.ruleSet! }));
      setSavedCount((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (seq === saveSeq.current) setSets((all) => (before ? { ...all, [key]: before } : Object.fromEntries(Object.entries(all).filter(([k]) => k !== key))));
    } finally {
      if (seq === saveSeq.current) setSaving(false);
    }
  };

  const updateRule = (index: number, rule: LookRuleUi) => void persist({ ...set, rules: set.rules.map((r, i) => (i === index ? rule : r)) });
  const move = (from: number, to: number) => {
    const rules = moveRule(set.rules, from, to);
    if (rules !== set.rules) void persist({ ...set, rules });
  };
  const removeRule = (index: number) => {
    if (typeof window !== "undefined" && !window.confirm("Delete this rule?")) return;
    void persist({ ...set, rules: set.rules.filter((_, i) => i !== index) });
  };
  const addRule = async () => {
    if (!adding || !ruleIsReady(adding)) return;
    await persist({ ...set, rules: [...set.rules, adding] });
    setAdding(null);
  };

  const jobsText = (o: RuleOwner) => (o.kind === "persona" ? ` (${o.jobs.map((j) => j.name).join(", ")})` : "");
  const people = (owners ?? []).filter((o) => o.kind === "persona");
  const jobsAlone = (owners ?? []).filter((o) => o.kind === "agent");
  const lookName = (id: string | null | undefined) => (id ? (looks.find((l) => l.id === id)?.name ?? null) : null);

  return (
    <section aria-label="Automatic looks" style={{ ...card, gap: 10 }}>
      <div style={{ fontWeight: 600 }}>Automatic looks</div>
      <div style={{ opacity: 0.7, fontSize: 12 }}>
        Pick a look by time of day or by words in the person's message. When no look is named, the rules are checked from
        the top and the first one that fits right now is used; a rule that does not fit right now is skipped. If none fits,
        the default look is used. A person's rules are shared by all of that person's jobs. Drag a rule (or use the arrows)
        to change the order. Changes are saved at once.
      </div>
      {error ? <div style={errorBox}>{error}</div> : null}
      {owners === null ? (
        error ? null : <div style={{ opacity: 0.7 }}>Loading…</div>
      ) : owners.length === 0 ? (
        <div style={{ opacity: 0.7 }}>This company has no agents yet.</div>
      ) : looks.length === 0 ? (
        <div style={{ opacity: 0.7 }}>Save a look first; then you can choose when it is used.</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", flex: "1 1 260px" }}>
              <span>For</span>
              <select aria-label="Person or agent" value={ownerKey} onChange={(e) => { setOwnerKey(e.target.value); setAdding(null); }} style={{ ...input, flex: 1 }}>
                {people.length > 0 ? (
                  <optgroup label="People">
                    {people.map((o) => (
                      <option key={o.key} value={o.key}>{`${o.name}${jobsText(o)}`}</option>
                    ))}
                  </optgroup>
                ) : null}
                {jobsAlone.length > 0 ? (
                  <optgroup label="Agents without a person">
                    {jobsAlone.map((o) => (
                      <option key={o.key} value={o.key}>{o.name}</option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", flex: "1 1 220px" }}>
              <span>Time zone</span>
              <select
                aria-label="Time zone"
                value={set.timezone}
                disabled={!canManage}
                onChange={(e) => void persist({ ...set, timezone: e.target.value })}
                style={{ ...input, flex: 1 }}
              >
                {timezoneOptions(set.timezone).map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </label>
          </div>

          {owner ? (
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              {owner.jobs.length === 1
                ? `Default look when no rule fits: ${lookName(defaults[owner.jobs[0]!.id]) ?? "none"}.`
                : `Default look when no rule fits: ${owner.jobs.map((j) => `${j.name}: ${lookName(defaults[j.id]) ?? "none"}`).join("; ")}.`}{" "}
              (Set it under "Default look per agent" above.)
            </div>
          ) : null}

          {set.rules.length === 0 ? (
            <div style={{ opacity: 0.7 }}>No rules yet{owner ? ` for ${owner.name}` : ""}.</div>
          ) : (
            <ol aria-label="Rules in priority order" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {set.rules.map((rule, index) => {
                const label = `rule ${index + 1}`;
                const fitsNow = preview?.rule?.position === index + 1;
                return (
                  <li
                    key={rule.id ?? `new-${index}`}
                    data-rule-row={index}
                    aria-label={`Rule ${index + 1}: ${ruleInWords(rule, looks)}`}
                    onDragOver={(e) => {
                      if (dragFrom === null) return;
                      e.preventDefault();
                      setDragOver(index);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragFrom !== null) move(dragFrom, index);
                      setDragFrom(null);
                      setDragOver(null);
                    }}
                    style={{
                      ...card,
                      gap: 8,
                      opacity: rule.enabled ? 1 : 0.6,
                      borderColor: dragOver === index && dragFrom !== index ? "#1971c2" : fitsNow ? "#087f5b" : "rgba(128,128,128,0.35)",
                    }}
                  >
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {canManage ? (
                        <span
                          draggable
                          role="button"
                          tabIndex={-1}
                          aria-label={`Drag ${label} to another place`}
                          title="Drag to change the order"
                          onDragStart={(e) => {
                            setDragFrom(index);
                            try {
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", String(index));
                              const row = (e.currentTarget as HTMLElement).closest("li");
                              if (row) e.dataTransfer.setDragImage(row, 12, 12);
                            } catch {
                              // Some browsers (and tests) have no drag data; the order is kept in state.
                            }
                          }}
                          onDragEnd={() => {
                            setDragFrom(null);
                            setDragOver(null);
                          }}
                          style={{ cursor: "grab", userSelect: "none", fontSize: 16, padding: "0 4px" }}
                        >
                          ⠿
                        </span>
                      ) : null}
                      <span style={{ fontWeight: 600 }}>{index + 1}.</span>
                      <span style={{ flex: "1 1 200px" }}>{ruleInWords(rule, looks)}</span>
                      {fitsNow ? <span style={{ fontSize: 12, color: "#087f5b" }}>Fits right now</span> : null}
                      <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                        <input
                          type="checkbox"
                          aria-label={`${label} on`}
                          checked={rule.enabled}
                          disabled={!canManage}
                          onChange={(e) => updateRule(index, { ...rule, enabled: e.target.checked })}
                        />
                        On
                      </label>
                      {canManage ? (
                        <span style={{ display: "flex", gap: 4 }}>
                          <button type="button" style={ghostBtn} aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => move(index, index - 1)}>
                            ↑
                          </button>
                          <button
                            type="button"
                            style={ghostBtn}
                            aria-label={`Move ${label} down`}
                            disabled={index === set.rules.length - 1}
                            onClick={() => move(index, index + 1)}
                          >
                            ↓
                          </button>
                          <button type="button" style={ghostBtn} onClick={() => removeRule(index)}>
                            Delete
                          </button>
                        </span>
                      ) : null}
                    </div>
                    {canManage ? (
                      <LookRuleEditor rule={rule} looks={looks} disabled={false} label={label} onChange={(next) => updateRule(index, next)} />
                    ) : null}
                    {canManage && !ruleIsReady(rule) ? (
                      <div style={{ fontSize: 12, color: "#b45309" }}>Not saved yet: fill in both times (like 08:00) and pick at least one day.</div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}

          {canManage && !adding ? (
            <div>
              <button
                type="button"
                style={primaryBtn}
                disabled={saving}
                onClick={() => setAdding({ lookId: looks[0]!.id, enabled: true, timeWindows: [{ from: "08:00", to: "12:00" }], keywords: [] })}
              >
                Add a rule
              </button>
            </div>
          ) : null}
          {adding ? (
            <div style={{ ...card, gap: 8 }} aria-label="New rule">
              <div style={{ fontWeight: 600 }}>New rule</div>
              <LookRuleEditor rule={adding} looks={looks} disabled={false} label="the new rule" onChange={setAdding} />
              {!ruleIsReady(adding) ? <div style={{ fontSize: 12, opacity: 0.7 }}>A rule needs a time or a keyword (or both).</div> : null}
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" style={primaryBtn} disabled={saving || !ruleIsReady(adding)} onClick={() => void addRule()}>
                  Add rule
                </button>
                <button type="button" style={ghostBtn} onClick={() => setAdding(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {!canManage ? <div style={{ opacity: 0.7, fontSize: 12 }}>Only the company's owner or an admin can change automatic looks.</div> : null}

          <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid rgba(128,128,128,0.25)", paddingTop: 8 }}>
            <label style={field}>
              <span>Try a message</span>
              <input
                aria-label="Test message"
                value={message}
                placeholder="Make a picture for work"
                onChange={(e) => setMessage(e.target.value)}
                style={input}
              />
            </label>
            <div aria-live="polite" data-testid="look-rules-preview">
              {preview === null ? (
                <span style={{ opacity: 0.7 }}>Working out what would be picked…</span>
              ) : preview.rule ? (
                <span>
                  Right now ({preview.localTime}, {preview.timezone}) this would pick: <strong>{preview.rule.lookName}</strong> ({preview.rule.why}).
                </span>
              ) : preview.fallbacks.length === 1 ? (
                <span>
                  Right now ({preview.localTime}, {preview.timezone}) no rule fits, so this would pick:{" "}
                  <strong>{preview.fallbacks[0]!.lookName ?? "no look"}</strong> ({preview.fallbacks[0]!.lookName ? "default look" : "there is no default look"}).
                </span>
              ) : (
                <span>
                  Right now ({preview.localTime}, {preview.timezone}) no rule fits, so each job uses its default look:{" "}
                  {preview.fallbacks.map((f) => `${f.agentName}: ${f.lookName ?? "no look"}`).join("; ")}.
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export function MediaStudioLooksPage({ context }: PluginCompanySettingsPageProps) {
  const companyId = context.companyId;
  const listLooks = usePluginAction(ACTION_LOOKS_LIST);
  const saveLook = usePluginAction(ACTION_LOOKS_SAVE);
  const deleteLook = usePluginAction(ACTION_LOOKS_DELETE);
  const listSogniModels = usePluginAction(ACTION_SOGNI_MODELS);
  const listSogniLoras = usePluginAction(ACTION_SOGNI_LORAS);
  const listLookDefaults = usePluginAction(ACTION_LOOK_DEFAULTS_LIST);
  const setLookDefault = usePluginAction(ACTION_LOOK_DEFAULTS_SET);
  const previewPrompt = usePluginAction(ACTION_LOOK_PROMPT_PREVIEW);

  const [looks, setLooks] = useState<Look[]>([]);
  const [agents, setAgents] = useState<LookAgent[] | null>(null);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [savingDefaultFor, setSavingDefaultFor] = useState<string | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [maxRefs, setMaxRefs] = useState(4);
  const [draft, setDraft] = useState<LookDraft | null>(null);
  const [images, setImages] = useState<CompanyImage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sogniModels, setSogniModels] = useState<SogniModelsResponse | null>(null);
  const [sogniLoras, setSogniLoras] = useState<SogniLorasResponse | null>(null);
  const [sampleRequest, setSampleRequest] = useState(DEFAULT_SAMPLE_REQUEST);
  const [promptPreview, setPromptPreview] = useState<PromptPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = (await listLooks({})) as LooksResponse;
      setLooks(res.looks ?? []);
      setCanManage(res.canManage === true);
      if (typeof res.maxReferenceFiles === "number") setMaxRefs(res.maxReferenceFiles);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [listLooks]);

  useEffect(() => {
    void load();
  }, [load]);

  // The agents and their default looks: their own call, so a problem here does not hide the looks.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await listLookDefaults({})) as LookDefaultsResponse;
        if (cancelled) return;
        setAgents(res.agents ?? []);
        setDefaults(res.defaults ?? {});
      } catch (e) {
        if (cancelled) return;
        // Leave the list empty (not "no agents"): the error says what went wrong.
        setDefaultsError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [listLookDefaults]);

  const onPickDefault = async (agentId: string, lookId: string) => {
    setSavingDefaultFor(agentId);
    setDefaultsError(null);
    try {
      const res = (await setLookDefault({ agentId, lookId: lookId || null })) as LookDefaultsResponse;
      setDefaults(res.defaults ?? {});
    } catch (e) {
      setDefaultsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingDefaultFor(null);
    }
  };

  const wantsSogni = draft?.provider === "sogni";
  const draftModel = draft?.model ?? "";

  // Sogni's model list, read once the editor is on Sogni.
  useEffect(() => {
    if (!wantsSogni || sogniModels) return;
    let cancelled = false;
    (async () => {
      try {
        const res = (await listSogniModels({})) as SogniModelsResponse;
        if (!cancelled) setSogniModels(res);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setSogniModels({ models: [], live: false, note: "Sogni's models could not be loaded." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wantsSogni, sogniModels, listSogniModels]);

  // The LoRAs for the chosen model.
  useEffect(() => {
    if (!wantsSogni || !draftModel) {
      setSogniLoras(null);
      return;
    }
    let cancelled = false;
    setSogniLoras(null);
    (async () => {
      try {
        const res = (await listSogniLoras({ modelId: draftModel })) as SogniLorasResponse;
        if (!cancelled) setSogniLoras(res);
      } catch (e) {
        if (!cancelled) setSogniLoras({ modelId: draftModel, loras: [], note: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wantsSogni, draftModel, listSogniLoras]);

  const loadImages = useCallback(async () => {
    if (!companyId || images) return;
    try {
      const res = await hostFetchJson<{ artifacts?: Array<{ title: string; contentPath: string | null; mediaKind: string }> }>(
        `/api/companies/${companyId}/artifacts?kind=image&limit=100`,
      );
      const found: CompanyImage[] = [];
      for (const artifact of res.artifacts ?? []) {
        const match = artifact.contentPath ? ATTACHMENT_PATH.exec(artifact.contentPath) : null;
        if (!match || found.some((img) => img.fileId === match[1])) continue;
        found.push({ fileId: match[1], title: artifact.title, src: artifact.contentPath! });
      }
      setImages(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setImages([]);
    }
  }, [companyId, images]);

  const startEdit = (look: Look | null) => {
    setError(null);
    setPromptPreview(null);
    setPreviewError(null);
    setDraft(look ? lookToDraft(look) : { ...EMPTY_DRAFT });
    setSheetOpen(Boolean(look?.sheet && Object.keys(look.sheet).length > 0));
    void loadImages();
  };

  // Picking or unpicking a picture keeps each picture's role with it.
  const toggleRef = (fileId: string, limit: number) => {
    setDraft((d) => {
      if (!d) return d;
      const roles = draftRoles(d);
      const at = d.referenceFileIds.indexOf(fileId);
      if (at >= 0) {
        return {
          ...d,
          referenceFileIds: d.referenceFileIds.filter((id) => id !== fileId),
          referenceRoles: roles.filter((_, i) => i !== at),
        };
      }
      if (d.referenceFileIds.length >= limit) return d;
      return { ...d, referenceFileIds: [...d.referenceFileIds, fileId], referenceRoles: [...roles, "other"] };
    });
  };

  const setRole = (index: number, role: string) => {
    setDraft((d) => (d ? { ...d, referenceRoles: draftRoles(d).map((r, i) => (i === index ? role : r)) } : d));
  };

  const setSheetField = (key: string, value: string) => {
    setDraft((d) => (d ? { ...d, sheet: { ...(d.sheet ?? {}), [key]: value } } : d));
  };

  const onPreviewPrompt = async () => {
    if (!draft) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const res = (await previewPrompt({ ...draftToSaveParams(draft), request: sampleRequest })) as PromptPreviewResult;
      setPromptPreview(res);
    } catch (e) {
      setPromptPreview(null);
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  // A new model starts with no LoRAs or model settings: those belong to one model.
  const pickModel = (model: SogniModel | null) => {
    setDraft((d) =>
      d && (model?.id ?? "") !== d.model && (model === null || model.id !== sogniLoras?.modelId)
        ? { ...d, model: model?.id ?? "", loras: [], guidance: "", negativePrompt: "", width: "", height: "" }
        : d,
    );
  };

  const onSave = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const res = (await saveLook(draftToSaveParams(draft))) as LooksResponse;
      setLooks(res.looks ?? []);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (look: Look) => {
    if (typeof window !== "undefined" && !window.confirm(`Delete the look "${look.name}"? Pictures already made with it are kept.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = (await deleteLook({ id: look.id })) as LooksResponse;
      setLooks(res.looks ?? []);
      // Deleting a look also clears it as any agent's default.
      if (res.defaults) setDefaults(res.defaults);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // An older look may name its model by Sogni's short key; the worker answers with the catalog id.
  const chosenModel = wantsSogni
    ? (sogniModels?.models.find((m) => m.id === draftModel || (sogniLoras !== null && m.id === sogniLoras.modelId)) ?? null)
    : null;
  const maxLoras = sogniLoras?.maxLoras ?? sogniModels?.maxLoras ?? DEFAULT_MAX_LORAS;
  const refLimit = draft ? referenceLimitFor(draft.provider, chosenModel, maxRefs) : maxRefs;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, fontSize: 13, maxWidth: 820 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 16 }}>Media Studio looks</div>
        <div style={{ opacity: 0.7, marginTop: 4 }}>
          A look keeps pictures consistent: its style words and character sheet (hair, face, outfit and so on) are added
          to every picture made with it, and it can fix the seed and use reference pictures from your Files, each with a
          role (face, body, outfit, style, background), to keep the same person, product or style. With
          Sogni, a look can also use one specific model and that model's LoRAs. Agents can use looks by name (for example
          "make a banner in our catalogue look"), but only the company's owner or an admin can change them.
        </div>
      </div>

      {error ? <div style={errorBox}>{error}</div> : null}

      {looks.length === 0 ? (
        <div style={{ opacity: 0.7 }}>No looks are saved yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {looks.map((look) => (
            <div key={look.id} style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <span style={{ fontWeight: 600 }}>{look.name}</span>
                {canManage ? (
                  <span style={{ display: "flex", gap: 8 }}>
                    <button type="button" style={ghostBtn} disabled={busy} onClick={() => startEdit(look)}>Edit</button>
                    <button type="button" style={ghostBtn} disabled={busy} onClick={() => void onDelete(look)}>Delete</button>
                  </span>
                ) : null}
              </div>
              {look.style ? <div style={{ whiteSpace: "pre-wrap" }}>{look.style}</div> : <div style={{ opacity: 0.6 }}>No style words.</div>}
              <div style={{ opacity: 0.7, fontSize: 12 }}>
                {look.seed !== null ? `Fixed seed ${look.seed}` : "New seed each time"}
                {look.provider ? ` · Made with ${SERVICE_LABEL[look.provider] ?? look.provider}` : ""}
                {look.model ? ` · Model ${look.modelName ?? look.model}` : ""}
                {look.loras && look.loras.length > 0
                  ? ` · LoRAs: ${look.loras.map((lora) => `${lora.name} (${showNumber(lora.strength)})`).join(", ")}`
                  : ""}
                {look.safeContentFilter === false ? " · Content filter off" : ""}
              </div>
              {look.sheet && Object.keys(look.sheet).length > 0 ? (
                <div style={{ opacity: 0.7, fontSize: 12 }}>
                  Character sheet: {SHEET_FIELD_OPTIONS.filter((f) => look.sheet?.[f.key]).map((f) => f.label).join(", ")}
                </div>
              ) : null}
              {look.referenceFileIds.length > 0 ? (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {look.referenceFileIds.map((id, i) => (
                    <figure key={id} style={{ margin: 0, display: "flex", flexDirection: "column", gap: 2, alignItems: "center" }}>
                      <img src={thumbnailPathFor(fileContentPath(id))} loading="lazy" alt="Reference picture" style={thumb} />
                      <figcaption style={{ fontSize: 11, opacity: 0.7 }}>{roleLabel(look.referenceRoles?.[i])}</figcaption>
                    </figure>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {canManage && !draft ? (
        <div>
          <button type="button" style={primaryBtn} onClick={() => startEdit(null)}>Add a look</button>
        </div>
      ) : null}
      {!canManage ? (
        <div style={{ opacity: 0.7, fontSize: 12 }}>Only the company's owner or an admin can add or change looks.</div>
      ) : null}

      {!draft ? (
        <LookDefaultsSection
          looks={looks}
          agents={agents}
          defaults={defaults}
          canManage={canManage}
          savingAgentId={savingDefaultFor}
          error={defaultsError}
          onPick={(agentId, lookId) => void onPickDefault(agentId, lookId)}
        />
      ) : null}
      {!draft ? <AutomaticLooksSection looks={looks} defaults={defaults} /> : null}

      {draft ? (
        <div style={{ ...card, gap: 10 }}>
          <div style={{ fontWeight: 600 }}>{draft.id ? "Edit look" : "New look"}</div>
          <label style={field}>
            <span>Name</span>
            <input value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={input} placeholder="Catalogue" />
          </label>
          <label style={field}>
            <span>Style words added to every picture</span>
            <textarea
              value={draft.style}
              maxLength={1000}
              rows={3}
              onChange={(e) => setDraft({ ...draft, style: e.target.value })}
              style={{ ...input, resize: "vertical" }}
              placeholder="Soft daylight, Scandinavian living room, light oak and linen, photographed at eye level"
            />
          </label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ ...field, flex: "1 1 200px" }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  aria-label="Lock seed"
                  checked={draft.seed !== ""}
                  onChange={(e) => setDraft({ ...draft, seed: e.target.checked ? (draft.seed || randomSeed()) : "" })}
                />
                <span>Lock seed</span>
              </label>
              {draft.seed !== "" ? (
                <input
                  aria-label="Seed"
                  value={draft.seed}
                  inputMode="numeric"
                  onChange={(e) => setDraft({ ...draft, seed: e.target.value.replace(/[^0-9]/g, "") })}
                  style={input}
                />
              ) : null}
              <span style={{ fontSize: 12, opacity: 0.75 }}>
                A fixed seed with the same character sheet gives the most consistent results. Off: a new seed each time.
                (Sogni does not use a seed for pictures made from reference pictures.)
              </span>
            </div>
            <label style={{ ...field, flex: "1 1 160px" }}>
              <span>Picture service</span>
              <select
                value={draft.provider}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    provider: e.target.value,
                    // A model belongs to one service.
                    model: e.target.value === draft.provider ? draft.model : "",
                    loras: e.target.value === "sogni" ? draft.loras : [],
                  })
                }
                style={input}
              >
                <option value="">The normal one (from settings)</option>
                <option value="fal">Fal.ai</option>
                <option value="sogni">Sogni</option>
              </select>
            </label>
            {draft.provider !== "sogni" ? (
              <label style={{ ...field, flex: "2 1 240px" }}>
                <span>Model (optional)</span>
                <input
                  value={draft.model}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  style={input}
                  placeholder={draft.provider === "fal" ? "For example fal-ai/flux/dev" : "Leave empty to use the normal one"}
                />
              </label>
            ) : null}
          </div>

          {wantsSogni ? (
            <>
              <SogniModelPicker
                models={sogniModels?.models ?? null}
                value={chosenModel?.id ?? draft.model}
                onPick={pickModel}
                note={sogniModels?.note ?? null}
                disabled={busy}
              />
              <SogniLoraSection
                model={chosenModel ?? (draft.model ? { ...UNKNOWN_MODEL, id: draft.model, name: draft.model } : null)}
                available={sogniLoras ? sogniLoras.loras : null}
                picked={draft.loras}
                onChange={(loras) => setDraft((d) => (d ? { ...d, loras } : d))}
                maxLoras={maxLoras}
                filterOn={draft.safeContentFilter}
                note={sogniLoras?.note ?? null}
                disabled={busy}
              />
              {chosenModel ? (
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {chosenModel.guidance ? (
                    <label style={{ ...field, flex: "1 1 160px" }}>
                      <span>Guidance (optional, {rangeText(chosenModel.guidance)})</span>
                      <input
                        type="number"
                        min={chosenModel.guidance.min}
                        max={chosenModel.guidance.max}
                        step={chosenModel.guidance.step ?? 0.1}
                        value={draft.guidance}
                        onChange={(e) => setDraft({ ...draft, guidance: e.target.value })}
                        style={input}
                        placeholder={`Sogni's usual: ${showNumber(chosenModel.guidance.default)}`}
                      />
                    </label>
                  ) : null}
                  <label style={{ ...field, flex: "1 1 120px" }}>
                    <span>Width (optional{chosenModel.width ? `, ${showNumber(chosenModel.width.min)} to ${showNumber(chosenModel.width.max)}` : ""})</span>
                    <input
                      type="number"
                      min={chosenModel.width?.min ?? 256}
                      max={chosenModel.width?.max ?? 2048}
                      step={chosenModel.width?.step ?? 16}
                      value={draft.width}
                      onChange={(e) => setDraft({ ...draft, width: e.target.value.replace(/[^0-9]/g, "") })}
                      style={input}
                      placeholder="Normal size"
                    />
                  </label>
                  <label style={{ ...field, flex: "1 1 120px" }}>
                    <span>Height (optional{chosenModel.height ? `, ${showNumber(chosenModel.height.min)} to ${showNumber(chosenModel.height.max)}` : ""})</span>
                    <input
                      type="number"
                      min={chosenModel.height?.min ?? 256}
                      max={chosenModel.height?.max ?? 2048}
                      step={chosenModel.height?.step ?? 16}
                      value={draft.height}
                      onChange={(e) => setDraft({ ...draft, height: e.target.value.replace(/[^0-9]/g, "") })}
                      style={input}
                      placeholder="Normal size"
                    />
                  </label>
                  {chosenModel.negativePrompt ? (
                    <label style={{ ...field, flex: "1 1 100%" }}>
                      <span>Things to keep out of the picture (optional)</span>
                      <textarea
                        value={draft.negativePrompt}
                        maxLength={1000}
                        rows={2}
                        onChange={(e) => setDraft({ ...draft, negativePrompt: e.target.value })}
                        style={{ ...input, resize: "vertical" }}
                        placeholder={chosenModel.negativePrompt.default || "For example: blurry, text, watermark"}
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}
              <div style={{ ...card, gap: 4 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={draft.safeContentFilter}
                    disabled={busy || !canManage}
                    onChange={(e) => setDraft({ ...draft, safeContentFilter: e.target.checked })}
                  />
                  Sensitive content filter {draft.safeContentFilter ? "on" : "off"}
                </label>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  On (the normal choice), Sogni stops pictures with mature content. Some models, for example the Dark Beast
                  models, only work with the filter off. Pictures made with the filter off can be explicit, so only turn it
                  off for a look that needs it. Only the company's owner or an admin can turn it off, and agents cannot
                  change it. Sogni also needs an eligible account (a Sogni subscription, Premium Spark, or paying with
                  SOGNI) before it makes pictures with the filter off.
                </div>
                {modelFilterNotice(chosenModel) && draft.safeContentFilter ? (
                  <div style={{ color: "#b45309", fontSize: 12 }}>{modelFilterNotice(chosenModel)}</div>
                ) : null}
              </div>
            </>
          ) : null}

          <details style={{ ...card, gap: 8 }} open={sheetOpen} onToggle={(e) => setSheetOpen(e.currentTarget.open)}>
            <summary style={{ fontWeight: 600, cursor: "pointer" }}>Character sheet (optional)</summary>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Short words for what should stay the same in every picture. When a request says otherwise (for example
              another outfit or place), the request wins.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
              {SHEET_FIELD_OPTIONS.map((f) => (
                <label key={f.key} style={field}>
                  <span>{f.label}</span>
                  <input
                    aria-label={f.label}
                    value={draft.sheet?.[f.key] ?? ""}
                    maxLength={SHEET_FIELD_MAX}
                    onChange={(e) => setSheetField(f.key, e.target.value)}
                    style={input}
                    placeholder={f.placeholder}
                  />
                </label>
              ))}
            </div>
          </details>

          <div style={field}>
            <span>Reference pictures ({draft.referenceFileIds.length} of {refLimit} picked)</span>
            {draft.referenceFileIds.length > 0 ? (
              <div aria-label="Picked reference pictures" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {draft.referenceFileIds.map((id, i) => (
                  <div key={id} style={{ display: "flex", flexDirection: "column", gap: 4, width: 120 }}>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>Picture {i + 1}</span>
                    <img src={thumbnailPathFor(fileContentPath(id))} loading="lazy" alt={`Reference picture ${i + 1}`} style={thumb} />
                    <select
                      aria-label={`What picture ${i + 1} is for`}
                      value={draftRoles(draft)[i]}
                      onChange={(e) => setRole(i, e.target.value)}
                      style={input}
                    >
                      {REFERENCE_ROLE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            ) : null}
            {draft.referenceFileIds.length > refLimit ? (
              <div style={{ color: "#b45309", fontSize: 12 }}>
                This model takes at most {refLimit} reference pictures. Remove some before saving.
              </div>
            ) : null}
            {images === null ? (
              <div style={{ opacity: 0.7 }}>Loading your pictures…</div>
            ) : images.length === 0 ? (
              <div style={{ opacity: 0.7 }}>There are no pictures in Files yet.</div>
            ) : (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 260, overflowY: "auto" }}>
                {images.map((img) => {
                  const picked = draft.referenceFileIds.includes(img.fileId);
                  return (
                    <button
                      key={img.fileId}
                      type="button"
                      title={img.title}
                      aria-pressed={picked}
                      onClick={() => toggleRef(img.fileId, refLimit)}
                      style={{ padding: 0, border: picked ? "3px solid #1971c2" : "3px solid transparent", borderRadius: 8, background: "none", cursor: "pointer" }}
                    >
                      <img src={thumbnailPathFor(img.src)} loading="lazy" alt={img.title} style={thumb} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div style={{ ...card, gap: 6 }} aria-label="Preview prompt">
            <label style={field}>
              <span>Sample request</span>
              <input aria-label="Sample request" value={sampleRequest} onChange={(e) => setSampleRequest(e.target.value)} style={input} />
            </label>
            <div>
              <button type="button" style={secondaryBtn} disabled={previewBusy} onClick={() => void onPreviewPrompt()}>
                {previewBusy ? "Working…" : "Preview prompt"}
              </button>
            </div>
            {previewError ? <div style={errorBox}>{previewError}</div> : null}
            {promptPreview ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  Sent to {SERVICE_LABEL[promptPreview.service] ?? promptPreview.service}
                  {promptPreview.model ? ` (${promptPreview.model})` : ""}
                  {promptPreview.references.length > 0
                    ? ` with ${promptPreview.references.map((r) => `picture ${r.position} as ${r.label.toLowerCase()}`).join(", ")}`
                    : ""}
                  :
                </div>
                <pre aria-label="Prompt that would be sent" style={{ whiteSpace: "pre-wrap", margin: 0, padding: 8, borderRadius: 8, background: "rgba(128,128,128,0.12)", fontSize: 12 }}>
                  {promptPreview.prompt}
                </pre>
                {promptPreview.negativePrompt ? (
                  <div style={{ fontSize: 12 }}>Things to avoid (sent separately): {promptPreview.negativePrompt}</div>
                ) : null}
                {promptPreview.leftOut.length > 0 ? (
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    Left out because the request describes it: {promptPreview.leftOut.join(", ")}.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={primaryBtn} disabled={busy} onClick={() => void onSave()}>{busy ? "Saving…" : "Save look"}</button>
            <button type="button" style={ghostBtn} disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Stands in for a saved model Sogni's list does not show right now. */
const UNKNOWN_MODEL: SogniModel = {
  id: "",
  name: "",
  tags: [],
  tier: null,
  generates: true,
  takesReferences: false,
  workersOnline: null,
  contentFilter: null,
  width: null,
  height: null,
  steps: null,
  guidance: null,
  negativePrompt: null,
  hasLoras: null,
  creator: null,
  sourceUrl: null,
  variant: false,
};

const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, whiteSpace: "pre-line" };
const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 6 };
const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const thumb: React.CSSProperties = { width: 72, height: 72, objectFit: "cover", borderRadius: 6, display: "block" };

const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const approveBtn: React.CSSProperties = { ...baseBtn, background: "#087f5b", color: "#fff" };
const dangerBtn: React.CSSProperties = { ...baseBtn, background: "#f03e3e", color: "#fff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };

function ImageIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

/** Main-menu link (Work section), next to Tools/Projects. */
export function SidebarLink(_props: PluginSidebarProps) {
  const nav = useHostNavigation();
  return (
    <a
      {...nav.linkProps(`/${MAIN_PAGE_ROUTE}`)}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden className="shrink-0"><ImageIcon /></span>
      <span className="flex-1 truncate">Media Studio</span>
    </a>
  );
}

type MediaStudioTabKey = "create" | "edit" | "looks" | "storylines" | "settings";

/** Reads ?tab= from the current URL without pulling in the host router (standalone module). */
function initialTabFromLocation(): MediaStudioTabKey {
  if (typeof window === "undefined") return "create";
  const tab = new URLSearchParams(window.location.search).get("tab");
  return tab === "looks" || tab === "edit" || tab === "storylines" || tab === "settings" ? tab : "create";
}

const tabBtn: React.CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 13, fontWeight: 600, background: "transparent" };
const tabBtnActive: React.CSSProperties = { ...tabBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const tabBtnInactive: React.CSSProperties = { ...tabBtn, color: "#495057" };

/**
 * Media Studio's own top-level page, reached from the main menu. Tabs: Create
 * (make a picture), Edit (work on an existing picture -- crop, rotate,
 * resize, adjust, add text, AI edits; DUR-4063) and Looks (saved styles,
 * model + LoRA presets, default and automatic looks).
 */
function initialEditFileIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("fileId");
}

export function MediaStudioPage({ context }: PluginPageProps) {
  const nav = useHostNavigation();
  const [tab, setTab] = useState<MediaStudioTabKey>(initialTabFromLocation);
  const [editFileId, setEditFileId] = useState<string | null>(initialEditFileIdFromLocation);
  // Settings holds the instance-wide plugin config (API keys), saved through
  // the instance-admin-gated generic route, so it's instance-admin only --
  // not company owners/admins, who manage looks but not this. Everyone else
  // never sees the tab, and a link straight to it shows the Create tab instead.
  const checkSettingsAccess = usePluginAction(ACTION_SETTINGS_ACCESS);
  const [canManageSettings, setCanManageSettings] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    checkSettingsAccess({})
      .then((result) => { if (!cancelled) setCanManageSettings((result as { canManage?: boolean } | null)?.canManage === true); })
      .catch(() => { if (!cancelled) setCanManageSettings(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const showSettings = canManageSettings === true;
  const activeTab: MediaStudioTabKey = tab === "settings" && canManageSettings === false ? "create" : tab;

  const selectTab = (next: MediaStudioTabKey, options?: { fileId?: string }) => {
    setTab(next);
    const fileId = options?.fileId ?? null;
    setEditFileId(fileId);
    const query = fileId ? `?tab=${next}&fileId=${fileId}` : `?tab=${next}`;
    nav.navigate(`/${MAIN_PAGE_ROUTE}${query}`, { replace: true });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Media Studio</h1>
        <p style={{ fontSize: 13, color: "#868e96", margin: "4px 0 0" }}>
          Make pictures, edit them, and save the looks (styles) your agents use to make them.
        </p>
      </div>
      <div role="tablist" aria-label="Media Studio" style={{ display: "flex", gap: 8, borderBottom: "1px solid rgba(128,128,128,0.25)", paddingBottom: 8 }}>
        <button type="button" role="tab" aria-selected={activeTab === "create"} style={activeTab === "create" ? tabBtnActive : tabBtnInactive} onClick={() => selectTab("create")}>
          Create
        </button>
        <button type="button" role="tab" aria-selected={activeTab === "edit"} style={activeTab === "edit" ? tabBtnActive : tabBtnInactive} onClick={() => selectTab("edit")}>
          Edit
        </button>
        <button type="button" role="tab" aria-selected={activeTab === "looks"} style={activeTab === "looks" ? tabBtnActive : tabBtnInactive} onClick={() => selectTab("looks")}>
          Looks
        </button>
        <button type="button" role="tab" aria-selected={activeTab === "storylines"} style={activeTab === "storylines" ? tabBtnActive : tabBtnInactive} onClick={() => selectTab("storylines")}>
          Storylines
        </button>
        {showSettings ? (
          <button type="button" role="tab" aria-selected={activeTab === "settings"} style={activeTab === "settings" ? tabBtnActive : tabBtnInactive} onClick={() => selectTab("settings")}>
            Settings
          </button>
        ) : null}
      </div>
      {activeTab === "create" ? (
        <MediaStudioCreateTab context={context} onEditFile={(fileId) => selectTab("edit", { fileId })} />
      ) : activeTab === "settings" ? (
        showSettings ? <PluginConfigForm pluginId={PLUGIN_ID} /> : null
      ) : activeTab === "edit" ? (
        <MediaStudioEditTab context={context} initialFileId={editFileId} />
      ) : activeTab === "storylines" ? (
        <MediaStudioStorylinesPage context={context} />
      ) : (
        <MediaStudioLooksPage context={context} />
      )}
    </div>
  );
}

// ─── Create tab (DUR-4330, frontend half of DUR-4329) ──────────────────────
//
// Make a picture, video, or audio clip directly from the board, without
// asking an agent: write a prompt (optionally ask Claude to rewrite it
// first), see the cost up front, make it, then save/use/download/edit the
// result. Talks directly to the server's /media-studio/direct routes (plain
// REST, backed by server/src/services/media-studio-direct.ts), the same
// pattern the Storylines section below uses for /video-storylines.
//
// v1 ships Fal only (see MEDIA_STUDIO_DIRECT_PROVIDERS in
// packages/shared/src/media-studio-direct.ts) and its request schemas are
// `.strict()` with no reference-picture or size/aspect field yet, so this UI
// does not offer those two controls -- they would silently 400. Picking a
// look here only pre-fills the model field client-side; it is not sent to
// the server. A follow-up is tracked for backend reference-picture support.

const DIRECT_KINDS = ["picture", "video", "audio"] as const;
type DirectKind = (typeof DIRECT_KINDS)[number];
const DIRECT_KIND_LABELS: Record<DirectKind, string> = { picture: "Picture", video: "Video", audio: "Audio" };
/** v1 ships Fal only; kept as a value (not a picker) so a second provider is a one-line change later. */
const DIRECT_PROVIDER = "fal";
const DIRECT_PROVIDER_LABEL = "Fal";
const DIRECT_AUDIO_MODES = ["music", "speech"] as const;
type DirectAudioMode = (typeof DIRECT_AUDIO_MODES)[number];
const DIRECT_PROMPT_MAX_LENGTH = 2_000;
const DIRECT_VIDEO_MIN_DURATION = 1;
const DIRECT_VIDEO_MAX_DURATION = 10;
const DIRECT_VIDEO_DEFAULT_DURATION = 5;
const DIRECT_AUDIO_MIN_DURATION = 1;
const DIRECT_AUDIO_MAX_DURATION = 30;
const DIRECT_AUDIO_DEFAULT_DURATION = 8;
const DIRECT_MAX_VARIANTS = 4;

type DirectResult = {
  fileId: string;
  contentPath: string;
  downloadPath: string;
  contentType: string;
  costCents: number;
  provider: string;
  model: string;
};

type DirectHistoryEntry = {
  id: string;
  kind: DirectKind | "rewrite_prompt";
  provider: string;
  model: string;
  prompt: string | null;
  costCents: number;
  fileId: string | null;
  contentPath: string | null;
  createdAt: string;
};

/** Thrown by directFetchJson on a non-2xx response, carrying the server's machine-readable `details` (e.g. `{ reason: "company_budget", ... }`) alongside the human message. */
class DirectRequestError extends Error {
  details: Record<string, unknown> | null;
  constructor(message: string, details: Record<string, unknown> | null) {
    super(message);
    this.details = details;
  }
}

async function directFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const message = (record && typeof record.error === "string" ? record.error : text) || `Request failed: ${res.status}`;
    const details = record && typeof record.details === "object" && record.details ? (record.details as Record<string, unknown>) : null;
    throw new DirectRequestError(message, details);
  }
  return (res.status === 204 ? (undefined as T) : (body as T));
}

/** Plain-language text for the budget/cap/rate-limit rejections media-studio-direct.ts can return (see its reason values). Falls back to the server's own message for anything unrecognized. */
function directErrorMessage(err: DirectRequestError): string {
  const reason = err.details?.reason;
  const cents = (key: string) => formatMoney(typeof err.details?.[key] === "number" ? (err.details![key] as number) : 0);
  if (reason === "company_budget") {
    return `Making this would go over the company's monthly budget (already spent ${cents("spentMonthlyCents")} of ${cents("budgetMonthlyCents")}). Ask an owner or admin to raise the budget, or try something smaller.`;
  }
  if (reason === "direct_create_cap") {
    return `Making this would go over Media Studio's monthly limit for making things directly here (already spent ${cents("spentCents")} of ${cents("capCents")}).`;
  }
  if (reason === "daily_call_cap") {
    return "Too many requests today. Try again tomorrow.";
  }
  if (reason === "cap_override_forbidden") {
    return "Only a company owner or admin can go over that limit.";
  }
  return err.message;
}

/**
 * Mirrors useCompanyRole's rule (ui/src/hooks/useCompanyRole.ts) for this
 * standalone plugin bundle, which cannot import that hook: the company
 * owner, admins, and operators may spend here; a viewer may only look. This
 * is UX only -- the server routes are the real gate (assertBoard +
 * assertCompanyAccess, see media-studio-direct.ts).
 */
function useDirectCreateAccess(context: PluginHostContext): { ready: boolean; canSpend: boolean; isAdmin: boolean } {
  const [state, setState] = useState<{ ready: boolean; canSpend: boolean; isAdmin: boolean }>({
    ready: false,
    canSpend: false,
    isAdmin: false,
  });
  const companyId = context.companyId;
  const userId = context.userId;
  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      // No sign-in on this Paperclip: the local board runs the whole box.
      setState({ ready: true, canSpend: true, isAdmin: true });
      return;
    }
    hostFetchJson<{ isInstanceAdmin?: boolean; memberships?: Array<{ companyId: string; membershipRole: string | null; status: string }> }>(
      "/api/cli-auth/me",
    )
      .then((res) => {
        if (cancelled) return;
        const membership = companyId ? (res.memberships ?? []).find((m) => m.companyId === companyId && m.status === "active") : undefined;
        const role = membership?.membershipRole ?? null;
        const isAdmin = res.isInstanceAdmin === true || role === "owner" || role === "admin";
        setState({ ready: true, canSpend: isAdmin || role === "operator", isAdmin });
      })
      .catch(() => {
        if (!cancelled) setState({ ready: true, canSpend: false, isAdmin: false });
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, userId]);
  return state;
}

function DirectHistoryList({ history, error }: { history: DirectHistoryEntry[] | null; error: string | null }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>Your recent creations</div>
      {error ? (
        <div style={errorBox}>{error}</div>
      ) : history === null ? (
        <div style={{ opacity: 0.7, fontSize: 13 }}>Loading…</div>
      ) : history.length === 0 ? (
        <div style={{ opacity: 0.7, fontSize: 13 }}>Nothing made yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {history.map((entry) => (
            <div key={entry.id} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12, borderBottom: "1px solid rgba(128,128,128,0.15)", paddingBottom: 6 }}>
              {entry.contentPath && entry.kind === "picture" ? (
                <img src={ATTACHMENT_PATH.test(entry.contentPath) ? thumbnailPathFor(entry.contentPath) : entry.contentPath} loading="lazy" alt="" style={thumb} />
              ) : (
                <div style={{ width: 72, height: 72, borderRadius: 6, background: "rgba(128,128,128,0.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#868e96" }}>
                  {entry.kind === "rewrite_prompt" ? "Rewrite" : DIRECT_KIND_LABELS[entry.kind as DirectKind] ?? entry.kind}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.prompt ?? "—"}</div>
                <div style={{ color: "#868e96" }}>
                  {formatMoney(entry.costCents)} · {new Date(entry.createdAt).toLocaleString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DirectCreatePanel(props: {
  companyId: string;
  kind: DirectKind;
  looks: Look[];
  canManageLooks: boolean;
  isAdmin: boolean;
  onEditFile: (fileId: string) => void;
  onGenerated: () => void;
}) {
  const { companyId, kind, looks, canManageLooks, isAdmin, onEditFile, onGenerated } = props;
  const saveLook = usePluginAction(ACTION_LOOKS_SAVE);

  const [prompt, setPrompt] = useState("");
  const [lookId, setLookId] = useState("");
  const [model, setModel] = useState("");
  const [durationSeconds, setDurationSeconds] = useState(kind === "video" ? DIRECT_VIDEO_DEFAULT_DURATION : DIRECT_AUDIO_DEFAULT_DURATION);
  const [mode, setMode] = useState<DirectAudioMode>("music");
  const [voice, setVoice] = useState("");
  const [variants, setVariants] = useState(1);

  const [estimateCents, setEstimateCents] = useState<number | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);

  const [rewriting, setRewriting] = useState(false);
  const [rewriteSuggestion, setRewriteSuggestion] = useState<string | null>(null);
  const [rewriteError, setRewriteError] = useState<string | null>(null);

  const [phase, setPhase] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [results, setResults] = useState<DirectResult[]>([]);
  const [error, setError] = useState<DirectRequestError | Error | null>(null);
  const [overrideCents, setOverrideCents] = useState("");
  const [lookTargetByFileId, setLookTargetByFileId] = useState<Record<string, string>>({});
  const [savingLookRefFor, setSavingLookRefFor] = useState<string | null>(null);

  // Picking a look only pre-fills the model field here (client-side
  // convenience) -- the direct-create routes have no lookId/referenceFileIds
  // field, so nothing about the look is sent to the server.
  useEffect(() => {
    if (!lookId) return;
    const look = looks.find((l) => l.id === lookId);
    if (look?.model) setModel(look.model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookId]);

  useEffect(() => {
    let cancelled = false;
    setEstimateError(null);
    const body: Record<string, unknown> = { kind, provider: DIRECT_PROVIDER };
    if (kind !== "picture") body.durationSeconds = durationSeconds;
    directFetchJson<{ estimatedCostCents: number }>(`/api/companies/${companyId}/media-studio/direct/estimate`, {
      method: "POST",
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (!cancelled) setEstimateCents(res.estimatedCostCents);
      })
      .catch((e) => {
        if (!cancelled) {
          setEstimateCents(null);
          setEstimateError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, kind, durationSeconds]);

  const onHelpWrite = async () => {
    if (!prompt.trim()) {
      setRewriteError("Write something first, then ask for help.");
      return;
    }
    setRewriting(true);
    setRewriteError(null);
    try {
      const res = await directFetchJson<{ rewritten: string }>(`/api/companies/${companyId}/media-studio/direct/rewrite-prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: prompt.trim(), kind }),
      });
      setRewriteSuggestion(res.rewritten);
    } catch (e) {
      setRewriteError(e instanceof Error ? e.message : String(e));
    } finally {
      setRewriting(false);
    }
  };

  const buildBody = (overrideValue?: number) => {
    const body: Record<string, unknown> = { prompt: prompt.trim(), provider: DIRECT_PROVIDER };
    if (model.trim()) body.model = model.trim();
    if (kind === "video" || kind === "audio") body.durationSeconds = durationSeconds;
    if (kind === "audio") {
      body.mode = mode;
      if (voice.trim()) body.voice = voice.trim();
    }
    if (overrideValue !== undefined) body.confirmBudgetCapCents = overrideValue;
    return body;
  };

  const onGenerate = async (overrideValue?: number) => {
    if (!prompt.trim()) {
      setError(new Error("Describe what to make first."));
      return;
    }
    setPhase("generating");
    setError(null);
    let madeAny = false;
    try {
      for (let i = 0; i < variants; i += 1) {
        const result = await directFetchJson<DirectResult>(`/api/companies/${companyId}/media-studio/direct/${kind}`, {
          method: "POST",
          body: JSON.stringify(buildBody(overrideValue)),
        });
        madeAny = true;
        setResults((prev) => [...prev, result]);
      }
      setPhase("done");
      setOverrideCents("");
      onGenerated();
    } catch (e) {
      setPhase(madeAny ? "done" : "error");
      setError(e instanceof Error ? e : new Error(String(e)));
      if (madeAny) onGenerated();
    }
  };

  const onUseAsLookReference = async (result: DirectResult) => {
    const targetId = lookTargetByFileId[result.fileId];
    const look = looks.find((l) => l.id === targetId);
    if (!look) return;
    setSavingLookRefFor(result.fileId);
    try {
      const draft = lookToDraft(look);
      const nextRefs = draft.referenceFileIds.includes(result.fileId) ? draft.referenceFileIds : [...draft.referenceFileIds, result.fileId];
      await saveLook({ ...draftToSaveParams(draft), referenceFileIds: nextRefs });
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setSavingLookRefFor(null);
    }
  };

  const isCapError = error instanceof DirectRequestError && error.details?.reason === "direct_create_cap";
  const totalCostCents = results.reduce((sum, r) => sum + r.costCents, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={card}>
        <label style={field}>
          <span>What should it make?</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={DIRECT_PROMPT_MAX_LENGTH}
            rows={3}
            placeholder={`Describe the ${kind} to make…`}
            style={{ ...input, resize: "vertical", fontFamily: "inherit" }}
          />
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" style={ghostBtn} onClick={onHelpWrite} disabled={rewriting}>
            {rewriting ? "Thinking…" : "Help me write this"}
          </button>
        </div>
        {rewriteError ? <div style={errorBox}>{rewriteError}</div> : null}
        {rewriteSuggestion ? (
          <div style={{ ...card, background: "rgba(25,113,194,0.06)" }}>
            <div style={{ fontSize: 12, color: "#868e96" }}>Suggested wording:</div>
            <div style={{ fontSize: 13 }}>{rewriteSuggestion}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                style={secondaryBtn}
                onClick={() => {
                  setPrompt(rewriteSuggestion);
                  setRewriteSuggestion(null);
                }}
              >
                Use this
              </button>
              <button type="button" style={ghostBtn} onClick={() => setRewriteSuggestion(null)}>
                Keep mine
              </button>
            </div>
          </div>
        ) : null}

        <label style={field}>
          <span>Look (optional)</span>
          <select value={lookId} onChange={(e) => setLookId(e.target.value)} style={input}>
            <option value="">None</option>
            {looks.map((look) => (
              <option key={look.id} value={look.id}>
                {look.name}
              </option>
            ))}
          </select>
        </label>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label style={field}>
            <span>Service</span>
            <select value={DIRECT_PROVIDER} disabled style={input}>
              <option value={DIRECT_PROVIDER}>{DIRECT_PROVIDER_LABEL}</option>
            </select>
          </label>
          <label style={field}>
            <span>Model (optional)</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Leave empty to use the default" style={input} />
          </label>
          {kind === "video" || kind === "audio" ? (
            <label style={field}>
              <span>Length (seconds)</span>
              <input
                type="number"
                min={kind === "video" ? DIRECT_VIDEO_MIN_DURATION : DIRECT_AUDIO_MIN_DURATION}
                max={kind === "video" ? DIRECT_VIDEO_MAX_DURATION : DIRECT_AUDIO_MAX_DURATION}
                value={durationSeconds}
                onChange={(e) => setDurationSeconds(Number(e.target.value))}
                style={input}
              />
            </label>
          ) : null}
          {kind === "audio" ? (
            <>
              <label style={field}>
                <span>Kind of audio</span>
                <select value={mode} onChange={(e) => setMode(e.target.value as DirectAudioMode)} style={input}>
                  {DIRECT_AUDIO_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m === "music" ? "Music" : "Speech"}
                    </option>
                  ))}
                </select>
              </label>
              {mode === "speech" ? (
                <label style={field}>
                  <span>Voice (optional)</span>
                  <input value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="Leave empty to use the default" style={input} />
                </label>
              ) : null}
            </>
          ) : null}
          <label style={field}>
            <span>How many to make</span>
            <select value={variants} onChange={(e) => setVariants(Number(e.target.value))} style={input}>
              {Array.from({ length: DIRECT_MAX_VARIANTS }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ fontSize: 13 }}>
          {estimateError ? (
            <span style={{ color: "#a61e4d" }}>Could not estimate the cost: {estimateError}</span>
          ) : estimateCents === null ? (
            "Estimating the cost…"
          ) : (
            <>
              Expected cost: <strong>{formatMoney(estimateCents * variants)}</strong>
              {variants > 1 ? ` (${formatMoney(estimateCents)} each × ${variants})` : ""}
            </>
          )}
        </div>

        <div>
          <button type="button" style={primaryBtn} onClick={() => onGenerate()} disabled={phase === "generating"}>
            {phase === "generating" ? "Making…" : `Make ${kind}`}
          </button>
        </div>

        {error ? (
          <div style={errorBox}>
            {error instanceof DirectRequestError ? directErrorMessage(error) : error.message}
            {isCapError && isAdmin ? (
              <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                <input
                  type="number"
                  min={0}
                  placeholder="Override cap (cents)"
                  value={overrideCents}
                  onChange={(e) => setOverrideCents(e.target.value)}
                  style={{ ...input, width: 160 }}
                />
                <button
                  type="button"
                  style={secondaryBtn}
                  disabled={!overrideCents.trim()}
                  onClick={() => onGenerate(Number(overrideCents))}
                >
                  Try again with this limit
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {results.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            Made {results.length} {results.length === 1 ? kind : `${kind}s`} · Total cost: {formatMoney(totalCostCents)}
          </div>
          {results.map((result, i) => (
            <div key={`${result.fileId}-${i}`} style={card}>
              {kind === "picture" ? (
                <img src={result.contentPath} alt="Generated" style={{ maxWidth: 260, borderRadius: 8 }} />
              ) : kind === "video" ? (
                <video src={result.contentPath} controls style={{ maxWidth: 320, borderRadius: 8 }} />
              ) : (
                <audio src={result.contentPath} controls />
              )}
              <div style={{ fontSize: 12, color: "#868e96" }}>
                Cost: {formatMoney(result.costCents)} · Saved to your company files
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <a href={result.downloadPath} style={{ ...secondaryBtn, textDecoration: "none" }}>
                  Download
                </a>
                {kind === "picture" ? (
                  <button type="button" style={ghostBtn} onClick={() => onEditFile(result.fileId)}>
                    Edit
                  </button>
                ) : null}
                {kind === "picture" && canManageLooks && looks.length > 0 ? (
                  <>
                    <select
                      aria-label="Use as a reference picture for a look"
                      value={lookTargetByFileId[result.fileId] ?? ""}
                      onChange={(e) => setLookTargetByFileId((prev) => ({ ...prev, [result.fileId]: e.target.value }))}
                      style={input}
                    >
                      <option value="">Use as look reference…</option>
                      {looks.map((look) => (
                        <option key={look.id} value={look.id}>
                          {look.name}
                        </option>
                      ))}
                    </select>
                    {lookTargetByFileId[result.fileId] ? (
                      <button
                        type="button"
                        style={ghostBtn}
                        disabled={savingLookRefFor === result.fileId}
                        onClick={() => onUseAsLookReference(result)}
                      >
                        {savingLookRefFor === result.fileId ? "Saving…" : "Save"}
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Create tab: make a picture, video, or audio clip directly from the
 * board, without asking an agent (DUR-4330). Builds on DUR-4329's direct
 * generation routes.
 */
function MediaStudioCreateTab({ context, onEditFile }: { context: PluginHostContext; onEditFile: (fileId: string) => void }) {
  const companyId = context.companyId;
  const listLooks = usePluginAction(ACTION_LOOKS_LIST);
  const access = useDirectCreateAccess(context);

  const [kind, setKind] = useState<DirectKind>("picture");
  const [looks, setLooks] = useState<Look[]>([]);
  const [canManageLooks, setCanManageLooks] = useState(false);
  const [history, setHistory] = useState<DirectHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listLooks({})
      .then((res) => {
        if (cancelled) return;
        const typed = res as LooksResponse;
        setLooks(typed.looks ?? []);
        setCanManageLooks(typed.canManage === true);
      })
      .catch(() => {
        /* The create form still works with no looks; the picker just stays empty. */
      });
    return () => {
      cancelled = true;
    };
  }, [listLooks]);

  const refreshHistory = useCallback(() => {
    if (!companyId) return;
    directFetchJson<DirectHistoryEntry[]>(`/api/companies/${companyId}/media-studio/direct/history?limit=20`)
      .then((res) => setHistory(res))
      .catch((e) => setHistoryError(e instanceof Error ? e.message : String(e)));
  }, [companyId]);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  if (!companyId) {
    return (
      <div style={card}>
        <p style={{ fontSize: 13, margin: 0 }}>Open Media Studio from inside a company to make pictures, video, or audio.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div role="tablist" aria-label="What to make" style={{ display: "flex", gap: 6 }}>
        {DIRECT_KINDS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} style={kind === k ? tabBtnActive : tabBtnInactive} onClick={() => setKind(k)}>
            {DIRECT_KIND_LABELS[k]}
          </button>
        ))}
      </div>

      {!access.ready ? (
        <div style={{ opacity: 0.7, fontSize: 13 }}>Checking your access…</div>
      ) : !access.canSpend ? (
        <div style={card}>
          <p style={{ fontSize: 13, margin: 0 }}>
            You can look, but not make anything here. Only the company's owner, admins, and operators can make pictures, video,
            or audio from this tab. Ask one of them, or ask an agent to make it for you instead.
          </p>
        </div>
      ) : (
        <DirectCreatePanel
          key={kind}
          companyId={companyId}
          kind={kind}
          looks={looks}
          canManageLooks={canManageLooks}
          isAdmin={access.isAdmin}
          onEditFile={onEditFile}
          onGenerated={refreshHistory}
        />
      )}

      <DirectHistoryList history={history} error={historyError} />
    </div>
  );
}

// ─── Storylines (DUR-4128, frontend half of DUR-4095) ─────────────────────
//
// Write out a story, split it into scenes and shots, fine-tune each shot,
// see a cost estimate before rendering, render scene by scene, and watch
// progress. Talks directly to the server's /video-storylines routes (plain
// REST, not a plugin action) -- see server/src/routes/video-storylines.ts.
//
// Copies of packages/shared/src/video-storylines.ts's limits/enums: this UI
// bundles standalone and cannot import @paperclipai/shared (only bare
// specifiers to installed deps resolve). Keep these in sync by hand.
const VIDEO_SHOT_MIN_DURATION_SECONDS = 1;
const VIDEO_SHOT_MAX_DURATION_SECONDS = 60;
const VIDEO_SHOT_DEFAULT_DURATION_SECONDS = 5;
const VIDEO_STORYLINE_PROVIDER_OPTIONS: Array<{ value: "fal" | "sogni"; label: string }> = [
  { value: "fal", label: "Fal.ai" },
  { value: "sogni", label: "Sogni" },
];

interface VideoStorylineSummary {
  id: string;
  companyId: string;
  projectId: string | null;
  title: string;
  status: string;
  providerId: string;
  model: string | null;
  budgetCapCents: number | null;
  spentCents: number;
  estimatedTotalCents: number | null;
  estimatedTotalSeconds: number | null;
  characterReferenceAssetIds: string[];
  finalObjectKey: string | null;
  finalByteSize: number | null;
  finalDurationSeconds: number | null;
  stitchBlockedReason: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface VideoSceneSummary {
  id: string;
  storylineId: string;
  orderIndex: number;
  title: string;
  notes: string | null;
  createdAt: string;
}

interface VideoShotSummary {
  id: string;
  storylineId: string;
  sceneId: string;
  orderIndex: number;
  prompt: string;
  cameraNotes: string | null;
  durationSeconds: number;
  lookReferenceAssetIds: string[];
  status: string;
  providerId: string | null;
  model: string | null;
  resultObjectKey: string | null;
  resultByteSize: number | null;
  estimatedCostCents: number | null;
  actualCostCents: number | null;
  attempt: number;
  errorMessage: string | null;
  createdAt: string;
  transitionIn?: "cut" | "fade" | "dissolve" | null;
  proposedPrompt?: string | null;
  proposedCameraNotes?: string | null;
  proposedDurationSeconds?: number | null;
  proposedTransitionIn?: "cut" | "fade" | "dissolve" | null;
  proposalStatus?: string | null;
  promptHistory?: Array<{ prompt: string }>;
}

interface VideoStorylineShotProgress {
  id: string;
  orderIndex: number;
  status: string;
  attempt: number;
  errorMessage: string | null;
}

interface VideoStorylineProgress {
  storylineId: string;
  status: string;
  totalShots: number;
  doneShots: number;
  failedShots: number;
  renderingShots: number;
  spentCents: number;
  budgetCapCents: number | null;
  stitchBlockedReason: string | null;
  shots: VideoStorylineShotProgress[];
}

function formatMoney(cents: number | null): string {
  if (cents === null) return "not set";
  return `$${(cents / 100).toFixed(2)}`;
}

function storylineStatusLabel(status: string): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "estimated":
      return "Cost estimated";
    case "rendering":
      return "Rendering";
    case "paused":
      return "Paused";
    case "ready_to_stitch":
      return "Ready to combine into one video";
    case "stitching":
      return "Combining clips into one video";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled (you can change it and start again)";
    case "needs_attention":
      return "Finished, but the automatic check found problems";
    default:
      return status;
  }
}

function shotStatusLabel(status: string): string {
  switch (status) {
    case "draft":
      return "Not started";
    case "queued":
      return "Waiting to render";
    case "rendering":
      return "Rendering";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

const RENDERING_STORYLINE_STATUSES = new Set(["rendering", "stitching"]);
const EDITABLE_STORYLINE_STATUSES = new Set(["draft", "estimated", "paused", "failed", "cancelled"]);

/** A small multi-select of the company's saved Looks, for picking character reference pictures. Reuses the Looks list already fetched for the Looks tab rather than building a new picker. */
function LookReferencePicker(props: {
  looks: Look[];
  selectedFileIds: string[];
  onChange: (fileIds: string[]) => void;
  max: number;
}) {
  const usable = props.looks.filter((look) => look.referenceFileIds.length > 0);
  if (usable.length === 0) {
    return (
      <p style={{ fontSize: 12, color: "#868e96", margin: 0 }}>
        No saved looks with a reference picture yet. Add one on the Looks tab to use it as a character here.
      </p>
    );
  }
  const toggle = (fileId: string) => {
    if (props.selectedFileIds.includes(fileId)) {
      props.onChange(props.selectedFileIds.filter((id) => id !== fileId));
    } else if (props.selectedFileIds.length < props.max) {
      props.onChange([...props.selectedFileIds, fileId]);
    }
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {usable.map((look) => {
        const fileId = look.referenceFileIds[0]!;
        const checked = props.selectedFileIds.includes(fileId);
        return (
          <label
            key={look.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              padding: "4px 8px",
              borderRadius: 8,
              border: "1px solid rgba(128,128,128,0.35)",
              background: checked ? "#e7f5ff" : "transparent",
              cursor: "pointer",
            }}
          >
            <input type="checkbox" checked={checked} onChange={() => toggle(fileId)} />
            {look.name}
          </label>
        );
      })}
    </div>
  );
}

export function MediaStudioStorylinesPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const listLooks = usePluginAction(ACTION_LOOKS_LIST);

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const [looks, setLooks] = useState<Look[]>([]);
  const [storylines, setStorylines] = useState<VideoStorylineSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scenes, setScenes] = useState<VideoSceneSummary[]>([]);
  const [shots, setShots] = useState<VideoShotSummary[]>([]);
  const [progress, setProgress] = useState<VideoStorylineProgress | null>(null);
  const [storyboard, setStoryboard] = useState<StoryboardSummary | null>(null);
  const [approvalPending, setApprovalPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newTitle, setNewTitle] = useState("");
  const [newProvider, setNewProvider] = useState<"fal" | "sogni">("fal");

  const [newSceneTitle, setNewSceneTitle] = useState("");
  const [shotDrafts, setShotDrafts] = useState<Record<string, { prompt: string; cameraNotes: string; durationSeconds: number; lookReferenceAssetIds: string[] }>>({});
  /** Which script-import panel is open: a new storyline from a script, or an import into the selected one. */
  const [importFor, setImportFor] = useState<"new" | "selected" | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);
  /** Set (to the suggested dollar amount) while the page asks for a budget cap before rendering. */
  const [budgetAsk, setBudgetAsk] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    if (!companyId) return;
    try {
      const res = await storylineFetchJson<{ enabled: boolean }>(`/api/companies/${companyId}/video-storylines/settings`);
      setEnabled(res.enabled);
    } catch (e) {
      setSettingsError(errorText(e));
    }
  }, [companyId]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const [advancedEnabled, setAdvancedEnabled] = useState<boolean | null>(null);
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [advancedBusy, setAdvancedBusy] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    storylineFetchJson<{ enabled: boolean }>(`/api/companies/${companyId}/video-storylines/settings/advanced`)
      .then((res) => setAdvancedEnabled(res.enabled))
      .catch((e) => setAdvancedError(errorText(e)));
  }, [companyId]);

  const toggleAdvanced = async (next: boolean) => {
    if (!companyId) return;
    setAdvancedBusy(true);
    setAdvancedError(null);
    try {
      const res = await storylineFetchJson<{ enabled: boolean }>(`/api/companies/${companyId}/video-storylines/settings/advanced`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: next }),
      });
      setAdvancedEnabled(res.enabled);
    } catch (e) {
      setAdvancedError(errorText(e));
    } finally {
      setAdvancedBusy(false);
    }
  };

  useEffect(() => {
    listLooks({})
      .then((res) => setLooks((res as LooksResponse).looks ?? []))
      .catch(() => setLooks([]));
  }, [listLooks]);

  const toggleEnabled = async (next: boolean) => {
    if (!companyId) return;
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const res = await storylineFetchJson<{ enabled: boolean }>(`/api/companies/${companyId}/video-storylines/settings`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: next }),
      });
      setEnabled(res.enabled);
    } catch (e) {
      setSettingsError(errorText(e));
    } finally {
      setSettingsBusy(false);
    }
  };

  const loadStorylines = useCallback(async () => {
    if (!companyId || !enabled) return;
    try {
      const res = await storylineFetchJson<VideoStorylineSummary[]>(`/api/companies/${companyId}/video-storylines`);
      setStorylines(res);
    } catch (e) {
      setError(errorText(e));
    }
  }, [companyId, enabled]);

  useEffect(() => {
    void loadStorylines();
  }, [loadStorylines]);

  const selected = storylines?.find((s) => s.id === selectedId) ?? null;

  useEffect(() => {
    setApprovalPending(false);
    setStoryboard(null);
    setBudgetAsk(null);
    if (importFor === "selected") setImportFor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const loadDetail = useCallback(async () => {
    if (!companyId || !selectedId) return;
    try {
      const [sceneRes, shotRes] = await Promise.all([
        storylineFetchJson<VideoSceneSummary[]>(`/api/companies/${companyId}/video-storylines/${selectedId}/scenes`),
        storylineFetchJson<VideoShotSummary[]>(`/api/companies/${companyId}/video-storylines/${selectedId}/shots`),
      ]);
      setScenes(sceneRes);
      setShots(shotRes);
    } catch (e) {
      setError(errorText(e));
    }
  }, [companyId, selectedId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const loadProgress = useCallback(async () => {
    if (!companyId || !selectedId) return;
    try {
      const res = await storylineFetchJson<VideoStorylineProgress>(`/api/companies/${companyId}/video-storylines/${selectedId}/progress`);
      setProgress(res);
    } catch (e) {
      setError(errorText(e));
    }
  }, [companyId, selectedId]);

  // Poll progress every 4s while the storyline is actively rendering/combining, so the
  // operator sees shots finish without having to refresh the page.
  useEffect(() => {
    if (!selectedId) {
      setProgress(null);
      return;
    }
    void loadProgress();
    if (!selected || !RENDERING_STORYLINE_STATUSES.has(selected.status)) return;
    const id = window.setInterval(() => {
      void loadProgress();
      void loadStorylines();
    }, 4000);
    return () => window.clearInterval(id);
  }, [selectedId, selected?.status, loadProgress, loadStorylines]);

  const createStoryline = async () => {
    if (!companyId || !newTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const row = await storylineFetchJson<VideoStorylineSummary>(`/api/companies/${companyId}/video-storylines`, {
        method: "POST",
        body: JSON.stringify({ title: newTitle.trim(), providerId: newProvider }),
      });
      setNewTitle("");
      await loadStorylines();
      setSelectedId(row.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteStoryline = async (id: string) => {
    if (!companyId) return;
    if (!window.confirm("Delete this storyline? Scenes, shots and progress are lost for good.")) return;
    setBusy(true);
    setError(null);
    try {
      await storylineFetchJson(`/api/companies/${companyId}/video-storylines/${id}`, { method: "DELETE" });
      if (selectedId === id) setSelectedId(null);
      await loadStorylines();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const updateBudgetCap = async (dollars: string) => {
    if (!companyId || !selectedId) return;
    const cents = dollars.trim() === "" ? null : Math.round(Number(dollars) * 100);
    if (cents !== null && (!Number.isFinite(cents) || cents < 0)) return;
    setBusy(true);
    setError(null);
    try {
      await storylineFetchJson(`/api/companies/${companyId}/video-storylines/${selectedId}`, {
        method: "PATCH",
        body: JSON.stringify({ budgetCapCents: cents }),
      });
      await loadStorylines();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const updateStorylineFields = async (patch: Record<string, unknown>, action: string) => {
    if (!companyId || !selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await storylineFetchJson(`/api/companies/${companyId}/video-storylines/${selectedId}`, { method: "PATCH", body: JSON.stringify(patch) }, action);
      await loadStorylines();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  /** Moves a shot to a storyline-wide position; the server keeps it inside its scene and renumbers everything. */
  const moveShot = async (shotId: string, orderIndex: number) => {
    if (!companyId || !selectedId || orderIndex < 0) return;
    setBusy(true);
    setError(null);
    try {
      await storylineFetchJson(`/api/companies/${companyId}/video-storylines/${selectedId}/shots/${shotId}`, { method: "PATCH", body: JSON.stringify({ orderIndex }) }, "moving the shot");
      await loadDetail();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const retryStitch = async () => {
    if (!companyId || !selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await storylineFetchJson(`/api/companies/${companyId}/video-storylines/${selectedId}/stitch/retry`, { method: "POST" }, "combining the clips again");
      await loadStorylines();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const addScene = async () => {
    if (!companyId || !selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await storylineFetchJson(`/api/companies/${companyId}/video-storylines/${selectedId}/scenes`, {
        method: "POST",
        // The next free position: scenes.length collides with an existing scene once an earlier one was deleted.
        body: JSON.stringify({ title: newSceneTitle.trim(), orderIndex: scenes.reduce((max, sc) => Math.max(max, sc.orderIndex), -1) + 1 }),
      });
      setNewSceneTitle("");
      await loadDetail();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteScene = async (sceneId: string) => {
    if (!companyId || !selectedId) return;
    if (!window.confirm("Delete this scene and all its shots?")) return;
    setBusy(true);
    setError(null);
    try {
      await storylineFetchJson(`/api/companies/${companyId}/video-storylines/${selectedId}/scenes/${sceneId}`, { method: "DELETE" });
      await loadDetail();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const shotDraftFor = (sceneId: string) =>
    shotDrafts[sceneId] ?? { prompt: "", cameraNotes: "", durationSeconds: VIDEO_SHOT_DEFAULT_DURATION_SECONDS, lookReferenceAssetIds: [] };

  const setShotDraft = (sceneId: string, next: Partial<ReturnType<typeof shotDraftFor>>) => {
    setShotDrafts((prev) => ({ ...prev, [sceneId]: { ...shotDraftFor(sceneId), ...next } }));
  };

  const addShot = async (sceneId: string) => {
    if (!companyId || !selectedId) return;
    const draft = shotDraftFor(sceneId);
    if (!draft.prompt.trim()) return;
    const shotsInScene = shots.filter((s) => s.sceneId === sceneId).length;
    setBusy(true);
    setError(null);
    try {
      await storylineFetchJson(`/api/companies/${companyId}/video-storylines/${selectedId}/shots`, {
        method: "POST",
        body: JSON.stringify({
          sceneId,
          orderIndex: shotsInScene,
          prompt: draft.prompt.trim(),
          cameraNotes: draft.cameraNotes.trim() || null,
          durationSeconds: draft.durationSeconds,
          lookReferenceAssetIds: draft.lookReferenceAssetIds,
        }),
      });
      setShotDrafts((prev) => ({ ...prev, [sceneId]: { prompt: "", cameraNotes: "", durationSeconds: VIDEO_SHOT_DEFAULT_DURATION_SECONDS, lookReferenceAssetIds: [] } }));
      await loadDetail();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteShot = async (shotId: string) => {
    if (!companyId || !selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await storylineFetchJson(`/api/companies/${companyId}/video-storylines/${selectedId}/shots/${shotId}`, { method: "DELETE" });
      await loadDetail();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const rerenderShot = async (shotId: string) => {
    if (!companyId || !selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await storylineFetchJson(`/api/companies/${companyId}/video-storylines/${selectedId}/shots/${shotId}/rerender`, { method: "POST" });
      await loadProgress();
      await loadStorylines();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const [estimate, setEstimate] = useState<VideoStorylineSummary | null>(null);
  const runEstimate = async () => {
    if (!companyId || !selectedId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await storylineFetchJson<VideoStorylineSummary>(`/api/companies/${companyId}/video-storylines/${selectedId}/estimate`, { method: "POST" });
      setEstimate(res);
      await loadStorylines();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const startRender = async (confirmBudgetCapCents?: number) => {
    if (!companyId || !selectedId || !selected) return;
    const estimatedCents = estimate?.id === selected.id ? estimate.estimatedTotalCents : selected.estimatedTotalCents;
    // No spending limit yet: ask for one here instead of a greyed-out button
    // (the server refuses to render without a cap).
    if (selected.budgetCapCents === null && confirmBudgetCapCents === undefined) {
      setBudgetAsk(estimatedCents !== null ? String(Math.ceil((estimatedCents * 1.2) / 100)) : "");
      return;
    }
    const capCents = confirmBudgetCapCents ?? selected.budgetCapCents;
    const overBudget = estimatedCents !== null && capCents !== null && selected.spentCents + estimatedCents > capCents;
    const costLine =
      estimatedCents !== null
        ? `This will cost about ${formatMoney(estimatedCents)} for ${(estimate?.id === selected.id ? estimate.estimatedTotalSeconds : selected.estimatedTotalSeconds) ?? 0} seconds of video.`
        : "Get a cost estimate first so you know roughly what this will cost.";
    const budgetWarning = overBudget
      ? `\n\nHeads up: that's more than your budget cap of ${formatMoney(capCents)}. The server will refuse to start until the cap covers the estimate.`
      : "";
    if (!window.confirm(`Start rendering this storyline now?\n\n${costLine}${budgetWarning}\n\nIt renders clip by clip in the background; you can watch progress here.`)) return;
    setBusy(true);
    setError(null);
    try {
      await storylineFetchJson(
        `/api/companies/${companyId}/video-storylines/${selectedId}/render/start`,
        { method: "POST", body: JSON.stringify(confirmBudgetCapCents !== undefined ? { confirmBudgetCapCents } : {}) },
        "starting the render",
      );
      setApprovalPending(false);
      setBudgetAsk(null);
      await loadStorylines();
      await loadProgress();
    } catch (e) {
      const message = errorText(e);
      if (message.includes("Waiting on a board decision")) {
        // Not a failure: the request for the owner's go-ahead was sent; the storyboard panel explains the wait.
        setApprovalPending(true);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmBudgetAndStart = () => {
    const cents = Math.round(Number(budgetAsk) * 100);
    if (!budgetAsk?.trim() || !Number.isFinite(cents) || cents <= 0) {
      setError("Enter the most this render may spend, in dollars (for example 25).");
      return;
    }
    void startRender(cents);
  };

  const cancelRender = async () => {
    if (!companyId || !selectedId) return;
    if (!window.confirm("Cancel this render? Shots already finished are kept; anything still in progress is stopped.")) return;
    setBusy(true);
    setError(null);
    try {
      await storylineFetchJson(`/api/companies/${companyId}/video-storylines/${selectedId}/render/cancel`, { method: "POST" });
      await loadStorylines();
      await loadProgress();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (enabled === null) {
    return <div style={card}><p style={{ fontSize: 13, margin: 0 }}>Loading...</p></div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <strong style={{ fontSize: 13 }}>Video storylines</strong>
            <p style={{ fontSize: 12, color: "#868e96", margin: "2px 0 0" }}>
              Write out a story, split it into scenes and shots, and render a long video clip by clip. Off by default.
            </p>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={enabled} disabled={settingsBusy} onChange={(e) => void toggleEnabled(e.target.checked)} />
            Turned on
          </label>
        </div>
        {settingsError && <div style={errorBox}>{settingsError}</div>}
        {enabled && (
          <AdvancedFeaturesToggle enabled={advancedEnabled} busy={advancedBusy} error={advancedError} onChange={(v) => void toggleAdvanced(v)} />
        )}
      </div>

      {!enabled ? (
        <div style={card}>
          <p style={{ fontSize: 13, margin: 0 }}>
            Video storylines are turned off for this company. Turn it on above to write a storyline and start rendering.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          <div style={{ ...card, width: 280, flexShrink: 0 }}>
            <strong style={{ fontSize: 13 }}>Storylines</strong>
            <div style={field}>
              <input style={input} placeholder="Title, e.g. Zelda theory video" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
              <select style={input} value={newProvider} onChange={(e) => setNewProvider(e.target.value as "fal" | "sogni")}>
                {VIDEO_STORYLINE_PROVIDER_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              <button type="button" style={primaryBtn} disabled={busy || !newTitle.trim()} onClick={() => void createStoryline()}>
                New storyline
              </button>
              <button type="button" style={secondaryBtn} disabled={busy} onClick={() => setImportFor("new")}>
                New from script (JSON)
              </button>
              <button type="button" style={ghostBtn} onClick={() => setShowInstructions(true)}>
                Script-writer instructions
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
              {(storylines ?? []).length === 0 && <p style={{ fontSize: 12, color: "#868e96", margin: 0 }}>No storylines yet.</p>}
              {(storylines ?? []).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedId(s.id)}
                  style={{
                    textAlign: "left",
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: "1px solid rgba(128,128,128,0.35)",
                    background: s.id === selectedId ? "#e7f5ff" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{s.title}</div>
                  <div style={{ fontSize: 11, color: "#868e96" }}>{storylineStatusLabel(s.status)}</div>
                </button>
              ))}
            </div>
          </div>

          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
            {showInstructions && companyId && <ScriptInstructionsDialog companyId={companyId} onClose={() => setShowInstructions(false)} />}
            {importFor === "new" && companyId && (
              <ScriptImportDialog
                companyId={companyId}
                storylineId={null}
                defaultProvider={newProvider}
                onClose={() => setImportFor(null)}
                onImported={async (id) => {
                  await loadStorylines();
                  if (id) setSelectedId(id);
                }}
              />
            )}
            {error && <div style={errorBox} role="alert">{error}</div>}
            {!selected ? (
              <div style={card}>
                <p style={{ fontSize: 13, margin: 0 }}>Pick a storyline on the left, or start a new one.</p>
              </div>
            ) : (
              <>
                <div style={card}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <strong style={{ fontSize: 14 }}>{selected.title}</strong>
                      <div style={{ fontSize: 12, color: "#868e96" }}>{storylineStatusLabel(selected.status)}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      <button
                        type="button"
                        style={secondaryBtn}
                        disabled={busy || !EDITABLE_STORYLINE_STATUSES.has(selected.status)}
                        title={EDITABLE_STORYLINE_STATUSES.has(selected.status) ? undefined : "Wait for the render to finish (or cancel it) first."}
                        onClick={() => setImportFor("selected")}
                      >
                        Import script (JSON)
                      </button>
                      <button type="button" style={ghostBtn} onClick={() => setShowInstructions(true)}>
                        Script-writer instructions
                      </button>
                      <button type="button" style={dangerBtn} disabled={busy} onClick={() => void deleteStoryline(selected.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                  {importFor === "selected" && companyId && (
                    <ScriptImportDialog
                      companyId={companyId}
                      storylineId={selected.id}
                      onClose={() => setImportFor(null)}
                      onImported={async () => {
                        await loadDetail();
                        await loadStorylines();
                      }}
                    />
                  )}
                  {selected.errorMessage && <div style={errorBox}>{selected.errorMessage}</div>}
                  {selected.status === "needs_attention" && (
                    <div>
                      <button type="button" style={secondaryBtn} disabled={busy} onClick={() => void retryStitch()}>
                        Combine the clips again
                      </button>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                    <div style={field}>
                      <label style={{ fontSize: 12, color: "#868e96" }}>Video service</label>
                      <select
                        style={input}
                        aria-label="Video service"
                        value={selected.providerId}
                        disabled={busy || !EDITABLE_STORYLINE_STATUSES.has(selected.status)}
                        onChange={(e) => void updateStorylineFields({ providerId: e.target.value }, "changing the video service")}
                      >
                        {VIDEO_STORYLINE_PROVIDER_OPTIONS.map((p) => (
                          <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                      </select>
                    </div>
                    <div style={{ ...field, flex: 1, minWidth: 200 }}>
                      <label style={{ fontSize: 12, color: "#868e96" }}>Video model (leave empty for the service's default)</label>
                      <input
                        key={`model-${selected.id}-${selected.model ?? ""}`}
                        style={input}
                        aria-label="Video model"
                        placeholder={selected.providerId === "fal" ? "Default: Kling (picked per shot)" : "Default model"}
                        defaultValue={selected.model ?? ""}
                        disabled={busy || !EDITABLE_STORYLINE_STATUSES.has(selected.status)}
                        onBlur={(e) => {
                          const next = e.target.value.trim() || null;
                          if (next !== selected.model) void updateStorylineFields({ model: next }, "changing the video model");
                        }}
                      />
                    </div>
                  </div>
                  {selected.providerId === "fal" && (!selected.model || /kling/i.test(selected.model)) && (
                    <p style={{ fontSize: 11, color: "#868e96", margin: 0 }}>
                      Fal.ai's Kling models only make 5- or 10-second clips. Shots with other lengths are rendered (and charged) at the next allowed length, up to 10 seconds.
                    </p>
                  )}
                  <div style={field}>
                    <label style={{ fontSize: 12, color: "#868e96" }}>
                      Character pictures (sent with every shot to keep faces the same; at most 4 pictures are used per shot, the shot's own first)
                    </label>
                    <LookReferencePicker
                      looks={looks}
                      selectedFileIds={selected.characterReferenceAssetIds}
                      onChange={(ids) => void updateStorylineFields({ characterReferenceAssetIds: ids }, "saving the character pictures")}
                      max={20}
                    />
                  </div>
                  <div style={field}>
                    <label style={{ fontSize: 12, color: "#868e96" }}>Budget cap (stops rendering once spend would go over this)</label>
                    <input
                      style={input}
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="e.g. 20.00"
                      key={`budget-${selected.id}-${selected.budgetCapCents ?? "none"}`}
                      aria-label="Budget cap in dollars"
                      defaultValue={selected.budgetCapCents !== null ? (selected.budgetCapCents / 100).toFixed(2) : ""}
                      disabled={!EDITABLE_STORYLINE_STATUSES.has(selected.status)}
                      onBlur={(e) => void updateBudgetCap(e.target.value)}
                    />
                  </div>
                  <p style={{ fontSize: 12, color: "#868e96", margin: 0 }}>
                    Spent so far: {formatMoney(selected.spentCents)} of {formatMoney(selected.budgetCapCents)}
                  </p>
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <button type="button" style={secondaryBtn} disabled={busy || shots.length === 0} onClick={() => void runEstimate()}>
                      Get cost estimate
                    </button>
                    <button
                      type="button"
                      style={primaryBtn}
                      disabled={busy || shots.length === 0 || !EDITABLE_STORYLINE_STATUSES.has(selected.status) || !storyboardReadyToRender(storyboard)}
                      title={storyboardReadyToRender(storyboard) ? undefined : "Approve every shot's picture in the storyboard first (or leave out the shots you don't want)."}
                      onClick={() => void startRender()}
                    >
                      Start render
                    </button>
                    {RENDERING_STORYLINE_STATUSES.has(selected.status) && (
                      <button type="button" style={dangerBtn} disabled={busy} onClick={() => void cancelRender()}>
                        Cancel render
                      </button>
                    )}
                  </div>
                  {shots.length > 0 && EDITABLE_STORYLINE_STATUSES.has(selected.status) && !storyboardReadyToRender(storyboard) && (
                    <p style={{ fontSize: 12, color: "#868e96", margin: 0 }}>
                      To start the render, approve every shot in the storyboard below (make a picture and approve it, approve it without a picture, or leave it out).
                    </p>
                  )}
                  {selected.budgetCapCents === null && budgetAsk === null && shots.length > 0 && (
                    <p style={{ fontSize: 12, color: "#868e96", margin: 0 }}>No budget cap yet -- you'll be asked for one when you start the render.</p>
                  )}
                  {budgetAsk !== null && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, background: "#fff9db", color: "#7f5f01", borderRadius: 8, padding: 10 }} data-testid="budget-ask">
                      <span style={{ fontSize: 12 }}>
                        Set a spending limit first: rendering never starts without one, and it stops if the limit would be passed.
                        {selected.estimatedTotalCents !== null ? ` This render is estimated at about ${formatMoney(selected.estimatedTotalCents)}.` : ""}
                      </span>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span style={{ fontSize: 12 }}>At most $</span>
                        <input style={{ ...input, width: 120 }} type="number" min={0} step="0.01" aria-label="Most this render may spend" value={budgetAsk} onChange={(e) => setBudgetAsk(e.target.value)} />
                        <button type="button" style={primaryBtn} disabled={busy} onClick={confirmBudgetAndStart}>Set limit and start render</button>
                        <button type="button" style={ghostBtn} disabled={busy} onClick={() => setBudgetAsk(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {estimate && estimate.id === selected.id && (
                    <p style={{ fontSize: 12, margin: 0 }}>
                      Estimate: about {formatMoney(estimate.estimatedTotalCents)} for {estimate.estimatedTotalSeconds ?? 0} seconds of video
                      ({shots.length} shot{shots.length === 1 ? "" : "s"}). This is a ballpark, not a quote.
                    </p>
                  )}
                </div>

                {advancedEnabled && companyId && (
                  <AiDirectorSection
                    companyId={companyId}
                    storylineId={selected.id}
                    scenes={scenes}
                    shots={shots}
                    editable={EDITABLE_STORYLINE_STATUSES.has(selected.status)}
                    fetchJson={storylineFetchJson}
                    onShotsChanged={loadDetail}
                  />
                )}

                {shots.length > 0 && (
                  <StoryboardPanel
                    companyId={companyId!}
                    storylineId={selected.id}
                    shots={shots}
                    editable={EDITABLE_STORYLINE_STATUSES.has(selected.status)}
                    approvalPending={approvalPending}
                    onSummary={setStoryboard}
                    onShotsChanged={async () => {
                      await loadDetail();
                      await loadStorylines();
                    }}
                  />
                )}

                {progress && (
                  <div style={card}>
                    <strong style={{ fontSize: 13 }}>Progress</strong>
                    <div style={{ height: 8, borderRadius: 4, background: "rgba(128,128,128,0.2)", overflow: "hidden" }}>
                      <div
                        style={{
                          height: "100%",
                          width: progress.totalShots > 0 ? `${(progress.doneShots / progress.totalShots) * 100}%` : "0%",
                          background: "#087f5b",
                        }}
                      />
                    </div>
                    <p style={{ fontSize: 12, margin: 0 }}>
                      {progress.doneShots} of {progress.totalShots} shots done
                      {progress.renderingShots > 0 ? `, ${progress.renderingShots} rendering now` : ""}
                      {progress.failedShots > 0 ? `, ${progress.failedShots} failed` : ""}.
                      Spent {formatMoney(progress.spentCents)} of {formatMoney(progress.budgetCapCents)}.
                    </p>
                    {progress.stitchBlockedReason && <div style={errorBox}>{progress.stitchBlockedReason}</div>}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {progress.shots.map((shot) => (
                        <div key={shot.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                          <span>
                            Shot {shot.orderIndex + 1}: {shotStatusLabel(shot.status)}
                            {shot.errorMessage ? ` — ${shot.errorMessage}` : ""}
                          </span>
                          {shot.status === "failed" && (
                            <button type="button" style={ghostBtn} disabled={busy} onClick={() => void rerenderShot(shot.id)}>
                              Try again
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {selected.status === "done" && selected.finalObjectKey && (
                  <div style={card}>
                    <strong style={{ fontSize: 13 }}>Finished video</strong>
                    <video
                      controls
                      style={{ width: "100%", borderRadius: 8, background: "#000" }}
                      src={`/api/companies/${companyId}/video-storylines/${selected.id}/final/content`}
                    />
                    <div>
                      <a
                        href={`/api/companies/${companyId}/video-storylines/${selected.id}/final/content`}
                        download={`${selected.title || "video-storyline"}.mp4`}
                        style={{ color: "#1971c2", fontSize: 12 }}
                      >
                        Download video
                        {selected.finalByteSize ? ` (${(selected.finalByteSize / (1024 * 1024)).toFixed(1)} MB)` : ""}
                      </a>
                    </div>
                  </div>
                )}

                <div style={card}>
                  <strong style={{ fontSize: 13 }}>Scenes</strong>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input style={{ ...input, flex: 1 }} placeholder="Scene title (optional)" value={newSceneTitle} onChange={(e) => setNewSceneTitle(e.target.value)} />
                    <button
                      type="button"
                      style={secondaryBtn}
                      disabled={busy || !EDITABLE_STORYLINE_STATUSES.has(selected.status)}
                      onClick={() => void addScene()}
                    >
                      Add scene
                    </button>
                  </div>
                  {scenes.length === 0 && <p style={{ fontSize: 12, color: "#868e96", margin: 0 }}>No scenes yet. Add one to start writing shots.</p>}
                  {scenes
                    .slice()
                    .sort((a, b) => a.orderIndex - b.orderIndex)
                    .map((scene, sceneIdx) => {
                      const sceneShots = shots.filter((sh) => sh.sceneId === scene.id).sort((a, b) => a.orderIndex - b.orderIndex);
                      const draft = shotDraftFor(scene.id);
                      return (
                        <div key={scene.id} style={{ border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <strong style={{ fontSize: 12 }}>Scene {sceneIdx + 1}{scene.title ? `: ${scene.title}` : ""}</strong>
                            <button
                              type="button"
                              style={ghostBtn}
                              disabled={busy || !EDITABLE_STORYLINE_STATUSES.has(selected.status)}
                              onClick={() => void deleteScene(scene.id)}
                            >
                              Delete scene
                            </button>
                          </div>
                          {sceneShots.map((shot, shotIdx) => (
                            <div key={shot.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, borderTop: "1px solid rgba(128,128,128,0.15)", paddingTop: 6 }}>
                              <div>
                                <div>
                                  <strong>Shot {shot.orderIndex + 1}.</strong> {shot.prompt}
                                </div>
                                <div style={{ color: "#868e96" }}>
                                  {shot.durationSeconds}s{shot.transitionIn ? ` · ${shot.transitionIn} in` : ""}{shot.cameraNotes ? ` · ${shot.cameraNotes}` : ""} · {shotStatusLabel(shot.status)}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
                                <button
                                  type="button"
                                  style={ghostBtn}
                                  aria-label="Move shot up"
                                  title="Move up"
                                  disabled={busy || shotIdx === 0 || !EDITABLE_STORYLINE_STATUSES.has(selected.status)}
                                  onClick={() => void moveShot(shot.id, shot.orderIndex - 1)}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  style={ghostBtn}
                                  aria-label="Move shot down"
                                  title="Move down"
                                  disabled={busy || shotIdx === sceneShots.length - 1 || !EDITABLE_STORYLINE_STATUSES.has(selected.status)}
                                  onClick={() => void moveShot(shot.id, shot.orderIndex + 1)}
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  style={ghostBtn}
                                  disabled={busy || !EDITABLE_STORYLINE_STATUSES.has(selected.status)}
                                  onClick={() => void deleteShot(shot.id)}
                                >
                                  Remove
                                </button>
                              </div>
                            </div>
                          ))}
                          {EDITABLE_STORYLINE_STATUSES.has(selected.status) && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6, background: "rgba(128,128,128,0.06)", borderRadius: 6, padding: 8 }}>
                              <textarea
                                style={{ ...input, minHeight: 50 }}
                                placeholder="Describe what happens in this shot"
                                value={draft.prompt}
                                onChange={(e) => setShotDraft(scene.id, { prompt: e.target.value })}
                              />
                              <div style={{ display: "flex", gap: 6 }}>
                                <input
                                  style={{ ...input, flex: 1 }}
                                  placeholder="Camera notes (optional)"
                                  value={draft.cameraNotes}
                                  onChange={(e) => setShotDraft(scene.id, { cameraNotes: e.target.value })}
                                />
                                <input
                                  style={{ ...input, width: 90 }}
                                  type="number"
                                  min={VIDEO_SHOT_MIN_DURATION_SECONDS}
                                  max={VIDEO_SHOT_MAX_DURATION_SECONDS}
                                  value={draft.durationSeconds}
                                  onChange={(e) => setShotDraft(scene.id, { durationSeconds: Number(e.target.value) || VIDEO_SHOT_DEFAULT_DURATION_SECONDS })}
                                />
                              </div>
                              <LookReferencePicker
                                looks={looks}
                                selectedFileIds={draft.lookReferenceAssetIds}
                                onChange={(ids) => setShotDraft(scene.id, { lookReferenceAssetIds: ids })}
                                max={8}
                              />
                              <button type="button" style={secondaryBtn} disabled={busy || !draft.prompt.trim()} onClick={() => void addShot(scene.id)}>
                                Add shot
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
