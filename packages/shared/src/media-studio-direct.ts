import { z } from "zod";
import { VIDEO_PROVIDER_COST_CENTS_PER_SECOND, type VideoStorylineProvider } from "./video-storylines.js";

/**
 * DUR-4329: Media Studio's Create tab direct generation — the same
 * provider actions agents already call (packages/plugins/media-studio),
 * triggered directly by a board owner/admin/operator instead of an agent,
 * with an upfront cost estimate and a budget gate before anything is
 * generated. See server/src/services/media-studio-direct.ts for the
 * request/response contract and server/src/services/
 * media-studio-direct-providers.ts's doc comment for why v1 ships Fal only
 * (Sogni is a deliberate, documented fast-follow, not an oversight).
 */

export const MEDIA_STUDIO_DIRECT_KINDS = ["picture", "video", "audio"] as const;
export type MediaStudioDirectKind = (typeof MEDIA_STUDIO_DIRECT_KINDS)[number];

/** A subset of VideoStorylineProvider's ids: both tables are keyed the same way so the video kind can reuse VIDEO_PROVIDER_COST_CENTS_PER_SECOND directly. */
export const MEDIA_STUDIO_DIRECT_PROVIDERS = ["fal"] as const;
export type MediaStudioDirectProvider = (typeof MEDIA_STUDIO_DIRECT_PROVIDERS)[number];

export const MEDIA_STUDIO_DIRECT_AUDIO_MODES = ["music", "speech"] as const;
export type MediaStudioDirectAudioMode = (typeof MEDIA_STUDIO_DIRECT_AUDIO_MODES)[number];

// ─── Limits ──────────────────────────────────────────────────────────────

export const MEDIA_STUDIO_DIRECT_PROMPT_MAX_LENGTH = 2_000;

export const MEDIA_STUDIO_DIRECT_VIDEO_MIN_DURATION_SECONDS = 1;
/** Kept well below generate-video's 60s agent-tool ceiling: this call polls synchronously within one HTTP request (see renderPreview's doc comment in video-storyline-render.ts for the same bounded-poll shape), so it must stay short enough to finish inside that window. */
export const MEDIA_STUDIO_DIRECT_VIDEO_MAX_DURATION_SECONDS = 10;
export const MEDIA_STUDIO_DIRECT_VIDEO_DEFAULT_DURATION_SECONDS = 5;

export const MEDIA_STUDIO_DIRECT_AUDIO_MIN_DURATION_SECONDS = 1;
/** Same bounded-synchronous-poll reasoning as the video cap above, scaled for audio's typically-faster generation. */
export const MEDIA_STUDIO_DIRECT_AUDIO_MAX_DURATION_SECONDS = 30;
export const MEDIA_STUDIO_DIRECT_AUDIO_DEFAULT_DURATION_SECONDS = 8;

export const MEDIA_STUDIO_DIRECT_REWRITE_PROMPT_MAX_LENGTH = 2_000;

export const MEDIA_STUDIO_DIRECT_BILLING_CODE = "media_studio_direct_create";
export const MEDIA_STUDIO_DIRECT_REWRITE_BILLING_CODE = "media_studio_direct_rewrite_prompt";

/**
 * Ballpark cents, NOT pulled from Fal's real billing — the same
 * "directional estimate, not a quote" caveat as
 * VIDEO_PROVIDER_COST_CENTS_PER_SECOND (video-storylines.ts), which the
 * video kind below reuses rather than duplicating.
 */
export const MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS: Record<MediaStudioDirectProvider, number> = {
  fal: 8,
};
export const MEDIA_STUDIO_DIRECT_AUDIO_COST_CENTS_PER_SECOND: Record<MediaStudioDirectProvider, number> = {
  fal: 15,
};

export interface MediaStudioDirectEstimateInput {
  kind: MediaStudioDirectKind;
  provider: MediaStudioDirectProvider;
  /** Required (and used) for "video"/"audio"; ignored for "picture" (flat cost). */
  durationSeconds?: number;
}

export interface MediaStudioDirectEstimateResult {
  kind: MediaStudioDirectKind;
  provider: MediaStudioDirectProvider;
  estimatedCostCents: number;
}

/** Pure so it is unit-testable and reused by both the estimate route and the pre-flight budget gate in media-studio-direct.ts. */
export function estimateMediaStudioDirectCostCents(input: MediaStudioDirectEstimateInput): MediaStudioDirectEstimateResult {
  const { kind, provider } = input;
  if (kind === "picture") {
    return { kind, provider, estimatedCostCents: MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS[provider] };
  }
  const durationSeconds = Math.max(0, input.durationSeconds ?? 0);
  const perSecondCents =
    kind === "video"
      ? VIDEO_PROVIDER_COST_CENTS_PER_SECOND[provider as VideoStorylineProvider]
      : MEDIA_STUDIO_DIRECT_AUDIO_COST_CENTS_PER_SECOND[provider];
  return { kind, provider, estimatedCostCents: Math.ceil(durationSeconds * perSecondCents) };
}

