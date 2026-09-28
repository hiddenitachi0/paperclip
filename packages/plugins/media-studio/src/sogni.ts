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
// Models: the workflow's `model` argument is a tool key ("z-turbo") or a raw
// catalog model id ("dark_beast_z_image_turbo_v9_bf16"). The published tool
// schema lists the keys; Sogni's own client resolves keys to catalog ids and
// passes any other id through unchanged (sogni-client Chat/modelRouting.js,
// resolveHostedToolModelSelector; the argument validator skips the enum on
// `model`). So a known model is sent by its key and any other catalog model
// by its id. The live list of models is GET /v1/model-catalog (sogni-catalog.ts).
//
// LoRAs: step arguments `loras` (ids, in order, 1-8) and `loraStrengths`
// (same length, positional) on generate_image and edit_image. Sensitive
// Content Filter: the workflow-level body field `safe_content_filter`
// (default true; one setting for the whole workflow, not per step).
// [creative-agent-workflows "LoRA Steps" and "Sensitive Content Filter";
// @sogni-ai/sogni-intelligence-client 4.6.2 schemas/tools/generate_image
// and edit_image, additionalProperties false.]
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

/**
 * generate_image tool keys and the catalog model each one runs, from Sogni's
 * own client (@sogni-ai/sogni-client 5.58.0, Chat/modelRouting.js
 * IMAGE_MODEL_SELECTORS, limited to the keys the published tool schema lists).
 */
export const SOGNI_GENERATE_TOOL_KEYS: Record<string, string> = {
  "z-turbo": "z_image_turbo_bf16",
  "z-image": "z_image_bf16",
  "krea-2-turbo": "krea2_turbo_fp8_scaled",
  "dark-beast-krea2": "dark_beast_krea2_fp8",
  "dark-beast-z-turbo": "dark_beast_z_image_turbo_v9_bf16",
  "chroma-v46-flash": "chroma-v.46-flash_fp8",
  "chroma1-hd": "chroma1-hd_fp8_scaled",
  "chroma-detail": "chroma-v48-detail-svd_fp8",
  "qwen-2512": "qwen_image_2512_fp8",
  "qwen-2512-lightning": "qwen_image_2512_fp8_lightning",
  "gpt-image-2": "gpt-image-2",
  "gpt-image-2.5-sunburst": "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare": "gpt-image-2.5-flare",
  "one-obsession-v22": "one_obsession_v22_fp16",
  "pony-v7": "coreml-cyberrealisticPony_v7",
  "albedo-xl": "coreml-albedobaseXL_v31Large",
  "animagine-xl": "coreml-animagineXL40_v4Opt",
  "anima-pencil-xl": "coreml-animaPencilXL_v500",
  "art-universe-xl": "coreml-artUniverse_sdxlV60",
  "hyphoria-real": "coreml-hyphoriaRealIllu_v05",
  "analog-madness-xl": "coreml-analogMadnessSDXL_xl2",
  "cyberrealistic-xl": "coreml-cyberrealisticXL_v60",
  "real-dream-xl": "coreml-realDream_sdxlPony11",
  "faetastic-xl": "coreml-sdxlFaetastic_v24",
  "zavychroma-xl": "coreml-zavychromaxl_v80",
  "pony-faetality": "coreml-ponyFaetality_v11",
  "dreamshaper-xl": "coreml-DreamShaper-XL1-Alpha2",
};

/** edit_image tool keys and their catalog models (same source, EDIT_IMAGE_MODEL_SELECTORS). */
export const SOGNI_EDIT_TOOL_KEYS: Record<string, string> = {
  "qwen-lightning": "qwen_image_edit_2511_fp8_lightning",
  qwen: "qwen_image_edit_2511_fp8",
  "krea-identity-edit": "krea2_identity_edit_v1_2",
  "dark-beast-krea2-identity-edit": "dark_beast_krea2_identity_edit_v1_2",
  "gpt-image-2": "gpt-image-2",
  "gpt-image-2.5-sunburst": "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare": "gpt-image-2.5-flare",
};

export type SogniTool = "generate_image" | "edit_image";

/** A tool key ("z-turbo") becomes its catalog model id; anything else is returned trimmed. */
export function sogniCanonicalModelId(model: string): string {
  const trimmed = model.trim();
  const key = trimmed.toLowerCase();
  return SOGNI_GENERATE_TOOL_KEYS[key] ?? SOGNI_EDIT_TOOL_KEYS[key] ?? trimmed;
}

