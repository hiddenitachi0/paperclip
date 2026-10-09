// DUR-4062: video generation providers. Text-to-video and image-to-video
// (a data: URI starting frame — an existing picture, a saved Look, or the
// last frame of an earlier clip for "continue from last frame") on Fal, and
// the same shape on Sogni (see the assumption noted in media-provider.ts and
// below). Both are MediaJobProvider: start() returns quickly, poll() is
// called again and again by the background job (media-jobs.ts) — see
// media-jobs-types.ts for why a video cannot be made inside one tool call.

import { sogniVideoStep } from "./sogni-video-step.js";
import type { FetchImpl } from "./providers.js";
import { falQueueCancel, falQueuePoll, falQueueSubmit } from "./fal-queue.js";
import type { MediaJobHandle, MediaJobInput, MediaJobProvider, MediaPollOutcome } from "./media-jobs-types.js";

export const FAL_DEFAULT_VIDEO_MODEL = "fal-ai/kling-video/v1.6/standard/text-to-video";
export const FAL_DEFAULT_IMAGE_TO_VIDEO_MODEL = "fal-ai/kling-video/v1.6/standard/image-to-video";

export class FalVideoProvider implements MediaJobProvider {
  readonly name = "fal";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchImpl,
    private readonly defaultModel = FAL_DEFAULT_VIDEO_MODEL,
    private readonly defaultImageToVideoModel = FAL_DEFAULT_IMAGE_TO_VIDEO_MODEL,
  ) {}

  async start(input: MediaJobInput): Promise<MediaJobHandle> {
    const model = input.model ?? (input.startImage ? this.defaultImageToVideoModel : this.defaultModel);
    const body: Record<string, unknown> = { prompt: input.prompt };
    if (input.startImage) body.image_url = input.startImage;
    if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;
    if (typeof input.durationSeconds === "number") body.duration = String(input.durationSeconds);
    if (typeof input.seed === "number") body.seed = input.seed;
    const { requestId } = await falQueueSubmit(this.fetchImpl, this.apiKey, model, body);
    return { externalId: requestId, model, provider: this.name };
  }

  poll(handle: MediaJobHandle): Promise<MediaPollOutcome> {
    return falQueuePoll(this.fetchImpl, this.apiKey, handle, "video");
  }

  cancel(handle: MediaJobHandle): Promise<void> {
    return falQueueCancel(this.fetchImpl, this.apiKey, handle);
  }
}

// ─── Sogni video ───────────────────────────────────────────────────────────
//
// Sogni's creative-agent workflow API (sogni.ts): start a one-step workflow
// (POST /v1/creative-agent/workflows), poll it (GET .../:id), download the
// artifact from Sogni's presigned storage. The step follows Sogni's published
// tool schemas -- see sogni-video-step.ts: animate_photo with the start frame
// at sourceImageIndex -1, or generate_video (with loose reference pictures by
// upload index for Seedance and the reference models). Only the schema's
// argument names are sent (no `model`, `seed` or `durationSeconds`).
// Uploads go through `transferFetch` (the worker passes
// guardedTransferFetch: Sogni's storage hosts only, real multipart bytes).
//
// NOT verified against a live call: the finished video's artifact shape
// (steps[0].artifacts[0].url), and whether Sogni accepts an id outside its
// videoModel key list (a custom id is sent unchanged).

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
        meta: { workflowId: handle.externalId },
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

  /** Upload a start frame or a reference picture to Sogni's storage (the same way SogniProvider uploads reference pictures); returns the address Sogni reads it from. */
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
