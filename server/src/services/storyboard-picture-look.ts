// Storyboard pictures with a picture service, model and Media Studio look.
//
// A storyline's picture settings ({providerId?, model?, lookId?}) and a shot's
// own look override (pictureLookId: a look id, "none", or null) decide what
// the next storyboard picture is made with. Looks live in the media-studio
// plugin's own state (plugin_state, company scope, key "looks" -- see the
// plugin worker's looksScope/normalizeLook); they are read here, company-
// scoped, and applied the way the plugin applies a look: its style words and
// character sheet through the same prompt builder (media-studio-look-prompt.ts),
// its reference pictures (with their roles) first, then the shot's and the
// storyline's character pictures, and on Sogni its LoRAs, seed, guidance,
// "things to avoid" text and Sensitive Content Filter setting.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginState } from "@paperclipai/db";
import { VIDEO_SHOT_PICTURE_LOOK_NONE, type VideoStorylineProvider } from "@paperclipai/shared";
import { assemblePrompt, normalizeRoles, normalizeSheet, type CharacterSheet, type ReferenceRole } from "./media-studio-look-prompt.js";

export interface StoryboardLook {
  id: string;
  name: string;
  style: string;
  model: string | null;
  provider: VideoStorylineProvider | null;
  seed: number | null;
  referenceFileIds: string[];
  referenceRoles: ReferenceRole[];
  sheet: CharacterSheet;
  loras: Array<{ id: string; strength: number }>;
  guidance: number | null;
  negativePrompt: string | null;
  /** Off only when an owner/admin saved the look with it off (the plugin's rule). */
  safeContentFilter: boolean;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The plugin worker's normalizeLook, for the fields a storyboard picture uses. */
export function normalizeStoryboardLook(value: unknown): StoryboardLook | null {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.style !== "string" || !Array.isArray(raw.referenceFileIds)) return null;
  const referenceFileIds = raw.referenceFileIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  const loras = Array.isArray(raw.loras)
    ? raw.loras.flatMap((item) => {
        const l = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
        const strength = finite(l?.strength);
        return l && typeof l.id === "string" && l.id && strength !== null ? [{ id: l.id, strength }] : [];
      })
    : [];
  const offBy = text(raw.contentFilterOffBy);
  return {
    id: raw.id,
    name: raw.name,
    style: raw.style,
    model: text(raw.model),
    provider: raw.provider === "fal" || raw.provider === "sogni" ? raw.provider : null,
    seed: finite(raw.seed),
    referenceFileIds,
    referenceRoles: normalizeRoles(raw.referenceRoles, referenceFileIds.length),
    sheet: normalizeSheet(raw.sheet),
    loras,
    guidance: finite(raw.guidance),
    negativePrompt: text(raw.negativePrompt),
    safeContentFilter: !(raw.safeContentFilter === false && offBy !== null),
  };
}

/** The company's saved Media Studio looks (empty when the plugin is not installed or has none). */
export async function loadStoryboardLooks(db: Db, pluginId: string | null, companyId: string): Promise<StoryboardLook[]> {
  if (!pluginId) return [];
  const [row] = await db
    .select({ value: pluginState.valueJson })
    .from(pluginState)
    .where(
      and(
        eq(pluginState.pluginId, pluginId),
        eq(pluginState.scopeKind, "company"),
        eq(pluginState.scopeId, companyId),
        eq(pluginState.namespace, "default"),
        eq(pluginState.stateKey, "looks"),
      ),
    )
    .limit(1);
  const list = Array.isArray(row?.value) ? row!.value : [];
  return list.map(normalizeStoryboardLook).filter((look): look is StoryboardLook => look !== null);
}

// ─── Sogni model names (the plugin's sogni.ts tool-key tables) ─────────────

const SOGNI_GENERATE_TOOL_KEYS: Record<string, string> = {
  "z-turbo": "z_image_turbo_bf16",
  "z-image": "z_image_bf16",
  "krea-2-turbo": "krea2_turbo_fp8_scaled",
  "dark-beast-krea2": "dark_beast_krea2_fp8",
  "dark-beast-z-turbo": "dark_beast_z_image_turbo_v9_bf16",
  "chroma-v46-flash": "chroma-v.46-flash_fp8",
  "chroma1-hd": "chroma1-hd_fp8_scaled",
  "chroma-detail": "chroma-v48-detail-svd_fp8",
  "qwen-2512": "qwen_image_2512_fp8",
  "qwen-2512-lightning": "qwen_image_2512_fp8_lightning",
  "gpt-image-2": "gpt-image-2",
  "gpt-image-2.5-sunburst": "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare": "gpt-image-2.5-flare",
};

const SOGNI_EDIT_TOOL_KEYS: Record<string, string> = {
  "qwen-lightning": "qwen_image_edit_2511_fp8_lightning",
  qwen: "qwen_image_edit_2511_fp8",
  "krea-identity-edit": "krea2_identity_edit_v1_2",
  "dark-beast-krea2-identity-edit": "dark_beast_krea2_identity_edit_v1_2",
  "gpt-image-2": "gpt-image-2",
  "gpt-image-2.5-sunburst": "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare": "gpt-image-2.5-flare",
};

