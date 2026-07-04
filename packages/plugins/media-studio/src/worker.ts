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
      async (params, _runCtx): Promise<ToolResult> => {
        const input = toInput(params as Record<string, unknown>);
        if (!input.prompt) return { error: "prompt is required" };
        try {
          const result = await runGeneration(ctx, input);
          return {
            content: `Generated a ${result.provider} preview. Submit it for board approval before posting.`,
            data: result,
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
