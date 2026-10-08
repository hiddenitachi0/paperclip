// Identity anchors: one saved person (real with written consent, or
// fictional/AI-made) that looks can point at, so every picture of that
// person starts from the same pictures and the same description.
//
// An identity is separate from looks. A look says how a picture should look
// (style, model, setting); an identity says who is in it. A look that points
// at an identity always gets the identity's face crop as picture 1 (and the
// body crop as picture 2 when the model has room), with the identity-lock
// wording from look-prompt.ts, then the look's own pictures in the slots left.
//
// What keeps a person the same in Sogni's picture-editing models is the
// reference pictures, never a seed: edit_image takes no seed at all
// (sogni.ts). The seed and model kept with the chosen canonical picture are
// only for making that exact picture again, and the page says so.
//
// Every identity records two confirmations from the person who made it:
// "fictional/AI-generated, or I have their written consent" and "this person
// is an adult (18+)". Saving refuses without both, and refuses a picture the
// analysis model flagged as maybe showing someone under 18.

import { assemblePrompt, type CharacterSheet, type ReferenceRole } from "./look-prompt.js";
import { SOGNI_EDIT_MODELS, sogniCanonicalModelId, sogniWorkflowModel } from "./sogni.js";

export const IDENTITY_NAME_MAX = 60;
export const IDENTITY_FIELD_MAX = 300;
export const MAX_IDENTITIES = 50;

/** The locked description: stable physical traits only. */
export const IDENTITY_SHEET_FIELDS = [
  { key: "hair", label: "Hair" },
  { key: "face", label: "Face" },
  { key: "eyes", label: "Eyes" },
  { key: "body", label: "Body and proportions" },
  { key: "skin", label: "Skin" },
  { key: "marks", label: "Distinguishing marks" },
] as const;
export type IdentitySheetKey = (typeof IDENTITY_SHEET_FIELDS)[number]["key"];
export type IdentitySheet = Partial<Record<IdentitySheetKey, string>>;
export const IDENTITY_SHEET_KEYS: IdentitySheetKey[] = IDENTITY_SHEET_FIELDS.map((f) => f.key);

export const CROP_ROLES = ["face", "body", "outfit", "other"] as const;
export type CropRole = (typeof CROP_ROLES)[number];

/** A box on a picture, as fractions of its width and height from the top-left corner. */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface IdentityCrop {
  role: CropRole;
  /** The cropped picture, a file in the company's Files. */
  fileId: string;
  /** Where it was cut from (null when a separate picture was picked). */
  sourceFileId: string | null;
  box: CropBox | null;
}

export const LORA_SOURCES = ["huggingface", "fal", "civitai", "other"] as const;
export type LoraSource = (typeof LORA_SOURCES)[number];

/**
 * A LoRA for this person. Stored with where it lives so a private option
 * (Fal-hosted, another provider) can be added later without changing data:
 * Sogni can only import a PUBLIC Hugging Face or Civitai file today.
 */
export interface IdentityLora {
  source: LoraSource;
  url: string;
  visibility: "public" | "private";
  baseModel: string;
  triggerWord: string;
  /** 0..1 (Sogni personal LoRAs take 0 < strength <= 1). */
  strength: number;
  /** Sogni's id for it once imported ("personal-..."), else null. */
  sogniLoraId: string | null;
  /** Sogni's import state: queued, ready, rejected, revoked (null: not imported). */
  sogniStatus: string | null;
  /** "user/repo" on Hugging Face, when published there. */
  repo: string | null;
}

export interface IdentityProvenance {
  model: string | null;
  /** Null for Sogni picture edits: they take no seed. Only for making the same picture again. */
  seed: number | null;
  workflowId: string | null;
  prompt: string | null;
  chosenAt: string;
}

export interface IdentityConsent {
  /** "This person is fictional/AI-generated, or I have their written consent to use their likeness." */
  likeness: true;
  /** "This person is an adult (18+)." */
  adult: true;
  confirmedBy: string;
  confirmedAt: string;
}

