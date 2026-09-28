// Detailed looks: what each reference picture is for (its role), a character
// sheet (hair, face, outfit, ...), and how both become the text sent to the
// picture service. Every sentence that goes into a prompt lives in this file.
//
// The final prompt is built the same way every time (no model in between):
//
//   <the request>
//
//   <what each reference picture is for>          only when pictures with a role are sent
//
//   Character (...): Hair: long, blonde. Face: ...  the sheet's person fields
//
//   Setting: ...
//
//   Style: <the look's style words>                  exactly as before
//
//   Art style: ... Lighting: ... Camera and framing: ...
//
//   Keep out of the picture: ...                     unless the model takes "things to avoid" text
//
// The request wins: a sheet field (or a picture's role) about something the
// request itself describes, such as a different outfit or place, is left out
// (for a picture: the prompt says to take that from the request instead), and
// the character line says the request wins where it differs.
//
// How each service is told what the pictures are for:
//
//   Sogni (edit_image, used for every Sogni picture made from reference
//   pictures): its tool schema's prompt guidance (@sogni-ai/sogni-protocol
//   1.0.0-alpha.46, schemas/tools/edit_image.schema.json, "PROMPT CONSTRUCTION
//   ORDER", "IDENTITY LOCK" and "MULTI-IMAGE PATTERN") numbers the pictures as
//   "picture N" in upload order, gives each one ONE role (identity, pose,
//   outfit, style, background, colour), locks the face to one picture ("Use
//   the person from picture 1 as the final subject and preserve their exact
//   facial likeness ... Identity comes only from picture 1 ... Do not borrow
//   identity from pictures 2 or 3") and ends with "Maintain realistic anatomy,
//   perspective, and lighting integration." Its "Preserve all unmentioned
//   details" ending is for editing one base picture and is left out here:
//   a look makes a new picture from the request.
//
//   Fal (FLUX.1 Kontext [pro] multi): Black Forest Labs' multi-reference
//   guide (docs.bfl.ai, "Multi-Reference Editing") numbers the inputs as
//   "image N" and says to "describe the role of each image so the model knows
//   what to pull from where"; the Kontext editing guide keeps a character by
//   saying what stays ("while maintaining the same facial features, hairstyle,
//   and expression") and names the subject ("the person in image 1") instead
//   of "her".

export const REFERENCE_ROLES = ["face", "body", "outfit", "style", "background", "other"] as const;
export type ReferenceRole = (typeof REFERENCE_ROLES)[number];

/** Plain labels for the looks page (the page keeps a copy; a test checks they match). */
export const REFERENCE_ROLE_LABELS: Record<ReferenceRole, string> = {
  face: "Face",
  body: "Body",
  outfit: "Outfit",
  style: "Style/aesthetic",
  background: "Background",
  other: "Other",
};

export function isReferenceRole(value: unknown): value is ReferenceRole {
  return typeof value === "string" && (REFERENCE_ROLES as readonly string[]).includes(value);
}

type SheetGroup = "character" | "setting" | "style" | "avoid";

/** The character sheet's fields, in the order the page shows them and the prompt uses them. */
export const SHEET_FIELDS = [
  { key: "hair", label: "Hair", promptLabel: "Hair", group: "character" },
  { key: "face", label: "Face", promptLabel: "Face", group: "character" },
  { key: "eyes", label: "Eyes", promptLabel: "Eyes", group: "character" },
  { key: "body", label: "Body", promptLabel: "Body", group: "character" },
  { key: "skin", label: "Skin", promptLabel: "Skin", group: "character" },
  { key: "outfit", label: "Outfit", promptLabel: "Outfit", group: "character" },
  { key: "accessories", label: "Accessories", promptLabel: "Accessories", group: "character" },
  { key: "expression", label: "Expression/pose defaults", promptLabel: "Expression and pose", group: "character" },
  { key: "setting", label: "Setting/background", promptLabel: "Setting", group: "setting" },
  { key: "artStyle", label: "Art style", promptLabel: "Art style", group: "style" },
  { key: "lighting", label: "Lighting", promptLabel: "Lighting", group: "style" },
  { key: "camera", label: "Camera/framing", promptLabel: "Camera and framing", group: "style" },
  { key: "avoid", label: "Always avoid", promptLabel: "Keep out of the picture", group: "avoid" },
] as const satisfies ReadonlyArray<{ key: string; label: string; promptLabel: string; group: SheetGroup }>;

