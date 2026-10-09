import { z } from "zod";
import { LANE_A_PROVIDERS, type LaneAProvider } from "./lane-a-models.js";
import { findKnownVariant } from "./known-models.js";
import type { ModelOptionStatus } from "./model-readiness.js";

/**
 * "Ask Paperclip" — the helper overlay (Phase 1).
 *
 * A person on the board opens the helper, optionally marks an area of the
 * page, and asks a question. The browser sends STRUCTURED text about what is
 * on the page (never pixels, never passwords), the server answers with one
 * model call that has NO tools at all, and the answer can be applied to one
 * opted-in text field, which the person still saves themselves.
 *
 * Where things live:
 *   - company_helper_settings (one lazy row per company): the default saved
 *     model and the full agent reserved for deeper investigations (Phase 3,
 *     stored but not used yet).
 *   - The helper's model keys are ordinary company secrets. Each pick is a
 *     company_secret_bindings row: target_type HELPER_BINDING_TARGET_TYPE,
 *     target_id = the company id, config_path helperKeyConfigPath(provider),
 *     so every read lands in secret_access_events.
 *   - Spend is a cost_events row with billing code HELPER_BILLING_CODE and no
 *     agent.
 */

export const HELPER_BINDING_TARGET_TYPE = "helper" as const;
export const HELPER_BILLING_CODE = "helper_ask";

/** config_path of the helper's key for one provider, e.g. "helper.apiKey.openrouter". */
export function helperKeyConfigPath(provider: LaneAProvider): string {
  return `helper.apiKey.${provider}`;
}

/** Providers that need a key of their own (Claude can fall back on Paperclip's key; a local model needs none). */
export const HELPER_KEYED_PROVIDERS = LANE_A_PROVIDERS.filter((p) => p !== "local");

/** Caps. The context cap matches what the browser captures. */
export const HELPER_CONTEXT_MAX_CHARS = 12_000;
export const HELPER_MESSAGE_MAX_CHARS = 4_000;
export const HELPER_HISTORY_MAX_TURNS = 12;
export const HELPER_HISTORY_TURN_MAX_CHARS = 6_000;
export const HELPER_PAGE_ROUTE_MAX_CHARS = 500;
export const HELPER_MAX_OUTPUT_TOKENS = 1_500;

// ─── Pictures (Phase 2) ──────────────────────────────────────────────────────

/**
 * Pictures the person attached to one question (upload, paste, or one of the
 * company's Files). Only pictures the person attached explicitly are sent;
 * nothing captures the screen. Uploaded pictures live for the one request
 * only: the server checks them, shrinks them, sends them to the model and
 * keeps nothing. A picked company file is read from Files for the request
 * and stays where it was.
 */
export const HELPER_PICTURES_MAX = 4;
export const HELPER_PICTURE_MAX_BYTES = 5 * 1024 * 1024;
export const HELPER_PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type HelperPictureType = (typeof HELPER_PICTURE_TYPES)[number];
/** Base64 length of the largest picture allowed (4 characters per 3 bytes, padded). */
export const HELPER_PICTURE_MAX_BASE64_CHARS = Math.ceil(HELPER_PICTURE_MAX_BYTES / 3) * 4;

export type HelperVisionSource = "setting" | "known_model" | "model_name" | "unknown";

/**
 * Model names that are known to read pictures, for saved models whose
 * "Pictures" field is not filled in and that are not in Paperclip's list of
 * known models. Only a guess from the name: the owner's own "Pictures"
 * setting on the saved model always wins.
 */
const VISION_NAME_PATTERNS: readonly RegExp[] = [
  /claude-(?:3|sonnet|opus|haiku|[4-9])/,
  /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5/,
  /gemini/,
  /gemma-?[34]/,
  /llava|bakllava/,
  /pixtral/,
  /mistral-small-3\.[12]|mistral-medium-3/,
  /llama-?4|llama3\.2-vision|llama-3\.2-\d+b-vision/,
  /minicpm-v|moondream|internvl|qvq/,
  /qwen[\d.]*-?vl/,
  /(?:^|[-_/:.])vl(?:$|[-_/:.])/,
  /vision/,
  /grok-(?:2-vision|4)/,
  /glm-4(?:\.\d)?v/,
];
const NO_VISION_NAME_PATTERNS: readonly RegExp[] = [/claude-(?:2|instant)/, /gemma-?3[:_-]?1b/, /embed/];