export const TRAINING_STATES = ["collecting", "training", "trained", "published", "failed"] as const;
export type TrainingState = (typeof TRAINING_STATES)[number];

export interface IdentityTraining {
  status: TrainingState;
  /** Pictures made for training (company files), in the order they were made. */
  datasetFileIds: string[];
  /** The ones a person ticked as truly looking like this person. */
  selectedFileIds: string[];
  triggerWord: string;
  steps: number;
  estimatedCostCents: number;
  falModel: string;
  falRequestId: string | null;
  /** Billing reservation for the training, given back if it fails. */
  reservationId: string | null;
  /** Fal's address of the trained file (safetensors). */
  resultUrl: string | null;
  error: string | null;
  startedBy: string | null;
  startedAt: string | null;
  updatedAt: string;
}

export interface Identity {
  id: string;
  name: string;
  /** Another name people use for this person in requests ("Maja" for "Maja Berg"). */
  nickname: string | null;
  /** The picture the identity was made from. */
  originalFileId: string | null;
  sheet: IdentitySheet;
  crops: IdentityCrop[];
  /** The chosen canonical picture (a front portrait or full body made from the crops). */
  canonicalFileId: string | null;
  /** Also send the canonical picture as a face reference when there is room. */
  canonicalAsReference: boolean;
  /** Which model to use per service when a look does not pick one. */
  preferredModels: { sogni: string; sogniExtraSlot: string; fal: string | null };
  lora: IdentityLora | null;
  provenance: IdentityProvenance | null;
  consent: IdentityConsent;
  training: IdentityTraining | null;
  createdAt: string;
  updatedAt: string;
}

/** Sogni's identity editor: best at keeping one face (2 reference pictures). */
export const IDENTITY_DEFAULT_SOGNI_MODEL = "krea-identity-edit";
/** Used instead when the identity and the look need a third reference picture. */
export const IDENTITY_EXTRA_SLOT_SOGNI_MODEL = "qwen";

export const CONSENT_LIKENESS_TEXT = "This person is fictional/AI-generated, or I have their written consent to use their likeness.";
export const CONSENT_ADULT_TEXT = "This person is an adult (18+).";
export const SEED_EXPLANATION =
  "Sogni's picture-editing models take no seed, so a seed cannot keep this person the same. The reference pictures do that. The model and seed kept with the chosen picture are only for making that exact picture again.";

// ─── Reading and checking ────────────────────────────────────────────────────

