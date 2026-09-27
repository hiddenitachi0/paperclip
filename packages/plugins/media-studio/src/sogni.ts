// Sogni (https://docs.sogni.ai/api-reference/) as a picture provider.
//
// Contract used (docs pages in brackets):
//   Start   POST https://api.sogni.ai/v1/creative-agent/workflows          [workflows, direct-generation]
//           Authorization: Bearer <key>, Idempotency-Key: <uuid>
//           {input:{title, steps:[{id, toolName, arguments}]}, token_type, app_source, media_references?}
//           201 -> {data:{workflow:{workflowId, status}}}; 409 = too many active
//           workflows; 429 = too fast / full, wait Retry-After (header) or
//           retryAfter (body, seconds) and resend with the same key.
//   Poll    GET  /v1/creative-agent/workflows/:id -> {data:{workflow:{status, steps:[{artifacts:[{url}]}]}}}
//           status: queued | running | waiting_for_user | completed | partial_failure | failed | cancelled
//   Cancel  POST /v1/creative-agent/workflows/:id/cancel (no body)
//   Refs    GET  /v2/image/uploadUrl?jobId&type=contextImageN&contentType -> {data:{url, fields}}
//           POST multipart to data.url (every field, then the file last) -> 204
//           GET  /v2/image/downloadUrl?jobId&type&contentType -> {data:{downloadUrl}}
//           and pass that https URL as media_references[{kind:"image", url}]
//           (inline data: URIs are rejected by the workflow API). [media-upload-urls, workflows]
//
// Text-only pictures use generate_image (it takes a seed). Pictures made from
// reference pictures use edit_image with sourceImageIndex -1 (the first
// uploaded picture; the others ride along as context pictures). edit_image has
// no seed argument, so a seed cannot be applied there.
//
// Two kinds of HTTP: `apiFetch` (JSON to api.sogni.ai; the worker passes the
// host's gated ctx.http.fetch) and `transferFetch` (raw picture bytes to and
// from Sogni's presigned storage). The host's http.fetch carries bodies as
// UTF-8 text, which corrupts picture bytes and cannot send a multipart upload,
// so byte transfers go through `transferFetch` instead. Every transfer address
// is checked first: https, the storage host the docs name, no redirects.

import type { FetchImpl, GenerationInput, GenerationResult, GenerationProvider } from "./providers.js";

export const SOGNI_API_BASE = "https://api.sogni.ai";

/** Default text-to-picture model: Z-Image Turbo, Sogni's general-purpose default (~5-10 s a picture). */
export const SOGNI_DEFAULT_MODEL = "z-turbo";
/** Default model for pictures made from reference pictures: Qwen Image Edit Lightning, Sogni's fast edit default. */
export const SOGNI_REFERENCE_MODEL = "qwen-lightning";

/** generate_image models the docs and the published tool schema list. */
export const SOGNI_IMAGE_MODELS = [
  "z-turbo",
  "z-image",
  "krea-2-turbo",
  "dark-beast-krea2",
  "dark-beast-z-turbo",
  "chroma-v46-flash",
  "chroma1-hd",
  "chroma-detail",
  "qwen-2512",
  "qwen-2512-lightning",
  "gpt-image-2",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
] as const;

/** edit_image models, with how many reference pictures each takes. */
export const SOGNI_EDIT_MODELS: Record<string, number> = {
  "qwen-lightning": 3,
  qwen: 3,
  "krea-identity-edit": 2,
  "dark-beast-krea2-identity-edit": 2,
  "gpt-image-2": 16,
  "gpt-image-2.5-sunburst": 16,
  "gpt-image-2.5-flare": 16,
};

export const SOGNI_TOKEN_TYPES = ["auto", "sogni", "spark"] as const;
export type SogniTokenType = (typeof SOGNI_TOKEN_TYPES)[number];

/**
 * Where Sogni's presigned picture addresses live. The Media page of the docs
 * shows presigned upload and download URLs as
 * https://<bucket>.s3-accelerate.amazonaws.com/..., and the workflow docs say
 * result addresses are presigned and time-limited. Nothing else is fetched.
 */
export const SOGNI_STORAGE_HOST_SUFFIXES = [".s3-accelerate.amazonaws.com"] as const;

const SOGNI_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const MAX_SEED = 4_294_967_295;
const MAX_PICTURE_BYTES = 50 * 1024 * 1024;
const REFERENCE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);

