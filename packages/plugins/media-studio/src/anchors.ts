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
  LORA_DATASET_MAX,
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
import { cropPicture, maskBoundingBox, shrinkForAnalysis, sogniSizeLike } from "./image-ops.js";
import {
  ANALYSIS_DEFAULT_BASE_URL,
  callVisionModel,
  isAnalysisProvider,
  parseAnalysis,
  type AnalysisModelSetting,
} from "./vision-analysis.js";
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
export const ACTION_LORA_PICTURES = "lora.pictures";
export const ACTION_LORA_ADD_PICTURES = "lora.addPictures";
export const ACTION_LORA_SELECT = "lora.select";
export const ACTION_LORA_TRAIN = "lora.train";
export const ACTION_LORA_STATUS = "lora.status";
export const ACTION_LORA_PUBLISH = "lora.publish";
export const ACTION_LORA_IMPORT_SOGNI = "lora.importSogni";
export const ACTION_LORA_SOGNI_STATUS = "lora.sogniStatus";
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

async function config(ctx: PluginContext): Promise<Record<string, unknown>> {
  return ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
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

async function sogniClient(ctx: PluginContext, seams: AnchorSeams): Promise<SogniProvider> {
  const cfg = await config(ctx);
  const ref = typeof cfg.sogniKeySecretRef === "string" ? cfg.sogniKeySecretRef.trim() : "";
  if (!ref) throw new Error("Ask an admin to add a Sogni API key in Media Studio settings first.");
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

async function falKey(ctx: PluginContext): Promise<string> {
  const cfg = await config(ctx);
  const ref = typeof cfg.falKeySecretRef === "string" ? cfg.falKeySecretRef.trim() : "";
  if (!ref) throw new Error("Ask an admin to add a Fal.ai API key in Media Studio settings first.");
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

export function readAnalysisSetting(value: unknown): AnalysisModelSetting | null {
  if (value === undefined || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!isAnalysisProvider(raw.provider)) throw new Error("Pick which service the analysis model runs on.");
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!model || model.length > 200) throw new Error("Type the analysis model's name.");
  const baseUrl = typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : null;
  if (baseUrl && !/^https?:\/\/[^\s]{3,300}$/i.test(baseUrl)) throw new Error("The analysis model's address must start with http:// or https://.");
  if (!baseUrl && !ANALYSIS_DEFAULT_BASE_URL[raw.provider]) throw new Error("This kind of model needs its address (for example http://my-server:11434/v1).");
  return {
    source: raw.source === "directory" ? "directory" : "custom",
    entryId: typeof raw.entryId === "string" && raw.entryId ? raw.entryId : null,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 120) : null,
    provider: raw.provider,
    model,
    baseUrl,
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
  const picture = await readPicture(ctx, companyId, fileId);
  let apiKey: string | null = null;
  if (settings.analysis.keySecretId) {
    try {
      apiKey = await ctx.secrets.resolve(settings.analysis.keySecretId);
    } catch (err) {
      throw new Error(`The analysis model's key could not be read: ${errorText(err)}`);
    }
  }
  const small = await shrinkForAnalysis(picture.bytes);
  const answer = await callVisionModel((url, init) => ctx.http.fetch(url, init), settings.analysis, apiKey, small);
  const outcome = parseAnalysis(answer);
  if (!outcome.ok) {
    if (outcome.kind === "not-adult") {
      await addAgeBlock(ctx, companyId, fileId);
      return { ok: false, blocked: true, message: outcome.message };
    }
    return { ok: false, blocked: false, message: outcome.message };
  }
  return { ok: true, sheet: outcome.result.sheet, crops: outcome.result.crops, model: settings.analysis.label ?? settings.analysis.model };
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

async function candidatesAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext, seams: AnchorSeams) {
  const { companyId, userId } = managerOf(context, "make candidate pictures");
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  const kind = (CANDIDATE_KINDS as readonly string[]).includes(String(params.kind)) ? (params.kind as CandidateKind) : null;
  if (!kind) throw new Error('Pick "portrait" or "full body".');
  const model = identity.preferredModels.sogni || IDENTITY_DEFAULT_SOGNI_MODEL;
  const refs = candidateReferences(identity, model);
  const pictures: string[] = [];
  for (const id of refs.fileIds) pictures.push((await readPicture(ctx, companyId, id, "The identity's crop")).dataUrl);
  const prompt = identityPicturePrompt(identity, CANDIDATE_REQUESTS[kind], refs.roles);
  const sogni = await sogniClient(ctx, seams);
  return withSpend(ctx, "identity-pictures", companyId, userId, params, async () => {
    const made = await sogni.editPictures({
      prompt,
      model,
      pictures,
      variations: 2,
      imageSize: kind === "portrait" ? "portrait_4_3" : "portrait_16_9",
      safeContentFilter: true,
    });
    return {
      candidates: made.pictures.map((p) => ({ imageDataUrl: asDataUrl(p), kind, model: made.model, workflowId: made.workflowId })),
      prompt,
      credits: made.credits,
      seedExplanation: SEED_EXPLANATION,
    };
  });
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
    const sogni = await sogniClient(ctx, seams);
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
  const key = await falKey(ctx);
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

// ─── LoRA training ───────────────────────────────────────────────────────────

function emptyTraining(): IdentityTraining {
  return {
    status: "collecting",
    datasetFileIds: [],
    selectedFileIds: [],
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

async function loraPicturesAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext, seams: AnchorSeams) {
  const { companyId, userId } = managerOf(context, "make training pictures");
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  if (identity.training?.status === "training") throw new Error("A LoRA is being trained right now. Wait until it is done.");
  const index = Number.isInteger(params.index) ? Math.abs(params.index as number) % TRAINING_REQUESTS.length : 0;
  const model = identity.preferredModels.sogni || IDENTITY_DEFAULT_SOGNI_MODEL;
  const refs = candidateReferences(identity, model);
  // The chosen canonical picture is the best face there is: use it as the face when there is one.
  if (identity.canonicalFileId) refs.fileIds[0] = identity.canonicalFileId;
  const pictures: string[] = [];
  for (const id of refs.fileIds) pictures.push((await readPicture(ctx, companyId, id, "The identity's picture")).dataUrl);
  const prompt = identityPicturePrompt(identity, TRAINING_REQUESTS[index]!, refs.roles);
  const sogni = await sogniClient(ctx, seams);
  return withSpend(ctx, "identity-pictures", companyId, userId, params, async () => {
    const made = await sogni.editPictures({ prompt, model, pictures, variations: 2, safeContentFilter: true });
    return { pictures: made.pictures.map((p) => ({ imageDataUrl: asDataUrl(p) })), index, prompt, of: TRAINING_REQUESTS.length };
  });
}

async function loraAddPicturesAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "add training pictures");
  const ids = Array.isArray(params.fileIds) ? params.fileIds.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  if (ids.length === 0) throw new Error("No pictures to add.");
  for (const id of ids) await assertPictureFile(ctx, companyId, id, "A training picture");
  const identity = await updateIdentity(ctx, companyId, String(params.identityId ?? ""), (current) => {
    const training = current.training ?? emptyTraining();
    if (current.training && current.training.status !== "collecting" && current.training.status !== "failed") {
      throw new Error("This identity's LoRA is already trained. Start over to make a new one.");
    }
    const dataset = Array.from(new Set([...training.datasetFileIds, ...ids]));
    if (dataset.length > LORA_DATASET_MAX) throw new Error(`Keep at most ${LORA_DATASET_MAX} training pictures.`);
    return { ...current, training: { ...training, status: "collecting", datasetFileIds: dataset, updatedAt: new Date().toISOString() } };
  });
  return { identity: identityView(identity) };
}

async function loraSelectAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "pick training pictures");
  const ids = Array.isArray(params.fileIds) ? Array.from(new Set(params.fileIds.filter((x): x is string => typeof x === "string"))) : [];
  const identity = await updateIdentity(ctx, companyId, String(params.identityId ?? ""), (current) => {
    const training = current.training;
    if (!training || (training.status !== "collecting" && training.status !== "failed")) throw new Error("Make training pictures first.");
    if (ids.some((id) => !training.datasetFileIds.includes(id))) throw new Error("Only pictures made for this training can be ticked.");
    if (ids.length > LORA_MAX_PICTURES) throw new Error(`Tick at most ${LORA_MAX_PICTURES} pictures (12 to 20 is best).`);
    return { ...current, training: { ...training, selectedFileIds: ids, updatedAt: new Date().toISOString() } };
  });
  return { identity: identityView(identity) };
}

