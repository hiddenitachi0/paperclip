// DUR-4329: Fal picture/audio provider HTTP clients for Media Studio's
// Create tab direct generation, intentionally duplicated from
// packages/plugins/media-studio/src/{providers,fal-queue,audio}.ts rather
// than imported as a package dependency -- the exact same tradeoff
// video-provider-clients.ts in this directory already made for video (see
// that file's own doc comment: packages/plugins/media-studio is
// `"private": true` and never published, so a workspace:* dependency on it
// from @paperclipai/server, which IS publishFromCi:true, is unresolvable
// once server's own dependencies are rewritten to pinned calver versions on
// release). Video generation below reuses that existing duplicate
// (FalVideoProvider) directly rather than triplicating it.
//
// v1 of direct generation ships Fal only, not Sogni. Reusing Sogni here
// would mean duplicating most of sogni.ts (its workflow start/poll/cancel,
// reference-picture upload, and model-key resolution are not separable into
// a short, self-contained slice the way Fal's picture/audio calls are --
// see sogni.ts's own ~400-line SogniProvider class). Rushing a partial,
// under-tested copy of that vendor contract under time pressure is a worse
// outcome than shipping Fal-only now and adding Sogni as a tracked
// fast-follow once it is worth the duplication (or, better, once the
// plugin host bridge grows a board-user-authorized file-save capability so
// this feature can call the plugin's own providers in place instead of
// duplicating any of them -- see the DUR-4329 issue thread for that
// alternative).
//
// Kept deliberately identical in behavior to the plugin's copies; mirror any
// change to providers.ts's FalProvider / audio.ts's FalAudioProvider here.

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface MediaStudioDirectAudioInput {
  prompt: string;
  mode: "music" | "speech";
  voice?: string;
  model?: string;
  durationSeconds?: number;
  seed?: number;
}

export interface MediaStudioDirectPictureResult {
  provider: string;
  model: string;
  contentType: string;
  imageUrl?: string;
  imageDataUrl?: string;
  seed: number | null;
}

export interface MediaStudioDirectMediaResult {
  contentType: string;
  url?: string;
  dataUrl?: string;
}

export type MediaStudioDirectPollOutcome =
  | { status: "running"; progress?: string }
  | { status: "done"; result: MediaStudioDirectMediaResult }
  | { status: "failed"; error: string };

export interface MediaStudioDirectJobHandle {
  externalId: string;
  model: string;
  provider: string;
}

/** A Fal model id: path segments of letters, digits, dots, dashes, underscores. Never a URL. */
const FAL_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i;

function assertFalModelId(model: string): string {
  const trimmed = model.trim();
  if (!FAL_MODEL_ID_PATTERN.test(trimmed) || trimmed.includes("..") || trimmed.length > 200) {
    throw new Error(`"${model}" is not a Fal model name (it looks like fal-ai/flux/schnell).`);
  }
  return trimmed;
}

function falAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" };
}

export const FAL_DIRECT_DEFAULT_PICTURE_MODEL = "fal-ai/flux/schnell";

