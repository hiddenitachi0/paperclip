import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";
import { selectProvider, type GenerationInput, type GenerationResult, type ProviderConfig } from "./providers.js";
import { ACTION_GENERATE, TOOL_GENERATE } from "./manifest.js";

/**
 * Resolve the operator-configured provider and run one generation. Shared by
 * the agent-callable tool and the UI action so both behave identically.
 */
async function runGeneration(ctx: PluginContext, input: GenerationInput): Promise<GenerationResult> {
  const cfg = (await ctx.config.get()) as Record<string, unknown>;
  const provider = String(cfg.provider ?? "mock");

  const providerConfig: ProviderConfig = {
    provider,
    falModel: typeof cfg.falModel === "string" ? cfg.falModel : undefined,
    comfyUrl: typeof cfg.comfyUrl === "string" && cfg.comfyUrl ? cfg.comfyUrl : undefined,
  };

  if (provider === "fal") {
    const ref = typeof cfg.falKeySecretRef === "string" ? cfg.falKeySecretRef : "";
    if (!ref) throw new Error("Set the Fal.ai API key secret reference in Media Studio settings.");
    providerConfig.falKey = await ctx.secrets.resolve(ref);
  }

  const impl = selectProvider(providerConfig, (url, init) => ctx.http.fetch(url, init));
  ctx.logger.info(`media-studio: generating via ${impl.name}`);
  return impl.generate(input);
}

function toInput(params: Record<string, unknown>): GenerationInput {
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  return {
    prompt,
    imageSize: typeof params.imageSize === "string" ? params.imageSize : undefined,
    model: typeof params.model === "string" ? params.model : undefined,
  };
}

const DATA_URL_PATTERN = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/s;

/**
 * A generation provider is expected to return an image. The host's
 * attachment allowlist is company-wide and includes non-image types (e.g.
 * text/html), so a misbehaving or compromised provider must not be able to
 * smuggle non-image content through by way of its response Content-Type.
 */
function assertImageContentType(contentType: string): string {
  const normalized = (contentType || "").trim().toLowerCase();
  if (!normalized.startsWith("image/")) {
    throw new Error(`Provider returned a non-image content type: "${contentType}"`);
  }
  return normalized;
}

/**
 * Resolve a generation result to raw base64 bytes. Fal only returns a remote
 * URL (bytes are never downloaded by the provider), so that path is fetched
 * host-side via ctx.http.fetch; ComfyUI/mock already embed a base64 data URL.
 */
async function toAttachmentBytes(
  ctx: PluginContext,
  result: GenerationResult,
): Promise<{ contentBase64: string; contentType: string }> {
  if (result.imageDataUrl) {
    const match = DATA_URL_PATTERN.exec(result.imageDataUrl);
    if (!match) throw new Error("Unrecognized image data URL from provider");
    const [, mime, isBase64, payload] = match;
    if (!isBase64) throw new Error("Expected a base64-encoded image data URL");
    return { contentBase64: payload, contentType: assertImageContentType(mime || result.contentType) };
  }
  if (result.imageUrl) {
    const response = await ctx.http.fetch(result.imageUrl);
    const bytes = await response.arrayBuffer();
    return {
      contentBase64: Buffer.from(bytes).toString("base64"),
      contentType: assertImageContentType(response.headers?.get?.("content-type") || result.contentType),
    };
  }
  throw new Error("Provider returned neither imageDataUrl nor imageUrl");
}

const plugin = definePlugin({
  async setup(ctx) {
    // Agent-callable tool: an employee can generate a preview as part of its work.
    ctx.tools.register(
      TOOL_GENERATE,
      {
        displayName: "Generate image",
        description: "Generate an image from a text prompt. Returns a preview; a human approves before posting.",
        parametersSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            imageSize: { type: "string" },
            model: { type: "string" },
          },
          required: ["prompt"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const rawParams = params as Record<string, unknown>;
        const input = toInput(rawParams);
        if (!input.prompt) return { error: "prompt is required" };
        const issueId = typeof rawParams.issueId === "string" ? rawParams.issueId : "";
        if (!issueId) return { error: "issueId is required" };

        // DUR-177: enforce the persona's daily generation cap in code, at
        // the moment of this action -- not as prompt guidance. Reserved
        // *before* calling the provider so a capped-out persona never
        // spends generation cost/quota on a call that would just be
        // rejected afterward. No-ops (always allowed) for agents that
        // aren't a persona, or a persona with no cap set.
        const reservation = await ctx.personas.reserveDailyGeneration(runCtx.companyId, { runId: runCtx.runId });
        if (!reservation.allowed) {
          return { error: `Daily image generation cap (${reservation.cap}) reached for this persona today.` };
        }

        try {
          const result = await runGeneration(ctx, input);
          const { contentBase64, contentType } = await toAttachmentBytes(ctx, result);
          const attachment = await ctx.issues.createAttachment(
            issueId,
            { contentBase64, contentType, filename: `${result.provider}-generation.${contentType.split("/")[1] ?? "bin"}` },
            runCtx.companyId,
            { authorAgentId: runCtx.agentId, runId: runCtx.runId },
          );
          return {
            content: `Generated a ${result.provider} preview and attached it to the issue (${attachment.contentPath}). Submit it for board approval before posting.`,
            data: { ...result, attachmentId: attachment.id, contentPath: attachment.contentPath },
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    );

    // UI-callable action: the Media Studio panel calls this via usePluginAction.
    ctx.actions.register(ACTION_GENERATE, async (params) => {
      const input = toInput(params);
      if (!input.prompt) throw new Error("prompt is required");
      return runGeneration(ctx, input);
    });

    ctx.logger.info("media-studio plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Media Studio ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
