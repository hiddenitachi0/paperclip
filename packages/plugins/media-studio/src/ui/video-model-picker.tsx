import { useState } from "react";

// The storyline's video model as a list to pick from, not free text.
//
// Fal: the Kling models the server's FalVideoProvider can drive
// (server/src/services/video-provider-clients.ts sends prompt, image_url,
// duration; Kling 1.6/2.1 only make 5- or 10-second clips, Kling 3 any
// whole length from 3 to 15 seconds -- see
// videoModelAllowedDurations in packages/shared/src/video-storylines.ts).
// Prices are rough per-second figures from Fal's published pricing (list
// reviewed FAL_VIDEO_MODELS_DATE, not read live); check fal.ai/pricing.
//
// Sogni: the live catalogue from the worker's "sogni.videoModels" action
// (public, cached 10 minutes; a dated built-in list when Sogni is down).
//
// Standalone ES module: local types and styles, no imports from outside ui/.

export const FAL_VIDEO_MODELS_DATE = "2026-10-08";

export interface VideoModelOption {
  /** null = let the service pick (the default). */
  id: string | null;
  name: string;
  /** Clip lengths it makes. */
  clipSeconds: { values: number[] } | { min: number; max: number } | null;
  /** Rough price in US cents per second of video; null = not known. */
  centsPerSecond: number | null;
  /** Sogni's own "per base render" list price in US dollars, when that is all that is published. */
  usdPerBaseRender?: number | null;
  takesStartImage: boolean;
  needsStartImage: boolean;
  /** How many character (reference) pictures it uses; 0 = none. */
  maxReferences: number;
  note?: string;
  premium?: boolean;
}

const KLING_LENGTHS = { values: [5, 10] };
/** Kling 3 (Standard and Pro): any whole number of seconds from 3 to 15. */
const KLING3_LENGTHS = { min: 3, max: 15 };

export const FAL_VIDEO_MODELS: VideoModelOption[] = [
  {
    id: null,
    name: "Automatic (recommended): Kling, picked per shot",
    clipSeconds: KLING_LENGTHS,
    centsPerSecond: 5,
    takesStartImage: true,
    needsStartImage: false,
    maxReferences: 4,
    note: "Uses Kling 1.6 Standard (text or start picture), and Kling 3 Pro when the storyline has character pictures, so faces stay the same.",
  },
  { id: "fal-ai/kling-video/v1.6/standard/image-to-video", name: "Kling 1.6 Standard, from a start picture", clipSeconds: KLING_LENGTHS, centsPerSecond: 5, takesStartImage: true, needsStartImage: true, maxReferences: 0 },
  { id: "fal-ai/kling-video/v1.6/standard/text-to-video", name: "Kling 1.6 Standard, from text only", clipSeconds: KLING_LENGTHS, centsPerSecond: 5, takesStartImage: false, needsStartImage: false, maxReferences: 0 },
  { id: "fal-ai/kling-video/v1.6/pro/image-to-video", name: "Kling 1.6 Pro, from a start picture", clipSeconds: KLING_LENGTHS, centsPerSecond: 10, takesStartImage: true, needsStartImage: true, maxReferences: 0 },
  { id: "fal-ai/kling-video/v1.6/pro/text-to-video", name: "Kling 1.6 Pro, from text only", clipSeconds: KLING_LENGTHS, centsPerSecond: 10, takesStartImage: false, needsStartImage: false, maxReferences: 0 },
  { id: "fal-ai/kling-video/v2.1/standard/image-to-video", name: "Kling 2.1 Standard, from a start picture", clipSeconds: KLING_LENGTHS, centsPerSecond: 5, takesStartImage: true, needsStartImage: true, maxReferences: 0 },
  { id: "fal-ai/kling-video/v2.1/pro/image-to-video", name: "Kling 2.1 Pro, from a start picture", clipSeconds: KLING_LENGTHS, centsPerSecond: 9, takesStartImage: true, needsStartImage: true, maxReferences: 0 },
  { id: "fal-ai/kling-video/v2.1/master/text-to-video", name: "Kling 2.1 Master, from text only", clipSeconds: KLING_LENGTHS, centsPerSecond: 28, takesStartImage: false, needsStartImage: false, maxReferences: 0 },
  { id: "fal-ai/kling-video/v2.1/master/image-to-video", name: "Kling 2.1 Master, from a start picture", clipSeconds: KLING_LENGTHS, centsPerSecond: 28, takesStartImage: true, needsStartImage: true, maxReferences: 0 },
  {
    id: "fal-ai/kling-video/v3/standard/image-to-video",
    name: "Kling 3 Standard, from a start picture",
    clipSeconds: KLING3_LENGTHS,
    centsPerSecond: 9,
    takesStartImage: true,
    needsStartImage: true,
    maxReferences: 3,
    note: "Character pictures from the cast are sent with every clip. No AI sound (it costs 50% more).",
  },
  {
    id: "fal-ai/kling-video/v3/pro/image-to-video",
    name: "Kling 3 Pro, from a start picture",
    clipSeconds: KLING3_LENGTHS,
    centsPerSecond: 12,
    takesStartImage: true,
    needsStartImage: true,
    maxReferences: 3,
    note: "Character pictures from the cast are sent with every clip. No AI sound (it costs 50% more).",
  },
];