export type SheetKey = (typeof SHEET_FIELDS)[number]["key"];
export type CharacterSheet = Partial<Record<SheetKey, string>>;
export const SHEET_KEYS: SheetKey[] = SHEET_FIELDS.map((f) => f.key);
/** Each sheet field is short text. */
export const SHEET_FIELD_MAX = 300;

/** Only known fields with text, trimmed. Anything else is dropped. */
export function normalizeSheet(value: unknown): CharacterSheet {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const sheet: CharacterSheet = {};
  for (const key of SHEET_KEYS) {
    const text = raw[key];
    if (typeof text === "string" && text.trim()) sheet[key] = text.trim();
  }
  return sheet;
}

export function sheetIsEmpty(sheet: CharacterSheet | null | undefined): boolean {
  return !sheet || SHEET_KEYS.every((key) => !sheet[key]);
}

/** The labels of the filled-in fields ("Hair, Face, Outfit"), for list-looks. */
export function filledSheetLabels(sheet: CharacterSheet): string[] {
  return SHEET_FIELDS.filter((f) => sheet[f.key]).map((f) => f.label);
}

/** One role per reference picture, in order; anything missing or unknown is "other". */
export function normalizeRoles(value: unknown, count: number): ReferenceRole[] {
  const list = Array.isArray(value) ? value : [];
  return Array.from({ length: count }, (_, i) => (isReferenceRole(list[i]) ? list[i] : "other"));
}

// ─── The request wins ─────────────────────────────────────────────────────────

/** Things a request can describe itself, which then beat the sheet and the pictures. */
export type Aspect = "hair" | "eyes" | "outfit" | "accessories" | "expression" | "setting" | "artStyle" | "lighting" | "camera";

/**
 * Words that show the request describes an aspect itself. Whole words, any
 * case. Face, body and skin are the character's identity and are never
 * dropped because of a word in the request.
 */
export const ASPECT_WORDS: Record<Aspect, string[]> = {
  hair: ["hair", "hairstyle", "haircut", "ponytail", "pigtails", "braid", "braids", "bun", "bangs", "fringe", "blonde", "brunette", "redhead", "bald"],
  eyes: ["eyes", "eye colour", "eye color"],
  outfit: [
    "wearing", "wears", "dressed", "outfit", "dress", "gown", "suit", "jacket", "coat", "shirt", "t-shirt", "blouse", "sweater",
    "jumper", "hoodie", "jeans", "trousers", "pants", "skirt", "shorts", "bikini", "swimsuit", "uniform", "costume", "clothes",
    "clothing", "lingerie", "pyjamas", "pajamas", "robe", "apron",
  ],
  accessories: ["glasses", "sunglasses", "hat", "cap", "earrings", "necklace", "jewellery", "jewelry", "scarf", "handbag", "bag", "wristwatch", "gloves"],
  expression: [
    "smiling", "smile", "laughing", "frowning", "crying", "angry", "surprised", "sitting", "standing", "lying", "walking",
    "running", "kneeling", "dancing", "jumping", "pose", "posing", "expression", "waving",
  ],
  setting: [
    "background", "setting", "beach", "forest", "woods", "city", "street", "office", "kitchen", "bedroom", "bathroom",
    "living room", "cafe", "café", "restaurant", "park", "garden", "studio", "mountains", "mountain", "lake", "sea",
    "snow", "desert", "indoors", "outdoors", "at home", "in the car", "on a boat", "pool", "gym", "library", "shop", "store",
  ],
  artStyle: [
    "painting", "painted", "watercolor", "watercolour", "oil painting", "anime", "manga", "cartoon", "sketch", "drawing",
    "illustration", "photorealistic", "3d render", "pixel art", "comic", "in the style of",
  ],
  lighting: ["lighting", "lit", "sunset", "sunrise", "golden hour", "neon", "candlelight", "moonlight", "night", "backlit"],
  camera: ["close-up", "closeup", "full body", "full-body", "wide shot", "wide-angle", "from above", "from below", "selfie", "headshot", "portrait shot", "overhead"],
};

