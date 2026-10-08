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
// Two wire formats cover every provider the app already calls:
//   Anthropic Messages  POST https://api.anthropic.com/v1/messages
//                       content: [{type:"image", source:{type:"base64", media_type, data}}, {type:"text"}]
//   OpenAI-compatible   POST <base>/chat/completions
//                       content: [{type:"text"}, {type:"image_url", image_url:{url:"data:..."}}]
//                       (OpenAI, Google's OpenAI endpoint, OpenRouter, Hugging Face router, local servers)

import type { FetchImpl } from "./providers.js";
import { IDENTITY_FIELD_MAX, IDENTITY_SHEET_KEYS, readCropBox, type CropBox, type IdentitySheet } from "./identity.js";

export const ANALYSIS_PROVIDERS = ["anthropic", "openai", "google", "openrouter", "huggingface", "local", "openai-compatible"] as const;
export type AnalysisProvider = (typeof ANALYSIS_PROVIDERS)[number];

/** The fixed addresses of the hosted providers; the others need the saved model's own address. */
export const ANALYSIS_DEFAULT_BASE_URL: Partial<Record<AnalysisProvider, string>> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
  huggingface: "https://router.huggingface.co/v1",
};

export interface AnalysisModelSetting {
  /** "directory": a saved model from Settings > Models; "custom": typed in here. */
  source: "directory" | "custom";
  entryId: string | null;
  /** Shown on the page ("Claude Sonnet (saved model)"). */
  label: string | null;
  provider: AnalysisProvider;
  model: string;
  baseUrl: string | null;
  /** A company secret (id) holding the provider's key; null for a local server that needs none. */
  keySecretId: string | null;
}

export function isAnalysisProvider(value: unknown): value is AnalysisProvider {
  return typeof value === "string" && (ANALYSIS_PROVIDERS as readonly string[]).includes(value);
}

/** The address calls go to. Hosted providers always use their own address; the rest need an http(s) address. */
export function analysisBaseUrl(setting: Pick<AnalysisModelSetting, "provider" | "baseUrl">): string {
  const fixed = ANALYSIS_DEFAULT_BASE_URL[setting.provider];
  if (fixed && setting.provider !== "openrouter") return fixed;
  const given = setting.baseUrl?.trim() || fixed || "";
  if (!/^https?:\/\/[^\s]+$/i.test(given)) {
    throw new Error("The analysis model has no address. Pick a saved model that has one, or type the address in Media Studio's identity settings.");
  }
  return given.replace(/\/+$/, "");
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
  | { ok: false; kind: "not-adult"; message: string };

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
      ? { ok: false, kind: "not-adult", message: ANALYSIS_NOT_ADULT_MESSAGE }
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

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Send one picture to the analysis model and return its text answer. The key
 * stays in this call; error texts never include it.
 */
export async function callVisionModel(
  fetchImpl: FetchImpl,
  setting: AnalysisModelSetting,
  apiKey: string | null,
  picture: { contentType: string; contentBase64: string },
): Promise<string> {
  const base = analysisBaseUrl(setting);
  const scrub = (t: string) => (apiKey ? t.split(apiKey).join("[key]") : t).slice(0, 200);
  if (setting.provider !== "local" && setting.provider !== "openai-compatible" && !apiKey) {
    throw new Error("Pick the analysis model's key (a company secret) in Media Studio's identity settings.");
  }
  let res: Response;
  if (setting.provider === "anthropic") {
    res = await fetchImpl(`${base}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: setting.model,
        max_tokens: 900,
        system: ANALYSIS_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: picture.contentType, data: picture.contentBase64 } },
              { type: "text", text: ANALYSIS_USER_PROMPT },
            ],
          },
        ],
      }),
    });
  } else {
    res = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model: setting.model,
        max_tokens: 900,
        messages: [
          { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: ANALYSIS_USER_PROMPT },
              { type: "image_url", image_url: { url: `data:${picture.contentType};base64,${picture.contentBase64}` } },
            ],
          },
        ],
      }),
    });
  }
  const raw = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("The analysis model's service did not accept the key. Pick the right key in Media Studio's identity settings.");
    if (res.status === 429) throw new Error("The analysis model's service is busy. Try again in a minute.");
    let detail = "";
    try {
      const body = asRecord(JSON.parse(raw));
      const m = asRecord(body?.error)?.message ?? body?.message;
      if (typeof m === "string") detail = `: ${scrub(m)}`;
    } catch {
      // keep it short
    }
    throw new Error(`The analysis model could not look at the picture (error ${res.status})${detail}. If it cannot see pictures, pick another model.`);
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = asRecord(JSON.parse(raw));
  } catch {
    body = null;
  }
  if (setting.provider === "anthropic") {
    const parts = Array.isArray(body?.content) ? (body!.content as unknown[]) : [];
    return parts.map((p) => (asRecord(p)?.type === "text" ? String(asRecord(p)?.text ?? "") : "")).join("");
  }
  const choice = Array.isArray(body?.choices) ? asRecord((body!.choices as unknown[])[0]) : null;
  const message = asRecord(choice?.message);
  if (typeof message?.refusal === "string" && message.refusal) return message.refusal;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => String(asRecord(p)?.text ?? "")).join("");
  return "";
}
