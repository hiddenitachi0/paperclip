import { z } from "zod";

/**
 * DUR-4127 (backend half of DUR-4095, video storylines): types, limits and
 * validators shared between server routes and (eventually) the UI. See
 * packages/db/src/schema/video_storylines.ts for the table doc comments --
 * these enum lists MUST stay byte-for-byte in sync with that file's CHECK
 * constraints, since nothing enforces the two automatically.
 */

export const VIDEO_STORYLINE_STATUSES = [
  "draft",
  "estimated",
  "rendering",
  "paused",
  "ready_to_stitch",
  "stitching",
  "done",
  "failed",
  "cancelled",
] as const;
export type VideoStorylineStatus = (typeof VIDEO_STORYLINE_STATUSES)[number];

export const VIDEO_SHOT_STATUSES = ["draft", "queued", "rendering", "done", "failed"] as const;
export type VideoShotStatus = (typeof VIDEO_SHOT_STATUSES)[number];

export const VIDEO_RENDER_JOB_STATUSES = ["running", "done", "failed"] as const;
export type VideoRenderJobStatus = (typeof VIDEO_RENDER_JOB_STATUSES)[number];

/** Must stay a subset of media-studio's supported video providers (packages/plugins/media-studio/src/video.ts). */
export const VIDEO_STORYLINE_PROVIDERS = ["fal", "sogni"] as const;
export type VideoStorylineProvider = (typeof VIDEO_STORYLINE_PROVIDERS)[number];

/** "cut" (no transition, the round-1 default) vs. ffmpeg's own xfade transition names -- see video-ffmpeg.ts's XFADE_TRANSITIONS, which MUST stay a subset of these two. */
export const VIDEO_SHOT_TRANSITIONS = ["cut", "fade", "dissolve"] as const;
export type VideoShotTransition = (typeof VIDEO_SHOT_TRANSITIONS)[number];

export const VIDEO_DIRECTOR_RUN_STATUSES = ["drafting", "ready_for_review", "approved", "rejected", "failed"] as const;
export type VideoDirectorRunStatus = (typeof VIDEO_DIRECTOR_RUN_STATUSES)[number];

// ─── Limits ──────────────────────────────────────────────────────────────

/** A little above the ~1400-clip ceiling the ticket names, so a storyline at that scale is never blocked by an arbitrary-feeling off-by-one. */
export const VIDEO_STORYLINE_MAX_SHOTS = 1500;
export const VIDEO_STORYLINE_MAX_SCENES = 500;
export const VIDEO_SHOT_MIN_DURATION_SECONDS = 1;
export const VIDEO_SHOT_MAX_DURATION_SECONDS = 60;
export const VIDEO_SHOT_DEFAULT_DURATION_SECONDS = 5;
/** How many shots' worth of reference/character pictures a storyline may carry. */
export const VIDEO_STORYLINE_MAX_CHARACTER_REFERENCES = 20;
export const VIDEO_SHOT_MAX_LOOK_REFERENCES = 8;
/** How many running render jobs one scheduler tick advances -- see video-storyline-render.ts. */
export const VIDEO_RENDER_TICK_BATCH = 25;
/** A render job stuck "running" past this long is treated as failed and retried on the next manual re-render, mirroring MEDIA_JOB_MAX_AGE_MS in media-jobs.ts. */
export const VIDEO_RENDER_JOB_MAX_AGE_MS = 30 * 60 * 1000;

// ─── Transitions and music (DUR-4196 round 2) ───────────────────────────

export const VIDEO_TRANSITION_MIN_DURATION_MS = 0;
export const VIDEO_TRANSITION_MAX_DURATION_MS = 5_000;
export const VIDEO_TRANSITION_DEFAULT_DURATION_MS = 500;
export const VIDEO_MUSIC_MIN_VOLUME_DB = -60;
export const VIDEO_MUSIC_MAX_VOLUME_DB = 0;
export const VIDEO_MUSIC_DEFAULT_VOLUME_DB = -18;

// ─── Director AI (DUR-4196 round 2) ──────────────────────────────────────

