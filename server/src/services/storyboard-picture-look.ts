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
import { classifyLoras, madeForText, SOGNI_MAX_LORAS, type LoraFitCheck, type SogniLoraInfo } from "@paperclipai/plugin-sdk/media";
import { assemblePrompt, normalizeRoles, normalizeSheet, SHEET_FIELDS, type CharacterSheet, type ReferenceRole } from "./media-studio-look-prompt.js";

export interface StoryboardLook {
  id: string;
  name: string;
  style: string;
  model: string | null;
  /** "higgsfield" is a look the plugin saved for Higgsfield: storyboard pictures cannot be made with it (see HIGGSFIELD_LOOK_REFUSAL). */
  provider: VideoStorylineProvider | "higgsfield" | null;
  seed: number | null;
  referenceFileIds: string[];
  referenceRoles: ReferenceRole[];
  sheet: CharacterSheet;
  loras: Array<{ id: string; strength: number }>;
  guidance: number | null;
  negativePrompt: string | null;
  /** Off only when an owner/admin saved the look with it off (the plugin's rule). */
  safeContentFilter: boolean;
  /** The saved person (identity) the look shows; null: none. Its character fields and face/body pictures only go on shots with this person in the cast. */
  identityId: string | null;
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
    provider: raw.provider === "fal" || raw.provider === "sogni" || raw.provider === "higgsfield" ? raw.provider : null,
    seed: finite(raw.seed),
    referenceFileIds,
    referenceRoles: normalizeRoles(raw.referenceRoles, referenceFileIds.length),
    sheet: normalizeSheet(raw.sheet),
    loras,
    guidance: finite(raw.guidance),
    negativePrompt: text(raw.negativePrompt),
    safeContentFilter: !(raw.safeContentFilter === false && offBy !== null),
    identityId: text(raw.identityId),
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
  /** Why no picture can be made with this look (a plain sentence for the person), else null. */
  refusal: string | null;
}

/** Higgsfield's only picture model (the plugin's HIGGSFIELD_MODELS); a look with it has no `provider` in older saves. */
const HIGGSFIELD_MODELS = ["soul"];

export const HIGGSFIELD_LOOK_REFUSAL = "Higgsfield can't make storyboard pictures yet; pick a Sogni or Fal look.";