/**
 * DUR-4441: the paid Edit-tab actions. The Edit tab shows ONE price for
 * every paid button -- the Create tab's picture estimate -- so the server
 * charges exactly that, from the same function, and the two can never
 * drift. If a per-action price ever differs, change it here, in one place.
 */
export const MEDIA_STUDIO_EDIT_ACTIONS = ["segment", "inpaint", "remove-background", "upscale", "restore", "variation", "prompt-edit"] as const;
export type MediaStudioEditAction = (typeof MEDIA_STUDIO_EDIT_ACTIONS)[number];
export const MEDIA_STUDIO_EDIT_BILLING_CODE = MEDIA_STUDIO_DIRECT_BILLING_CODE;

export function estimateMediaStudioEditCostCents(_action: MediaStudioEditAction, provider: MediaStudioDirectProvider = "fal"): number {
  return estimateMediaStudioDirectCostCents({ kind: "picture", provider }).estimatedCostCents;
}

// ─── Validators ──────────────────────────────────────────────────────────

const promptField = z.string().trim().min(1, "Describe what to make.").max(MEDIA_STUDIO_DIRECT_PROMPT_MAX_LENGTH);
const providerField = z.enum(MEDIA_STUDIO_DIRECT_PROVIDERS).default("fal");
/** Lets a call proceed past the per-plugin cap for this one call only — never past the company's own monthly budget, which is not overridable this way. See media-studio-direct.ts's assertWithinBudget. */
const confirmBudgetCapCentsField = z.number().int().min(0).optional();

export const mediaStudioDirectEstimateSchema = z
  .object({
    kind: z.enum(MEDIA_STUDIO_DIRECT_KINDS),
    provider: providerField,
    durationSeconds: z.number().int().min(1).max(MEDIA_STUDIO_DIRECT_AUDIO_MAX_DURATION_SECONDS).optional(),
  })
  .strict();
export type MediaStudioDirectEstimateRequest = z.infer<typeof mediaStudioDirectEstimateSchema>;

export const createMediaStudioDirectPictureSchema = z
  .object({
    prompt: promptField,
    provider: providerField,
    model: z.string().trim().min(1).max(200).optional(),
    seed: z.number().int().min(0).max(4_294_967_295).optional(),
    confirmBudgetCapCents: confirmBudgetCapCentsField,
  })
  .strict();
export type CreateMediaStudioDirectPictureInput = z.infer<typeof createMediaStudioDirectPictureSchema>;

export const createMediaStudioDirectVideoSchema = z
  .object({
    prompt: promptField,
    provider: providerField,
    model: z.string().trim().min(1).max(200).optional(),
    durationSeconds: z
      .number()
      .int()
      .min(MEDIA_STUDIO_DIRECT_VIDEO_MIN_DURATION_SECONDS)
      .max(MEDIA_STUDIO_DIRECT_VIDEO_MAX_DURATION_SECONDS)
      .default(MEDIA_STUDIO_DIRECT_VIDEO_DEFAULT_DURATION_SECONDS),
    seed: z.number().int().min(0).max(4_294_967_295).optional(),
    confirmBudgetCapCents: confirmBudgetCapCentsField,
  })
  .strict();
export type CreateMediaStudioDirectVideoInput = z.infer<typeof createMediaStudioDirectVideoSchema>;

export const createMediaStudioDirectAudioSchema = z
  .object({
    prompt: promptField,
    provider: providerField,
    mode: z.enum(MEDIA_STUDIO_DIRECT_AUDIO_MODES).default("music"),
    voice: z.string().trim().min(1).max(100).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    durationSeconds: z
      .number()
      .int()
      .min(MEDIA_STUDIO_DIRECT_AUDIO_MIN_DURATION_SECONDS)
      .max(MEDIA_STUDIO_DIRECT_AUDIO_MAX_DURATION_SECONDS)
      .default(MEDIA_STUDIO_DIRECT_AUDIO_DEFAULT_DURATION_SECONDS),
    confirmBudgetCapCents: confirmBudgetCapCentsField,
  })
  .strict();
export type CreateMediaStudioDirectAudioInput = z.infer<typeof createMediaStudioDirectAudioSchema>;

export const mediaStudioDirectRewritePromptSchema = z
  .object({
    prompt: z.string().trim().min(1).max(MEDIA_STUDIO_DIRECT_REWRITE_PROMPT_MAX_LENGTH),
    kind: z.enum(MEDIA_STUDIO_DIRECT_KINDS).optional(),
  })
  .strict();
export type MediaStudioDirectRewritePromptInput = z.infer<typeof mediaStudioDirectRewritePromptSchema>;

export interface MediaStudioDirectHistoryEntry {
  id: string;
  kind: MediaStudioDirectKind | "rewrite_prompt";
  provider: string;
  model: string;
  prompt: string | null;
  costCents: number;
  fileId: string | null;
  contentPath: string | null;
  createdAt: string;
}
