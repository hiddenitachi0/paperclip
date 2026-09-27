import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";
import {
  MAX_SEED,
  assertFalModelId,
  isPictureService,
  selectProvider,
  serviceForModel,
  type GenerationInput,
  type GenerationResult,
  type PictureService,
  type ProviderConfig,
} from "./providers.js";
import {
  SOGNI_TOKEN_TYPES,
  assertSogniModelId,
  guardedTransferFetch,
  sogniMaxReferences,
  sogniReferenceModel,
  sogniSize,
  type SogniTokenType,
} from "./sogni.js";
import {
  ACTION_GENERATE,
  ACTION_LOOKS_DELETE,
  ACTION_LOOKS_LIST,
  ACTION_LOOKS_SAVE,
  GENERATE_IMAGE_DESCRIPTION,
  GENERATE_IMAGE_PARAMETERS,
  LIST_LOOKS_DESCRIPTION,
  LOOKS_PAGE_ROUTE,
  MAX_REFERENCE_FILES,
  TOOL_GENERATE,
  TOOL_LIST_LOOKS,
} from "./manifest.js";

/**
 * Resolve the operator-configured provider and run one generation. Shared by
 * the agent-callable tool and the UI action so both behave identically.
 */
async function runGeneration(ctx: PluginContext, input: GenerationInput): Promise<GenerationResult> {
  const cfg = (await ctx.config.get()) as Record<string, unknown>;
  // A per-call choice or a look's service (already checked in prepareGeneration) wins over settings.
  const provider = input.provider ?? String(cfg.provider ?? "mock");

  const providerConfig: ProviderConfig = {
    provider,
    falModel: typeof cfg.falModel === "string" && cfg.falModel.trim() ? cfg.falModel.trim() : undefined,
    comfyUrl: typeof cfg.comfyUrl === "string" && cfg.comfyUrl ? cfg.comfyUrl : undefined,
    sogniModel: typeof cfg.sogniModel === "string" && cfg.sogniModel.trim() ? cfg.sogniModel.trim() : undefined,
    sogniTokenType: (SOGNI_TOKEN_TYPES as readonly string[]).includes(String(cfg.sogniTokenType))
      ? (cfg.sogniTokenType as SogniTokenType)
      : "auto",
    sogniTransferFetch: guardedTransferFetch,
  };

  if (provider === "fal") {
    const ref = typeof cfg.falKeySecretRef === "string" ? cfg.falKeySecretRef : "";
    if (!ref) throw new Error("Set the Fal.ai API key secret reference in Media Studio settings.");
    providerConfig.falKey = await ctx.secrets.resolve(ref);
  }
  if (provider === "sogni") {
    const ref = typeof cfg.sogniKeySecretRef === "string" ? cfg.sogniKeySecretRef : "";
    if (!ref) throw new Error("Pick the Sogni API key in Media Studio settings (it comes from the company's Secrets).");
    providerConfig.sogniKey = await ctx.secrets.resolve(ref);
  }

  const impl = selectProvider(providerConfig, (url, init) => ctx.http.fetch(url, init));
  ctx.logger.info(`media-studio: generating via ${impl.name}`);
  return impl.generate(input);
}

/** A whole number 0..MAX_SEED, from a number or a numeric string the model sent; otherwise undefined. */
export function parseSeed(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_SEED) return "invalid";
  return n;
}

function toInput(params: Record<string, unknown>): GenerationInput {
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  const seed = parseSeed(params.seed);
  return {
    prompt,
    imageSize: typeof params.imageSize === "string" ? params.imageSize : undefined,
    model: typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined,
    seed: typeof seed === "number" ? seed : undefined,
  };
}

const SERVICE_NAME: Record<PictureService, string> = { fal: "Fal.ai", sogni: "Sogni" };

/**
 * Which service makes this picture. In order: the per-call provider; a model
 * the call names (a Sogni model name or a Fal model path picks its service);
 * the look's service (set on the look, or implied by the look's model); the
 * settings. Only a per-call provider moves away from mock/ComfyUI: those are
 * chosen on purpose (testing, own server) and must not start spending.
 */