/** A look saved for Higgsfield: its provider says so, or (older saves) it has no provider and Higgsfield's model. */
export function isHiggsfieldLook(look: Pick<StoryboardLook, "provider" | "model">): boolean {
  if (look.provider === "higgsfield") return true;
  return look.provider === null && look.model !== null && HIGGSFIELD_MODELS.includes(look.model.trim().toLowerCase());
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
 * A Higgsfield look is never turned into a Fal or Sogni picture: the target
 * carries a refusal instead.
 */
export function resolveStoryboardPictureTarget(
  settings: PictureSettingsInput,
  shotPictureLookId: string | null | undefined,
  looks: readonly StoryboardLook[],
): StoryboardPictureTarget {
  const lookId = effectiveLookId(settings, shotPictureLookId);
  const look = lookId ? (looks.find((l) => l.id === lookId) ?? null) : null;
  if (look && isHiggsfieldLook(look)) {
    return { providerId: settings.providerId === "sogni" ? "sogni" : "fal", model: null, look, lookId, refusal: HIGGSFIELD_LOOK_REFUSAL };
  }
  const lookProvider = look?.provider === "fal" || look?.provider === "sogni" ? look.provider : null;
  const lookService = look ? (lookProvider ?? (look.model ? serviceOfModel(look.model) : null)) : null;
  const providerId: VideoStorylineProvider =
    settings.providerId === "fal" || settings.providerId === "sogni" ? settings.providerId : (lookService ?? "fal");
  const settingsModel = text(settings.model);
  const model = settingsModel ?? (look?.model && serviceOfModel(look.model) === providerId ? look.model : null);
  return { providerId, model, look, lookId, refusal: null };
}

// ─── The look on one shot: its person, its LoRAs ─────────────────────────

/** The sheet without the character fields (hair, face, outfit, ...): what is left is the setting, style and what to avoid. */
export function sheetWithoutCharacter(sheet: CharacterSheet): CharacterSheet {
  return Object.fromEntries(SHEET_FIELDS.filter((f) => f.group !== "character" && sheet[f.key]).map((f) => [f.key, sheet[f.key]])) as CharacterSheet;
}

/** Picture roles that stay on a shot without the look's person: they show the look's style and setting, not a person or their clothes. */
const SCENE_ROLES: readonly ReferenceRole[] = ["style", "background"];

/**
 * The look as it applies to one shot. A look that shows a saved person
 * (identityId) puts that person's character fields and pictures only on
 * shots where the person is: in the shot's cast, or named in the shot's text
 * (the caller decides, see presentIdentityIds). Any other shot gets the look's
 * style and setting fields and only its style and background pictures: a
 * picture tagged face, body, outfit or "other" (the tag every new picture
 * starts with) may show the person, so it stays out too. A note says what was
 * left out and how to get the person back. A look with no saved person is
 * returned as it is.
 */
export function lookForShot(
  look: StoryboardLook | null,
  presentIdentityIds: ReadonlySet<string>,
  personName?: string | null,
): { look: StoryboardLook | null; note: string | null } {
  if (!look || !look.identityId || presentIdentityIds.has(look.identityId)) return { look, note: null };
  const sheet = sheetWithoutCharacter(look.sheet);
  const referenceFileIds: string[] = [];
  const referenceRoles: ReferenceRole[] = [];
  look.referenceFileIds.forEach((id, i) => {
    const role = look.referenceRoles[i] ?? "other";
    if (!SCENE_ROLES.includes(role)) return;
    referenceFileIds.push(id);
    referenceRoles.push(role);
  });
  const leftOutFields = Object.keys(look.sheet).length > Object.keys(sheet).length;
  const leftOutPictures = referenceFileIds.length < look.referenceFileIds.length;
  const who = personName?.trim() || "the look's saved person";
  const note =
    leftOutFields || leftOutPictures
      ? `The look "${look.name}" shows a saved person (${who}) who is not in this shot's cast and is not named in its description, so its character description and its face, body, outfit and untagged pictures were left out; its style, setting and style and background pictures were used. To put ${who} in this shot, add them to the cast in step 1 and link them to the saved person, or name them in the shot's description.`
      : null;
  return { look: { ...look, sheet, referenceFileIds, referenceRoles }, note };
}

/** Sogni's catalog id for a model name (a tool key such as "qwen-lightning", or a catalog id, which is returned as it is). */
export function sogniCatalogModelId(model: string): string {
  const trimmed = model.trim();
  const key = trimmed.toLowerCase();
  return SOGNI_GENERATE_TOOL_KEYS[key] ?? SOGNI_EDIT_TOOL_KEYS[key] ?? trimmed;
}

/** What people call the models in a note (catalog id -> name); a model not listed shows by its id. */
const SOGNI_MODEL_NAMES: Record<string, string> = {
  z_image_turbo_bf16: "Z-Image Turbo",
  z_image_bf16: "Z-Image",
  krea2_turbo_fp8_scaled: "Krea 2 Turbo",
  dark_beast_krea2_fp8: "Dark Beast Krea 2",
  dark_beast_z_image_turbo_v9_bf16: "Dark Beast Z-Image Turbo v9",
  "chroma-v.46-flash_fp8": "Chroma v.46 Flash",
  "chroma1-hd_fp8_scaled": "Chroma 1 HD",
  "chroma-v48-detail-svd_fp8": "Chroma Detail",
  qwen_image_2512_fp8: "Qwen Image 2512",
  qwen_image_2512_fp8_lightning: "Qwen Image 2512 Lightning",
  qwen_image_edit_2511_fp8_lightning: "Qwen Image Edit 2511 Lightning",
  qwen_image_edit_2511_fp8: "Qwen Image Edit 2511",
  krea2_identity_edit_v1_2: "Krea 2 Identity Edit",
  dark_beast_krea2_identity_edit_v1_2: "Dark Beast Krea 2 Identity Edit",
  krea2_identity_edit_sogni_v0_3_alpha: "Sogni Krea 2 Identity Edit v0.3 Alpha",
  "gpt-image-2": "GPT Image 2",
  "gpt-image-2.5-sunburst": "GPT Image 2.5 Sunburst",
  "gpt-image-2.5-flare": "GPT Image 2.5 Flare",
};

function skippedLorasNote(lookName: string, modelName: string, skipped: LoraFitCheck[]): string {
  const parts = skipped.map((check) =>
    check.fit === "other-models" ? `"${check.name}" (made for ${madeForText(check.madeFor)})` : `"${check.name}" (Sogni does not list it any more)`,
  );
  const one = skipped.length === 1;
  return `The look "${lookName}" has ${one ? "a LoRA that does" : `${skipped.length} LoRAs that do`} not work with ${modelName}, so ${one ? "it was" : "they were"} left out of this picture: ${parts.join(", ")}. An owner or admin can remove ${one ? "it" : "them"} from the look.`;
}

/**
 * The look's LoRAs that fit the model the picture is really made with. Sogni
 * checks LoRAs against the model and can fail the whole picture on one it does
 * not list for it, and a model that ignores a LoRA gives odd pictures, so
 * misfits are left out with a note (the look itself is not changed). Same rule
 * as the Media Studio plugin: when Sogni's LoRA list could not be read nobody
 * can tell, so the LoRAs go as saved and the note says they were not checked.
 * The account's own LoRAs (personal-...) are not in the public list the
 * server reads, so they are kept as saved.
 */
export function fitLorasToModel(
  look: Pick<StoryboardLook, "name" | "loras">,
  model: string,
  known: SogniLoraInfo[] | null,
): { loras: Array<{ id: string; strength: number }>; note: string | null } {
  if (look.loras.length === 0) return { loras: [], note: null };
  const modelId = sogniCatalogModelId(model);
  const modelName = SOGNI_MODEL_NAMES[modelId] ?? modelId;
  if (known === null) {
    return {
      loras: look.loras.slice(0, SOGNI_MAX_LORAS),
      note: `Sogni's list of LoRAs could not be read just now, so the LoRAs of the look "${look.name}" were sent as saved and not checked against ${modelName}.`,
    };
  }
  const checks = classifyLoras({ id: modelId, name: modelName }, look.loras, known, SOGNI_MODEL_NAMES);
  const skipped = checks.filter((check) => check.fit === "other-models" || (check.fit === "unknown" && !check.id.startsWith("personal-")));
  const loras = look.loras.filter((l) => !skipped.some((check) => check.id === l.id)).slice(0, SOGNI_MAX_LORAS);
  return { loras, note: skipped.length > 0 ? skippedLorasNote(look.name, modelName, skipped) : null };
}

/** What Sogni's edit_image (every picture made from reference pictures) ignores of the look; null when the look sets none of it. */
export function editImageDropsNote(look: Pick<StoryboardLook, "name" | "seed" | "guidance" | "negativePrompt"> | null): string | null {
  if (!look) return null;
  const dropped = [look.seed !== null ? "seed" : null, look.guidance !== null ? "guidance" : null, look.negativePrompt ? '"things to avoid" text' : null].filter(
    (x): x is string => x !== null,
  );
  if (dropped.length === 0) return null;
  const list = dropped.length === 1 ? dropped[0]! : `${dropped.slice(0, -1).join(", ")} and ${dropped[dropped.length - 1]}`;
  return `Pictures made from reference pictures use Sogni's picture editor, which has no place for the look's ${list}, so ${dropped.length === 1 ? "it was" : "they were"} not used.`;
}

/** What a Fal.ai picture ignores of the look (LoRAs, seed, guidance, "things to avoid"); null when the look sets none of it. */
export function falIgnoresNote(look: Pick<StoryboardLook, "name" | "loras" | "seed" | "guidance" | "negativePrompt"> | null): string | null {
  if (!look) return null;
  const ignored = [
    look.loras.length > 0 ? (look.loras.length === 1 ? "its LoRA" : "its LoRAs") : null,
    look.seed !== null ? "seed" : null,
    look.guidance !== null ? "guidance" : null,
    look.negativePrompt ? '"things to avoid" text' : null,
  ].filter((x): x is string => x !== null);
  if (ignored.length === 0) return null;
  const list = ignored.length === 1 ? ignored[0]! : `${ignored.slice(0, -1).join(", ")} and ${ignored[ignored.length - 1]}`;
  return `Fal.ai pictures use only the style words and character description of the look "${look.name}", not ${list}, so ${ignored.length === 1 ? "it was" : "they were"} left out. Pick Sogni for this storyline to use ${ignored.length === 1 ? "it" : "them"}.`;
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
