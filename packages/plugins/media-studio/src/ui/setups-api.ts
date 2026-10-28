// Model setups and the LoRA library (Media Studio's "Model setups" tab and the
// setup picker in a film's settings): the types the server sends, the words a
// person sees for them, and one fetch helper that turns every failure into
// plain sentences. The server routes are /api/companies/:id/media/setups,
// .../media/loras and .../media/storylines/:id/setups.
//
// Standalone ES module (see index.tsx's note): local types and styles, no
// imports from @paperclipai/shared. The server writes its refusals in plain
// words already, so they are shown as they are.

import { friendlyStorylineError, StorylineRequestError } from "./storyline-api.js";

export type SetupKind = "image" | "video";
export type SetupStatus = "draft" | "approved" | "archived";
export type SetupProvider = "sogni" | "fal" | "higgsfield" | "comfyui";
export type SetupMode = "t2i" | "edit" | "t2v" | "i2v" | "flf2v" | "r2v" | "extend";
export type LoraProvider = "sogni" | "fal";
export type LoraSource = "catalog" | "personal" | "url";
export type ContentTag = "sfw" | "mature" | "refused" | "unreviewed";
export type ContentRating = "sfw" | "mature";

export interface MediaLoraRow {
  id: string;
  provider: LoraProvider;
  source: LoraSource;
  ref: string;
  name: string;
  notes: string;
  triggerWords: string[];
  family: string | null;
  compatibleModelIds: string[];
  contentTag: ContentTag;
  effectiveContentTag: ContentTag;
  contentNote: string | null;
  strengthMin: number | null;
  strengthMax: number | null;
  strengthDefault: number;
  recommendedMin: number | null;
  recommendedMax: number | null;
  builtinKey: string | null;
  archivedAt: string | null;
}

export interface SetupLoraPick {
  loraId: string;
  strength: number;
  name: string | null;
  ref: string | null;
  source: LoraSource | null;
  triggerWords: string[];
  contentTag: ContentTag | null;
}

export interface MediaSetupRow {
  id: string;
  kind: SetupKind;
  name: string;
  description: string;
  provider: SetupProvider;
  family: string | null;
  mode: SetupMode | null;
  modelId: string;
  editModelId: string | null;
  loras: SetupLoraPick[];
  params: Record<string, unknown>;
  contentRating: ContentRating;
  matureReasons: string[];
  status: SetupStatus;
  approvedAt: string | null;
  tags: string[];
  favorite: boolean;
  notes: string;
  builtinKey: string | null;
  billingLabel: string;
  triggerWords: string[];
  problems: string[];
}

/** What a person types in the setup form; sent as the body of a create or an update. */
export interface SetupDraft {
  kind: SetupKind;
  name: string;
  description: string;
  provider: SetupProvider;
  mode: SetupMode | null;
  modelId: string;
  loras: Array<{ loraId: string; strength: number }>;
  params: Record<string, unknown>;
  tags: string[];
  notes: string;
}

export interface SetupCheck {
  ok: boolean;
  problems: string[];
  contentRating: ContentRating;
  matureReasons: string[];
  billingLabel: string;
  triggerWords: string[];
}

// ─── Words ───────────────────────────────────────────────────────────────────

export const PROVIDER_NAMES: Record<string, string> = { sogni: "Sogni", fal: "Fal.ai", higgsfield: "Higgsfield", comfyui: "ComfyUI" };
export const KIND_NAMES: Record<SetupKind, string> = { video: "Video", image: "Pictures" };

export const MODE_NAMES: Record<SetupMode, string> = {
  t2v: "Video from text only",
  i2v: "Video from a start picture",
  flf2v: "Video from a start and an end picture",
  r2v: "Video that keeps people from reference pictures",
  extend: "Make an existing clip longer",
  t2i: "Picture from text",
  edit: "Change an existing picture",
};
export const VIDEO_MODES: SetupMode[] = ["t2v", "i2v", "flf2v", "r2v", "extend"];
export const IMAGE_MODES: SetupMode[] = ["t2i", "edit"];

export const STATUS_NAMES: Record<SetupStatus, string> = { draft: "Draft", approved: "Approved", archived: "Archived" };
export const STATUS_HELP: Record<SetupStatus, string> = {
  draft: "Not approved yet. Agents cannot use it. You can use it in your own films.",
  approved: "Approved. Agents can pick it for films.",
  archived: "Archived. Not offered anywhere until you restore it.",
};

