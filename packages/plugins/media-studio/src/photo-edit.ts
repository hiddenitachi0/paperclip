// A photo the person sent in a chat, changed on request ("alter this image to
// show you helping him prepare the meat"). That is an EDIT of their photo, not
// a new picture of the agent:
//
//  - the person's photo is picture 1, the base the edit model changes;
//  - the agent's identity and look pictures follow, only as the person to
//    add, as many as the edit model takes;
//  - the picture is made with a model that edits pictures (Sogni's Qwen Image
//    Edit or Krea Identity Edit, Fal's FLUX Kontext), never with a model that
//    only draws new pictures from text;
//  - the prompt says to keep the scene and everyone in it (look-prompt.ts,
//    assemblePhotoEditPrompt), instead of the look's full character sheet,
//    which would re-draw the scene around the agent.
//
// Which reference counts as "the person's photo": a file id the host lists
// in runContext.attachedFileIds (pictures the person attached in this
// quick-agent chat, set by the host only, never by the tool input).

import type { ReferenceRole } from "./look-prompt.js";
import { FAL_REFERENCE_MODEL } from "./providers.js";
import type { Identity } from "./identity.js";
import { SOGNI_EDIT_MODELS, sogniCanonicalModelId, sogniWorkflowModel } from "./sogni.js";

/**
 * Sogni's model for a photo edit when neither the look nor the settings pick
 * one that edits: Qwen Image Edit 2511 (3 pictures: the photo, the face and
 * the body), the editor that adds a person from other pictures into a base
 * picture. Krea Identity Edit (2 pictures) keeps faces best but only has room
 * for the photo and the face; a look or identity can still pick it.
 */
export const PHOTO_EDIT_SOGNI_MODEL = "qwen";

/** The references that are photos the person attached in this chat, in the order the call gave them. */
export function attachedReferenceIds(requested: readonly string[], attachedFileIds: readonly string[] | null | undefined): string[] {
  const attached = new Set((attachedFileIds ?? []).map((id) => id.toLowerCase()));
  return requested.filter((id) => attached.has(id.toLowerCase()));
}

/** A Sogni model that edits pictures: a known edit model, or one Sogni's catalog says takes reference pictures. */
export function isSogniEditModel(model: string | null | undefined, takesReferences = false): boolean {
  if (!model?.trim()) return false;
  if (sogniWorkflowModel(model, "edit_image") in SOGNI_EDIT_MODELS) return true;
  if (sogniCanonicalModelId(model) in SOGNI_EDIT_MODELS) return true;
  return takesReferences;
}

/** A Fal model that edits pictures (FLUX Kontext, or any "…/edit" model). */
export function isFalEditModel(model: string | null | undefined): boolean {
  if (!model?.trim()) return false;
  return /(?:^|\/)kontext(?:\/|$)|(?:^|\/)edit(?:\/|$)|-edit(?:\/|$)/i.test(model.trim());
}

/** The Fal model for a photo edit: the settings' model when it edits, else FLUX Kontext multi. */
export function falPhotoEditModel(settingsModel: string | null | undefined): string {
  return isFalEditModel(settingsModel) ? settingsModel!.trim() : FAL_REFERENCE_MODEL;
}

export interface PhotoEditPlan {
  /** In upload order: the person's photo(s) first, then the agent's pictures. */
  fileIds: string[];
  roles: ReferenceRole[];
  /** How many of `fileIds` are the person's photos (always the first ones). */
  photoCount: number;
  /** 1-based positions of the agent's face pictures, for the identity sentence. */
  facePositions: number[];
  /** Plain sentences about pictures left out. */
  notes: string[];
}

/**
 * The pictures sent for a photo edit, in order: the person's photo(s), then
 * the identity's face, body and (with "same outfit") outfit crops, then the
 * look's own pictures that show the agent (face only when there is no
 * identity, body, outfit, other), then any other picture the call named.
 * A look's style and background pictures are left out: the scene is the
 * photo's. Never more than `slots`; the photo is never left out.
 */
