import { z } from "zod";
import type { VideoStorylineProvider } from "./video-storylines.js";

/**
 * DUR-4320 (backend half of DUR-4317, storyboard-of-stills approval gate):
 * types, a price table, an estimator and validators for the storyboard --
 * a cheap still-image render of each shot that a human/agent reviews and
 * approves (or drops) before that shot's real, paid video render can start.
 * Written fresh for this feature; see
 * packages/db/src/schema/video_storylines.ts's videoShots.storyboardStatus
 * and still* column doc comments for the schema side of this -- the status
 * enum below MUST stay byte-for-byte in sync with that file's CHECK
 * constraint, same discipline video-storylines.ts already requires of its
 * own enums (nothing enforces the two automatically).
 */

export const VIDEO_SHOT_STORYBOARD_STATUSES = ["pending", "approved", "dropped"] as const;
export type VideoShotStoryboardStatus = (typeof VIDEO_SHOT_STORYBOARD_STATUSES)[number];

/**
 * Deliberately a separate, much smaller price table from
 * VIDEO_PROVIDER_COST_CENTS_PER_SECOND (video-storylines.ts): a storyboard
 * still is one cheap image-generation call per shot, not seconds of paid
 * video -- the whole point of this gate is to review composition/likeness
 * before paying for the expensive thing. Same ballpark-pricing caveat as
 * that table: not pulled from any provider's real billing, directional only.
 */
export const STILL_IMAGE_PROVIDER_COST_CENTS_PER_IMAGE: Record<VideoStorylineProvider, number> = {
  fal: 2,
  sogni: 1,
};

export interface StoryboardCostEstimateShotInput {
  storyboardStatus: VideoShotStoryboardStatus;
}

export interface StoryboardCostEstimateResult {
  shotCount: number;
  costPerImageCents: number;
  estimatedTotalCents: number;
}

/**
 * Pure so it can be unit tested and reused by both the generate-still
 * endpoint (one shot at a time) and the storyboard summary (the whole
 * storyline). Dropped shots never need a still and are excluded from both
 * the count and the total -- the same "dropped shots don't cost money" rule
 * the render-cost estimate applies to the video side of this feature.
 */
export function estimateStoryboardCostCents(
  shots: readonly StoryboardCostEstimateShotInput[],
  providerId: VideoStorylineProvider,
): StoryboardCostEstimateResult {
  const costPerImageCents = STILL_IMAGE_PROVIDER_COST_CENTS_PER_IMAGE[providerId];
  const shotCount = shots.filter((shot) => shot.storyboardStatus !== "dropped").length;
  return {
    shotCount,
    costPerImageCents,
    estimatedTotalCents: shotCount * costPerImageCents,
  };
}

// ─── Validators ──────────────────────────────────────────────────────────

/** No body today -- a placeholder so the route can still run through the same validate() middleware every other mutating route uses, and so a future option (e.g. a style hint) has somewhere to land without a route signature change. */
export const generateStoryboardStillSchema = z.object({}).strict();
export type GenerateStoryboardStillInput = z.infer<typeof generateStoryboardStillSchema>;

export const approveStoryboardShotSchema = z
  .object({
    /**
     * true = approve the shot on its written description alone, without a
     * storyboard picture -- for when no picture can be made (no Fal.ai key)
     * or the person simply does not want to pay for one. Still an explicit
     * human OK before the paid video render.
     */
    withoutStill: z.boolean().optional(),
  })
  .strict();
export type ApproveStoryboardShotInput = z.infer<typeof approveStoryboardShotSchema>;

export const dropStoryboardShotSchema = z.object({}).strict();
export type DropStoryboardShotInput = z.infer<typeof dropStoryboardShotSchema>;

export const updateVideoStorylineApprovalThresholdSchema = z
  .object({
    /** null turns the threshold gate off for this company (the mandatory per-shot approval gate is unaffected either way). */
    thresholdCents: z.number().int().min(0).nullable(),
  })
  .strict();
export type UpdateVideoStorylineApprovalThresholdInput = z.infer<typeof updateVideoStorylineApprovalThresholdSchema>;

// ─── Storyboard summary shape (GET .../storyboard) ──────────────────────

