import { z } from "zod";
import type { VideoStorylineProvider } from "./video-storylines.js";

/**
 * Storyline strip (Simple editor, Phase 1; design 2.1-2.4): how each gap
 * between two shots is joined. Shared by the server routes and (as plain
 * copies, since the plugin UI bundle cannot import this package) the strip UI.
 * These lists MUST stay in sync with packages/db's video_transitions CHECKs.
 */

export const VIDEO_TRANSITION_KINDS = ["cut", "blend", "dissolve", "fade", "ai"] as const;
export type VideoTransitionKind = (typeof VIDEO_TRANSITION_KINDS)[number];

/** What a person sees for each kind. "blend" is a smooth crossfade; dissolve and fade sit under "More…". */
export const VIDEO_TRANSITION_KIND_LABELS: Record<VideoTransitionKind, string> = {
  cut: "Cut",
  blend: "Smooth blend",
  dissolve: "Grainy dissolve",
  fade: "Soft fade",
  ai: "AI bridge",
};

/** ffmpeg xfade name for each ffmpeg-made kind (cut and ai never crossfade). */
export const VIDEO_TRANSITION_XFADE: Partial<Record<VideoTransitionKind, "fade" | "dissolve">> = {
  blend: "fade",
  fade: "fade",
  dissolve: "dissolve",
};

export const VIDEO_TRANSITION_AUDIO_MODES = ["ambient", "silent", "bed_only"] as const;
export type VideoTransitionAudioMode = (typeof VIDEO_TRANSITION_AUDIO_MODES)[number];

export const VIDEO_TRANSITION_TAKE_STATUSES = ["generating", "ready", "failed"] as const;
export type VideoTransitionTakeStatus = (typeof VIDEO_TRANSITION_TAKE_STATUSES)[number];

/** The styles the writer may pick behind "AI bridge" (design 2.3). */
export const VIDEO_TRANSITION_AI_STYLES = [
  "follow_character",
  "camera_move",
  "whip_pan",
  "foreground_wipe",
  "match_cut",
  "time_lapse",
  "bridge_picture",
  "morph",
] as const;
export type VideoTransitionAiStyle = (typeof VIDEO_TRANSITION_AI_STYLES)[number];

/** Crossfade lengths ffmpeg makes (video-ffmpeg.ts clamps to the same range). */
export const VIDEO_BLEND_MIN_MS = 100;
export const VIDEO_BLEND_MAX_MS = 5_000;
export const VIDEO_BLEND_DEFAULT_MS = 500;

/**
 * The AI models a transition can be made with, and their real limits
 * (design 2.4, 9 Oct snapshot). Prices are per second of clip and are a
 * ballpark shown before anything is made, not a quote.
 */
export interface VideoTransitionModelOption {
  provider: VideoStorylineProvider;
  model: string;
  label: string;
  minSeconds: number;
  maxSeconds: number;
  /** US cents per second with no AI sound. */
  centsPerSecond: number;
  /** US cents per second with the model's own sound (null = it makes none). */
  soundCentsPerSecond: number | null;
  /** Whether sound is made at no extra cost (Sogni). */
  soundIsFree: boolean;
  note: string;
}

export const VIDEO_TRANSITION_MODELS: readonly VideoTransitionModelOption[] = [
  {
    provider: "sogni",
    model: "ltx25-22b-int8_i2v_distilled",
    label: "Sogni LTX-2.5 (start and end picture)",
    minSeconds: 1,
    maxSeconds: 21,
    centsPerSecond: 2,
    soundCentsPerSecond: 2,
    soundIsFree: true,
    note: "About $0.10 for 5 seconds. Makes quiet background sound at no extra cost.",
  },
  {
    provider: "fal",
    model: "fal-ai/kling-video/v3/standard/image-to-video",
    label: "Kling 3.0 Standard on Fal (start and end picture)",
    minSeconds: 3,
    maxSeconds: 15,
    centsPerSecond: 8.4,
    soundCentsPerSecond: 12.6,
    soundIsFree: false,
    note: "About $0.34 for 4 seconds. AI sound would cost 50% more, so it stays off; the music plays under it.",
  },
];

/** The default transition model for a storyline's video service (decision 2). */
export function defaultVideoTransitionModel(provider: VideoStorylineProvider): VideoTransitionModelOption {
  return VIDEO_TRANSITION_MODELS.find((m) => m.provider === provider) ?? VIDEO_TRANSITION_MODELS[0]!;
}

/** A known transition model for this service, or null. */
export function findVideoTransitionModel(provider: VideoStorylineProvider, model: string | null | undefined): VideoTransitionModelOption | null {
  if (!model) return defaultVideoTransitionModel(provider);
  return VIDEO_TRANSITION_MODELS.find((m) => m.provider === provider && m.model === model) ?? null;
}

/** A length the model really makes: whole seconds within its limits. */
export function snapTransitionSeconds(option: Pick<VideoTransitionModelOption, "minSeconds" | "maxSeconds">, seconds: number): number {
  const whole = Number.isFinite(seconds) ? Math.round(seconds) : option.minSeconds;
  return Math.min(option.maxSeconds, Math.max(option.minSeconds, whole));
}

/** Ballpark cost in cents (rounded up) for one take. */
export function estimateVideoTransitionCents(option: VideoTransitionModelOption, seconds: number, withSound: boolean): number {
  const perSecond = withSound && option.soundCentsPerSecond !== null ? option.soundCentsPerSecond : option.centsPerSecond;
  return Math.ceil(snapTransitionSeconds(option, seconds) * perSecond);
}

