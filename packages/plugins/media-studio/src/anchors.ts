// Identities (people) and rooms: the page actions behind Media Studio's
// "Identities" and "Rooms" tabs, and the LoRA training flow on an identity.
//
// Storage: plugin state, scope "company", scope id = the company the host
// verified for the call (the same as looks), so one company never sees
// another's identities, rooms or settings:
//   identities          Identity[]                (identity.ts)
//   rooms               Room[]                    (rooms.ts)
//   identitySettings    {analysis, hfTokenSecretId, hfNamespace}
//   identityAgeBlocks   file ids the analysis flagged as maybe under 18
//
// Who may do what: anyone in the company can see identities and rooms and
// place products into a room (paid, like the Edit tab); only an owner or
// admin can create or change an identity, analyse or crop for one, make
// candidates, change rooms or settings, and train or publish a LoRA. Every
// paid call reserves spend through the host first (billing capability), the
// same gate as the Edit tab. Every key comes from a company secret, resolved
// here on the server; no key ever reaches the browser.

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { FAL_REFERENCE_MODEL, assertFalModelId, selectProvider, type FetchImpl } from "./providers.js";
import { assemblePrompt } from "./look-prompt.js";
import {
  HIGGSFIELD_MAX_SOUL_PICTURES,
  HIGGSFIELD_MIN_SOUL_PICTURES,
  HIGGSFIELD_MODELS,
  HiggsfieldClient,
  readHiggsfieldCredentials,
} from "./higgsfield.js";
import { compositeMaskedEdit } from "./mask-composite.js";
import {
  SOGNI_DEFAULT_MODEL,
  SOGNI_EDIT_MODELS,
  SOGNI_TOKEN_TYPES,
  SogniProvider,
  guardedTransferFetch,
  sogniWorkflowModel,
  type SogniTokenType,
} from "./sogni.js";
import {
  CANDIDATE_KINDS,
  CANDIDATE_REQUESTS,
  CONSENT_ADULT_TEXT,
  CONSENT_LIKENESS_TEXT,
  IDENTITY_DEFAULT_SOGNI_MODEL,
  IDENTITY_EXTRA_SLOT_SOGNI_MODEL,
  IDENTITY_NAME_MAX,
  TRAINING_SET_MAX,
  emptyTrainingSet,
  pickTrained,
  sheetWithIdentity,
  trainedReady,
  type TrainingBatch,
  type TrainingPicture,
  LORA_MAX_PICTURES,
  LORA_MIN_PICTURES,
  LORA_SOGNI_BASE_MODEL_ID,
  LORA_TRAINER_MODEL,
  LORA_TRAINING_STEPS,
  MAX_IDENTITIES,
  SEED_EXPLANATION,
  TRAINING_REQUESTS,
  assertTrainingMove,
  candidateReferences,
  identityPicturePrompt,
  loraTrainingCostCents,
  normalizeIdentity,
  readConsent,
  readCropBox,
  readCrops,
  readIdentitySheet,
  readLoraInput,
  readRepoName,
  readTriggerWord,
  isCropRole,
  type CandidateKind,
  type Identity,
  type IdentityTraining,
} from "./identity.js";
import { cropPicture, maskBoundingBox, sogniSizeLike } from "./image-ops.js";
import { ANALYSIS_SYSTEM_PROMPT, ANALYSIS_USER_PROMPT, parseAnalysis, type AnalysisModelSetting } from "./vision-analysis.js";
import { companyConfig } from "./company-settings.js";
import { MAX_ROOMS, ROOM_SOGNI_MODEL, normalizeRoom, placementPrompt, readRoomInput, type Room } from "./rooms.js";
import {
  downloadBytes,
  falTrainerPoll,
  falTrainerSubmit,
  falUpload,
  guardedBytesFetch,
  hfPublishPublic,
  hfWhoAmI,
  zipStore,
} from "./lora-training.js";

// ─── Action names (the page keeps a copy) ────────────────────────────────────

export const ACTION_IDENTITIES_LIST = "identities.list";
export const ACTION_IDENTITIES_SAVE = "identities.save";
export const ACTION_IDENTITIES_DELETE = "identities.delete";
export const ACTION_IDENTITIES_ANALYSE = "identities.analyse";
export const ACTION_IDENTITIES_CROP = "identities.crop";
export const ACTION_IDENTITIES_CANDIDATES = "identities.candidates";
export const ACTION_IDENTITIES_USE_CANDIDATE = "identities.useCandidate";
export const ACTION_IDENTITY_SETTINGS_GET = "identitySettings.get";
export const ACTION_IDENTITY_SETTINGS_SAVE = "identitySettings.save";
export const ACTION_ROOMS_LIST = "rooms.list";
export const ACTION_ROOMS_SAVE = "rooms.save";
export const ACTION_ROOMS_DELETE = "rooms.delete";
export const ACTION_ROOMS_PLACE = "rooms.place";
export const ACTION_IDENTITIES_GENERATION_OPTIONS = "identities.generationOptions";
export const ACTION_TRAINING_SET_GENERATE = "trainingSet.generate";
export const ACTION_TRAINING_SET_ADD = "trainingSet.add";
export const ACTION_TRAINING_SET_SELECT = "trainingSet.select";
export const ACTION_TRAINING_SET_REMOVE = "trainingSet.remove";
export const ACTION_TRAINING_SET_PRESETS = "trainingSet.presets";
export const ACTION_TRAINING_SET_DOWNLOAD = "trainingSet.download";
export const ACTION_HIGGSFIELD_SOUL = "higgsfield.soulId";
export const ACTION_TRAINED_STATUS = "trained.status";
export const ACTION_TRAINED_REMOVE = "trained.remove";
export const ACTION_LORA_TRAIN = "lora.train";
export const ACTION_LORA_STATUS = "lora.status";
export const ACTION_LORA_PUBLISH = "lora.publish";
export const ACTION_LORA_IMPORT_SOGNI = "lora.importSogni";
export const ACTION_LORA_ATTACH = "lora.attach";
export const ACTION_LORA_RESET = "lora.reset";

// ─── Context helpers ─────────────────────────────────────────────────────────

export interface ActionContext {
  companyId: string | null;
  actor: { type: string; userId?: string | null; canManageCompany?: boolean };
}

function companyOf(context: ActionContext): string {
  if (!context.companyId) throw new Error("Open this page from inside a company.");
  return context.companyId;
}

function managerOf(context: ActionContext, what: string): { companyId: string; userId: string } {
  const companyId = companyOf(context);
  if (context.actor.type !== "user" || context.actor.canManageCompany !== true || !context.actor.userId) {
    throw new Error(`Only the company's owner or an admin can ${what}.`);
  }
  return { companyId, userId: context.actor.userId };
}