/** fal.run's synchronous picture endpoint -- text-to-image only (no reference pictures) for v1 of direct generation. */
export class FalDirectPictureProvider {
  readonly name = "fal";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchImpl,
    private readonly defaultModel = FAL_DIRECT_DEFAULT_PICTURE_MODEL,
    private readonly baseUrl = "https://fal.run",
  ) {}

  async generate(input: { prompt: string; model?: string; seed?: number }): Promise<MediaStudioDirectPictureResult> {
    const model = assertFalModelId(input.model ?? this.defaultModel);
    const body: Record<string, unknown> = {
      prompt: input.prompt,
      image_size: "landscape_4_3",
      num_images: 1,
      enable_safety_checker: true,
    };
    if (typeof input.seed === "number") body.seed = input.seed;
    const res = await this.fetchImpl(`${this.baseUrl}/${model}`, {
      method: "POST",
      headers: falAuthHeaders(this.apiKey),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fal.ai ${model} failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { images?: Array<{ url: string; content_type?: string }>; seed?: number };
    const image = data.images?.[0];
    if (!image?.url) throw new Error("fal.ai returned no image");
    const seed = typeof data.seed === "number" ? data.seed : (input.seed ?? null);
    const base = { provider: this.name, model, contentType: image.content_type ?? "image/jpeg", seed };
    if (/^data:/i.test(image.url)) return { ...base, imageDataUrl: image.url };
    if (!/^https:\/\//i.test(image.url)) throw new Error("fal.ai returned an image address that is not https");
    return { ...base, imageUrl: image.url };
  }
}

async function falQueueSubmit(fetchImpl: FetchImpl, apiKey: string, model: string, body: Record<string, unknown>): Promise<{ requestId: string }> {
  const checked = assertFalModelId(model);
  const res = await fetchImpl(`https://queue.fal.run/${checked}`, {
    method: "POST",
    headers: falAuthHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`fal.ai ${checked} could not be started (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { request_id?: string };
  if (!data.request_id) throw new Error("fal.ai did not say which job it started.");
  return { requestId: data.request_id };
}

async function falQueuePoll(fetchImpl: FetchImpl, apiKey: string, handle: MediaStudioDirectJobHandle): Promise<MediaStudioDirectPollOutcome> {
  const model = assertFalModelId(handle.model);
  const statusRes = await fetchImpl(`https://queue.fal.run/${model}/requests/${encodeURIComponent(handle.externalId)}/status`, {
    headers: falAuthHeaders(apiKey),
  });
  if (!statusRes.ok) {
    if (statusRes.status >= 500) return { status: "running" };
    return { status: "failed", error: `fal.ai lost track of this job (${statusRes.status}). Try again.` };
  }
  const statusBody = (await statusRes.json()) as { status?: string; queue_position?: number };
  const state = statusBody.status ?? "";
  if (state === "IN_QUEUE") {
    const position = typeof statusBody.queue_position === "number" ? statusBody.queue_position : null;
    return { status: "running", progress: position !== null ? `queued, position ${position}` : "queued" };
  }
  if (state === "IN_PROGRESS") return { status: "running", progress: "running" };
  if (state !== "COMPLETED") return { status: "failed", error: `fal.ai could not make this (status: ${state || "unknown"}).` };

  const resultRes = await fetchImpl(`https://queue.fal.run/${model}/requests/${encodeURIComponent(handle.externalId)}`, {
    headers: falAuthHeaders(apiKey),
  });
  if (!resultRes.ok) return { status: "failed", error: `fal.ai finished but the result could not be fetched (${resultRes.status}).` };
  const result = (await resultRes.json()) as Record<string, unknown>;
  const media = result.audio as { url?: string; content_type?: string } | undefined;
  if (!media?.url) return { status: "failed", error: "fal.ai finished but sent nothing back. Try again." };
  if (!/^https:\/\//i.test(media.url)) return { status: "failed", error: "fal.ai gave an address that is not https, so it was not used." };
  return { status: "done", result: { contentType: media.content_type ?? "audio/mpeg", url: media.url } };
}

async function falQueueCancel(fetchImpl: FetchImpl, apiKey: string, handle: MediaStudioDirectJobHandle): Promise<void> {
  try {
    const model = assertFalModelId(handle.model);
    await fetchImpl(`https://queue.fal.run/${model}/requests/${encodeURIComponent(handle.externalId)}/cancel`, {
      method: "PUT",
      headers: falAuthHeaders(apiKey),
    });
  } catch {
    // Best effort -- the original problem is what the caller needs to hear about.
  }
}

export const FAL_DIRECT_DEFAULT_MUSIC_MODEL = "cassetteai/music-generator";
export const FAL_DIRECT_DEFAULT_SPEECH_MODEL = "fal-ai/kokoro";

/** Fal's async queue API for music/speech, polled synchronously (bounded) by the caller -- see media-studio-direct.ts's pollUntilDone. */
export class FalDirectAudioProvider {
  readonly name = "fal";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchImpl,
    private readonly defaultMusicModel = FAL_DIRECT_DEFAULT_MUSIC_MODEL,
    private readonly defaultSpeechModel = FAL_DIRECT_DEFAULT_SPEECH_MODEL,
  ) {}

  async start(input: MediaStudioDirectAudioInput): Promise<MediaStudioDirectJobHandle> {
    const model = input.model ?? (input.mode === "speech" ? this.defaultSpeechModel : this.defaultMusicModel);
    const body: Record<string, unknown> =
      input.mode === "speech"
        ? { text: input.prompt, ...(input.voice ? { voice: input.voice } : {}) }
        : { prompt: input.prompt, ...(typeof input.durationSeconds === "number" ? { duration: input.durationSeconds } : {}) };
    if (typeof input.seed === "number") body.seed = input.seed;
    const { requestId } = await falQueueSubmit(this.fetchImpl, this.apiKey, model, body);
    return { externalId: requestId, model, provider: this.name };
  }

  poll(handle: MediaStudioDirectJobHandle): Promise<MediaStudioDirectPollOutcome> {
    return falQueuePoll(this.fetchImpl, this.apiKey, handle);
  }

  cancel(handle: MediaStudioDirectJobHandle): Promise<void> {
    return falQueueCancel(this.fetchImpl, this.apiKey, handle);
  }
}