/**
 * Edit models Sogni's catalog lists but its edit_image tool schema has no key
 * for, so they are sent by catalog id (the plugin's sogni.ts
 * SOGNI_EDIT_CATALOG_ONLY): Sogni's Krea 2 Identity Edit v0.3 alpha.
 */
const SOGNI_EDIT_CATALOG_ONLY = new Set(["krea2_identity_edit_sogni_v0_3_alpha"]);

/** The Sogni workflow's `model` argument: the tool key when the model has one, else the catalog id (Sogni passes those through). */
export function sogniStepModel(model: string, tool: "generate_image" | "edit_image"): string {
  const trimmed = model.trim();
  const keys = tool === "edit_image" ? SOGNI_EDIT_TOOL_KEYS : SOGNI_GENERATE_TOOL_KEYS;
  if (trimmed.toLowerCase() in keys) return trimmed.toLowerCase();
  const key = Object.keys(keys).find((k) => keys[k] === trimmed);
  return key ?? trimmed;
}

/** Only these Sogni models make a picture from reference pictures; anything else falls back to Sogni's fast editor. */
export function sogniEditModelOrDefault(model: string | null): string {
  if (!model) return "qwen-lightning";
  const key = sogniStepModel(model, "edit_image");
  return key in SOGNI_EDIT_TOOL_KEYS || SOGNI_EDIT_CATALOG_ONLY.has(key) ? key : "qwen-lightning";
}

/** Which service a model name belongs to: Fal model ids are paths (fal-ai/...), Sogni's are not. */
export function serviceOfModel(model: string): VideoStorylineProvider {
  return model.includes("/") ? "fal" : "sogni";
}

// ─── What the next picture is made with ───────────────────────────────────

export interface PictureSettingsInput {
  providerId?: string | null;
  model?: string | null;
  lookId?: string | null;
}

export interface StoryboardPictureTarget {
  providerId: VideoStorylineProvider;
  /** null = the service's default picture model. */
  model: string | null;
  look: StoryboardLook | null;
  /** The look id asked for (storyline's or the shot's own), even when it no longer exists. */
  lookId: string | null;
}

/** The shot's own look wins over the storyline's; "none" means no look for this shot. */
export function effectiveLookId(settings: PictureSettingsInput, shotPictureLookId: string | null | undefined): string | null {
  if (shotPictureLookId === VIDEO_SHOT_PICTURE_LOOK_NONE) return null;
  return shotPictureLookId ?? settings.lookId ?? null;
}

/**
 * Service: the storyline's choice, else the look's service, else the one its
 * model implies, else Fal.ai. Model: the storyline's choice, else the look's
 * own model when it belongs to the same service, else the service's default.
 */
export function resolveStoryboardPictureTarget(
  settings: PictureSettingsInput,
  shotPictureLookId: string | null | undefined,
  looks: readonly StoryboardLook[],
): StoryboardPictureTarget {
  const lookId = effectiveLookId(settings, shotPictureLookId);
  const look = lookId ? (looks.find((l) => l.id === lookId) ?? null) : null;
  const lookService = look ? (look.provider ?? (look.model ? serviceOfModel(look.model) : null)) : null;
  const providerId: VideoStorylineProvider =
    settings.providerId === "fal" || settings.providerId === "sogni" ? settings.providerId : (lookService ?? "fal");
  const settingsModel = text(settings.model);
  const model = settingsModel ?? (look?.model && serviceOfModel(look.model) === providerId ? look.model : null);
  return { providerId, model, look, lookId };
}

/**
 * The reference pictures (company file / asset ids) in the order they are
 * sent, with a role each: the look's own pictures first (their saved roles),
 * then the shot's and the storyline's character pictures ("other").
 */
export function storyboardReferences(
  look: StoryboardLook | null,
  shotReferenceIds: readonly string[],
  storylineCharacterIds: readonly string[],
  max: number,
): { ids: string[]; roles: ReferenceRole[] } {
  const ids: string[] = [];
  const roles: ReferenceRole[] = [];
  const add = (id: string, role: ReferenceRole) => {
    if (ids.length >= max || ids.includes(id)) return;
    ids.push(id);
    roles.push(role);
  };
  look?.referenceFileIds.forEach((id, i) => add(id, look.referenceRoles[i] ?? "other"));
  for (const id of shotReferenceIds) add(id, "other");
  for (const id of storylineCharacterIds) add(id, "other");
  return { ids, roles };
}

/** The picture's prompt: the shot's description plus the look (style words, sheet, what each picture is for). */
export function storyboardPrompt(request: string, look: StoryboardLook | null, roles: ReferenceRole[], service: VideoStorylineProvider): string {
  if (!look) return request;
  return assemblePrompt({ request, style: look.style, sheet: look.sheet, roles, service }).prompt;
}
