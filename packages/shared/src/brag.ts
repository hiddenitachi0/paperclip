import { z } from "zod";
import { estimateMediaStudioDirectCostCents } from "./media-studio-direct.js";

/**
 * DUR-4520 (Brag video, parent DUR-4518): request validators and the pure
 * cost estimate for the backend pipeline. Slim mode only -- headless browser
 * capture + ffmpeg run locally, so the only metered spend is the scene
 * planning/copy call and, when asked for, a generated music bed.
 */

export const BRAG_FORMATS = ["landscape", "vertical", "square"] as const;
export type BragFormat = (typeof BRAG_FORMATS)[number];
export const BRAG_TONES = ["hype", "calm", "playful", "serious", "technical"] as const;
export const BRAG_JOB_STATUSES = ["draft", "planning", "awaiting_approval", "rendering", "completed", "failed", "cancelled"] as const;
export type BragJobStatus = (typeof BRAG_JOB_STATUSES)[number];
export const BRAG_SCENE_APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type BragSceneApprovalStatus = (typeof BRAG_SCENE_APPROVAL_STATUSES)[number];

export const BRAG_MIN_LENGTH_SECONDS = 8;
export const BRAG_MAX_LENGTH_SECONDS = 60;
export const BRAG_SECONDS_PER_SCENE = 4;
export const BRAG_MAX_SCENES = 15;
/** Planning/copy call per job plus a small per-scene copy cost. Capture and stitching are free local tools. */
export const BRAG_PLANNING_BASE_CENTS = 10;
export const BRAG_PLANNING_PER_SCENE_CENTS = 2;
/** A render is aborted once actual spend passes this multiple of its estimate. */
export const BRAG_OVERRUN_ABORT_MULTIPLIER = 2;
export const BRAG_BILLING_CODE = "brag_video";

export interface BragEstimateInput {
  lengthSeconds: number;
  music: boolean;
}
export interface BragEstimateResult {
  sceneCount: number;
  planningCents: number;
  musicCents: number;
  estimatedCostCents: number;
}

export function bragSceneCount(lengthSeconds: number): number {
  return Math.min(BRAG_MAX_SCENES, Math.max(1, Math.round(lengthSeconds / BRAG_SECONDS_PER_SCENE)));
}

/** Pure -- used by both the estimate route and the pre-flight budget gate so they cannot drift. */
export function estimateBragCostCents(input: BragEstimateInput): BragEstimateResult {
  const sceneCount = bragSceneCount(input.lengthSeconds);
  const planningCents = BRAG_PLANNING_BASE_CENTS + BRAG_PLANNING_PER_SCENE_CENTS * sceneCount;
  const musicCents = input.music
    ? estimateMediaStudioDirectCostCents({ kind: "audio", provider: "fal", durationSeconds: input.lengthSeconds }).estimatedCostCents
    : 0;
  return { sceneCount, planningCents, musicCents, estimatedCostCents: planningCents + musicCents };
}

/** True when actual spend has passed the abort line (strictly more than 2x the estimate). */
export function isBragOverrun(estimatedCents: number, actualCents: number): boolean {
  return actualCents > Math.max(estimatedCents, 1) * BRAG_OVERRUN_ABORT_MULTIPLIER;
}

const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => value.toLowerCase().startsWith("https://"), "Only https addresses are allowed.");

export const bragJobOptionsSchema = z
  .object({
    sourceUrl: httpsUrl.optional(),
    tone: z.enum(BRAG_TONES).optional(),
    format: z.enum(BRAG_FORMATS).default("landscape"),
    lengthSeconds: z.number().int().min(BRAG_MIN_LENGTH_SECONDS).max(BRAG_MAX_LENGTH_SECONDS).default(20),
    music: z.boolean().default(false),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();
export type BragJobOptionsInput = z.infer<typeof bragJobOptionsSchema>;

export const createBragJobSchema = bragJobOptionsSchema.extend({ projectId: z.string().uuid(), issueId: z.string().uuid().optional() }).strict();
export type CreateBragJobInput = z.infer<typeof createBragJobSchema>;

export const bragEstimateSchema = z
  .object({
    lengthSeconds: z.number().int().min(BRAG_MIN_LENGTH_SECONDS).max(BRAG_MAX_LENGTH_SECONDS).default(20),
    music: z.boolean().default(false),
  })
  .strict();

export const updateBragSceneSchema = z
  .object({
    action: z.enum(["approve", "edit", "leave_out"]),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => v.action !== "edit" || !!v.description, { message: "Say what the scene should show.", path: ["description"] });
export type UpdateBragSceneInput = z.infer<typeof updateBragSceneSchema>;