export const VIDEO_DIRECTOR_IDEA_MAX_LENGTH = 4_000;
export const VIDEO_DIRECTOR_MIN_SHOT_COUNT = 1;
export const VIDEO_DIRECTOR_MAX_SHOT_COUNT = 10;
export const VIDEO_DIRECTOR_DEFAULT_SHOT_COUNT = 3;
/** How many of the storyline's most-recent shots the director AI is shown for continuity -- the ticket's "track the last ~10 shots" rule. */
export const VIDEO_DIRECTOR_CONTEXT_SHOT_COUNT = 10;

// ─── Feature flag (ships default off) ───────────────────────────────────

export const MEDIA_STUDIO_PLUGIN_KEY = "paperclip.media-studio";
/** Key inside plugin_company_settings.settings_json for this company's media-studio row. Absent or false = off (the required default). */
export const VIDEO_STORYLINES_SETTINGS_KEY = "videoStorylinesEnabled";
/**
 * DUR-4196 round 2: director AI, still-frame preview and transitions/music all
 * ship behind this second, narrower flag -- on top of (never instead of)
 * VIDEO_STORYLINES_SETTINGS_KEY. A company that already has video storylines
 * on keeps the exact round-1 behavior until it separately opts into round 2,
 * per the ticket's "ships off, doesn't change existing experience" rule.
 */
export const VIDEO_STORYLINE_ADVANCED_SETTINGS_KEY = "videoStorylineAdvancedFeaturesEnabled";

// ─── Cost estimate (placeholder pricing -- see "Questions for Filip") ───

/**
 * Ballpark cents-per-second-of-output used only to show an approximate
 * estimate before a render starts and to gate the budget cap. These are
 * NOT pulled from Fal/Sogni's real billing -- nothing in this codebase
 * exposes that. Treat POST .../estimate's numbers as directional, not a
 * quote, until real pricing is wired in.
 */
export const VIDEO_PROVIDER_COST_CENTS_PER_SECOND: Record<VideoStorylineProvider, number> = {
  fal: 50,
  sogni: 40,
};

export interface VideoCostEstimateShotInput {
  durationSeconds: number;
}

export interface VideoCostEstimateResult {
  shotCount: number;
  totalSeconds: number;
  estimatedTotalCents: number;
  costPerSecondCents: number;
}

/** Pure so it can be unit tested and reused by both the estimate route and the budget gate at render time. */
export function estimateVideoStorylineCostCents(
  shots: readonly VideoCostEstimateShotInput[],
  providerId: VideoStorylineProvider,
): VideoCostEstimateResult {
  const costPerSecondCents = VIDEO_PROVIDER_COST_CENTS_PER_SECOND[providerId];
  const totalSeconds = shots.reduce((sum, shot) => sum + Math.max(0, shot.durationSeconds), 0);
  return {
    shotCount: shots.length,
    totalSeconds,
    estimatedTotalCents: Math.ceil(totalSeconds * costPerSecondCents),
    costPerSecondCents,
  };
}

// ─── Validators ──────────────────────────────────────────────────────────

const assetIdArray = (max: number) => z.array(z.string().uuid()).max(max);

const storylineFields = {
  title: z.string().trim().min(1, "Give the storyline a title.").max(200),
  projectId: z.string().uuid().nullable(),
  providerId: z.enum(VIDEO_STORYLINE_PROVIDERS),
  model: z.string().trim().min(1).max(200).nullable(),
  budgetCapCents: z.number().int().min(0).nullable(),
  characterReferenceAssetIds: assetIdArray(VIDEO_STORYLINE_MAX_CHARACTER_REFERENCES),
  defaultTransition: z.enum(VIDEO_SHOT_TRANSITIONS),
  defaultTransitionDurationMs: z.number().int().min(VIDEO_TRANSITION_MIN_DURATION_MS).max(VIDEO_TRANSITION_MAX_DURATION_MS),
  /** A user-uploaded music bed (an assets.id) -- mutually exclusive with musicSourceKey; the service layer refuses both set. */
  musicAssetId: z.string().uuid().nullable(),
  /** A licensed/stock track id from the source picker, opaque to this schema -- the service layer resolves it. */
  musicSourceKey: z.string().trim().min(1).max(200).nullable(),
  musicVolumeDb: z.number().int().min(VIDEO_MUSIC_MIN_VOLUME_DB).max(VIDEO_MUSIC_MAX_VOLUME_DB),
};

