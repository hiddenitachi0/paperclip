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
// Sogni: SogniImageProvider below is a trimmed copy of the plugin's
// SogniProvider (packages/plugins/media-studio/src/sogni.ts) -- one picture
// per call through the creative-agent workflow API (start, poll, download),
// with reference pictures, LoRAs, seed and the Sensitive Content Filter, which
// is what a storyboard picture with a Media Studio look needs. No retries on
// 429/409 (the person just presses Make picture again).

import { readSogniWorkflowCredits } from "./sogni-cost.js";

export type ImageFetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface ImageGenerationInput {
  prompt: string;
  model?: string;
  /** Reference pictures as data: URIs (continuity/character look), same convention as video-provider-clients.ts's MediaJobInput.referenceImages. */
  referenceImages?: string[];
  /** Sogni only: a look's LoRAs, in order. */
  loras?: Array<{ id: string; strength: number }>;
  /** Sogni only (text-only pictures). */
  seed?: number;
  guidance?: number;
  negativePrompt?: string;
  /** Sogni's Sensitive Content Filter; on unless a look saved by an owner/admin turned it off. */
  safeContentFilter?: boolean;
}

export interface ImageGenerationResult {
  /** Sogni credits the workflow reported, when it did (for the cost record). */
  sogniCredits?: number | null;
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
            // "quick" posture media-studio's quick-picture.ts uses. Only for
            // the default quick model: a model picked on purpose keeps its
            // own step count.
            ...(model === FAL_STILL_DEFAULT_MODEL ? { num_inference_steps: 2 } : {}),
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


// ─── Sogni ─────────────────────────────────────────────────────────────────

const SOGNI_API_BASE = "https://api.sogni.ai";
/** Text-only default (the plugin's SOGNI_DEFAULT_MODEL) and the default for pictures made from reference pictures (SOGNI_REFERENCE_MODEL). */
export const SOGNI_STILL_DEFAULT_MODEL = "z-turbo";
export const SOGNI_STILL_REFERENCE_MODEL = "qwen-lightning";
const SOGNI_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const SOGNI_MAX_LORAS = 8;
/** Where Sogni serves uploaded and finished pictures (the plugin's SOGNI_STORAGE_HOST_SUFFIXES / SOGNI_STORAGE_HOSTS). */
const SOGNI_STORAGE_HOST_SUFFIXES = [".s3-accelerate.amazonaws.com"];
const SOGNI_STORAGE_HOSTS = ["media.sogni.ai", "artist-upload-production.s3.us-east-1.amazonaws.com"];
const MAX_SEED = 4_294_967_295;

type Json = Record<string, unknown>;
function asJson(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

export function assertSogniStorageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Sogni gave an address that is not a web address.");
  }
  const host = url.hostname.toLowerCase();
  const ok = url.protocol === "https:" && (SOGNI_STORAGE_HOSTS.includes(host) || SOGNI_STORAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)));
  if (!ok) throw new Error("Sogni gave a picture address outside its own storage, so it was not used.");
  return url;
}