function personOf(context: ActionContext): { companyId: string; userId: string } {
  const companyId = companyOf(context);
  if (context.actor.type !== "user" || !context.actor.userId) throw new Error("This is only for a person using Media Studio.");
  return { companyId, userId: context.actor.userId };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The instance's Media Studio settings with this company's own service keys on top (company-settings.ts). */
async function config(ctx: PluginContext, companyId: string): Promise<Record<string, unknown>> {
  return companyConfig(ctx, companyId);
}

function tokenType(cfg: Record<string, unknown>): SogniTokenType {
  return (SOGNI_TOKEN_TYPES as readonly string[]).includes(String(cfg.sogniTokenType)) ? (cfg.sogniTokenType as SogniTokenType) : "auto";
}

/** The worker's Sogni client with the company's key; test seams can replace the fetches. */
export interface AnchorSeams {
  bytesFetch?: FetchImpl;
  sogniTransferFetch?: FetchImpl;
  sogniPollIntervalMs?: number;
}

async function sogniClient(ctx: PluginContext, companyId: string, seams: AnchorSeams): Promise<SogniProvider> {
  const cfg = await config(ctx, companyId);
  const ref = typeof cfg.sogniKeySecretRef === "string" ? cfg.sogniKeySecretRef.trim() : "";
  if (!ref) throw new Error("Ask the company's owner or an admin to add a Sogni API key in Media Studio's Settings tab first.");
  let apiKey: string;
  try {
    apiKey = await ctx.secrets.resolve(ref);
  } catch (err) {
    throw new Error(`The Sogni API key picked in Media Studio's settings could not be read: ${errorText(err)}`);
  }
  return new SogniProvider({
    apiKey,
    apiFetch: (url, init) => ctx.http.fetch(url, init),
    transferFetch: seams.sogniTransferFetch ?? guardedTransferFetch,
    defaultModel: typeof cfg.sogniModel === "string" && cfg.sogniModel.trim() ? cfg.sogniModel.trim() : SOGNI_DEFAULT_MODEL,
    tokenType: tokenType(cfg),
    ...(seams.sogniPollIntervalMs !== undefined ? { pollIntervalMs: seams.sogniPollIntervalMs, sleep: async () => {} } : {}),
  });
}

async function falKey(ctx: PluginContext, companyId: string): Promise<string> {
  const cfg = await config(ctx, companyId);
  const ref = typeof cfg.falKeySecretRef === "string" ? cfg.falKeySecretRef.trim() : "";
  if (!ref) throw new Error("Ask the company's owner or an admin to add a Fal.ai API key in Media Studio's Settings tab first.");
  try {
    return await ctx.secrets.resolve(ref);
  } catch (err) {
    throw new Error(`The Fal.ai API key picked in Media Studio's settings could not be read: ${errorText(err)}`);
  }
}

/**
 * Reserve the cost of one paid call before making it; give it back if the
 * call fails. `keep` true keeps the reservation after success (training,
 * which is settled when it finishes).
 */
export async function withSpend<T>(
  ctx: PluginContext,
  action: string,
  companyId: string,
  userId: string,
  raw: Record<string, unknown>,
  run: (reservationId: string) => Promise<T>,
): Promise<T> {
  const override = raw.confirmBudgetCapCents;
  const reservation = await ctx.billing.reserveMediaStudioDirectSpend(companyId, {
    userId,
    action,
    ...(typeof override === "number" && Number.isInteger(override) && override >= 0 ? { confirmBudgetCapCents: override } : {}),
  });
  if (!reservation.allowed) throw new Error(reservation.message);
  try {
    return await run(reservation.reservationId);
  } catch (err) {
    try {
      await ctx.billing.releaseMediaStudioDirectSpend(companyId, reservation.reservationId);
    } catch (releaseErr) {
      ctx.logger.warn(`media-studio: could not give back reserved spend: ${errorText(releaseErr)}`);
    }
    throw err;
  }
}

/** A picture from this company's Files, with its bytes. */
async function readPicture(ctx: PluginContext, companyId: string, fileId: string, what = "The picture"): Promise<{ bytes: Buffer; contentType: string; dataUrl: string }> {
  const file = await ctx.files.get(fileId, companyId);
  if (!file) throw new Error(`${what} is not in this company's Files. Pick it again.`);
  if (!file.contentType.toLowerCase().startsWith("image/")) throw new Error(`"${file.originalFilename ?? "That file"}" is not a picture.`);
  const content = await ctx.files.readContent(fileId, companyId);
  const contentType = content.contentType.toLowerCase();
  return { bytes: Buffer.from(content.contentBase64, "base64"), contentType, dataUrl: `data:${contentType};base64,${content.contentBase64}` };
}

async function assertPictureFile(ctx: PluginContext, companyId: string, fileId: string, what: string): Promise<void> {
  const file = await ctx.files.get(fileId, companyId);
  if (!file) throw new Error(`${what} is not in this company's Files. Pick it again.`);
  if (!file.contentType.toLowerCase().startsWith("image/")) throw new Error(`"${file.originalFilename ?? "That file"}" is not a picture.`);
}

const DATA_IMAGE = /^data:(image\/[a-z0-9.+-]+);base64,/i;
function asDataUrl(p: { contentType: string; contentBase64: string }): string {
  return `data:${p.contentType};base64,${p.contentBase64}`;
}

// ─── State ───────────────────────────────────────────────────────────────────

const scope = (companyId: string, stateKey: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey });

export async function loadIdentities(ctx: PluginContext, companyId: string): Promise<Identity[]> {
  const raw = await ctx.state.get(scope(companyId, "identities"));
  return Array.isArray(raw) ? raw.map(normalizeIdentity).filter((i): i is Identity => i !== null) : [];
}

async function saveIdentities(ctx: PluginContext, companyId: string, list: Identity[]): Promise<void> {
  await ctx.state.set(scope(companyId, "identities"), list);
}

async function loadRooms(ctx: PluginContext, companyId: string): Promise<Room[]> {
  const raw = await ctx.state.get(scope(companyId, "rooms"));
  return Array.isArray(raw) ? raw.map(normalizeRoom).filter((r): r is Room => r !== null) : [];
}

export async function loadAgeBlocks(ctx: PluginContext, companyId: string): Promise<string[]> {
  const raw = await ctx.state.get(scope(companyId, "identityAgeBlocks"));
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

async function addAgeBlock(ctx: PluginContext, companyId: string, fileId: string): Promise<void> {
  const list = await loadAgeBlocks(ctx, companyId);
  if (!list.includes(fileId)) await ctx.state.set(scope(companyId, "identityAgeBlocks"), [...list, fileId].slice(-1000));
}

export interface IdentitySettings {
  analysis: AnalysisModelSetting | null;
  /** A company secret holding a Hugging Face token with write access. */
  hfTokenSecretId: string | null;
  /** The Hugging Face user or organisation to publish under (empty: the token's own account). */
  hfNamespace: string | null;
}

export async function loadIdentitySettings(ctx: PluginContext, companyId: string): Promise<IdentitySettings> {
  const raw = ((await ctx.state.get(scope(companyId, "identitySettings"))) ?? {}) as Record<string, unknown>;
  let analysis: AnalysisModelSetting | null = null;
  try {
    analysis = raw.analysis ? readAnalysisSetting(raw.analysis) : null;
  } catch {
    // An older setting with a typed-in model and address (no saved model) is
    // no longer used: the server only calls the company's saved models.
    analysis = null;
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { analysis, hfTokenSecretId: str(raw.hfTokenSecretId), hfNamespace: str(raw.hfNamespace) };
}

const SECRET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readSecretId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !SECRET_ID.test(value.trim())) throw new Error(`Pick the ${label} from the company's Secrets.`);
  return value.trim();
}

const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The analysis model: one of the company's saved models (Settings > Models),
 * by id, plus the company secret holding its key. Nothing else: no service,
 * model name or address can be typed in here, because the server reads
 * those from the saved model itself.
 */
export function readAnalysisSetting(value: unknown): AnalysisModelSetting | null {
  if (value === undefined || value === null) return null;
  const raw = value as Record<string, unknown>;
  const entryId = typeof raw.entryId === "string" ? raw.entryId.trim() : "";
  if (!entryId || !ENTRY_ID.test(entryId)) {
    throw new Error("Pick the analysis model from the company's saved models (Settings > Models). Add the model there first if it is not listed.");
  }
  return {
    entryId,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 120) : null,
    keySecretId: readSecretId(raw.keySecretId, "analysis model's key"),
  };
}

function findIdentity(list: Identity[], id: unknown): Identity {
  const found = typeof id === "string" ? list.find((i) => i.id === id) : undefined;
  if (!found) throw new Error("That identity no longer exists. Reload the page.");
  return found;
}

async function updateIdentity(ctx: PluginContext, companyId: string, id: string, change: (identity: Identity) => Identity): Promise<Identity> {
  const list = await loadIdentities(ctx, companyId);
  const current = findIdentity(list, id);
  const next = { ...change(current), updatedAt: new Date().toISOString() };
  await saveIdentities(ctx, companyId, list.map((i) => (i.id === id ? next : i)));
  return next;
}

/** What the page shows about an identity (everything stored; no keys are ever part of it). */
function identityView(identity: Identity) {
  return {
    ...identity,
    consentText: { likeness: CONSENT_LIKENESS_TEXT, adult: CONSENT_ADULT_TEXT },
    seedExplanation: SEED_EXPLANATION,
  };
}

// ─── Identities ──────────────────────────────────────────────────────────────

async function validateIdentityFiles(ctx: PluginContext, companyId: string, fileIds: string[], blocks: string[]): Promise<void> {
  for (const id of fileIds) {
    if (blocks.includes(id)) {
      throw new Error("One of these pictures was flagged by the analysis as possibly showing someone under 18, so it cannot be used for an identity.");
    }
    await assertPictureFile(ctx, companyId, id, "One of the identity's pictures");
  }
}

function readEditModel(value: unknown, fallback: string, label: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) return fallback;
  const key = sogniWorkflowModel(v, "edit_image");
  if (!(key in SOGNI_EDIT_MODELS)) throw new Error(`${label} must be one of Sogni's picture-editing models: ${Object.keys(SOGNI_EDIT_MODELS).join(", ")}.`);
  return key;
}