export const createVideoStorylineSchema = z
  .object({
    title: storylineFields.title,
    projectId: storylineFields.projectId.optional().default(null),
    providerId: storylineFields.providerId.optional().default("fal"),
    model: storylineFields.model.optional().default(null),
    budgetCapCents: storylineFields.budgetCapCents.optional().default(null),
    characterReferenceAssetIds: storylineFields.characterReferenceAssetIds.optional().default([]),
    defaultTransition: storylineFields.defaultTransition.optional().default("cut"),
    defaultTransitionDurationMs: storylineFields.defaultTransitionDurationMs.optional().default(VIDEO_TRANSITION_DEFAULT_DURATION_MS),
    musicAssetId: storylineFields.musicAssetId.optional().default(null),
    musicSourceKey: storylineFields.musicSourceKey.optional().default(null),
    musicVolumeDb: storylineFields.musicVolumeDb.optional().default(VIDEO_MUSIC_DEFAULT_VOLUME_DB),
  })
  .strict()
  .refine((value) => !(value.musicAssetId && value.musicSourceKey), {
    message: "Pick either an uploaded music file or a licensed track, not both.",
  });
export type CreateVideoStorylineInput = z.infer<typeof createVideoStorylineSchema>;

export const updateVideoStorylineSchema = z
  .object({
    title: storylineFields.title,
    projectId: storylineFields.projectId,
    budgetCapCents: storylineFields.budgetCapCents,
    characterReferenceAssetIds: storylineFields.characterReferenceAssetIds,
    defaultTransition: storylineFields.defaultTransition,
    defaultTransitionDurationMs: storylineFields.defaultTransitionDurationMs,
    musicAssetId: storylineFields.musicAssetId,
    musicSourceKey: storylineFields.musicSourceKey,
    musicVolumeDb: storylineFields.musicVolumeDb,
  })
  .partial()
  .strict()
  .refine((value) => !(value.musicAssetId && value.musicSourceKey), {
    message: "Pick either an uploaded music file or a licensed track, not both.",
  });
export type UpdateVideoStorylineInput = z.infer<typeof updateVideoStorylineSchema>;

const sceneFields = {
  title: z.string().trim().max(200).default(""),
  notes: z.string().trim().max(4000).nullable(),
  orderIndex: z.number().int().min(0),
};

export const createVideoSceneSchema = z
  .object({
    title: sceneFields.title.optional(),
    notes: sceneFields.notes.optional().default(null),
    orderIndex: sceneFields.orderIndex,
  })
  .strict();
export type CreateVideoSceneInput = z.infer<typeof createVideoSceneSchema>;

export const updateVideoSceneSchema = z
  .object({
    title: sceneFields.title,
    notes: sceneFields.notes,
    orderIndex: sceneFields.orderIndex,
  })
  .partial()
  .strict();
export type UpdateVideoSceneInput = z.infer<typeof updateVideoSceneSchema>;

const shotFields = {
  sceneId: z.string().uuid(),
  orderIndex: z.number().int().min(0),
  prompt: z.string().trim().min(1, "Describe what happens in this shot.").max(4000),
  cameraNotes: z.string().trim().max(2000).nullable(),
  durationSeconds: z
    .number()
    .int()
    .min(VIDEO_SHOT_MIN_DURATION_SECONDS)
    .max(VIDEO_SHOT_MAX_DURATION_SECONDS),
  lookReferenceAssetIds: assetIdArray(VIDEO_SHOT_MAX_LOOK_REFERENCES),
  /** null = inherit the storyline's defaultTransition; set to override just this shot's incoming transition. */
  transitionIn: z.enum(VIDEO_SHOT_TRANSITIONS).nullable(),
};