export interface VideoStoryboardShotSummary {
  id: string;
  orderIndex: number;
  storyboardStatus: VideoShotStoryboardStatus;
  stillObjectKey: string | null;
  stillContentType: string | null;
  stillByteSize: number | null;
  stillGeneratedAt: string | null;
  stillEstimatedCostCents: number | null;
  stillActualCostCents: number | null;
  /** Only right after a picture is made: plain notes about how the cast's saved people were used (pictures left out, LoRA not used, ...). */
  notes?: string[];
}

export interface VideoStoryboardSummary {
  storylineId: string;
  providerId: VideoStorylineProvider;
  shots: VideoStoryboardShotSummary[];
  /** Sum of non-dropped shots' stillActualCostCents (falling back to stillEstimatedCostCents for shots not generated yet). */
  stillTotalCents: number;
  /** True once every non-dropped shot's storyboardStatus is 'approved' -- what render/start's upfront gate itself checks. */
  allApproved: boolean;
  /** The storyline's current video-render cost estimate (excluding dropped shots), shown here so "cost before paying for video" reads next to the stills -- same number recomputeEstimate/startRender already compute. */
  videoEstimatedTotalCents: number | null;
  videoSpentCents: number;
  /** The company's configured kind:"video_render" approval threshold, or null if not configured (that extra gate is off). */
  approvalThresholdCents: number | null;
  /** Which picture services have an API key set up, so the editor only offers those. */
  pictureServices: { fal: boolean; sogni: boolean };
  /** What the next storyboard picture is made with, after defaults: service, model (null = the service's default) and look. */
  picture: { providerId: VideoStorylineProvider; model: string | null; lookId: string | null; costPerPictureCents: number };
}

// ─── "How was this made?" record (DUR-4902) ─────────────────────────────

/** What a record says for a seed when the tool has no seed setting. */
export const GENERATION_SEED_UNSUPPORTED = "not supported by this tool";
/** What a record says for a seed when the tool takes one but none was sent, so the service chose it. */
export const GENERATION_SEED_SERVICE_CHOSE = "not sent (the service chose one)";

/**
 * Exactly what one storyboard picture or one video clip was made with: the
 * words, the model, the LoRAs, the safety settings, the pictures sent and what
 * it cost. Written into the activity log's `details.generation` when the
 * picture/clip is made, so a picture that drifted can be explained later.
 * Built only from named fields: no keys, no tokens, and never picture bytes
 * (pictures appear as file ids with their roles).
 */
export interface VideoShotGenerationRecord {
  version: 1;
  kind: "still" | "clip";
  madeAt: string;
  /** The prompt actually sent (after the safe-for-work words and any LoRA trigger word were added). */
  promptSent: string;
  /** The "things to avoid" text actually sent; null when the tool has none or none was sent. */
  negativePromptSent: string | null;
  provider: string;
  /** The model asked for; null = the service's default for this tool. */
  model: string | null;
  /** The picture-editing model, when the picture was made from reference pictures; null otherwise. */
  editModel: string | null;
  /** The service's tool (e.g. generate_image, edit_image, animate_photo); null when it has one endpoint per model. */
  tool: string | null;
  loras: Array<{ id: string; strength: number }>;
  lorasDropped: Array<{ id: string; reason: string }>;
  contentRating: "sfw" | "mature";
  /** Sogni's content filter as sent (true = on); null for services with only the safety fields below. */
  contentFilterOn: boolean | null;
  /** The provider's own safety fields exactly as sent. */
  providerSafety: Record<string, string | number | boolean>;
  /** "off", "on", "service default" or "not supported by this tool". */
  promptExpansion: string;
  references: Array<{ fileId: string | null; role: string }>;
  /** How many reference pictures were chosen but could not be read, so were not sent. */
  referencesNotSent: number;
  /** The seed sent, or GENERATION_SEED_UNSUPPORTED / GENERATION_SEED_SERVICE_CHOSE. */
  seed: number | string;
  estimatedCostCents: number | null;
  actualCostCents: number | null;
  /** Sogni credits the job reported, when it did. */
  providerCredits: number | null;
  /** Plain notes made while the request was built (a LoRA left out, a setting the tool ignores, ...). */
  notes: string[];
}

/** GET .../shots/:shotId/generation: the newest record of each kind for one shot; null = none was written (made before records existed). */
export interface VideoShotGenerationResponse {
  still: VideoShotGenerationRecord | null;
  clip: VideoShotGenerationRecord | null;
}