function chooseService(
  settingsProvider: string,
  requested: PictureService | null,
  callModel: string | undefined,
  look: Look | null,
): { service: string; useLookModel: boolean } | { error: string } {
  const callModelService = serviceForModel(callModel);
  const lookService = look ? (look.provider ?? serviceForModel(look.model)) : null;
  if (requested) {
    if (callModel && callModelService && callModelService !== requested) {
      return {
        error: `The model ${callModel} is a ${SERVICE_NAME[callModelService]} model, not a ${SERVICE_NAME[requested]} one. Leave out the model, or use ${SERVICE_NAME[callModelService]}.`,
      };
    }
    return { service: requested, useLookModel: !lookService || lookService === requested };
  }
  if (isPictureService(settingsProvider)) {
    if (callModelService) return { service: callModelService, useLookModel: false };
    if (!callModel && lookService) return { service: lookService, useLookModel: true };
  }
  return { service: settingsProvider, useLookModel: !lookService || lookService === settingsProvider };
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

// ─── Saved looks ─────────────────────────────────────────────────────────────
//
// A look is a named recipe a company reuses so its pictures stay consistent:
// style words added to every prompt, an optional model, an optional fixed
// seed, and up to four reference pictures from the company's Files. Stored
// per company in plugin state (scope "company", scope id = the company the
// host verified for this call), so one company never sees another's looks.

export interface Look {
  id: string;
  name: string;
  style: string;
  model: string | null;
  /** The service this look's pictures are made with (null: the one in settings, or the one its model implies). */
  provider: PictureService | null;
  seed: number | null;
  referenceFileIds: string[];
  updatedAt: string;
}

const LOOKS_STATE_KEY = "looks";
const LOOK_NAME_MAX = 60;
const LOOK_STYLE_MAX = 1000;
const MAX_LOOKS = 50;

function looksScope(companyId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey: LOOKS_STATE_KEY };
}

function isLook(value: unknown): value is Look {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.name === "string" && typeof v.style === "string" && Array.isArray(v.referenceFileIds);
}

export async function loadLooks(ctx: PluginContext, companyId: string): Promise<Look[]> {
  const raw = await ctx.state.get(looksScope(companyId));
  // Looks saved before the service choice existed have no provider: they follow settings/their model.
  return Array.isArray(raw)
    ? raw.filter(isLook).map((look) => ({ ...look, provider: isPictureService(look.provider) ? look.provider : null }))
    : [];
}

function findLook(looks: Look[], name: string): Look | undefined {
  const wanted = name.trim().toLowerCase();
  return looks.find((look) => look.name.trim().toLowerCase() === wanted);
}

function lookNamesSentence(looks: Look[]): string {
  if (looks.length === 0) {
    return "No looks are saved yet. A company owner or admin can add them under Company settings, Media Studio looks.";
  }
  return `Saved looks: ${looks.map((look) => look.name).join(", ")}.`;
}

function describeLook(look: Look): string {
  const extras: string[] = [];
  if (look.seed !== null) extras.push(`fixed seed ${look.seed}`);
  if (look.referenceFileIds.length > 0) {
    extras.push(`${look.referenceFileIds.length} reference picture${look.referenceFileIds.length === 1 ? "" : "s"}`);
  }
  if (look.provider) extras.push(`made with ${SERVICE_NAME[look.provider]}`);
  if (look.model) extras.push(`model ${look.model}`);
  const style = look.style.trim() ? `: ${look.style.trim()}` : "";
  return `- ${look.name}${style}${extras.length > 0 ? ` (${extras.join("; ")})` : ""}`;
}

/**
 * Turn file ids into data: URIs for the provider. Each file must be a picture
 * in THIS company's Files: the host answers "no such file" for another
 * company's file, and that is refused with a plain sentence. The bytes travel
 * as data URIs so no private Paperclip address ever leaves the box.
 */
