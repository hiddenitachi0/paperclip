// Self-contained image-generation providers behind one interface.
// The provider is chosen by operator config (or per call / per look); `fetchImpl` is injected so the
// worker can route outbound calls through the gated `ctx.http.fetch`.
//
// Contracts:
//   Fal.ai sync:  POST https://fal.run/{model}  header  Authorization: Key <FAL_KEY>
//                 body {prompt, image_size, num_images}  ->  {images:[{url,content_type}]}
//   ComfyUI:      POST {COMFYUI_URL}/prompt {prompt:<workflow>, client_id} -> {prompt_id}
//                 poll GET /history/{prompt_id} ; GET /view?filename=&subfolder=&type=
//   Sogni:        see sogni.ts (durable workflow: start, poll, download)

import {
  SogniProvider,
  isKnownSogniModel,
  type SogniSizeBounds,
  type SogniTokenType,
} from "./sogni.js";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** The two paid picture services a call or a look can pick between. */
export const PICTURE_SERVICES = ["fal", "sogni"] as const;
export type PictureService = (typeof PICTURE_SERVICES)[number];

export function isPictureService(value: unknown): value is PictureService {
  return value === "fal" || value === "sogni";
}

/**
 * Which service a model name belongs to: a known Sogni model, or a Fal model
 * path (Fal names always have a slash, like fal-ai/flux/schnell). Anything
 * else is left to the chosen service.
 */
export function serviceForModel(model: string | null | undefined): PictureService | null {
  if (!model?.trim()) return null;
  if (isKnownSogniModel(model)) return "sogni";
  if (model.includes("/")) return "fal";
  return null;
}

export interface GenerationInput {
  prompt: string;
  imageSize?: string;
  model?: string;
  /** Which service makes this picture (a per-call choice or a look's); settings decide when absent. */
  provider?: string;
  /** Fixed seed: the same seed + prompt + model gives (nearly) the same picture. */
  seed?: number;
  /**
   * Reference pictures as base64 data: URIs (never a Paperclip URL: those are
   * private to this box). When given, Fal uses a model that keeps the same
   * person/product/style as these pictures.
   */
  referenceImages?: string[];
  /**
   * Sogni only, set by the worker from a saved look after checking them
   * against Sogni's catalog (never straight from an agent's input):
   */
  /** LoRAs to apply, in order, each with its strength. */
  loras?: Array<{ id: string; strength: number }>;
  /** Guidance override (generate_image only). */
  guidance?: number;
  /** Things to keep out of the picture (generate_image only). */
  negativePrompt?: string;
  /** The model can make a picture from reference pictures (the catalog says it edits pictures). */
  modelTakesReferences?: boolean;
  /** How many reference pictures the chosen edit model takes, from Sogni's catalog (the worker checks it first). */
  maxReferences?: number;
  /** Sogni's Sensitive Content Filter. Only an owner/admin-saved look can set false; anything else is on. */
  safeContentFilter?: boolean;
  /** The picture sizes the chosen model takes (from Sogni's catalog). */
  sizeBounds?: SogniSizeBounds;
  /** Fal text-to-picture only: how many denoising steps (Fal's num_inference_steps). Quick pictures use few. */
  steps?: number;
  /** How long this one picture may take before it is given up (Sogni stops its job). The provider's own limit otherwise. */
  timeoutMs?: number;
}

/**
 * The Fal model used when reference pictures are given: FLUX.1 Kontext [pro]
 * "multi", which takes 1+ pictures as `image_urls` (data URIs accepted) and
 * keeps their identity/look while following the prompt. The plain text-to-
 * image models (flux/schnell, flux/dev) ignore reference pictures.
 */
export const FAL_REFERENCE_MODEL = "fal-ai/flux-pro/kontext/multi";

/** A Fal model id: path segments of letters, digits, dots, dashes, underscores. Never a URL. */
const FAL_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i;

export function assertFalModelId(model: string): string {
  const trimmed = model.trim();
  if (!FAL_MODEL_ID_PATTERN.test(trimmed) || trimmed.includes("..") || trimmed.length > 200) {
    throw new Error(`"${model}" is not a Fal model name (it looks like fal-ai/flux/schnell).`);
  }
  return trimmed;
}