/** The Sogni catalogue row as the worker returns it (sogni-catalog.ts SogniVideoModelInfo). */
export interface SogniVideoModelRow {
  id: string;
  name: string;
  tags: string[];
  premium: boolean;
  workersOnline: number | null;
  clipSeconds: { values: number[] } | { min: number; max: number } | null;
  takesStartImage: boolean;
  needsStartImage: boolean;
  maxReferences: number;
  usdPerBaseRender: number | null;
  creator: string | null;
}

export function sogniVideoOptions(rows: SogniVideoModelRow[]): VideoModelOption[] {
  return [
    {
      id: null,
      name: "Sogni's default video model",
      clipSeconds: null,
      centsPerSecond: null,
      takesStartImage: true,
      needsStartImage: false,
      maxReferences: 3,
      note: "Sogni picks: LTX 2.5 today (2 to 20 second clips, can start from a picture).",
    },
    ...rows.map((row) => ({
      id: row.id,
      name: row.workersOnline === 0 ? `${row.name} (no workers online now)` : row.name,
      clipSeconds: row.clipSeconds,
      centsPerSecond: null,
      usdPerBaseRender: row.usdPerBaseRender,
      takesStartImage: row.takesStartImage,
      needsStartImage: row.needsStartImage,
      maxReferences: row.maxReferences,
      premium: row.premium,
    })),
  ];
}

export function clipLengthsText(clip: VideoModelOption["clipSeconds"]): string {
  if (!clip) return "not published";
  if ("values" in clip) {
    const v = clip.values;
    if (v.length === 0) return "not published";
    const contiguous = v.every((x, i) => i === 0 || x === v[i - 1]! + 1);
    if (v.length > 2 && contiguous) return `${v[0]} to ${v[v.length - 1]} seconds`;
    return `${v.slice(0, -1).join(", ")}${v.length > 1 ? " or " : ""}${v[v.length - 1]} seconds`;
  }
  return `${clip.min} to ${clip.max} seconds`;
}

export function priceText(option: VideoModelOption): string {
  if (option.centsPerSecond !== null) return `about $${(option.centsPerSecond / 100).toFixed(2)} per second`;
  if (option.usdPerBaseRender) return `Sogni list price about $${option.usdPerBaseRender.toFixed(3)} per base render (length and size change it)`;
  return "not published";
}