export function isKnownSogniModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  return (SOGNI_IMAGE_MODELS as readonly string[]).includes(id) || id in SOGNI_EDIT_MODELS;
}

export function assertSogniModelId(model: string): string {
  const trimmed = model.trim();
  if (!SOGNI_MODEL_ID_PATTERN.test(trimmed)) {
    throw new Error(`"${model}" is not a Sogni model name (it looks like ${SOGNI_DEFAULT_MODEL}).`);
  }
  return trimmed;
}

/** The edit model used for reference pictures: the asked-for one if it can take references, else the default. */
export function sogniReferenceModel(model?: string): string {
  const id = model?.trim().toLowerCase();
  return id && id in SOGNI_EDIT_MODELS ? id : SOGNI_REFERENCE_MODEL;
}

export function sogniMaxReferences(model?: string): number {
  return SOGNI_EDIT_MODELS[sogniReferenceModel(model)] ?? 3;
}

/**
 * Fal's size names, so a look or a prompt that works with Fal works with
 * Sogni too; "1280x720" style sizes are accepted as well.
 */
const SIZE_PRESETS: Record<string, { width: number; height: number }> = {
  square_hd: { width: 1024, height: 1024 },
  square: { width: 512, height: 512 },
  portrait_4_3: { width: 768, height: 1024 },
  portrait_16_9: { width: 576, height: 1024 },
  landscape_4_3: { width: 1024, height: 768 },
  landscape_16_9: { width: 1024, height: 576 },
};
/** Fal's default size, so an unsized picture has the same shape with either provider. */
export const SOGNI_DEFAULT_SIZE = "landscape_4_3";

export function sogniSize(imageSize?: string): { width: number; height: number } {
  const wanted = (imageSize ?? SOGNI_DEFAULT_SIZE).trim().toLowerCase();
  const preset = SIZE_PRESETS[wanted];
  if (preset) return preset;
  const exact = /^(\d{3,4})\s*x\s*(\d{3,4})$/.exec(wanted);
  if (exact) {
    const width = Number(exact[1]);
    const height = Number(exact[2]);
    if (width >= 256 && width <= 2048 && height >= 256 && height <= 2048) return { width, height };
  }
  throw new Error(
    `Sogni does not know the picture size "${imageSize}". Use one of ${Object.keys(SIZE_PRESETS).join(", ")}, or a size like 1280x720 (each side 256 to 2048).`,
  );
}

/** Refuse any picture address that is not https on the storage host the Sogni docs name. */
export function assertSogniStorageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Sogni gave a picture address that is not a web address, so it was not used.");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    (url.port === "" || url.port === "443") &&
    SOGNI_STORAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
  if (!allowed) {
    throw new Error(
      `Sogni gave a picture address on ${url.protocol === "https:" ? host : `a non-https address (${host})`}, which is not Sogni's picture storage, so it was not used.`,
    );
  }
  return url;
}

export interface SogniProviderOptions {
  apiKey: string;
  /** JSON calls to api.sogni.ai (the worker passes the host's gated fetch). */
  apiFetch: FetchImpl;
  /** Raw picture bytes to and from Sogni's presigned storage (address-checked before every call). */
  transferFetch: FetchImpl;
  defaultModel?: string;
  tokenType?: SogniTokenType;
  baseUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  newId?: () => string;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function readSeed(value: unknown): number | null {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_SEED ? n : null;
}

/** Retry-After as milliseconds: the header (seconds), else the body's retryAfter (seconds). */
function retryAfterMs(res: Response, body: Json | null): number | null {
  const header = res.headers.get("retry-after");
  if (header && /^\d+(\.\d+)?$/.test(header.trim())) return Math.ceil(Number(header.trim()) * 1000);
  if (header) {
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  const fromBody = body?.retryAfter ?? asRecord(body?.details)?.retryAfterSeconds;
  return typeof fromBody === "number" && fromBody >= 0 ? Math.ceil(fromBody * 1000) : null;
}

function errorMessage(body: Json | null): string {
  const raw = body?.message ?? asRecord(body?.error)?.message ?? body?.error;
  return typeof raw === "string" ? raw.slice(0, 300) : "";
}

function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) {
    return "image/webp";
  }
  return null;
}

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;

