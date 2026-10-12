// Higgsfield (https://docs.higgsfield.ai) as a picture service, and its
// Soul ID (a trained face identity) for identities.
//
// What was confirmed, and where (8 Oct 2026):
//   Auth      Authorization: Key <key id>:<key secret>          docs.higgsfield.ai/docs/authentication, openapi.json
//   Upload    POST https://api.higgsfield.ai/files/generate-upload-url {content_type}
//             -> {upload_url, public_url, upload_headers}; PUT the bytes to upload_url
//             with every upload_header (no Higgsfield key there)  docs/concepts/file-uploads
//   Soul ID   POST /v1/custom-references {name, input_images:[{type:"image_url", image_url}]}
//             -> {id, name, status}; GET /v1/custom-references/<id> -> {status}
//             status: not_ready | queued | in_progress | completed | failed
//             (higgsfield-js SDK src/client.ts createSoulId, src/models/SoulId.ts, src/types.ts;
//             5-20 face photos: higgsfield-ai/skills higgsfield-soul-id/SKILL.md)
//   Picture   POST /v1/text2image/soul {params:{prompt, width_and_height, quality, batch_size,
//             seed?, custom_reference_id?, custom_reference_strength?}} -> {id, jobs:[...]};
//             GET /v1/job-sets/<id> -> {jobs:[{status, results:{raw:{url}}}]}
//             (higgsfield-js README "Text-to-Image Generation (Soul)" and "SoulIds", src/models/JobSet.ts)
//
// Not confirmed (so not used): reference/input pictures or image-to-image
// together with a Soul ID (the v2 OpenAPI's /higgsfield-ai/soul/standard takes
// only prompt, num_images, resolution, aspect_ratio; the v1 Soul call above
// takes no input picture), and how to ask for the "soul-2" or
// "soul-cinematic" Soul ID variant through the API (the CLI has flags; the SDK
// sends neither). So a Higgsfield picture keeps the person through the Soul
// ID only: a look's outfit/style pictures and rooms go through the
// reference-picture services (Sogni, Fal) instead, and the page says so.

import type { FetchImpl, GenerationInput, GenerationProvider, GenerationResult } from "./providers.js";

export const HIGGSFIELD_API = "https://api.higgsfield.ai";
export const HIGGSFIELD_SOUL_ENDPOINT = "/v1/text2image/soul";
/** The only Higgsfield picture model Media Studio uses ("soul": Higgsfield Soul text-to-image). */
export const HIGGSFIELD_MODELS = ["soul"] as const;
export const HIGGSFIELD_MIN_SOUL_PICTURES = 5;
export const HIGGSFIELD_MAX_SOUL_PICTURES = 20;

const SOUL_SIZES: Array<[string, number]> = [
  ["1536x1536", 1],
  ["1152x1536", 0.75],
  ["1536x1152", 4 / 3],
  ["1152x2048", 0.5625],
  ["2048x1152", 16 / 9],
  ["1344x2016", 2 / 3],
  ["2016x1344", 1.5],
];
const PRESET_RATIO: Record<string, number> = {
  square_hd: 1,
  square: 1,
  portrait_4_3: 0.75,
  portrait_16_9: 0.5625,
  landscape_4_3: 4 / 3,
  landscape_16_9: 16 / 9,
};

/** The Soul size closest to the asked-for shape (a Fal-style preset or "WxH"). */
export function soulSize(imageSize?: string): string {
  let ratio = 0.75;
  if (imageSize && PRESET_RATIO[imageSize] !== undefined) ratio = PRESET_RATIO[imageSize]!;
  else {
    const m = imageSize ? /^(\d+)x(\d+)$/.exec(imageSize) : null;
    if (m) ratio = Number(m[1]) / Number(m[2]);
  }
  return SOUL_SIZES.reduce((best, s) => (Math.abs(s[1] - ratio) < Math.abs(best[1] - ratio) ? s : best))[0];
}

/** "id:secret" from the company secret; anything else is refused before a call is made. */
export function readHiggsfieldCredentials(value: string): string {
  const v = value.trim();
  if (!/^[^\s:]+:[^\s:]+$/.test(v)) {
    throw new Error("The Higgsfield secret must hold the key id and key secret as id:secret (from Higgsfield's console, API keys).");
  }
  return v;
}

export type SoulIdStatus = "not_ready" | "queued" | "in_progress" | "completed" | "failed";

