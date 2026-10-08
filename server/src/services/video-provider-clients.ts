// DUR-4127: Fal/Sogni video provider HTTP clients, intentionally duplicated
// from packages/plugins/media-studio/src/{video,fal-queue,providers,media-jobs-types}.ts
// rather than imported as a package dependency.
//
// packages/plugins/media-studio is `"private": true` and is never published
// to npm, but server/package.json's "dependencies" section is rewritten to
// pinned calver versions on every release (see scripts/release-package-map.mjs)
// because @paperclipai/server itself is publishFromCi:true. A workspace:*
// dependency from server on a package that never gets a calver publish makes
// every published @paperclipai/server install unresolvable -- this is exactly
// what release-package-map.mjs's policy check exists to catch, and it failed
// CI on this PR's first push. Bootstrapping an npm publish for an internal,
// non-public plugin just to satisfy that check is a bigger call than this
// fix warrants, so this file duplicates the small (ctx-free, no vendor
// secrets) provider-client classes instead of crossing the plugin package
// boundary. If media-studio's video.ts/fal-queue.ts changes, mirror the
// change here too.
//
// Kept deliberately identical in behavior to the plugin's copy; see that
// package for the fuller design commentary (Sogni's shape is an unconfirmed
// upstream assumption -- see the DUR-4127 PR's "Questions for Filip").
import { readSogniWorkflowCredits } from "./sogni-cost.js";


export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface MediaJobInput {
  kind: "video";
  prompt: string;
  model?: string;
  /** image-to-video / continue-from-last-frame: a data: URI of the starting frame. */
  startImage?: string;
  /** Additional character/Look reference pictures (data: URIs); see media-jobs-types.ts's doc comment -- neither provider consumes this today. */
  referenceImages?: string[];
  seed?: number;
  durationSeconds?: number;
  aspectRatio?: string;
}

/** What the service told us right after asking it to start (never the finished file: that comes from poll()). */
export interface MediaJobHandle {
  externalId: string;
  model: string;
  provider: string;
}

export type MediaPollOutcome =
  | { status: "running"; progress?: string }
  | { status: "done"; result: MediaJobResult }
  | { status: "failed"; error: string };

export interface MediaJobResult {
  contentType: string;
  url?: string;
  dataUrl?: string;
  meta?: Record<string, unknown>;
}

export interface MediaJobProvider {
  readonly name: string;
  start(input: MediaJobInput): Promise<MediaJobHandle>;
  poll(handle: MediaJobHandle): Promise<MediaPollOutcome>;
  cancel(handle: MediaJobHandle): Promise<void>;
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

const FAL_QUEUE_BASE = "https://queue.fal.run";

function falAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" };
}

