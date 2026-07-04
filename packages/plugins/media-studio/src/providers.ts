// Self-contained image-generation providers behind one interface.
// The provider is chosen by operator config; `fetchImpl` is injected so the
// worker can route outbound calls through the gated `ctx.http.fetch`.
//
// Contracts:
//   Fal.ai sync:  POST https://fal.run/{model}  header  Authorization: Key <FAL_KEY>
//                 body {prompt, image_size, num_images}  ->  {images:[{url,content_type}]}
//   ComfyUI:      POST {COMFYUI_URL}/prompt {prompt:<workflow>, client_id} -> {prompt_id}
//                 poll GET /history/{prompt_id} ; GET /view?filename=&subfolder=&type=

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface GenerationInput {
  prompt: string;
  imageSize?: string;
  model?: string;
}

export interface GenerationResult {
  provider: string;
  model?: string;
  contentType: string;
  /** Remote https URL (fal) — safe to persist as work-product `url`. */
  imageUrl?: string;
  /** Inline bytes as a data: URL (mock/comfyui) — stored in work-product metadata. */
  imageDataUrl?: string;
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
    const model = input.model ?? this.defaultModel;
    const res = await this.fetchImpl(`${this.baseUrl}/${model}`, {
      method: "POST",
      headers: { Authorization: `Key ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: input.prompt,
        image_size: input.imageSize ?? "landscape_4_3",
        num_images: 1,
        enable_safety_checker: true,
      }),
    });
    if (!res.ok) throw new Error(`fal.ai ${model} failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { images?: Array<{ url: string; content_type?: string }>; seed?: number };
    const image = data.images?.[0];
    if (!image?.url) throw new Error("fal.ai returned no image");
    return { provider: this.name, model, contentType: image.content_type ?? "image/jpeg", imageUrl: image.url, meta: { seed: data.seed } };
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
    const base = this.baseUrl.replace(/\/$/, "");
    const workflow = JSON.parse(
      JSON.stringify(this.workflowTemplate).replaceAll("%PROMPT%", input.prompt.replace(/"/g, '\\"')),
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
    return {
      provider: this.name,
      contentType: "image/svg+xml",
      imageDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      meta: { mock: true },
    };
  }
}

export interface ProviderConfig {
  provider?: string;
  falKey?: string;
  falModel?: string;
  comfyUrl?: string;
  comfyWorkflow?: Record<string, unknown>;
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
  throw new Error(`unknown provider: ${which}`);
}