export function pictureSupportText(option: VideoModelOption): string {
  const start = option.needsStartImage
    ? "Needs a start picture (the shot's approved picture or the previous clip's last frame)"
    : option.takesStartImage
      ? "Can start from a picture"
      : "Text only: start pictures are not used";
  const refs = option.maxReferences > 0 ? `uses up to ${option.maxReferences} character pictures` : "does not use character pictures";
  return `${start}; ${refs}.`;
}

const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };

const CUSTOM = "__custom__";

export function VideoModelPicker(props: {
  provider: "fal" | "sogni" | string;
  value: string | null;
  sogniModels: SogniVideoModelRow[] | null;
  /** Shown under the list, e.g. "Sogni's list could not be reached". */
  sogniNote?: string | null;
  disabled?: boolean;
  onChange: (model: string | null) => void;
}) {
  const options = props.provider === "sogni" ? sogniVideoOptions(props.sogniModels ?? []) : FAL_VIDEO_MODELS;
  const known = options.find((o) => o.id === props.value) ?? null;
  const isCustom = props.value !== null && !known;
  const [customDraft, setCustomDraft] = useState(isCustom ? props.value ?? "" : "");
  const selected: VideoModelOption = known ?? {
    id: props.value,
    name: `Custom model: ${props.value}`,
    clipSeconds: null,
    centsPerSecond: null,
    takesStartImage: true,
    needsStartImage: false,
    maxReferences: 0,
    note: "A model id typed by hand. Paperclip cannot check what it accepts.",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="video-model-picker">
      <select
        style={input}
        aria-label="Video model"
        value={isCustom ? CUSTOM : (props.value ?? "")}
        disabled={props.disabled || (props.provider === "sogni" && props.sogniModels === null)}
        onChange={(e) => {
          const next = e.target.value;
          if (next === CUSTOM) return;
          props.onChange(next === "" ? null : next);
        }}
      >
        {options.map((o) => (
          <option key={o.id ?? "default"} value={o.id ?? ""}>
            {o.name}
            {o.premium ? " (premium)" : ""}
          </option>
        ))}
        {isCustom && <option value={CUSTOM}>Custom: {props.value}</option>}
      </select>
      {props.provider === "sogni" && props.sogniModels === null && <span style={{ fontSize: 11, color: "#868e96" }}>Loading Sogni's video models...</span>}
      {props.sogniNote && <span style={{ fontSize: 11, color: "#7f5f01" }}>{props.sogniNote}</span>}
      <div style={{ fontSize: 12, background: "rgba(128,128,128,0.06)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 2 }} data-testid="video-model-details">
        <strong>{selected.name}</strong>
        <span>Clip lengths: {clipLengthsText(selected.clipSeconds)}</span>
        <span>Price: {priceText(selected)}</span>
        <span>{pictureSupportText(selected)}</span>
        {selected.note && <span style={{ color: "#868e96" }}>{selected.note}</span>}
        {props.provider === "fal" && (
          <span style={{ color: "#868e96", fontSize: 11 }}>
            Fal prices are rough figures from Fal's published pricing (list reviewed {FAL_VIDEO_MODELS_DATE}, not read live); check fal.ai/pricing for today's numbers. The cost estimate on this page uses one flat ballpark rate per service.
          </span>
        )}
      </div>
      <details style={{ fontSize: 12 }} open={isCustom}>
        <summary style={{ cursor: "pointer" }}>Advanced: use a model id that is not in the list</summary>
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          <input
            style={{ ...input, flex: "1 1 200px" }}
            aria-label="Custom video model id"
            placeholder={props.provider === "fal" ? "e.g. fal-ai/kling-video/v1.6/pro/text-to-video" : "Sogni model id"}
            value={customDraft}
            disabled={props.disabled}
            onChange={(e) => setCustomDraft(e.target.value)}
          />
          <button type="button" style={secondaryBtn} disabled={props.disabled || !customDraft.trim()} onClick={() => props.onChange(customDraft.trim())}>
            Use this model id
          </button>
        </div>
      </details>
    </div>
  );
}