function text(value: unknown, max: number, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`"${label}" must be text.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new Error(`Keep "${label}" under ${max} characters.`);
  return trimmed;
}

export function readIdentitySheet(value: unknown): IdentitySheet {
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw new Error("The description could not be read. Fill it in again.");
  }
  const raw = (value ?? {}) as Record<string, unknown>;
  const sheet: IdentitySheet = {};
  for (const field of IDENTITY_SHEET_FIELDS) {
    const v = text(raw[field.key], IDENTITY_FIELD_MAX, field.label);
    if (v) sheet[field.key] = v;
  }
  return sheet;
}

export function isCropRole(value: unknown): value is CropRole {
  return typeof value === "string" && (CROP_ROLES as readonly string[]).includes(value);
}

/** A box inside the picture, at least 2% wide and high. Throws a plain sentence otherwise. */
export function readCropBox(value: unknown): CropBox {
  const raw = value as Record<string, unknown> | null;
  const nums = ["x", "y", "w", "h"].map((k) => raw?.[k]);
  if (!raw || nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw new Error("A crop box needs x, y, width and height.");
  const [x, y, w, h] = nums as number[];
  const eps = 1e-6;
  if (x! < -eps || y! < -eps || w! < 0.02 || h! < 0.02 || x! + w! > 1 + eps || y! + h! > 1 + eps) {
    throw new Error("A crop box must lie inside the picture and be at least a little bigger than a dot.");
  }
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return { x: clamp(x!), y: clamp(y!), w: Math.min(w!, 1 - clamp(x!)), h: Math.min(h!, 1 - clamp(y!)) };
}

export function readCrops(value: unknown): IdentityCrop[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("The crops could not be read. Make them again.");
  if (value.length > 8) throw new Error("Keep at most 8 crops.");
  return value.map((item) => {
    const row = item as Record<string, unknown> | null;
    if (!row || !isCropRole(row.role)) throw new Error("Each crop needs a role: face, body, outfit or other.");
    const fileId = typeof row.fileId === "string" ? row.fileId.trim() : "";
    if (!fileId) throw new Error("A crop has no picture. Make it again.");
    const sourceFileId = typeof row.sourceFileId === "string" && row.sourceFileId.trim() ? row.sourceFileId.trim() : null;
    return { role: row.role, fileId, sourceFileId, box: row.box === undefined || row.box === null ? null : readCropBox(row.box) };
  });
}

export function readLoraInput(value: unknown, existing: IdentityLora | null): IdentityLora | null {
  if (value === undefined) return existing;
  if (value === null) return null;
  const raw = value as Record<string, unknown>;
  const source = (LORA_SOURCES as readonly string[]).includes(String(raw.source)) ? (raw.source as LoraSource) : null;
  if (!source) throw new Error("Say where the LoRA lives (Hugging Face, Fal, Civitai or other).");
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 500) throw new Error("The LoRA address must be an https address.");
  const triggerWord = text(raw.triggerWord, 60, "Trigger word") ?? "";
  const strength = typeof raw.strength === "number" ? raw.strength : Number(raw.strength ?? 0.8);
  if (!Number.isFinite(strength) || strength <= 0 || strength > 1) throw new Error("LoRA strength must be more than 0 and at most 1.");
  const sogniLoraId = typeof raw.sogniLoraId === "string" && /^personal-[A-Za-z0-9-]{1,100}$/.test(raw.sogniLoraId) ? raw.sogniLoraId : null;
  return {
    source,
    url,
    visibility: raw.visibility === "private" ? "private" : "public",
    baseModel: text(raw.baseModel, 100, "Base model") ?? "krea-2",
    triggerWord,
    strength,
    sogniLoraId,
    sogniStatus: sogniLoraId ? (typeof raw.sogniStatus === "string" ? raw.sogniStatus : existing?.sogniStatus ?? null) : null,
    repo: text(raw.repo, 200, "Repository") ?? null,
  };
}

/**
 * The two confirmations. Both must be ticked (true) for a new identity; an
 * existing identity keeps the ones it was made with.
 */
export function readConsent(params: Record<string, unknown>, existing: Identity | null, userId: string, now: string): IdentityConsent {
  if (existing) return existing.consent;
  if (params.consentLikeness !== true || params.consentAdult !== true) {
    throw new Error(
      `Tick both boxes to save this identity: "${CONSENT_LIKENESS_TEXT}" and "${CONSENT_ADULT_TEXT}" Media Studio does not keep identities without both.`,
    );
  }
  return { likeness: true, adult: true, confirmedBy: userId, confirmedAt: now };
}

export function normalizeIdentity(value: unknown): Identity | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  const consent = raw.consent as Record<string, unknown> | null;
  // An identity without both confirmations is never used.
  if (!consent || consent.likeness !== true || consent.adult !== true) return null;
  let sheet: IdentitySheet = {};
  let crops: IdentityCrop[] = [];
  try {
    sheet = readIdentitySheet(raw.sheet);
  } catch {
    sheet = {};
  }
  try {
    crops = readCrops(raw.crops);
  } catch {
    crops = [];
  }
  const models = (raw.preferredModels ?? {}) as Record<string, unknown>;
  let lora: IdentityLora | null = null;
  try {
    lora = raw.lora ? readLoraInput(raw.lora, null) : null;
  } catch {
    lora = null;
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    id: raw.id,
    name: raw.name,
    nickname: str(raw.nickname),
    originalFileId: str(raw.originalFileId),
    sheet,
    crops,
    canonicalFileId: str(raw.canonicalFileId),
    canonicalAsReference: raw.canonicalAsReference === true,
    preferredModels: {
      sogni: str(models.sogni) ?? IDENTITY_DEFAULT_SOGNI_MODEL,
      sogniExtraSlot: str(models.sogniExtraSlot) ?? IDENTITY_EXTRA_SLOT_SOGNI_MODEL,
      fal: str(models.fal),
    },
    lora,
    provenance: (raw.provenance as IdentityProvenance | null) ?? null,
    consent: consent as unknown as IdentityConsent,
    training: (raw.training as IdentityTraining | null) ?? null,
    createdAt: str(raw.createdAt) ?? new Date(0).toISOString(),
    updatedAt: str(raw.updatedAt) ?? new Date(0).toISOString(),
  };
}

export function cropFor(identity: Identity, role: CropRole): IdentityCrop | null {
  return identity.crops.find((c) => c.role === role) ?? null;
}

// ─── Mentions ────────────────────────────────────────────────────────────────

function escapeRegExp(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The identities a request names by name or nickname (whole words, any case). */
export function identitiesMentionedIn(request: string, identities: Identity[]): Identity[] {
  return identities.filter((identity) =>
    [identity.name, identity.nickname].some((n) => {
      if (!n || n.trim().length < 2) return false;
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(n.trim()).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "iu");
      return pattern.test(request);
    }),
  );
}

// ─── Which pictures go where ─────────────────────────────────────────────────

export interface ReferencePlan {
  fileIds: string[];
  roles: ReferenceRole[];
  /** The model to use when the look picks none (null: leave the look's/settings' model). */
  model: string | null;
  /** Plain sentences about what was left out. */
  notes: string[];
}

/** How many reference pictures a Sogni edit model takes (from sogni.ts). */
export function sogniSlots(model: string): number {
  return SOGNI_EDIT_MODELS[sogniWorkflowModel(model, "edit_image")] ?? 3;
}

/**
 * Put the identity's pictures first, then the look's. Order: face crop
 * (picture 1), body crop, outfit crop (only with "same outfit"), the
 * canonical picture (only when asked for), then the look's own pictures.
 * The look's own face pictures are left out: the face comes only from the
 * identity. When nothing pins the model (`fixedModel` null, Sogni), the
 * identity's preferred model is used, or its extra-slot model when the
 * pictures need one more slot than that model takes.
 */
export function planIdentityReferences(input: {
  identity: Identity;
  lookFileIds: string[];
  lookRoles: ReferenceRole[];
  sameOutfit: boolean;
  service: string;
  /** The model already chosen (the look's, or the call's); null: the identity picks. */
  fixedModel: string | null;
  /** The slot limit when the model is fixed (or for Fal). */
  fixedSlots: number;
}): ReferencePlan {
  const { identity } = input;
  const notes: string[] = [];
  const identityRefs: Array<{ id: string; role: ReferenceRole; must: boolean }> = [];
  const face = cropFor(identity, "face");
  const faceId = face?.fileId ?? identity.canonicalFileId ?? identity.originalFileId;
  if (!faceId) return { fileIds: input.lookFileIds, roles: input.lookRoles, model: null, notes: [`The identity "${identity.name}" has no face picture yet, so it was not used.`] };
  identityRefs.push({ id: faceId, role: "face", must: true });
  const body = cropFor(identity, "body");
  if (body && body.fileId !== faceId) identityRefs.push({ id: body.fileId, role: "body", must: false });
  const outfit = cropFor(identity, "outfit");
  if (input.sameOutfit && outfit) identityRefs.push({ id: outfit.fileId, role: "outfit", must: false });
  if (identity.canonicalAsReference && identity.canonicalFileId && !identityRefs.some((r) => r.id === identity.canonicalFileId)) {
    identityRefs.push({ id: identity.canonicalFileId, role: "face", must: false });
  }
  const look: Array<{ id: string; role: ReferenceRole }> = [];
  let droppedLookFaces = 0;
  input.lookFileIds.forEach((id, i) => {
    const role = input.lookRoles[i] ?? "other";
    if (role === "face") {
      droppedLookFaces += 1;
      return;
    }
    // The identity's outfit wins only when "same outfit" is on; otherwise the look's outfit picture stays.
    if (identityRefs.some((r) => r.id === id)) return;
    look.push({ id, role });
  });
  if (droppedLookFaces > 0) {
    notes.push(`The look's face ${droppedLookFaces === 1 ? "picture was" : "pictures were"} left out: the face comes from the identity "${identity.name}".`);
  }

  let model: string | null = null;
  let slots = input.fixedSlots;
  if (input.service === "sogni" && !input.fixedModel) {
    const preferred = identity.preferredModels.sogni || IDENTITY_DEFAULT_SOGNI_MODEL;
    const extra = identity.preferredModels.sogniExtraSlot || IDENTITY_EXTRA_SLOT_SOGNI_MODEL;
    const wanted = identityRefs.length + look.length;
    model = wanted > sogniSlots(preferred) && sogniSlots(extra) > sogniSlots(preferred) ? extra : preferred;
    slots = sogniSlots(model);
  }

  const chosen: Array<{ id: string; role: ReferenceRole }> = [];
  for (const ref of identityRefs) {
    if (chosen.length < slots || ref.must) chosen.push(ref);
  }
  const skippedIdentity = identityRefs.length - chosen.length;
  const room = Math.max(0, slots - chosen.length);
  const lookKept = look.slice(0, room);
  const skippedLook = look.length - lookKept.length;
  chosen.push(...lookKept);
  if (skippedIdentity > 0 || skippedLook > 0) {
    const parts: string[] = [];
    if (skippedIdentity > 0) parts.push(`${skippedIdentity} of the identity's extra ${skippedIdentity === 1 ? "picture" : "pictures"}`);
    if (skippedLook > 0) parts.push(`${skippedLook} of the look's ${skippedLook === 1 ? "picture" : "pictures"}`);
    notes.push(`The model takes ${slots} reference ${slots === 1 ? "picture" : "pictures"}, so ${parts.join(" and ")} ${skippedIdentity + skippedLook === 1 ? "was" : "were"} left out (the face always goes first).`);
  }
  return { fileIds: chosen.map((c) => c.id), roles: chosen.map((c) => c.role), model, notes };
}