const FIELD_ASPECT: Partial<Record<SheetKey, Aspect>> = {
  hair: "hair",
  eyes: "eyes",
  outfit: "outfit",
  accessories: "accessories",
  expression: "expression",
  setting: "setting",
  artStyle: "artStyle",
  lighting: "lighting",
  camera: "camera",
};

const ROLE_ASPECT: Partial<Record<ReferenceRole, Aspect>> = { outfit: "outfit", background: "setting", style: "artStyle" };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The aspects the request describes itself. */
export function aspectsInRequest(request: string): Aspect[] {
  const found: Aspect[] = [];
  for (const [aspect, words] of Object.entries(ASPECT_WORDS) as Array<[Aspect, string[]]>) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map((w) => escapeRegExp(w).replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`, "iu");
    if (pattern.test(request)) found.push(aspect);
  }
  return found;
}

// ─── What each reference picture is for ───────────────────────────────────────

export type RoleWording = "fal" | "sogni";

interface RoleTexts {
  /** "image" or "picture": how the service's guides number the inputs. */
  noun: string;
  role: Record<ReferenceRole, (refs: string) => string>;
  /** When a picture's aspect is described by the request itself. */
  requestWins: Partial<Record<ReferenceRole, (refs: string) => string>>;
  /** Said when one picture is the face and there are others. */
  identityOnly: (face: string, others: string) => string;
  closing: string | null;
}

/** The sentences each service gets about the reference pictures (see the top of this file for the sources). */
export const ROLE_TEXTS: Record<RoleWording, RoleTexts> = {
  sogni: {
    noun: "picture",
    role: {
      face: (refs) =>
        `Use the person from ${refs} as the final subject and preserve their exact facial likeness: face structure, eye shape, nose shape, mouth shape, jawline, skin tone, hairline, apparent age and overall recognizability.`,
      body: (refs) => `Body shape and proportions from ${refs}.`,
      outfit: (refs) => `Outfit from ${refs}.`,
      style: (refs) => `Style, colour palette and aesthetic from ${refs} only.`,
      background: (refs) => `Background and setting from ${refs}.`,
      other: (refs) => `Use ${refs} as a general reference.`,
    },
    requestWins: {
      outfit: (refs) => `The outfit comes from the request, not from ${refs}.`,
      background: (refs) => `The setting comes from the request, not from ${refs}.`,
      style: (refs) => `The style comes from the request, not from ${refs}.`,
    },
    identityOnly: (face, others) => `Identity comes only from ${face}. Do not borrow identity from ${others}.`,
    closing: "Maintain realistic anatomy, perspective, and lighting integration.",
  },
  fal: {
    noun: "image",
    role: {
      face: (refs) => `Keep the same person as in ${refs}, maintaining the same facial features, hairstyle and apparent age.`,
      body: (refs) => `Match the body shape and proportions of the person in ${refs}.`,
      outfit: (refs) => `Dress the person in the outfit from ${refs}.`,
      style: (refs) => `From ${refs} take only the style, colours and mood (no people or objects).`,
      background: (refs) => `Use the background and setting from ${refs}.`,
      other: (refs) => `Use ${refs} as a general reference.`,
    },
    requestWins: {
      outfit: (refs) => `Take the outfit from the request, not from ${refs}.`,
      background: (refs) => `Take the setting from the request, not from ${refs}.`,
      style: (refs) => `Take the style from the request, not from ${refs}.`,
    },
    identityOnly: (face, others) => `Only the person in ${face} is the subject; do not take anyone's face from ${others}.`,
    closing: null,
  },
};

/** "picture 1", "pictures 1 and 3", "pictures 1, 2 and 4". */
function refsText(noun: string, positions: number[]): string {
  if (positions.length === 1) return `${noun} ${positions[0]}`;
  const head = positions.slice(0, -1).join(", ");
  return `${noun}s ${head} and ${positions[positions.length - 1]}`;
}

/** Which wording a service gets. Mock uses Fal's (it shows nothing); ComfyUI takes no reference pictures. */
export function roleWordingFor(service: string): RoleWording {
  return service === "sogni" ? "sogni" : "fal";
}