export async function saveIdentityAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId, userId } = managerOf(context, "create or change identities");
  const list = await loadIdentities(ctx, companyId);
  const id = typeof params.id === "string" && params.id ? params.id : null;
  const existing = id ? list.find((i) => i.id === id) ?? null : null;
  if (id && !existing) throw new Error("That identity no longer exists. Reload the page.");
  const now = new Date().toISOString();
  const consent = readConsent(params, existing, userId, now);
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!name) throw new Error("Give the identity a name.");
  if (name.length > IDENTITY_NAME_MAX) throw new Error(`Keep the name under ${IDENTITY_NAME_MAX} characters.`);
  const nickname = typeof params.nickname === "string" && params.nickname.trim() ? params.nickname.trim().slice(0, IDENTITY_NAME_MAX) : null;
  const taken = (n: string) => list.some((i) => i.id !== id && [i.name, i.nickname].some((x) => x && x.toLowerCase() === n.toLowerCase()));
  if (taken(name) || (nickname && taken(nickname))) throw new Error("Another identity already uses that name or nickname. Pick another.");
  const sheet = readIdentitySheet(params.sheet);
  const crops = readCrops(params.crops);
  if (crops.filter((c) => c.role === "face").length > 1) throw new Error("Keep one face crop.");
  const originalFileId = typeof params.originalFileId === "string" && params.originalFileId.trim() ? params.originalFileId.trim() : null;
  const canonicalFileId = typeof params.canonicalFileId === "string" && params.canonicalFileId.trim() ? params.canonicalFileId.trim() : existing?.canonicalFileId ?? null;
  const blocks = await loadAgeBlocks(ctx, companyId);
  const files = [originalFileId, canonicalFileId, ...crops.flatMap((c) => [c.fileId, c.sourceFileId])].filter((f): f is string => Boolean(f));
  await validateIdentityFiles(ctx, companyId, Array.from(new Set(files)), blocks);
  if (!originalFileId && !crops.some((c) => c.role === "face")) throw new Error("Add the person's picture (or a face crop) first.");
  const models = (params.preferredModels ?? {}) as Record<string, unknown>;
  const preferredModels = {
    sogni: readEditModel(models.sogni, existing?.preferredModels.sogni ?? IDENTITY_DEFAULT_SOGNI_MODEL, "The Sogni model"),
    sogniExtraSlot: readEditModel(models.sogniExtraSlot, existing?.preferredModels.sogniExtraSlot ?? IDENTITY_EXTRA_SLOT_SOGNI_MODEL, "The model for an extra picture"),
    fal: typeof models.fal === "string" && models.fal.trim() ? assertFalModelId(models.fal.trim()) : null,
  };
  const lora = readLoraInput(params.lora, existing?.lora ?? null);
  if (!existing && list.length >= MAX_IDENTITIES) throw new Error(`A company can keep up to ${MAX_IDENTITIES} identities. Delete one first.`);
  const identity: Identity = {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    nickname,
    originalFileId,
    sheet,
    crops,
    canonicalFileId,
    canonicalAsReference: params.canonicalAsReference === undefined ? existing?.canonicalAsReference ?? false : params.canonicalAsReference === true,
    preferredModels,
    lora,
    trainedIdentities: existing?.trainedIdentities ?? [],
    trainingSet: existing?.trainingSet ?? null,
    provenance: existing?.provenance ?? null,
    consent,
    training: existing?.training ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const next = existing ? list.map((i) => (i.id === identity.id ? identity : i)) : [...list, identity];
  await saveIdentities(ctx, companyId, next);
  return { identity: identityView(identity), identities: next.map(identityView) };
}

/** Delete an identity; looks that pointed at it keep working without it. */
async function deleteIdentityAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "delete identities");
  const list = await loadIdentities(ctx, companyId);
  const id = typeof params.id === "string" ? params.id : "";
  const target = list.find((i) => i.id === id);
  if (target?.training?.status === "training") throw new Error("A LoRA is being trained for this identity. Wait until it is done.");
  const next = list.filter((i) => i.id !== id);
  await saveIdentities(ctx, companyId, next);
  const looksScope = scope(companyId, "looks");
  const looks = await ctx.state.get(looksScope);
  if (Array.isArray(looks) && looks.some((l) => (l as { identityId?: unknown })?.identityId === id)) {
    await ctx.state.set(
      looksScope,
      looks.map((l) => ((l as { identityId?: unknown })?.identityId === id ? { ...(l as object), identityId: null, identitySameOutfit: false } : l)),
    );
  }
  return { identities: next.map(identityView) };
}

/** Send the uploaded picture to the company's analysis model. */
export async function analyseAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "analyse pictures for identities");
  const fileId = typeof params.fileId === "string" ? params.fileId.trim() : "";
  if (!fileId) throw new Error("Upload or pick the person's picture first.");
  if ((await loadAgeBlocks(ctx, companyId)).includes(fileId)) {
    return { ok: false, blocked: true, message: "This picture was already flagged as possibly showing someone under 18, so it cannot be used for an identity." };
  }
  const settings = await loadIdentitySettings(ctx, companyId);
  if (!settings.analysis) {
    throw new Error("Pick an analysis model (one that can see pictures) in the identity settings first. You can also fill in the description and crops yourself.");
  }
  await assertPictureFile(ctx, companyId, fileId, "The picture");
  // The server makes the call (it can reach the company's own model server);
  // the answer is still checked strictly here.
  const answer = await ctx.models.analyseImage(companyId, {
    entryId: settings.analysis.entryId,
    fileId,
    keySecretId: settings.analysis.keySecretId,
    systemPrompt: ANALYSIS_SYSTEM_PROMPT,
    userPrompt: ANALYSIS_USER_PROMPT,
    maxOutputTokens: 900,
  });
  const outcome = parseAnalysis(answer.text);
  if (!outcome.ok) {
    if (outcome.kind === "not-adult") {
      await addAgeBlock(ctx, companyId, fileId);
      return { ok: false, blocked: true, message: outcome.message };
    }
    return { ok: false, blocked: false, message: outcome.message };
  }
  return { ok: true, sheet: outcome.result.sheet, crops: outcome.result.crops, model: settings.analysis.label ?? answer.entryName };
}

/** Cut crops out of one picture (several boxes from the same picture). Returns the pictures; the page saves them to Files. */
async function cropAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "make crops for identities");
  const fileId = typeof params.fileId === "string" ? params.fileId.trim() : "";
  if (!fileId) throw new Error("Pick the picture to crop first.");
  if ((await loadAgeBlocks(ctx, companyId)).includes(fileId)) {
    throw new Error("This picture was flagged as possibly showing someone under 18, so it cannot be used for an identity.");
  }
  const boxes = Array.isArray(params.boxes) ? params.boxes : [];
  if (boxes.length === 0 || boxes.length > 8) throw new Error("Draw between 1 and 8 boxes.");
  const picture = await readPicture(ctx, companyId, fileId);
  const crops = [];
  for (const item of boxes) {
    const row = (item ?? {}) as Record<string, unknown>;
    if (!isCropRole(row.role)) throw new Error("Each box needs a role: face, body, outfit or other.");
    const box = readCropBox(row.box);
    const cut = await cropPicture(picture.bytes, box);
    crops.push({ role: row.role, box, imageDataUrl: `data:${cut.contentType};base64,${cut.bytes.toString("base64")}`, width: cut.width, height: cut.height });
  }
  return { crops };
}

// ─── Making pictures of an identity (candidates and training sets) ───────────

/** The models offered per service for pictures of a person; the identity-keeping ones first. */
export const IDENTITY_PICTURE_MODELS: Record<"sogni" | "fal" | "higgsfield", string[]> = {
  sogni: ["krea-identity-edit", "qwen", "qwen-lightning", "dark-beast-krea2-identity-edit", "gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"],
  fal: ["fal-ai/flux-2-pro/edit", "fal-ai/nano-banana-2/edit", FAL_REFERENCE_MODEL],
  higgsfield: [...HIGGSFIELD_MODELS],
};

/** How many reference pictures each Fal edit model takes (Fal's model pages, 8 Oct 2026). */
export const FAL_EDIT_MAX_REFERENCES: Record<string, number> = {
  "fal-ai/flux-2-pro/edit": 9,
  "fal-ai/nano-banana-2/edit": 14,
  [FAL_REFERENCE_MODEL]: 4,
};

/**
 * What one picture roughly costs on each service, for the page's estimate
 * (null: the service does not publish a price per picture). Fal: its model
 * pages (flux-2-pro edit about $0.03 per megapixel, nano-banana-2 edit $0.08,
 * FLUX Kontext pro $0.04). Every call also reserves Media Studio's flat edit
 * estimate against the company's limit.
 */
export const PICTURE_PRICE_CENTS: Record<string, number | null> = {
  "fal-ai/flux-2-pro/edit": 3,
  "fal-ai/nano-banana-2/edit": 8,
  [FAL_REFERENCE_MODEL]: 4,
};
export const PRICE_NOTES: Record<"sogni" | "fal" | "higgsfield", string> = {
  sogni: "Sogni charges in its own credits (shown on the Costs page when a credit price is set).",
  fal: "Fal.ai's published price per picture.",
  higgsfield: "Higgsfield's API documentation does not publish a price per picture; it is charged in Higgsfield credits.",
};
const SPEND_ACTION: Record<"sogni" | "fal" | "higgsfield", string> = { sogni: "identity-pictures", fal: "identity-pictures-fal", higgsfield: "higgsfield-pictures" };

