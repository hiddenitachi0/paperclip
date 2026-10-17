import { z } from "zod";
import { findKnownVariant } from "./known-models.js";
import { normalizeLaneAProvider, type LaneAProviderRouting } from "./lane-a-models.js";
import { openRouterHostsAllowed, withOpenRouterBlockedHostsForCall } from "./openrouter-hosts.js";
import type { ModelPickerReadiness } from "./model-picker-readiness.js";
import {
  VIDEO_SHOT_MAX_DURATION_SECONDS,
  VIDEO_SHOT_MIN_DURATION_SECONDS,
  VIDEO_SHOT_TRANSITIONS,
  VIDEO_STORYLINE_PROVIDERS,
  type VideoShotTransition,
  type VideoStorylineProvider,
} from "./video-storylines.js";
import {
  VIDEO_SCRIPT_CAMERA_NOTES_MAX_LENGTH,
  VIDEO_SCRIPT_PROMPT_MAX_LENGTH,
  validateVideoStorylineScript,
  type ParsedVideoStorylineScript,
} from "./video-storyline-script.js";

/**
 * Storyline directors and the AI story writer (18 Oct 2026).
 *
 * A DIRECTOR is a per-company, named way of writing a storyboard: which saved
 * model writes, which (optional) saved model looks at pictures first, which
 * (optional) saved model does the tool work for a writer that cannot use
 * tools, how creative it is, its style instructions, and its default video
 * and picture settings. Every company starts with two editable starters
 * ("Tutorial / explainer" and "Action movie"); owners and admins can change,
 * add and delete directors.
 *
 * The STORY WRITER is the one-stop writer in step 1 of a storyline: the
 * person writes ideas and pointers, the chosen director may ask 1-3 short
 * questions, then writes the whole storyboard straight into the storyline
 * (the same shape the JSON script import takes). Later requests in the same
 * chat ("make shot 3 more dramatic") come back as a list of changes the
 * person accepts or rejects; nothing changes until they accept.
 *
 * The writer's answer is always checked here, in one place, whether it came
 * from a model that used tools or from one that only wrote text
 * (parseVideoWriterReply).
 */

// ─── Limits ────────────────────────────────────────────────────────────────

export const VIDEO_DIRECTOR_NAME_MAX_LENGTH = 80;
export const VIDEO_DIRECTOR_DESCRIPTION_MAX_LENGTH = 500;
export const VIDEO_DIRECTOR_STYLE_MAX_LENGTH = 6_000;
export const VIDEO_DIRECTOR_MAX_PER_COMPANY = 50;
export const VIDEO_DIRECTOR_THINKING_SETTINGS = ["on", "off"] as const;
export type VideoDirectorThinking = (typeof VIDEO_DIRECTOR_THINKING_SETTINGS)[number];

export const VIDEO_WRITER_IDEAS_MAX_LENGTH = 6_000;
export const VIDEO_WRITER_REQUEST_MAX_LENGTH = 2_000;
export const VIDEO_WRITER_ANSWER_MAX_LENGTH = 2_000;
export const VIDEO_WRITER_MAX_QUESTIONS = 3;
export const VIDEO_WRITER_MAX_QUESTION_OPTIONS = 4;
/** After this many rounds of questions the writer writes with what it has. */
export const VIDEO_WRITER_MAX_QUESTION_ROUNDS = 2;
export const VIDEO_WRITER_MAX_REFERENCE_PICTURES = 6;
export const VIDEO_WRITER_MAX_CHANGES = 200;
export const VIDEO_WRITER_MIN_TARGET_SECONDS = 5;
export const VIDEO_WRITER_MAX_TARGET_SECONDS = 1_800;
export const VIDEO_WRITER_MUSIC_MAX_LENGTH = 500;
/** How many times a broken answer is sent back to be fixed before the writer gives up. */
export const VIDEO_WRITER_MAX_REPAIRS = 2;

/** Cost events of the writer carry these billing codes. */
export const VIDEO_WRITER_BILLING_CODE = "video_storyline_writer";
export const VIDEO_WRITER_ANALYSIS_BILLING_CODE = "video_storyline_writer_analysis";
export const VIDEO_WRITER_HELPER_BILLING_CODE = "video_storyline_writer_helper";

/** The plain line the director editor shows for a writing model that cannot use tools. */
export const VIDEO_DIRECTOR_TEXT_ONLY_EXPLANATION = "This model can't use tools; the helper model does the lookups for it.";
export const VIDEO_DIRECTOR_TEXT_ONLY_NO_HELPER_EXPLANATION =
  "This model can't use tools. Paperclip looks things up for it and checks its answer. Pick a helper model that can use tools for the best results.";