/** What goes in a step's `model` argument: the tool's key when it has one, else the catalog id. */
export function sogniWorkflowModel(model: string, tool: SogniTool): string {
  const canonical = sogniCanonicalModelId(model);
  const keys = tool === "edit_image" ? SOGNI_EDIT_TOOL_KEYS : SOGNI_GENERATE_TOOL_KEYS;
  const key = Object.keys(keys).find((k) => keys[k] === canonical);
  return key ?? canonical;
}

/** At most this many LoRAs on one picture (Sogni's limit, also advertised as constraints.maxPerRequest). */
export const SOGNI_MAX_LORAS = 8;

export interface SogniLoraPick {
  id: string;
  strength: number;
}

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

const KNOWN_CANONICAL_IDS = new Set([...Object.values(SOGNI_GENERATE_TOOL_KEYS), ...Object.values(SOGNI_EDIT_TOOL_KEYS)]);

/** A Sogni tool key, or the catalog id of one (the live catalog knows many more; see sogni-catalog.ts). */
export function isKnownSogniModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  return (
    (SOGNI_IMAGE_MODELS as readonly string[]).includes(id) ||
    id in SOGNI_EDIT_MODELS ||
    id in SOGNI_GENERATE_TOOL_KEYS ||
    KNOWN_CANONICAL_IDS.has(model.trim())
  );
}

export function assertSogniModelId(model: string): string {
  const trimmed = model.trim();
  if (!SOGNI_MODEL_ID_PATTERN.test(trimmed)) {
    throw new Error(`"${model}" is not a Sogni model name (it looks like ${SOGNI_DEFAULT_MODEL}).`);
  }
  return trimmed;
}

/**
 * The edit model used for reference pictures: the asked-for one if it can
 * take references (a known edit model, or one the catalog says edits
 * pictures: `takesReferences`), else the default edit model.
 */
export function sogniReferenceModel(model?: string, takesReferences = false): string {
  if (!model?.trim()) return SOGNI_REFERENCE_MODEL;
  const edit = sogniWorkflowModel(model, "edit_image");
  if (edit in SOGNI_EDIT_MODELS) return edit;
  return takesReferences ? sogniCanonicalModelId(model) : SOGNI_REFERENCE_MODEL;
}

