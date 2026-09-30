// DUR-4062: the shared shape every media kind (picture, video, audio) plugs
// into, so a new provider or a new kind never needs the rest of Media Studio
// restructured.
//
// A provider declares which kinds it can make and, for each kind, its known
// models (a starting list for the UI/tool descriptions — Fal keeps adding
// models, so an unlisted "fal-ai/…" path is still accepted; see
// assertFalModelId in providers.ts). Tools and settings read this
// declaration instead of hard-coding which service does what.

/** The kinds of media Media Studio can make. Pictures: providers.ts (unchanged). */
export const MEDIA_KINDS = ["image", "video", "audio"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export function isMediaKind(value: unknown): value is MediaKind {
  return value === "image" || value === "video" || value === "audio";
}

/** What one provider can make, and a short list of its known models per kind (for the UI and tool text; not exhaustive). */
export interface MediaProviderCapability {
  id: string;
  displayName: string;
  kinds: Partial<Record<MediaKind, { models: readonly string[]; notes?: string }>>;
}

/**
 * The pluggable-provider declarations DUR-4062 asked for: which service
 * makes which kind, with a short list of known models per kind. Video and
 * audio models are named freely (like Fal picture models already are; see
 * assertFalModelId) — this list is what the tool descriptions and the looks
 * page mention by name, not a hard allowlist.
 */
export const MEDIA_PROVIDER_CAPABILITIES: readonly MediaProviderCapability[] = [
  {
    id: "fal",
    displayName: "Fal.ai",
    kinds: {
      image: { models: ["fal-ai/flux/schnell", "fal-ai/flux/dev", "fal-ai/flux-pro/kontext/multi"] },
      video: {
        models: [
          "fal-ai/kling-video/v1.6/standard/text-to-video",
          "fal-ai/kling-video/v1.6/standard/image-to-video",
          "fal-ai/wan-t2v",
          "fal-ai/veo3",
        ],
        notes: "Text-to-video and image-to-video (an existing picture, or a saved Look, as the first frame).",
      },
      audio: {
        models: ["fal-ai/stable-audio-25", "cassetteai/music-generator", "fal-ai/kokoro"],
        notes: "Music/sound generation and text-to-speech/voice.",
      },
    },
  },
  {
    id: "sogni",
    displayName: "Sogni",
    kinds: {
      image: { models: ["z-turbo", "z-image", "qwen-2512-lightning"] },
      video: {
        models: ["sogni-video"],
        notes:
          "DUR-4062 assumption: Sogni video is wired to the same creative-agent workflow API as pictures " +
          "(generate_video, one workflow step, polled the same way as generate_image/edit_image). " +
          "Continue-from-last-frame uploads the previous clip's last frame as a media_references image, " +
          "the same way a picture's reference pictures are uploaded. Not yet verified against Sogni's own " +
          "docs/schema for video — see \"Questions for Filip\" in the DUR-4062 PR before relying on it for a paying customer.",
      },
    },
  },
] as const;

export function mediaProviderCapability(providerId: string): MediaProviderCapability | undefined {
  return MEDIA_PROVIDER_CAPABILITIES.find((p) => p.id === providerId);
}

/** Which providers can make this kind at all (for a plain "not offered" error message). */
export function providersForKind(kind: MediaKind): MediaProviderCapability[] {
  return MEDIA_PROVIDER_CAPABILITIES.filter((p) => p.kinds[kind]);
}

// ─── The seam for a future "long video" provider (Task 1.3, not built here) ──
//
// Filip's assistant is researching long-form consistent video (ComfyUI's
// Endless Sampler and alternatives). When that lands, it plugs in as one more
// entry in MEDIA_PROVIDER_CAPABILITIES with kinds.video, plus a
// `continuity: "long"` flag this type does not have yet (added then, not
// guessed now). The job engine (media-jobs.ts) already treats every video
// generation as a background job with a start()/poll() contract and no fixed
// timeout other than a generous overall ceiling, which is what an
// open-ended/long-running render needs; nothing in that contract assumes a
// single clip or a fixed duration, so a long-video provider does not need the
// job engine itself to change, only a new MediaProvider implementation.