// ─── Starter directors ─────────────────────────────────────────────────────

export interface VideoDirectorStarter {
  key: "tutorial" | "action";
  name: string;
  description: string;
  styleInstructions: string;
  defaultShotSeconds: number;
  temperature: number | null;
}

export const VIDEO_DIRECTOR_STARTERS: readonly VideoDirectorStarter[] = [
  {
    key: "tutorial",
    name: "Tutorial / explainer",
    description: "Calm, clear videos that show how something works, one step at a time.",
    temperature: 0.4,
    defaultShotSeconds: 5,
    styleInstructions: [
      "Tone: friendly, calm and clear. The viewer is learning something.",
      "Structure: a short hook that shows the result, then one step per shot in the order a person would do it, then the finished result again.",
      "Pacing: steady. One idea per shot. Give the viewer time to see each step.",
      "Shot length: mostly 5 seconds; up to 10 seconds for a step with a lot to see.",
      "Camera: mostly static or slow moves. Medium shots and close-ups of hands, tools and screens. Eye level. No fast cuts or shaky camera.",
      "Lighting: bright and even, so details are easy to see.",
      "Transitions: cut within a step sequence; a soft dissolve between chapters.",
    ].join("\n"),
  },
  {
    key: "action",
    name: "Action movie",
    description: "Fast, dramatic films with movement, tension and a big finish.",
    temperature: 0.9,
    defaultShotSeconds: 5,
    styleInstructions: [
      "Tone: tense, energetic, cinematic.",
      "Structure: open in the middle of the action, build tension, a turning point, then a big climax and a short calm ending shot.",
      "Pacing: fast. Short shots in the action; one slower shot before the climax to build suspense.",
      "Shot length: mostly 5 seconds; never longer than 10 seconds.",
      "Camera: dynamic. Tracking shots, low angles, quick push-ins, handheld feel in chases, wide establishing shots between scenes.",
      "Lighting: high contrast, dramatic, strong backlight, sparks, rain or dust where it fits.",
      "Transitions: hard cuts; a fade only at the very end.",
    ].join("\n"),
  },
];

// ─── Directors: requests ───────────────────────────────────────────────────

const optionalUuid = z.string().uuid().nullable();

const directorFields = {
  name: z.string().trim().min(1, "Give the director a name.").max(VIDEO_DIRECTOR_NAME_MAX_LENGTH),
  description: z.string().trim().max(VIDEO_DIRECTOR_DESCRIPTION_MAX_LENGTH),
  writingEntryId: optionalUuid,
  writingKeySecretId: optionalUuid,
  analysisEntryId: optionalUuid,
  analysisKeySecretId: optionalUuid,
  helperEntryId: optionalUuid,
  helperKeySecretId: optionalUuid,
  temperature: z.number().min(0).max(2).nullable(),
  thinking: z.enum(VIDEO_DIRECTOR_THINKING_SETTINGS).nullable(),
  styleInstructions: z.string().trim().max(VIDEO_DIRECTOR_STYLE_MAX_LENGTH),
  defaultVideoProviderId: z.enum(VIDEO_STORYLINE_PROVIDERS).nullable(),
  defaultVideoModel: z.string().trim().min(1).max(200).nullable(),
  defaultLookId: z.string().trim().min(1).max(100).nullable(),
  defaultShotSeconds: z.number().int().min(VIDEO_SHOT_MIN_DURATION_SECONDS).max(VIDEO_SHOT_MAX_DURATION_SECONDS).nullable(),
};

export const createVideoStorylineDirectorSchema = z
  .object({
    name: directorFields.name,
    description: directorFields.description.optional().default(""),
    writingEntryId: directorFields.writingEntryId.optional().default(null),
    writingKeySecretId: directorFields.writingKeySecretId.optional().default(null),
    analysisEntryId: directorFields.analysisEntryId.optional().default(null),
    analysisKeySecretId: directorFields.analysisKeySecretId.optional().default(null),
    helperEntryId: directorFields.helperEntryId.optional().default(null),
    helperKeySecretId: directorFields.helperKeySecretId.optional().default(null),
    temperature: directorFields.temperature.optional().default(null),
    thinking: directorFields.thinking.optional().default(null),
    styleInstructions: directorFields.styleInstructions.optional().default(""),
    defaultVideoProviderId: directorFields.defaultVideoProviderId.optional().default(null),
    defaultVideoModel: directorFields.defaultVideoModel.optional().default(null),
    defaultLookId: directorFields.defaultLookId.optional().default(null),
    defaultShotSeconds: directorFields.defaultShotSeconds.optional().default(null),
  })
  .strict();