export interface SogniImageProviderOptions {
  apiKey: string;
  /** JSON calls to api.sogni.ai. */
  apiFetch: ImageFetchImpl;
  /** Byte transfers to and from Sogni's storage (addresses are checked first). */
  transferFetch: ImageFetchImpl;
  defaultModel?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class SogniImageProvider implements ImageGenerationProvider {
  readonly name = "sogni";
  constructor(private readonly options: SogniImageProviderOptions) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.options.apiKey}`, Accept: "application/json", ...extra };
  }

  private async readJson(res: Response): Promise<Json | null> {
    try {
      return asJson(JSON.parse(await res.text()));
    } catch {
      return null;
    }
  }

  private refusal(status: number, body: Json | null): Error {
    const message = asJson(body?.error)?.message ?? body?.message ?? body?.error;
    const text = typeof message === "string" && message.trim() ? `: ${message.trim().slice(0, 200)}` : "";
    if (status === 401 || status === 403) return new Error("Sogni did not accept the API key in Media Studio settings. Check it there.");
    if (status === 402) return new Error("The Sogni account does not have enough credit for this picture. Top it up at dashboard.sogni.ai.");
    if (status === 409 || status === 429) return new Error("Sogni is busy with other pictures for this account right now. Try again in a minute.");
    return new Error(`Sogni refused the picture (error ${status})${text}.`);
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const references = input.referenceImages ?? [];
    const loras = (input.loras ?? []).slice(0, SOGNI_MAX_LORAS);
    const loraArguments = loras.length > 0 ? { loras: loras.map((l) => l.id), loraStrengths: loras.map((l) => l.strength) } : {};
    const rawModel = (input.model ?? (references.length > 0 ? SOGNI_STILL_REFERENCE_MODEL : this.options.defaultModel ?? SOGNI_STILL_DEFAULT_MODEL)).trim();
    if (!SOGNI_MODEL_ID_PATTERN.test(rawModel)) throw new Error(`"${rawModel}" is not a Sogni model name (it looks like ${SOGNI_STILL_DEFAULT_MODEL}).`);

    const mediaReferences: Array<{ kind: "image"; url: string }> = [];
    for (const [index, reference] of references.entries()) {
      mediaReferences.push({ kind: "image", url: await this.uploadReference(reference, index) });
    }
    const size = { width: 1024, height: 576 }; // A 16:9 storyboard frame.
    const step: Json =
      references.length > 0
        ? {
            id: "picture",
            toolName: "edit_image",
            arguments: { prompt: input.prompt, model: rawModel, sourceImageIndex: -1, numberOfVariations: 1, ...size, ...loraArguments },
          }
        : {
            id: "picture",
            toolName: "generate_image",
            arguments: {
              prompt: input.prompt,
              model: rawModel,
              seed: typeof input.seed === "number" ? input.seed : Math.floor(Math.random() * MAX_SEED),
              numberOfVariations: 1,
              ...size,
              ...(typeof input.guidance === "number" ? { guidance: input.guidance } : {}),
              ...(input.negativePrompt?.trim() ? { negativePrompt: input.negativePrompt.trim() } : {}),
              ...loraArguments,
            },
          };
    const body: Json = {
      input: { title: "Paperclip storyboard picture", steps: [step] },
      token_type: "auto",
      app_source: "paperclip-media-studio",
      safe_content_filter: input.safeContentFilter !== false,
      ...(mediaReferences.length > 0 ? { media_references: mediaReferences } : {}),
    };
    const started = await this.options.apiFetch(`${SOGNI_API_BASE}/v1/creative-agent/workflows`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }),
      body: JSON.stringify(body),
    });
    const startedBody = await this.readJson(started);
    if (!started.ok) throw this.refusal(started.status, startedBody);
    const workflowId = asJson(asJson(startedBody?.data)?.workflow)?.workflowId;
    if (typeof workflowId !== "string" || !workflowId) throw new Error("Sogni did not say which job it started, so the picture cannot be collected.");

    const workflow = await this.waitForWorkflow(workflowId);
    const firstStep = Array.isArray(workflow.steps) ? asJson(workflow.steps[0]) : null;
    const artifact = (Array.isArray(firstStep?.artifacts) ? firstStep!.artifacts : []).map(asJson).find((a): a is Json => typeof a?.url === "string" && a.url !== "");
    if (!artifact) throw new Error("Sogni finished but sent no picture back. Try again.");
    const url = assertSogniStorageUrl(String(artifact.url));
    const res = await this.options.transferFetch(url.toString(), { method: "GET" });
    if (!res.ok) throw new Error(`The finished picture could not be fetched from Sogni (error ${res.status}). Try again.`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) throw new Error("Sogni sent an empty picture. Try again.");
    const header = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const contentType = header.startsWith("image/") ? header : "image/jpeg";
    const credits = readSogniWorkflowCredits(workflow);
    return {
      provider: this.name,
      model: rawModel,
      contentType,
      imageDataUrl: `data:${contentType};base64,${bytes.toString("base64")}`,
      sogniCredits: credits,
    };
  }

  private async waitForWorkflow(workflowId: string): Promise<Json> {
    const now = this.options.now ?? (() => Date.now());
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const deadline = now() + timeoutMs;
    const path = `${SOGNI_API_BASE}/v1/creative-agent/workflows/${encodeURIComponent(workflowId)}`;
    for (;;) {
      if (now() >= deadline) {
        await this.cancel(workflowId);
        throw new Error(`Sogni took longer than ${Math.round(timeoutMs / 1000)} seconds to make the picture, so it was stopped. Try again in a minute.`);
      }
      await sleep(this.options.pollIntervalMs ?? 2_000);
      const res = await this.options.apiFetch(path, { method: "GET", headers: this.headers() });
      const body = await this.readJson(res);
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) continue;
        await this.cancel(workflowId);
        throw this.refusal(res.status, body);
      }
      const workflow = asJson(asJson(body?.data)?.workflow) ?? {};
      const status = String(workflow.status ?? "");
      if (status === "completed" || status === "partial_failure") return workflow;
      if (status === "queued" || status === "running" || status === "") continue;
      if (status === "waiting_for_user") {
        await this.cancel(workflowId);
        const reason = String(workflow.waitingReason ?? "");
        if (reason === "safety_review_required") throw new Error("Sogni's content filter stopped this picture. Describe the shot more gently and try again.");
        if (reason === "insufficient_credit") throw new Error("The Sogni account does not have enough credit for this picture. Top it up at dashboard.sogni.ai.");
        throw new Error("Sogni paused this picture to ask something, so it was stopped. Try again.");
      }
      if (status === "cancelled") throw new Error("The picture was cancelled on Sogni before it was finished.");
      throw new Error("Sogni could not make the picture. Try again, or pick another picture model.");
    }
  }

  private async cancel(workflowId: string): Promise<void> {
    try {
      await this.options.apiFetch(`${SOGNI_API_BASE}/v1/creative-agent/workflows/${encodeURIComponent(workflowId)}/cancel`, { method: "POST", headers: this.headers() });
    } catch {
      // Best effort: the original problem is what the person needs to hear about.
    }
  }

  /** Put one reference picture (a data: URI) into Sogni's storage and return the address Sogni reads it from (the plugin's uploadReference). */
  private async uploadReference(dataUri: string, index: number): Promise<string> {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUri);
    const contentType = match?.[1]?.toLowerCase() === "image/jpg" ? "image/jpeg" : match?.[1]?.toLowerCase();
    if (!match || !contentType || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(contentType)) {
      throw new Error("Sogni takes PNG, JPEG, WebP or GIF reference pictures. Pick a picture in one of those formats.");
    }
    const bytes = Buffer.from(match[2]!, "base64");
    const slot = new URLSearchParams({ jobId: `paperclip-${crypto.randomUUID()}`, type: `contextImage${Math.min(index + 1, 16)}`, contentType }).toString();
    const upload = await this.options.apiFetch(`${SOGNI_API_BASE}/v2/image/uploadUrl?${slot}`, { method: "GET", headers: this.headers() });
    const uploadBody = await this.readJson(upload);
    if (!upload.ok) throw this.refusal(upload.status, uploadBody);
    const form = asJson(uploadBody?.data);
    if (typeof form?.url !== "string") throw new Error("Sogni did not give a place to upload the reference picture. Try again.");
    const target = assertSogniStorageUrl(form.url);
    const multipart = new FormData();
    for (const [key, value] of Object.entries(asJson(form.fields) ?? {})) {
      if (value !== undefined && value !== null) multipart.append(key, String(value));
    }
    multipart.append("file", new Blob([bytes], { type: contentType }), `reference-${index + 1}.${contentType.split("/")[1]}`);
    const stored = await this.options.transferFetch(target.toString(), { method: "POST", body: multipart });
    if (!stored.ok) throw new Error(`Sogni's storage did not take the reference picture (error ${stored.status}). Try again.`);
    const download = await this.options.apiFetch(`${SOGNI_API_BASE}/v2/image/downloadUrl?${slot}`, { method: "GET", headers: this.headers() });
    const downloadBody = await this.readJson(download);
    if (!download.ok) throw this.refusal(download.status, downloadBody);
    const url = asJson(downloadBody?.data)?.downloadUrl;
    if (typeof url !== "string") throw new Error("Sogni did not give an address for the uploaded reference picture. Try again.");
    return assertSogniStorageUrl(url).toString();
  }
}