/**
 * The sentences about the reference pictures, in upload order (picture 1 is
 * the first one sent). Nothing when every picture is "other": older looks
 * and pictures the agent adds are sent as before.
 */
export function roleInstructions(roles: ReferenceRole[], wording: RoleWording, requestAspects: Aspect[] = []): string {
  if (roles.length === 0 || roles.every((role) => role === "other")) return "";
  const texts = ROLE_TEXTS[wording];
  const sentences: string[] = [];
  for (const role of REFERENCE_ROLES) {
    const positions = roles.flatMap((r, i) => (r === role ? [i + 1] : []));
    if (positions.length === 0) continue;
    const refs = refsText(texts.noun, positions);
    const aspect = ROLE_ASPECT[role];
    const wins = aspect && requestAspects.includes(aspect) ? texts.requestWins[role] : undefined;
    sentences.push(wins ? wins(refs) : texts.role[role](refs));
  }
  const faces = roles.flatMap((r, i) => (r === "face" ? [i + 1] : []));
  const others = roles.flatMap((r, i) => (r !== "face" ? [i + 1] : []));
  if (faces.length > 0 && others.length > 0) {
    sentences.push(texts.identityOnly(refsText(texts.noun, faces), refsText(texts.noun, others)));
  }
  if (texts.closing) sentences.push(texts.closing);
  return sentences.join(" ");
}

// ─── The whole prompt ────────────────────────────────────────────────────────

export const CHARACTER_INTRO = "Character (the same in every picture; where the request above says otherwise, follow the request)";

export interface PromptInput {
  /** What the agent or person asked for. */
  request: string;
  /** The look's free style words. */
  style?: string | null;
  sheet?: CharacterSheet | null;
  /** One per reference picture sent, in the order they are sent. Empty: no pictures. */
  roles?: ReferenceRole[];
  /** The service that makes the picture (fal, sogni, mock, comfyui). */
  service: string;
  /** The model takes "things to avoid" text of its own: "Always avoid" goes there instead of into the prompt. */
  avoidAsNegative?: boolean;
}

export interface AssembledPrompt {
  prompt: string;
  /** "Always avoid" text for the model's own "things to avoid" field, when it has one. */
  avoid: string | null;
  /** The sheet fields left out because the request describes that itself. */
  leftOut: SheetKey[];
  /** The aspects the request describes itself. */
  requestAspects: Aspect[];
}

function sentence(label: string, value: string): string {
  return `${label}: ${value.replace(/[\s.]+$/, "")}.`;
}

/** Build the final prompt from the request, the look's style words, its sheet and its pictures' roles. */
export function assemblePrompt(input: PromptInput): AssembledPrompt {
  const request = input.request.trim();
  const sheet = input.sheet ?? {};
  const requestAspects = aspectsInRequest(request);
  const leftOut: SheetKey[] = [];
  const pick = (group: SheetGroup) =>
    SHEET_FIELDS.filter((field) => {
      if (field.group !== group || !sheet[field.key]) return false;
      const aspect = FIELD_ASPECT[field.key];
      if (aspect && requestAspects.includes(aspect)) {
        leftOut.push(field.key);
        return false;
      }
      return true;
    }).map((field) => sentence(field.promptLabel, sheet[field.key]!));

  const blocks = [request];
  const roles = roleInstructions(input.roles ?? [], roleWordingFor(input.service), requestAspects);
  if (roles) blocks.push(roles);
  const character = pick("character");
  if (character.length > 0) blocks.push(`${CHARACTER_INTRO}: ${character.join(" ")}`);
  const setting = pick("setting");
  if (setting.length > 0) blocks.push(setting.join(" "));
  const style = input.style?.trim();
  if (style) blocks.push(`Style: ${style}`);
  const styleFields = pick("style");
  if (styleFields.length > 0) blocks.push(styleFields.join(" "));
  const avoidText = sheet.avoid?.trim() || null;
  let avoid: string | null = null;
  if (avoidText) {
    if (input.avoidAsNegative) avoid = avoidText;
    else blocks.push(sentence("Keep out of the picture", avoidText));
  }
  return { prompt: blocks.join("\n\n"), avoid, leftOut, requestAspects };
}