export type CreateVideoStorylineDirectorInput = z.infer<typeof createVideoStorylineDirectorSchema>;

export const updateVideoStorylineDirectorSchema = z.object(directorFields).partial().strict();
export type UpdateVideoStorylineDirectorInput = z.infer<typeof updateVideoStorylineDirectorSchema>;

/** PUT .../video-storylines/:id/director: which director writes this storyline (null = none picked). */
export const setVideoStorylineDirectorSchema = z.object({ directorId: z.string().uuid().nullable() }).strict();
export type SetVideoStorylineDirectorInput = z.infer<typeof setVideoStorylineDirectorSchema>;

// ─── Directors: what the API returns ───────────────────────────────────────

export type VideoDirectorModelRole = "writing" | "analysis" | "helper";

/** Whether a model can make tool calls where it runs, and why, in plain words. */
export interface VideoDirectorToolSupport {
  canUseTools: boolean;
  /** "known" = from the model's facts or its hosts; "unknown" = not known, treated as no. */
  source: "known" | "hosts" | "unknown";
  reason: string;
}

export interface VideoDirectorModelView {
  entryId: string;
  /** null = the saved model is gone (deleted or archived). */
  name: string | null;
  provider: string | null;
  model: string | null;
  keySecretId: string | null;
  /** Whether a key is in place for this model: its own key, the helper's key for its service, Paperclip's Claude key, or none needed. */
  keyReady: boolean;
  keyNote: string;
  canSeePictures: boolean | null;
  toolSupport: VideoDirectorToolSupport | null;
  readiness: ModelPickerReadiness | null;
}

