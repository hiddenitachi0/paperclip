import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";
import {
  FAL_REFERENCE_MODEL,
  FalProvider,
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
import { compositeMaskedEdit } from "./mask-composite.js";
import {
  SOGNI_DEFAULT_MODEL,
  SOGNI_MAX_LORAS,
  SOGNI_MAX_REFERENCES,
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
  ACTION_EDIT_CAPABILITIES,
  ACTION_EDIT_FAL,
  ACTION_EDIT_INPAINT,
  ACTION_EDIT_SEGMENT,
  ACTION_EDIT_SOGNI,
  ACTION_GENERATE,
  ACTION_LOOKS_DELETE,
  ACTION_LOOKS_LIST,
  ACTION_LOOK_DEFAULTS_LIST,
  ACTION_LOOK_DEFAULTS_SET,
  ACTION_LOOK_RULES_LIST,
  ACTION_LOOK_PROMPT_PREVIEW,
  ACTION_LOOK_RULES_PREVIEW,
  ACTION_LOOK_RULES_SAVE,
  ACTION_LOOKS_SAVE,
  ACTION_SOGNI_LORAS,
  ACTION_SOGNI_MODELS,
  CHECK_MEDIA_JOB_DESCRIPTION,
  CHECK_MEDIA_JOB_PARAMETERS,
  GENERATE_AUDIO_DESCRIPTION,
  GENERATE_AUDIO_PARAMETERS,
  GENERATE_IMAGE_DESCRIPTION,
  GENERATE_IMAGE_PARAMETERS,
  GENERATE_VIDEO_DESCRIPTION,
  GENERATE_VIDEO_PARAMETERS,
  LIST_LOOKS_DESCRIPTION,
  MAIN_PAGE_ROUTE,
  MAX_REFERENCE_FILES,
  QUICK_PICTURE_DESCRIPTION,
  QUICK_PICTURE_PARAMETERS,
  TOOL_CHECK_MEDIA_JOB,
  TOOL_GENERATE,
  TOOL_GENERATE_AUDIO,
  TOOL_GENERATE_VIDEO,
  TOOL_LIST_LOOKS,
  TOOL_QUICK_PICTURE,
} from "./manifest.js";
import { JOB_KEY_MEDIA_POLL, advanceMediaJobs, findOwnMediaJob, startMediaJob } from "./media-jobs.js";
import {
  FAL_QUICK_STEPS,
  QUICK_PICTURE_PROVIDER_TIMEOUT_MS,
  QUICK_PICTURE_TIMEOUT_MS,
  QUICK_PICTURE_TIMEOUT_SENTENCE,
  isQuickShape,
  quickModelFor,
  quickPictureSize,
  showDuration,
  withQuickTimeout,
  type QuickShape,
} from "./quick-picture.js";
import {
  DEFAULT_TIMEZONE,
  checkRuleSet,
  describeMatch,
  describeRuleConditions,
  firstApplicableRule,
  normalizeRuleSets,
  ownerKeyFor,
  parseOwnerKey,
  withoutLook,
  type LookRuleOwnerKey,
  type LookRuleSet,
} from "./look-rules.js";
import {
  REFERENCE_ROLE_LABELS,
  SHEET_FIELDS,
  SHEET_FIELD_MAX,
  assemblePrompt,
  filledSheetLabels,
  isReferenceRole,
  normalizeRoles,
  normalizeSheet,
  sheetIsEmpty,
  type CharacterSheet,
  type ReferenceRole,
} from "./look-prompt.js";
import { SOGNI_TOOLS, findSogniTool, prepareSogniCall, sogniToolDescription, sogniToolParameters, type SogniToolDef } from "./sogni-tools.js";

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

/** Decode a base64 picture data: URL straight from the browser (the editor never sends a Paperclip address here). */
function bytesFromDataUrl(dataUrl: string, label: string): Buffer {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match || !match[2]) throw new Error(`${label} must be a picture.`);
  return Buffer.from(match[3]!, "base64");
}

/**
 * The fixed prompt for "Remove selected object" (DUR-4331): mode "remove"
 * never takes a client-supplied prompt, so this path cannot be used to
 * smuggle an unfiltered prompt past safeContentFilter under the guise of a
 * removal. Exported so tests can assert the server ignores the client's text.
 */
export const INPAINT_REMOVE_PROMPT =
  "Remove the selected object entirely and fill the area with background that realistically matches the surrounding picture (same lighting, texture and perspective). Do not add any new object, person, text or logo.";

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
  /** What each reference picture is for (face, body, outfit, ...), one per picture, in the same order. Older looks: all "other". */
  referenceRoles: ReferenceRole[];
  /** Character sheet: short text per field (hair, face, outfit, ...). Older looks: empty. */
  sheet: CharacterSheet;
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

/** Fill in what older looks do not have: no LoRAs or settings, the content filter on, every picture "other", an empty sheet. */
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
    referenceRoles: normalizeRoles(raw.referenceRoles, look.referenceFileIds.length),
    sheet: normalizeSheet(raw.sheet),
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

/** Matches a saved look by id first (DUR-4138: morning-report settings store a stable lookId), then by name (the normal chat "look: X" path). */
function findLook(looks: Look[], nameOrId: string): Look | undefined {
  const byId = looks.find((look) => look.id === nameOrId);
  if (byId) return byId;
  const wanted = nameOrId.trim().toLowerCase();
  return looks.find((look) => look.name.trim().toLowerCase() === wanted);
}

// ─── Default look per agent ──────────────────────────────────────────────────
//
// An owner/admin can give an agent a default look: used for every picture
// that agent makes without naming a look. Stored per company next to the
// looks (plugin state, scope "company", the host-verified company id) as
// { agentId: lookId }. The agent is always the run's own agent as the host
// resolved it (runCtx.agentId), never anything from the tool input. A
// default look is the same saved look, applied the same way: it cannot do
// anything the look itself cannot (the content filter included).

const LOOK_DEFAULTS_STATE_KEY = "lookDefaults";

function lookDefaultsScope(companyId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey: LOOK_DEFAULTS_STATE_KEY };
}

/** The company's agentId -> lookId map. Anything malformed is left out. */
export async function loadLookDefaults(ctx: PluginContext, companyId: string): Promise<Record<string, string>> {
  const raw = await ctx.state.get(lookDefaultsScope(companyId));
  const defaults: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  for (const [agentId, lookId] of Object.entries(raw as Record<string, unknown>)) {
    if (agentId && typeof lookId === "string" && lookId) defaults[agentId] = lookId;
  }
  return defaults;
}

/** Only defaults that still point at a saved look. */
function liveDefaults(defaults: Record<string, string>, looks: Look[]): Record<string, string> {
  const ids = new Set(looks.map((look) => look.id));
  return Object.fromEntries(Object.entries(defaults).filter(([, lookId]) => ids.has(lookId)));
}

// ─── Automatic looks (look rules) ────────────────────────────────────────────
//
// An owner/admin can give a person (every job that person holds) or a job
// without a person an ordered list of rules: "08:00-12:00 use look X",
// "a message that says 'work' uses look Y". Stored per company next to the
// looks (plugin state, scope "company", the host-verified company id) as
// { "persona:<id>" | "agent:<id>": { timezone, rules[] } }. Whose rules apply
// is decided from the run's own agent as the host resolved it (runCtx), and
// that agent's person as the host reads it; never from the tool input.
// Keywords are looked for in the person's own message, which only the host
// fills in (quick-agent chats), and in the picture's description.

const LOOK_RULES_STATE_KEY = "lookRules";

function lookRulesScope(companyId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey: LOOK_RULES_STATE_KEY };
}

export async function loadLookRules(ctx: PluginContext, companyId: string): Promise<Record<string, LookRuleSet>> {
  return normalizeRuleSets(await ctx.state.get(lookRulesScope(companyId)));
}

/** Whose rules this agent follows: its person's when it has one (in this company), else its own. */
async function ruleOwnerForAgent(ctx: PluginContext, companyId: string, agentId: string): Promise<LookRuleOwnerKey> {
  try {
    const agent = (await ctx.agents.get(agentId, companyId)) as { id: string; companyId: string; personaId?: string | null } | null;
    if (agent && agent.companyId === companyId) return ownerKeyFor(agent);
  } catch (err) {
    ctx.logger.warn(`media-studio: could not read the agent for its automatic looks: ${err instanceof Error ? err.message : String(err)}`);
  }
  return `agent:${agentId}`;
}

export interface AutomaticLook {
  look: Look;
  reason: "rule" | "agent-default";
  /** "rule: 08:00–12:00 on weekdays", "rule: keyword 'work'" or "default look". */
  text: string;
  /** The rule's place in the list (from 1), for a rule. */
  rulePosition: number | null;
}

