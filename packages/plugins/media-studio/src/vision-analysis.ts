// "Analyse picture": a vision model the company picks describes the stable
// physical traits of the one person in an uploaded picture and suggests crop
// boxes, as strict JSON. Nothing it says is trusted until it passes
// parseAnalysis below; anything else (a refusal, prose, extra fields, a box
// outside the picture) becomes one plain sentence suggesting another model.
//
// Safety: the model is told never to say or guess who the person is, and to
// say whether the person clearly looks like an adult. Anything but a clear
// "yes" blocks the picture for identities (checked again when saving).
//
// Where the call happens: on the Paperclip server, not in this worker
// (ctx.models.analyseImage, capability models.image_analysis.run). The
// worker only names one of the company's saved models (Settings > Models),
// the picture's file id and the key's company secret; the server finds the
// provider, model id and address itself, so a company's own model server on
// its own network (Ollama on the owner's computer) can be used the same way
// quick agents use it, and the plugin can never point the call at an address
// of its choosing. The server sends no tools and returns only the text,
// which parseAnalysis below checks strictly.

import { IDENTITY_FIELD_MAX, IDENTITY_SHEET_KEYS, readCropBox, type CropBox, type IdentitySheet } from "./identity.js";

export interface AnalysisModelSetting {
  /** A saved model of this company (Settings > Models). */
  entryId: string;
  /** Shown on the page ("Claude Sonnet (saved model)"). */
  label: string | null;
  /** A company secret (id) holding the service's key; null for a local server or Paperclip's own Claude key. */
  keySecretId: string | null;
}

export const ANALYSIS_SYSTEM_PROMPT = [
  "You describe the stable physical traits of the one person in a picture, so an artist can draw the same character again.",
  "Rules:",
  "- Describe only stable physical traits: hair (colour, length, texture, style), face (shape and features), eyes (colour and shape), body build and proportions, skin tone and texture, and distinguishing marks (freckles, moles, scars, tattoos, piercings).",
  "- Never say or guess who the person is, never name anyone, and never say they look like any real person.",
  "- Never guess nationality, ethnicity, religion, health, sexuality or other sensitive things.",
  "- Do not describe clothing, pose, expression, background or lighting in the trait fields.",
  '- Say whether the person clearly looks like an adult (18 or older): "yes", "no" or "unsure". If in any doubt, say "unsure".',
  '- If there is no single clear person in the picture, or you will not describe them, answer only {"refused": true, "reason": "<short reason>"}.',
  "Otherwise answer with exactly this JSON and nothing else (each text at most 200 characters, empty string when not visible):",
  '{"refused": false, "apparentAdult": "yes", "sheet": {"hair": "", "face": "", "eyes": "", "body": "", "skin": "", "marks": ""}, "crops": {"face": {"x": 0, "y": 0, "w": 0, "h": 0}, "body": {"x": 0, "y": 0, "w": 0, "h": 0}, "outfit": null}}',
  "Boxes are fractions of the picture's width and height (0 to 1) from its top-left corner: face = the head with a little margin around it; body = the whole visible person; outfit = only the clothing, or null when there is none to see. Use null for body when only the face is visible.",
].join("\n");

export const ANALYSIS_USER_PROMPT = "Describe the person in this picture as the rules say. Answer with the JSON only.";

export interface AnalysisResult {
  sheet: IdentitySheet;
  crops: { face: CropBox; body: CropBox | null; outfit: CropBox | null };
}

export type AnalysisOutcome =
  | { ok: true; result: AnalysisResult }
  | { ok: false; kind: "refused" | "unreadable"; message: string }
  | { ok: false; kind: "not-adult"; message: string; verdict: "under18" | "unclear" };

export const ANALYSIS_REFUSED_MESSAGE =
  "The analysis model would not describe this picture. Try another analysis model in Media Studio's identity settings, or fill in the description and crops yourself.";
export const ANALYSIS_UNREADABLE_MESSAGE =
  "The analysis model's answer could not be read. Try again, or pick another analysis model (one that can see pictures) in Media Studio's identity settings.";