/** The identity's locked description over the look's: hair, face, eyes, body and skin come from the identity. */
export function sheetWithIdentity(lookSheet: CharacterSheet | null | undefined, identity: Identity): CharacterSheet {
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

/** Krea 2 family models a Krea 2 LoRA works with. */
export function loraFitsModel(lora: IdentityLora, model: string | null | undefined): boolean {
  if (!model) return false;
  const id = sogniCanonicalModelId(model).toLowerCase();
  return /krea/i.test(lora.baseModel) ? id.startsWith("krea2") || id.startsWith("dark_beast_krea2") : false;
}

// ─── Candidates and training pictures ────────────────────────────────────────

export const CANDIDATE_KINDS = ["portrait", "full-body"] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export const CANDIDATE_REQUESTS: Record<CandidateKind, string> = {
  portrait:
    "A neutral, front-facing head-and-shoulders portrait photo of the person, looking straight at the camera with a relaxed neutral expression. Plain light grey studio background, soft even lighting, simple plain neutral clothing (a plain crew-neck top).",
  "full-body":
    "A full-body photo of the person standing straight and facing the camera, arms relaxed at the sides, the whole body from head to feet in the frame. Plain light grey studio background, soft even lighting, simple plain neutral clothing (a plain top and plain trousers).",
};

/** Varied requests for LoRA training pictures: angles, outfits, lighting and places. Two pictures each. */
export const TRAINING_REQUESTS: string[] = [
  "A close-up portrait photo of the person, front view, soft window light, plain background.",
  "A portrait photo of the person in three-quarter view turned to the left, natural daylight outdoors.",
  "A portrait photo of the person in profile view facing right, studio lighting, dark background.",
  "A waist-up photo of the person smiling, wearing a casual denim jacket, in a sunny park.",
  "A full-body photo of the person walking on a city street, wearing a long coat, overcast light.",
  "A photo of the person sitting at a cafe table, wearing a knitted sweater, warm indoor light.",
  "A head-and-shoulders photo of the person looking slightly upward, golden hour light.",
  "A full-body photo of the person standing, wearing smart business clothes, in a bright office.",
  "A photo of the person laughing, wearing a t-shirt, on a beach on a cloudy day.",
  "A close-up photo of the person, looking over their shoulder, evening light, neutral background.",
  "A waist-up photo of the person in a kitchen, wearing a plain shirt, soft overhead light.",
  "A full-body photo of the person sitting on steps, wearing sportswear, shade on a sunny day.",
];

/** The prompt for one identity picture (candidate or training), with the identity-lock wording. */
export function identityPicturePrompt(identity: Identity, request: string, roles: ReferenceRole[]): string {
  return assemblePrompt({ request, sheet: sheetWithIdentity({}, identity), roles, service: "sogni" }).prompt;
}

/** Face (and body, when the model takes two) pictures for candidates and training pictures. */
export function candidateReferences(identity: Identity, model: string): { fileIds: string[]; roles: ReferenceRole[] } {
  const face = cropFor(identity, "face")?.fileId ?? identity.originalFileId;
  if (!face) throw new Error(`Make a face crop for "${identity.name}" first.`);
  const fileIds = [face];
  const roles: ReferenceRole[] = ["face"];
  const body = cropFor(identity, "body")?.fileId;
  if (body && body !== face && sogniSlots(model) >= 2) {
    fileIds.push(body);
    roles.push("body");
  }
  return { fileIds, roles };
}

// ─── LoRA training ───────────────────────────────────────────────────────────

export const LORA_TRAINER_MODEL = "fal-ai/krea-2-trainer";
/** Keep in step with MEDIA_STUDIO_LORA_TRAINING_STEPS / estimateLoraTrainingCostCents in @paperclipai/shared (a test checks). */
export const LORA_TRAINING_STEPS = 1000;
export const LORA_TRAINING_USD_PER_STEP = 0.003;
export const LORA_MIN_PICTURES = 10;
export const LORA_MAX_PICTURES = 30;
export const LORA_DATASET_MAX = 40;
export const LORA_SOGNI_BASE_MODEL_ID = "krea2_identity_edit_v1_2";

export function loraTrainingCostCents(steps = LORA_TRAINING_STEPS): number {
  return Math.max(30, Math.ceil(steps * LORA_TRAINING_USD_PER_STEP * 100));
}

/** A trigger word: one or two plain words, letters/digits/underscore/dash. */
export function readTriggerWord(value: unknown): string {
  const word = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,30}( [A-Za-z0-9_-]{1,30})?$/.test(word)) {
    throw new Error("Pick a trigger word of 3 to 30 letters or digits that is not a normal word, for example majaberg_person.");
  }
  return word;
}