async function loadReferenceImages(ctx: PluginContext, companyId: string, fileIds: string[]): Promise<string[]> {
  const images: string[] = [];
  for (const fileId of fileIds) {
    const file = await ctx.files.get(fileId, companyId);
    if (!file) {
      throw new Error(
        `The reference picture ${fileId} is not in this company's Files, so it cannot be used. Pick a picture from this company's Files.`,
      );
    }
    if (!file.contentType.toLowerCase().startsWith("image/")) {
      throw new Error(`The file "${file.originalFilename ?? fileId}" is not a picture, so it cannot be used as a reference.`);
    }
    const content = await ctx.files.readContent(fileId, companyId);
    images.push(`data:${content.contentType.toLowerCase()};base64,${content.contentBase64}`);
  }
  return images;
}

function readReferenceIds(value: unknown): string[] | "invalid" {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return "invalid";
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) return "invalid";
    if (!ids.includes(item.trim())) ids.push(item.trim());
  }
  return ids;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** What a stored picture remembers about how it was made (kept per company, by file id). */
function imageRecordScope(companyId: string, fileId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey: `image:${fileId}` };
}

export interface PreparedGeneration {
  input: GenerationInput;
  look: Look | null;
  referenceFileIds: string[];
}

/**
 * Validate the tool input and apply a saved look. Nothing here spends
 * anything: it runs before the daily limit is reserved, so a typo in a look
 * name does not use up one of the day's pictures.
 */