async function falQueueSubmit(
  fetchImpl: FetchImpl,
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
): Promise<{ requestId: string }> {
  const checked = assertFalModelId(model);
  const res = await fetchImpl(`${FAL_QUEUE_BASE}/${checked}`, {
    method: "POST",
    headers: falAuthHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`fal.ai ${checked} could not be started (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { request_id?: string };
  if (!data.request_id) throw new Error("fal.ai did not say which job it started.");
  return { requestId: data.request_id };
}

async function falQueuePoll(fetchImpl: FetchImpl, apiKey: string, handle: MediaJobHandle): Promise<MediaPollOutcome> {
  const model = assertFalModelId(handle.model);
  const statusRes = await fetchImpl(`${FAL_QUEUE_BASE}/${model}/requests/${encodeURIComponent(handle.externalId)}/status`, {
    headers: falAuthHeaders(apiKey),
  });
  if (!statusRes.ok) {
    if (statusRes.status >= 500) return { status: "running" }; // Fal's own retry guidance; not a lost job.
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

  const resultRes = await fetchImpl(`${FAL_QUEUE_BASE}/${model}/requests/${encodeURIComponent(handle.externalId)}`, {
    headers: falAuthHeaders(apiKey),
  });
  if (!resultRes.ok) return { status: "failed", error: `fal.ai finished but the result could not be fetched (${resultRes.status}).` };
  const result = (await resultRes.json()) as Record<string, unknown>;
  const media = result.video as { url?: string; content_type?: string } | undefined;
  if (!media?.url) return { status: "failed", error: "fal.ai finished but sent nothing back. Try again." };
  if (!/^https:\/\//i.test(media.url)) return { status: "failed", error: "fal.ai gave an address that is not https, so it was not used." };
  return {
    status: "done",
    result: { contentType: media.content_type ?? "video/mp4", url: media.url, meta: { requestId: handle.externalId } },
  };
}

async function falQueueCancel(fetchImpl: FetchImpl, apiKey: string, handle: MediaJobHandle): Promise<void> {
  try {
    const model = assertFalModelId(handle.model);
    await fetchImpl(`${FAL_QUEUE_BASE}/${model}/requests/${encodeURIComponent(handle.externalId)}/cancel`, {
      method: "PUT",
      headers: falAuthHeaders(apiKey),
    });
  } catch {
    // Best effort: the original problem is what the caller needs to hear about.
  }
}

export const FAL_DEFAULT_VIDEO_MODEL = "fal-ai/kling-video/v1.6/standard/text-to-video";
export const FAL_DEFAULT_IMAGE_TO_VIDEO_MODEL = "fal-ai/kling-video/v1.6/standard/image-to-video";
/**
 * DUR-4196: the face-drift fix. The only Fal model in this codebase's lineup
 * whose API accepts BOTH a literal continuity frame (`start_image_url`) and
 * named character/object reference pictures (`elements[].reference_image_urls`)
 * in the same generation call -- see the PR description's model research
 * note (fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/api). Before
 * this, every shot after the first silently dropped its character reference
 * pictures whenever a continuity frame was available (FalVideoProvider only
 * ever read input.startImage; input.referenceImages was computed in
 * video-storyline-render.ts but never sent to either provider).
 */
export const FAL_DEFAULT_COMBINED_MODEL = "fal-ai/kling-video/v3/pro/image-to-video";

/**
 * Kling v3's documented element shape wants a `frontal_image_url` plus 1-3
 * `reference_image_urls`. When there is only one character picture in total,
 * it is reused as its own sole "additional angle" rather than guessing
 * whether Fal's API tolerates an empty array for a field its docs call
 * required.
 */
function buildFalElement(referenceImages: readonly string[]): { frontal_image_url: string; reference_image_urls: string[] } | null {
  if (referenceImages.length === 0) return null;
  const [frontal, ...rest] = referenceImages;
  return { frontal_image_url: frontal!, reference_image_urls: rest.length > 0 ? rest.slice(0, 3) : [frontal!] };
}

export class FalVideoProvider implements MediaJobProvider {
  readonly name = "fal";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchImpl,
    private readonly defaultModel = FAL_DEFAULT_VIDEO_MODEL,
    private readonly defaultImageToVideoModel = FAL_DEFAULT_IMAGE_TO_VIDEO_MODEL,
    private readonly defaultCombinedModel = FAL_DEFAULT_COMBINED_MODEL,
  ) {}

  async start(input: MediaJobInput): Promise<MediaJobHandle> {
    const element = buildFalElement(input.referenceImages ?? []);
    // Only switch to the combined model when the caller did not pin an exact
    // model themselves -- an explicit input.model always wins, same as the
    // other two defaults below.
    const useCombined = !input.model && element !== null;
    const model = input.model ?? (useCombined ? this.defaultCombinedModel : input.startImage ? this.defaultImageToVideoModel : this.defaultModel);
    const body: Record<string, unknown> = { prompt: input.prompt };
    if (useCombined) {
      // v3 pro's start_image_url is effectively required; when there is no
      // continuity frame yet (the storyline's first shot), fall back to the
      // character's own frontal picture so likeness still drives the model
      // rather than silently losing it to a bare text-to-video call.
      body.start_image_url = input.startImage ?? element!.frontal_image_url;
      body.elements = [element];
    } else if (input.startImage) {
      body.image_url = input.startImage;
    }
    if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;
    if (typeof input.durationSeconds === "number") body.duration = String(input.durationSeconds);
    if (typeof input.seed === "number") body.seed = input.seed;
    const { requestId } = await falQueueSubmit(this.fetchImpl, this.apiKey, model, body);
    return { externalId: requestId, model, provider: this.name };
  }

  poll(handle: MediaJobHandle): Promise<MediaPollOutcome> {
    return falQueuePoll(this.fetchImpl, this.apiKey, handle);
  }

  cancel(handle: MediaJobHandle): Promise<void> {
    return falQueueCancel(this.fetchImpl, this.apiKey, handle);
  }
}

// ─── Sogni video ───────────────────────────────────────────────────────────
//
// Sogni's creative-agent workflow API: start a one-step workflow (POST
// /v1/creative-agent/workflows), poll it, download the artifact from Sogni's
// storage. The step shapes below follow Sogni's published tool schemas
// (@sogni-ai/sogni-intelligence-client 4.11.0, schema version 2026-07-18.1):
//
//   generate_video  {prompt, duration, videoModel?, referenceImageIndices?}
//     text-to-video; Seedance / MiniMax H3 r2v / HappyHorse r2v / Wan 3 also
//     take loose reference pictures by upload index (-1 = first upload).
//   animate_photo   {prompt, duration, videoModel?, sourceImageIndex}
//     image-to-video: the uploaded picture is the START frame (LTX, WAN 2.2,
//     MiniMax H3 i2v, HappyHorse i2v, Wan 3; not Seedance).
//
// Both schemas have additionalProperties: false, so only those names are
// sent (no `model`, `seed` or `durationSeconds`). `videoModel` takes Sogni's
// tool keys ("ltx25", "seedance2-mini", "minimax-h3-i2v-turbo"); a catalogue
// id from the video model picker is mapped to its key by sogniVideoModelKey
// (the SDK's utils/videoModelIds.js and seedanceModelIds.js aliases).
//
// NOT verified against a live call: the artifact shape of a finished video
// (steps[0].artifacts[0].url), and whether the server accepts catalogue ids
// it does not list in the enum (an unknown/custom id is sent unchanged).

export type SogniVideoTool = "generate_video" | "animate_photo";

/** Tool keys per published schema (videoModel enums). */
const GENERATE_VIDEO_KEYS = new Set([
  "ltx25", "ltx23", "wan22", "seedance2", "seedance2-mini", "seedance2-5", "seedance2-5-uncensored",
  "minimax-h3-t2v", "minimax-h3-t2v-turbo", "minimax-h3-fasth3-t2v-turbo", "minimax-h3-fasth3-t2v-turbo-2stage",
  "happyhorse-1.1-t2v", "happyhorse-1.1-i2v", "happyhorse-1.1-r2v",
  "minimax-h3-r2v", "minimax-h3-r2v-turbo", "minimax-h3-r2v-2stage", "minimax-h3-r2v-balanced-2stage",
  "wan3.0-video", "wan3.0-spicy-video",
]);
const ANIMATE_PHOTO_KEYS = new Set([
  "ltx25", "ltx23", "wan22", "happyhorse-1.1-i2v", "happyhorse-1.1-r2v",
  "minimax-h3-i2v", "minimax-h3-i2v-turbo", "minimax-h3-fasth3-i2v-turbo", "minimax-h3-fasth3-i2v-turbo-2stage",
  "minimax-h3-flf2v", "minimax-h3-flf2v-turbo", "minimax-h3-fasth3-flf2v-turbo", "minimax-h3-fasth3-flf2v-turbo-2stage",
  "wan3.0-video", "wan3.0-spicy-video",
]);
/** Models whose generate_video takes loose reference pictures (referenceImageIndices). */
const LOOSE_REFERENCE_KEYS = new Set([
  "seedance2", "seedance2-mini", "seedance2-5", "seedance2-5-uncensored",
  "minimax-h3-r2v", "minimax-h3-r2v-turbo", "minimax-h3-r2v-2stage", "minimax-h3-r2v-balanced-2stage",
  "happyhorse-1.1-r2v", "wan3.0-video", "wan3.0-spicy-video",
]);
const SEEDANCE_KEYS: Record<string, string> = {
  "seedance-2-0": "seedance2",
  "seedance-2-0-fast": "seedance2-mini",
  "seedance-2-0-mini": "seedance2-mini",
  "seedance-2-5": "seedance2-5",
  "seedance-2-5-uncensored": "seedance2-5-uncensored",
};

/**
 * The videoModel key for a model name (a tool key, or a catalogue id from the
 * picker) and the job: with a start picture the image-to-video variant,
 * without one the text-to-video variant. null = Sogni's default; an unknown
 * name is returned unchanged.
 */
export function sogniVideoModelKey(model: string | null | undefined, withStartImage: boolean): string | null {
  const raw = model?.trim();
  if (!raw) return null;
  const id = raw.toLowerCase();
  if (SEEDANCE_KEYS[id]) return SEEDANCE_KEYS[id]!;
  if (id.startsWith("seedance")) return id;
  if (/^ltx-?2\.?5|^ltx25/.test(id)) return "ltx25";
  if (/^ltx-?2\.?3|^ltx23|10eros/.test(id)) return "ltx23";
  if (/^wan_v2\.2|^wan-?2\.?2|^wan22/.test(id)) return "wan22";
  if (/^wan3/.test(id)) return id.includes("spicy") ? "wan3.0-spicy-video" : "wan3.0-video";
  if (id.startsWith("happyhorse-1.1")) {
    if (id.endsWith("r2v")) return "happyhorse-1.1-r2v";
    return withStartImage ? "happyhorse-1.1-i2v" : "happyhorse-1.1-t2v";
  }
  if (id.startsWith("minimax-h3")) {
    const twoStage = id.includes("2stage");
    if (id.includes("r2v")) {
      if (twoStage) return id.includes("balanced") ? "minimax-h3-r2v-balanced-2stage" : "minimax-h3-r2v-2stage";
      return id.includes("turbo") ? "minimax-h3-r2v-turbo" : "minimax-h3-r2v";
    }
    const flf = id.includes("flf2v");
    const workflow = withStartImage ? (flf ? "flf2v" : "i2v") : "t2v";
    if (id.includes("fastvideo") || id.includes("fasth3")) return `minimax-h3-fasth3-${workflow}-turbo${twoStage ? "-2stage" : ""}`;
    return `minimax-h3-${workflow}${id.includes("turbo") ? "-turbo" : ""}`;
  }
  return raw;
}

/** Which tool a shot uses, and whether its pictures go along as a start frame or as loose references. */
export function sogniVideoStep(model: string | null | undefined, hasStartImage: boolean): { tool: SogniVideoTool; videoModel: string | null; pictures: "start" | "references" | "none" } {
  const startKey = sogniVideoModelKey(model, true);
  // Image-to-video when there is a start frame and the model can take one (Seedance and r2v models use loose references instead).
  if (hasStartImage && (startKey === null || ANIMATE_PHOTO_KEYS.has(startKey)) && !(startKey && startKey.endsWith("r2v"))) {
    return { tool: "animate_photo", videoModel: startKey, pictures: "start" };
  }
  const key = sogniVideoModelKey(model, false);
  const known = key === null || GENERATE_VIDEO_KEYS.has(key);
  const loose = key !== null && LOOSE_REFERENCE_KEYS.has(key);
  if (hasStartImage && !known && startKey !== null) {
    // A custom id we cannot classify: send the start frame the image-to-video way.
    return { tool: "animate_photo", videoModel: startKey, pictures: "start" };
  }
  return { tool: "generate_video", videoModel: key, pictures: loose ? "references" : "none" };
}

const SOGNI_API_BASE = "https://api.sogni.ai";

export interface SogniVideoProviderOptions {
  apiKey: string;
  apiFetch: FetchImpl;
  transferFetch: FetchImpl;
  defaultModel?: string;
  tokenType?: "auto" | "sogni" | "spark";
}

type Json = Record<string, unknown>;
function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

export class SogniVideoProvider implements MediaJobProvider {
  readonly name = "sogni";
  constructor(private readonly options: SogniVideoProviderOptions) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.options.apiKey}`, Accept: "application/json", ...extra };
  }

  async start(input: MediaJobInput): Promise<MediaJobHandle> {
    const requested = input.model ?? this.options.defaultModel ?? null;
    const plan = sogniVideoStep(requested, Boolean(input.startImage));
    const mediaReferences: Array<{ kind: "image"; url: string }> = [];
    const args: Json = {
      prompt: input.prompt,
      ...(typeof input.durationSeconds === "number" ? { duration: input.durationSeconds } : {}),
      ...(plan.videoModel ? { videoModel: plan.videoModel } : {}),
    };
    if (plan.pictures === "start" && input.startImage) {
      mediaReferences.push({ kind: "image", url: await this.uploadReferenceImage(input.startImage, 0) });
      // -1 = the first uploaded picture, used as the START frame.
      args.sourceImageIndex = -1;
    } else if (plan.pictures === "references") {
      const pictures = [...(input.startImage ? [input.startImage] : []), ...(input.referenceImages ?? [])].slice(0, 4);
      for (const [index, picture] of pictures.entries()) {
        mediaReferences.push({ kind: "image", url: await this.uploadReferenceImage(picture, index) });
      }
      // Negative indices point at uploads: -1 is the first, -2 the second, ...
      if (pictures.length > 0) args.referenceImageIndices = pictures.map((_, index) => -(index + 1));
    }
    const step: Json = { id: "video", toolName: plan.tool, arguments: args };
    const body: Json = {
      input: { title: "Paperclip video", steps: [step] },
      token_type: this.options.tokenType ?? "auto",
      app_source: "paperclip-media-studio",
      safe_content_filter: true,
      ...(mediaReferences.length > 0 ? { media_references: mediaReferences } : {}),
    };
    const res = await this.options.apiFetch(`${SOGNI_API_BASE}/v1/creative-agent/workflows`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Sogni refused the video request (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const parsed = asRecord(JSON.parse(await res.text()));
    const workflowId = asRecord(asRecord(parsed?.data)?.workflow)?.workflowId;
    if (typeof workflowId !== "string" || !workflowId) throw new Error("Sogni did not say which job it started.");
    return { externalId: workflowId, model: plan.videoModel ?? "sogni-video", provider: this.name };
  }

  async poll(handle: MediaJobHandle): Promise<MediaPollOutcome> {
    const res = await this.options.apiFetch(
      `${SOGNI_API_BASE}/v1/creative-agent/workflows/${encodeURIComponent(handle.externalId)}`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      if (res.status >= 500) return { status: "running" };
      return { status: "failed", error: `Sogni lost track of this video (${res.status}). Try again.` };
    }
    const body = asRecord(JSON.parse(await res.text()));
    const workflow = asRecord(asRecord(body?.data)?.workflow) ?? {};
    const status = String(workflow.status ?? "");
    if (status === "queued" || status === "running" || status === "") return { status: "running", progress: status || "queued" };
    if (status === "waiting_for_user") return { status: "failed", error: "Sogni paused this video to ask something, so it was stopped. Try again with a clearer description." };
    if (status === "cancelled") return { status: "failed", error: "The video was cancelled on Sogni before it was finished." };
    if (status !== "completed" && status !== "partial_failure") {
      return { status: "failed", error: "Sogni could not make the video." };
    }
    const firstStep = Array.isArray(workflow.steps) ? asRecord(workflow.steps[0]) : null;
    const artifacts = (Array.isArray(firstStep?.artifacts) ? firstStep.artifacts : []).map(asRecord).filter(
      (a): a is Json => typeof a?.url === "string" && a.url !== "",
    );
    const artifact = artifacts[0];
    if (!artifact) return { status: "failed", error: "Sogni finished but sent no video back. Try again." };
    return {
      status: "done",
      result: {
        contentType: typeof artifact.contentType === "string" ? artifact.contentType : "video/mp4",
        url: String(artifact.url),
        meta: {
          workflowId: handle.externalId,
          ...(readSogniWorkflowCredits(workflow) !== null ? { sogniCredits: readSogniWorkflowCredits(workflow) } : {}),
        },
      },
    };
  }

  async cancel(handle: MediaJobHandle): Promise<void> {
    try {
      await this.options.apiFetch(`${SOGNI_API_BASE}/v1/creative-agent/workflows/${encodeURIComponent(handle.externalId)}/cancel`, {
        method: "POST",
        headers: this.headers(),
      });
    } catch {
      // Best effort.
    }
  }

  /** Upload a continuity frame or a character reference picture (same upload mechanics for both), the same way SogniProvider uploads reference pictures. */
  private async uploadReferenceImage(dataUri: string, index = 0): Promise<string> {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUri);
    const contentType = match?.[1]?.toLowerCase() === "image/jpg" ? "image/jpeg" : match?.[1]?.toLowerCase();
    if (!match || !contentType || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(contentType)) {
      throw new Error("The starting frame must be a PNG, JPEG, WebP or GIF picture.");
    }
    const bytes = Buffer.from(match[2]!, "base64");
    const slot = new URLSearchParams({ jobId: `paperclip-${crypto.randomUUID()}`, type: `contextImage${Math.min(index + 1, 16)}`, contentType }).toString();
    const upload = await this.options.apiFetch(`${SOGNI_API_BASE}/v2/image/uploadUrl?${slot}`, { headers: this.headers() });
    if (!upload.ok) throw new Error(`Sogni did not give a place to upload the starting frame (${upload.status}).`);
    const form = asRecord(asRecord(JSON.parse(await upload.text()))?.data);
    if (typeof form?.url !== "string") throw new Error("Sogni did not give a place to upload the starting frame.");
    const multipart = new FormData();
    for (const [key, value] of Object.entries(asRecord(form.fields) ?? {})) {
      if (value !== undefined && value !== null) multipart.append(key, String(value));
    }
    multipart.append("file", new Blob([bytes], { type: contentType }), `frame.${contentType.split("/")[1]}`);
    const stored = await this.options.transferFetch(form.url, { method: "POST", body: multipart });
    if (!stored.ok) throw new Error(`Sogni's storage did not take the starting frame (${stored.status}).`);
    const download = await this.options.apiFetch(`${SOGNI_API_BASE}/v2/image/downloadUrl?${slot}`, { headers: this.headers() });
    if (!download.ok) throw new Error(`Sogni did not give an address for the uploaded starting frame (${download.status}).`);
    const url = asRecord(asRecord(JSON.parse(await download.text()))?.data)?.downloadUrl;
    if (typeof url !== "string") throw new Error("Sogni did not give an address for the uploaded starting frame.");
    return url;
  }
}