export async function loraTrainAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext, seams: AnchorSeams) {
  const { companyId, userId } = managerOf(context, "train a LoRA");
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  const training = identity.training;
  if (!training) throw new Error("Make and tick training pictures first.");
  assertTrainingMove(training.status, "training");
  if (training.selectedFileIds.length < LORA_MIN_PICTURES) {
    throw new Error(`Tick at least ${LORA_MIN_PICTURES} pictures that truly look like ${identity.name} (12 to 20 is best).`);
  }
  const triggerWord = readTriggerWord(params.triggerWord);
  const cost = loraTrainingCostCents(LORA_TRAINING_STEPS);
  if (params.confirmCostCents !== cost) {
    throw new Error(`Training costs about $${(cost / 100).toFixed(2)} on Fal.ai. Confirm that price to start.`);
  }
  const key = await falKey(ctx);
  const files = [];
  for (const [i, id] of training.selectedFileIds.entries()) {
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
      ...(current.training ?? emptyTraining()),
      status: "training",
      triggerWord,
      steps: LORA_TRAINING_STEPS,
      estimatedCostCents: cost,
      falModel: LORA_TRAINER_MODEL,
      falRequestId: requestId,
      reservationId: reservation.reservationId,
      resultUrl: null,
      error: null,
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
  const key = await falKey(ctx);
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
    return { ...current, training: { ...current.training!, status: "trained", resultUrl: poll.loraUrl, updatedAt: new Date().toISOString() } };
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
    lora: {
      source: "huggingface",
      url: published.url,
      visibility: "public",
      baseModel: "krea-2",
      triggerWord: current.training!.triggerWord,
      strength: current.lora?.strength ?? 0.8,
      sogniLoraId: null,
      sogniStatus: null,
      repo: published.repo,
    },
    training: { ...current.training!, status: "published", updatedAt: new Date().toISOString() },
  }));
  return { identity: identityView(next) };
}

