// DUR-4062: video generation providers. Text-to-video and image-to-video
// (a data: URI starting frame — an existing picture, a saved Look, or the
// last frame of an earlier clip for "continue from last frame") on Fal, and
// the same shape on Sogni (see the assumption noted in media-provider.ts and
// below). Both are MediaJobProvider: start() returns quickly, poll() is
// called again and again by the background job (media-jobs.ts) — see
// media-jobs-types.ts for why a video cannot be made inside one tool call.

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

// ─── Sogni video (assumption — see media-provider.ts and the DUR-4062 PR's "Questions for Filip") ──
//
// Sogni's documented API (sogni.ts) is the creative-agent workflow contract:
// start a one-step workflow (POST /v1/creative-agent/workflows), poll it
// (GET .../:id), download the artifact from Sogni's presigned storage. No
// video tool name is confirmed in this codebase or its vendored docs
// comments. This class assumes Sogni exposes video the same way, under a
// "generate_video" step (text-to-video) whose arguments take a `prompt` and
// `model`, and that image-to-video/continue-from-last-frame is the same
// media_references upload edit_image already uses, with the frame at
// sourceImageIndex -1. It is deliberately small and self-contained (it does
// not reuse SogniProvider's private internals) so a wrong assumption here
// cannot regress the proven picture path.

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
    const model = input.model ?? this.options.defaultModel ?? "sogni-video";
    const mediaReferences: Array<{ kind: "image"; url: string }> = [];
    if (input.startImage) mediaReferences.push({ kind: "image", url: await this.uploadStartFrame(input.startImage) });
    const step: Json = {
      id: "video",
      toolName: "generate_video",
      arguments: {
        prompt: input.prompt,
        model,
        ...(mediaReferences.length > 0 ? { sourceImageIndex: -1 } : {}),
        ...(typeof input.seed === "number" ? { seed: input.seed } : {}),
        ...(typeof input.durationSeconds === "number" ? { durationSeconds: input.durationSeconds } : {}),
      },
    };
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
    return { externalId: workflowId, model, provider: this.name };
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

  /** Upload the continue-from-last-frame / image-to-video starting frame, the same way SogniProvider uploads reference pictures. */
  private async uploadStartFrame(dataUri: string): Promise<string> {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUri);
    const contentType = match?.[1]?.toLowerCase() === "image/jpg" ? "image/jpeg" : match?.[1]?.toLowerCase();
    if (!match || !contentType || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(contentType)) {
      throw new Error("The starting frame must be a PNG, JPEG, WebP or GIF picture.");
    }
    const bytes = Buffer.from(match[2]!, "base64");
    const slot = new URLSearchParams({ jobId: `paperclip-${crypto.randomUUID()}`, type: "contextImage1", contentType }).toString();
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