/** How many reference pictures the chosen edit model takes (3 for an edit model Sogni's docs give no number for). */
export function sogniMaxReferences(model?: string, takesReferences = false): number {
  return SOGNI_EDIT_MODELS[sogniReferenceModel(model, takesReferences)] ?? 3;
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

/** The sides a model takes (from the catalog's width/height ranges); 256-2048 when unknown. */
export interface SogniSizeBounds {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
}

export const SOGNI_DEFAULT_SIZE_BOUNDS: SogniSizeBounds = { minWidth: 256, maxWidth: 2048, minHeight: 256, maxHeight: 2048 };

export function sogniSize(imageSize?: string, bounds: SogniSizeBounds = SOGNI_DEFAULT_SIZE_BOUNDS): { width: number; height: number } {
  const wanted = (imageSize ?? SOGNI_DEFAULT_SIZE).trim().toLowerCase();
  const preset = SIZE_PRESETS[wanted];
  if (preset) return preset;
  const exact = /^(\d{3,4})\s*x\s*(\d{3,4})$/.exec(wanted);
  if (exact) {
    const width = Number(exact[1]);
    const height = Number(exact[2]);
    if (width >= bounds.minWidth && width <= bounds.maxWidth && height >= bounds.minHeight && height <= bounds.maxHeight) {
      return { width, height };
    }
  }
  const sides =
    bounds.minWidth === bounds.minHeight && bounds.maxWidth === bounds.maxHeight
      ? `each side ${bounds.minWidth} to ${bounds.maxWidth}`
      : `width ${bounds.minWidth} to ${bounds.maxWidth}, height ${bounds.minHeight} to ${bounds.maxHeight}`;
  throw new Error(
    `Sogni does not know the picture size "${imageSize}". Use one of ${Object.keys(SIZE_PRESETS).join(", ")}, or a size like 1280x720 (${sides}).`,
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

/** How long a synchronous Sogni tool (tools/execute) may take, 429 waits included. */
export const SOGNI_EXECUTE_TIMEOUT_MS = 60_000;

/** A picture one of Sogni's picture tools made. */
export interface SogniToolPicture {
  contentType: string;
  contentBase64: string;
  workflowId: string;
  /** How many pictures Sogni sent back (only the first is kept). */
  artifactCount: number;
}

/** Picture types Sogni's storage takes for an uploaded picture. */
export function isSogniUploadType(contentType: string): boolean {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return REFERENCE_CONTENT_TYPES.has(type === "image/jpg" ? "image/jpeg" : type);
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

/**
 * The pictures: steps[0].artifacts[].url per the docs, else the
 * workflow-level artifacts list (the same pictures, when both are given).
 */
function pictureArtifacts(workflow: Json): Json[] {
  const firstStep = Array.isArray(workflow.steps) ? asRecord(workflow.steps[0]) : null;
  const withUrl = (list: unknown) =>
    (Array.isArray(list) ? list : []).map(asRecord).filter((item): item is Json => typeof item?.url === "string" && item.url !== "");
  const fromStep = withUrl(firstStep?.artifacts);
  return fromStep.length > 0 ? fromStep : withUrl(workflow.artifacts);
}

function findArtifact(workflow: Json): Json | null {
  return pictureArtifacts(workflow)[0] ?? null;
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
  private refusal(res: Response, body: Json | null, what = "picture request"): Error {
    const detail = errorMessage(body);
    if (res.status === 401 || res.status === 403) {
      return new Error("Sogni did not accept the API key. Check the Sogni key picked in Media Studio settings.");
    }
    if (res.status === 402) {
      return new Error(
        what === "picture request"
          ? "The Sogni account does not have enough credit for this picture. Top it up at dashboard.sogni.ai, or pick a cheaper model."
          : "The Sogni account does not have enough credit for this. Top it up at dashboard.sogni.ai.",
      );
    }
    if (res.status === 409) {
      return new Error("Sogni is busy with other pictures on this account, try again in a minute.");
    }
    if (res.status === 429) {
      return new Error("Sogni is getting too many requests right now, try again in a minute.");
    }
    if (res.status >= 500) return new Error("Sogni is having trouble right now, try again in a minute.");
    return new Error(`Sogni refused the ${what}${detail ? `: ${detail}` : ` (error ${res.status})`}.`);
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
    const timeoutMs = input.timeoutMs ?? this.timeoutMs;
    const deadline = this.now() + timeoutMs;
    const references = input.referenceImages ?? [];
    const size = sogniSize(input.imageSize, input.sizeBounds);

    let step: Json;
    let model: string;
    let sentSeed: number | null = null;
    const mediaReferences: Array<{ kind: "image"; url: string }> = [];
    const loras = (input.loras ?? []).slice(0, SOGNI_MAX_LORAS);
    const loraArguments =
      loras.length > 0 ? { loras: loras.map((lora) => lora.id), loraStrengths: loras.map((lora) => lora.strength) } : {};
    if (references.length > 0) {
      model = sogniReferenceModel(input.model, input.modelTakesReferences === true);
      const max = sogniMaxReferences(model, input.modelTakesReferences === true);
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
          // edit_image takes loras/loraStrengths but no guidance or negativePrompt.
          ...loraArguments,
        },
      };
    } else {
      model = sogniWorkflowModel(
        assertSogniModelId(input.model ?? this.options.defaultModel ?? SOGNI_DEFAULT_MODEL),
        "generate_image",
      );
      // Always send a seed, so the seed of every picture is known and can be reused.
      sentSeed = typeof input.seed === "number" ? input.seed : Math.floor(Math.random() * MAX_SEED);
      step = {
        id: "picture",
        toolName: "generate_image",
        arguments: {
          prompt: input.prompt,
          model,
          seed: sentSeed,
          numberOfVariations: 1,
          ...size,
          ...(typeof input.guidance === "number" ? { guidance: input.guidance } : {}),
          ...(input.negativePrompt?.trim() ? { negativePrompt: input.negativePrompt.trim() } : {}),
          ...loraArguments,
        },
      };
    }

    const { workflowId, firstStep, artifact, picture } = await this.runWorkflow(
      "Paperclip picture",
      step,
      mediaReferences,
      input.safeContentFilter !== false,
      deadline,
      timeoutMs,
    );
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
      meta: {
        seed,
        workflowId,
        ...(seedNotUsed ? { seedNotUsed: true } : {}),
        ...(loras.length > 0 ? { loras: loras.map((lora) => lora.id) } : {}),
        ...(input.safeContentFilter === false ? { contentFilter: "off" } : {}),
      },
    };
  }

  /**
   * One of Sogni's picture tools (upscale_image, remove_background, ...) as a
   * one-step workflow on the given pictures (data: URIs, uploaded to Sogni's
   * storage first; the step's sourceImageIndex -1 is the first of them).
   * The arguments must already be checked against Sogni's schema.
   */
  async runPictureTool(request: {
    toolName: string;
    arguments: Json;
    pictures: string[];
    /** Only an owner/admin-saved look may turn it off; the tools never do. */
    safeContentFilter?: boolean;
  }): Promise<SogniToolPicture> {
    const deadline = this.now() + this.timeoutMs;
    const mediaReferences: Array<{ kind: "image"; url: string }> = [];
    for (const [index, picture] of request.pictures.entries()) {
      mediaReferences.push({ kind: "image", url: await this.uploadReference(picture, index, deadline) });
    }
    const step: Json = { id: "picture", toolName: request.toolName, arguments: request.arguments };
    const { workflowId, picture, artifactCount } = await this.runWorkflow(
      `Paperclip ${request.toolName}`,
      step,
      mediaReferences,
      request.safeContentFilter !== false,
      deadline,
      this.timeoutMs,
    );
    return { contentType: picture.contentType, contentBase64: picture.bytes.toString("base64"), workflowId, artifactCount };
  }

  /**
   * One of Sogni's synchronous tools (enhance_prompt) on
   * POST /v1/creative-agent/tools/execute. Returns the tool's text.
   */
  async executeTool(tool: string, args: Json, safeContentFilter = true): Promise<{ text: string; result: Json }> {
    const deadline = this.now() + SOGNI_EXECUTE_TIMEOUT_MS;
    const answer = await this.api(
      "/v1/creative-agent/tools/execute",
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          tool,
          arguments: args,
          token_type: this.options.tokenType ?? "auto",
          app_source: "paperclip-media-studio",
          safe_content_filter: safeContentFilter,
        }),
      },
      deadline,
    );
    if (!answer.res.ok) throw this.refusal(answer.res, answer.body, "request");
    const data = asRecord(answer.body?.data);
    const result = asRecord(data?.result) ?? {};
    if (result.ok === false || result.success === false) {
      const message = typeof result.message === "string" ? result.message.trim().slice(0, 300).replace(/[.!\s]+$/, "") : "";
      const why = message ? `: ${message}` : "";
      throw new Error(`Sogni could not do that${why}.`);
    }
    const text = [result.prompt, result.message, data?.message].find((v): v is string => typeof v === "string" && v.trim() !== "");
    if (!text) throw new Error("Sogni answered but sent no text back. Try again.");
    return { text: text.trim(), result };
  }

  /** Start a one-step workflow, wait for it, and download its first picture. */
  private async runWorkflow(
    title: string,
    step: Json,
    mediaReferences: Array<{ kind: "image"; url: string }>,
    safeContentFilter: boolean,
    deadline: number,
    timeoutMs: number,
  ): Promise<{ workflowId: string; firstStep: Json | null; artifact: Json; picture: { bytes: Buffer; contentType: string }; artifactCount: number }> {
    const body: Json = {
      input: { title, steps: [step] },
      token_type: this.options.tokenType ?? "auto",
      app_source: "paperclip-media-studio",
      // Always said out loud: on, unless an owner/admin saved a look with it off.
      safe_content_filter: safeContentFilter,
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

    const workflow = await this.waitForWorkflow(workflowId, deadline, timeoutMs);
    const firstStep = Array.isArray(workflow.steps) ? asRecord(workflow.steps[0]) : null;
    const artifacts = pictureArtifacts(workflow);
    const artifact = artifacts[0];
    if (!artifact) throw new Error("Sogni finished but sent no picture back. Try again.");
    const picture = await this.download(String(artifact.url), artifact);
    return { workflowId, firstStep, artifact, picture, artifactCount: artifacts.length };
  }

  private async waitForWorkflow(workflowId: string, deadline: number, timeoutMs: number): Promise<Json> {
    const path = `/v1/creative-agent/workflows/${encodeURIComponent(workflowId)}`;
    for (;;) {
      const left = this.remaining(deadline);
      if (left <= 0) {
        await this.cancel(workflowId);
        throw new Error(
          `Sogni took longer than ${Math.round(timeoutMs / 1000)} seconds to make the picture, so it was stopped. Try again in a minute.`,
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
