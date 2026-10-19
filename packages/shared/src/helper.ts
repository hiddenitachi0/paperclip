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
 *     model, the full agent that takes deeper investigations (Phase 3) and
 *     the per-person investigation limits.
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
/**
 * What the ask route ACCEPTS as history. It is more than the model gets: the
 * server keeps only the last HELPER_HISTORY_MAX_TURNS questions and answers,
 * each cut to HELPER_HISTORY_TURN_MAX_CHARS, so a long conversation (or an
 * older browser tab that sends all of it) keeps working instead of being
 * refused.
 */
export const HELPER_HISTORY_ACCEPT_MAX_ITEMS = 100;
export const HELPER_HISTORY_ACCEPT_TURN_MAX_CHARS = 24_000;
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

// ─── Investigations (Phase 3) ────────────────────────────────────────────────

/**
 * "Investigate deeper": the person hands a question to a full agent (the
 * company's investigation agent, picked by an owner/admin under Company
 * settings → General → Helper). It is an ordinary task in the company,
 * assigned to that agent, marked with this origin kind and created by the
 * person, so their own investigations can be listed back in the Ask panel.
 * The agent is told to give advice only and finish with one plain answer.
 */
export const HELPER_INVESTIGATION_ORIGIN_KIND = "helper_investigation" as const;
/** Billing code on the task, so its runs show up as helper investigations in Costs. */
export const HELPER_INVESTIGATION_BILLING_CODE = "helper_investigation";
/** Per person, per company. An owner/admin can change both under Helper settings. */
export const HELPER_INVESTIGATION_DEFAULT_MAX_RUNNING = 3;
export const HELPER_INVESTIGATION_DEFAULT_MAX_PER_DAY = 20;
export const HELPER_INVESTIGATION_MAX_RUNNING_CAP = 20;
export const HELPER_INVESTIGATION_MAX_PER_DAY_CAP = 200;
/** For the whole company together, in 24 hours (owner/admin can change it). */
export const HELPER_INVESTIGATION_DEFAULT_COMPANY_MAX_PER_DAY = 50;
export const HELPER_INVESTIGATION_COMPANY_MAX_PER_DAY_CAP = 1000;
/** How many of the person's own investigations the panel lists (newest first). */
export const HELPER_INVESTIGATIONS_LIST_LIMIT = 20;
export const HELPER_INVESTIGATION_REFERENCES_MAX = 20;
export const HELPER_INVESTIGATION_QUICK_ANSWER_MAX_CHARS = 6_000;
/** Text fields on the person's screen the answer may be put into ("Apply to …"). */
export const HELPER_INVESTIGATION_APPLY_TARGETS_MAX = 8;
export const HELPER_APPLY_TARGET_MAX_CHARS = 120;

/**
 * The line the quick model ends an answer with when it thinks an agent should
 * take a closer look. The server removes it and sets `suggestInvestigation`.
 */
export const HELPER_SUGGEST_INVESTIGATION_MARKER = "[[suggest-investigation]]";
const SUGGEST_MARKER_SOURCE = String.raw`\[\[\s*suggest[-_ ]investigation\s*\]\]`;

/** Removes the suggestion marker from a quick answer and says whether it was there. */
export function stripInvestigationSuggestion(answer: string): { text: string; suggested: boolean } {
  if (!new RegExp(SUGGEST_MARKER_SOURCE, "i").test(answer)) return { text: answer, suggested: false };
  const text = answer.replace(new RegExp(SUGGEST_MARKER_SOURCE, "gi"), "").replace(/\n{3,}/g, "\n\n").trim();
  return { text, suggested: true };
}

/**
 * The line the quick model ends an answer with when the person is asking
 * Paperclip to DO something (create, hire, change, assign, delete…) rather
 * than to explain. The server removes it and sets `suggestBoardChat`.
 */
export const HELPER_WANTS_CHANGE_MARKER = "[[wants-change]]";
const WANTS_CHANGE_MARKER_SOURCE = String.raw`\[\[\s*wants?[-_ ]change\s*\]\]`;

/** Removes the "wants a change" marker from a quick answer and says whether it was there. */
export function stripChangeRequestMarker(answer: string): { text: string; wantsChange: boolean } {
  if (!new RegExp(WANTS_CHANGE_MARKER_SOURCE, "i").test(answer)) return { text: answer, wantsChange: false };
  const text = answer.replace(new RegExp(WANTS_CHANGE_MARKER_SOURCE, "gi"), "").replace(/\n{3,}/g, "\n\n").trim();
  return { text, wantsChange: true };
}

/**
 * Openings that hand the rest of the sentence to someone else ("can you …",
 * "please …", "I want to …"). They are removed before looking for the verb.
 * English first; a few Norwegian ones because many Paperclip companies write
 * Norwegian. Questions in other languages rely on the model's marker.
 */
