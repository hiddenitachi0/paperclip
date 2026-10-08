import { z } from "zod";
import { LANE_A_PROVIDERS, type LaneAProvider } from "./lane-a-models.js";

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
}

export interface HelperSettingsView {
  defaultDirectoryEntryId: string | null;
  /** Reserved for Phase 3 (deeper investigations by a full agent). Stored, not used yet. */
  investigationAgentId: string | null;
  keys: HelperKeyStatus[];
  models: HelperModelOption[];
  /** What answers when no model is picked and no default is set. */
  builtInDefaultLabel: string;
  /** True when the person asking may change these settings (owner/admin). */
  canEdit: boolean;
  updatedAt: string | null;
}