export interface VideoStorylineDirector {
  id: string;
  companyId: string;
  name: string;
  description: string;
  /** "tutorial" / "action" for the starters; null for one a person added. */
  builtinKey: string | null;
  writing: VideoDirectorModelView | null;
  analysis: VideoDirectorModelView | null;
  helper: VideoDirectorModelView | null;
  temperature: number | null;
  thinking: VideoDirectorThinking | null;
  styleInstructions: string;
  defaultVideoProviderId: VideoStorylineProvider | null;
  defaultVideoModel: string | null;
  defaultLookId: string | null;
  defaultShotSeconds: number | null;
  /** How the writer will run with this director, in one plain line. */
  writerMode: "tools" | "text_with_helper" | "text_only" | "no_model";
  writerModeNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface VideoStorylineDirectorsView {
  directors: VideoStorylineDirector[];
  /** Owners and admins may add, change and delete directors. */
  canEdit: boolean;
}

// ─── Tool support of a saved model ─────────────────────────────────────────

export interface ToolSupportModelInput {
  provider: string;
  model: string;
  specs?: { tools?: "yes" | "partial" | "no" | null; openrouterHostsSeen?: Array<{ slug: string; tools: boolean }> | null } | null;
  providerRouting?: LaneAProviderRouting | null;
}

/**
 * Whether a saved model can make tool calls where it will run. For OpenRouter
 * the hosts matter: support differs per host, and the company's blocked
 * hosts plus the model's own host choices decide which hosts may run it
 * (the hosts last seen on Settings > Models). Otherwise the model's own
 * "Tools" fact, then Paperclip's list of known models. Unknown counts as
 * "no", so the writer never sends tools to a model that may refuse them.
 */
export function savedModelToolSupport(entry: ToolSupportModelInput, blockedHosts: readonly string[] = []): VideoDirectorToolSupport {
  const provider = normalizeLaneAProvider(entry.provider);
  const known = entry.model.trim() ? findKnownVariant(entry.provider, entry.model) : null;
  const facts = entry.specs?.tools ?? known?.variant.tools ?? null;
  if (provider === "openrouter") {
    const seen = entry.specs?.openrouterHostsSeen ?? null;
    if (seen && seen.length > 0) {
      const routing = withOpenRouterBlockedHostsForCall(entry.providerRouting ?? null, blockedHosts);
      const allowed = openRouterHostsAllowed(routing, seen.map((h) => ({ slug: h.slug, supportsTools: h.tools })));
      if (allowed.length === 0) {
        return { canUseTools: false, source: "hosts", reason: "Your host rules leave no OpenRouter host to run this model." };
      }
      if (allowed.some((h) => h.supportsTools)) {
        return { canUseTools: true, source: "hosts", reason: "At least one allowed OpenRouter host can use tools with this model." };
      }
      return { canUseTools: false, source: "hosts", reason: "None of the OpenRouter hosts allowed to run this model can use tools." };
    }
  }
  if (facts === "no") return { canUseTools: false, source: "known", reason: "This model can't use tools." };
  if (facts === "yes" || facts === "partial") {
    return { canUseTools: true, source: "known", reason: facts === "yes" ? "This model can use tools." : "This model can use tools, though not always reliably." };
  }
  if (provider === "anthropic" || provider === "openai" || provider === "google") {
    return { canUseTools: true, source: "known", reason: "This model can use tools." };
  }
  return { canUseTools: false, source: "unknown", reason: "Paperclip does not know whether this model can use tools, so it is treated as one that can't." };
}

// ─── Story writer: requests ────────────────────────────────────────────────

export const writeVideoStorylineSchema = z
  .object({
    /** Which director writes; null/absent = the storyline's own director. */
    directorId: z.string().uuid().nullable().optional(),
    ideas: z.string().trim().min(1, "Write a few ideas or pointers first.").max(VIDEO_WRITER_IDEAS_MAX_LENGTH),
    /** About how long the film should be, in seconds (optional). */
    targetSeconds: z.number().int().min(VIDEO_WRITER_MIN_TARGET_SECONDS).max(VIDEO_WRITER_MAX_TARGET_SECONDS).nullable().optional().default(null),
    /** The storyline's own uploaded photos to show the analysis model. */
    referenceUploadIds: z.array(z.string().uuid()).max(VIDEO_WRITER_MAX_REFERENCE_PICTURES).optional().default([]),
    /** Show the analysis model the pictures of cast members linked to saved people. */
    useCastPictures: z.boolean().optional().default(true),
    /** Write straight away, without follow-up questions. */
    skipQuestions: z.boolean().optional().default(false),
  })
  .strict();
export type WriteVideoStorylineInput = z.infer<typeof writeVideoStorylineSchema>;

export const answerVideoStorylineWriterSchema = z
  .object({
    answers: z
      .array(z.object({ questionId: z.string().min(1).max(100), answer: z.string().trim().max(VIDEO_WRITER_ANSWER_MAX_LENGTH) }).strict())
      .max(VIDEO_WRITER_MAX_QUESTIONS)
      .optional()
      .default([]),
    /** "Just write it": no more questions. */
    skipQuestions: z.boolean().optional().default(false),
  })
  .strict();
export type AnswerVideoStorylineWriterInput = z.infer<typeof answerVideoStorylineWriterSchema>;

export const improveVideoStorylineSchema = z
  .object({ request: z.string().trim().min(1, "Write what you would like changed.").max(VIDEO_WRITER_REQUEST_MAX_LENGTH) })
  .strict();
export type ImproveVideoStorylineInput = z.infer<typeof improveVideoStorylineSchema>;

export const acceptVideoStorylineChangesSchema = z
  .object({
    /** The changes to apply; absent = all of them. The rest are rejected. */
    changeIds: z.array(z.string().min(1).max(20)).max(VIDEO_WRITER_MAX_CHANGES).optional(),
  })
  .strict();
export type AcceptVideoStorylineChangesInput = z.infer<typeof acceptVideoStorylineChangesSchema>;

export const estimateVideoStorylineWriterSchema = z
  .object({
    directorId: z.string().uuid().nullable().optional(),
    kind: z.enum(["write", "improve"]).optional().default("write"),
    ideas: z.string().max(VIDEO_WRITER_IDEAS_MAX_LENGTH).optional().default(""),
    targetSeconds: z.number().int().min(VIDEO_WRITER_MIN_TARGET_SECONDS).max(VIDEO_WRITER_MAX_TARGET_SECONDS).nullable().optional().default(null),
    pictureCount: z.number().int().min(0).max(VIDEO_WRITER_MAX_REFERENCE_PICTURES * 4).optional().default(0),
  })
  .strict();
export type EstimateVideoStorylineWriterInput = z.infer<typeof estimateVideoStorylineWriterSchema>;

// ─── Story writer: the conversation ────────────────────────────────────────

export const VIDEO_WRITER_MESSAGE_ROLES = ["writer", "person", "system"] as const;
export type VideoWriterMessageRole = (typeof VIDEO_WRITER_MESSAGE_ROLES)[number];
export const VIDEO_WRITER_MESSAGE_KINDS = ["brief", "analysis", "question", "answer", "storyboard", "change_request", "change_set", "note"] as const;
export type VideoWriterMessageKind = (typeof VIDEO_WRITER_MESSAGE_KINDS)[number];
export const VIDEO_WRITER_CHANGE_SET_STATUSES = ["pending", "applied", "partly_applied", "discarded"] as const;
export type VideoWriterChangeSetStatus = (typeof VIDEO_WRITER_CHANGE_SET_STATUSES)[number];

export interface VideoWriterQuestion {
  id: string;
  question: string;
  options: string[];
}

export interface VideoWriterShotFields {
  prompt: string;
  cameraNotes: string | null;
  durationSeconds: number;
  transitionIn: VideoShotTransition | null;
  /** Names of cast members in the shot (empty = found from the description). */
  cast: string[];
}

export interface VideoWriterChange {
  id: string;
  op: "update" | "add" | "remove";
  /** The shot changed or removed (update/remove). */
  shotId: string | null;
  /** Its number when the change was written, for people ("Shot 3"). */
  shotNumber: number | null;
  /** add: goes right after this shot (null = at the very start). */
  afterShotId: string | null;
  before: VideoWriterShotFields | null;
  after: VideoWriterShotFields | null;
  status: "pending" | "accepted" | "rejected";
}

export interface VideoWriterBriefPayload {
  ideas: string;
  targetSeconds: number | null;
  referenceUploadIds: string[];
  useCastPictures: boolean;
}

export interface VideoWriterAnalysisPayload {
  text: string;
  pictureCount: number;
  /** Pictures that were not sent, with the plain reason. */
  skipped: string[];
  modelLabel: string | null;
}

export interface VideoWriterQuestionPayload {
  round: number;
  questions: VideoWriterQuestion[];
}

export interface VideoWriterAnswerPayload {
  answers: Array<{ questionId: string; question: string; answer: string }>;
  skipQuestions: boolean;
}

export interface VideoWriterStoryboardPayload {
  note: string;
  sceneCount: number;
  shotCount: number;
  totalSeconds: number;
  estimatedCostCents: number;
  music: string | null;
  voice: string | null;
  /** Director defaults that were put on the storyline (plain lines). */
  appliedDefaults: string[];
}

export interface VideoWriterChangeSetPayload {
  note: string;
  changes: VideoWriterChange[];
  music: string | null;
  voice: string | null;
  /** Set when the whole storyboard is to be replaced (a rewrite of a storyline that already had shots). */
  replaceAll: { script: unknown; shotCast: string[][]; sceneCount: number; shotCount: number; totalSeconds: number } | null;
  secondsBefore: number;
  secondsAfter: number;
}

export interface VideoWriterNotePayload {
  text: string;
  /** How the writer ran: e.g. "Text-only writer, helper did the lookups". */
  mode?: string | null;
  costCents?: number | null;
  error?: boolean;
}

export type VideoWriterMessagePayload =
  | VideoWriterBriefPayload
  | VideoWriterAnalysisPayload
  | VideoWriterQuestionPayload
  | VideoWriterAnswerPayload
  | VideoWriterStoryboardPayload
  | VideoWriterChangeSetPayload
  | VideoWriterNotePayload
  | { request: string };

export interface VideoWriterMessage {
  id: string;
  role: VideoWriterMessageRole;
  kind: VideoWriterMessageKind;
  status: VideoWriterChangeSetStatus | null;
  directorId: string | null;
  payload: VideoWriterMessagePayload;
  createdAt: string;
}

export interface VideoWriterReferenceOption {
  id: string;
  label: string;
  kind: "upload" | "cast";
  /** Why it cannot be sent right now (missing consent ticks, no linked person, ...), else null. */
  blockedReason: string | null;
}

export interface VideoWriterSession {
  storylineId: string;
  directorId: string | null;
  /** idle = nothing open; asking = questions wait for answers; reviewing = a list of changes waits. */
  state: "idle" | "asking" | "reviewing";
  messages: VideoWriterMessage[];
  openQuestions: { messageId: string; questions: VideoWriterQuestion[] } | null;
  pendingChangeSetId: string | null;
  referenceOptions: VideoWriterReferenceOption[];
}

export interface VideoWriterEstimate {
  /** Rough cost of the AI writing (not the video), in cents. */
  writingCents: number;
  /** Rough cost of the video at the target length, in cents (null without a length). */
  videoCents: number | null;
  /** One plain sentence. */
  summary: string;
  /** Set when the company's spending limit would stop the writer. */
  blockedReason: string | null;
}

// ─── The writer's answer (text-only mode and the final tool calls) ─────────

export interface VideoWriterStoryboardReply {
  type: "storyboard";
  note: string;
  script: ParsedVideoStorylineScript;
  /** One entry per shot, in storyboard order: the cast names the writer put in it. */
  shotCast: string[][];
  music: string | null;
  voice: string | null;
  /** The script as the import takes it (extras removed). */
  rawScript: Record<string, unknown>;
}

export interface VideoWriterQuestionsReply {
  type: "questions";
  questions: Array<{ question: string; options: string[] }>;
}

export interface VideoWriterChangeEntry {
  op: "update" | "add" | "remove";
  /** update/remove: the shot's number (1 = first); add: the shot it goes after (0 = at the start). */
  shot: number;
  prompt: string | null;
  cameraNotes: string | null | undefined;
  durationSeconds: number | null;
  transitionIn: VideoShotTransition | null | undefined;
  cast: string[] | null;
}

export interface VideoWriterChangesReply {
  type: "changes";
  note: string;
  changes: VideoWriterChangeEntry[];
  music: string | null;
  voice: string | null;
}

export type VideoWriterReply = VideoWriterStoryboardReply | VideoWriterQuestionsReply | VideoWriterChangesReply;
export type VideoWriterReplyType = VideoWriterReply["type"];

export type VideoWriterParseResult = { ok: true; reply: VideoWriterReply } | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one JSON object in a model's text: the whole reply, inside one ```json
 * fence, or the outermost {...} in the text. Null when there is none.
 */
export function extractVideoWriterJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(trimmed);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return null;
}