const CHANGE_REQUEST_OPENERS: RegExp[] = [
  /^(?:hey|hi|ok(?:ay)?|so|now|then|and|also)[,!]?\s+/,
  /^(?:please|pls|plz|kindly)[,!]?\s+/,
  /^(?:can|could|would|will)\s+(?:you|u|paperclip)(?:\s+please)?\s+/,
  /^(?:i|we)\s+(?:want|need|would like|'d like|wanna)\s+(?:you\s+)?to\s+/,
  /^(?:i|we)'?d\s+like\s+(?:you\s+)?to\s+/,
  /^i\s+want\s+you\s+to\s+/,
  /^(?:let'?s|lets)\s+/,
  /^go\s+ahead\s+and\s+/,
  /^help\s+me\s+(?:to\s+)?/,
  /^(?:kan|kunne|vil)\s+du(?:\s+være\s+så\s+snill\s+(?:å\s+)?)?\s+/,
  /^(?:vær\s+så\s+snill\s+(?:og|å)\s+|vennligst\s+)/,
  /^(?:jeg|vi)\s+(?:vil|ønsker)\s+(?:at\s+du\s+skal\s+|å\s+)?/,
];

/**
 * Verbs that, at the start of a request, ask for something to be changed.
 * "write" and "draft" are left out on purpose: asking for text to put in a
 * field is exactly what Ask is for ("Apply to field").
 */
const CHANGE_VERB_RE = new RegExp(
  String.raw`^(?:` +
    [
      "create", "add", "hire", "fire", "employ", "recruit", "onboard", "terminate", "retire",
      "delete", "remove", "drop", "archive", "unarchive", "restore",
      "change", "set", "reset", "update", "edit", "modify", "rename", "replace", "switch",
      "assign", "reassign", "unassign", "move", "transfer",
      "enable", "disable", "activate", "deactivate", "turn\\s+(?:on|off)", "switch\\s+(?:on|off)",
      "pause", "unpause", "resume", "restart", "start", "stop", "kill", "cancel", "close", "reopen",
      "approve", "reject", "deny", "decline", "accept", "merge", "deploy", "publish",
      "schedule", "reschedule", "configure", "install", "uninstall", "connect", "disconnect",
      "invite", "promote", "demote", "raise", "lower", "increase", "decrease", "bump", "cap", "limit",
      "set\\s*up", "make\\s+(?:a\\s+new|another|an?\\s+(?:agent|task|job|project|routine|goal|company|team))\\b",
      "open\\s+(?:a|an)\\s+new", "spin\\s+up",
      // Norwegian
      "opprett", "lag\\s+(?:en|et)\\s+ny(?:tt)?", "legg\\s+til", "ansett", "si\\s+opp", "slett", "fjern", "arkiver", "endre", "bytt",
      "sett(?:\\s+opp)?", "oppdater", "tildel", "flytt", "skru\\s+(?:på|av)", "aktiver", "deaktiver",
      "start", "stopp", "pause", "godkjenn", "avvis", "inviter", "øk", "senk", "planlegg",
      // ...and their infinitive forms ("kan du opprette …")
      "opprette", "legge\\s+til", "ansette", "slette", "fjerne", "arkivere", "bytte", "sette(?:\\s+opp)?",
      "oppdatere", "tildele", "flytte", "aktivere", "deaktivere", "starte", "stoppe", "godkjenne", "avvise",
      "invitere", "øke", "senke", "planlegge",
    ].join("|") +
    String.raw`)(?=\s|$|[.,!?:;])`,
);

/** Openings that make a sentence a question about something, not a request ("how do I…", "should I…"). */
const EXPLAIN_OPENER_RE =
  /^(?:how|what|what's|whats|why|where|when|which|who|whose|is|are|was|were|does|do|did|should|shall|can\s+i|could\s+i|may\s+i|am\s+i|explain|tell\s+me|show\s+me|describe|hvordan|hva|hvorfor|hvor|når|hvilken|hvilke|hvem|er|kan\s+jeg|bør|skal\s+jeg|forklar)\b/;

function sentenceAsksForChange(sentence: string): boolean {
  let s = sentence.trim().toLowerCase().replace(/^[\s"'“”‘’(\[*-]+/, "");
  if (!s) return false;
  // Peel openers repeatedly ("ok, can you please …").
  for (let i = 0; i < 4; i += 1) {
    const before = s;
    for (const re of CHANGE_REQUEST_OPENERS) s = s.replace(re, "");
    if (s === before) break;
  }
  if (EXPLAIN_OPENER_RE.test(s)) return false;
  return CHANGE_VERB_RE.test(s);
}

/**
 * Cheap, predictable check: is this question asking Paperclip to DO
 * something (hire, create, change a setting, assign, delete, set up a job…)
 * rather than to explain? Looks at the start of each sentence for a request
 * verb, after removing polite openings. "How do I hire an agent?" is a
 * question (false); "Can you hire an agent?" is a request (true).
 *
 * The server combines this with the quick model's own marker, so requests
 * this misses (other languages, unusual wording) are still caught.
 */
export function helperQuestionAsksForChange(message: string): boolean {
  if (!message) return false;
  return message
    .split(/(?<=[.!?])\s+|\n+/)
    .slice(0, 12)
    .some(sentenceAsksForChange);
}

/** A record the person marked, e.g. "approval:<id>" or "agent:<id>". */
const HELPER_REFERENCE_RE = /^[a-z][a-z0-9_-]{0,39}:[A-Za-z0-9_.-]{1,120}$/;

/** Plain status of an investigation, as the panel shows it. */
export type HelperInvestigationStatus = "queued" | "working" | "done" | "failed";

export interface HelperInvestigationView {
  /** The task's id. */
  id: string;
  /** The task's identifier, e.g. "ACM-123" (null only for very old tasks). */
  identifier: string | null;
  title: string;
  question: string;
  status: HelperInvestigationStatus;
  /** One or two words for the badge: "Waiting to start", "Working", "Done", "Stopped", "Stuck". */
  statusLabel: string;
  /** A plain sentence about the state, when there is something to say. */
  statusDetail: string | null;
  /** The agent's final answer (Markdown), once it has written one. */
  answer: string | null;
  answeredAt: string | null;
  agentId: string | null;
  agentName: string | null;
  /** What the task's runs have cost so far, in cents (Costs view). */
  costCents: number;
  /**
   * Text fields that were on screen when the question was asked. The panel
   * offers "Apply to …" for the answer while such a field is still on screen.
   */
  applyTargets: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HelperInvestigationEstimate {
  /** How many of the agent's recent finished tasks the numbers come from (0 = no history). */
  basedOnTasks: number;
  /** The middle (median) time those tasks took from start to done, in minutes. */
  typicalMinutes: number | null;
  /** The middle (median) cost of those tasks, in cents. */
  typicalCostCents: number | null;
}

/** Whether "Investigate deeper" can start, and what it will cost, in plain words. */
export interface HelperInvestigationAvailability {
  agentId: string | null;
  agentName: string | null;
  /** True when a click would start it now. */
  ready: boolean;
  /** Why it cannot start, in plain words (null when ready). */
  problem: string | null;
  problemCode:
    | "no_agent"
    | "agent_unavailable"
    | "agent_can_write"
    | "assign_denied"
    | "budget"
    | "limit_running"
    | "limit_daily"
    | "limit_company_daily"
    | null;
  estimate: HelperInvestigationEstimate;
  /** The agent's monthly budget and what it has spent this month, in cents (budget 0 = no monthly budget set). */
  agentBudgetMonthlyCents: number;
  agentSpentMonthlyCents: number;
  maxRunning: number;
  maxPerDay: number;
  /** The person's own investigations: running now (blocked ones count too), and started in the last 24 hours. */
  runningCount: number;
  startedLast24h: number;
  /** The whole company: the most allowed in 24 hours, and how many were started in the last 24 hours. */
  companyMaxPerDay: number;
  companyStartedLast24h: number;
  /** True when the person may change the helper settings (owner/admin). */
  canConfigure: boolean;
}

export interface HelperInvestigationList {
  investigations: HelperInvestigationView[];
  availability: HelperInvestigationAvailability;
}

/** A record the person marked that was NOT handed to the agent, and why (plain words). */
export interface HelperDroppedReference {
  reference: string;
  reason: string;
}

export interface HelperInvestigationStartResponse extends HelperInvestigationView {
  /** Marked records left out because the person may not see them (or they are not in this company). */
  droppedReferences: HelperDroppedReference[];
}

/** What the investigation agent could change, in plain words (empty = nothing Paperclip knows of). */
export interface HelperInvestigationAgentSummary {
  id: string;
  name: string;
  status: string;
  /** 0 = no monthly budget set, so nothing caps what its investigations cost. */
  budgetMonthlyCents: number;
  /** E.g. "can ask for deploys", "has secrets besides its model login (GITHUB_TOKEN)". */
  writeCapabilities: string[];
  /** True when an owner/admin confirmed every one of writeCapabilities for this agent. */
  writeAcknowledged: boolean;
}

// ─── API shapes ──────────────────────────────────────────────────────────────

export const helperAskTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(HELPER_HISTORY_ACCEPT_TURN_MAX_CHARS),
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
    /** Earlier turns of this panel conversation (kept in the browser only; the server uses the last few). */
    history: z.array(helperAskTurnSchema).max(HELPER_HISTORY_ACCEPT_MAX_ITEMS).optional(),
    /** Pictures attached to this question only (Phase 2). Needs a model that can see pictures. */
    pictures: z
      .array(helperPictureSchema)
      .max(HELPER_PICTURES_MAX, `Attach at most ${HELPER_PICTURES_MAX} pictures to one question.`)
      .optional(),
  })
  .strict();
export type HelperAskRequest = z.infer<typeof helperAskSchema>;

/** "Investigate deeper": hand one question to the company's investigation agent. */
export const startHelperInvestigationSchema = z
  .object({
    question: z.string().trim().min(1, "Type a question first.").max(HELPER_MESSAGE_MAX_CHARS),
    /** The captured page context (masked again on the server). */
    context: z.string().max(HELPER_CONTEXT_MAX_CHARS).optional().nullable(),
    pageRoute: z.string().max(HELPER_PAGE_ROUTE_MAX_CHARS).optional().nullable(),
    /** Records the person marked, e.g. "approval:<id>", "agent:<id>". */
    references: z
      .array(z.string().regex(HELPER_REFERENCE_RE, "A record reference looks like \"approval:<id>\"."))
      .max(HELPER_INVESTIGATION_REFERENCES_MAX)
      .optional(),
    /** The quick helper's answer the person wants checked, if any (shown to the agent as "may be wrong"). */
    quickAnswer: z.string().max(HELPER_INVESTIGATION_QUICK_ANSWER_MAX_CHARS).optional().nullable(),
    /** Pictures, same rules as a question; kept on the task as attachments. */
    pictures: z
      .array(helperPictureSchema)
      .max(HELPER_PICTURES_MAX, `Attach at most ${HELPER_PICTURES_MAX} pictures to one question.`)
      .optional(),
    /** Labels of the text fields on screen the answer may be put into later. */
    applyTargets: z
      .array(z.string().trim().min(1).max(HELPER_APPLY_TARGET_MAX_CHARS))
      .max(HELPER_INVESTIGATION_APPLY_TARGETS_MAX)
      .optional(),
  })
  .strict();
export type StartHelperInvestigationRequest = z.infer<typeof startHelperInvestigationSchema>;

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
  /**
   * Phase 3: the quick model said a good answer needs a closer look than it
   * can give (code, reviews, logs, data). The panel then offers "Investigate
   * deeper"; nothing starts until the person clicks.
   */
  suggestInvestigation: boolean;
  /**
   * The question asks Paperclip to DO something (create, hire, change a
   * setting, assign, delete, set up a job…). Ask cannot; the panel then
   * offers "Do this in Board chat" (if this person can use it). Set when the
   * question reads like a request (helperQuestionAsksForChange) or the quick
   * model marked it ([[wants-change]]).
   */
  suggestBoardChat: boolean;
}

export const updateHelperSettingsSchema = z
  .object({
    defaultDirectoryEntryId: z.string().uuid().nullable().optional(),
    investigationAgentId: z.string().uuid().nullable().optional(),
    /** Most investigations one person may have running at once (null = Paperclip's default). */
    investigationMaxRunning: z.number().int().min(1).max(HELPER_INVESTIGATION_MAX_RUNNING_CAP).nullable().optional(),
    /** Most investigations one person may start in 24 hours (null = Paperclip's default). */
    investigationMaxPerDay: z.number().int().min(1).max(HELPER_INVESTIGATION_MAX_PER_DAY_CAP).nullable().optional(),
    /** Most investigations the whole company may start in 24 hours (null = Paperclip's default). */
    investigationCompanyMaxPerDay: z
      .number()
      .int()
      .min(1)
      .max(HELPER_INVESTIGATION_COMPANY_MAX_PER_DAY_CAP)
      .nullable()
      .optional(),
    /**
     * The owner/admin confirms that the investigation agent can change things
     * (rights or secrets beyond reading) and that text on screen could try to
     * make it do so. Without it, such an agent is refused.
     */
    acknowledgeInvestigatorCanWrite: z.boolean().optional(),
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
  /** The full agent that takes "Investigate deeper" requests (Phase 3). Null = investigations are off. */
  investigationAgentId: string | null;
  /** Most investigations one person may have running at once (the company's pick, or Paperclip's default). */
  investigationMaxRunning: number;
  /** Most investigations one person may start in 24 hours (the company's pick, or Paperclip's default). */
  investigationMaxPerDay: number;
  /** Most investigations the whole company may start in 24 hours (the company's pick, or Paperclip's default). */
  investigationCompanyMaxPerDay: number;
  /** The picked investigation agent: its budget and what it could change (null = none picked). */
  investigationAgent: HelperInvestigationAgentSummary | null;
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