export type PictureService3 = "sogni" | "fal" | "higgsfield";
function readService(value: unknown, fallback: PictureService3 = "sogni"): PictureService3 {
  return value === "fal" || value === "higgsfield" || value === "sogni" ? value : fallback;
}

function readPicks(value: unknown): Array<{ id: string; strength: number }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error("Pick at most 8 LoRAs.");
  return value.map((v) => {
    const row = (v ?? {}) as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const strength = typeof row.strength === "string" ? Number(row.strength) : row.strength;
    if (!id || id.length > 200 || typeof strength !== "number" || !Number.isFinite(strength)) throw new Error("The LoRAs could not be read. Pick them again.");
    return { id, strength };
  });
}

async function higgsfieldClient(ctx: PluginContext, companyId: string, seams: AnchorSeams): Promise<HiggsfieldClient> {
  const cfg = await config(ctx, companyId);
  const ref = typeof cfg.higgsfieldKeySecretRef === "string" ? cfg.higgsfieldKeySecretRef.trim() : "";
  if (!ref) throw new Error("Ask the company's owner or an admin to add a Higgsfield API key in Media Studio's Settings tab first.");
  let value: string;
  try {
    value = await ctx.secrets.resolve(ref);
  } catch (err) {
    throw new Error(`The Higgsfield API key picked in Media Studio's settings could not be read: ${errorText(err)}`);
  }
  return new HiggsfieldClient({
    credentials: readHiggsfieldCredentials(value),
    apiFetch: (url, init) => ctx.http.fetch(url, init),
    bytesFetch: seams.bytesFetch ?? guardedBytesFetch,
    ...(seams.sogniPollIntervalMs !== undefined ? { pollIntervalMs: 0, sleep: async () => {} } : {}),
  });
}

export interface MadePicture {
  imageDataUrl: string;
  service: PictureService3;
  model: string;
  loras: Array<{ id: string; strength: number }>;
  prompt: string;
  seed: number | null;
  workflowId: string | null;
}

/**
 * Pictures of one identity on the chosen service: Sogni or Fal edit the
 * identity's own pictures (face first, body second when there is room);
 * Higgsfield keeps the person only through a ready Soul ID (it takes no
 * reference pictures). Reserves spend first; gives it back on failure.
 */
export async function makeIdentityPictures(
  ctx: PluginContext,
  seams: AnchorSeams,
  companyId: string,
  userId: string,
  identity: Identity,
  options: { service: PictureService3; model: string | null; loras: Array<{ id: string; strength: number }>; request: string; count: number; imageSize?: string; raw: Record<string, unknown> },
): Promise<{ pictures: MadePicture[]; prompt: string }> {
  const service = options.service;
  const model = options.model?.trim() || (service === "sogni" ? identity.preferredModels.sogni || IDENTITY_DEFAULT_SOGNI_MODEL : service === "fal" ? identity.preferredModels.fal || IDENTITY_PICTURE_MODELS.fal[0]! : "soul");
  if (service === "sogni") {
    const key = sogniWorkflowModel(model, "edit_image");
    if (!(key in SOGNI_EDIT_MODELS)) throw new Error(`Pictures of a person on Sogni need one of its picture-editing models (${Object.keys(SOGNI_EDIT_MODELS).join(", ")}).`);
    if (options.loras.some((l) => l.id.startsWith("personal-"))) {
      throw new Error("Your own Sogni LoRAs only run with Sogni's content filter off, which only a look an owner or admin saved that way can do. Pick public LoRAs here.");
    }
    const refs = candidateReferences(identity, key);
    const pictures: string[] = [];
    for (const id of refs.fileIds) pictures.push((await readPicture(ctx, companyId, id, "The identity's picture")).dataUrl);
    const prompt = identityPicturePrompt(identity, options.request, refs.roles);
    const sogni = await sogniClient(ctx, companyId, seams);
    return withSpend(ctx, SPEND_ACTION.sogni, companyId, userId, options.raw, async () => {
      const made = await sogni.editPictures({
        prompt,
        model: key,
        pictures,
        variations: Math.min(2, Math.max(1, options.count)),
        ...(options.imageSize ? { imageSize: options.imageSize } : {}),
        ...(options.loras.length > 0 ? { loras: options.loras } : {}),
        safeContentFilter: true,
      });
      return {
        prompt,
        pictures: made.pictures.map((p) => ({ imageDataUrl: asDataUrl(p), service, model: made.model, loras: options.loras, prompt, seed: null, workflowId: made.workflowId })),
      };
    });
  }
  if (service === "fal") {
    const checked = assertFalModelId(model);
    const max = FAL_EDIT_MAX_REFERENCES[checked];
    if (!max) throw new Error(`Pick one of Fal.ai's picture-editing models for pictures of a person: ${IDENTITY_PICTURE_MODELS.fal.join(", ")}.`);
    if (options.loras.length > 0) throw new Error("These Fal.ai editing models take no LoRAs. Remove the LoRAs, or use Sogni.");
    const refs = candidateReferences(identity, "qwen");
    if (identity.canonicalFileId && refs.fileIds.length < max && !refs.fileIds.includes(identity.canonicalFileId)) {
      refs.fileIds.push(identity.canonicalFileId);
      refs.roles.push("face");
    }
    const pictures: string[] = [];
    for (const id of refs.fileIds.slice(0, max)) pictures.push((await readPicture(ctx, companyId, id, "The identity's picture")).dataUrl);
    const prompt = assemblePrompt({ request: options.request, sheet: sheetWithIdentity({}, identity), roles: refs.roles.slice(0, max), service: "fal" }).prompt;
    const key = await falKey(ctx, companyId);
    const count = Math.min(4, Math.max(1, options.count));
    return withSpend(ctx, SPEND_ACTION.fal, companyId, userId, options.raw, async () => {
      const res = await ctx.http.fetch(`https://fal.run/${checked}`, {
        method: "POST",
        headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, image_urls: pictures, num_images: count }),
      });
      if (!res.ok) throw new Error(`Fal.ai could not make the pictures (error ${res.status}).`);
      const body = (await res.json()) as { images?: Array<{ url?: string }>; seed?: number };
      const urls = (body.images ?? []).map((i) => i.url ?? "").filter((u) => /^https:\/\/|^data:image\//.test(u));
      if (urls.length === 0) throw new Error("Fal.ai sent no picture back. Try again.");
      const out: MadePicture[] = [];
      for (const url of urls) {
        const dataUrl = url.startsWith("data:") ? url : await fetchAsDataUrl(ctx, url);
        out.push({ imageDataUrl: dataUrl, service, model: checked, loras: [], prompt, seed: typeof body.seed === "number" ? body.seed : null, workflowId: null });
      }
      return { prompt, pictures: out };
    });
  }
  // Higgsfield: only through a ready Soul ID.
  const soul = pickTrained(identity, "higgsfield", null);
  if (!soul) {
    throw new Error(
      `Higgsfield cannot take ${identity.name}'s pictures; it keeps a person only through a Soul ID. Make one under "Train with: Higgsfield Soul ID" first, or pick Sogni or Fal.ai.`,
    );
  }
  if (options.loras.length > 0) throw new Error("Higgsfield takes no LoRAs. Remove them, or use Sogni.");
  const prompt = assemblePrompt({ request: options.request, sheet: sheetWithIdentity({}, identity), roles: [], service: "higgsfield" }).prompt;
  const client = await higgsfieldClient(ctx, companyId, seams);
  const seed = Math.floor(Math.random() * 1_000_000);
  return withSpend(ctx, SPEND_ACTION.higgsfield, companyId, userId, options.raw, async () => {
    // Soul makes 1 or 4 pictures per call; more than 1 asked for: 4, keeping as many as asked.
    const made = await client.soulPictures({ prompt, imageSize: options.imageSize, count: options.count >= 2 ? 4 : 1, seed, soulId: soul.ref });
    const out: MadePicture[] = [];
    for (const url of made.urls.slice(0, Math.max(1, options.count))) out.push({ imageDataUrl: await fetchAsDataUrl(ctx, url), service, model: "soul", loras: [], prompt, seed, workflowId: made.jobSetId });
    return { prompt, pictures: out };
  });
}

async function fetchAsDataUrl(ctx: PluginContext, url: string): Promise<string> {
  const res = await ctx.http.fetch(url);
  if (!res.ok) throw new Error(`The finished picture could not be fetched (error ${res.status}).`);
  const type = (res.headers?.get?.("content-type") ?? "image/png").split(";")[0]!.trim().toLowerCase();
  if (!type.startsWith("image/")) throw new Error("The service sent something that is not a picture.");
  return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
}