function cleanText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function cleanNames(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  return Array.from(new Set(value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim().slice(0, 60)))).slice(0, 20);
}

function parseQuestions(raw: Record<string, unknown>, errors: string[]): VideoWriterQuestionsReply | null {
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    errors.push('"questions" must be a list with 1 to 3 questions.');
    return null;
  }
  const questions: VideoWriterQuestionsReply["questions"] = [];
  raw.questions.slice(0, VIDEO_WRITER_MAX_QUESTIONS).forEach((entry, index) => {
    const q = isRecord(entry) ? entry : typeof entry === "string" ? { question: entry } : null;
    const text = q ? cleanText(q.question ?? q.prompt, 500) : null;
    if (!text) {
      errors.push(`Question ${index + 1} has no "question" text.`);
      return;
    }
    const options = Array.isArray(q!.options)
      ? q!.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0).map((o) => o.trim().slice(0, 200)).slice(0, VIDEO_WRITER_MAX_QUESTION_OPTIONS)
      : [];
    questions.push({ question: text, options });
  });
  return errors.length > 0 ? null : { type: "questions", questions };
}

function parseStoryboard(raw: Record<string, unknown>, errors: string[]): VideoWriterStoryboardReply | null {
  const board = isRecord(raw.storyboard) ? raw.storyboard : isRecord(raw.script) ? raw.script : null;
  if (!board) {
    errors.push('"storyboard" must be an object with "scenes".');
    return null;
  }
  // The extras the import does not take (music, voice, a shot's cast) are
  // taken off here; everything else goes through the import's own checks.
  const shotCast: string[][] = [];
  const rawScript: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(board)) {
    if (key === "music" || key === "voice") continue;
    rawScript[key] = value;
  }
  if (Array.isArray(board.scenes)) {
    rawScript.scenes = board.scenes.map((scene) => {
      if (!isRecord(scene) || !Array.isArray(scene.shots)) return scene;
      return {
        ...scene,
        shots: scene.shots.map((shot) => {
          if (!isRecord(shot)) return shot;
          const { cast, ...rest } = shot;
          shotCast.push(cleanNames(cast) ?? []);
          return rest;
        }),
      };
    });
  }
  const checked = validateVideoStorylineScript(rawScript);
  if (!checked.ok) {
    errors.push(...checked.errors);
    return null;
  }
  return {
    type: "storyboard",
    note: cleanText(raw.note, 1_000) ?? "",
    script: checked.script,
    shotCast,
    music: cleanText(board.music ?? raw.music, VIDEO_WRITER_MUSIC_MAX_LENGTH),
    voice: cleanText(board.voice ?? raw.voice, VIDEO_WRITER_MUSIC_MAX_LENGTH),
    rawScript,
  };
}