/**
 * Fal's image_size: one of its size names, or {width, height} for an exact
 * "640x480" size (Fal's schema takes either).
 */
export function falImageSize(imageSize?: string): string | { width: number; height: number } {
  const wanted = imageSize?.trim() || "landscape_4_3";
  const exact = /^(\d{2,4})\s*x\s*(\d{2,4})$/i.exec(wanted);
  return exact ? { width: Number(exact[1]), height: Number(exact[2]) } : wanted;
}

/** The largest seed Fal and ComfyUI accept (unsigned 32-bit). */
export const MAX_SEED = 4_294_967_295;

export interface GenerationResult {
  provider: string;
  model?: string;
  contentType: string;
  /** Remote https URL (fal) — safe to persist as work-product `url`. */
  imageUrl?: string;
  /** Inline bytes as a data: URL (mock/comfyui) — stored in work-product metadata. */
  imageDataUrl?: string;
  /** The seed the provider actually used, when it reports one. */
  seed?: number | null;
  meta?: Record<string, unknown>;
}

export interface GenerationProvider {
  readonly name: string;
  generate(input: GenerationInput): Promise<GenerationResult>;
}

export class FalProvider implements GenerationProvider {
  readonly name = "fal";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchImpl,
    private readonly defaultModel = "fal-ai/flux/schnell",
    private readonly baseUrl = "https://fal.run",
  ) {}

  async generate(input: GenerationInput): Promise<GenerationResult> {
    const references = input.referenceImages ?? [];
    const model = assertFalModelId(input.model ?? (references.length > 0 ? FAL_REFERENCE_MODEL : this.defaultModel));
    const body: Record<string, unknown> =
      references.length > 0
        ? {
            // FLUX Kontext: the pictures to keep, plus what to do with them.
            prompt: input.prompt,
            image_urls: references,
            num_images: 1,
            output_format: "jpeg",
            safety_tolerance: "2",
          }
        : {
            prompt: input.prompt,
            image_size: falImageSize(input.imageSize),
            num_images: 1,
            enable_safety_checker: true,
            ...(typeof input.steps === "number" ? { num_inference_steps: input.steps } : {}),
          };
    if (typeof input.seed === "number") body.seed = input.seed;
    const res = await this.fetchImpl(`${this.baseUrl}/${model}`, {
      method: "POST",
      headers: { Authorization: `Key ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fal.ai ${model} failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { images?: Array<{ url: string; content_type?: string }>; seed?: number };
    const image = data.images?.[0];
    if (!image?.url) throw new Error("fal.ai returned no image");
    const seed = typeof data.seed === "number" ? data.seed : (input.seed ?? null);
    const base = { provider: this.name, model, contentType: image.content_type ?? "image/jpeg", seed, meta: { seed } };
    // Fal answers with an https URL on its own CDN (or, rarely, inline bytes).
    if (/^data:/i.test(image.url)) return { ...base, imageDataUrl: image.url };
    if (!/^https:\/\//i.test(image.url)) throw new Error("fal.ai returned an image address that is not https");
    return { ...base, imageUrl: image.url };
  }
}

export class ComfyUIProvider implements GenerationProvider {
  readonly name = "comfyui";
  constructor(
    private readonly baseUrl: string,
    private readonly workflowTemplate: Record<string, unknown>,
    private readonly fetchImpl: FetchImpl,
    private readonly pollIntervalMs = 1500,
    private readonly timeoutMs = 120_000,
  ) {}

  async generate(input: GenerationInput): Promise<GenerationResult> {
    if ((input.referenceImages ?? []).length > 0) {
      throw new Error("Reference pictures need Fal.ai or Sogni. Switch Media Studio to one of them in its settings.");
    }
    const base = this.baseUrl.replace(/\/$/, "");
    const seed = typeof input.seed === "number" ? input.seed : Math.floor(Math.random() * MAX_SEED);
    // A workflow that wants a seed says so with "%SEED%" (the quoted
    // placeholder becomes the number); one without it keeps its own.
    const templateText = JSON.stringify(this.workflowTemplate);
    const usesSeed = templateText.includes('"%SEED%"');
    const workflow = JSON.parse(
      templateText
        .replaceAll("%PROMPT%", input.prompt.replace(/"/g, '\\"'))
        .replaceAll('"%SEED%"', String(seed)),
    );
    const submit = await this.fetchImpl(`${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: `paperclip-${Date.now()}` }),
    });
    if (!submit.ok) throw new Error(`ComfyUI /prompt failed (${submit.status}): ${await submit.text()}`);
    const { prompt_id: promptId } = (await submit.json()) as { prompt_id: string };

    const started = Date.now();
    for (;;) {
      if (Date.now() - started > this.timeoutMs) throw new Error("ComfyUI generation timed out");
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const hist = await this.fetchImpl(`${base}/history/${promptId}`);
      if (!hist.ok) continue;
      const history = (await hist.json()) as Record<
        string,
        { outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> }
      >;
      const entry = history[promptId];
      const image = entry && Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
      if (!image) continue;
      const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
      const view = await this.fetchImpl(`${base}/view?${q.toString()}`);
      if (!view.ok) throw new Error(`ComfyUI /view failed (${view.status})`);
      const bytes = Buffer.from(await view.arrayBuffer());
      const contentType = view.headers.get("content-type") ?? "image/png";
      return {
        provider: this.name,
        contentType,
        imageDataUrl: `data:${contentType};base64,${bytes.toString("base64")}`,
        seed: usesSeed ? seed : null,
        meta: { promptId, filename: image.filename },
      };
    }
  }
}