/** A Hugging Face repository name (the part after "user/"). */
export function readRepoName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(name) || /\.\.|--/.test(name) || /[.-]$/.test(name)) {
    throw new Error("Pick a repository name of letters, digits, dots, dashes or underscores (for example maja-lora).");
  }
  return name;
}

/**
 * What a training may move to from where it is. "collecting": pictures are
 * being made and ticked; "training": Fal is training; "trained": the file is
 * on Fal; "published": the file is on Hugging Face; "failed": try again from
 * the ticked pictures.
 */
export const TRAINING_TRANSITIONS: Record<TrainingState, TrainingState[]> = {
  collecting: ["training"],
  training: ["trained", "failed"],
  trained: ["published"],
  published: [],
  failed: ["training", "collecting"],
};

export function assertTrainingMove(from: TrainingState | null, to: TrainingState): void {
  const allowed = from === null ? to === "collecting" : TRAINING_TRANSITIONS[from].includes(to) || (to === "collecting" && from !== "training");
  if (!allowed) {
    const words: Record<TrainingState, string> = {
      collecting: "picking pictures",
      training: "training",
      trained: "trained",
      published: "published",
      failed: "failed",
    };
    throw new Error(`The LoRA training is ${from ? words[from] : "not started"}, so it cannot move to ${words[to]} now.`);
  }
}