/**
 * The look for a picture where no look was named: the first automatic look
 * rule that applies right now, else the agent's default look, else none.
 */
export async function automaticLook(
  ctx: PluginContext,
  companyId: string,
  agentId: string,
  input: { looks: Look[]; texts: Array<string | null | undefined>; now?: Date },
): Promise<AutomaticLook | null> {
  const byId = new Map(input.looks.map((look) => [look.id, look]));
  const owner = await ruleOwnerForAgent(ctx, companyId, agentId);
  const set = (await loadLookRules(ctx, companyId))[owner];
  const match = firstApplicableRule(set, { now: input.now ?? new Date(), texts: input.texts, lookExists: (id) => byId.has(id) });
  if (match) return { look: byId.get(match.rule.lookId)!, reason: "rule", text: describeMatch(match), rulePosition: match.position };
  const lookId = (await loadLookDefaults(ctx, companyId))[agentId];
  const fallback = lookId ? byId.get(lookId) : undefined;
  return fallback ? { look: fallback, reason: "agent-default", text: "default look", rulePosition: null } : null;
}

/** Why a picture used the look it did; said back to the agent so it can tell the person. */
export type LookReason = "look-input" | "named-in-request" | "rule" | "agent-default";

/** The same, in plain words ("rule: 08:00–12:00 on weekdays", "default look"), for the tool result's data. */
function lookReasonText(reason: LookReason | null, ruleText: string | null): string | null {
  switch (reason) {
    case "look-input":
      return "named as the look";
    case "named-in-request":
      return "named in the request";
    case "rule":
      return ruleText ?? "rule";
    case "agent-default":
      return "default look";
    default:
      return null;
  }
}

const WORD_CHAR = "[\\p{L}\\p{N}_]";
/** What may sit between "look" and a look's name: spaces, a colon, quotes, a hyphen ("look: Maja Night", 'look "B"', "B-look"). */
const LOOK_GAP = "[\\s:\"'\u201c\u201d\u2018\u2019\u00ab\u00bb-]+";
/** A name this short is only taken from the text with the word "look" right next to it. */
const SHORT_LOOK_NAME = 2;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A look's name as a pattern: its words in order, any spacing between them. */
function lookNamePattern(name: string): string {
  return name.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
}

function wholeWords(pattern: string): string {
  return `(?<!${WORD_CHAR})${pattern}(?!${WORD_CHAR})`;
}

function nextToLookWord(name: string): RegExp {
  const core = lookNamePattern(name);
  return new RegExp(`${wholeWords(`look${LOOK_GAP}${core}`)}|${wholeWords(`${core}${LOOK_GAP}look`)}`, "iu");
}

/**
 * The saved look the request's text names, when the agent left `look` empty
 * but wrote "in look Maja Night" or "Maja Night look" into the prompt. Whole
 * words only and case-insensitive; a name of one or two characters only
 * counts with the word "look" right next to it. A name mentioned next to
 * "look" beats one that is only mentioned; a longer name beats one inside it
 * ("Maja Night" over "Maja"). When two different looks are still left, the
 * request is ambiguous and nothing is guessed.
 */
export function lookMentionedIn(prompt: string, looks: Look[]): { look: Look } | { ambiguous: Look[] } | null {
  const found: Array<{ look: Look; nextToLook: boolean }> = [];
  for (const look of looks) {
    const name = look.name.trim();
    if (!name) continue;
    const nextToLook = nextToLookWord(name).test(prompt);
    const short = name.length <= SHORT_LOOK_NAME;
    if (nextToLook || (!short && new RegExp(wholeWords(lookNamePattern(name)), "iu").test(prompt))) {
      found.push({ look, nextToLook });
    }
  }
  if (found.length === 0) return null;
  const strongest = found.some((f) => f.nextToLook) ? found.filter((f) => f.nextToLook) : found;
  // Drop a look whose name is only part of another mentioned look's name.
  const left = strongest.filter(
    (f) =>
      !strongest.some(
        (other) =>
          other.look.id !== f.look.id &&
          other.look.name.trim().length > f.look.name.trim().length &&
          new RegExp(wholeWords(lookNamePattern(f.look.name)), "iu").test(other.look.name),
      ),
  );
  return left.length === 1 ? { look: left[0]!.look } : { ambiguous: left.map((f) => f.look) };
}

/** The sentence the tool result carries about the look (or none). */
function lookUsedSentence(look: Look | null, reason: LookReason | null, reasonText: string | null = null): string {
  if (!look) return "";
  if (reason === "rule") {
    return ` Used the saved look "${look.name}" (automatic look, ${reasonText ?? "rule"}, because no look was named).`;
  }
  if (reason === "agent-default") {
    return ` Used the saved look "${look.name}" (your default look, because no look was named).`;
  }
  if (reason === "named-in-request") return ` Used the saved look "${look.name}" (named in the request).`;
  return ` Used the saved look "${look.name}".`;
}

function lookNamesSentence(looks: Look[]): string {
  if (looks.length === 0) {
    return "No looks are saved yet. A company owner or admin can add them under Company settings, Media Studio looks.";
  }
  return `Saved looks: ${looks.map((look) => look.name).join(", ")}.`;
}

function describeLook(look: Look, isYourDefault = false): string {
  const extras: string[] = [];
  if (isYourDefault) extras.push("your default look: used when you name no look");
  if (look.seed !== null) extras.push(`fixed seed ${look.seed}`);
  if (look.referenceFileIds.length > 0) {
    const roles = look.referenceRoles.some((role) => role !== "other")
      ? ` (${look.referenceRoles.map((role) => REFERENCE_ROLE_LABELS[role].toLowerCase()).join(", ")})`
      : "";
    extras.push(`${look.referenceFileIds.length} reference picture${look.referenceFileIds.length === 1 ? "" : "s"}${roles}`);
  }
  if (!sheetIsEmpty(look.sheet)) extras.push(`character sheet: ${filledSheetLabels(look.sheet).join(", ").toLowerCase()}`);
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

/** One role per reference picture (from the looks page). A missing role is "other"; an unknown one is refused. */
function readReferenceRoles(value: unknown, count: number): ReferenceRole[] {
  if (value === undefined || value === null) return normalizeRoles([], count);
  if (!Array.isArray(value) || value.length > count || value.some((role) => role !== null && role !== "" && !isReferenceRole(role))) {
    throw new Error("Pick what each reference picture is for (face, body, outfit, style, background or other).");
  }
  return normalizeRoles(value, count);
}

/** The character sheet from the looks page: known fields only, each short. */
function readSheet(value: unknown): CharacterSheet {
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw new Error("The character sheet could not be read. Fill it in again.");
  }
  const sheet = normalizeSheet(value);
  for (const field of SHEET_FIELDS) {
    if ((sheet[field.key]?.length ?? 0) > SHEET_FIELD_MAX) {
      throw new Error(`Keep "${field.label}" under ${SHEET_FIELD_MAX} characters.`);
    }
  }
  return sheet;
}

/**
 * How many reference pictures a Sogni look with this model can keep: the
 * model's own limit when it edits pictures (from the catalog, else Sogni's
 * docs), else the limit of Sogni's default picture editor (3).
 */
export function lookReferenceLimit(model: string | null, info: SogniModelInfo | null): number {
  const takes = info?.takesReferences === true;
  return sogniMaxReferences(model ?? undefined, takes, info?.maxReferences ?? null);
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
  /** Why this look: named as look, named in the request's text, an automatic look rule, or the agent's default. Null without a look. */
  lookReason: LookReason | null;
  /** The same in plain words: "rule: 08:00–12:00 on weekdays", "rule: keyword 'work'", "default look", "named in the request". */
  lookReasonText: string | null;
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
): Promise<{ error: string } | { info: SogniModelInfo | null; editing: boolean; usesOwnModel: boolean }> {
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

  // The chosen model's own limit from Sogni's catalog when it is the editor used, else the docs' number.
  const max = sogniMaxReferences(input.model, input.modelTakesReferences, usesOwnModel ? (info?.maxReferences ?? null) : null);
  if (referenceCount > max) {
    return {
      error: `Sogni's ${sogniReferenceModel(input.model, input.modelTakesReferences)} model takes at most ${max} reference pictures (this asked for ${referenceCount}).`,
    };
  }
  if (editing) input.maxReferences = max;
  return { info, editing, usesOwnModel };
}

/**
 * DUR-4133/DUR-4138: the fixed "things to avoid" text merged onto a picture
 * made with `safeForWork: true` — used for pictures nobody reviews before
 * they go out (the morning report's illustrations). DUR-4138: this text
 * (plus "fully clothed" in the prompt) is the *only* safety net `safeForWork`
 * adds now — it no longer touches the provider's own content-filter switch,
 * see the `safeForWork` block below.
 */