function parseShotFields(entry: Record<string, unknown>, where: string, errors: string[], requirePrompt: boolean) {
  let prompt: string | null = null;
  if (entry.prompt !== undefined && entry.prompt !== null) {
    if (typeof entry.prompt !== "string" || !entry.prompt.trim()) errors.push(`${where}: "prompt" must be non-empty text.`);
    else if (entry.prompt.trim().length > VIDEO_SCRIPT_PROMPT_MAX_LENGTH) errors.push(`${where}: "prompt" is longer than ${VIDEO_SCRIPT_PROMPT_MAX_LENGTH} characters.`);
    else prompt = entry.prompt.trim();
  } else if (requirePrompt) {
    errors.push(`${where}: "prompt" is missing.`);
  }
  let cameraNotes: string | null | undefined;
  if (entry.camera_notes !== undefined) {
    if (entry.camera_notes === null) cameraNotes = null;
    else if (typeof entry.camera_notes !== "string") errors.push(`${where}: "camera_notes" must be text.`);
    else cameraNotes = entry.camera_notes.trim().slice(0, VIDEO_SCRIPT_CAMERA_NOTES_MAX_LENGTH) || null;
  }
  let durationSeconds: number | null = null;
  if (entry.duration_seconds !== undefined && entry.duration_seconds !== null) {
    const d = entry.duration_seconds;
    if (typeof d !== "number" || !Number.isInteger(d) || d < VIDEO_SHOT_MIN_DURATION_SECONDS || d > VIDEO_SHOT_MAX_DURATION_SECONDS) {
      errors.push(`${where}: "duration_seconds" must be a whole number from ${VIDEO_SHOT_MIN_DURATION_SECONDS} to ${VIDEO_SHOT_MAX_DURATION_SECONDS}.`);
    } else durationSeconds = d;
  }
  let transitionIn: VideoShotTransition | null | undefined;
  if (entry.transition_in !== undefined) {
    if (entry.transition_in === null) transitionIn = null;
    else if (typeof entry.transition_in !== "string" || !(VIDEO_SHOT_TRANSITIONS as readonly string[]).includes(entry.transition_in)) {
      errors.push(`${where}: "transition_in" must be one of ${VIDEO_SHOT_TRANSITIONS.join(", ")}.`);
    } else transitionIn = entry.transition_in as VideoShotTransition;
  }
  return { prompt, cameraNotes, durationSeconds, transitionIn, cast: cleanNames(entry.cast) };
}

