// DUR-4317/DUR-4320: a minimal Fal.ai still-image client for the
// storyboard-of-stills approval gate, intentionally duplicated (in spirit,
// not verbatim -- trimmed to only what a cheap storyboard still needs: no
// LoRAs, ComfyUI or Sogni) from packages/plugins/media-studio/src/providers.ts's
// FalProvider, for the same reason server/src/services/video-provider-clients.ts
// duplicates that package's video clients instead of importing them: that
// plugin package is `"private": true` and never calver-published, but
// server/package.json's dependencies get rewritten to pinned calver versions
// on release (see scripts/release-package-map.mjs) -- a workspace:* dependency
// on an unpublished package breaks that CI check. See video-provider-clients.ts's
// header comment for the fuller story.
//
// Sogni is NOT implemented here: its real client (packages/plugins/media-studio/src/sogni.ts)
// is a ~800-line durable start/poll/download workflow, far more than a cheap
// storyboard still needs to duplicate. A storyline whose providerId is
// "sogni" gets a clear "not supported yet" error from generateStill (see
// video-storyline-stills.ts) rather than a half-ported client.

export type ImageFetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface ImageGenerationInput {
  prompt: string;
  model?: string;
  /** Reference pictures as data: URIs (continuity/character look), same convention as video-provider-clients.ts's MediaJobInput.referenceImages. */
  referenceImages?: string[];
}

export interface ImageGenerationResult {
  provider: string;
  model: string;
  contentType: string;
  /** Remote https URL (Fal's CDN) -- safe to download and persist. */
  imageUrl?: string;
  /** Inline bytes as a data: URL, when the provider answers that way instead. */
  imageDataUrl?: string;
  /** DUR-4455: the picture's size in megapixels when Fal reported it, for per-megapixel pricing. */
  megapixels?: number;
}

export interface ImageGenerationProvider {
  readonly name: string;
  generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}

/** A Fal model id: path segments of letters, digits, dots, dashes, underscores. Never a URL -- same guard video-provider-clients.ts's assertFalModelId uses. */
const FAL_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i;

function assertFalModelId(model: string): string {
  const trimmed = model.trim();
  if (!FAL_MODEL_ID_PATTERN.test(trimmed) || trimmed.includes("..") || trimmed.length > 200) {
    throw new Error(`"${model}" is not a Fal model name (it looks like fal-ai/flux/schnell).`);
  }
  return trimmed;
}

/** The cheapest Fal text-to-image model -- same choice media-studio's quick-picture.ts makes for its own "fast still" preset. */
export const FAL_STILL_DEFAULT_MODEL = "fal-ai/flux/schnell";
/** FLUX.1 Kontext "multi": used instead of the plain model whenever reference pictures are given, so continuity/likeness carries into the still. */
const FAL_REFERENCE_MODEL = "fal-ai/flux-pro/kontext/multi";

export class FalImageProvider implements ImageGenerationProvider {
  readonly name = "fal";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: ImageFetchImpl,
    private readonly defaultModel: string = FAL_STILL_DEFAULT_MODEL,
    private readonly baseUrl = "https://fal.run",
  ) {}

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const references = input.referenceImages ?? [];
    const model = assertFalModelId(input.model ?? (references.length > 0 ? FAL_REFERENCE_MODEL : this.defaultModel));
    const body: Record<string, unknown> =
      references.length > 0
        ? {
            prompt: input.prompt,
            image_urls: references,
            num_images: 1,
            output_format: "jpeg",
            safety_tolerance: "2",
          }
        : {
            prompt: input.prompt,
            image_size: "landscape_4_3",
            num_images: 1,
            enable_safety_checker: true,
            // A cheap storyboard still -- few denoising steps, same
            // "quick" posture media-studio's quick-picture.ts uses.
            num_inference_steps: 2,
          };
    const res = await this.fetchImpl(`${this.baseUrl}/${model}`, {
      method: "POST",
      headers: { Authorization: `Key ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fal.ai ${model} failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { images?: Array<{ url: string; content_type?: string; width?: number; height?: number }> };
    const image = data.images?.[0];
    if (!image?.url) throw new Error("fal.ai returned no image");
    const megapixels = typeof image.width === "number" && typeof image.height === "number" ? (image.width * image.height) / 1_000_000 : undefined;
    const base = { provider: this.name, model, contentType: image.content_type ?? "image/jpeg", ...(megapixels !== undefined ? { megapixels } : {}) };
    if (/^data:/i.test(image.url)) return { ...base, imageDataUrl: image.url };
    if (!/^https:\/\//i.test(image.url)) throw new Error("fal.ai returned an image address that is not https");
    return { ...base, imageUrl: image.url };
  }
}