/**
 * Whether a model can look at pictures, and where that answer comes from:
 * the saved model's own "Pictures" setting (Settings → Models), then
 * Paperclip's list of known models, then a guess from the model's name.
 * `canSee: null` means nobody knows; the helper then does not send pictures
 * to it and says how to mark the model.
 */
export function helperModelCanSeePictures(input: {
  provider: string;
  model: string;
  specs?: Record<string, unknown> | null;
}): { canSee: boolean | null; source: HelperVisionSource } {
  const own = input.specs?.vision;
  if (typeof own === "boolean") return { canSee: own, source: "setting" };
  const known = input.model.trim() ? findKnownVariant(input.provider, input.model) : null;
  if (known && typeof known.variant.vision === "boolean") return { canSee: known.variant.vision, source: "known_model" };
  const name = input.model.trim().toLowerCase();
  if (!name) return { canSee: null, source: "unknown" };
  if (NO_VISION_NAME_PATTERNS.some((re) => re.test(name))) return { canSee: false, source: "model_name" };
  if (input.provider === "anthropic" || VISION_NAME_PATTERNS.some((re) => re.test(name))) {
    return { canSee: true, source: "model_name" };
  }
  return { canSee: null, source: "unknown" };
}

/** What replaces anything that looks like a key, token, password or card number. */
export const HELPER_MASK = "[hidden]";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PREFIXED_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[A-Z0-9]{12,}/g,
  /\bshp(?:at|ss|ca|pa)_[A-Za-z0-9]{20,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** "api_key: abc", "password=abc", "token abc" — the value after a secret-ish word. */
const LABELLED_SECRET_RE =
  /\b(api[ _-]?key|access[ _-]?token|auth[ _-]?token|bearer|token|secret|password|passwd|pwd|passord|private[ _-]?key|client[ _-]?secret)(\s*[:=]\s*|\s+)(["']?)([^\s"',;]{6,})\3/gi;

/** A long run of key-ish characters with both letters and digits (but not a record id). */
const LONG_TOKEN_RE = /[A-Za-z0-9_\-+/=]{32,}/g;

const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Masks anything that looks like a key, token, password or card number.
 * Used by the browser before showing "What the helper sees" and again by the
 * server before the text reaches a model (the browser is not trusted to
 * have done it). Record ids (UUIDs) are kept: they identify what the person
 * marked and are not secrets.
 */
export function maskSecretLikeText(input: string): string {
  if (!input) return input;
  let out = input;
  for (const re of PREFIXED_SECRET_PATTERNS) out = out.replace(re, HELPER_MASK);
  out = out.replace(LABELLED_SECRET_RE, (match, word: string, sep: string, quote: string, value: string) => {
    if (value === HELPER_MASK || UUID_RE.test(value)) return match;
    // "token" / "secret" in ordinary prose ("the token count is high") is only
    // masked when the value itself looks like a key: digits and letters mixed.
    const looksLikeKey = /\d/.test(value) && /[A-Za-z]/.test(value);
    const strongWord = /pass|pwd|key|secret/i.test(word) && sep.trim().length > 0;
    if (!looksLikeKey && !strongWord) return match;
    return `${word}${sep}${quote}${HELPER_MASK}${quote}`;
  });
  out = out.replace(LONG_TOKEN_RE, (match) => {
    if (UUID_RE.test(match)) return match;
    if (/^[a-z]+(?:[-_/][a-z]+)*$/i.test(match)) return match; // a long plain word or path of words
    if (!/\d/.test(match) || !/[A-Za-z]/.test(match)) return match;
    return HELPER_MASK;
  });
  out = out.replace(CARD_RE, (match) => {
    const digits = match.replace(/[ -]/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? HELPER_MASK : match;
  });
  return out;
}

/** Cuts text to `max` characters, saying so at the end. */
export function capHelperText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const note = "\n[…cut: too long]";
  return { text: text.slice(0, Math.max(0, max - note.length)) + note, truncated: true };
}

// ─── API shapes ──────────────────────────────────────────────────────────────

export const helperAskTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(HELPER_HISTORY_TURN_MAX_CHARS),
});

export const helperPictureSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("upload"),
      /** The file name, only to name the picture back to the person. */
      name: z.string().max(200).optional().nullable(),
      /** What the browser says it is; the server checks the bytes themselves. */
      contentType: z.string().max(100).optional().nullable(),
      dataBase64: z
        .string()
        .min(1)
        .max(HELPER_PICTURE_MAX_BASE64_CHARS, `A picture can be at most ${HELPER_PICTURE_MAX_BYTES / (1024 * 1024)} MB.`),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      /** An attachment id from this company's Files. */
      fileId: z.string().uuid(),
    })
    .strict(),
]);
export type HelperPictureInput = z.infer<typeof helperPictureSchema>;