function parseChanges(raw: Record<string, unknown>, shotCount: number, errors: string[]): VideoWriterChangesReply | null {
  if (!Array.isArray(raw.changes)) {
    errors.push('"changes" must be a list (it may be empty when nothing needs to change).');
    return null;
  }
  if (raw.changes.length > VIDEO_WRITER_MAX_CHANGES) errors.push(`There are ${raw.changes.length} changes; at most ${VIDEO_WRITER_MAX_CHANGES} are allowed.`);
  const changes: VideoWriterChangeEntry[] = [];
  const touched = new Set<number>();
  raw.changes.slice(0, VIDEO_WRITER_MAX_CHANGES).forEach((entry, index) => {
    const where = `Change ${index + 1}`;
    if (!isRecord(entry)) {
      errors.push(`${where}: must be an object.`);
      return;
    }
    const op = entry.op;
    if (op !== "update" && op !== "add" && op !== "remove") {
      errors.push(`${where}: "op" must be "update", "add" or "remove".`);
      return;
    }
    const shotRaw = op === "add" ? entry.after_shot ?? entry.shot : entry.shot;
    const min = op === "add" ? 0 : 1;
    if (typeof shotRaw !== "number" || !Number.isInteger(shotRaw) || shotRaw < min || shotRaw > shotCount) {
      errors.push(
        op === "add"
          ? `${where}: "after_shot" must be a shot number from 0 (at the start) to ${shotCount}.`
          : `${where}: "shot" must be a shot number from 1 to ${shotCount}.`,
      );
      return;
    }
    if (op !== "add") {
      if (touched.has(shotRaw)) {
        errors.push(`${where}: shot ${shotRaw} is changed more than once; put everything for one shot in one change.`);
        return;
      }
      touched.add(shotRaw);
    }
    if (op === "remove") {
      changes.push({ op, shot: shotRaw, prompt: null, cameraNotes: undefined, durationSeconds: null, transitionIn: undefined, cast: null });
      return;
    }
    const fields = parseShotFields(entry, where, errors, op === "add");
    if (op === "update" && fields.prompt === null && fields.cameraNotes === undefined && fields.durationSeconds === null && fields.transitionIn === undefined && fields.cast === null) {
      errors.push(`${where}: an update must change at least one of prompt, camera_notes, duration_seconds, transition_in or cast.`);
      return;
    }
    changes.push({ op, shot: shotRaw, ...fields });
  });
  if (errors.length > 0) return null;
  return {
    type: "changes",
    note: cleanText(raw.note, 1_000) ?? "",
    changes,
    music: cleanText(raw.music, VIDEO_WRITER_MUSIC_MAX_LENGTH),
    voice: cleanText(raw.voice, VIDEO_WRITER_MUSIC_MAX_LENGTH),
  };
}