export const RATING_NAMES: Record<ContentRating, string> = { sfw: "Safe for work", mature: "Mature" };

export const TAG_NAMES: Record<ContentTag, string> = {
  sfw: "Safe for work",
  mature: "Mature",
  refused: "Not allowed",
  unreviewed: "Not checked yet",
};
export const TAG_HELP: Record<ContentTag, string> = {
  sfw: "Checked by a person and fine for safe-for-work films.",
  mature: "Only for films marked mature.",
  refused: "Never allowed in any film.",
  unreviewed: "Nobody has checked this yet, so it counts as mature until someone does.",
};

export const LORA_SOURCE_NAMES: Record<LoraSource, string> = {
  catalog: "From Sogni's list",
  personal: "Imported into your Sogni account",
  url: "Link",
};

export const RECIPE_CHANGE_NOTE =
  "If you change the service, model, way of working, LoRAs or settings of an approved setup, it goes back to draft and has to be approved again. Changing only the name or notes does not.";

export const VIEW_ONLY_NOTE = "You can look at everything here. Only owners and admins can change it.";

export function strengthText(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export function rangeText(min: number | null, max: number | null): string | null {
  if (min === null || max === null) return null;
  return `${strengthText(min)} to ${strengthText(max)}`;
}

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

export function splitWords(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter((w, i, all) => w.length > 0 && all.indexOf(w) === i);
}

/** A link shown without its query string, so a pasted key never sits on the screen. */
export function shortLink(ref: string): string {
  return ref.split(/[?#]/, 1)[0] ?? ref;
}

// ─── Talking to the server ───────────────────────────────────────────────────

/**
 * Like storylineFetchJson, but a refusal that lists problems (a setup or LoRA
 * the safety rules or the model table say no to) shows each one on its own
 * line instead of one long run-on sentence.
 */
export async function setupsFetch<T>(path: string, init?: RequestInit, action?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "include", headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init });
  } catch {
    throw new StorylineRequestError("Could not reach the server. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    try {
      const body = JSON.parse(text) as { error?: unknown; details?: { problems?: unknown } };
      const problems = Array.isArray(body.details?.problems) ? (body.details!.problems as unknown[]).filter((p): p is string => typeof p === "string") : [];
      if ((res.status === 422 || res.status === 409) && problems.length > 0) {
        throw new StorylineRequestError(problems.length === 1 ? problems[0]! : "This cannot be saved yet:", res.status, problems.length === 1 ? [] : problems);
      }
    } catch (e) {
      if (e instanceof StorylineRequestError) throw e;
    }
    throw friendlyStorylineError(res.status, text, action);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function setupsBase(companyId: string): string {
  return `/api/companies/${companyId}/media`;
}

// ─── Styles (the same look as the other Media Studio panels) ─────────────────

export const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
export const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 13 };
export const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
export const muted: React.CSSProperties = { fontSize: 12, color: "#868e96", margin: 0 };
export const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13, whiteSpace: "pre-line" };
export const okBox: React.CSSProperties = { background: "#ebfbee", color: "#087f5b", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
export const warnBox: React.CSSProperties = { background: "#fff4e6", color: "#a24200", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
export const infoBox: React.CSSProperties = { background: "#e7f5ff", color: "#1864ab", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
export const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
export const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
export const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };
export const dangerBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#c92a2a", borderColor: "#ffa8a8" };

export function pill(background: string, color: string): React.CSSProperties {
  return { fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, background, color, whiteSpace: "nowrap" };
}
export const STATUS_PILL: Record<SetupStatus, React.CSSProperties> = {
  draft: pill("#fff4e6", "#d9480f"),
  approved: pill("#e6fcf5", "#087f5b"),
  archived: pill("#f1f3f5", "#495057"),
};
export const RATING_PILL: Record<ContentRating, React.CSSProperties> = {
  sfw: pill("#e7f5ff", "#1864ab"),
  mature: pill("#f3d9fa", "#862e9c"),
};
export const TAG_PILL: Record<ContentTag, React.CSSProperties> = {
  sfw: pill("#e7f5ff", "#1864ab"),
  mature: pill("#f3d9fa", "#862e9c"),
  refused: pill("#ffe3e3", "#c92a2a"),
  unreviewed: pill("#fff4e6", "#d9480f"),
};