/** Whether a take of this model carries sound into the film: Sogni's free ambient sound, never paid Kling sound. */
export function videoTransitionAudioModeFor(option: VideoTransitionModelOption): VideoTransitionAudioMode {
  return option.soundIsFree ? "ambient" : "bed_only";
}

// ─── Company monthly media cap (design 2.11) ─────────────────────────────

/** Key inside plugin_company_settings.settings_json (Media Studio's row). */
export const MEDIA_MONTHLY_CAP_SETTINGS_KEY = "mediaMonthlyCapCents";
/** $20 a month unless an owner or admin sets another amount. */
export const MEDIA_MONTHLY_CAP_DEFAULT_CENTS = 2_000;
export const MEDIA_MONTHLY_CAP_EXPLANATION =
  "The most this company may spend on AI transitions in one calendar month, across all storylines. Each transition reserves its cost before it is made; a failed one gives it back. Shot renders keep their own per-film budget.";

export const updateMediaMonthlyCapSchema = z.object({ capCents: z.number().int().min(0).max(10_000_000) }).strict();

// ─── Requests ────────────────────────────────────────────────────────────

const keepSameSchema = z.object({ face: z.boolean(), clothes: z.boolean(), location: z.boolean() }).strict();

export const upsertVideoTransitionSchema = z
  .object({
    fromShotId: z.string().uuid(),
    toShotId: z.string().uuid(),
    kind: z.enum(VIDEO_TRANSITION_KINDS).optional(),
    durationMs: z.number().int().min(0).max(30_000).optional(),
    plainLine: z.string().trim().max(1_000).nullable().optional(),
    prompt: z.string().trim().max(4_000).nullable().optional(),
    note: z.string().trim().max(1_000).nullable().optional(),
    keepSame: keepSameSchema.optional(),
    audioMode: z.enum(VIDEO_TRANSITION_AUDIO_MODES).optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    locked: z.boolean().optional(),
  })
  .strict();
export type UpsertVideoTransitionInput = z.infer<typeof upsertVideoTransitionSchema>;

export const suggestVideoTransitionSchema = z
  .object({
    fromShotId: z.string().uuid(),
    toShotId: z.string().uuid(),
    /** The person's edited sentence: the AI rewrites the prompt from it. */
    plainLine: z.string().trim().max(1_000).nullable().optional(),
    note: z.string().trim().max(1_000).nullable().optional(),
  })
  .strict();
export type SuggestVideoTransitionInput = z.infer<typeof suggestVideoTransitionSchema>;

export const generateVideoTransitionSchema = z
  .object({
    /** "Try another" with a note: added to the prompt for this take only. */
    note: z.string().trim().max(1_000).nullable().optional(),
    /** The cost the person saw; the server refuses if its own estimate is higher. */
    confirmCostCents: z.number().int().min(0).optional(),
  })
  .strict();
export type GenerateVideoTransitionInput = z.infer<typeof generateVideoTransitionSchema>;

// ─── Responses ───────────────────────────────────────────────────────────

export type VideoTransitionState = "default" | "suggested" | "generating" | "ready" | "failed" | "out_of_date" | "needs_making";

export interface VideoTransitionTakeSummary {
  id: string;
  status: VideoTransitionTakeStatus;
  provider: string;
  model: string;
  durationMs: number;
  costCents: number | null;
  reservedCents: number;
  note: string | null;
  error: string | null;
  /** The take was made for the shots as they are now. */
  current: boolean;
  createdAt: string;
}

export interface VideoTransitionSummary {
  id: string | null;
  fromShotId: string;
  toShotId: string;
  kind: VideoTransitionKind;
  aiStyle: string | null;
  durationMs: number;
  plainLine: string | null;
  prompt: string | null;
  userNote: string | null;
  suggestedKind: VideoTransitionKind | null;
  suggestReason: string | null;
  keepSame: { face: boolean; clothes: boolean; location: boolean };
  audioMode: VideoTransitionAudioMode;
  model: string | null;
  locked: boolean;
  chosenTakeId: string | null;
  state: VideoTransitionState;
  /** The suggestion was written for the shots as they were then, not as they are now. */
  suggestionOutdated: boolean;
  /** Set when the suggestion was written from the script only, in plain words. */
  textOnlyReason: string | null;
  takes: VideoTransitionTakeSummary[];
}

export interface VideoStripClip {
  shotId: string;
  orderIndex: number;
  sceneId: string;
  prompt: string;
  cameraNotes: string | null;
  durationSeconds: number;
  status: string;
  storyboardStatus: string;
  hasClip: boolean;
  hasPoster: boolean;
}

export interface VideoStripSummary {
  storylineId: string;
  providerId: VideoStorylineProvider;
  status: string;
  clips: VideoStripClip[];
  gaps: VideoTransitionSummary[];
  models: VideoTransitionModelOption[];
  defaultModel: string;
  budget: { capCents: number | null; spentCents: number };
  monthly: { capCents: number; spentCents: number; explanation: string };
  /** Plain sentence when the company has no writer model (else null). */
  writerProblem: string | null;
  /** The picture-reading model's name, or null with readerProblem saying why. */
  readerLabel: string | null;
  readerProblem: string | null;
  /** Stale AI transitions block combining; this lists them in plain words. */
  combineProblems: string[];
  canCombineAgain: boolean;
}