/**
 * Checks the writer's answer: one JSON object of an allowed type. Returns the
 * cleaned answer, or plain per-item problems to send back to the model for a
 * fix. `value` is the model's text (text-only mode) or a final tool call's
 * input (already an object).
 */
export function parseVideoWriterReply(
  value: unknown,
  ctx: { allowed: readonly VideoWriterReplyType[]; shotCount: number },
): VideoWriterParseResult {
  const parsed = typeof value === "string" ? extractVideoWriterJson(value) : value;
  if (!isRecord(parsed)) {
    return { ok: false, errors: ["The answer was not one JSON object. Reply with ONLY the JSON object described, nothing before or after it."] };
  }
  let type = parsed.type;
  // A bare storyboard (the import's own shape) is taken as one.
  if (type === undefined && Array.isArray(parsed.scenes)) {
    return parseVideoWriterReply({ type: "storyboard", storyboard: parsed }, ctx);
  }
  if (type === undefined && isRecord(parsed.storyboard)) type = "storyboard";
  if (type === undefined && Array.isArray(parsed.questions)) type = "questions";
  if (type === undefined && Array.isArray(parsed.changes)) type = "changes";
  if (typeof type !== "string" || !(ctx.allowed as readonly string[]).includes(type)) {
    return { ok: false, errors: [`"type" must be ${ctx.allowed.map((t) => `"${t}"`).join(" or ")}.`] };
  }
  const errors: string[] = [];
  const reply =
    type === "questions" ? parseQuestions(parsed, errors) : type === "storyboard" ? parseStoryboard(parsed, errors) : parseChanges(parsed, ctx.shotCount, errors);
  if (!reply) return { ok: false, errors: errors.length > 0 ? errors.slice(0, 30) : ["The answer could not be read."] };
  return { ok: true, reply };
}

/** The JSON contract, as the writer's instructions describe it. */
export function videoWriterContractText(allowed: readonly VideoWriterReplyType[]): string {
  const lines: string[] = ["Reply with ONLY one JSON object, no prose before or after it, in one of these shapes:"];
  if (allowed.includes("questions")) {
    lines.push(
      "",
      "1) When the brief leaves something important open, ask first (1 to 3 short questions, each with up to 4 suggested answers or none):",
      '{"type": "questions", "questions": [{"question": "<short question>", "options": ["<answer>", ...]}]}',
    );
  }
  if (allowed.includes("storyboard")) {
    lines.push(
      "",
      `${allowed.includes("questions") ? "2) " : ""}The whole storyboard:`,
      '{"type": "storyboard", "note": "<one or two plain sentences for the person>", "storyboard": {"title": "<string>", ' +
        '"characters": {"<Name>": "<visual description>"}, "music": "<music idea or null>", "voice": "<voice-over idea or null>", ' +
        '"scenes": [{"scene_title": "<string>", "scene_notes": "<string or null>", "shots": [{"prompt": "<self-contained visual description>", ' +
        `"camera_notes": "<string or null>", "duration_seconds": <whole number ${VIDEO_SHOT_MIN_DURATION_SECONDS}-${VIDEO_SHOT_MAX_DURATION_SECONDS}>, ` +
        `"transition_in": ${VIDEO_SHOT_TRANSITIONS.map((t) => `"${t}"`).join(" | ")} | null, "cast": ["<Name>", ...]}]}]}}`,
    );
  }
  if (allowed.includes("changes")) {
    lines.push(
      "",
      "Changes to the existing shots (shots are numbered 1, 2, 3 ... in playing order, as listed under CURRENT SHOTS):",
      '{"type": "changes", "note": "<one or two plain sentences for the person>", "music": "<new music idea or null>", "voice": "<new voice-over idea or null>", "changes": [',
      '  {"op": "update", "shot": <number>, "prompt": "<new text, or leave out>", "camera_notes": "<or leave out>", "duration_seconds": <or leave out>, "transition_in": "<or leave out>", "cast": ["<Name>"] or leave out},',
      '  {"op": "add", "after_shot": <number, 0 = at the start>, "prompt": "<text>", "camera_notes": "<string or null>", "duration_seconds": <number>, "transition_in": null, "cast": []},',
      '  {"op": "remove", "shot": <number>}',
      "]}",
      "Only list shots that really change. Put everything for one shot in one change.",
    );
  }
  return lines.join("\n");
}