async function candidatesAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext, seams: AnchorSeams) {
  const { companyId, userId } = managerOf(context, "make candidate pictures");
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  const kind = (CANDIDATE_KINDS as readonly string[]).includes(String(params.kind)) ? (params.kind as CandidateKind) : null;
  if (!kind) throw new Error('Pick "portrait" or "full body".');
  const made = await makeIdentityPictures(ctx, seams, companyId, userId, identity, {
    service: readService(params.service),
    model: typeof params.model === "string" ? params.model : null,
    loras: readPicks(params.loras),
    request: CANDIDATE_REQUESTS[kind],
    count: 2,
    imageSize: kind === "portrait" ? "portrait_4_3" : "portrait_16_9",
    raw: params,
  });
  return {
    candidates: made.pictures.map((p) => ({ ...p, kind })),
    prompt: made.prompt,
    seedExplanation: SEED_EXPLANATION,
  };
}

async function useCandidateAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "pick the identity's picture");
  const fileId = typeof params.fileId === "string" ? params.fileId.trim() : "";
  if (!fileId) throw new Error("Save the picture first.");
  await assertPictureFile(ctx, companyId, fileId, "The chosen picture");
  const identity = await updateIdentity(ctx, companyId, String(params.identityId ?? ""), (current) => ({
    ...current,
    canonicalFileId: fileId,
    canonicalAsReference: params.addAsReference === true,
    provenance: {
      model: typeof params.model === "string" ? params.model.slice(0, 100) : null,
      seed: null,
      workflowId: typeof params.workflowId === "string" ? params.workflowId.slice(0, 100) : null,
      prompt: typeof params.prompt === "string" ? params.prompt.slice(0, 4000) : null,
      chosenAt: new Date().toISOString(),
    },
  }));
  return { identity: identityView(identity) };
}

// ─── Rooms ───────────────────────────────────────────────────────────────────

async function saveRoomAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "change rooms");
  const rooms = await loadRooms(ctx, companyId);
  const id = typeof params.id === "string" && params.id ? params.id : null;
  const existing = id ? rooms.find((r) => r.id === id) ?? null : null;
  if (id && !existing) throw new Error("That room no longer exists. Reload the page.");
  const fields = readRoomInput(params, existing, () => crypto.randomUUID());
  if (rooms.some((r) => r.id !== id && r.name.toLowerCase() === fields.name.toLowerCase())) throw new Error("There is already a room with that name.");
  const files = [fields.photoFileId, ...fields.zones.map((z) => z.maskFileId), ...fields.products.flatMap((p) => [p.fileId, p.cutoutFileId])].filter(
    (f): f is string => Boolean(f),
  );
  for (const f of new Set(files)) await assertPictureFile(ctx, companyId, f, "One of the room's pictures");
  if (!existing && rooms.length >= MAX_ROOMS) throw new Error(`A company can keep up to ${MAX_ROOMS} rooms. Delete one first.`);
  const room: Room = { id: existing?.id ?? crypto.randomUUID(), ...fields, updatedAt: new Date().toISOString() };
  const next = existing ? rooms.map((r) => (r.id === room.id ? room : r)) : [...rooms, room];
  await ctx.state.set(scope(companyId, "rooms"), next);
  return { room, rooms: next };
}

async function placeAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext, seams: AnchorSeams) {
  const { companyId, userId } = personOf(context);
  const rooms = await loadRooms(ctx, companyId);
  const room = rooms.find((r) => r.id === params.roomId);
  if (!room) throw new Error("That room no longer exists. Reload the page.");
  const zone = room.zones.find((z) => z.id === params.zoneId);
  if (!zone) throw new Error("Pick the area of the room to place the product in.");
  const service = params.service === "fal" ? "fal" : "sogni";
  const ids = Array.isArray(params.productIds) ? params.productIds.filter((x): x is string => typeof x === "string") : [];
  const products = ids.map((pid) => room.products.find((p) => p.id === pid)).filter((p): p is NonNullable<typeof p> => Boolean(p));
  if (products.length === 0) throw new Error("Pick at least one product.");
  const maxProducts = service === "sogni" ? (SOGNI_EDIT_MODELS[ROOM_SOGNI_MODEL] ?? 3) - 1 : 3;
  if (products.length > maxProducts) throw new Error(`${service === "sogni" ? "Sogni" : "Fal.ai"} can place at most ${maxProducts} products at once.`);
  const extra = typeof params.prompt === "string" && params.prompt.trim() ? params.prompt.trim().slice(0, 500) : null;
  const photo = await readPicture(ctx, companyId, room.photoFileId, "The room photo");
  const mask = await readPicture(ctx, companyId, zone.maskFileId, "The zone's area");
  if (!(await maskBoundingBox(mask.bytes))) throw new Error(`The area "${zone.name}" is empty. Draw or select it again.`);
  const productPictures: string[] = [];
  for (const p of products) productPictures.push((await readPicture(ctx, companyId, p.cutoutFileId ?? p.fileId, `The picture of "${p.name}"`)).dataUrl);
  const prompt = placementPrompt({ service, zoneName: zone.name, productNames: products.map((p) => p.name), cameraNote: room.cameraNote, extra });
  const size = await sogniSizeLike(photo.bytes);

  if (service === "sogni") {
    const sogni = await sogniClient(ctx, companyId, seams);
    return withSpend(ctx, "room-place", companyId, userId, params, async () => {
      const made = await sogni.editPictures({
        prompt,
        model: ROOM_SOGNI_MODEL,
        pictures: [photo.dataUrl, ...productPictures],
        variations: 1,
        ...(size ? { imageSize: size } : {}),
        safeContentFilter: true,
      });
      const edited = Buffer.from(made.pictures[0]!.contentBase64, "base64");
      const composited = await compositeMaskedEdit({ original: photo.bytes, edited, mask: mask.bytes });
      return { imageDataUrl: `data:image/png;base64,${composited.toString("base64")}`, prompt, provider: "sogni", model: made.model };
    });
  }
  const key = await falKey(ctx, companyId);
  return withSpend(ctx, "room-place-fal", companyId, userId, params, async () => {
    const impl = selectProvider({ provider: "fal", falKey: key, falModel: FAL_REFERENCE_MODEL }, (url, init) => ctx.http.fetch(url, init));
    const result = await impl.generate({ prompt, referenceImages: [photo.dataUrl, ...productPictures] });
    let edited: Buffer;
    if (result.imageDataUrl && DATA_IMAGE.test(result.imageDataUrl)) edited = Buffer.from(result.imageDataUrl.split(",", 2)[1]!, "base64");
    else if (result.imageUrl) edited = Buffer.from(await (await ctx.http.fetch(result.imageUrl)).arrayBuffer());
    else throw new Error("Fal.ai sent no picture back. Try again.");
    const composited = await compositeMaskedEdit({ original: photo.bytes, edited, mask: mask.bytes });
    return { imageDataUrl: `data:image/png;base64,${composited.toString("base64")}`, prompt, provider: "fal", model: result.model ?? FAL_REFERENCE_MODEL };
  });
}

// ─── Training set (provider-agnostic) ────────────────────────────────────────

async function trainingSetGenerateAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext, seams: AnchorSeams) {
  const { companyId, userId } = managerOf(context, "make training pictures");
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  const request = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!request || request.length > 500) throw new Error("Each variation needs a short description (under 500 characters).");
  const count = Number.isInteger(params.count) ? Math.min(4, Math.max(1, params.count as number)) : 2;
  const made = await makeIdentityPictures(ctx, seams, companyId, userId, identity, {
    service: readService(params.service),
    model: typeof params.model === "string" ? params.model : null,
    loras: readPicks(params.loras),
    request,
    count,
    raw: params,
  });
  return { pictures: made.pictures };
}