export const SAFE_FOR_WORK_AVOID = "nudity, nsfw, text, letters, words, watermark, logo";

/**
 * Validate the tool input and apply a saved look. Nothing here spends
 * anything: it runs before the daily limit is reserved, so a typo in a look
 * name does not use up one of the day's pictures.
 */
export async function prepareGeneration(
  ctx: PluginContext,
  companyId: string,
  params: Record<string, unknown>,
  /**
   * The calling agent, as the host resolved it for this run, and the person's
   * own message for this turn when the host provides it (quick-agent chats).
   * Neither ever comes from the tool input.
   */
  options: { agentId?: string | null; requesterMessage?: string | null; now?: Date } = {},
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
  // DUR-4138 (was DUR-4133): adds "fully clothed" and a fixed safety negative
  // prompt to the request, regardless of any look's own text. It does NOT
  // touch the provider's own content filter switch any more — that stays the
  // chosen look's own setting (or the company/provider default below), so an
  // operator's own filter-off preference (e.g. Filip's Sogni account) is
  // never silently overridden. Not in any tool's public parameters schema, so
  // an ordinary chat agent cannot set it — only first-party server code
  // building `parameters` directly (the morning report's pictures) does.
  const safeForWork = params.safeForWork === true;

  // Which look, in order: the one named as look; else one the request's
  // text names ("in look Maja Night"); else the first automatic look rule
  // that applies right now; else the agent's default look. "none" skips all
  // of that — not named, not mentioned, no automatic rule, no default — for
  // pictures that must never carry any person's look (DUR-4133: the morning
  // report's mood picture).
  let look: Look | null = null;
  let lookReason: LookReason | null = null;
  let ruleText: string | null = null;
  const rawLook = typeof params.look === "string" ? params.look.trim() : "";
  const noLook = rawLook.toLowerCase() === "none";
  if (noLook) {
    // Leave look/lookReason null: no named, mentioned, automatic or default look.
  } else if (rawLook) {
    const looks = await loadLooks(ctx, companyId);
    look = findLook(looks, rawLook) ?? null;
    if (!look) return { error: `There is no saved look called "${rawLook}". ${lookNamesSentence(looks)}` };
    lookReason = "look-input";
  } else {
    const looks = await loadLooks(ctx, companyId);
    if (looks.length > 0) {
      const mentioned = lookMentionedIn(input.prompt, looks);
      if (mentioned && "ambiguous" in mentioned) {
        return {
          error: `The request names more than one saved look (${mentioned.ambiguous.map((l) => `"${l.name}"`).join(", ")}). Pass the one to use as look.`,
        };
      }
      if (mentioned) {
        look = mentioned.look;
        lookReason = "named-in-request";
      } else if (options.agentId) {
        // Keywords: the person's own message first, the picture's description as well.
        const auto = await automaticLook(ctx, companyId, options.agentId, {
          looks,
          texts: [options.requesterMessage, input.prompt],
          now: options.now,
        });
        if (auto) {
          look = auto.look;
          lookReason = auto.reason;
          if (auto.reason === "rule") ruleText = auto.text;
        }
      }
    }
  }

  const referenceFileIds = [...(look?.referenceFileIds ?? [])];
  // The look's pictures keep their roles; pictures the agent adds are "other".
  const referenceRoles: ReferenceRole[] = [...(look?.referenceRoles ?? [])];
  for (const id of requestedRefs) {
    if (!referenceFileIds.includes(id)) {
      referenceFileIds.push(id);
      referenceRoles.push("other");
    }
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
  // Sogni's picture-editing models take up to 16 (each model's own limit is checked below); Fal's Kontext 4.
  const referenceCap = chosen.service === "sogni" ? SOGNI_MAX_REFERENCES : MAX_REFERENCE_FILES;
  if (referenceFileIds.length > referenceCap) {
    return { error: `At most ${referenceCap} reference pictures can be used at once (this asked for ${referenceFileIds.length}).` };
  }
  // The look's model is used when the call names no model, or names the look's own model.
  const lookModelUsed = callModel
    ? Boolean(look?.model) && sogniCanonicalModelId(callModel) === sogniCanonicalModelId(look!.model!)
    : Boolean(look?.model) && chosen.useLookModel;
  if (lookModelUsed && !callModel) input.model = look!.model!;

  const notes: string[] = [];
  // Sogni's own limits, checked here so a mistake does not use up one of the day's pictures.
  let negativeAllowed = false;
  if (chosen.service === "sogni") {
    const prepared = await prepareSogni(ctx, cfg, input, look, lookModelUsed, referenceFileIds.length, notes);
    if ("error" in prepared) return prepared;
    // "Always avoid" goes into the model's own "things to avoid" text when this picture can use it.
    negativeAllowed = !prepared.editing && prepared.usesOwnModel && prepared.info?.negativePrompt != null;
  }

  // The final prompt: the request, what each picture is for, the look's sheet and style words.
  const assembled = assemblePrompt({
    request: input.prompt,
    style: look?.style,
    sheet: look?.sheet,
    roles: referenceFileIds.length > 0 ? referenceRoles : [],
    service: chosen.service,
    avoidAsNegative: negativeAllowed,
  });
  input.prompt = assembled.prompt;
  if (assembled.avoid) {
    const merged = input.negativePrompt ? `${input.negativePrompt}, ${assembled.avoid}` : assembled.avoid;
    if (merged.length <= SOGNI_NEGATIVE_PROMPT_MAX) input.negativePrompt = merged;
    else input.prompt = `${input.prompt}\n\nKeep out of the picture: ${assembled.avoid.replace(/[\s.]+$/, "")}.`;
  }
  if (look && assembled.leftOut.length > 0) {
    const labels = SHEET_FIELDS.filter((f) => assembled.leftOut.includes(f.key)).map((f) => f.label.toLowerCase());
    notes.push(`The look's ${labels.join(", ")} ${labels.length === 1 ? "was" : "were"} left out, because the request describes ${labels.length === 1 ? "it" : "them"}.`);
  }
  if (safeForWork) {
    // DUR-4138: does NOT touch input.safeContentFilter any more — that stays
    // whatever the look/provider/company resolution above already set it to
    // (a look's own filter-off setting is respected, exactly like any other
    // picture). Safety here is prompt-only: "fully clothed" plus the fixed
    // negative prompt, always, for a picture nobody reviews before it goes
    // out (the morning report's illustrations).
    input.prompt = `${input.prompt}\n\nFully clothed.`;
    if (negativeAllowed) {
      const merged = input.negativePrompt ? `${input.negativePrompt}, ${SAFE_FOR_WORK_AVOID}` : SAFE_FOR_WORK_AVOID;
      if (merged.length <= SOGNI_NEGATIVE_PROMPT_MAX) input.negativePrompt = merged;
      else input.prompt = `${input.prompt}\n\nKeep out of the picture: ${SAFE_FOR_WORK_AVOID}.`;
    } else {
      input.prompt = `${input.prompt}\n\nKeep out of the picture: ${SAFE_FOR_WORK_AVOID}.`;
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
  return { input, look, lookReason, lookReasonText: lookReasonText(lookReason, ruleText), referenceFileIds, notes };
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
  if (refs.length > SOGNI_MAX_REFERENCES) throw new Error(`Pick at most ${SOGNI_MAX_REFERENCES} reference pictures.`);
  const referenceRoles = readReferenceRoles(params.referenceRoles, refs.length);
  const sheet = readSheet(params.sheet);
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
  const base = { name, style, provider, seed: seed ?? null, referenceFileIds: refs, referenceRoles, sheet };

  if (service !== "sogni") {
    if (refs.length > MAX_REFERENCE_FILES) {
      throw new Error(`Pick at most ${MAX_REFERENCE_FILES} reference pictures (more need a Sogni picture-editing model that takes more).`);
    }
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
  if (refs.length > 0) {
    const max = lookReferenceLimit(model, info);
    if (refs.length > max) {
      const editor = sogniReferenceModel(model ?? undefined, info?.takesReferences === true);
      throw new Error(
        `Sogni's ${info && sogniCanonicalModelId(editor) === info.id ? info.name : editor} model takes at most ${max} reference pictures; this look has ${refs.length}. Remove some, or pick a model that takes more.`,
      );
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

interface RuleOwner {
  key: LookRuleOwnerKey;
  kind: "persona" | "agent";
  name: string;
  jobs: Array<{ id: string; name: string; title: string | null }>;
}

/**
 * Who can have automatic looks: each person (persona) holding at least one
 * of the company's jobs, and each job without a person. Terminated jobs and
 * other companies' jobs are left out.
 */
async function ruleOwners(ctx: PluginContext, companyId: string): Promise<RuleOwner[]> {
  const agents = (await ctx.agents.list({ companyId })) as Array<{
    id: string;
    companyId: string;
    name: string;
    title?: string | null;
    status: string;
    personaId?: string | null;
    persona?: { displayName?: string | null } | null;
  }>;
  const owners = new Map<string, RuleOwner>();
  for (const agent of agents) {
    if (agent.companyId !== companyId || agent.status === "terminated") continue;
    const key = ownerKeyFor(agent);
    const job = { id: agent.id, name: agent.name, title: agent.title ?? null };
    const existing = owners.get(key);
    if (existing) {
      existing.jobs.push(job);
      continue;
    }
    owners.set(key, {
      key,
      kind: agent.personaId ? "persona" : "agent",
      name: agent.personaId ? agent.persona?.displayName?.trim() || `${agent.name}'s person` : agent.name,
      jobs: [job],
    });
  }
  const list = [...owners.values()];
  for (const owner of list) owner.jobs.sort((a, b) => a.name.localeCompare(b.name));
  // People first, then jobs without a person; each by name.
  return list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "persona" ? -1 : 1));
}

async function findRuleOwner(ctx: PluginContext, companyId: string, rawKey: unknown): Promise<RuleOwner> {
  const parsed = parseOwnerKey(rawKey);
  if (!parsed) throw new Error("Pick a person or an agent.");
  const owner = (await ruleOwners(ctx, companyId)).find((o) => o.key === `${parsed.kind}:${parsed.id}`);
  if (owner) return owner;
  if (parsed.kind === "agent") {
    const agent = (await ctx.agents.get(parsed.id, companyId)) as { companyId: string; personaId?: string | null; status: string } | null;
    if (agent && agent.companyId === companyId && agent.status !== "terminated" && agent.personaId) {
      throw new Error("This agent is one of a person's jobs, so it follows that person's automatic looks. Pick the person instead.");
    }
  }
  throw new Error("That person or agent is not in this company. Reload the page.");
}

/**
 * The automatic looks that apply to this agent, in plain words for the
 * list-looks tool: only switched-on rules whose look still exists, in order.
 */
async function describeAgentRules(
  ctx: PluginContext,
  companyId: string,
  agentId: string,
  looks: Look[],
): Promise<{ text: string; lines: string[]; data: { timezone: string; rules: Array<{ position: number; look: string; when: string }> } | null }> {
  const byId = new Map(looks.map((look) => [look.id, look]));
  const owner = await ruleOwnerForAgent(ctx, companyId, agentId);
  const set = (await loadLookRules(ctx, companyId))[owner];
  const live = (set?.rules ?? []).filter((rule) => rule.enabled && byId.has(rule.lookId));
  if (!set || live.length === 0) return { text: "", lines: [], data: null };
  const rows = live.map((rule, i) => ({ position: i + 1, look: byId.get(rule.lookId)!.name, when: describeRuleConditions(rule) }));
  const lines = rows.map((row) => `${row.position}. "${row.look}": ${row.when}.`);
  const now = firstApplicableRule({ ...set, rules: live }, { now: new Date(), texts: [], lookExists: (id) => byId.has(id) });
  const nowSentence = now
    ? `\nRight now, without any keyword, "${byId.get(now.rule.lookId)!.name}" would be used (${describeMatch(now)}).`
    : "\nRight now no time rule fits, so only a keyword rule (or your default look) can pick a look.";
  const text =
    `\nAutomatic looks: when no look is named, these are checked from the top and the first that fits is used (times are ${set.timezone} time; keywords are looked for in the person's message and in the picture's description):\n` +
    lines.join("\n") +
    nowSentence;
  return { text, lines, data: { timezone: set.timezone, rules: rows } };
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

        // The agent is the run's own, as the host resolved it; the input cannot name another.
        // The person's message is the host's (quick-agent chats only); the input cannot supply it.
        const prepared = await prepareGeneration(ctx, runCtx.companyId, rawParams, {
          agentId: runCtx.agentId,
          requesterMessage: typeof runCtx.requesterMessage === "string" ? runCtx.requesterMessage : null,
        });
        if ("error" in prepared) return { error: prepared.error };
        const { input, look, lookReason, lookReasonText: reasonText, referenceFileIds, notes } = prepared;
        const notesSentence = notes.length > 0 ? ` ${notes.join(" ")}` : "";
        const lookSentence = lookUsedSentence(look, lookReason, reasonText);

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
              content: `Generated a ${result.provider} preview and attached it to the issue (${attachment.contentPath}). Submit it for board approval before posting.${lookSentence}${seedSentence(seed)}${seedNotUsedSentence(result)}${notesSentence}`,
              data: {
                ...result,
                attachmentId: attachment.id,
                contentPath: attachment.contentPath,
                fileId: attachment.id,
                issueId,
                seed,
                look: look?.name ?? null,
                lookReason,
                lookReasonText: reasonText,
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
              lookReason,
              lookReasonText: reasonText,
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

    // A quick, small mood picture to go along with a message (ticked per agent
    // separately from Generate image).
    ctx.tools.register(
      TOOL_QUICK_PICTURE,
      {
        displayName: "Quick picture",
        description: QUICK_PICTURE_DESCRIPTION,
        parametersSchema: QUICK_PICTURE_PARAMETERS as unknown as Record<string, unknown>,
      },
      (params, runCtx) => runQuickPicture(ctx, (params ?? {}) as Record<string, unknown>, runCtx),
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
        if (looks.length === 0) return { content: lookNamesSentence(looks), data: { looks: [], defaultLook: null } };
        // The calling agent's own default, as the host resolved the agent for this run.
        const defaultId = (await loadLookDefaults(ctx, runCtx.companyId))[runCtx.agentId] ?? null;
        const defaultLook = looks.find((look) => look.id === defaultId) ?? null;
        const rules = await describeAgentRules(ctx, runCtx.companyId, runCtx.agentId, looks);
        const defaultSentence = defaultLook
          ? `\nYour default look is "${defaultLook.name}": it is used for every picture where no look is named${rules.lines.length > 0 ? " and no automatic look fits" : ""}. A look named in the request wins over it.`
          : "";
        return {
          content: `Saved looks:\n${looks.map((look) => describeLook(look, look.id === defaultLook?.id)).join("\n")}${rules.text}${defaultSentence}`,
          data: {
            defaultLook: defaultLook?.name ?? null,
            automaticLooks: rules.data,
            looks: looks.map((look) => ({
              name: look.name,
              yourDefault: look.id === defaultLook?.id,
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
              referenceRoles: look.referenceRoles,
              sheet: look.sheet,
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
      // No agent keeps a default that points at a deleted look.
      const defaults = await loadLookDefaults(ctx, companyId);
      const kept = liveDefaults(defaults, next);
      if (Object.keys(kept).length !== Object.keys(defaults).length) await ctx.state.set(lookDefaultsScope(companyId), kept);
      // Nor does any automatic look rule.
      const cleaned = withoutLook(await loadLookRules(ctx, companyId), id);
      if (cleaned.changed) await ctx.state.set(lookRulesScope(companyId), cleaned.sets);
      return { looks: next, defaults: kept, lookRules: cleaned.sets };
    });

    // "Preview prompt" on the looks page: the exact text a look (as it is in
    // the form, saved or not) would send for a sample request. Nothing is
    // made or spent; anyone in the company may try it.
    ctx.actions.register(ACTION_LOOK_PROMPT_PREVIEW, async (params, context) => {
      if (!context.companyId) throw new Error("Open this page from inside a company.");
      return previewLookPrompt(ctx, params);
    });

    // Default look per agent (same page). Anyone in the company may see it;
    // only an owner/admin may change it. The agents are the company's own,
    // read through the host (capability agents.read), terminated ones left out.
    ctx.actions.register(ACTION_LOOK_DEFAULTS_LIST, async (_params, context) => {
      if (!context.companyId) throw new Error("Open this page from inside a company.");
      const companyId = context.companyId;
      const [agents, looks, defaults] = await Promise.all([
        ctx.agents.list({ companyId }),
        loadLooks(ctx, companyId),
        loadLookDefaults(ctx, companyId),
      ]);
      return {
        agents: agents
          .filter((agent) => agent.companyId === companyId && agent.status !== "terminated")
          .map((agent) => ({ id: agent.id, name: agent.name, title: agent.title ?? null }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        defaults: liveDefaults(defaults, looks),
        canManage: context.actor.type === "user" && context.actor.canManageCompany === true,
      };
    });

    ctx.actions.register(ACTION_LOOK_DEFAULTS_SET, async (params, context) => {
      const companyId = assertCanManageLooks(context);
      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      if (!agentId) throw new Error("Pick an agent.");
      const agent = await ctx.agents.get(agentId, companyId);
      if (!agent || agent.companyId !== companyId || agent.status === "terminated") {
        throw new Error("That agent is not in this company. Reload the page.");
      }
      const lookId = typeof params.lookId === "string" ? params.lookId.trim() : "";
      const looks = await loadLooks(ctx, companyId);
      if (lookId && !looks.some((look) => look.id === lookId)) throw new Error("That look no longer exists. Reload the page.");
      const defaults = liveDefaults(await loadLookDefaults(ctx, companyId), looks);
      if (lookId) defaults[agentId] = lookId;
      else delete defaults[agentId];
      await ctx.state.set(lookDefaultsScope(companyId), defaults);
      return { defaults };
    });

    // Automatic looks (same page). Anyone in the company may see them and try
    // the preview; only an owner/admin may change them. The people and jobs
    // are the company's own, read through the host (agents.read).
    ctx.actions.register(ACTION_LOOK_RULES_LIST, async (_params, context) => {
      if (!context.companyId) throw new Error("Open this page from inside a company.");
      const companyId = context.companyId;
      const [owners, looks, sets, defaults] = await Promise.all([
        ruleOwners(ctx, companyId),
        loadLooks(ctx, companyId),
        loadLookRules(ctx, companyId),
        loadLookDefaults(ctx, companyId),
      ]);
      const live = liveDefaults(defaults, looks);
      return {
        owners: owners.map((owner) => ({
          ...owner,
          jobs: owner.jobs.map((job) => ({ ...job, defaultLookId: live[job.id] ?? null })),
        })),
        ruleSets: Object.fromEntries(owners.filter((owner) => sets[owner.key]).map((owner) => [owner.key, sets[owner.key]])),
        defaultTimezone: DEFAULT_TIMEZONE,
        canManage: context.actor.type === "user" && context.actor.canManageCompany === true,
      };
    });

    ctx.actions.register(ACTION_LOOK_RULES_SAVE, async (params, context) => {
      const companyId = assertCanManageLooks(context);
      const owner = await findRuleOwner(ctx, companyId, params.ownerKey);
      const looks = await loadLooks(ctx, companyId);
      const set = checkRuleSet(
        { timezone: params.timezone, rules: params.rules },
        new Set(looks.map((look) => look.id)),
      );
      const sets = await loadLookRules(ctx, companyId);
      sets[owner.key] = set;
      await ctx.state.set(lookRulesScope(companyId), sets);
      return { ownerKey: owner.key, ruleSet: set };
    });

    // "Right now this would pick: ..." for the page, with a test message.
    ctx.actions.register(ACTION_LOOK_RULES_PREVIEW, async (params, context) => {
      if (!context.companyId) throw new Error("Open this page from inside a company.");
      const companyId = context.companyId;
      const owner = await findRuleOwner(ctx, companyId, params.ownerKey);
      const message = typeof params.message === "string" ? params.message.slice(0, 4000) : "";
      const [looks, sets, defaults] = await Promise.all([loadLooks(ctx, companyId), loadLookRules(ctx, companyId), loadLookDefaults(ctx, companyId)]);
      const byId = new Map(looks.map((look) => [look.id, look]));
      const set = sets[owner.key] ?? { timezone: DEFAULT_TIMEZONE, rules: [] };
      const now = new Date();
      const match = firstApplicableRule(set, { now, texts: [message], lookExists: (id) => byId.has(id) });
      const live = liveDefaults(defaults, looks);
      return {
        timezone: set.timezone,
        localTime: new Intl.DateTimeFormat("en-GB", { timeZone: set.timezone, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now),
        rule: match
          ? { id: match.rule.id, position: match.position, lookId: match.rule.lookId, lookName: byId.get(match.rule.lookId)!.name, why: describeMatch(match) }
          : null,
        fallbacks: owner.jobs.map((job) => ({
          agentId: job.id,
          agentName: job.name,
          lookName: live[job.id] ? (byId.get(live[job.id]!)?.name ?? null) : null,
        })),
      };
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
        models: list.models.map((model) => ({
          ...model,
          hasLoras: withLoras ? withLoras.has(model.id) : null,
          // How many reference pictures a look with this model can keep (the same rule as saving).
          referenceLimit: lookReferenceLimit(model.id, model),
        })),
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

    // Media Studio's Edit tab (DUR-4063): a person editing a picture directly
    // in the browser, not an agent. Which AI edit buttons to show — the tab
    // hides a button whose service has no key instead of offering one that
    // would just fail.
    ctx.actions.register(ACTION_EDIT_CAPABILITIES, async (_params, context) => {
      if (!context.companyId) throw new Error("Open this page from inside a company.");
      const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
      const sogniRef = typeof cfg.sogniKeySecretRef === "string" ? cfg.sogniKeySecretRef.trim() : "";
      const falRef = typeof cfg.falKeySecretRef === "string" ? cfg.falKeySecretRef.trim() : "";
      return { sogni: sogniRef.length > 0, fal: falRef.length > 0 };
    });

    // Run one Sogni picture tool (restore/upscale/remove background) on a
    // picture the person is editing. This is deliberately its own path, not
    // runSogniTool: it takes the picture's bytes straight from the browser
    // (the picture is already open in the editor) instead of re-reading
    // ctx.files, and it does not reserve the agent daily-picture cap --
    // that cap is per-agent, and this is a human editing their own picture,
    // not an agent run.
    ctx.actions.register(ACTION_EDIT_SOGNI, async (params, context) => {
      if (context.actor.type !== "user") throw new Error("This is only for a person editing a picture in Media Studio.");
      if (!context.companyId) throw new Error("Open this page from inside a company.");
      const raw = (params ?? {}) as Record<string, unknown>;
      const toolName = typeof raw.tool === "string" ? raw.tool : "";
      const def = SOGNI_TOOLS.find((d) => d.name === toolName && d.kind === "picture");
      if (!def) throw new Error("Unknown edit action.");
      const imageDataUrl = typeof raw.imageDataUrl === "string" ? raw.imageDataUrl : "";
      if (!/^data:image\//i.test(imageDataUrl)) throw new Error("Open a picture in the editor first.");

      const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
      const defaultModel = textOrNull(cfg.sogniModel) ?? SOGNI_DEFAULT_MODEL;
      const callParams: Record<string, unknown> = { ...raw, fileId: "editor" };
      delete callParams.tool;
      delete callParams.imageDataUrl;
      // The host bridge splices its own authorized companyId (and, for some
      // calls, renderEnvironment) onto every action's params; neither is a
      // Sogni argument, so they must not reach prepareSogniCall's strict
      // schema check.
      delete callParams.companyId;
      delete callParams.renderEnvironment;
      const prepared = prepareSogniCall(def, callParams, { defaultModel });
      if ("error" in prepared) throw new Error(prepared.error);

      const ref = typeof cfg.sogniKeySecretRef === "string" ? cfg.sogniKeySecretRef.trim() : "";
      if (!ref) {
        throw new Error("Ask an admin to add a Sogni API key in Media Studio settings to use AI edits.");
      }
      let apiKey: string;
      try {
        apiKey = await ctx.secrets.resolve(ref);
      } catch (err) {
        throw new Error(`The Sogni API key picked in Media Studio's settings could not be read: ${errorText(err)}`);
      }
      const sogni = new SogniProvider({
        apiKey,
        apiFetch: (url, init) => ctx.http.fetch(url, init),
        transferFetch: guardedTransferFetch,
        defaultModel,
        tokenType: sogniTokenType(cfg),
      });
      try {
        const made = await sogni.runPictureTool({
          toolName: def.sogniTool,
          arguments: prepared.arguments,
          pictures: [imageDataUrl],
          safeContentFilter: true,
        });
        const contentType = assertImageContentType(made.contentType);
        return { imageDataUrl: `data:${contentType};base64,${made.contentBase64}`, contentType, provider: "sogni" };
      } catch (err) {
        throw new Error(errorText(err));
      }
    });

    // "Make a variation" / "Edit with a prompt": Fal's Kontext model takes
    // the picture as a reference and a written instruction. Same non-agent
    // path as edit.sogni: no daily cap, bytes come straight from the browser.
    ctx.actions.register(ACTION_EDIT_FAL, async (params, context) => {
      if (context.actor.type !== "user") throw new Error("This is only for a person editing a picture in Media Studio.");
      if (!context.companyId) throw new Error("Open this page from inside a company.");
      const raw = (params ?? {}) as Record<string, unknown>;
      const imageDataUrl = typeof raw.imageDataUrl === "string" ? raw.imageDataUrl : "";
      if (!/^data:image\//i.test(imageDataUrl)) throw new Error("Open a picture in the editor first.");
      const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
      if (!prompt) throw new Error("Describe what to change first.");

      const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
      const ref = typeof cfg.falKeySecretRef === "string" ? cfg.falKeySecretRef.trim() : "";
      if (!ref) {
        throw new Error("Ask an admin to add a Fal.ai API key in Media Studio settings to use AI edits.");
      }
      let falKey: string;
      try {
        falKey = await ctx.secrets.resolve(ref);
      } catch (err) {
        throw new Error(`The Fal.ai API key picked in Media Studio's settings could not be read: ${errorText(err)}`);
      }
      const providerConfig: ProviderConfig = { provider: "fal", falKey, falModel: FAL_REFERENCE_MODEL };
      const impl = selectProvider(providerConfig, (url, init) => ctx.http.fetch(url, init));
      try {
        const result = await impl.generate({ prompt, referenceImages: [imageDataUrl] });
        const { contentBase64, contentType } = await toAttachmentBytes(ctx, result);
        return { imageDataUrl: `data:${contentType};base64,${contentBase64}`, contentType, provider: "fal" };
      } catch (err) {
        throw new Error(errorText(err));
      }
    });

    // "Select an object": DUR-4331's helper for the Edit tab's selection
    // tools. Wraps Sogni's segment_image, but always as a black-and-white
    // mask — never Sogni's own cutout option (applyMask is forced false
    // regardless of what the caller sends) — since the result only ever
    // feeds a selection, not a finished picture. Same non-agent path as
    // edit.sogni: no daily cap, bytes come straight from the browser.
    //
    // Input:  { imageDataUrl, text?, points?: [{x,y,label}], boxes?: [{x0,y0,x1,y1,label?}] }
    //         (at least one of text/points/boxes, per segment_image's own rule)
    // Output: { imageDataUrl, contentType, provider: "sogni" } — a black-and-white mask, same picture dimensions.
    ctx.actions.register(ACTION_EDIT_SEGMENT, async (params, context) => {
      if (context.actor.type !== "user") throw new Error("This is only for a person editing a picture in Media Studio.");
      if (!context.companyId) throw new Error("Open this page from inside a company.");
      const raw = (params ?? {}) as Record<string, unknown>;
      const imageDataUrl = typeof raw.imageDataUrl === "string" ? raw.imageDataUrl : "";
      if (!/^data:image\//i.test(imageDataUrl)) throw new Error("Open a picture in the editor first.");

      const def = findSogniTool("sogni-segment-image")!;
      const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
      const defaultModel = textOrNull(cfg.sogniModel) ?? SOGNI_DEFAULT_MODEL;
      const callParams: Record<string, unknown> = { ...raw, fileId: "editor", applyMask: false };
      delete callParams.imageDataUrl;
      // See edit.sogni's identical guard above: the host-injected companyId
      // (and renderEnvironment) are not Sogni arguments.
      delete callParams.companyId;
      delete callParams.renderEnvironment;
      const prepared = prepareSogniCall(def, callParams, { defaultModel });
      if ("error" in prepared) throw new Error(prepared.error);

      const ref = typeof cfg.sogniKeySecretRef === "string" ? cfg.sogniKeySecretRef.trim() : "";
      if (!ref) {
        throw new Error("Ask an admin to add a Sogni API key in Media Studio settings to use AI edits.");
      }
      let apiKey: string;
      try {
        apiKey = await ctx.secrets.resolve(ref);
      } catch (err) {
        throw new Error(`The Sogni API key picked in Media Studio's settings could not be read: ${errorText(err)}`);
      }
      const sogni = new SogniProvider({
        apiKey,
        apiFetch: (url, init) => ctx.http.fetch(url, init),
        transferFetch: guardedTransferFetch,
        defaultModel,
        tokenType: sogniTokenType(cfg),
      });
      try {
        const made = await sogni.runPictureTool({
          toolName: def.sogniTool,
          arguments: prepared.arguments,
          pictures: [imageDataUrl],
          safeContentFilter: true,
        });
        const contentType = assertImageContentType(made.contentType);
        return { imageDataUrl: `data:${contentType};base64,${made.contentBase64}`, contentType, provider: "sogni" };
      } catch (err) {
        throw new Error(errorText(err));
      }
    });

    // "Replace selected area" / "Remove selected object": Fal's Fill model
    // (FAL_FILL_MODEL) paints over the masked area. The model's own output
    // is never trusted outside the mask: compositeMaskedEdit restores the
    // original pixels there regardless of what the model actually returned
    // — this is DUR-4326's acceptance criterion, enforced in code rather
    // than assumed from model behavior. Same non-agent path as edit.fal: no
    // daily cap, bytes come straight from the browser.
    //
    // Input:  { imageDataUrl, maskDataUrl, mode: "replace" | "remove", prompt? }
    //         (prompt required for "replace"; ignored — overridden by a fixed
    //         server-side prompt — for "remove")
    // Output: { imageDataUrl, contentType: "image/png", provider: "fal" } — same dimensions as imageDataUrl.
    ctx.actions.register(ACTION_EDIT_INPAINT, async (params, context) => {
      if (context.actor.type !== "user") throw new Error("This is only for a person editing a picture in Media Studio.");
      if (!context.companyId) throw new Error("Open this page from inside a company.");
      const raw = (params ?? {}) as Record<string, unknown>;
      const imageDataUrl = typeof raw.imageDataUrl === "string" ? raw.imageDataUrl : "";
      if (!/^data:image\//i.test(imageDataUrl)) throw new Error("Open a picture in the editor first.");
      const maskDataUrl = typeof raw.maskDataUrl === "string" ? raw.maskDataUrl : "";
      if (!/^data:image\//i.test(maskDataUrl)) throw new Error("Select an area first.");
      const mode = raw.mode === "remove" || raw.mode === "replace" ? raw.mode : "";
      if (!mode) throw new Error('mode must be "replace" or "remove".');
      const prompt =
        mode === "remove"
          ? INPAINT_REMOVE_PROMPT
          : (() => {
              const given = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
              if (!given) throw new Error("Describe what to put in the selected area first.");
              return given;
            })();

      const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
      const ref = typeof cfg.falKeySecretRef === "string" ? cfg.falKeySecretRef.trim() : "";
      if (!ref) {
        throw new Error("Ask an admin to add a Fal.ai API key in Media Studio settings to use AI edits.");
      }
      let falKey: string;
      try {
        falKey = await ctx.secrets.resolve(ref);
      } catch (err) {
        throw new Error(`The Fal.ai API key picked in Media Studio's settings could not be read: ${errorText(err)}`);
      }
      try {
        const provider = new FalProvider(falKey, (url, init) => ctx.http.fetch(url, init));
        const result = await provider.fillImage({ image: imageDataUrl, mask: maskDataUrl, prompt });
        const { contentBase64: editedBase64 } = await toAttachmentBytes(ctx, result);
        const composited = await compositeMaskedEdit({
          original: bytesFromDataUrl(imageDataUrl, "The picture"),
          edited: Buffer.from(editedBase64, "base64"),
          mask: bytesFromDataUrl(maskDataUrl, "The mask"),
        });
        return { imageDataUrl: `data:image/png;base64,${composited.toString("base64")}`, contentType: "image/png", provider: "fal" };
      } catch (err) {
        throw new Error(errorText(err));
      }
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

    registerMediaJobTools(ctx);
    ctx.jobs.register(JOB_KEY_MEDIA_POLL, (job) => advanceMediaJobs(ctx, job.runId));

    ctx.logger.info(`media-studio plugin ready (main page: ${MAIN_PAGE_ROUTE})`);
  },

  async onHealth() {
    return { status: "ok", message: "Media Studio ready" };
  },
});

// ─── Video and music/audio (DUR-4062) ─────────────────────────────────────────
//
// Both are background jobs (media-jobs.ts): the tool starts the job and
// returns a job id right away, never a blocking wait. The finished file
// lands in the company's Files, and — with a task — a comment there, once
// the media-generation-poll job (jobs.schedule) notices it is done.

function readSeedParam(value: unknown): number | undefined | "invalid" {
  const seed = parseSeed(value);
  return seed === "invalid" ? "invalid" : (seed ?? undefined);
}

/**
 * DUR-4091 finding 1: generate-video/generate-audio take `issueId` straight
 * from the model's own tool-call parameters. The tool call itself still runs
 * on the calling agent's live, checked-out run, so — unlike the background
 * job that later delivers the result — this is the one point where the host
 * can still verify the agent actually owns that issue right now, the same
 * rule `createAttachment` already enforces for generate-image. Returns an
 * error string when the calling agent may not use this issueId, or null when
 * it is clear to proceed.
 */
async function assertOwnedIssueId(
  ctx: PluginContext,
  runCtx: { agentId: string; runId: string; companyId: string },
  issueId: string,
): Promise<string | null> {
  try {
    await ctx.issues.assertCheckoutOwner({
      issueId,
      companyId: runCtx.companyId,
      actorAgentId: runCtx.agentId,
      actorRunId: runCtx.runId,
    });
    return null;
  } catch {
    return "You can only post this to a task you're currently checked out on and working.";
  }
}

function registerMediaJobTools(ctx: PluginContext): void {
  ctx.tools.register(
    TOOL_GENERATE_VIDEO,
    { displayName: "Generate video", description: GENERATE_VIDEO_DESCRIPTION, parametersSchema: GENERATE_VIDEO_PARAMETERS as unknown as Record<string, unknown> },
    async (params, runCtx): Promise<ToolResult> => {
      const rawParams = (params ?? {}) as Record<string, unknown>;
      const prompt = typeof rawParams.prompt === "string" ? rawParams.prompt.trim() : "";
      if (!prompt) return { error: "prompt is required" };
      const issueId = typeof rawParams.issueId === "string" && rawParams.issueId.trim() ? rawParams.issueId.trim() : null;
      if (issueId) {
        const ownershipError = await assertOwnedIssueId(ctx, runCtx, issueId);
        if (ownershipError) return { error: ownershipError };
      }

      const rawProvider = typeof rawParams.provider === "string" ? rawParams.provider.trim().toLowerCase() : "";
      if (rawProvider && rawProvider !== "fal" && rawProvider !== "sogni") {
        return { error: `"${String(rawParams.provider)}" is not a video service. Use fal or sogni, or leave it out.` };
      }
      const seed = readSeedParam(rawParams.seed);
      if (seed === "invalid") return { error: `The seed must be a whole number from 0 to ${MAX_SEED}.` };
      const durationSeconds = readOptionalNumber(rawParams.durationSeconds);
      if (durationSeconds === "invalid") return { error: "durationSeconds must be a number." };
      const aspectRatio = typeof rawParams.aspectRatio === "string" && rawParams.aspectRatio.trim() ? rawParams.aspectRatio.trim() : undefined;
      const model = typeof rawParams.model === "string" && rawParams.model.trim() ? rawParams.model.trim() : undefined;

      let startImage: string | undefined;
      const startImageFileId = typeof rawParams.startImageFileId === "string" ? rawParams.startImageFileId.trim() : "";
      if (startImageFileId) {
        try {
          [startImage] = await loadReferenceImages(ctx, runCtx.companyId, [startImageFileId]);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }

      const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
      const settingsProvider = String(cfg.provider ?? "").toLowerCase();
      const provider = rawProvider || (settingsProvider === "fal" || settingsProvider === "sogni" ? settingsProvider : "fal");

      // Same daily-picture-limit reservation as generate-image, reserved before the provider is called (DUR-4000).
      const reservation = await ctx.personas.reserveDailyGeneration(runCtx.companyId, { runId: runCtx.runId });
      if (!reservation.allowed) return { error: `Daily image limit (${reservation.cap ?? 0}) reached for this agent today.` };

      try {
        const started = await startMediaJob(
          ctx,
          runCtx,
          "video",
          provider,
          { kind: "video", prompt, model, startImage, seed, durationSeconds: durationSeconds ?? undefined, aspectRatio },
          issueId,
        );
        return {
          content:
            `Started making the video with ${started.provider === "fal" ? "Fal.ai" : "Sogni"} (${started.model}). This takes a few minutes — ` +
            `${issueId ? "I will post it on this task" : "it will be saved to the company's Files"} once it's ready. Job id: ${started.jobId}.`,
          data: { jobId: started.jobId, status: "started", provider: started.provider, model: started.model, issueId },
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ctx.tools.register(
    TOOL_GENERATE_AUDIO,
    { displayName: "Generate audio", description: GENERATE_AUDIO_DESCRIPTION, parametersSchema: GENERATE_AUDIO_PARAMETERS as unknown as Record<string, unknown> },
    async (params, runCtx): Promise<ToolResult> => {
      const rawParams = (params ?? {}) as Record<string, unknown>;
      const prompt = typeof rawParams.prompt === "string" ? rawParams.prompt.trim() : "";
      if (!prompt) return { error: "prompt is required" };
      const issueId = typeof rawParams.issueId === "string" && rawParams.issueId.trim() ? rawParams.issueId.trim() : null;
      if (issueId) {
        const ownershipError = await assertOwnedIssueId(ctx, runCtx, issueId);
        if (ownershipError) return { error: ownershipError };
      }

      const rawMode = typeof rawParams.mode === "string" && rawParams.mode.trim() ? rawParams.mode.trim().toLowerCase() : "music";
      if (rawMode !== "music" && rawMode !== "speech") {
        return { error: `"${String(rawParams.mode)}" is not "music" or "speech".` };
      }
      const voice = typeof rawParams.voice === "string" && rawParams.voice.trim() ? rawParams.voice.trim() : undefined;
      const model = typeof rawParams.model === "string" && rawParams.model.trim() ? rawParams.model.trim() : undefined;
      const seed = readSeedParam(rawParams.seed);
      if (seed === "invalid") return { error: `The seed must be a whole number from 0 to ${MAX_SEED}.` };
      const durationSeconds = readOptionalNumber(rawParams.durationSeconds);
      if (durationSeconds === "invalid") return { error: "durationSeconds must be a number." };

      const reservation = await ctx.personas.reserveDailyGeneration(runCtx.companyId, { runId: runCtx.runId });
      if (!reservation.allowed) return { error: `Daily image limit (${reservation.cap ?? 0}) reached for this agent today.` };

      try {
        const started = await startMediaJob(
          ctx,
          runCtx,
          "audio",
          "fal",
          { kind: "audio", prompt, mode: rawMode, voice, model, seed, durationSeconds: durationSeconds ?? undefined },
          issueId,
        );
        return {
          content:
            `Started making the ${rawMode} with Fal.ai (${started.model}). This can take a while — ` +
            `${issueId ? "I will post it on this task" : "it will be saved to the company's Files"} once it's ready. Job id: ${started.jobId}.`,
          data: { jobId: started.jobId, status: "started", provider: started.provider, model: started.model, mode: rawMode, issueId },
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ctx.tools.register(
    TOOL_CHECK_MEDIA_JOB,
    { displayName: "Check video/audio job", description: CHECK_MEDIA_JOB_DESCRIPTION, parametersSchema: CHECK_MEDIA_JOB_PARAMETERS as unknown as Record<string, unknown> },
    async (params, runCtx): Promise<ToolResult> => {
      const jobId = typeof (params as Record<string, unknown> | null)?.jobId === "string" ? (params as Record<string, unknown>).jobId as string : "";
      if (!jobId.trim()) return { error: "jobId is required" };
      const record = await findOwnMediaJob(ctx, runCtx.companyId, runCtx.agentId, jobId.trim());
      if (!record) return { error: "No such job (or it was not started by you)." };
      const data = record.data as { kind: string; progress: string | null; error: string | null; resultFileId: string | null };
      if (record.status === "running") {
        return {
          content: `Still working on the ${data.kind}${data.progress ? ` (${data.progress})` : ""}.`,
          data: { status: "running", progress: data.progress ?? null },
        };
      }
      if (record.status === "failed") {
        return { content: `Could not make the ${data.kind}: ${data.error}`, data: { status: "failed", error: data.error } };
      }
      return {
        content: `The ${data.kind} is ready: file id ${data.resultFileId} in the company's Files.`,
        data: { status: "done", fileId: data.resultFileId },
      };
    },
  );
}

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

// ─── Preview prompt ─────────────────────────────────────────────────────────

/** Used when the preview is asked for without a sample request. */
export const PREVIEW_SAMPLE_REQUEST = "reading a book by the window";

export interface PromptPreview {
  request: string;
  prompt: string;
  /** Sogni's "things to avoid" text, when the model takes it (the look's own plus the sheet's "Always avoid"). */
  negativePrompt: string | null;
  service: string;
  /** The model the picture would be made with (for pictures from reference pictures: the editing model). */
  model: string | null;
  references: Array<{ position: number; role: ReferenceRole; label: string }>;
  /** Sheet fields left out because the sample request describes them itself. */
  leftOut: string[];
}

/**
 * The prompt a look would send, from the looks page's form (the same
 * assembly as a real picture; see look-prompt.ts). The service and model are
 * worked out as for a real picture; Sogni's catalog (public) is read to know
 * whether the model takes "things to avoid" text.
 */
export async function previewLookPrompt(ctx: PluginContext, params: Record<string, unknown>): Promise<PromptPreview> {
  const request = typeof params.request === "string" && params.request.trim() ? params.request.trim().slice(0, 2000) : PREVIEW_SAMPLE_REQUEST;
  const style = typeof params.style === "string" ? params.style.trim().slice(0, LOOK_STYLE_MAX) : "";
  const refs = readReferenceIds(params.referenceFileIds);
  if (refs === "invalid") throw new Error("The reference pictures could not be read. Pick them again.");
  const roles = readReferenceRoles(params.referenceRoles, refs.length);
  const sheet = readSheet(params.sheet);
  const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
  const settingsProvider = String(cfg.provider ?? "mock").toLowerCase();
  const rawProvider = typeof params.provider === "string" ? params.provider.trim().toLowerCase() : "";
  const rawModel = typeof params.model === "string" ? params.model.trim() : "";
  const catalog = sogniCatalogFor(ctx);
  const modelService = rawModel ? (serviceForModel(rawModel) ?? (catalog.knows(rawModel) ? "sogni" : null)) : null;
  const service = isPictureService(rawProvider)
    ? rawProvider
    : isPictureService(settingsProvider)
      ? (modelService ?? settingsProvider)
      : settingsProvider;

  let model: string | null = null;
  let negativeAllowed = false;
  if (service === "sogni") {
    const wanted = rawModel || textOrNull(cfg.sogniModel) || SOGNI_DEFAULT_MODEL;
    let info: SogniModelInfo | null = null;
    try {
      info = (await catalog.model(assertSogniModelId(wanted))).model;
    } catch {
      info = null;
    }
    if (refs.length > 0) {
      model = sogniReferenceModel(rawModel || undefined, info?.takesReferences === true);
    } else {
      model = info?.id ?? wanted;
      negativeAllowed = info?.negativePrompt != null;
    }
  } else if (service === "fal") {
    // As Fal is called: the look's model, else Kontext for reference pictures, else the settings' model.
    model = rawModel || (refs.length > 0 ? FAL_REFERENCE_MODEL : (textOrNull(cfg.falModel) ?? "fal-ai/flux/schnell"));
  }
  const assembled = assemblePrompt({ request, style, sheet, roles: refs.length > 0 ? roles : [], service, avoidAsNegative: negativeAllowed });
  const ownNegative = service === "sogni" && refs.length === 0 ? textOrNull(params.negativePrompt) : null;
  const negatives = [ownNegative, assembled.avoid].filter((text): text is string => Boolean(text));
  return {
    request,
    prompt: assembled.prompt,
    negativePrompt: negatives.length > 0 ? negatives.join(", ") : null,
    service,
    model,
    references: roles.map((role, i) => ({ position: i + 1, role, label: REFERENCE_ROLE_LABELS[role] })),
    leftOut: SHEET_FIELDS.filter((f) => assembled.leftOut.includes(f.key)).map((f) => f.label),
  };
}

// ─── Quick pictures ─────────────────────────────────────────────────────────

/**
 * A quick picture: the fastest model of the picture service, small, no
 * reference pictures, no LoRAs. A look is only used when it is named as look
 * (never a default or automatic look), so the content filter stays on unless
 * a look an owner/admin saved with it off is named. It counts toward the
 * daily picture limit (reserved before anything is spent) and gives up after
 * QUICK_PICTURE_TIMEOUT_MS. The time it took is in the result.
 */
export async function runQuickPicture(
  ctx: PluginContext,
  params: Record<string, unknown>,
  runCtx: { companyId: string; runId: string; agentId: string },
): Promise<ToolResult> {
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!prompt) return { error: "prompt is required" };
  const rawShape = typeof params.shape === "string" && params.shape.trim() ? params.shape.trim().toLowerCase() : "square";
  if (!isQuickShape(rawShape)) return { error: `"${String(params.shape)}" is not a shape. Use square, landscape or portrait, or leave it out.` };
  const shape: QuickShape = rawShape;
  const issueId = typeof params.issueId === "string" ? params.issueId.trim() : "";

  let look: Look | null = null;
  const lookName = typeof params.look === "string" ? params.look.trim() : "";
  if (lookName) {
    const looks = await loadLooks(ctx, runCtx.companyId);
    look = findLook(looks, lookName) ?? null;
    if (!look) return { error: `There is no saved look called "${lookName}". ${lookNamesSentence(looks)}` };
  }

  const cfg = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
  const settingsProvider = String(cfg.provider ?? "mock").toLowerCase();
  const catalog = sogniCatalogFor(ctx);
  const lookService = look
    ? (look.provider ?? serviceForModel(look.model) ?? (look.model && catalog.knows(look.model) ? "sogni" : null))
    : null;
  // Like Generate image: a named look's service is used only when settings pick a paid service (never away from mock/ComfyUI).
  const service = isPictureService(settingsProvider) && lookService ? lookService : settingsProvider;
  const size = quickPictureSize(shape, service);
  const input: GenerationInput = {
    // A named look's words only: its style words and character sheet (no pictures, so no roles).
    prompt: look ? assemblePrompt({ request: prompt, style: look.style, sheet: look.sheet, roles: [], service }).prompt : prompt,
    provider: service,
    model: quickModelFor(service),
    imageSize: size.imageSize,
    timeoutMs: QUICK_PICTURE_PROVIDER_TIMEOUT_MS,
    // Only a look named here, saved off by an owner/admin, turns the filter off.
    safeContentFilter: look ? !lookFilterOff(look) : true,
    ...(service === "fal" ? { steps: FAL_QUICK_STEPS } : {}),
  };

  const reservation = await ctx.personas.reserveDailyGeneration(runCtx.companyId, { runId: runCtx.runId });
  if (!reservation.allowed) {
    return { error: `Daily image limit (${reservation.cap ?? 0}) reached for this agent today.` };
  }

  const started = Date.now();
  let made: { result: GenerationResult; contentBase64: string; contentType: string };
  try {
    made = await withQuickTimeout(
      (async () => {
        const result = await runGeneration(ctx, input);
        return { result, ...(await toAttachmentBytes(ctx, result)) };
      })(),
      QUICK_PICTURE_TIMEOUT_MS,
    );
  } catch (err) {
    const durationMs = Date.now() - started;
    ctx.logger.warn(`media-studio: quick picture via ${service} failed after ${durationMs} ms`);
    // Past the service's own limit, the plain sentence is the same whichever side gave up first.
    if (durationMs >= QUICK_PICTURE_PROVIDER_TIMEOUT_MS) return { error: QUICK_PICTURE_TIMEOUT_SENTENCE };
    return { error: `The quick picture could not be made. ${errorText(err)}` };
  }
  const durationMs = Date.now() - started;
  const { result, contentBase64, contentType } = made;
  const seed = typeof result.seed === "number" ? result.seed : null;
  const extension = contentType.split("/")[1]?.replace(/\+.*$/, "") ?? "bin";
  const filename = `quick-picture${seed !== null ? `-seed-${seed}` : ""}.${extension}`;
  const record = { seed, prompt: input.prompt, look, provider: result.provider, model: result.model, referenceFileIds: [], quick: true, durationMs };
  ctx.logger.info(`media-studio: quick picture via ${result.provider} (${result.model ?? "default model"}, ${size.imageSize}) in ${durationMs} ms`);
  const lookSentence = look ? ` Used the saved look "${look.name}" (its style words and character sheet only).` : "";
  const about = `${SERVICE_NAME[result.provider as PictureService] ?? result.provider}, ${size.width}x${size.height}, ${showDuration(durationMs)}`;
  const data = {
    quick: true,
    provider: result.provider,
    model: result.model ?? null,
    width: size.width,
    height: size.height,
    durationMs,
    seed,
    look: look?.name ?? null,
  };

  try {
    if (issueId) {
      const attachment = await ctx.issues.createAttachment(
        issueId,
        { contentBase64, contentType, filename },
        runCtx.companyId,
        { authorAgentId: runCtx.agentId, runId: runCtx.runId },
      );
      await rememberImage(ctx, runCtx.companyId, attachment.id, record);
      return {
        content: `Made a quick picture (${about}) and attached it to the task (${attachment.contentPath}). File id: ${attachment.id}.${lookSentence}`,
        data: { ...data, fileId: attachment.id, attachmentId: attachment.id, contentPath: attachment.contentPath, contentType, issueId },
      };
    }
    const file = await ctx.files.createCompanyFile({ contentBase64, contentType, filename }, runCtx.companyId, { runId: runCtx.runId });
    await rememberImage(ctx, runCtx.companyId, file.id, record);
    return {
      content: `Made a quick picture (${about}) and saved it to the company's Files; it is shown to the person with your reply. File id: ${file.id}.${lookSentence}`,
      data: { ...data, fileId: file.id, contentPath: file.contentPath, contentType: file.contentType, issueId: null },
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
  record: {
    seed: number | null;
    prompt: string;
    look: Look | null;
    provider: string;
    model?: string;
    referenceFileIds: string[];
    quick?: boolean;
    durationMs?: number;
  },
): Promise<void> {
  try {
    await ctx.state.set(imageRecordScope(companyId, fileId), {
      ...(record.quick ? { quick: true } : {}),
      ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
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
