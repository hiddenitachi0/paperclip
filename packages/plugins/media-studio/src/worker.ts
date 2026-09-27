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
  SOGNI_DEFAULT_MODEL,
  SOGNI_MAX_LORAS,
  SOGNI_TOKEN_TYPES,
  SogniProvider,
  assertSogniModelId,
  guardedTransferFetch,
  isSogniUploadType,
  sogniCanonicalModelId,
  sogniMaxReferences,
  sogniReferenceModel,
  sogniSize,
  type SogniLoraPick,
  type SogniTokenType,
} from "./sogni.js";
import {
  SOGNI_NEGATIVE_PROMPT_MAX,
  SogniCatalog,
  checkSogniLoras,
  checkSogniOverrides,
  lorasForModel,
  showNumber,
  sizeBoundsFor,
  type SogniLoraInfo,
  type SogniModelInfo,
} from "./sogni-catalog.js";
import {
  ACTION_GENERATE,
  ACTION_LOOKS_DELETE,
  ACTION_LOOKS_LIST,
  ACTION_LOOKS_SAVE,
  ACTION_SOGNI_LORAS,
  ACTION_SOGNI_MODELS,
  GENERATE_IMAGE_DESCRIPTION,
  GENERATE_IMAGE_PARAMETERS,
  LIST_LOOKS_DESCRIPTION,
  LOOKS_PAGE_ROUTE,
  MAX_REFERENCE_FILES,
  TOOL_GENERATE,
  TOOL_LIST_LOOKS,
} from "./manifest.js";
import { SOGNI_TOOLS, prepareSogniCall, sogniToolDescription, sogniToolParameters, type SogniToolDef } from "./sogni-tools.js";

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
  serviceOf: (model: string | null | undefined) => PictureService | null = serviceForModel,
): { service: string; useLookModel: boolean } | { error: string } {
  const callModelService = serviceOf(callModel);
  const lookService = look ? (look.provider ?? serviceOf(look.model)) : null;
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
// seed, and up to four reference pictures from the company's Files. A Sogni
// look can also carry LoRAs (with strengths), model settings (guidance,
// "things to avoid" text, picture size) and the Sensitive Content Filter
// switch. Stored per company in plugin state (scope "company", scope id = the
// company the host verified for this call), so one company never sees
// another's looks. Only an owner/admin can save one, and everything in it is
// checked against Sogni's catalog again before each picture.

export interface LookLora {
  id: string;
  /** Sogni's name for it when the look was saved, so the list reads well even when Sogni cannot be reached. */
  name: string;
  strength: number;
}

export interface Look {
  id: string;
  name: string;
  style: string;
  model: string | null;
  /** Sogni's name for the model when the look was saved ("Dark Beast Z-Image Turbo v9"). */
  modelName: string | null;
  /** The service this look's pictures are made with (null: the one in settings, or the one its model implies). */
  provider: PictureService | null;
  seed: number | null;
  referenceFileIds: string[];
  /** Sogni only. */
  loras: LookLora[];
  guidance: number | null;
  negativePrompt: string | null;
  size: string | null;
  /** Sogni's Sensitive Content Filter; on unless an owner/admin turned it off (see contentFilterOffBy). */
  safeContentFilter: boolean;
  /** The owner/admin (user id) who saved the look with the filter off. The filter is only off with this set. */
  contentFilterOffBy: string | null;
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

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Fill in what older looks do not have: no LoRAs or settings, and the content filter on. */
function normalizeLook(look: Look): Look {
  const raw = look as unknown as Record<string, unknown>;
  const loras = Array.isArray(raw.loras)
    ? raw.loras.flatMap((item): LookLora[] => {
        const l = item as Record<string, unknown> | null;
        if (!l || typeof l.id !== "string" || !l.id || finiteOrNull(l.strength) === null) return [];
        return [{ id: l.id, name: typeof l.name === "string" && l.name ? l.name : l.id, strength: l.strength as number }];
      })
    : [];
  const offBy = textOrNull(raw.contentFilterOffBy);
  return {
    ...look,
    provider: isPictureService(look.provider) ? look.provider : null,
    model: textOrNull(raw.model),
    modelName: textOrNull(raw.modelName),
    seed: finiteOrNull(raw.seed),
    loras,
    guidance: finiteOrNull(raw.guidance),
    negativePrompt: textOrNull(raw.negativePrompt),
    size: textOrNull(raw.size),
    // Off only when saved off by a named owner/admin; anything else is on.
    safeContentFilter: !(raw.safeContentFilter === false && offBy !== null),
    contentFilterOffBy: raw.safeContentFilter === false ? offBy : null,
  };
}

/** The Sensitive Content Filter is off for this look (saved off by an owner/admin). */
export function lookFilterOff(look: Look): boolean {
  return look.safeContentFilter === false && typeof look.contentFilterOffBy === "string" && look.contentFilterOffBy.length > 0;
}

export async function loadLooks(ctx: PluginContext, companyId: string): Promise<Look[]> {
  const raw = await ctx.state.get(looksScope(companyId));
  return Array.isArray(raw) ? raw.filter(isLook).map(normalizeLook) : [];
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
  if (look.model) extras.push(`model ${look.modelName ? `${look.modelName} (${look.model})` : look.model}`);
  if (look.loras.length > 0) {
    extras.push(`LoRAs: ${look.loras.map((lora) => `${lora.name} at ${showNumber(lora.strength)}`).join(", ")}`);
  }
  if (look.guidance !== null) extras.push(`guidance ${showNumber(look.guidance)}`);
  if (look.size) extras.push(`size ${look.size}`);
  if (look.negativePrompt) extras.push("has things to avoid");
  if (lookFilterOff(look)) extras.push("content filter off (pictures can be explicit)");
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

/** LoRA picks from the looks page: [{id, strength}]. Strength may come as text from a form field. */
function readLoraPicks(value: unknown): SogniLoraPick[] | "invalid" {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return "invalid";
  const picks: SogniLoraPick[] = [];
  for (const item of value) {
    const row = item as Record<string, unknown> | null;
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    const raw = row?.strength;
    const strength = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    if (!id || id.length > 200 || typeof strength !== "number" || !Number.isFinite(strength)) return "invalid";
    picks.push({ id, strength });
  }
  return picks;
}

function readOptionalNumber(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : "invalid";
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** What a stored picture remembers about how it was made (kept per company, by file id). */
function imageRecordScope(companyId: string, fileId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey: `image:${fileId}` };
}

// ─── Sogni's catalog, per worker ─────────────────────────────────────────────

const sogniCatalogs = new WeakMap<PluginContext, SogniCatalog>();

/** One catalog (and one 10-minute memory) per plugin worker; reads go through the host's gated fetch. */
export function sogniCatalogFor(ctx: PluginContext): SogniCatalog {
  let catalog = sogniCatalogs.get(ctx);
  if (!catalog) {
    catalog = new SogniCatalog((url, init) => ctx.http.fetch(url, init));
    sogniCatalogs.set(ctx, catalog);
  }
  return catalog;
}

async function resolveSogniKey(ctx: PluginContext, cfg: Record<string, unknown>): Promise<string | null> {
  const ref = typeof cfg.sogniKeySecretRef === "string" ? cfg.sogniKeySecretRef : "";
  return ref ? ctx.secrets.resolve(ref) : null;
}

const CATALOG_UNREACHABLE = "Sogni's list of models could not be reached just now";

/**
 * A Sogni model must be in Sogni's catalog. When the catalog cannot be read,
 * only a model an owner/admin already chose (saved in the look being used,
 * or set in Media Studio settings) is let through.
 */
async function resolveSogniModel(
  catalog: SogniCatalog,
  model: string,
  trusted: Array<string | null | undefined>,
): Promise<{ id: string; info: SogniModelInfo | null } | { error: string }> {
  let checked: string;
  try {
    checked = assertSogniModelId(model);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const id = sogniCanonicalModelId(checked);
  const found = await catalog.model(id);
  if (found.live) {
    if (found.model) return { id: found.model.id, info: found.model };
    return { error: `Sogni has no picture model called "${model}". Leave out the model, or use a saved look.` };
  }
  const trustedIds = trusted.filter((t): t is string => typeof t === "string" && t.trim() !== "").map(sogniCanonicalModelId);
  if (trustedIds.includes(id)) return { id, info: null };
  return { error: `${CATALOG_UNREACHABLE}, so the model "${model}" could not be checked. Try again in a minute, or use a saved look.` };
}

/** Public LoRAs, plus the account's own when asked for. `known` is null when they could not be read. */
async function knownLoras(
  ctx: PluginContext,
  cfg: Record<string, unknown>,
  catalog: SogniCatalog,
  withPersonal: boolean,
): Promise<{ known: SogniLoraInfo[] | null; maxPerRequest: number; error?: string }> {
  const publicCatalog = await catalog.publicLoras();
  if (!publicCatalog) return { known: null, maxPerRequest: SOGNI_MAX_LORAS };
  const known = [...publicCatalog.loras];
  if (withPersonal) {
    const key = await resolveSogniKey(ctx, cfg);
    if (!key) return { known: null, maxPerRequest: publicCatalog.maxPerRequest, error: "Your own LoRAs need the Sogni API key picked in Media Studio settings." };
    const own = await catalog.personalLoras(key);
    if (own.status === "not-allowed") {
      return {
        known: null,
        maxPerRequest: publicCatalog.maxPerRequest,
        error: "Your own LoRAs need an active Sogni Unlimited plan on the Sogni account.",
      };
    }
    if (own.status === "unavailable") return { known: null, maxPerRequest: publicCatalog.maxPerRequest };
    known.push(...own.loras);
  }
  return { known, maxPerRequest: publicCatalog.maxPerRequest };
}

export interface PreparedGeneration {
  input: GenerationInput;
  look: Look | null;
  referenceFileIds: string[];
  /** Plain sentences for the agent: what of the look could not be used, and why. */
  notes: string[];
}

/**
 * Sogni's part of preparing a picture: the model must be in Sogni's catalog,
 * and a look's LoRAs and settings must still fit it. Runs before the daily
 * limit is reserved, so nothing is spent on a picture that would be refused.
 */
async function prepareSogni(
  ctx: PluginContext,
  cfg: Record<string, unknown>,
  input: GenerationInput,
  look: Look | null,
  lookModelUsed: boolean,
  referenceCount: number,
  notes: string[],
): Promise<{ error: string } | null> {
  const catalog = sogniCatalogFor(ctx);
  let info: SogniModelInfo | null = null;
  if (input.model) {
    const resolved = await resolveSogniModel(catalog, input.model, [look?.model, textOrNull(cfg.sogniModel)]);
    if ("error" in resolved) {
      return lookModelUsed && look && !resolved.error.startsWith(CATALOG_UNREACHABLE)
        ? { error: `The look "${look.name}" uses the model ${look.modelName ?? look.model}, which Sogni no longer offers. An owner or admin can pick another model for the look.` }
        : resolved;
    }
    input.model = resolved.id;
    info = resolved.info;
  }
  if (info && !info.generates && referenceCount === 0) {
    return {
      error: `${info.name} changes existing pictures, so it needs reference pictures. Add reference pictures (to the look or to this picture), or pick another model.`,
    };
  }
  input.modelTakesReferences = info?.takesReferences ?? false;
  const editing = referenceCount > 0;
  // With reference pictures the picture comes from an edit model: this one if it edits, else Sogni's default editor.
  const usesOwnModel =
    !editing ||
    (input.model !== undefined &&
      sogniCanonicalModelId(sogniReferenceModel(input.model, input.modelTakesReferences)) === sogniCanonicalModelId(input.model));

  if (look?.size && !input.imageSize) input.imageSize = look.size;
  const bounds = sizeBoundsFor(usesOwnModel ? info : null);
  if (input.imageSize) {
    try {
      sogniSize(input.imageSize, bounds);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  input.sizeBounds = bounds;

  if (look && (look.loras.length > 0 || look.guidance !== null || look.negativePrompt !== null)) {
    if (!lookModelUsed) {
      notes.push(`The look's LoRAs and model settings were left out, because this picture uses a different model than the look "${look.name}".`);
    } else if (!usesOwnModel) {
      notes.push(
        "The look's LoRAs and model settings were left out: pictures made from reference pictures use Sogni's picture-editing model, which cannot use them. An owner or admin can pick a picture-editing model for the look.",
      );
    } else {
      if (look.loras.length > 0) {
        if (look.loras.length > SOGNI_MAX_LORAS) {
          return { error: `The look "${look.name}" has more than ${SOGNI_MAX_LORAS} LoRAs. An owner or admin needs to remove some.` };
        }
        const picks = look.loras.map(({ id, strength }) => ({ id, strength }));
        const loras = await knownLoras(ctx, cfg, catalog, picks.some((p) => p.id.startsWith("personal-")));
        if (loras.error) return { error: `The look "${look.name}" cannot be used: ${loras.error}` };
        // Sogni's LoRA list unreadable: the owner/admin-saved picks are used as saved (Sogni limits strengths itself).
        if (loras.known && info) {
          const problem = checkSogniLoras(info, picks, loras.known, {
            maxPerRequest: loras.maxPerRequest,
            contentFilterOn: !lookFilterOff(look),
          });
          if (problem) return { error: `The look "${look.name}" cannot be used as saved: ${problem}` };
        }
        input.loras = picks;
      }
      if (info) {
        const problem = checkSogniOverrides(info, { guidance: look.guidance, negativePrompt: look.negativePrompt, size: null });
        if (problem) return { error: `The look "${look.name}" cannot be used as saved: ${problem}` };
      }
      if (!editing) {
        if (look.guidance !== null) input.guidance = look.guidance;
        if (look.negativePrompt) input.negativePrompt = look.negativePrompt;
      } else if (look.guidance !== null || look.negativePrompt) {
        notes.push('Guidance and "things to avoid" text are not used for pictures made from reference pictures.');
      }
    }
  }

  // Only a look an owner/admin saved with the filter off turns it off. Nothing an agent sends can.
  input.safeContentFilter = look ? !lookFilterOff(look) : true;

  const max = sogniMaxReferences(input.model, input.modelTakesReferences);
  if (referenceCount > max) {
    return {
      error: `Sogni's ${sogniReferenceModel(input.model, input.modelTakesReferences)} model takes at most ${max} reference pictures (this asked for ${referenceCount}).`,
    };
  }
  return null;
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
  const catalog = sogniCatalogFor(ctx);
  const callModel = input.model;
  // A model name that is neither a known Sogni key nor a Fal path may still be one of Sogni's many models.
  if (callModel && !serviceForModel(callModel) && isPictureService(settingsProvider)) await catalog.models();
  const chosen = chooseService(
    settingsProvider,
    isPictureService(rawProvider) ? rawProvider : null,
    callModel,
    look,
    (model) => serviceForModel(model) ?? (model && catalog.knows(model) ? "sogni" : null),
  );
  if ("error" in chosen) return chosen;
  input.provider = chosen.service;

  if (look?.style.trim()) input.prompt = `${input.prompt}\n\nStyle: ${look.style.trim()}`;
  // The look's model is used when the call names no model, or names the look's own model.
  const lookModelUsed = callModel
    ? Boolean(look?.model) && sogniCanonicalModelId(callModel) === sogniCanonicalModelId(look!.model!)
    : Boolean(look?.model) && chosen.useLookModel;
  if (lookModelUsed && !callModel) input.model = look!.model!;

  const notes: string[] = [];
  // Sogni's own limits, checked here so a mistake does not use up one of the day's pictures.
  if (chosen.service === "sogni") {
    const problem = await prepareSogni(ctx, cfg, input, look, lookModelUsed, referenceFileIds.length, notes);
    if (problem) return problem;
  }
  // An explicit seed wins over the look's fixed seed: "same look, but try
  // the seed from that other picture" is a normal thing to ask.
  if (input.seed === undefined && look?.seed !== null && look?.seed !== undefined) input.seed = look.seed;

  try {
    if (referenceFileIds.length > 0) input.referenceImages = await loadReferenceImages(ctx, companyId, referenceFileIds);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  return { input, look, referenceFileIds, notes };
}

function assertCanManageLooks(context: { companyId: string | null; actor: { type: string; canManageCompany?: boolean } }): string {
  if (!context.companyId) throw new Error("Open this page from inside a company.");
  if (context.actor.type !== "user" || context.actor.canManageCompany !== true) {
    throw new Error("Only the company's owner or an admin can change looks. You can see them, but not change them.");
  }
  return context.companyId;
}

const SOGNI_ONLY_SETTINGS =
  'LoRAs, guidance, "things to avoid" text, picture size and the content filter switch are Sogni settings. Pick Sogni as the picture service to use them.';

function sameLoras(a: SogniLoraPick[], b: LookLora[]): boolean {
  return a.length === b.length && a.every((pick, i) => pick.id === b[i]!.id && pick.strength === b[i]!.strength);
}

/**
 * Check a look before saving it. For Sogni, the model must be in Sogni's
 * catalog, each LoRA must work with that model at a strength inside its
 * range, and each setting must be one the model allows. When Sogni cannot be
 * reached, only what the look already had is kept.
 */
async function validateLookInput(
  ctx: PluginContext,
  companyId: string,
  params: Record<string, unknown>,
  actorUserId: string | null,
  existing: Look | null,
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

  const picks = readLoraPicks(params.loras);
  if (picks === "invalid") throw new Error("The LoRAs could not be read. Pick them again.");
  const guidance = readOptionalNumber(params.guidance);
  if (guidance === "invalid") throw new Error("Guidance must be a number, or empty.");
  const negativePrompt = textOrNull(params.negativePrompt);
  const size = textOrNull(params.size);
  const safeContentFilter = params.safeContentFilter !== false;

  const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
  const catalog = sogniCatalogFor(ctx);
  const modelService = rawModel ? (serviceForModel(rawModel) ?? (catalog.knows(rawModel) ? "sogni" : null)) : null;
  if (provider && modelService && modelService !== provider) {
    throw new Error(`"${rawModel}" is a ${SERVICE_NAME[modelService]} model. Pick ${SERVICE_NAME[modelService]} as the service, or another model.`);
  }
  const settingsService = isPictureService(String(cfg.provider ?? "").toLowerCase()) ? (String(cfg.provider).toLowerCase() as PictureService) : null;
  const service = provider ?? modelService ?? settingsService;
  const base = { name, style, provider, seed: seed ?? null, referenceFileIds: refs };

  if (service !== "sogni") {
    if (picks.length > 0 || guidance !== null || negativePrompt !== null || size !== null || !safeContentFilter) {
      throw new Error(SOGNI_ONLY_SETTINGS);
    }
    let model: string | null = null;
    if (rawModel) {
      try {
        model = assertFalModelId(rawModel);
      } catch {
        throw new Error(`"${rawModel}" is not a model name. Leave it empty to use the normal model.`);
      }
    }
    return { ...base, model, modelName: null, loras: [], guidance: null, negativePrompt: null, size: null, safeContentFilter: true, contentFilterOffBy: null };
  }

  // ── Sogni ──
  if (picks.length > SOGNI_MAX_LORAS) throw new Error(`A look can use at most ${SOGNI_MAX_LORAS} LoRAs; this has ${picks.length}. Remove some.`);
  if (!rawModel && (picks.length > 0 || guidance !== null || negativePrompt !== null)) {
    throw new Error("Pick a Sogni model first: LoRAs, guidance and \"things to avoid\" text belong to one model.");
  }
  if (negativePrompt && negativePrompt.length > SOGNI_NEGATIVE_PROMPT_MAX) {
    throw new Error(`Keep the "things to avoid" text under ${SOGNI_NEGATIVE_PROMPT_MAX} characters.`);
  }
  let model: string | null = null;
  let info: SogniModelInfo | null = null;
  if (rawModel) {
    let checked: string;
    try {
      checked = assertSogniModelId(rawModel);
    } catch {
      throw new Error(`"${rawModel}" is not a model name. Leave it empty to use the normal model.`);
    }
    const found = await catalog.model(checked);
    if (found.live && !found.model) throw new Error(`Sogni has no picture model called "${rawModel}". Pick one from the list.`);
    if (found.model) {
      info = found.model;
      model = found.model.id;
    } else if (existing?.model && sogniCanonicalModelId(existing.model) === sogniCanonicalModelId(checked)) {
      model = existing.model; // Sogni unreachable: keep the model this look already had.
    } else {
      throw new Error(`${CATALOG_UNREACHABLE}, so the model could not be checked. Try again in a minute.`);
    }
  }
  const unchanged =
    existing !== null &&
    existing.model === model &&
    existing.guidance === guidance &&
    existing.negativePrompt === negativePrompt &&
    existing.size === size;
  if (info) {
    const problem = checkSogniOverrides(info, { guidance, negativePrompt, size });
    if (problem) throw new Error(problem);
  } else if ((guidance !== null || negativePrompt !== null) && !unchanged) {
    throw new Error(`${CATALOG_UNREACHABLE}, so the model settings could not be checked. Try again in a minute.`);
  } else if (size !== null) {
    sogniSize(size);
  }

  let loras: LookLora[] = [];
  if (picks.length > 0) {
    const listed = info ? await knownLoras(ctx, cfg, catalog, picks.some((p) => p.id.startsWith("personal-"))) : null;
    if (listed?.error) throw new Error(listed.error);
    if (info && listed?.known) {
      const problem = checkSogniLoras(info, picks, listed.known, { maxPerRequest: listed.maxPerRequest, contentFilterOn: safeContentFilter });
      if (problem) throw new Error(problem);
      loras = picks.map((pick) => ({ ...pick, name: listed.known!.find((l) => l.id === pick.id)?.name ?? pick.id }));
    } else if (existing && existing.model === model && sameLoras(picks, existing.loras)) {
      loras = existing.loras; // Sogni unreachable: keep the LoRAs this look already had.
    } else {
      throw new Error("Sogni's list of LoRAs could not be reached just now, so the LoRAs could not be checked. Try again in a minute.");
    }
  }

  // Turning the filter off is recorded with who did it; only an owner/admin gets this far.
  const contentFilterOffBy = safeContentFilter
    ? null
    : existing && lookFilterOff(existing)
      ? existing.contentFilterOffBy
      : actorUserId ?? "owner-or-admin";
  return {
    ...base,
    model,
    modelName: info?.name ?? (model && existing?.model === model ? existing.modelName : null),
    loras,
    guidance,
    negativePrompt,
    size,
    safeContentFilter,
    contentFilterOffBy,
  };
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
        const { input, look, referenceFileIds, notes } = prepared;
        const notesSentence = notes.length > 0 ? ` ${notes.join(" ")}` : "";

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
              content: `Generated a ${result.provider} preview and attached it to the issue (${attachment.contentPath}). Submit it for board approval before posting.${seedSentence(seed)}${seedNotUsedSentence(result)}${notesSentence}`,
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
              seedNotUsedSentence(result) +
              notesSentence,
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
              modelName: look.modelName,
              loras: look.loras.map((lora) => ({ name: lora.name, id: lora.id, strength: lora.strength })),
              guidance: look.guidance,
              size: look.size,
              contentFilter: lookFilterOff(look) ? "off" : "on",
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
      const looks = await loadLooks(ctx, companyId);
      const id = typeof params.id === "string" && params.id ? params.id : null;
      const existing = id ? (looks.find((look) => look.id === id) ?? null) : null;
      const fields = await validateLookInput(ctx, companyId, params, context.actor.userId ?? null, existing);
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

    // Sogni's picture models, for the looks page's model picker. Public
    // information (no key); anyone in the company may read it.
    ctx.actions.register(ACTION_SOGNI_MODELS, async (_params, context) => {
      if (!context.companyId) throw new Error("Open this page from inside a company.");
      const catalog = sogniCatalogFor(ctx);
      const list = await catalog.models();
      const loras = await catalog.publicLoras();
      const withLoras = loras ? new Set(loras.models) : null;
      return {
        models: list.models.map((model) => ({ ...model, hasLoras: withLoras ? withLoras.has(model.id) : null })),
        live: list.live,
        updatedAt: list.updatedAt,
        maxLoras: loras?.maxPerRequest ?? SOGNI_MAX_LORAS,
        note: list.live ? null : "Sogni's model list could not be reached just now, so only a few well-known models are shown. Try again in a minute.",
      };
    });

    // The LoRAs that work with one Sogni model: Sogni's public ones, plus the
    // account's own for an owner/admin when the Sogni key is set and the
    // account's plan allows them.
    ctx.actions.register(ACTION_SOGNI_LORAS, async (params, context) => {
      if (!context.companyId) throw new Error("Open this page from inside a company.");
      const rawModel = typeof params.modelId === "string" ? params.modelId.trim() : "";
      if (!rawModel) throw new Error("Pick a Sogni model first.");
      const modelId = sogniCanonicalModelId(assertSogniModelId(rawModel));
      const catalog = sogniCatalogFor(ctx);
      const publicCatalog = await catalog.publicLoras();
      const loras = lorasForModel(publicCatalog, modelId);
      let personal: "included" | "not-allowed" | "no-key" | "unavailable" | "owners-only" = "owners-only";
      let note: string | null = publicCatalog ? null : "Sogni's list of LoRAs could not be reached just now. Try again in a minute.";
      if (context.actor.type === "user" && context.actor.canManageCompany === true) {
        const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
        const key = await resolveSogniKey(ctx, cfg);
        if (!key) {
          personal = "no-key";
        } else {
          const own = await catalog.personalLoras(key);
          personal = own.status;
          loras.push(...own.loras.filter((lora) => lora.modelIds.includes(modelId)));
          if (own.status === "not-allowed") {
            note = note ?? "Your own LoRAs are not shown: they need an active Sogni Unlimited plan.";
          }
        }
      }
      return { modelId, loras, maxLoras: publicCatalog?.maxPerRequest ?? SOGNI_MAX_LORAS, personal, live: publicCatalog !== null, note };
    });

    // Sogni's picture tools and its prompt tool, one agent tool each (ticked
    // per agent on the Tools tab). Parameters come from Sogni's vendored
    // schemas, the same ones the manifest lists.
    for (const def of SOGNI_TOOLS) {
      ctx.tools.register(
        def.name,
        { displayName: def.displayName, description: sogniToolDescription(def), parametersSchema: sogniToolParameters(def) },
        (params, runCtx) => runSogniTool(ctx, def, params, runCtx),
      );
    }

    ctx.logger.info(`media-studio plugin ready (looks page: ${LOOKS_PAGE_ROUTE})`);
  },

  async onHealth() {
    return { status: "ok", message: "Media Studio ready" };
  },
});

// ─── Sogni's tools (upscale, remove background, restore, ...) ────────────────

function sogniTokenType(cfg: Record<string, unknown>): SogniTokenType {
  return (SOGNI_TOKEN_TYPES as readonly string[]).includes(String(cfg.sogniTokenType)) ? (cfg.sogniTokenType as SogniTokenType) : "auto";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one of Media Studio's Sogni tools for an agent. In order, and nothing
 * spent before the last step: the arguments are checked (the tool's schema,
 * built from Sogni's, then Sogni's own schema), the Sogni key must be set,
 * the picture must be a picture in the calling run's company, the agent's
 * daily picture limit is reserved (picture tools only), and only then is
 * Sogni called. The Sensitive Content Filter is always on: nothing an agent
 * sends can turn it off (an unknown argument is refused), and these tools take
 * no look.
 */
async function runSogniTool(
  ctx: PluginContext,
  def: SogniToolDef,
  params: unknown,
  runCtx: { companyId: string; runId: string; agentId: string },
): Promise<ToolResult> {
  const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
  const defaultModel = textOrNull(cfg.sogniModel) ?? SOGNI_DEFAULT_MODEL;
  const prepared = prepareSogniCall(def, params, { defaultModel });
  if ("error" in prepared) return { error: prepared.error };

  const ref = typeof cfg.sogniKeySecretRef === "string" ? cfg.sogniKeySecretRef.trim() : "";
  if (!ref) {
    return {
      error: `${def.displayName} needs a Sogni API key. An admin picks it in Media Studio's settings under "Sogni API key" (the key itself is saved in the company's Secrets).`,
    };
  }
  let apiKey: string;
  try {
    apiKey = await ctx.secrets.resolve(ref);
  } catch (err) {
    return { error: `The Sogni API key picked in Media Studio's settings could not be read: ${errorText(err)}` };
  }
  const sogni = new SogniProvider({
    apiKey,
    apiFetch: (url, init) => ctx.http.fetch(url, init),
    transferFetch: guardedTransferFetch,
    defaultModel,
    tokenType: sogniTokenType(cfg),
  });

  if (def.kind === "text") {
    try {
      const { text } = await sogni.executeTool(def.sogniTool, prepared.arguments, true);
      const model = String(prepared.arguments.destination_model ?? defaultModel);
      return {
        content: `Sogni's improved prompt for ${model}:

${text}`,
        data: { prompt: text, destinationModel: model, targetOutput: prepared.arguments.target_output ?? null, provider: "sogni", tool: def.sogniTool },
      };
    } catch (err) {
      return { error: errorText(err) };
    }
  }

  // The picture: a file (or task attachment) in THIS run's company. Another
  // company's file reads exactly like a missing one.
  const fileId = prepared.fileId!;
  const file = await ctx.files.get(fileId, runCtx.companyId);
  if (!file) {
    return { error: `The picture ${fileId} is not in this company's Files, so it cannot be used. Pick a picture from this company's Files.` };
  }
  const name = file.originalFilename ?? fileId;
  if (!file.contentType.toLowerCase().startsWith("image/")) return { error: `The file "${name}" is not a picture.` };
  if (!isSogniUploadType(file.contentType)) {
    return { error: `Sogni takes PNG, JPEG, WebP or GIF pictures, and "${name}" is ${file.contentType}.` };
  }
  let picture: string;
  try {
    const content = await ctx.files.readContent(fileId, runCtx.companyId);
    picture = `data:${content.contentType.toLowerCase()};base64,${content.contentBase64}`;
  } catch (err) {
    return { error: errorText(err) };
  }

  // DUR-177: every picture-making tool counts toward the agent's daily
  // picture limit, reserved before Sogni is called (see generate-image).
  const reservation = await ctx.personas.reserveDailyGeneration(runCtx.companyId, { runId: runCtx.runId });
  if (!reservation.allowed) {
    return { error: `Daily image limit (${reservation.cap ?? 0}) reached for this agent today.` };
  }

  try {
    const made = await sogni.runPictureTool({
      toolName: def.sogniTool,
      arguments: prepared.arguments,
      pictures: [picture],
      safeContentFilter: true,
    });
    const contentType = assertImageContentType(made.contentType);
    const extension = contentType.split("/")[1]?.replace(/\+.*$/, "") ?? "png";
    const stem = slug((file.originalFilename ?? "").replace(/\.[a-z0-9]+$/i, "")) || "picture";
    const filename = `${def.filenamePrefix}-${stem}.${extension}`;
    const extra = made.artifactCount > 1 ? ` Sogni sent ${made.artifactCount} pictures; the first one was kept.` : "";
    const prompt = typeof prepared.arguments.prompt === "string" ? prepared.arguments.prompt : typeof prepared.arguments.description === "string" ? prepared.arguments.description : def.displayName;
    const record = { seed: null, prompt, look: null, provider: "sogni", model: def.sogniTool, referenceFileIds: [fileId] };

    if (prepared.issueId) {
      // Same rules as Generate image: the host only lets the run attach to a
      // task it may attach to.
      const attachment = await ctx.issues.createAttachment(
        prepared.issueId,
        { contentBase64: made.contentBase64, contentType, filename },
        runCtx.companyId,
        { authorAgentId: runCtx.agentId, runId: runCtx.runId },
      );
      await rememberImage(ctx, runCtx.companyId, attachment.id, record);
      return {
        content: `Made the ${def.resultNoun} with Sogni and attached it to the task (${attachment.contentPath}). File id: ${attachment.id}. Submit it for board approval before posting.${extra}`,
        data: {
          attachmentId: attachment.id,
          contentPath: attachment.contentPath,
          fileId: attachment.id,
          contentType,
          issueId: prepared.issueId,
          seed: null,
          provider: "sogni",
          tool: def.sogniTool,
          sourceFileId: fileId,
        },
      };
    }

    const stored = await ctx.files.createCompanyFile({ contentBase64: made.contentBase64, contentType, filename }, runCtx.companyId, {
      runId: runCtx.runId,
    });
    await rememberImage(ctx, runCtx.companyId, stored.id, record);
    return {
      content:
        `Made the ${def.resultNoun} with Sogni and saved it to the company's Files (not tied to a task); it is shown to the person with your reply. File id: ${stored.id}.` +
        extra,
      data: {
        fileId: stored.id,
        contentPath: stored.contentPath,
        contentType: stored.contentType,
        issueId: null,
        seed: null,
        provider: "sogni",
        tool: def.sogniTool,
        sourceFileId: fileId,
      },
    };
  } catch (err) {
    return { error: errorText(err) };
  }
}

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