async function loraImportSogniAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext, seams: AnchorSeams) {
  const { companyId } = managerOf(context, "import a LoRA into Sogni");
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  const lora = identity.lora;
  if (!lora) throw new Error("This identity has no LoRA yet.");
  if (lora.visibility !== "public" || (lora.source !== "huggingface" && lora.source !== "civitai")) {
    throw new Error("Sogni can only import a public Hugging Face or Civitai file.");
  }
  const sogni = await sogniClient(ctx, seams);
  const started = await sogni.importPersonalLora({ url: lora.url, name: `${identity.name} (person)`, modelId: LORA_SOGNI_BASE_MODEL_ID });
  const next = await updateIdentity(ctx, companyId, identity.id, (current) => ({
    ...current,
    lora: { ...current.lora!, sogniLoraId: started.id, sogniStatus: started.status },
  }));
  return { identity: identityView(next) };
}

async function loraSogniStatusAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext, seams: AnchorSeams) {
  const companyId = companyOf(context);
  const identity = findIdentity(await loadIdentities(ctx, companyId), params.identityId);
  if (!identity.lora?.sogniLoraId) return { identity: identityView(identity), reason: null };
  const sogni = await sogniClient(ctx, seams);
  const state = await sogni.personalLora(identity.lora.sogniLoraId);
  const next = await updateIdentity(ctx, companyId, identity.id, (current) => ({ ...current, lora: { ...current.lora!, sogniStatus: state.status } }));
  return { identity: identityView(next), reason: state.reason };
}

/** Attach a LoRA already imported into Sogni by hand (its "personal-..." id). */
async function loraAttachAction(ctx: PluginContext, params: Record<string, unknown>, context: ActionContext) {
  const { companyId } = managerOf(context, "attach a LoRA");
  const id = typeof params.sogniLoraId === "string" ? params.sogniLoraId.trim() : "";
  if (!/^personal-[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error("Pick one of your own Sogni LoRAs (its id starts with personal-).");
  const strength = params.strength === undefined ? null : Number(params.strength);
  if (strength !== null && (!Number.isFinite(strength) || strength <= 0 || strength > 1)) throw new Error("LoRA strength must be more than 0 and at most 1.");
  const next = await updateIdentity(ctx, companyId, String(params.identityId ?? ""), (current) => {
    if (!current.lora) throw new Error("Publish the LoRA (or add its address) first.");
    return { ...current, lora: { ...current.lora, sogniLoraId: id, sogniStatus: "ready", strength: strength ?? current.lora.strength } };
  });
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
      training: { steps: LORA_TRAINING_STEPS, costCents: loraTrainingCostCents(), minPictures: LORA_MIN_PICTURES, maxPictures: LORA_MAX_PICTURES, prompts: TRAINING_REQUESTS.length },
      editModels: Object.keys(SOGNI_EDIT_MODELS),
    };
  });
  reg(ACTION_IDENTITIES_SAVE, (p, c) => saveIdentityAction(ctx, p, c));
  reg(ACTION_IDENTITIES_DELETE, (p, c) => deleteIdentityAction(ctx, p, c));
  reg(ACTION_IDENTITIES_ANALYSE, (p, c) => analyseAction(ctx, p, c));
  reg(ACTION_IDENTITIES_CROP, (p, c) => cropAction(ctx, p, c));
  reg(ACTION_IDENTITIES_CANDIDATES, (p, c) => candidatesAction(ctx, p, c, seams));
  reg(ACTION_IDENTITIES_USE_CANDIDATE, (p, c) => useCandidateAction(ctx, p, c));

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

  reg(ACTION_LORA_PICTURES, (p, c) => loraPicturesAction(ctx, p, c, seams));
  reg(ACTION_LORA_ADD_PICTURES, (p, c) => loraAddPicturesAction(ctx, p, c));
  reg(ACTION_LORA_SELECT, (p, c) => loraSelectAction(ctx, p, c));
  reg(ACTION_LORA_TRAIN, (p, c) => loraTrainAction(ctx, p, c, seams));
  reg(ACTION_LORA_STATUS, (p, c) => loraStatusAction(ctx, p, c));
  reg(ACTION_LORA_PUBLISH, (p, c) => loraPublishAction(ctx, p, c, seams));
  reg(ACTION_LORA_IMPORT_SOGNI, (p, c) => loraImportSogniAction(ctx, p, c, seams));
  reg(ACTION_LORA_SOGNI_STATUS, (p, c) => loraSogniStatusAction(ctx, p, c, seams));
  reg(ACTION_LORA_ATTACH, (p, c) => loraAttachAction(ctx, p, c));
  reg(ACTION_LORA_RESET, (p, c) => loraResetAction(ctx, p, c));
}
