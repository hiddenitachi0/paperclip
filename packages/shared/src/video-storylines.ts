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

// ─── Feature flag (ships default off) ───────────────────────────────────

export const MEDIA_STUDIO_PLUGIN_KEY = "paperclip.media-studio";
/** Key inside plugin_company_settings.settings_json for this company's media-studio row. Absent or false = off (the required default). */
export const VIDEO_STORYLINES_SETTINGS_KEY = "videoStorylinesEnabled";

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
};

export const createVideoStorylineSchema = z
  .object({
    title: storylineFields.title,
    projectId: storylineFields.projectId.optional().default(null),
    providerId: storylineFields.providerId.optional().default("fal"),
    model: storylineFields.model.optional().default(null),
    budgetCapCents: storylineFields.budgetCapCents.optional().default(null),
    characterReferenceAssetIds: storylineFields.characterReferenceAssetIds.optional().default([]),
  })
  .strict();
export type CreateVideoStorylineInput = z.infer<typeof createVideoStorylineSchema>;

export const updateVideoStorylineSchema = z
  .object({
    title: storylineFields.title,
    projectId: storylineFields.projectId,
    budgetCapCents: storylineFields.budgetCapCents,
    characterReferenceAssetIds: storylineFields.characterReferenceAssetIds,
  })
  .partial()
  .strict();
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
};

export const createVideoShotSchema = z
  .object({
    sceneId: shotFields.sceneId,
    orderIndex: shotFields.orderIndex,
    prompt: shotFields.prompt,
    cameraNotes: shotFields.cameraNotes.optional().default(null),
    durationSeconds: shotFields.durationSeconds.optional().default(VIDEO_SHOT_DEFAULT_DURATION_SECONDS),
    lookReferenceAssetIds: shotFields.lookReferenceAssetIds.optional().default([]),
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