function readProvenance(value: unknown, fileId: string, batchId: string | null): TrainingPicture {
  const raw = (value ?? {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const generated = raw.source !== "upload" && text(raw.service, 20) !== null;
  return {
    fileId,
    source: generated ? "generated" : "upload",
    service: generated ? text(raw.service, 20) : null,
    model: generated ? text(raw.model, 200) : null,
    loras: generated && Array.isArray(raw.loras) ? readPicks(raw.loras) : [],
    prompt: generated ? text(raw.prompt, 4000) : null,
    seed: generated && typeof raw.seed === "number" && Number.isInteger(raw.seed) ? raw.seed : null,
    batchId,
    addedAt: new Date().toISOString(),
  };
}

async function trainingSetAddAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "add training pictures");
  const rows = Array.isArray(params.pictures) ? params.pictures : [];
  if (rows.length === 0 || rows.length > 40) throw new Error("Add between 1 and 40 pictures at a time.");
  const batchRaw = params.batch as Record<string, unknown> | undefined;
  const batch: TrainingBatch | null = batchRaw
    ? {
        id: crypto.randomUUID(),
        service: readService(batchRaw.service),
        model: typeof batchRaw.model === "string" ? batchRaw.model.slice(0, 200) : "",
        loras: readPicks(batchRaw.loras),
        prompts: Array.isArray(batchRaw.prompts) ? batchRaw.prompts.filter((p): p is string => typeof p === "string").map((p) => p.slice(0, 500)).slice(0, 60) : [],
        count: rows.length,
        createdAt: new Date().toISOString(),
      }
    : null;
  const added: TrainingPicture[] = [];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    const fileId = typeof r.fileId === "string" ? r.fileId.trim() : "";
    if (!fileId) throw new Error("A picture has no file. Save it again.");
    await assertPictureFile(ctx, companyId, fileId, "A training picture");
    added.push(readProvenance(r.provenance, fileId, batch?.id ?? null));
  }
  const blocks = await loadAgeBlocks(ctx, companyId);
  if (added.some((p) => blocks.includes(p.fileId))) throw new Error("One of these pictures was flagged as possibly showing someone under 18, so it cannot be used.");
  const identity = await updateIdentity(ctx, companyId, String(params.identityId ?? ""), (current) => {
    const set = current.trainingSet ?? emptyTrainingSet();
    const known = new Set(set.pictures.map((p) => p.fileId));
    const pictures = [...set.pictures, ...added.filter((p) => !known.has(p.fileId))];
    if (pictures.length > TRAINING_SET_MAX) throw new Error(`A training set holds at most ${TRAINING_SET_MAX} pictures. Remove some first.`);
    return { ...current, trainingSet: { ...set, pictures, batches: batch ? [...set.batches, batch] : set.batches } };
  });
  return { identity: identityView(identity) };
}

async function trainingSetSelectAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "pick training pictures");
  const ids = Array.isArray(params.fileIds) ? Array.from(new Set(params.fileIds.filter((x): x is string => typeof x === "string"))) : [];
  const identity = await updateIdentity(ctx, companyId, String(params.identityId ?? ""), (current) => {
    const set = current.trainingSet;
    if (!set || set.pictures.length === 0) throw new Error("Add pictures to the training set first.");
    if (ids.some((id) => !set.pictures.some((p) => p.fileId === id))) throw new Error("Only pictures in this training set can be ticked.");
    if (ids.length > LORA_MAX_PICTURES) throw new Error(`Tick at most ${LORA_MAX_PICTURES} pictures (12 to 25 is best).`);
    return { ...current, trainingSet: { ...set, selectedFileIds: ids } };
  });
  return { identity: identityView(identity) };
}

async function trainingSetRemoveAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "remove training pictures");
  const ids = Array.isArray(params.fileIds) ? params.fileIds.filter((x): x is string => typeof x === "string") : [];
  const identity = await updateIdentity(ctx, companyId, String(params.identityId ?? ""), (current) => {
    const set = current.trainingSet ?? emptyTrainingSet();
    return {
      ...current,
      trainingSet: { ...set, pictures: set.pictures.filter((p) => !ids.includes(p.fileId)), selectedFileIds: set.selectedFileIds.filter((id) => !ids.includes(id)) },
    };
  });
  return { identity: identityView(identity) };
}

async function trainingSetPresetsAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "change the variations");
  const presets = Array.isArray(params.presets) ? params.presets.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean) : [];
  if (presets.length === 0 || presets.length > 60 || presets.some((p) => p.length > 500)) throw new Error("Keep 1 to 60 variations, each under 500 characters.");
  const identity = await updateIdentity(ctx, companyId, String(params.identityId ?? ""), (current) => ({
    ...current,
    trainingSet: { ...(current.trainingSet ?? emptyTrainingSet()), presets },
  }));
  return { identity: identityView(identity) };
}

/** The ticked pictures as a zip, with one caption file per picture and a README, for training anywhere. */
export async function trainingSetDownloadAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "download the training set");
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  const set = identity.trainingSet;
  if (!set || set.selectedFileIds.length === 0) throw new Error("Tick the pictures to download first.");
  const trigger = typeof params.triggerWord === "string" && params.triggerWord.trim() ? readTriggerWord(params.triggerWord) : null;
  const files: Array<{ name: string; bytes: Buffer }> = [];
  const lines: string[] = [];
  for (const [i, id] of set.selectedFileIds.entries()) {
    const p = await readPicture(ctx, companyId, id, "A ticked picture");
    const ext = p.contentType.includes("jpeg") || p.contentType.includes("jpg") ? "jpg" : p.contentType.includes("webp") ? "webp" : "png";
    const base = String(i + 1).padStart(3, "0");
    const info = set.pictures.find((x) => x.fileId === id);
    const caption = [trigger, info?.prompt ? info.prompt.split("\n")[0] : null].filter(Boolean).join(", ") || identity.name;
    files.push({ name: `${base}.${ext}`, bytes: p.bytes }, { name: `${base}.txt`, bytes: Buffer.from(caption, "utf8") });
    lines.push(`- ${base}.${ext}: ${info?.source === "upload" ? "own photo" : `${info?.service ?? "?"} ${info?.model ?? ""}${info?.loras.length ? ` with LoRAs ${info.loras.map((l) => `${l.id}@${l.strength}`).join(", ")}` : ""}${info?.seed != null ? `, seed ${info.seed}` : ""}`}`);
  }
  const readme = [
    `# Training set: ${identity.name}`,
    "",
    `${set.selectedFileIds.length} pictures, each with a caption file of the same name${trigger ? ` starting with the trigger word "${trigger}"` : ""}.`,
    "Made with Paperclip Media Studio. Only use it for a person who is fictional/AI-made, or an adult who gave written consent.",
    "",
    "## Where each picture came from",
    ...lines,
    "",
  ].join("\n");
  files.push({ name: "README.md", bytes: Buffer.from(readme, "utf8") });
  const zip = zipStore(files);
  const filename = `${identity.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "person"}-training-set.zip`;
  return { filename, contentType: "application/zip", contentBase64: zip.toString("base64"), pictures: set.selectedFileIds.length };
}

// ─── Train with: Fal LoRA ────────────────────────────────────────────────────

function newTraining(): IdentityTraining {
  return {
    status: "training",
    trainedFileIds: [],
    triggerWord: "",
    steps: LORA_TRAINING_STEPS,
    estimatedCostCents: loraTrainingCostCents(),
    falModel: LORA_TRAINER_MODEL,
    falRequestId: null,
    reservationId: null,
    resultUrl: null,
    error: null,
    startedBy: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

export async function loraTrainAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext, seams: AnchorSeams) {
  const { companyId, userId } = managerOf(context, "train a LoRA");
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  assertTrainingMove(identity.training?.status ?? null, "training");
  const selected = identity.trainingSet?.selectedFileIds ?? [];
  if (selected.length < LORA_MIN_PICTURES) {
    throw new Error(`Tick at least ${LORA_MIN_PICTURES} pictures in the training set that truly look like ${identity.name} (12 to 25 is best).`);
  }
  const triggerWord = readTriggerWord(params.triggerWord);
  const cost = loraTrainingCostCents(LORA_TRAINING_STEPS);
  if (params.confirmCostCents !== cost) {
    throw new Error(`Training costs about $${(cost / 100).toFixed(2)} on Fal.ai. Confirm that price to start.`);
  }
  const key = await falKey(ctx, companyId);
  const files = [];
  for (const [i, id] of selected.entries()) {
    const p = await readPicture(ctx, companyId, id, "A ticked training picture");
    const ext = p.contentType.includes("jpeg") || p.contentType.includes("jpg") ? "jpg" : p.contentType.includes("webp") ? "webp" : "png";
    files.push({ name: `${String(i + 1).padStart(3, "0")}.${ext}`, bytes: p.bytes });
  }
  const zip = zipStore(files);
  const bytesFetch = seams.bytesFetch ?? guardedBytesFetch;
  const apiFetch: FetchImpl = (url, init) => ctx.http.fetch(url, init);
  // The reservation is kept while Fal trains; it is given back if the training fails.
  const reservation = await ctx.billing.reserveMediaStudioDirectSpend(companyId, {
    userId,
    action: "lora-training",
    ...(typeof params.confirmBudgetCapCents === "number" ? { confirmBudgetCapCents: params.confirmBudgetCapCents } : {}),
  });
  if (!reservation.allowed) throw new Error(reservation.message);
  let requestId: string;
  try {
    const zipUrl = await falUpload(apiFetch, bytesFetch, key, { bytes: zip, contentType: "application/zip", name: `${identity.id}.zip` });
    requestId = await falTrainerSubmit(apiFetch, key, { zipUrl, triggerWord, steps: LORA_TRAINING_STEPS });
  } catch (err) {
    await ctx.billing.releaseMediaStudioDirectSpend(companyId, reservation.reservationId).catch(() => undefined);
    throw err;
  }
  const now = new Date().toISOString();
  const next = await updateIdentity(ctx, companyId, identity.id, (current) => ({
    ...current,
    training: {
      ...newTraining(),
      trainedFileIds: [...selected],
      triggerWord,
      falRequestId: requestId,
      reservationId: reservation.reservationId,
      startedBy: userId,
      startedAt: now,
      updatedAt: now,
    },
  }));
  return { identity: identityView(next) };
}

export async function loraStatusAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const companyId = companyOf(context);
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  const training = identity.training;
  if (!training || training.status !== "training" || !training.falRequestId) return { identity: identityView(identity), progress: null };
  const key = await falKey(ctx, companyId);
  const poll = await falTrainerPoll((url, init) => ctx.http.fetch(url, init), key, training.falRequestId);
  if (poll.status === "running") return { identity: identityView(identity), progress: poll.progress };
  if (poll.status === "failed") {
    if (training.reservationId) await ctx.billing.releaseMediaStudioDirectSpend(companyId, training.reservationId).catch(() => undefined);
    const next = await updateIdentity(ctx, companyId, identity.id, (current) => {
      assertTrainingMove(current.training!.status, "failed");
      return { ...current, training: { ...current.training!, status: "failed", error: poll.error, reservationId: null, updatedAt: new Date().toISOString() } };
    });
    return { identity: identityView(next), progress: null };
  }
  if (training.reservationId) {
    try {
      await ctx.billing.settleMediaStudioDirectSpend(companyId, { reservationId: training.reservationId, endpointId: LORA_TRAINER_MODEL, usage: { units: training.steps } });
    } catch (err) {
      ctx.logger.warn(`media-studio: could not settle the LoRA training's cost: ${errorText(err)}`);
    }
  }
  const next = await updateIdentity(ctx, companyId, identity.id, (current) => {
    assertTrainingMove(current.training!.status, "trained");
    const now = new Date().toISOString();
    return {
      ...current,
      training: { ...current.training!, status: "trained", resultUrl: poll.loraUrl, updatedAt: now },
      // Usable right away by Fal LoRA models from Fal's own (private, time-limited) address.
      trainedIdentities: [
        ...current.trainedIdentities,
        { id: crypto.randomUUID(), provider: "fal-lora", ref: poll.loraUrl, url: poll.loraUrl, variant: null, triggerWord: current.training!.triggerWord, strength: 0.8, status: "ready", createdAt: now },
      ],
    };
  });
  return { identity: identityView(next), progress: null };
}

