// Storyline Cast: the script's characters linked to the company's saved
// Media Studio identities (see packages/shared/src/video-storyline-cast.ts
// for how the cast is stored). This file reads the identities -- company-
// scoped, from the media-studio plugin's own state (plugin_state, company
// scope, key "identities"; see the plugin's anchors.ts/identity.ts) -- and
// decides which of an identity's pictures go with a storyboard picture or a
// video clip, the same way a Media Studio look that points at an identity
// does (identity.ts planIdentityReferences):
//
//   - the face crop is picture 1 (for two people: both faces first),
//   - then the body crop when the model has a free slot,
//   - then the canonical picture when the identity asks for it,
//   - then the look's own pictures (its face pictures are left out: faces
//     come only from the identities), then the shot's and storyline's
//     character pictures, all within the model's slot limit;
//   - on Sogni, the identity's preferred identity model (krea-identity-edit,
//     or its extra-slot model when more pictures are needed) unless the
//     storyline picks an editing model; on Fal.ai, the identity's preferred
//     Fal editing model or FLUX.2 pro edit;
//   - the identity's Sogni LoRA only under the plugin's own rule: a personal
//     LoRA needs Sogni's content filter off, which only a look an owner or
//     admin saved that way can do, and only on a Krea 2 model.
//
// Consent and age: an identity without both confirmations (likeness consent
// and adult) is never read (normalizeCastIdentity returns null, the plugin's
// normalizeIdentity rule). A picture the plugin's age check refused, or the
// analysis flagged, is never sent: castPictureRefusal finds those.
//
// The server cannot import the plugin package (see media-studio-look-prompt.ts
// for why), so the small pieces needed are copied here; a test checks the
// slot tables against the plugin's.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginState } from "@paperclipai/db";
import type { VideoStorylineCastMember, VideoStorylineProvider } from "@paperclipai/shared";
import type { CharacterSheet, ReferenceRole } from "./media-studio-look-prompt.js";
import { sogniStepModel } from "./storyboard-picture-look.js";

export interface CastIdentityCrop {
  role: "face" | "body" | "outfit" | "other";
  fileId: string;
}

export interface CastTrainedIdentity {
  id: string;
  provider: "sogni-lora" | "fal-lora" | "higgsfield-soul";
  ref: string;
  triggerWord: string | null;
  strength: number | null;
  status: string;
}

/** The fields of a Media Studio identity a storyline uses. */
export interface CastIdentity {
  id: string;
  name: string;
  nickname: string | null;
  sheet: Partial<Record<"hair" | "face" | "eyes" | "body" | "skin" | "marks", string>>;
  crops: CastIdentityCrop[];
  originalFileId: string | null;
  canonicalFileId: string | null;
  canonicalAsReference: boolean;
  preferredModels: { sogni: string; sogniExtraSlot: string; fal: string | null };
  loraBaseModel: string | null;
  trainedIdentities: CastTrainedIdentity[];
}

/** Sogni's identity editor (2 pictures), and the one used when a third picture is needed (identity.ts). */
export const CAST_DEFAULT_SOGNI_MODEL = "krea-identity-edit";
export const CAST_EXTRA_SLOT_SOGNI_MODEL = "qwen";
/** Fal.ai's editing model for pictures of a person when the identity picks none (anchors.ts IDENTITY_PICTURE_MODELS.fal[0]). */
export const CAST_DEFAULT_FAL_MODEL = "fal-ai/flux-2-pro/edit";

/** How many reference pictures each Sogni editing model takes (the plugin's sogni.ts SOGNI_EDIT_MODELS). */
export const CAST_SOGNI_EDIT_SLOTS: Record<string, number> = {
  "qwen-lightning": 3,
  qwen: 3,
  "krea-identity-edit": 2,
  // Sogni's own alpha of Krea 2 Identity Edit (v0.3): no tool key, sent by its catalog id.
  krea2_identity_edit_sogni_v0_3_alpha: 2,
  "dark-beast-krea2-identity-edit": 2,
  "gpt-image-2": 16,
  "gpt-image-2.5-sunburst": 16,
  "gpt-image-2.5-flare": 16,
};