export function planPhotoEditReferences(input: {
  photoIds: string[];
  identity: Identity | null;
  lookFileIds: string[];
  lookRoles: ReferenceRole[];
  sameOutfit: boolean;
  /** Other pictures the call named that are not the person's photos. */
  extraIds: string[];
  slots: number;
}): PhotoEditPlan {
  const notes: string[] = [];
  const photos = input.photoIds.slice(0, Math.max(1, input.slots));
  if (photos.length < input.photoIds.length) {
    const left = input.photoIds.length - photos.length;
    notes.push(`The editing model takes ${input.slots} picture${input.slots === 1 ? "" : "s"}, so ${left} of the photos sent ${left === 1 ? "was" : "were"} left out.`);
  }
  const used = new Set(photos.map((id) => id.toLowerCase()));
  const person: Array<{ id: string; role: ReferenceRole }> = [];
  const add = (id: string | null | undefined, role: ReferenceRole) => {
    if (!id || used.has(id.toLowerCase())) return;
    used.add(id.toLowerCase());
    person.push({ id, role });
  };
  const identity = input.identity;
  if (identity) {
    const face = identity.crops.find((c) => c.role === "face")?.fileId ?? identity.canonicalFileId ?? identity.originalFileId;
    add(face, "face");
    add(identity.crops.find((c) => c.role === "body")?.fileId, "body");
    if (input.sameOutfit) add(identity.crops.find((c) => c.role === "outfit")?.fileId, "outfit");
  }
  let leftOutScene = 0;
  input.lookFileIds.forEach((id, i) => {
    const role = input.lookRoles[i] ?? "other";
    if (role === "style" || role === "background") {
      leftOutScene += 1;
      return;
    }
    if (role === "face" && identity) return;
    add(id, role);
  });
  for (const id of input.extraIds) add(id, "other");
  if (leftOutScene > 0) {
    notes.push(`The look's ${leftOutScene === 1 ? "style/background picture was" : "style/background pictures were"} left out: the scene comes from the photo.`);
  }
  const room = Math.max(0, input.slots - photos.length);
  const kept = person.slice(0, room);
  if (person.length > kept.length) {
    const left = person.length - kept.length;
    notes.push(`The editing model takes ${input.slots} pictures, so the photo went first and ${left} of the agent's own ${left === 1 ? "picture was" : "pictures were"} left out.`);
  }
  const fileIds = [...photos, ...kept.map((p) => p.id)];
  const roles: ReferenceRole[] = [...photos.map(() => "other" as const), ...kept.map((p) => p.role)];
  const facePositions = roles.flatMap((role, i) => (i >= photos.length && role === "face" ? [i + 1] : []));
  return { fileIds, roles, photoCount: photos.length, facePositions, notes };
}

/** "you" that is only how a request is asked ("can you", "you left out"), not the agent being in the picture. */
const YOU_ASKING = /\b(?:can|could|would|will|do|did|if|thank|when|then)\s+you\b|\byou\s+(?:can|could|would|will|please|left|forgot|missed|didn'?t|did\s+not|made|make|have|had|need|should|did|see|know|think)\b/giu;
const DU_ASKING = /\b(?:kan|kunne|vil|ville|skal|har|takk|når)\s+du\b|\bdu\s+(?:kan|kunne|vil|glemte|har|hadde|må|skal|ser|tror|vet)\b/giu;

/**
 * Does the request put the agent in the picture? "alter this image to show
 * you helping him", "you and him working together", "with you", "Maja
 * cooking" (her name) -- yes. "put a hat on him", "can you make it darker"
 * -- no: only the photo changes. `names` are the agent's own names (identity
 * name and nickname, the agent's name). English and Norwegian.
 */
export function requestPutsAgentInPicture(input: {
  requesterMessage?: string | null;
  request: string;
  names: readonly string[];
}): boolean {
  const texts = [input.requesterMessage ?? "", input.request];
  for (const name of input.names) {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    if (!escaped) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
    if (texts.some((t) => pattern.test(t))) return true;
  }
  const message = (input.requesterMessage ?? "").replace(YOU_ASKING, " ").replace(DU_ASKING, " ");
  if (/\b(?:you|yourself)\b/iu.test(message)) return true;
  if (/(?<![\p{L}])(?:deg|du)(?![\p{L}])/iu.test(message)) return true;
  // The agent writing about itself in its own picture description.
  return /\b(?:me|myself)\b/iu.test(input.request);
}