export async function loraPublishAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext, seams: AnchorSeams) {
  const { companyId } = managerOf(context, "publish a LoRA");
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  const training = identity.training;
  if (!training || !training.resultUrl) throw new Error("Train the LoRA first.");
  assertTrainingMove(training.status, "published");
  if (params.confirmPublic !== true) {
    throw new Error("Tick that you understand the LoRA will be PUBLIC: anyone can download it from Hugging Face. Sogni can only import public files.");
  }
  const repoName = readRepoName(params.repoName);
  const settings = await loadIdentitySettings(ctx, companyId);
  if (!settings.hfTokenSecretId) throw new Error("Pick a Hugging Face token (with write access) in the identity settings first.");
  let token: string;
  try {
    token = await ctx.secrets.resolve(settings.hfTokenSecretId);
  } catch (err) {
    throw new Error(`The Hugging Face token could not be read: ${errorText(err)}`);
  }
  const bytesFetch = seams.bytesFetch ?? guardedBytesFetch;
  const apiFetch: FetchImpl = (url, init) => ctx.http.fetch(url, init);
  const bytes = await downloadBytes(bytesFetch, training.resultUrl);
  const namespace = settings.hfNamespace ?? (await hfWhoAmI(apiFetch, token));
  const fileName = `${repoName}.safetensors`;
  const readme = [
    "---",
    "base_model: krea/krea-2",
    "tags: [lora, krea-2]",
    "---",
    `# ${repoName}`,
    "",
    `A Krea 2 LoRA. Trigger word: \`${training.triggerWord}\`.`,
    "",
    "Published from Paperclip Media Studio.",
  ].join("\n");
  const published = await hfPublishPublic(apiFetch, bytesFetch, token, { namespace, repoName, fileName, bytes, readme });
  const next = await updateIdentity(ctx, companyId, identity.id, (current) => ({
    ...current,
    lora: { source: "huggingface", url: published.url, visibility: "public", baseModel: "krea-2", triggerWord: current.training!.triggerWord, strength: current.lora?.strength ?? 0.8, repo: published.repo },
    // The public address replaces Fal's time-limited one for Fal LoRA models.
    trainedIdentities: current.trainedIdentities.map((t) => (t.provider === "fal-lora" && t.ref === current.training!.resultUrl ? { ...t, url: published.url } : t)),
    training: { ...current.training!, status: "published", updatedAt: new Date().toISOString() },
  }));
  return { identity: identityView(next) };
}

async function loraImportSogniAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext, seams: AnchorSeams) {
  const { companyId } = managerOf(context, "import a LoRA into Sogni");
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  const lora = identity.lora;
  if (!lora) throw new Error("Publish the LoRA first (Sogni imports from a public address).");
  if (lora.visibility !== "public" || (lora.source !== "huggingface" && lora.source !== "civitai")) {
    throw new Error("Sogni can only import a public Hugging Face or Civitai file.");
  }
  const sogni = await sogniClient(ctx, companyId, seams);
  const started = await sogni.importPersonalLora({ url: lora.url, name: `${identity.name} (person)`, modelId: LORA_SOGNI_BASE_MODEL_ID });
  const next = await updateIdentity(ctx, companyId, identity.id, (current) => ({
    ...current,
    trainedIdentities: [
      ...current.trainedIdentities.filter((t) => !(t.provider === "sogni-lora" && t.ref === started.id)),
      { id: crypto.randomUUID(), provider: "sogni-lora", ref: started.id, url: lora.url, variant: null, triggerWord: lora.triggerWord || null, strength: lora.strength, status: started.status, createdAt: new Date().toISOString() },
    ],
  }));
  return { identity: identityView(next) };
}

/** Check every Sogni import and Higgsfield Soul ID that is not finished yet. */
async function trainedStatusAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext, seams: AnchorSeams) {
  const companyId = companyOf(context);
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  const pending = identity.trainedIdentities.filter((t) => !trainedReady(t) && !["failed", "rejected", "revoked"].includes(t.status));
  if (pending.length === 0) return { identity: identityView(identity) };
  const updates = new Map<string, string>();
  for (const t of pending) {
    if (t.provider === "sogni-lora") updates.set(t.id, (await (await sogniClient(ctx, companyId, seams)).personalLora(t.ref)).status);
    else if (t.provider === "higgsfield-soul") updates.set(t.id, await (await higgsfieldClient(ctx, companyId, seams)).soulIdStatus(t.ref));
  }
  const next = await updateIdentity(ctx, companyId, identity.id, (current) => ({
    ...current,
    trainedIdentities: current.trainedIdentities.map((t) => (updates.has(t.id) ? { ...t, status: updates.get(t.id)! } : t)),
  }));
  return { identity: identityView(next) };
}

/** Attach a LoRA already in the Sogni account (its "personal-..." id), e.g. imported by hand. */
async function loraAttachAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "attach a LoRA");
  const id = typeof params.sogniLoraId === "string" ? params.sogniLoraId.trim() : "";
  if (!/^personal-[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error("Pick one of your own Sogni LoRAs (its id starts with personal-).");
  const strength = params.strength === undefined || params.strength === null || params.strength === "" ? 0.8 : Number(params.strength);
  if (!Number.isFinite(strength) || strength <= 0 || strength > 1) throw new Error("LoRA strength must be more than 0 and at most 1.");
  const triggerWord = typeof params.triggerWord === "string" && params.triggerWord.trim() ? readTriggerWord(params.triggerWord) : null;
  const next = await updateIdentity(ctx, companyId, String(params.identityId ?? ""), (current) => ({
    ...current,
    trainedIdentities: [
      ...current.trainedIdentities.filter((t) => !(t.provider === "sogni-lora" && t.ref === id)),
      { id: crypto.randomUUID(), provider: "sogni-lora", ref: id, url: current.lora?.url ?? null, variant: null, triggerWord: triggerWord ?? current.lora?.triggerWord ?? null, strength, status: "ready", createdAt: new Date().toISOString() },
    ],
  }));
  return { identity: identityView(next) };
}

async function trainedRemoveAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "remove a trained identity");
  const next = await updateIdentity(ctx, companyId, String(params.identityId ?? ""), (current) => ({
    ...current,
    trainedIdentities: current.trainedIdentities.filter((t) => t.id !== params.trainedId),
  }));
  return { identity: identityView(next) };
}

async function loraResetAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "start the LoRA training over");
  const next = await updateIdentity(ctx, companyId, String(params.identityId ?? ""), (current) => {
    if (current.training?.status === "training") throw new Error("A LoRA is being trained right now. Wait until it is done.");
    return { ...current, training: null };
  });
  return { identity: identityView(next) };
}