/** How many reference pictures each Fal.ai editing model takes (the plugin's anchors.ts FAL_EDIT_MAX_REFERENCES). */
export const CAST_FAL_EDIT_SLOTS: Record<string, number> = {
  "fal-ai/flux-2-pro/edit": 9,
  "fal-ai/nano-banana-2/edit": 14,
  "fal-ai/flux-pro/kontext/multi": 4,
};

const CONSENT_OK = (value: unknown) => {
  const c = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  return c?.likeness === true && c?.adult === true;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The plugin's normalizeIdentity, for the fields used here. An identity without both confirmations is never used. */
export function normalizeCastIdentity(value: unknown): CastIdentity | null {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  if (!CONSENT_OK(raw.consent)) return null;
  const crops: CastIdentityCrop[] = Array.isArray(raw.crops)
    ? raw.crops.flatMap((c) => {
        const crop = c && typeof c === "object" ? (c as Record<string, unknown>) : null;
        const role = crop?.role;
        const fileId = str(crop?.fileId);
        return fileId && (role === "face" || role === "body" || role === "outfit" || role === "other") ? [{ role, fileId }] : [];
      })
    : [];
  const sheetRaw = raw.sheet && typeof raw.sheet === "object" ? (raw.sheet as Record<string, unknown>) : {};
  const sheet: CastIdentity["sheet"] = {};
  for (const key of ["hair", "face", "eyes", "body", "skin", "marks"] as const) {
    const v = str(sheetRaw[key]);
    if (v) sheet[key] = v;
  }
  const models = raw.preferredModels && typeof raw.preferredModels === "object" ? (raw.preferredModels as Record<string, unknown>) : {};
  const lora = raw.lora && typeof raw.lora === "object" ? (raw.lora as Record<string, unknown>) : null;
  const trainedIdentities: CastTrainedIdentity[] = Array.isArray(raw.trainedIdentities)
    ? raw.trainedIdentities.flatMap((t) => {
        const item = t && typeof t === "object" ? (t as Record<string, unknown>) : null;
        const provider = item?.provider;
        if (!item || typeof item.id !== "string" || typeof item.ref !== "string") return [];
        if (provider !== "sogni-lora" && provider !== "fal-lora" && provider !== "higgsfield-soul") return [];
        return [
          {
            id: item.id,
            provider,
            ref: item.ref,
            triggerWord: str(item.triggerWord),
            strength: typeof item.strength === "number" && Number.isFinite(item.strength) ? item.strength : null,
            status: typeof item.status === "string" ? item.status : "",
          },
        ];
      })
    : [];
  return {
    id: raw.id,
    name: raw.name,
    nickname: str(raw.nickname),
    sheet,
    crops,
    originalFileId: str(raw.originalFileId),
    canonicalFileId: str(raw.canonicalFileId),
    canonicalAsReference: raw.canonicalAsReference === true,
    preferredModels: {
      sogni: str(models.sogni) ?? CAST_DEFAULT_SOGNI_MODEL,
      sogniExtraSlot: str(models.sogniExtraSlot) ?? CAST_EXTRA_SLOT_SOGNI_MODEL,
      fal: str(models.fal),
    },
    loraBaseModel: str(lora?.baseModel) ?? (lora ? "krea-2" : null),
    trainedIdentities,
  };
}

async function readPluginState(db: Db, pluginId: string, companyId: string, stateKey: string): Promise<unknown> {
  const [row] = await db
    .select({ value: pluginState.valueJson })
    .from(pluginState)
    .where(
      and(
        eq(pluginState.pluginId, pluginId),
        eq(pluginState.scopeKind, "company"),
        eq(pluginState.scopeId, companyId),
        eq(pluginState.namespace, "default"),
        eq(pluginState.stateKey, stateKey),
      ),
    )
    .limit(1);
  return row?.value ?? null;
}

/** This company's saved identities (only ones with both confirmations). Another company's are never read. */
export async function loadCastIdentities(db: Db, pluginId: string | null, companyId: string): Promise<CastIdentity[]> {
  if (!pluginId) return [];
  const raw = await readPluginState(db, pluginId, companyId, "identities");
  return Array.isArray(raw) ? raw.map(normalizeCastIdentity).filter((i): i is CastIdentity => i !== null) : [];
}

/** What the plugin's age check already refused for this company: flagged file ids, and picture hashes not judged "adult". */
export async function loadCastAgeRefusals(db: Db, pluginId: string | null, companyId: string): Promise<{ fileIds: Set<string>; hashes: Set<string> }> {
  if (!pluginId) return { fileIds: new Set(), hashes: new Set() };
  const [blocks, checks] = await Promise.all([
    readPluginState(db, pluginId, companyId, "identityAgeBlocks"),
    readPluginState(db, pluginId, companyId, "pictureAgeChecks"),
  ]);
  const fileIds = new Set(Array.isArray(blocks) ? blocks.filter((x): x is string => typeof x === "string") : []);
  const hashes = new Set<string>();
  if (checks && typeof checks === "object" && !Array.isArray(checks)) {
    for (const [hash, rec] of Object.entries(checks as Record<string, unknown>)) {
      const verdict = rec && typeof rec === "object" ? (rec as Record<string, unknown>).verdict : null;
      if (verdict === "under18" || verdict === "unclear") hashes.add(hash);
    }
  }
  return { fileIds, hashes };
}

/** sha256 of a data: URI's bytes (what the plugin keeps its age checks by). */
export function dataUriSha256(dataUri: string): string | null {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(dataUri);
  if (!match?.[1]) return null;
  return createHash("sha256").update(Buffer.from(match[1], "base64")).digest("hex");
}

/**
 * A plain refusal when one of a cast member's pictures was flagged by the
 * age check (never sent anywhere), else null.
 */
export function castPictureRefusal(
  pictures: ReadonlyArray<{ fileId: string; dataUri: string | null; personName: string }>,
  refusals: { fileIds: Set<string>; hashes: Set<string> },
): string | null {
  for (const p of pictures) {
    const hash = p.dataUri ? dataUriSha256(p.dataUri) : null;
    if (refusals.fileIds.has(p.fileId) || (hash && refusals.hashes.has(hash))) {
      return `One of ${p.personName}'s pictures did not pass Media Studio's age check (only pictures clearly of an adult are ever sent), so nothing was made. Change ${p.personName}'s pictures on the Identities tab, or unlink ${p.personName} in the Cast section of step 1.`;
    }
  }
  return null;
}

// ─── Who is in a shot ─────────────────────────────────────────────────────────

export interface CastPerson {
  member: VideoStorylineCastMember;
  identity: CastIdentity;
}

/** The linked identities of the shot's cast, in cast order; a member whose identity is gone gets a plain note. */
export function castPeople(
  castIds: readonly string[],
  members: readonly VideoStorylineCastMember[],
  identities: readonly CastIdentity[],
): { people: CastPerson[]; notes: string[] } {
  const people: CastPerson[] = [];
  const notes: string[] = [];
  for (const id of castIds) {
    const member = members.find((m) => m.id === id);
    if (!member?.identityId) continue;
    const identity = identities.find((i) => i.id === member.identityId);
    if (!identity) {
      notes.push(`${member.name} is linked to a saved person who no longer exists (or is missing a confirmation), so ${member.name} was made from the description only. Link them again in step 1's Cast section.`);
      continue;
    }
    people.push({ member, identity });
  }
  return { people, notes };
}

export function castIdentityNames(identities: readonly CastIdentity[]): Record<string, { name: string; nickname: string | null }> {
  return Object.fromEntries(identities.map((i) => [i.id, { name: i.name, nickname: i.nickname }]));
}

function faceOf(identity: CastIdentity): string | null {
  return identity.crops.find((c) => c.role === "face")?.fileId ?? identity.canonicalFileId ?? identity.originalFileId;
}

function bodyOf(identity: CastIdentity): string | null {
  return identity.crops.find((c) => c.role === "body")?.fileId ?? null;
}

// ─── Storyboard pictures ──────────────────────────────────────────────────────

/** The Sogni editing model's slots (unknown models: 3, the plugin's default). */
export function castSogniSlots(model: string): number {
  return CAST_SOGNI_EDIT_SLOTS[sogniStepModel(model, "edit_image")] ?? 3;
}

/** Sogni catalogue ids of the Krea 2 identity editors (what a Krea 2 LoRA fits). */
const SOGNI_EDIT_CANONICAL: Record<string, string> = {
  "krea-identity-edit": "krea2_identity_edit_v1_2",
  "dark-beast-krea2-identity-edit": "dark_beast_krea2_identity_edit_v1_2",
};

export interface CastStillPlan {
  ids: string[];
  roles: ReferenceRole[];
  /** The model to use. */
  model: string;
  /** Which picture belongs to which person (for the prompt and the result). */
  owners: Array<string | null>;
  /** The identity's Sogni LoRA, when the plugin's rules allow it. */
  lora: { id: string; strength: number; triggerWord: string | null } | null;
  notes: string[];
}

/**
 * Which pictures go with a storyboard picture of a shot with cast members.
 * Faces first (one per person, never dropped for the look's pictures), then
 * bodies, then canonical pictures the identity asks for, then the look's own
 * pictures (faces left out) and the shot's/storyline's pictures, within the
 * slot limit of the model and the storyboard's own cap.
 */
export function planCastStill(input: {
  people: readonly CastPerson[];
  service: VideoStorylineProvider;
  /** The storyline's picked model (null: the identity picks). */
  pickedModel: string | null;
  lookIds: readonly string[];
  lookRoles: readonly ReferenceRole[];
  /** The shot's and storyline's character pictures ("other"). */
  extraIds: readonly string[];
  /** The storyboard's own cap on pictures per still. */
  cap: number;
  /** Sogni's content filter for this picture (off only through a look an owner/admin saved that way). */
  safeContentFilter: boolean;
}): CastStillPlan {
  const notes: string[] = [];
  const faces: Array<{ id: string; owner: string }> = [];
  const extras: Array<{ id: string; role: ReferenceRole; owner: string }> = [];
  for (const { member, identity } of input.people) {
    const face = faceOf(identity);
    if (!face) {
      notes.push(`${member.name}'s saved person "${identity.name}" has no face picture yet, so ${member.name} was made from the description only. Add a face crop on the Identities tab.`);
      continue;
    }
    if (faces.some((f) => f.id === face)) continue;
    faces.push({ id: face, owner: member.name });
  }
  for (const { member, identity } of input.people) {
    const face = faceOf(identity);
    if (!face) continue;
    const body = bodyOf(identity);
    if (body && body !== face) extras.push({ id: body, role: "body", owner: member.name });
  }
  for (const { member, identity } of input.people) {
    if (identity.canonicalAsReference && identity.canonicalFileId && identity.canonicalFileId !== faceOf(identity)) {
      extras.push({ id: identity.canonicalFileId, role: "face", owner: member.name });
    }
  }
  const look: Array<{ id: string; role: ReferenceRole }> = [];
  let droppedLookFaces = 0;
  input.lookIds.forEach((id, i) => {
    const role = input.lookRoles[i] ?? "other";
    if (role === "face") {
      droppedLookFaces += 1;
      return;
    }
    look.push({ id, role });
  });
  for (const id of input.extraIds) look.push({ id, role: "other" });
  if (droppedLookFaces > 0 && faces.length > 0) {
    notes.push(`The look's face ${droppedLookFaces === 1 ? "picture was" : "pictures were"} left out: faces come from the linked people.`);
  }

  // The model, and how many pictures it takes.
  let model: string;
  let slots: number;
  if (input.service === "sogni") {
    const picked = input.pickedModel ? sogniStepModel(input.pickedModel, "edit_image") : null;
    if (picked && picked in CAST_SOGNI_EDIT_SLOTS) {
      model = picked;
    } else {
      const first = input.people[0]?.identity;
      const preferred = sogniStepModel(first?.preferredModels.sogni || CAST_DEFAULT_SOGNI_MODEL, "edit_image");
      const extra = sogniStepModel(first?.preferredModels.sogniExtraSlot || CAST_EXTRA_SLOT_SOGNI_MODEL, "edit_image");
      const wanted = faces.length + (extras.length > 0 ? 1 : 0);
      model = wanted > castSogniSlots(preferred) && castSogniSlots(extra) > castSogniSlots(preferred) ? extra : preferred;
      if (picked) notes.push(`The picked model "${input.pickedModel}" cannot make a picture from reference pictures, so ${model} was used to keep the people the same.`);
    }
    slots = castSogniSlots(model);
  } else {
    const picked = input.pickedModel && input.pickedModel in CAST_FAL_EDIT_SLOTS ? input.pickedModel : null;
    const preferred = input.people.map((p) => p.identity.preferredModels.fal).find((m): m is string => !!m && m in CAST_FAL_EDIT_SLOTS) ?? null;
    model = picked ?? preferred ?? CAST_DEFAULT_FAL_MODEL;
    slots = CAST_FAL_EDIT_SLOTS[model] ?? 4;
  }
  slots = Math.max(1, Math.min(slots, input.cap));

  const chosen: Array<{ id: string; role: ReferenceRole; owner: string | null }> = [];
  const keptFaces = faces.slice(0, slots);
  for (const f of keptFaces) chosen.push({ id: f.id, role: "face", owner: f.owner });
  if (keptFaces.length < faces.length) {
    const left = faces.slice(keptFaces.length).map((f) => f.owner);
    notes.push(
      `This picture model takes ${slots} reference ${slots === 1 ? "picture" : "pictures"}, so only ${keptFaces.map((f) => f.owner).join(" and ")} ${keptFaces.length === 1 ? "was" : "were"} sent as a face picture; ${left.join(" and ")} ${left.length === 1 ? "was" : "were"} made from the description only. Pick a model with more slots (for example qwen or gpt-image-2 on Sogni) to keep everyone the same.`,
    );
  }
  let skipped = 0;
  for (const e of extras) {
    if (chosen.some((c) => c.id === e.id)) continue;
    if (chosen.length < slots && keptFaces.some((f) => f.owner === e.owner)) chosen.push(e);
    else skipped += 1;
  }
  for (const l of look) {
    if (chosen.some((c) => c.id === l.id)) continue;
    if (chosen.length < slots) chosen.push({ ...l, owner: null });
    else skipped += 1;
  }
  if (skipped > 0) {
    notes.push(`The model takes ${slots} reference ${slots === 1 ? "picture" : "pictures"}, so ${skipped} other ${skipped === 1 ? "picture was" : "pictures were"} left out (faces always go first).`);
  }
  if (keptFaces.length > 1) {
    notes.push(`${keptFaces.length} people are in this shot. Pictures with more than one saved person are harder for picture models; check that nobody's face got mixed up.`);
  }

  // The identity's own Sogni LoRA: only for one person, on a Krea 2 model, with the content filter off.
  let lora: CastStillPlan["lora"] = null;
  if (input.service === "sogni" && input.people.length > 0) {
    const person = input.people.find((p) => keptFaces.some((f) => f.owner === p.member.name));
    const trained = person
      ? [...person.identity.trainedIdentities].reverse().find((t) => t.provider === "sogni-lora" && (t.status === "ready" || t.status === "completed"))
      : undefined;
    if (person && trained) {
      const krea = /krea/i.test(person.identity.loraBaseModel ?? "krea-2");
      const modelId = (SOGNI_EDIT_CANONICAL[model] ?? model).toLowerCase();
      if (keptFaces.length > 1) {
        notes.push(`${person.member.name}'s LoRA was not used: with more than one person in the picture it would pull every face towards ${person.member.name}.`);
      } else if (input.safeContentFilter) {
        notes.push(`${person.member.name}'s LoRA was not used: Sogni only runs your own LoRAs with its content filter off, which only a look an owner or admin saved that way can do. The reference pictures still keep ${person.member.name} the same.`);
      } else if (!krea || !(modelId.startsWith("krea2") || modelId.startsWith("dark_beast_krea2"))) {
        notes.push(`${person.member.name}'s LoRA was not used: it is made for Krea 2 models, and this picture uses ${model}.`);
      } else {
        lora = { id: trained.ref, strength: trained.strength ?? 0.8, triggerWord: trained.triggerWord };
      }
    }
  }
  return { ids: chosen.map((c) => c.id), roles: chosen.map((c) => c.role), owners: chosen.map((c) => c.owner), model, lora, notes };
}

/** "Maja is the person in picture 1." -- said before the picture roles so each face has a name. */
export function castPromptLine(plan: Pick<CastStillPlan, "roles" | "owners">, service: VideoStorylineProvider): string {
  const noun = service === "sogni" ? "picture" : "image";
  const byPerson = new Map<string, number[]>();
  plan.owners.forEach((owner, i) => {
    if (!owner || plan.roles[i] !== "face") return;
    byPerson.set(owner, [...(byPerson.get(owner) ?? []), i + 1]);
  });
  if (byPerson.size === 0) return "";
  const parts = Array.from(byPerson.entries()).map(([name, positions]) => `${name} is the person in ${noun} ${positions.join(" and ")}`);
  const line = `${parts.join("; ")}.`;
  return byPerson.size > 1 ? `${line} Keep each person's own face; never mix their faces up.` : line;
}

/** The identity's locked description over the look's (identity.ts sheetWithIdentity). */
export function sheetWithCastIdentity(lookSheet: CharacterSheet | null | undefined, identity: CastIdentity): CharacterSheet {
  const merged: CharacterSheet = { ...(lookSheet ?? {}) };
  const s = identity.sheet;
  if (s.hair) merged.hair = s.hair;
  if (s.eyes) merged.eyes = s.eyes;
  if (s.body) merged.body = s.body;
  if (s.skin) merged.skin = s.skin;
  const face = [s.face, s.marks ? `distinguishing marks: ${s.marks}` : null].filter(Boolean).join("; ");
  if (face) merged.face = face;
  return merged;
}

// ─── Video clips ──────────────────────────────────────────────────────────────

/**
 * The pictures of each person for a video clip: the face crop first (the
 * "frontal" picture video models want), then the canonical render, then the
 * body crop. The approved storyboard picture stays the start frame; these go
 * as character/reference pictures where the video model takes them.
 */
export function castVideoPictures(people: readonly CastPerson[]): Array<{ name: string; fileIds: string[] }> {
  return people.flatMap(({ member, identity }) => {
    const ids: string[] = [];
    for (const id of [faceOf(identity), identity.canonicalFileId, bodyOf(identity)]) {
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids.length > 0 ? [{ name: member.name, fileIds: ids.slice(0, 3) }] : [];
  });
}

/** Load the cast's identities for these ids (company-scoped), keeping only those linked from this cast. */
export async function loadLinkedCastIdentities(
  db: Db,
  pluginId: string | null,
  companyId: string,
  members: readonly VideoStorylineCastMember[],
): Promise<CastIdentity[]> {
  if (!members.some((m) => m.identityId)) return [];
  const all = await loadCastIdentities(db, pluginId, companyId);
  const wanted = new Set(members.map((m) => m.identityId).filter((x): x is string => !!x));
  return all.filter((i) => wanted.has(i.id));
}