export const createVideoShotSchema = z
  .object({
    sceneId: shotFields.sceneId,
    orderIndex: shotFields.orderIndex,
    prompt: shotFields.prompt,
    cameraNotes: shotFields.cameraNotes.optional().default(null),
    durationSeconds: shotFields.durationSeconds.optional().default(VIDEO_SHOT_DEFAULT_DURATION_SECONDS),
    lookReferenceAssetIds: shotFields.lookReferenceAssetIds.optional().default([]),
    transitionIn: shotFields.transitionIn.optional().default(null),
  })
  .strict();
export type CreateVideoShotInput = z.infer<typeof createVideoShotSchema>;

export const updateVideoShotSchema = z
  .object({
    sceneId: shotFields.sceneId,
    orderIndex: shotFields.orderIndex,
    prompt: shotFields.prompt,
    cameraNotes: shotFields.cameraNotes,
    durationSeconds: shotFields.durationSeconds,
    lookReferenceAssetIds: shotFields.lookReferenceAssetIds,
    transitionIn: shotFields.transitionIn,
  })
  .partial()
  .strict();
export type UpdateVideoShotInput = z.infer<typeof updateVideoShotSchema>;

export const startVideoStorylineRenderSchema = z
  .object({
    /** Required only when the caller wants to raise/confirm a new cap in the same call (e.g. resuming a paused-on-budget storyline); omit to render against the existing budgetCapCents. */
    confirmBudgetCapCents: z.number().int().min(0).optional(),
  })
  .strict();
export type StartVideoStorylineRenderInput = z.infer<typeof startVideoStorylineRenderSchema>;

export const updateVideoStorylineSettingsSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
export type UpdateVideoStorylineSettingsInput = z.infer<typeof updateVideoStorylineSettingsSchema>;

// ─── Progress shape (GET .../progress) ──────────────────────────────────

export interface VideoStorylineShotProgress {
  id: string;
  orderIndex: number;
  status: VideoShotStatus;
  attempt: number;
  errorMessage: string | null;
}

export interface VideoStorylineProgress {
  storylineId: string;
  status: VideoStorylineStatus;
  totalShots: number;
  doneShots: number;
  failedShots: number;
  renderingShots: number;
  spentCents: number;
  budgetCapCents: number | null;
  stitchBlockedReason: string | null;
  shots: VideoStorylineShotProgress[];
}

// ─── Director AI (DUR-4196 round 2) ──────────────────────────────────────

export const draftVideoDirectorShotsSchema = z
  .object({
    sceneId: z.string().uuid(),
    idea: z.string().trim().min(1, "Describe what should happen next.").max(VIDEO_DIRECTOR_IDEA_MAX_LENGTH),
    shotCount: z.number().int().min(VIDEO_DIRECTOR_MIN_SHOT_COUNT).max(VIDEO_DIRECTOR_MAX_SHOT_COUNT).optional().default(VIDEO_DIRECTOR_DEFAULT_SHOT_COUNT),
  })
  .strict();
export type DraftVideoDirectorShotsInput = z.infer<typeof draftVideoDirectorShotsSchema>;

export const approveVideoDirectorRunSchema = z
  .object({
    /** Indexes into the run's draftedShots array; omit to approve every drafted shot. */
    selectedIndexes: z.array(z.number().int().min(0)).optional(),
  })
  .strict();
export type ApproveVideoDirectorRunInput = z.infer<typeof approveVideoDirectorRunSchema>;

export interface VideoDirectorDraftedShot {
  prompt: string;
  cameraNotes: string | null;
  durationSeconds: number;
  /** Freeform character/object names the AI believes are in view, for the operator's own continuity sense-check -- not written to any shot row. */
  castInView: string[];
}

export interface VideoDirectorRunSummary {
  id: string;
  storylineId: string;
  sceneId: string;
  idea: string;
  status: VideoDirectorRunStatus;
  draftedShots: VideoDirectorDraftedShot[];
  errorMessage: string | null;
  createdAt: string;
  decidedAt: string | null;
}