// ─── Train with: Higgsfield Soul ID ──────────────────────────────────────────

export async function higgsfieldSoulAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext, seams: AnchorSeams) {
  const { companyId, userId } = managerOf(context, "make a Higgsfield Soul ID");
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  const selected = identity.trainingSet?.selectedFileIds ?? [];
  if (selected.length < HIGGSFIELD_MIN_SOUL_PICTURES || selected.length > HIGGSFIELD_MAX_SOUL_PICTURES) {
    throw new Error(`A Higgsfield Soul ID needs ${HIGGSFIELD_MIN_SOUL_PICTURES} to ${HIGGSFIELD_MAX_SOUL_PICTURES} ticked face pictures (${selected.length} ticked).`);
  }
  const variant = params.variant === "soul-cinematic" ? "soul-cinematic" : "soul-2";
  const client = await higgsfieldClient(ctx, companyId, seams);
  const made = await withSpend(ctx, "higgsfield-soul-id", companyId, userId, params, async () => {
    const urls: string[] = [];
    for (const id of selected) {
      const p = await readPicture(ctx, companyId, id, "A ticked picture");
      urls.push(await client.upload(p.bytes, p.contentType === "image/jpg" ? "image/jpeg" : p.contentType));
    }
    return client.createSoulId(`${identity.name}`, urls);
  });
  const next = await updateIdentity(ctx, companyId, identity.id, (current) => ({
    ...current,
    trainedIdentities: [
      ...current.trainedIdentities,
      { id: crypto.randomUUID(), provider: "higgsfield-soul", ref: made.id, url: null, variant, triggerWord: null, strength: 1, status: made.status, createdAt: new Date().toISOString() },
    ],
  }));
  return { identity: identityView(next) };
}

/** Which services have a key, the models to offer, and the price notes, for "Generate with". */
async function generationOptionsAction(ctx: PluginContext, _params: Record<string, unknown>, context: ActionContext) {
  const companyId = companyOf(context);
  const cfg = await config(ctx, companyId);
  const has = (k: string) => typeof cfg[k] === "string" && (cfg[k] as string).trim() !== "";
  return {
    services: { sogni: has("sogniKeySecretRef"), fal: has("falKeySecretRef"), higgsfield: has("higgsfieldKeySecretRef") },
    models: IDENTITY_PICTURE_MODELS,
    priceCents: PICTURE_PRICE_CENTS,
    priceNotes: PRICE_NOTES,
    reservedPerCallCents: 8,
    perCall: { sogni: 2, fal: 4, higgsfield: 4 },
    higgsfieldNote:
      "Higgsfield keeps a person only through a Soul ID: it takes no reference pictures, so a look's outfit or style pictures and rooms cannot be combined with it. Those go through Sogni or Fal.ai.",
  };
}

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Test seams only: the byte and Sogni-storage fetches (the real ones talk to
 * the internet directly). Production code never sets these.
 */
export const anchorSeams: AnchorSeams = {};

export function registerAnchorActions(ctx: PluginContext, seams: AnchorSeams = anchorSeams): void {
  const reg = (key: string, fn: (params: Record<string, unknown>, context: ActionContext) => Promise<unknown>) =>
    ctx.actions.register(key, (params, context) => fn((params ?? {}) as Record<string, unknown>, context as unknown as ActionContext));

  reg(ACTION_IDENTITIES_LIST, async (_p, context) => {
    const companyId = companyOf(context);
    const settings = await loadIdentitySettings(ctx, companyId);
    return {
      identities: (await loadIdentities(ctx, companyId)).map(identityView),
      canManage: context.actor.type === "user" && context.actor.canManageCompany === true,
      analysisReady: settings.analysis !== null,
      hfReady: settings.hfTokenSecretId !== null,
      consentText: { likeness: CONSENT_LIKENESS_TEXT, adult: CONSENT_ADULT_TEXT },
      seedExplanation: SEED_EXPLANATION,
      training: {
        steps: LORA_TRAINING_STEPS,
        costCents: loraTrainingCostCents(),
        minPictures: LORA_MIN_PICTURES,
        maxPictures: LORA_MAX_PICTURES,
        soulMin: HIGGSFIELD_MIN_SOUL_PICTURES,
        soulMax: HIGGSFIELD_MAX_SOUL_PICTURES,
        presets: TRAINING_REQUESTS,
      },
      editModels: Object.keys(SOGNI_EDIT_MODELS),
    };
  });
  reg(ACTION_IDENTITIES_SAVE, (p, c) => saveIdentityAction(ctx, p, c));
  reg(ACTION_IDENTITIES_DELETE, (p, c) => deleteIdentityAction(ctx, p, c));
  reg(ACTION_IDENTITIES_ANALYSE, (p, c) => analyseAction(ctx, p, c));
  reg(ACTION_IDENTITIES_CROP, (p, c) => cropAction(ctx, p, c));
  reg(ACTION_IDENTITIES_CANDIDATES, (p, c) => candidatesAction(ctx, p, c, seams));
  reg(ACTION_IDENTITIES_USE_CANDIDATE, (p, c) => useCandidateAction(ctx, p, c));
  reg(ACTION_IDENTITIES_GENERATION_OPTIONS, (p, c) => generationOptionsAction(ctx, p, c));

  reg(ACTION_IDENTITY_SETTINGS_GET, async (_p, context) => {
    const companyId = companyOf(context);
    return { settings: await loadIdentitySettings(ctx, companyId), canManage: context.actor.type === "user" && context.actor.canManageCompany === true };
  });
  reg(ACTION_IDENTITY_SETTINGS_SAVE, async (p, context) => {
    const { companyId } = managerOf(context, "change the identity settings");
    const settings: IdentitySettings = {
      analysis: readAnalysisSetting(p.analysis ?? null),
      hfTokenSecretId: readSecretId(p.hfTokenSecretId, "Hugging Face token"),
      hfNamespace: typeof p.hfNamespace === "string" && p.hfNamespace.trim() ? p.hfNamespace.trim().slice(0, 96) : null,
    };
    if (settings.hfNamespace && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(settings.hfNamespace)) throw new Error("The Hugging Face account or organisation name can only have letters, digits, dots, dashes and underscores.");
    await ctx.state.set(scope(companyId, "identitySettings"), settings);
    return { settings };
  });

  reg(ACTION_ROOMS_LIST, async (_p, context) => {
    const companyId = companyOf(context);
    return { rooms: await loadRooms(ctx, companyId), canManage: context.actor.type === "user" && context.actor.canManageCompany === true };
  });
  reg(ACTION_ROOMS_SAVE, (p, c) => saveRoomAction(ctx, p, c));
  reg(ACTION_ROOMS_DELETE, async (p, context) => {
    const { companyId } = managerOf(context, "delete rooms");
    const next = (await loadRooms(ctx, companyId)).filter((r) => r.id !== p.id);
    await ctx.state.set(scope(companyId, "rooms"), next);
    return { rooms: next };
  });
  reg(ACTION_ROOMS_PLACE, (p, c) => placeAction(ctx, p, c, seams));

  reg(ACTION_TRAINING_SET_GENERATE, (p, c) => trainingSetGenerateAction(ctx, p, c, seams));
  reg(ACTION_TRAINING_SET_ADD, (p, c) => trainingSetAddAction(ctx, p, c));
  reg(ACTION_TRAINING_SET_SELECT, (p, c) => trainingSetSelectAction(ctx, p, c));
  reg(ACTION_TRAINING_SET_REMOVE, (p, c) => trainingSetRemoveAction(ctx, p, c));
  reg(ACTION_TRAINING_SET_PRESETS, (p, c) => trainingSetPresetsAction(ctx, p, c));
  reg(ACTION_TRAINING_SET_DOWNLOAD, (p, c) => trainingSetDownloadAction(ctx, p, c));
  reg(ACTION_LORA_TRAIN, (p, c) => loraTrainAction(ctx, p, c, seams));
  reg(ACTION_LORA_STATUS, (p, c) => loraStatusAction(ctx, p, c));
  reg(ACTION_LORA_PUBLISH, (p, c) => loraPublishAction(ctx, p, c, seams));
  reg(ACTION_LORA_IMPORT_SOGNI, (p, c) => loraImportSogniAction(ctx, p, c, seams));
  reg(ACTION_LORA_ATTACH, (p, c) => loraAttachAction(ctx, p, c));
  reg(ACTION_LORA_RESET, (p, c) => loraResetAction(ctx, p, c));
  reg(ACTION_HIGGSFIELD_SOUL, (p, c) => higgsfieldSoulAction(ctx, p, c, seams));
  reg(ACTION_TRAINED_STATUS, (p, c) => trainedStatusAction(ctx, p, c, seams));
  reg(ACTION_TRAINED_REMOVE, (p, c) => trainedRemoveAction(ctx, p, c));
}