/** Keyless placeholder generator so the whole flow is testable without a GPU/key. */
export class MockProvider implements GenerationProvider {
  readonly name = "mock";
  async generate(input: GenerationInput): Promise<GenerationResult> {
    const label = input.prompt.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string).slice(0, 48);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">` +
      `<rect width="100%" height="100%" fill="#0b7285"/>` +
      `<text x="50%" y="46%" fill="#e3fafc" font-family="sans-serif" font-size="16" text-anchor="middle">mock preview</text>` +
      `<text x="50%" y="56%" fill="#fff" font-family="sans-serif" font-size="20" text-anchor="middle">${label}</text></svg>`;
    const seed = typeof input.seed === "number" ? input.seed : Math.floor(Math.random() * MAX_SEED);
    return {
      provider: this.name,
      model: input.model,
      contentType: "image/svg+xml",
      imageDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      seed,
      meta: { mock: true, seed, referenceCount: (input.referenceImages ?? []).length },
    };
  }
}

export interface ProviderConfig {
  provider?: string;
  falKey?: string;
  falModel?: string;
  comfyUrl?: string;
  comfyWorkflow?: Record<string, unknown>;
  sogniKey?: string;
  sogniModel?: string;
  sogniTokenType?: SogniTokenType;
  /** Byte transfers to and from Sogni's storage (see sogni.ts for why this is not the host fetch). */
  sogniTransferFetch?: FetchImpl;
}

export function selectProvider(config: ProviderConfig, fetchImpl: FetchImpl): GenerationProvider {
  const which = (config.provider ?? "mock").toLowerCase();
  if (which === "mock") return new MockProvider();
  if (which === "comfyui") {
    if (!config.comfyUrl || !config.comfyWorkflow) throw new Error("comfyui provider needs COMFYUI_URL + workflow");
    return new ComfyUIProvider(config.comfyUrl, config.comfyWorkflow, fetchImpl);
  }
  if (which === "fal") {
    if (!config.falKey) throw new Error("fal provider needs a FAL_KEY (set falKeySecretRef in plugin config)");
    return new FalProvider(config.falKey, fetchImpl, config.falModel);
  }
  if (which === "sogni") {
    if (!config.sogniKey) throw new Error("Pick the Sogni API key in Media Studio settings (it comes from the company's Secrets).");
    if (!config.sogniTransferFetch) throw new Error("Sogni needs a way to fetch finished pictures.");
    return new SogniProvider({
      apiKey: config.sogniKey,
      apiFetch: fetchImpl,
      transferFetch: config.sogniTransferFetch,
      defaultModel: config.sogniModel,
      tokenType: config.sogniTokenType,
    });
  }
  throw new Error(`unknown provider: ${which}`);
}