export const ANALYSIS_NOT_ADULT_MESSAGE =
  "This picture cannot be used for an identity: the analysis could not confirm that the person is an adult (18 or older). Media Studio only keeps identities of adults.";

/** The JSON object inside a model's answer: the whole answer, or the inside of one ```json fence. */
function extractJson(answer: string): unknown {
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1]! : trimmed;
  return JSON.parse(body);
}

function exactKeys(obj: Record<string, unknown>, allowed: string[], required: string[]): boolean {
  const keys = Object.keys(obj);
  return keys.every((k) => allowed.includes(k)) && required.every((k) => k in obj);
}

/**
 * Check a model's answer strictly. Exactly the documented keys, text fields
 * short, boxes inside the picture. A refusal, or an answer that does not
 * clearly say "adult", never yields a result.
 */
export function parseAnalysis(answer: string): AnalysisOutcome {
  let parsed: unknown;
  try {
    parsed = extractJson(answer);
  } catch {
    // Prose like "I can't help with that" is a refusal in all but name.
    return /\b(can['’]?t|cannot|won['’]?t|unable|not able|sorry|refuse)\b/i.test(answer)
      ? { ok: false, kind: "refused", message: ANALYSIS_REFUSED_MESSAGE }
      : { ok: false, kind: "unreadable", message: ANALYSIS_UNREADABLE_MESSAGE };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, kind: "unreadable", message: ANALYSIS_UNREADABLE_MESSAGE };
  const obj = parsed as Record<string, unknown>;
  if (obj.refused === true) return { ok: false, kind: "refused", message: ANALYSIS_REFUSED_MESSAGE };
  if (obj.refused !== false || !exactKeys(obj, ["refused", "apparentAdult", "sheet", "crops"], ["refused", "apparentAdult", "sheet", "crops"])) {
    return { ok: false, kind: "unreadable", message: ANALYSIS_UNREADABLE_MESSAGE };
  }
  if (obj.apparentAdult !== "yes") {
    return obj.apparentAdult === "no" || obj.apparentAdult === "unsure"
      ? { ok: false, kind: "not-adult", message: ANALYSIS_NOT_ADULT_MESSAGE, verdict: obj.apparentAdult === "no" ? "under18" : "unclear" }
      : { ok: false, kind: "unreadable", message: ANALYSIS_UNREADABLE_MESSAGE };
  }
  const sheetRaw = obj.sheet as Record<string, unknown> | null;
  if (!sheetRaw || typeof sheetRaw !== "object" || Array.isArray(sheetRaw) || !exactKeys(sheetRaw, IDENTITY_SHEET_KEYS, [])) {
    return { ok: false, kind: "unreadable", message: ANALYSIS_UNREADABLE_MESSAGE };
  }
  const sheet: IdentitySheet = {};
  for (const key of IDENTITY_SHEET_KEYS) {
    const v = sheetRaw[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || v.length > IDENTITY_FIELD_MAX || /[\r\n]/.test(v.trim())) {
      return { ok: false, kind: "unreadable", message: ANALYSIS_UNREADABLE_MESSAGE };
    }
    if (v.trim()) sheet[key] = v.trim();
  }
  const cropsRaw = obj.crops as Record<string, unknown> | null;
  if (!cropsRaw || typeof cropsRaw !== "object" || Array.isArray(cropsRaw) || !exactKeys(cropsRaw, ["face", "body", "outfit"], ["face"])) {
    return { ok: false, kind: "unreadable", message: ANALYSIS_UNREADABLE_MESSAGE };
  }
  try {
    const box = (v: unknown) => (v === undefined || v === null ? null : readCropBox(v));
    const face = readCropBox(cropsRaw.face);
    return { ok: true, result: { sheet, crops: { face, body: box(cropsRaw.body), outfit: box(cropsRaw.outfit) } } };
  } catch {
    return { ok: false, kind: "unreadable", message: ANALYSIS_UNREADABLE_MESSAGE };
  }
}