export class HiggsfieldClient {
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(
    private readonly options: {
      credentials: string;
      apiFetch: FetchImpl;
      /** Raw bytes to Higgsfield's presigned storage (never the host fetch, which carries text). */
      bytesFetch: FetchImpl;
      pollIntervalMs?: number;
      timeoutMs?: number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private headers(): Record<string, string> {
    return { Authorization: `Key ${this.options.credentials}`, "Content-Type": "application/json", Accept: "application/json" };
  }

  private async call(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const res = await this.options.apiFetch(`${HIGGSFIELD_API}${path}`, { ...init, headers: { ...this.headers(), ...((init.headers as Record<string, string>) ?? {}) } });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (!res.ok) {
      const detail = typeof body.detail === "string" ? `: ${body.detail.slice(0, 200)}` : "";
      if (res.status === 401) throw new Error("Higgsfield did not accept the key picked in Media Studio settings.");
      if (res.status === 403) throw new Error("The Higgsfield account does not have enough credits for this.");
      if (res.status === 429) throw new Error("Higgsfield is getting too many requests right now, try again in a minute.");
      throw new Error(`Higgsfield refused the request (error ${res.status})${detail}.`);
    }
    return body;
  }

  /** Put one picture in Higgsfield's storage; returns its public address for the next call. */
  async upload(bytes: Buffer, contentType: string): Promise<string> {
    const made = await this.call("/files/generate-upload-url", { method: "POST", body: JSON.stringify({ content_type: contentType }) });
    const uploadUrl = typeof made.upload_url === "string" ? made.upload_url : "";
    const publicUrl = typeof made.public_url === "string" ? made.public_url : "";
    if (!/^https:\/\//.test(uploadUrl) || !/^https:\/\//.test(publicUrl)) throw new Error("Higgsfield did not say where to upload the picture.");
    const headers = (made.upload_headers && typeof made.upload_headers === "object" ? made.upload_headers : { "Content-Type": contentType }) as Record<string, string>;
    const put = await this.options.bytesFetch(uploadUrl, { method: "PUT", headers, body: new Uint8Array(bytes) });
    if (!put.ok) throw new Error(`Higgsfield's storage did not take the picture (error ${put.status}).`);
    return publicUrl;
  }

  async createSoulId(name: string, imageUrls: string[]): Promise<{ id: string; status: SoulIdStatus }> {
    if (imageUrls.length < HIGGSFIELD_MIN_SOUL_PICTURES || imageUrls.length > HIGGSFIELD_MAX_SOUL_PICTURES) {
      throw new Error(`A Higgsfield Soul ID needs ${HIGGSFIELD_MIN_SOUL_PICTURES} to ${HIGGSFIELD_MAX_SOUL_PICTURES} face pictures (this has ${imageUrls.length}).`);
    }
    const body = await this.call("/v1/custom-references", {
      method: "POST",
      body: JSON.stringify({ name: name.slice(0, 80), input_images: imageUrls.map((url) => ({ type: "image_url", image_url: url })) }),
    });
    if (typeof body.id !== "string" || !body.id) throw new Error("Higgsfield did not say which Soul ID it started.");
    return { id: body.id, status: (typeof body.status === "string" ? body.status : "queued") as SoulIdStatus };
  }

  async soulIdStatus(id: string): Promise<SoulIdStatus> {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error("That is not a Higgsfield Soul ID.");
    const body = await this.call(`/v1/custom-references/${encodeURIComponent(id)}`, { method: "GET" });
    return (typeof body.status === "string" ? body.status : "queued") as SoulIdStatus;
  }

  /** Make 1 or 4 Soul pictures and wait for them; returns their addresses. */
  async soulPictures(input: { prompt: string; imageSize?: string; count: 1 | 4; seed?: number; soulId?: string | null; soulStrength?: number }): Promise<{ urls: string[]; jobSetId: string }> {
    const params: Record<string, unknown> = {
      prompt: input.prompt,
      width_and_height: soulSize(input.imageSize),
      quality: "1080p",
      batch_size: input.count,
      ...(typeof input.seed === "number" ? { seed: input.seed } : {}),
      ...(input.soulId ? { custom_reference_id: input.soulId, custom_reference_strength: input.soulStrength ?? 1 } : {}),
    };
    const started = await this.call(HIGGSFIELD_SOUL_ENDPOINT, { method: "POST", body: JSON.stringify({ params }) });
    const id = typeof started.id === "string" ? started.id : "";
    if (!id) throw new Error("Higgsfield did not say which pictures it started.");
    const deadline = Date.now() + (this.options.timeoutMs ?? 240_000);
    for (;;) {
      await this.sleep(this.options.pollIntervalMs ?? 3_000);
      const set = await this.call(`/v1/job-sets/${encodeURIComponent(id)}`, { method: "GET" });
      const jobs = Array.isArray(set.jobs) ? (set.jobs as Array<Record<string, unknown>>) : [];
      const statuses = jobs.map((j) => String(j.status ?? ""));
      if (statuses.includes("nsfw")) throw new Error("Higgsfield's content check stopped this picture. Describe it more gently and try again.");
      if (statuses.includes("failed") || statuses.includes("canceled")) throw new Error("Higgsfield could not make the picture. Try again.");
      if (jobs.length > 0 && statuses.every((s) => s === "completed")) {
        const urls = jobs
          .map((j) => ((j.results as Record<string, { url?: string }> | undefined)?.raw?.url ?? ""))
          .filter((u) => /^https:\/\//.test(u));
        if (urls.length === 0) throw new Error("Higgsfield finished but sent no picture back.");
        return { urls, jobSetId: id };
      }
      if (Date.now() > deadline) throw new Error("Higgsfield took too long to make the picture. Try again in a minute.");
    }
  }
}

/** Higgsfield as a normal Media Studio picture service (text to picture, optionally with a Soul ID). */
export class HiggsfieldProvider implements GenerationProvider {
  readonly name = "higgsfield";
  constructor(private readonly client: HiggsfieldClient) {}

  async generate(input: GenerationInput): Promise<GenerationResult> {
    if ((input.referenceImages ?? []).length > 0) {
      throw new Error("Higgsfield Soul does not take reference pictures. Use Sogni or Fal.ai for pictures made from reference pictures.");
    }
    const made = await this.client.soulPictures({
      prompt: input.prompt,
      imageSize: input.imageSize,
      count: 1,
      seed: input.seed,
      soulId: input.customReferenceId ?? null,
    });
    const seed = typeof input.seed === "number" ? input.seed : null;
    return {
      provider: this.name,
      model: "soul",
      contentType: "image/jpeg",
      imageUrl: made.urls[0]!,
      seed,
      meta: { seed, jobSetId: made.jobSetId, ...(input.customReferenceId ? { soulId: input.customReferenceId } : {}) },
    };
  }
}
