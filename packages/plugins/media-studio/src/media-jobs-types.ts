// DUR-4062: the two-phase contract a slow (video/audio) media provider
// implements, distinct from the picture GenerationProvider in providers.ts
// (which returns the finished picture from one call). A picture is fast
// enough to make inside one tool call; video (and some audio, e.g. music) is
// not: Fal's video models and Sogni's workflow API can both take minutes, far
// past the host's tool-call timeout. So these providers only ever (a) start
// a job and hand back an id the service knows it by, and (b) check that id's
// status — the actual waiting happens across many ticks of the
// media-generation-poll background job (media-jobs.ts), not inside one call.

import type { MediaKind } from "./media-provider.js";

export interface MediaJobInput {
  kind: MediaKind;
  prompt: string;
  model?: string;
  /** image-to-video / continue-from-last-frame: a data: URI of the starting frame. */
  startImage?: string;
  /**
   * DUR-4127: additional character/Look reference pictures (data: URIs) a
   * caller would like considered *alongside* `startImage`. Carried through
   * the type so a caller (video-storyline-render.ts) can express the intent,
   * but neither FalVideoProvider nor SogniVideoProvider consumes it today --
   * Fal's image-to-video endpoint and Sogni's assumed video tool (see
   * video.ts's own doc comment) only confirm a single reference image each,
   * not several combined with a continuity frame in the same call. A caller
   * that sets this should not assume the pictures are actually used; see the
   * DUR-4127 PR's "Questions for Filip" for what confirming real
   * multi-reference support on either provider would take.
   */
  referenceImages?: string[];
  /** Music vs. speech, for an audio job (ignored for video). */
  mode?: "music" | "speech";
  /** Text-to-speech only: which voice, when the model takes one. */
  voice?: string;
  seed?: number;
  durationSeconds?: number;
  aspectRatio?: string;
}

/** What the service told us right after asking it to start (never the finished file: that comes from poll()). */
export interface MediaJobHandle {
  /** The id this service will recognize the job by on every later poll. */
  externalId: string;
  /** The exact model that ended up running (a default may have been filled in). */
  model: string;
  provider: string;
}

export type MediaPollOutcome =
  | { status: "running"; progress?: string }
  | { status: "done"; result: MediaJobResult }
  | { status: "failed"; error: string };

export interface MediaJobResult {
  contentType: string;
  /** Remote https URL — downloaded once and stored as a Paperclip file; never handed to a person directly. */
  url?: string;
  /** Inline bytes as a data: URL, for a provider that returns them directly. */
  dataUrl?: string;
  meta?: Record<string, unknown>;
}

/**
 * A slow media provider: start a job, then poll it (from the background job,
 * not from the tool call) until it is done or failed. `cancel` is best
 * effort — used when a job has been abandoned (e.g. its company or agent
 * disappeared) so the provider does not keep spending on it.
 */
export interface MediaJobProvider {
  readonly name: string;
  start(input: MediaJobInput): Promise<MediaJobHandle>;
  poll(handle: MediaJobHandle): Promise<MediaPollOutcome>;
  cancel(handle: MediaJobHandle): Promise<void>;
}