export const helperAskSchema = z
  .object({
    message: z.string().trim().min(1, "Type a question first.").max(HELPER_MESSAGE_MAX_CHARS),
    /** The captured page context as text. Longer text is refused, not silently cut. */
    context: z.string().max(HELPER_CONTEXT_MAX_CHARS).optional().nullable(),
    pageRoute: z.string().max(HELPER_PAGE_ROUTE_MAX_CHARS).optional().nullable(),
    /** A saved model (model directory entry) of this company; absent = the company's helper default. */
    directoryEntryId: z.string().uuid().optional().nullable(),
    /** Earlier turns of this panel conversation (kept in the browser only). */
    history: z.array(helperAskTurnSchema).max(HELPER_HISTORY_MAX_TURNS * 2).optional(),
    /** Pictures attached to this question only (Phase 2). Needs a model that can see pictures. */
    pictures: z
      .array(helperPictureSchema)
      .max(HELPER_PICTURES_MAX, `Attach at most ${HELPER_PICTURES_MAX} pictures to one question.`)
      .optional(),
  })
  .strict();
export type HelperAskRequest = z.infer<typeof helperAskSchema>;

export interface HelperAskResponse {
  answer: string;
  /** Which saved model answered (null = Paperclip's built-in default). */
  directoryEntryId: string | null;
  modelLabel: string;
  provider: LaneAProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  truncated: boolean;
  /** How many pictures the model was shown with this question. */
  pictureCount: number;
}

export const updateHelperSettingsSchema = z
  .object({
    defaultDirectoryEntryId: z.string().uuid().nullable().optional(),
    investigationAgentId: z.string().uuid().nullable().optional(),
    /** provider → company secret id (null removes the pick). Providers left out are unchanged. */
    keys: z
      .record(z.enum(LANE_A_PROVIDERS), z.string().uuid().nullable())
      .optional(),
  })
  .strict();
export type UpdateHelperSettings = z.infer<typeof updateHelperSettingsSchema>;

export interface HelperKeyStatus {
  provider: LaneAProvider;
  providerLabel: string;
  secretId: string | null;
  secretName: string | null;
  /** none: nothing picked. ok: picked and active. unusable: picked but deleted/switched off. */
  status: "none" | "ok" | "unusable";
  /** True for Claude when Paperclip's own key will be used if none is picked. */
  instanceFallback: boolean;
}

export interface HelperModelOption {
  id: string;
  name: string;
  provider: LaneAProvider;
  providerLabel: string;
  model: string;
  maker: string | null;
  baseModel: string | null;
  lane: string | null;
  favorite: boolean;
  /** False when the helper has no key it could use for this model; `keyHint` says what to do. */
  keyReady: boolean;
  keyHint: string | null;
  /** True: can look at pictures. False: cannot. Null: not known (treated as "cannot" for pictures). */
  canSeePictures: boolean | null;
  /** Where `canSeePictures` comes from: the saved model's own setting, Paperclip's known models, or its name. */
  picturesSource: HelperVisionSource;
  /**
   * Is it ready to answer the helper? From what Paperclip already knows (the
   * helper's keys, the last model-server reading for a local model); no
   * model is called. Same shape as every other model picker's status.
   */
  status: ModelOptionStatus;
}

export interface HelperSettingsView {
  defaultDirectoryEntryId: string | null;
  /** Reserved for Phase 3 (deeper investigations by a full agent). Stored, not used yet. */
  investigationAgentId: string | null;
  keys: HelperKeyStatus[];
  models: HelperModelOption[];
  /** What answers when no model is picked and no default is set. */
  builtInDefaultLabel: string;
  /** Whether the built-in default can look at pictures. */
  builtInDefaultCanSeePictures: boolean;
  /** Is the built-in default ready (Paperclip's own Claude key set, or a Claude key picked for the helper)? */
  builtInDefaultStatus: ModelOptionStatus;
  /** True when the person asking may change these settings (owner/admin). */
  canEdit: boolean;
  updatedAt: string | null;
}