export async function prepareGeneration(
  ctx: PluginContext,
  companyId: string,
  params: Record<string, unknown>,
): Promise<PreparedGeneration | { error: string }> {
  const input = toInput(params);
  if (!input.prompt) return { error: "prompt is required" };
  if (parseSeed(params.seed) === "invalid") {
    return { error: `The seed must be a whole number from 0 to ${MAX_SEED}.` };
  }
  const requestedRefs = readReferenceIds(params.referenceFileIds);
  if (requestedRefs === "invalid") return { error: "referenceFileIds must be a list of file ids." };
  const rawProvider = typeof params.provider === "string" ? params.provider.trim().toLowerCase() : "";
  if (rawProvider && !isPictureService(rawProvider)) {
    return { error: `"${String(params.provider)}" is not a picture service. Use fal (Fal.ai) or sogni (Sogni), or leave it out.` };
  }

  let look: Look | null = null;
  const lookName = typeof params.look === "string" ? params.look.trim() : "";
  if (lookName) {
    const looks = await loadLooks(ctx, companyId);
    look = findLook(looks, lookName) ?? null;
    if (!look) return { error: `There is no saved look called "${lookName}". ${lookNamesSentence(looks)}` };
  }

  const referenceFileIds = [...(look?.referenceFileIds ?? [])];
  for (const id of requestedRefs) if (!referenceFileIds.includes(id)) referenceFileIds.push(id);
  if (referenceFileIds.length > MAX_REFERENCE_FILES) {
    return { error: `At most ${MAX_REFERENCE_FILES} reference pictures can be used at once (this asked for ${referenceFileIds.length}).` };
  }

  const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
  const settingsProvider = String(cfg.provider ?? "mock").toLowerCase();
  const chosen = chooseService(settingsProvider, isPictureService(rawProvider) ? rawProvider : null, input.model, look);
  if ("error" in chosen) return chosen;
  input.provider = chosen.service;

  if (look?.style.trim()) input.prompt = `${input.prompt}\n\nStyle: ${look.style.trim()}`;
  if (!input.model && look?.model && chosen.useLookModel) input.model = look.model;

  // Sogni's own limits, checked here so a mistake does not use up one of the day's pictures.
  if (chosen.service === "sogni") {
    try {
      if (input.imageSize) sogniSize(input.imageSize);
      if (input.model) assertSogniModelId(input.model);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    if (referenceFileIds.length > sogniMaxReferences(input.model)) {
      return {
        error: `Sogni's ${sogniReferenceModel(input.model)} model takes at most ${sogniMaxReferences(input.model)} reference pictures (this asked for ${referenceFileIds.length}).`,
      };
    }
  }
  // An explicit seed wins over the look's fixed seed: "same look, but try
  // the seed from that other picture" is a normal thing to ask.
  if (input.seed === undefined && look?.seed !== null && look?.seed !== undefined) input.seed = look.seed;

  try {
    if (referenceFileIds.length > 0) input.referenceImages = await loadReferenceImages(ctx, companyId, referenceFileIds);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  return { input, look, referenceFileIds };
}

function assertCanManageLooks(context: { companyId: string | null; actor: { type: string; canManageCompany?: boolean } }): string {
  if (!context.companyId) throw new Error("Open this page from inside a company.");
  if (context.actor.type !== "user" || context.actor.canManageCompany !== true) {
    throw new Error("Only the company's owner or an admin can change looks. You can see them, but not change them.");
  }
  return context.companyId;
}

async function validateLookInput(
  ctx: PluginContext,
  companyId: string,
  params: Record<string, unknown>,
): Promise<Omit<Look, "id" | "updatedAt">> {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!name) throw new Error("Give the look a name.");
  if (name.length > LOOK_NAME_MAX) throw new Error(`Keep the name under ${LOOK_NAME_MAX} characters.`);
  const style = typeof params.style === "string" ? params.style.trim() : "";
  if (style.length > LOOK_STYLE_MAX) throw new Error(`Keep the style text under ${LOOK_STYLE_MAX} characters.`);
  const rawProvider = typeof params.provider === "string" ? params.provider.trim().toLowerCase() : "";
  if (rawProvider && !isPictureService(rawProvider)) throw new Error("Pick Fal.ai, Sogni, or the normal picture service for the look.");
  const provider: PictureService | null = isPictureService(rawProvider) ? rawProvider : null;
  const rawModel = typeof params.model === "string" ? params.model.trim() : "";
  let model: string | null = null;
  if (rawModel) {
    const modelService = serviceForModel(rawModel);
    if (provider && modelService && modelService !== provider) {
      throw new Error(`"${rawModel}" is a ${SERVICE_NAME[modelService]} model. Pick ${SERVICE_NAME[modelService]} as the service, or another model.`);
    }
    try {
      model = (provider ?? modelService) === "sogni" ? assertSogniModelId(rawModel) : assertFalModelId(rawModel);
    } catch {
      throw new Error(`"${rawModel}" is not a model name. Leave it empty to use the normal model.`);
    }
  }
  const seed = parseSeed(params.seed);
  if (seed === "invalid") throw new Error(`The seed must be a whole number from 0 to ${MAX_SEED}, or empty.`);
  const refs = readReferenceIds(params.referenceFileIds);
  if (refs === "invalid") throw new Error("The reference pictures could not be read. Pick them again.");
  if (refs.length > MAX_REFERENCE_FILES) throw new Error(`Pick at most ${MAX_REFERENCE_FILES} reference pictures.`);
  for (const id of refs) {
    const file = await ctx.files.get(id, companyId);
    if (!file) throw new Error("One of the reference pictures is not in this company's Files. Pick it again.");
    if (!file.contentType.toLowerCase().startsWith("image/")) {
      throw new Error(`"${file.originalFilename ?? "That file"}" is not a picture, so it cannot be a reference.`);
    }
  }
  return { name, style, model, provider, seed: seed ?? null, referenceFileIds: refs };
}

const plugin = definePlugin({
  async setup(ctx) {
    // Agent-callable tool: an employee (or a quick agent in chat) makes a picture.
    ctx.tools.register(
      TOOL_GENERATE,
      {
        displayName: "Generate image",
        description: GENERATE_IMAGE_DESCRIPTION,
        parametersSchema: GENERATE_IMAGE_PARAMETERS as unknown as Record<string, unknown>,
      },
      async (params, runCtx): Promise<ToolResult> => {
        const rawParams = (params ?? {}) as Record<string, unknown>;
        const issueId = typeof rawParams.issueId === "string" ? rawParams.issueId.trim() : "";

        const prepared = await prepareGeneration(ctx, runCtx.companyId, rawParams);
        if ("error" in prepared) return { error: prepared.error };
        const { input, look, referenceFileIds } = prepared;

        // DUR-177 / DUR-4000: enforce the calling agent's own daily image
        // limit (agents.limits.dailyImageGenerations) in code, at the moment
        // of this action -- not as prompt guidance. Reserved *before* calling
        // the provider so a capped-out agent never spends generation
        // cost/quota on a call that would just be rejected afterward. No-op
        // (always allowed) for an agent with no limit set. The host resolves
        // the agent from the run id; the plugin cannot name a different one.
        // Applies to every picture, with a task or without.
        const reservation = await ctx.personas.reserveDailyGeneration(runCtx.companyId, { runId: runCtx.runId });
        if (!reservation.allowed) {
          return { error: `Daily image limit (${reservation.cap ?? 0}) reached for this agent today.` };
        }

        try {
          const result = await runGeneration(ctx, input);
          const { contentBase64, contentType } = await toAttachmentBytes(ctx, result);
          const seed = typeof result.seed === "number" ? result.seed : null;
          const extension = contentType.split("/")[1]?.replace(/\+.*$/, "") ?? "bin";

          if (issueId) {
            // With a task: exactly as before -- the host only lets the run
            // attach to the task it has checked out, or (a quick agent) one
            // assigned to it or named in the person's own message.
            const attachment = await ctx.issues.createAttachment(
              issueId,
              { contentBase64, contentType, filename: `${result.provider}-generation.${contentType.split("/")[1] ?? "bin"}` },
              runCtx.companyId,
              { authorAgentId: runCtx.agentId, runId: runCtx.runId },
            );
            await rememberImage(ctx, runCtx.companyId, attachment.id, { seed, prompt: input.prompt, look, provider: result.provider, model: result.model, referenceFileIds });
            return {
              content: `Generated a ${result.provider} preview and attached it to the issue (${attachment.contentPath}). Submit it for board approval before posting.${seedSentence(seed)}${seedNotUsedSentence(result)}`,
              data: {
                ...result,
                attachmentId: attachment.id,
                contentPath: attachment.contentPath,
                fileId: attachment.id,
                issueId,
                seed,
              },
            };
          }

          // No task: a company file in the Files page's "No task" group. The
          // company is the one the host verified for this run; the author is
          // the run's own agent, resolved by the host.
          const filename = `${look ? `${slug(look.name) || "look"}-` : ""}image${seed !== null ? `-seed-${seed}` : ""}.${extension}`;
          const file = await ctx.files.createCompanyFile(
            { contentBase64, contentType, filename },
            runCtx.companyId,
            { runId: runCtx.runId },
          );
          await rememberImage(ctx, runCtx.companyId, file.id, { seed, prompt: input.prompt, look, provider: result.provider, model: result.model, referenceFileIds });
          const lookSentence = look ? ` Used the saved look "${look.name}".` : "";
          return {
            content:
              `Made the picture and saved it to the company's Files (not tied to a task); it is shown to the person with your reply. File id: ${file.id}.` +
              lookSentence +
              seedSentence(seed) +
              seedNotUsedSentence(result),
            data: {
              fileId: file.id,
              contentPath: file.contentPath,
              contentType: file.contentType,
              seed,
              issueId: null,
              look: look?.name ?? null,
              provider: result.provider,
              model: result.model ?? null,
              referenceFileIds,
            },
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    );

    // Read-only: which looks does this company have? (Maja can answer
    // "which looks do we have?" without being able to change them.)
    ctx.tools.register(
      TOOL_LIST_LOOKS,
      {
        displayName: "List saved looks",
        description: LIST_LOOKS_DESCRIPTION,
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, runCtx): Promise<ToolResult> => {
        const looks = await loadLooks(ctx, runCtx.companyId);
        if (looks.length === 0) return { content: lookNamesSentence(looks), data: { looks: [] } };
        return {
          content: `Saved looks:\n${looks.map(describeLook).join("\n")}`,
          data: {
            looks: looks.map((look) => ({
              name: look.name,
              style: look.style,
              provider: look.provider,
              model: look.model,
              seed: look.seed,
              references: look.referenceFileIds.length,
            })),
          },
        };
      },
    );

    // UI-callable action: the Media Studio panel calls this via usePluginAction.
    ctx.actions.register(ACTION_GENERATE, async (params) => {
      const input = toInput(params);
      if (!input.prompt) throw new Error("prompt is required");
      return runGeneration(ctx, input);
    });

    // Looks page (Company settings → Media Studio looks). Anyone in the
    // company may see the list; only an owner/admin may change it. The host
    // decides both the company and canManageCompany from the session.
    ctx.actions.register(ACTION_LOOKS_LIST, async (_params, context) => {
      if (!context.companyId) throw new Error("Open this page from inside a company.");
      return {
        looks: await loadLooks(ctx, context.companyId),
        canManage: context.actor.type === "user" && context.actor.canManageCompany === true,
        maxReferenceFiles: MAX_REFERENCE_FILES,
      };
    });

    ctx.actions.register(ACTION_LOOKS_SAVE, async (params, context) => {
      const companyId = assertCanManageLooks(context);
      const fields = await validateLookInput(ctx, companyId, params);
      const looks = await loadLooks(ctx, companyId);
      const id = typeof params.id === "string" && params.id ? params.id : null;
      const clash = looks.find((look) => look.id !== id && look.name.trim().toLowerCase() === fields.name.toLowerCase());
      if (clash) throw new Error(`There is already a look called "${clash.name}". Pick another name.`);
      const updatedAt = new Date().toISOString();
      let next: Look[];
      if (id) {
        if (!looks.some((look) => look.id === id)) throw new Error("That look no longer exists. Reload the page.");
        next = looks.map((look) => (look.id === id ? { ...look, ...fields, updatedAt } : look));
      } else {
        if (looks.length >= MAX_LOOKS) throw new Error(`A company can keep up to ${MAX_LOOKS} looks. Delete one first.`);
        next = [...looks, { id: crypto.randomUUID(), ...fields, updatedAt }];
      }
      await ctx.state.set(looksScope(companyId), next);
      return { looks: next };
    });

    ctx.actions.register(ACTION_LOOKS_DELETE, async (params, context) => {
      const companyId = assertCanManageLooks(context);
      const id = typeof params.id === "string" ? params.id : "";
      const looks = await loadLooks(ctx, companyId);
      const next = looks.filter((look) => look.id !== id);
      await ctx.state.set(looksScope(companyId), next);
      return { looks: next };
    });

    ctx.logger.info(`media-studio plugin ready (looks page: ${LOOKS_PAGE_ROUTE})`);
  },

  async onHealth() {
    return { status: "ok", message: "Media Studio ready" };
  },
});

/** Sogni cannot take a seed for a picture made from reference pictures: say so rather than pretend. */
function seedNotUsedSentence(result: GenerationResult): string {
  return result.meta?.seedNotUsed === true
    ? " Sogni does not use a seed when it works from reference pictures, so the seed was not applied."
    : "";
}

function seedSentence(seed: number | null): string {
  return seed === null ? "" : ` Seed: ${seed}. To make a close variation of this picture later, pass seed ${seed} again.`;
}

/**
 * Keep how a picture was made next to it (per company, by file id): the seed
 * first of all, so "same as that one, but..." can reuse it. A failure here
 * is logged and does not undo the picture, which is already saved.
 */
async function rememberImage(
  ctx: PluginContext,
  companyId: string,
  fileId: string,
  record: { seed: number | null; prompt: string; look: Look | null; provider: string; model?: string; referenceFileIds: string[] },
): Promise<void> {
  try {
    await ctx.state.set(imageRecordScope(companyId, fileId), {
      seed: record.seed,
      prompt: record.prompt,
      look: record.look?.name ?? null,
      provider: record.provider,
      model: record.model ?? null,
      referenceFileIds: record.referenceFileIds,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    ctx.logger.warn(`media-studio: could not store the picture's details: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export default plugin;
runWorker(plugin, import.meta.url);
