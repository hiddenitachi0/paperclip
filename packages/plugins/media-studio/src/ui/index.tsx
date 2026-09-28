import { useCallback, useEffect, useState } from "react";
import type { PluginCompanySettingsPageProps, PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";

// The plugin UI is served as a standalone ES module, so it must not import from
// sibling plugin files (only bare specifiers resolve). Keep these in sync with
// manifest.ts / providers.ts.
const PLUGIN_ID = "paperclip.media-studio";
const ACTION_GENERATE = "generate";
const PROVIDER = "media-studio";
const ACTION_LOOKS_LIST = "looks.list";
const ACTION_LOOKS_SAVE = "looks.save";
const ACTION_LOOKS_DELETE = "looks.delete";
const ACTION_LOOK_DEFAULTS_LIST = "looks.defaults.list";
const ACTION_LOOK_DEFAULTS_SET = "looks.defaults.set";
const ACTION_SOGNI_MODELS = "sogni.models";
const ACTION_SOGNI_LORAS = "sogni.loras";

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
type SogniLorasResponse = { modelId: string; loras: SogniLora[]; maxLoras?: number; personal?: string; note?: string | null };

const ATTACHMENT_PATH = /^\/api\/attachments\/([0-9a-f-]{36})\/content$/i;

function fileContentPath(fileId: string) {
  return `/api/attachments/${fileId}/content`;
}

export type LookDraft = {
  id: string | null;
  name: string;
  style: string;
  provider: string;
  model: string;
  seed: string;
  referenceFileIds: string[];
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

export function MediaStudioLooksPage({ context }: PluginCompanySettingsPageProps) {
  const companyId = context.companyId;
  const listLooks = usePluginAction(ACTION_LOOKS_LIST);
  const saveLook = usePluginAction(ACTION_LOOKS_SAVE);
  const deleteLook = usePluginAction(ACTION_LOOKS_DELETE);
  const listSogniModels = usePluginAction(ACTION_SOGNI_MODELS);
  const listSogniLoras = usePluginAction(ACTION_SOGNI_LORAS);
  const listLookDefaults = usePluginAction(ACTION_LOOK_DEFAULTS_LIST);
  const setLookDefault = usePluginAction(ACTION_LOOK_DEFAULTS_SET);

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
    setDraft(look ? lookToDraft(look) : { ...EMPTY_DRAFT });
    void loadImages();
  };

  const toggleRef = (fileId: string) => {
    setDraft((d) => {
      if (!d) return d;
      if (d.referenceFileIds.includes(fileId)) {
        return { ...d, referenceFileIds: d.referenceFileIds.filter((id) => id !== fileId) };
      }
      if (d.referenceFileIds.length >= maxRefs) return d;
      return { ...d, referenceFileIds: [...d.referenceFileIds, fileId] };
    });
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, fontSize: 13, maxWidth: 820 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 16 }}>Media Studio looks</div>
        <div style={{ opacity: 0.7, marginTop: 4 }}>
          A look keeps pictures consistent: its style words are added to every picture made with it, and it can fix the
          seed and use up to {maxRefs} reference pictures from your Files to keep the same person, product or style. With
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
              {look.referenceFileIds.length > 0 ? (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {look.referenceFileIds.map((id) => (
                    <img key={id} src={fileContentPath(id)} alt="Reference picture" style={thumb} />
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
            <label style={{ ...field, flex: "1 1 160px" }}>
              <span>Fixed seed (optional)</span>
              <input value={draft.seed} inputMode="numeric" onChange={(e) => setDraft({ ...draft, seed: e.target.value.replace(/[^0-9]/g, "") })} style={input} placeholder="Leave empty for a new one each time" />
            </label>
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

          <div style={field}>
            <span>Reference pictures ({draft.referenceFileIds.length} of {maxRefs} picked)</span>
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
                      onClick={() => toggleRef(img.fileId)}
                      style={{ padding: 0, border: picked ? "3px solid #1971c2" : "3px solid transparent", borderRadius: 8, background: "none", cursor: "pointer" }}
                    >
                      <img src={img.src} alt={img.title} style={thumb} />
                    </button>
                  );
                })}
              </div>
            )}
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

const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8 };
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