/** The picture: steps[0].artifacts[0].url per the docs, or the workflow-level artifacts list. */
function findArtifact(workflow: Json): Json | null {
  const firstStep = Array.isArray(workflow.steps) ? asRecord(workflow.steps[0]) : null;
  const artifacts = [
    ...(Array.isArray(firstStep?.artifacts) ? firstStep.artifacts : []),
    ...(Array.isArray(workflow.artifacts) ? workflow.artifacts : []),
  ].map(asRecord);
  return artifacts.find((item) => typeof item?.url === "string" && item.url) ?? null;
}

export class SogniProvider implements GenerationProvider {
  readonly name = "sogni";
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: SogniProviderOptions) {
    this.baseUrl = (options.baseUrl ?? SOGNI_API_BASE).replace(/\/$/, "");
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.options.apiKey}`, Accept: "application/json", ...extra };
  }

  private async readJson(res: Response): Promise<Json | null> {
    try {
      return asRecord(JSON.parse(await res.text()));
    } catch {
      return null;
    }
  }

  /** The plain sentence for an answer Sogni refused. */
  private refusal(res: Response, body: Json | null): Error {
    const detail = errorMessage(body);
    if (res.status === 401 || res.status === 403) {
      return new Error("Sogni did not accept the API key. Check the Sogni key picked in Media Studio settings.");
    }
    if (res.status === 402) {
      return new Error("The Sogni account does not have enough credit for this picture. Top it up at dashboard.sogni.ai, or pick a cheaper model.");
    }
    if (res.status === 409) {
      return new Error("Sogni is busy with other pictures on this account, try again in a minute.");
    }
    if (res.status === 429) {
      return new Error("Sogni is getting too many requests right now, try again in a minute.");
    }
    if (res.status >= 500) return new Error("Sogni is having trouble right now, try again in a minute.");
    return new Error(`Sogni refused the picture request${detail ? `: ${detail}` : ` (error ${res.status})`}.`);
  }

  private remaining(deadline: number): number {
    return deadline - this.now();
  }

  /** A GET/POST to api.sogni.ai that waits out 429s (Retry-After) while time allows. */
  private async api(path: string, init: RequestInit, deadline: number): Promise<{ res: Response; body: Json | null }> {
    for (;;) {
      const res = await this.options.apiFetch(`${this.baseUrl}${path}`, init);
      const body = await this.readJson(res);
      if (res.status !== 429) return { res, body };
      const wait = retryAfterMs(res, body) ?? this.pollIntervalMs;
      if (wait > this.remaining(deadline)) throw this.refusal(res, body);
      await this.sleep(Math.max(wait, 1));
    }
  }

  async generate(input: GenerationInput): Promise<GenerationResult> {
    const deadline = this.now() + this.timeoutMs;
    const references = input.referenceImages ?? [];
    const size = sogniSize(input.imageSize);

    let step: Json;
    let model: string;
    let sentSeed: number | null = null;
    const mediaReferences: Array<{ kind: "image"; url: string }> = [];
    if (references.length > 0) {
      model = sogniReferenceModel(input.model);
      const max = sogniMaxReferences(model);
      if (references.length > max) {
        throw new Error(`Sogni's ${model} model takes at most ${max} reference pictures; this asked for ${references.length}.`);
      }
      for (const [index, reference] of references.entries()) {
        mediaReferences.push({ kind: "image", url: await this.uploadReference(reference, index, deadline) });
      }
      step = {
        id: "picture",
        toolName: "edit_image",
        arguments: {
          prompt: input.prompt,
          model,
          sourceImageIndex: -1,
          numberOfVariations: 1,
          // Without a size, Sogni keeps the first reference picture's shape.
          ...(input.imageSize ? size : {}),
        },
      };
    } else {
      model = assertSogniModelId(input.model ?? this.options.defaultModel ?? SOGNI_DEFAULT_MODEL);
      // Always send a seed, so the seed of every picture is known and can be reused.
      sentSeed = typeof input.seed === "number" ? input.seed : Math.floor(Math.random() * MAX_SEED);
      step = {
        id: "picture",
        toolName: "generate_image",
        arguments: { prompt: input.prompt, model, seed: sentSeed, numberOfVariations: 1, ...size },
      };
    }

    const body: Json = {
      input: { title: "Paperclip picture", steps: [step] },
      token_type: this.options.tokenType ?? "auto",
      app_source: "paperclip-media-studio",
      ...(mediaReferences.length > 0 ? { media_references: mediaReferences } : {}),
    };
    // The same key on every retry of this start, so a retry never starts a second (paid) picture.
    const idempotencyKey = this.newId();
    const started = await this.api(
      "/v1/creative-agent/workflows",
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }),
        body: JSON.stringify(body),
      },
      deadline,
    );
    if (!started.res.ok) throw this.refusal(started.res, started.body);
    const workflowId = asRecord(asRecord(started.body?.data)?.workflow)?.workflowId;
    if (typeof workflowId !== "string" || !workflowId) throw new Error("Sogni did not say which job it started, so the picture cannot be collected.");

    const workflow = await this.waitForWorkflow(workflowId, deadline);
    const firstStep = Array.isArray(workflow.steps) ? asRecord(workflow.steps[0]) : null;
    const artifact = findArtifact(workflow);
    if (!artifact) throw new Error("Sogni finished but sent no picture back. Try again.");

    const picture = await this.download(String(artifact.url), artifact);
    const reportedSeed =
      readSeed(artifact.seed) ??
      readSeed(asRecord(artifact.metadata)?.seed) ??
      readSeed(firstStep?.seed) ??
      readSeed(asRecord(firstStep?.arguments)?.seed);
    const seed = reportedSeed ?? sentSeed;
    const seedNotUsed = references.length > 0 && typeof input.seed === "number";
    return {
      provider: this.name,
      model,
      contentType: picture.contentType,
      imageDataUrl: `data:${picture.contentType};base64,${picture.bytes.toString("base64")}`,
      seed,
      meta: { seed, workflowId, ...(seedNotUsed ? { seedNotUsed: true } : {}) },
    };
  }

  private async waitForWorkflow(workflowId: string, deadline: number): Promise<Json> {
    const path = `/v1/creative-agent/workflows/${encodeURIComponent(workflowId)}`;
    for (;;) {
      const left = this.remaining(deadline);
      if (left <= 0) {
        await this.cancel(workflowId);
        throw new Error(
          `Sogni took longer than ${Math.round(this.timeoutMs / 1000)} seconds to make the picture, so it was stopped. Try again in a minute.`,
        );
      }
      await this.sleep(Math.min(this.pollIntervalMs, left));
      let polled: { res: Response; body: Json | null };
      try {
        polled = await this.api(path, { method: "GET", headers: this.headers() }, deadline);
      } catch (err) {
        await this.cancel(workflowId);
        throw err;
      }
      if (!polled.res.ok) {
        if (polled.res.status >= 500) continue; // Sogni says retry; not a lost picture.
        await this.cancel(workflowId);
        throw this.refusal(polled.res, polled.body);
      }
      const workflow = asRecord(asRecord(polled.body?.data)?.workflow) ?? {};
      const status = String(workflow.status ?? "");
      if (status === "completed") return workflow;
      if (status === "queued" || status === "running" || status === "") continue;
      if (status === "partial_failure" && findArtifact(workflow)) return workflow;
      if (status === "waiting_for_user") {
        await this.cancel(workflowId);
        throw new Error(this.pausedSentence(String(workflow.waitingReason ?? "")));
      }
      if (status === "cancelled") throw new Error("The picture was cancelled on Sogni before it was finished.");
      const reason = this.failureReason(workflow);
      throw new Error(`Sogni could not make the picture${reason ? `: ${reason}` : ""}.`);
    }
  }

  private pausedSentence(reason: string): string {
    if (reason === "safety_review_required") {
      return "Sogni's content filter stopped this picture. Describe it more gently and try again.";
    }
    if (reason === "insufficient_credit") {
      return "The Sogni account does not have enough credit for this picture. Top it up at dashboard.sogni.ai.";
    }
    if (reason === "cost_approval_required" || reason === "cost_reauthorization_required") {
      return "Sogni wanted the cost of this picture approved first, so it was stopped. Try again, or pick a cheaper model.";
    }
    return "Sogni paused this picture to ask something, so it was stopped. Try again with a clearer description.";
  }

  private failureReason(workflow: Json): string {
    const steps = Array.isArray(workflow.steps) ? workflow.steps.map(asRecord) : [];
    for (const candidate of [workflow.error, ...steps.map((s) => s?.error)]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 200);
      const message = asRecord(candidate)?.message;
      if (typeof message === "string" && message.trim()) return message.trim().slice(0, 200);
    }
    return "";
  }

  /** Best effort: stop the job on Sogni so it does not keep a slot or spend more. */
  private async cancel(workflowId: string): Promise<void> {
    try {
      await this.options.apiFetch(`${this.baseUrl}/v1/creative-agent/workflows/${encodeURIComponent(workflowId)}/cancel`, {
        method: "POST",
        headers: this.headers(),
      });
    } catch {
      // The original problem is what the person needs to hear about.
    }
  }

  /**
   * Put one reference picture (a data: URI) into Sogni's storage and return
   * the presigned https address Sogni's workflow reads it from. No Paperclip
   * address is ever sent.
   */
  private async uploadReference(dataUri: string, index: number, deadline: number): Promise<string> {
    const match = DATA_URI.exec(dataUri);
    const contentType = match?.[1]?.toLowerCase() === "image/jpg" ? "image/jpeg" : match?.[1]?.toLowerCase();
    if (!match || !contentType || !REFERENCE_CONTENT_TYPES.has(contentType)) {
      throw new Error("Sogni takes PNG, JPEG, WebP or GIF reference pictures. Pick a picture in one of those formats.");
    }
    const bytes = Buffer.from(match[2]!, "base64");
    const slot = new URLSearchParams({
      jobId: `paperclip-${this.newId()}`,
      type: `contextImage${Math.min(index + 1, 16)}`,
      contentType,
    }).toString();

    const upload = await this.api(`/v2/image/uploadUrl?${slot}`, { method: "GET", headers: this.headers() }, deadline);
    if (!upload.res.ok) throw this.refusal(upload.res, upload.body);
    const form = asRecord(upload.body?.data);
    if (typeof form?.url !== "string") throw new Error("Sogni did not give a place to upload the reference picture. Try again.");
    const target = assertSogniStorageUrl(form.url);

    const multipart = new FormData();
    for (const [key, value] of Object.entries(asRecord(form.fields) ?? {})) {
      if (value !== undefined && value !== null) multipart.append(key, String(value));
    }
    multipart.append("file", new Blob([bytes], { type: contentType }), `reference-${index + 1}.${contentType.split("/")[1]}`);
    const stored = await this.options.transferFetch(target.toString(), { method: "POST", body: multipart });
    if (!stored.ok) throw new Error(`Sogni's storage did not take the reference picture (error ${stored.status}). Try again.`);

    const download = await this.api(`/v2/image/downloadUrl?${slot}`, { method: "GET", headers: this.headers() }, deadline);
    if (!download.res.ok) throw this.refusal(download.res, download.body);
    const url = asRecord(download.body?.data)?.downloadUrl;
    if (typeof url !== "string") throw new Error("Sogni did not give an address for the uploaded reference picture. Try again.");
    return assertSogniStorageUrl(url).toString();
  }

  private async download(rawUrl: string, artifact: Json | null): Promise<{ bytes: Buffer; contentType: string }> {
    const url = assertSogniStorageUrl(rawUrl);
    const res = await this.options.transferFetch(url.toString(), { method: "GET" });
    if (!res.ok) throw new Error(`The finished picture could not be fetched from Sogni (error ${res.status}). Try again.`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_PICTURE_BYTES) throw new Error("Sogni's picture is too large to keep.");
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) throw new Error("Sogni sent an empty picture. Try again.");
    if (bytes.length > MAX_PICTURE_BYTES) throw new Error("Sogni's picture is too large to keep.");
    const header = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const declaredType = [artifact?.mimeType, artifact?.contentType].find((v): v is string => typeof v === "string");
    const contentType = header.startsWith("image/")
      ? header
      : (declaredType?.toLowerCase().startsWith("image/") ? declaredType.toLowerCase() : null) ?? sniffImageType(bytes) ?? header;
    return { bytes, contentType };
  }
}

/**
 * The byte-transfer fetch the worker uses for Sogni's storage: the platform
 * fetch with redirects refused and a time limit. Callers check the address
 * (assertSogniStorageUrl) before every call.
 */
export const guardedTransferFetch: FetchImpl = (url, init) =>
  globalThis.fetch(assertSogniStorageUrl(url).toString(), { ...init, redirect: "error", signal: AbortSignal.timeout(60_000) });
