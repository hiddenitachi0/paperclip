import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mediaLoras, mediaModelSetups, mediaModelSetupTrials, mediaProjectDefaults, personas, videoStorylines, withCompanyScope } from "@paperclipai/db";
import {
  MEDIA_BILLING_LABELS,
  MEDIA_LORA_MAX_PER_COMPANY,
  MEDIA_SETUP_MAX_PER_COMPANY,
  MEDIA_STARTER_LORAS,
  MEDIA_STARTER_SETUPS,
  checkMediaLoraFields,
  checkMediaSetup,
  effectiveMediaLoraContentTag,
  inferMediaLoraFamily,
  pickMediaSetupParams,
  summarizeMediaSetupTrials,
  type CreateMediaLoraInput,
  type CreateMediaSetupInput,
  type CreateMediaSetupTrialInput,
  type MediaBillingCoverage,
  type MediaContentRating,
  type MediaContentTag,
  type MediaContinuityMode,
  type MediaLora,
  type MediaLoraForCheck,
  type MediaLoraProvider,
  type MediaLoraSource,
  type MediaModelSetup,
  type MediaModelSetupTrial,
  type MediaProjectDefaults,
  type MediaResolvedSetup,
  type MediaSetupCheckResult,
  type MediaSetupForCheck,
  type MediaSetupKind,
  type MediaSetupMode,
  type MediaSetupProvider,
  type MediaSetupScoreAttribute,
  type MediaSetupStatus,
  type MediaTrialRaterKind,
  type SetStorylineMediaSetupsInput,
  type UpdateMediaLoraInput,
  type UpdateMediaProjectDefaultsInput,
  type UpdateMediaSetupInput,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { mediaContentRules } from "./media-content-rules.js";
import { assertStorylineEditable, isStorylineEditable, lockStorylineRow, videoStorylineService, type ScopedTx } from "./video-storylines.js";

/**
 * Media Studio film studio, Phase 1: the LoRA library, saved model setups,
 * the setup register (trials and scores) and the company's new-project
 * defaults (see packages/shared/src/media-setups.ts).
 *
 * Company isolation: every query filters on the caller's company, every id a
 * request names (LoRA, setup, storyline, persona) must be this company's, and
 * a setup is checked against this company's own LoRA rows only.
 *
 * Who may do what is decided in the routes: owners and admins write; members
 * read; agents read approved setups only (`reader.agent`) and never write,
 * except picking an approved setup for a storyline.
 *
 * Content: every check uses the Media Studio safety module's rules
 * (media-content-rules.ts). A LoRA the module refuses in every film is never
 * saved or used; a storyline only takes setups its content rating allows.
 *
 * Starters: on first use each company gets the D4 starter setups and the two
 * starter LoRAs, once (deleting them later does not bring them back). The
 * claim is media_project_defaults.setups_seeded_at, set in the same
 * transaction as the inserts, so two first requests at once seed only once.
 *
 * Storylines copy a picked setup's provider and model (the sync rule, see
 * setStorylineSetups). Changing a setup's kind, provider or model updates
 * those copies in the same transaction (syncStorylinesToSetup). Both paths
 * lock the setup row before the storyline rows, so they never deadlock.
 */

export interface MediaSetupsActor {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
}

/** Who is reading: agents only ever see approved setups and usable LoRAs. */
export interface MediaSetupsReader {
  agent: boolean;
}

/** What happened to one storyline when the setup it uses changed. */
interface StorylineSetupSync {
  storylineId: string;
  slot: "image" | "video";
  /** copied: it now runs the setup's new provider and model. unlinked: it keeps its model, shown as custom. */
  outcome: "copied" | "unlinked";
  reason: string | null;
}

/** video_storylines.provider_id and picture_settings.providerId take only these. */
const STORYLINE_PROVIDERS: readonly string[] = ["fal", "sogni"];

type LoraRow = typeof mediaLoras.$inferSelect;
type SetupRow = typeof mediaModelSetups.$inferSelect;
type TrialRow = typeof mediaModelSetupTrials.$inferSelect;
type DefaultsRow = typeof mediaProjectDefaults.$inferSelect;

const SETUP_NOT_FOUND = "That model setup is not in this company (it may have been deleted).";
const LORA_NOT_FOUND = "That LoRA is not in this company's LoRA library (it may have been deleted).";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function userIdOf(actor: MediaSetupsActor): string | null {
  return actor.actorType === "user" ? actor.actorId : null;
}

function refuse(problems: string[]): never {
  throw unprocessable(problems.join(" "), { problems });
}

export function loraForCheck(row: LoraRow): MediaLoraForCheck {
  return {
    id: row.id,
    provider: row.provider as MediaLoraProvider,
    source: row.source as MediaLoraSource,
    ref: row.ref,
    name: row.name,
    family: row.family,
    compatibleModelIds: row.compatibleModelIds,
    contentTag: row.contentTag as MediaContentTag,
    providerNsfw: row.providerNsfw,
    providerSexual: row.providerSexual,
    strengthMin: row.strengthMin,
    strengthMax: row.strengthMax,
    triggerWords: row.triggerWords,
    archivedAt: row.archivedAt,
  };
}

export function toMediaLoraView(row: LoraRow): MediaLora {
  const lora = loraForCheck(row);
  const effective = effectiveMediaLoraContentTag(lora, mediaContentRules);
  const floor = mediaContentRules.loraFloor(lora);
  return {
    id: row.id,
    companyId: row.companyId,
    provider: row.provider as MediaLoraProvider,
    source: row.source as MediaLoraSource,
    ref: row.ref,
    name: row.name,
    notes: row.notes,
    triggerWords: row.triggerWords,
    family: row.family,
    compatibleModelIds: row.compatibleModelIds,
    contentTag: row.contentTag as MediaContentTag,
    effectiveContentTag: effective,
    contentNote:
      floor && floor.tag !== row.contentTag
        ? floor.reason
        : effective === "unreviewed"
          ? "Not reviewed yet: it counts as mature until an owner or admin reviews it."
          : null,
    providerNsfw: row.providerNsfw,
    providerSexual: row.providerSexual,
    strengthMin: row.strengthMin,
    strengthMax: row.strengthMax,
    strengthDefault: row.strengthDefault,
    recommendedMin: row.recommendedMin,
    recommendedMax: row.recommendedMax,
    builtinKey: row.builtinKey,
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: iso(row.reviewedAt),
    archivedAt: iso(row.archivedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function setupForCheck(row: Pick<SetupRow, "kind" | "provider" | "modelId" | "mode" | "editModelId" | "loras" | "params">): MediaSetupForCheck {
  return {
    kind: row.kind as MediaSetupKind,
    provider: row.provider as MediaSetupProvider,
    modelId: row.modelId,
    mode: (row.mode as MediaSetupMode | null) ?? null,
    editModelId: row.editModelId,
    loras: row.loras ?? [],
    params: row.params ?? {},
  };
}

function toTrialView(row: TrialRow): MediaModelSetupTrial {
  return {
    id: row.id,
    setupId: row.setupId,
    storylineId: row.storylineId,
    personaId: row.personaId,
    inputs: row.inputs ?? {},
    prompt: row.prompt,
    resultFileId: row.resultFileId,
    scores: (row.scores ?? {}) as Partial<Record<MediaSetupScoreAttribute, number>>,
    flaggedByCheck: row.flaggedByCheck,
    flaggedByProvider: row.flaggedByProvider,
    costCents: row.costCents,
    secondsTaken: row.secondsTaken,
    raterKind: row.raterKind as MediaTrialRaterKind,
    raterId: row.raterId,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDefaultsView(companyId: string, row: DefaultsRow | undefined): MediaProjectDefaults {
  return {
    companyId,
    defaultImageSetupId: row?.defaultImageSetupId ?? null,
    defaultVideoSetupId: row?.defaultVideoSetupId ?? null,
    defaultContentRating: (row?.defaultContentRating as MediaContentRating | undefined) ?? "sfw",
    defaultContinuityMode: (row?.defaultContinuityMode as MediaContinuityMode | undefined) ?? "stills",
    setupsSeededAt: iso(row?.setupsSeededAt),
    updatedAt: iso(row?.updatedAt),
  };
}

export function mediaSetupsService(db: Db) {
  const storylines = videoStorylineService(db);

  // ─── Starters ───────────────────────────────────────────────────────────

  async function ensureStarters(companyId: string): Promise<void> {
    const [existing] = await db
      .select({ seededAt: mediaProjectDefaults.setupsSeededAt })
      .from(mediaProjectDefaults)
      .where(eq(mediaProjectDefaults.companyId, companyId));
    if (existing?.seededAt) return;
    await withCompanyScope(db, companyId, async (tx) => {
      await tx.insert(mediaProjectDefaults).values({ companyId }).onConflictDoNothing();
      // The claim: only the request that flips setups_seeded_at seeds. A
      // second one waits on the row lock, then sees it set and stops.
      const claimed = await tx
        .update(mediaProjectDefaults)
        .set({ setupsSeededAt: new Date(), updatedAt: new Date() })
        .where(and(eq(mediaProjectDefaults.companyId, companyId), isNull(mediaProjectDefaults.setupsSeededAt)))
        .returning({ id: mediaProjectDefaults.id });
      if (claimed.length === 0) return;

      const start = Date.now();
      const loraIds = new Map<string, string>();
      for (const [index, starter] of MEDIA_STARTER_LORAS.entries()) {
        // The safety module has the last word on starters too: one it refuses
        // in every film is not seeded, one it holds mature is seeded as mature.
        const contentTag = effectiveMediaLoraContentTag({ ...starter, providerNsfw: false, providerSexual: false }, mediaContentRules);
        if (contentTag === "refused") continue;
        const now = new Date(start + index);
        const [inserted] = await tx
          .insert(mediaLoras)
          .values({
            companyId,
            provider: starter.provider,
            source: starter.source,
            ref: starter.ref,
            name: starter.name,
            notes: starter.notes,
            family: starter.family,
            compatibleModelIds: [...starter.compatibleModelIds],
            contentTag,
            strengthMin: starter.strengthMin,
            strengthMax: starter.strengthMax,
            strengthDefault: starter.strengthDefault,
            recommendedMin: starter.recommendedMin,
            recommendedMax: starter.recommendedMax,
            builtinKey: starter.key,
            reviewedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: mediaLoras.id });
        const id =
          inserted?.id ??
          (
            await tx
              .select({ id: mediaLoras.id })
              .from(mediaLoras)
              .where(and(eq(mediaLoras.companyId, companyId), eq(mediaLoras.provider, starter.provider), eq(mediaLoras.ref, starter.ref), isNull(mediaLoras.archivedAt)))
          )[0]?.id;
        if (id) loraIds.set(starter.key, id);
      }
      const seededLoras =
        loraIds.size > 0
          ? await tx
              .select()
              .from(mediaLoras)
              .where(and(eq(mediaLoras.companyId, companyId), inArray(mediaLoras.id, [...loraIds.values()])))
          : [];
      const seededLibrary = new Map(seededLoras.map((row) => [row.id, loraForCheck(row)]));

      const defaults: Partial<Record<MediaSetupKind, string>> = {};
      for (const [index, starter] of MEDIA_STARTER_SETUPS.entries()) {
        const loras = starter.loras
          .map((pick) => ({ loraId: loraIds.get(pick.starterLoraKey), strength: pick.strength }))
          .filter((pick): pick is { loraId: string; strength: number } => Boolean(pick.loraId));
        // Rated by the same check as any other setup, never assumed safe for work.
        const check = checkMediaSetup(
          { kind: starter.kind, provider: starter.provider, modelId: starter.modelId, mode: starter.mode, editModelId: null, loras, params: { ...starter.params } },
          seededLibrary,
          mediaContentRules,
        );
        // One millisecond apart, so the list keeps the starters' own order.
        const now = new Date(start + index);
        const [inserted] = await tx
          .insert(mediaModelSetups)
          .values({
            companyId,
            kind: starter.kind,
            name: starter.name,
            description: starter.description,
            provider: starter.provider,
            family: starter.family,
            mode: starter.mode,
            modelId: starter.modelId,
            loras,
            params: { ...starter.params },
            contentRating: check.contentRating,
            status: "draft",
            tags: [...starter.tags],
            notes: starter.notes,
            builtinKey: starter.key,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: mediaModelSetups.id });
        if (inserted && starter.companyDefault && !defaults[starter.kind]) defaults[starter.kind] = inserted.id;
      }
      await tx
        .update(mediaProjectDefaults)
        .set({
          ...(defaults.image ? { defaultImageSetupId: sql`coalesce(${mediaProjectDefaults.defaultImageSetupId}, ${defaults.image}::uuid)` } : {}),
          ...(defaults.video ? { defaultVideoSetupId: sql`coalesce(${mediaProjectDefaults.defaultVideoSetupId}, ${defaults.video}::uuid)` } : {}),
        })
        .where(eq(mediaProjectDefaults.companyId, companyId));
    });
  }

  // ─── Reading ────────────────────────────────────────────────────────────

  async function loraRows(companyId: string): Promise<LoraRow[]> {
    return db
      .select()
      .from(mediaLoras)
      .where(eq(mediaLoras.companyId, companyId))
      .orderBy(asc(mediaLoras.createdAt), asc(mediaLoras.name));
  }

  async function library(companyId: string): Promise<Map<string, MediaLoraForCheck>> {
    return new Map((await loraRows(companyId)).map((row) => [row.id, loraForCheck(row)]));
  }

  async function getLoraRow(companyId: string, loraId: string): Promise<LoraRow> {
    if (!UUID_RE.test(loraId)) throw notFound(LORA_NOT_FOUND);
    const [row] = await db.select().from(mediaLoras).where(and(eq(mediaLoras.id, loraId), eq(mediaLoras.companyId, companyId)));
    if (!row) throw notFound(LORA_NOT_FOUND);
    return row;
  }

  async function getSetupRow(companyId: string, setupId: string, reader: MediaSetupsReader = { agent: false }): Promise<SetupRow> {
    if (!UUID_RE.test(setupId)) throw notFound(SETUP_NOT_FOUND);
    const [row] = await db
      .select()
      .from(mediaModelSetups)
      .where(and(eq(mediaModelSetups.id, setupId), eq(mediaModelSetups.companyId, companyId)));
    // An agent never learns that a draft or archived setup exists.
    if (!row || (reader.agent && row.status !== "approved")) throw notFound(SETUP_NOT_FOUND);
    return row;
  }

  async function trialsBySetup(companyId: string, setupIds: string[]): Promise<Map<string, TrialRow[]>> {
    const out = new Map<string, TrialRow[]>();
    if (setupIds.length === 0) return out;
    const rows = await db
      .select()
      .from(mediaModelSetupTrials)
      .where(and(eq(mediaModelSetupTrials.companyId, companyId), inArray(mediaModelSetupTrials.setupId, setupIds)))
      .orderBy(desc(mediaModelSetupTrials.createdAt));
    for (const row of rows) {
      const list = out.get(row.setupId) ?? [];
      list.push(row);
      out.set(row.setupId, list);
    }
    return out;
  }

  function toSetupView(row: SetupRow, lib: ReadonlyMap<string, MediaLoraForCheck>, trials: TrialRow[]): MediaModelSetup {
    const check = checkMediaSetup(setupForCheck(row), lib, mediaContentRules);
    const billing: MediaBillingCoverage = check.billing;
    return {
      id: row.id,
      companyId: row.companyId,
      kind: row.kind as MediaSetupKind,
      name: row.name,
      description: row.description,
      provider: row.provider as MediaSetupProvider,
      family: row.family,
      mode: (row.mode as MediaSetupMode | null) ?? null,
      modelId: row.modelId,
      editModelId: row.editModelId,
      loras: (row.loras ?? []).map((pick) => {
        const lora = lib.get(pick.loraId);
        return {
          loraId: pick.loraId,
          strength: pick.strength,
          name: lora?.name ?? null,
          ref: lora?.ref ?? null,
          source: lora?.source ?? null,
          triggerWords: lora?.triggerWords ?? [],
          contentTag: lora ? effectiveMediaLoraContentTag(lora, mediaContentRules) : null,
        };
      }),
      // Only the allowed settings, ever; a stored key outside the list shows in `problems`.
      params: pickMediaSetupParams(row.params ?? {}),
      // Computed now, so a LoRA reviewed or refused after the setup was saved shows at once.
      contentRating: check.contentRating,
      matureReasons: check.matureReasons,
      matureEnabledByUserId: row.matureEnabledByUserId,
      status: row.status as MediaSetupStatus,
      approvedByUserId: row.approvedByUserId,
      approvedAt: iso(row.approvedAt),
      tags: row.tags,
      favorite: row.favorite,
      notes: row.notes,
      builtinKey: row.builtinKey,
      billing,
      billingLabel: MEDIA_BILLING_LABELS[billing],
      triggerWords: check.triggerWords,
      problems: check.problems,
      register: summarizeMediaSetupTrials(
        trials.map((trial) => ({
          scores: (trial.scores ?? {}) as Partial<Record<MediaSetupScoreAttribute, number>>,
          raterKind: trial.raterKind as MediaTrialRaterKind,
          flaggedByCheck: trial.flaggedByCheck,
          flaggedByProvider: trial.flaggedByProvider,
          costCents: trial.costCents,
          secondsTaken: trial.secondsTaken,
        })),
        check.contentRating,
      ),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function listSetups(
    companyId: string,
    reader: MediaSetupsReader,
    opts: { kind?: MediaSetupKind; includeArchived?: boolean } = {},
  ): Promise<MediaModelSetup[]> {
    await ensureStarters(companyId);
    const conditions = [eq(mediaModelSetups.companyId, companyId)];
    if (opts.kind) conditions.push(eq(mediaModelSetups.kind, opts.kind));
    if (reader.agent) conditions.push(eq(mediaModelSetups.status, "approved"));
    else if (!opts.includeArchived) conditions.push(ne(mediaModelSetups.status, "archived"));
    const rows = await db
      .select()
      .from(mediaModelSetups)
      .where(and(...conditions))
      .orderBy(desc(mediaModelSetups.favorite), asc(mediaModelSetups.createdAt), asc(mediaModelSetups.name));
    const [lib, trials] = await Promise.all([library(companyId), trialsBySetup(companyId, rows.map((r) => r.id))]);
    return rows.map((row) => toSetupView(row, lib, trials.get(row.id) ?? []));
  }

  async function getSetup(companyId: string, setupId: string, reader: MediaSetupsReader): Promise<MediaModelSetup> {
    const row = await getSetupRow(companyId, setupId, reader);
    const [lib, trials] = await Promise.all([library(companyId), trialsBySetup(companyId, [row.id])]);
    return toSetupView(row, lib, trials.get(row.id) ?? []);
  }

  async function listLoras(companyId: string, reader: MediaSetupsReader, opts: { includeArchived?: boolean } = {}): Promise<MediaLora[]> {
    await ensureStarters(companyId);
    const views = (await loraRows(companyId)).map(toMediaLoraView);
    if (reader.agent) return views.filter((lora) => !lora.archivedAt && lora.effectiveContentTag !== "refused");
    return opts.includeArchived ? views : views.filter((lora) => !lora.archivedAt);
  }

  async function getLora(companyId: string, loraId: string, reader: MediaSetupsReader): Promise<MediaLora> {
    const view = toMediaLoraView(await getLoraRow(companyId, loraId));
    if (reader.agent && (view.archivedAt || view.effectiveContentTag === "refused")) throw notFound(LORA_NOT_FOUND);
    return view;
  }

  /** A setup ready to run: the provider refs of its LoRAs, its params and whether it can be used now. */
  async function resolveSetup(companyId: string, setupId: string, reader: MediaSetupsReader): Promise<MediaResolvedSetup> {
    const row = await getSetupRow(companyId, setupId, reader);
    const lib = await library(companyId);
    const check = checkMediaSetup(setupForCheck(row), lib, mediaContentRules);
    const problems = [...check.problems];
    if (row.status === "archived") problems.unshift("This setup is archived. Pick another one, or bring it back first.");
    return {
      setupId: row.id,
      name: row.name,
      kind: row.kind as MediaSetupKind,
      status: row.status as MediaSetupStatus,
      provider: row.provider as MediaSetupProvider,
      modelId: row.modelId,
      editModelId: row.editModelId,
      mode: check.mode,
      family: row.family ?? check.family,
      loras: (row.loras ?? []).flatMap((pick) => {
        const lora = lib.get(pick.loraId);
        return lora ? [{ loraId: lora.id, ref: lora.ref, source: lora.source, name: lora.name ?? lora.ref, strength: pick.strength, triggerWords: lora.triggerWords }] : [];
      }),
      triggerWords: check.triggerWords,
      // Only the allowed settings reach a run: never a provider safety switch (plan 2.10).
      params: pickMediaSetupParams(row.params ?? {}),
      contentRating: check.contentRating,
      billing: check.billing,
      usable: problems.length === 0,
      problems,
    };
  }

  // ─── Setups: writing ────────────────────────────────────────────────────

  async function assertSetupNameFree(companyId: string, name: string, exceptId: string | null): Promise<void> {
    const rows = await db
      .select({ id: mediaModelSetups.id })
      .from(mediaModelSetups)
      .where(and(eq(mediaModelSetups.companyId, companyId), sql`lower(${mediaModelSetups.name}) = lower(${name})`));
    if (rows.some((r) => r.id !== exceptId)) throw conflict(`There is already a model setup called "${name}". Pick another name.`);
  }

  async function checkSetup(companyId: string, input: MediaSetupForCheck): Promise<MediaSetupCheckResult> {
    const check = checkMediaSetup(input, await library(companyId), mediaContentRules);
    return {
      ok: check.problems.length === 0,
      problems: check.problems,
      contentRating: check.contentRating,
      matureReasons: check.matureReasons,
      mode: check.mode,
      family: check.family,
      billing: check.billing,
      billingLabel: MEDIA_BILLING_LABELS[check.billing],
      triggerWords: check.triggerWords,
    };
  }

  async function createSetup(companyId: string, input: CreateMediaSetupInput, actor: MediaSetupsActor): Promise<MediaModelSetup> {
    await ensureStarters(companyId);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaModelSetups)
      .where(eq(mediaModelSetups.companyId, companyId));
    if (count >= MEDIA_SETUP_MAX_PER_COMPANY) {
      throw unprocessable(`A company can have at most ${MEDIA_SETUP_MAX_PER_COMPANY} model setups. Delete or archive one you no longer use first.`);
    }
    await assertSetupNameFree(companyId, input.name, null);
    const check = checkMediaSetup(input, await library(companyId), mediaContentRules);
    if (check.problems.length > 0) refuse(check.problems);
    const now = new Date();
    const userId = userIdOf(actor);
    const [row] = await db
      .insert(mediaModelSetups)
      .values({
        companyId,
        kind: input.kind,
        name: input.name,
        description: input.description,
        provider: input.provider,
        family: input.family ?? check.family,
        mode: check.mode,
        modelId: input.modelId,
        editModelId: input.editModelId,
        loras: input.loras,
        params: input.params,
        contentRating: check.contentRating,
        matureEnabledByUserId: check.contentRating === "mature" ? userId : null,
        status: input.status,
        approvedByUserId: input.status === "approved" ? userId : null,
        approvedAt: input.status === "approved" ? now : null,
        tags: input.tags,
        favorite: input.favorite,
        notes: input.notes,
        createdByUserId: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("Model setup insert returned no row");
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "media.setup_created",
      entityType: "media_model_setup",
      entityId: row.id,
      details: { name: row.name, kind: row.kind, provider: row.provider, modelId: row.modelId, status: row.status, contentRating: row.contentRating },
    });
    return getSetup(companyId, row.id, { agent: false });
  }

  async function updateSetup(companyId: string, setupId: string, input: UpdateMediaSetupInput, actor: MediaSetupsActor): Promise<MediaModelSetup> {
    const existing = await getSetupRow(companyId, setupId);
    if (input.name !== undefined) await assertSetupNameFree(companyId, input.name, setupId);
    const recipeChanged = (["kind", "provider", "modelId", "mode", "editModelId", "loras", "params"] as const).some((key) => input[key] !== undefined);
    const approving = input.status === "approved" && existing.status !== "approved";
    const merged = setupForCheck({
      kind: input.kind ?? existing.kind,
      provider: input.provider ?? existing.provider,
      modelId: input.modelId ?? existing.modelId,
      mode: input.mode !== undefined ? input.mode : existing.mode,
      editModelId: input.editModelId !== undefined ? input.editModelId : existing.editModelId,
      loras: input.loras ?? existing.loras,
      params: input.params ?? existing.params,
    });
    const check = checkMediaSetup(merged, await library(companyId), mediaContentRules);
    // Renaming, notes or archiving never trip over a problem that came later
    // (a LoRA refused after saving); changing the recipe or approving does.
    if ((recipeChanged || approving) && check.problems.length > 0) refuse(check.problems);
    const userId = userIdOf(actor);
    const now = new Date();
    const statusFields =
      input.status === undefined || input.status === existing.status
        ? {}
        : input.status === "approved"
          ? { status: input.status, approvedByUserId: userId, approvedAt: now }
          : input.status === "draft"
            ? { status: input.status, approvedByUserId: null, approvedAt: null }
            : { status: input.status };
    // Storylines copy a setup's kind (which slot), provider and model. When
    // one of those is sent, the storylines that use the setup follow in the
    // same transaction, so none keeps rendering the old model under the
    // setup's name. The sync compares each storyline's copy with the row as
    // written here (not with `existing`, read before the lock), so two edits
    // of the same setup at once still leave every copy matching the setup.
    // Mode, LoRAs and params are not copied. A setup that is rated mature
    // after the edit also leaves every safe-for-work storyline that uses it.
    const copyFieldSent = input.kind !== undefined || input.provider !== undefined || input.modelId !== undefined;
    const { row, synced } = await withCompanyScope(db, companyId, async (tx) => {
      const [updated] = await tx
        .update(mediaModelSetups)
        .set({
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.family !== undefined ? { family: input.family } : recipeChanged ? { family: check.family } : {}),
          ...(recipeChanged ? { mode: check.mode } : {}),
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          ...(input.editModelId !== undefined ? { editModelId: input.editModelId } : {}),
          ...(input.loras !== undefined ? { loras: input.loras } : {}),
          ...(input.params !== undefined ? { params: input.params } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.favorite !== undefined ? { favorite: input.favorite } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...statusFields,
          contentRating: check.contentRating,
          ...(check.contentRating === "mature" && existing.contentRating !== "mature" ? { matureEnabledByUserId: userId } : {}),
          ...(check.contentRating === "sfw" ? { matureEnabledByUserId: null } : {}),
          updatedAt: now,
        })
        .where(and(eq(mediaModelSetups.id, setupId), eq(mediaModelSetups.companyId, companyId)))
        .returning();
      if (!updated) throw notFound(SETUP_NOT_FOUND);
      const sync = copyFieldSent || updated.contentRating === "mature";
      return { row: updated, synced: sync ? await syncStorylinesToSetup(tx, companyId, updated) : [] };
    });
    // A different video model changes what each clip costs, so the cached estimate follows.
    for (const sync of synced) {
      if (sync.slot === "video" && sync.outcome === "copied") await storylines.recomputeEstimate(companyId, sync.storylineId);
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: input.status && input.status !== existing.status ? `media.setup_${input.status}` : "media.setup_updated",
      entityType: "media_model_setup",
      entityId: setupId,
      details: {
        fields: Object.keys(input),
        status: row.status,
        contentRating: row.contentRating,
        ...(synced.length > 0
          ? {
              storylinesFollowed: synced.filter((s) => s.outcome === "copied").map((s) => s.storylineId),
              storylinesUnlinked: synced.filter((s) => s.outcome === "unlinked").map((s) => s.storylineId),
            }
          : {}),
      },
    });
    for (const sync of synced) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: sync.outcome === "copied" ? "video_storyline.setup_followed" : "video_storyline.setup_unlinked",
        entityType: "video_storyline",
        entityId: sync.storylineId,
        details: {
          setupId,
          slot: sync.slot,
          ...(sync.outcome === "copied" ? { providerId: row.provider, model: row.modelId } : { reason: sync.reason }),
        },
      });
    }
    return getSetup(companyId, setupId, { agent: false });
  }

  /**
   * The sync rule after a setup's kind, provider or model was edited, or the
   * setup is rated mature (inside updateSetup's transaction, with the setup
   * row already updated and so locked). A safe-for-work storyline loses the
   * pick of a mature setup and keeps the model it has. Each other storyline
   * slot that uses the setup and whose copy no longer matches it either:
   *   - gets the new provider and model copied, when it can be edited now
   *     and the setup still fits its slot; or
   *   - loses the pick and keeps the model it has, shown as "custom (not
   *     from a setup)": a storyline that is rendering, stitching or done
   *     keeps what it is being made with, and a setup that no longer fits
   *     the slot (another kind, or pictures on a service storylines cannot
   *     use) cannot be its source.
   * A slot whose copy already matches is left alone, so running it again
   * changes nothing.
   */
  async function syncStorylinesToSetup(tx: ScopedTx, companyId: string, setup: SetupRow): Promise<StorylineSetupSync[]> {
    const users = await tx
      .select({
        id: videoStorylines.id,
        status: videoStorylines.status,
        imageSetupId: videoStorylines.imageSetupId,
        videoSetupId: videoStorylines.videoSetupId,
        providerId: videoStorylines.providerId,
        model: videoStorylines.model,
        pictureSettings: videoStorylines.pictureSettings,
        contentRating: videoStorylines.contentRating,
      })
      .from(videoStorylines)
      .where(and(eq(videoStorylines.companyId, companyId), or(eq(videoStorylines.imageSetupId, setup.id), eq(videoStorylines.videoSetupId, setup.id))))
      .orderBy(asc(videoStorylines.id))
      .for("update");
    const out: StorylineSetupSync[] = [];
    const now = new Date();
    for (const storyline of users) {
      const picture = (storyline.pictureSettings ?? {}) as { providerId?: unknown; model?: unknown };
      const tooMature = setup.contentRating === "mature" && storyline.contentRating !== "mature";
      const videoStale =
        storyline.videoSetupId === setup.id &&
        (tooMature || !(setup.kind === "video" && storyline.providerId === setup.provider && storyline.model === setup.modelId));
      const imageStale =
        storyline.imageSetupId === setup.id &&
        (tooMature || !(setup.kind === "image" && picture.providerId === setup.provider && picture.model === setup.modelId));
      if (!videoStale && !imageStale) continue;
      const editable = isStorylineEditable(storyline);
      const mature = tooMature ? "The setup is now rated mature, and the storyline is safe for work." : null;
      const busy = editable ? null : `The storyline is ${storyline.status.replace(/_/g, " ")}, so it keeps the model it is made with.`;
      const providerFits = STORYLINE_PROVIDERS.includes(setup.provider);
      const videoReason =
        mature ?? busy ?? (setup.kind !== "video" ? "The setup is no longer a video setup." : !providerFits ? "Storyline clips are made with Fal or Sogni only." : null);
      const imageReason =
        mature ??
        busy ??
        (setup.kind !== "image"
          ? "The setup is no longer a picture setup."
          : !providerFits
            ? `A storyline's pictures are made with Fal or Sogni; the setup now uses ${setup.provider}.`
            : null);
      if (videoStale) out.push({ storylineId: storyline.id, slot: "video", outcome: videoReason ? "unlinked" : "copied", reason: videoReason });
      if (imageStale) out.push({ storylineId: storyline.id, slot: "image", outcome: imageReason ? "unlinked" : "copied", reason: imageReason });
      await tx
        .update(videoStorylines)
        .set({
          ...(videoStale ? (videoReason ? { videoSetupId: null } : { providerId: setup.provider, model: setup.modelId }) : {}),
          ...(imageStale
            ? imageReason
              ? { imageSetupId: null }
              : {
                  pictureSettings: sql`(coalesce(${videoStorylines.pictureSettings}, '{}'::jsonb) - 'providerId' - 'model') || ${JSON.stringify({ providerId: setup.provider, model: setup.modelId })}::jsonb`,
                }
            : {}),
          // A rendering storyline's updated_at is its stall clock (releaseStalledRenders); leave it.
          ...(editable ? { updatedAt: now } : {}),
        })
        .where(and(eq(videoStorylines.id, storyline.id), eq(videoStorylines.companyId, companyId)));
    }
    return out;
  }

  async function deleteSetup(companyId: string, setupId: string, actor: MediaSetupsActor): Promise<void> {
    const row = await getSetupRow(companyId, setupId);
    await db.delete(mediaModelSetups).where(and(eq(mediaModelSetups.id, setupId), eq(mediaModelSetups.companyId, companyId)));
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "media.setup_deleted",
      entityType: "media_model_setup",
      entityId: setupId,
      details: { name: row.name },
    });
  }

  // ─── LoRAs: writing ─────────────────────────────────────────────────────

  async function assertLoraRefFree(companyId: string, provider: string, ref: string, exceptId: string | null): Promise<void> {
    const rows = await db
      .select({ id: mediaLoras.id, name: mediaLoras.name })
      .from(mediaLoras)
      .where(and(eq(mediaLoras.companyId, companyId), eq(mediaLoras.provider, provider), eq(mediaLoras.ref, ref), isNull(mediaLoras.archivedAt)));
    const other = rows.find((r) => r.id !== exceptId);
    if (other) throw conflict(`This LoRA is already in the library as "${other.name}".`);
  }

  async function createLora(companyId: string, input: CreateMediaLoraInput, actor: MediaSetupsActor): Promise<MediaLora> {
    await ensureStarters(companyId);
    const problems = checkMediaLoraFields(input, mediaContentRules);
    if (problems.length > 0) refuse(problems);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaLoras)
      .where(eq(mediaLoras.companyId, companyId));
    if (count >= MEDIA_LORA_MAX_PER_COMPANY) {
      throw unprocessable(`A company can have at most ${MEDIA_LORA_MAX_PER_COMPANY} saved LoRAs. Delete one you no longer use first.`);
    }
    await assertLoraRefFree(companyId, input.provider, input.ref, null);
    const now = new Date();
    const userId = userIdOf(actor);
    const reviewed = input.contentTag !== "unreviewed";
    const [row] = await db
      .insert(mediaLoras)
      .values({
        companyId,
        provider: input.provider,
        source: input.source,
        ref: input.ref,
        name: input.name,
        notes: input.notes,
        triggerWords: input.triggerWords,
        family: input.family ?? inferMediaLoraFamily(input),
        compatibleModelIds: input.compatibleModelIds,
        contentTag: input.contentTag,
        providerNsfw: input.providerNsfw,
        providerSexual: input.providerSexual,
        strengthMin: input.strengthMin,
        strengthMax: input.strengthMax,
        strengthDefault: input.strengthDefault,
        recommendedMin: input.recommendedMin,
        recommendedMax: input.recommendedMax,
        reviewedByUserId: reviewed ? userId : null,
        reviewedAt: reviewed ? now : null,
        createdByUserId: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("LoRA insert returned no row");
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "media.lora_created",
      entityType: "media_lora",
      entityId: row.id,
      details: { name: row.name, provider: row.provider, source: row.source, contentTag: row.contentTag },
    });
    return toMediaLoraView(row);
  }

  async function updateLora(companyId: string, loraId: string, input: UpdateMediaLoraInput, actor: MediaSetupsActor): Promise<MediaLora> {
    const existing = await getLoraRow(companyId, loraId);
    const { archived, ...fields } = input;
    const merged = {
      provider: existing.provider as MediaLoraProvider,
      source: existing.source as MediaLoraSource,
      ref: existing.ref,
      name: fields.name ?? existing.name,
      contentTag: (fields.contentTag ?? existing.contentTag) as MediaContentTag,
      providerNsfw: fields.providerNsfw ?? existing.providerNsfw,
      providerSexual: fields.providerSexual ?? existing.providerSexual,
      strengthMin: fields.strengthMin !== undefined ? fields.strengthMin : existing.strengthMin,
      strengthMax: fields.strengthMax !== undefined ? fields.strengthMax : existing.strengthMax,
      strengthDefault: fields.strengthDefault ?? existing.strengthDefault,
      recommendedMin: fields.recommendedMin !== undefined ? fields.recommendedMin : existing.recommendedMin,
      recommendedMax: fields.recommendedMax !== undefined ? fields.recommendedMax : existing.recommendedMax,
    };
    const problems = checkMediaLoraFields(merged, mediaContentRules);
    if (problems.length > 0) refuse(problems);
    if (archived === false && existing.archivedAt) await assertLoraRefFree(companyId, existing.provider, existing.ref, loraId);
    const now = new Date();
    const userId = userIdOf(actor);
    const reviewing = fields.contentTag !== undefined && fields.contentTag !== existing.contentTag;
    const [row] = await db
      .update(mediaLoras)
      .set({
        ...fields,
        ...(reviewing ? { reviewedByUserId: fields.contentTag === "unreviewed" ? null : userId, reviewedAt: fields.contentTag === "unreviewed" ? null : now } : {}),
        ...(archived === true && !existing.archivedAt ? { archivedAt: now } : {}),
        ...(archived === false ? { archivedAt: null } : {}),
        updatedAt: now,
      })
      .where(and(eq(mediaLoras.id, loraId), eq(mediaLoras.companyId, companyId)))
      .returning();
    if (!row) throw notFound(LORA_NOT_FOUND);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: reviewing ? "media.lora_reviewed" : "media.lora_updated",
      entityType: "media_lora",
      entityId: loraId,
      details: { fields: Object.keys(input), contentTag: row.contentTag, archived: Boolean(row.archivedAt) },
    });
    return toMediaLoraView(row);
  }

  async function deleteLora(companyId: string, loraId: string, actor: MediaSetupsActor): Promise<void> {
    const row = await getLoraRow(companyId, loraId);
    const users = await db
      .select({ name: mediaModelSetups.name })
      .from(mediaModelSetups)
      .where(
        and(
          eq(mediaModelSetups.companyId, companyId),
          ne(mediaModelSetups.status, "archived"),
          sql`${mediaModelSetups.loras} @> ${JSON.stringify([{ loraId }])}::jsonb`,
        ),
      );
    if (users.length > 0) {
      throw conflict(
        `This LoRA is used by ${users.map((u) => `"${u.name}"`).join(", ")}. Remove it from ${users.length === 1 ? "that setup" : "those setups"} first, or archive the LoRA instead.`,
      );
    }
    await db.delete(mediaLoras).where(and(eq(mediaLoras.id, loraId), eq(mediaLoras.companyId, companyId)));
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "media.lora_deleted",
      entityType: "media_lora",
      entityId: loraId,
      details: { name: row.name },
    });
  }

  // ─── Register: trials ───────────────────────────────────────────────────

  async function listTrials(companyId: string, setupId: string): Promise<MediaModelSetupTrial[]> {
    await getSetupRow(companyId, setupId);
    return ((await trialsBySetup(companyId, [setupId])).get(setupId) ?? []).map(toTrialView);
  }

  async function createTrial(companyId: string, setupId: string, input: CreateMediaSetupTrialInput, actor: MediaSetupsActor): Promise<MediaModelSetupTrial> {
    await getSetupRow(companyId, setupId);
    if (input.storylineId) {
      const [storyline] = await db
        .select({ id: videoStorylines.id })
        .from(videoStorylines)
        .where(and(eq(videoStorylines.id, input.storylineId), eq(videoStorylines.companyId, companyId)));
      if (!storyline) throw unprocessable("That storyline is not in this company.");
    }
    if (input.personaId) {
      const [persona] = await db
        .select({ id: personas.id })
        .from(personas)
        .where(and(eq(personas.id, input.personaId), eq(personas.companyId, companyId)));
      if (!persona) throw unprocessable("That persona is not in this company.");
    }
    const [row] = await db
      .insert(mediaModelSetupTrials)
      .values({
        companyId,
        setupId,
        storylineId: input.storylineId,
        personaId: input.personaId,
        inputs: input.inputs,
        prompt: input.prompt,
        resultFileId: input.resultFileId,
        scores: input.scores as Record<string, number>,
        flaggedByCheck: input.flaggedByCheck,
        flaggedByProvider: input.flaggedByProvider,
        costCents: input.costCents,
        secondsTaken: input.secondsTaken,
        raterKind: input.raterKind,
        raterId: actor.actorId,
        notes: input.notes,
      })
      .returning();
    if (!row) throw new Error("Setup trial insert returned no row");
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "media.setup_trial_recorded",
      entityType: "media_model_setup",
      entityId: setupId,
      details: { trialId: row.id, raterKind: row.raterKind, scored: Object.keys(input.scores), flagged: row.flaggedByCheck || row.flaggedByProvider },
    });
    return toTrialView(row);
  }

  async function deleteTrial(companyId: string, setupId: string, trialId: string, actor: MediaSetupsActor): Promise<void> {
    await getSetupRow(companyId, setupId);
    if (!UUID_RE.test(trialId)) throw notFound("That try is not in this setup's register.");
    const deleted = await db
      .delete(mediaModelSetupTrials)
      .where(and(eq(mediaModelSetupTrials.id, trialId), eq(mediaModelSetupTrials.setupId, setupId), eq(mediaModelSetupTrials.companyId, companyId)))
      .returning({ id: mediaModelSetupTrials.id });
    if (deleted.length === 0) throw notFound("That try is not in this setup's register.");
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "media.setup_trial_deleted",
      entityType: "media_model_setup",
      entityId: setupId,
      details: { trialId },
    });
  }

  // ─── Project defaults ───────────────────────────────────────────────────

  async function getProjectDefaults(companyId: string): Promise<MediaProjectDefaults> {
    await ensureStarters(companyId);
    const [row] = await db.select().from(mediaProjectDefaults).where(eq(mediaProjectDefaults.companyId, companyId));
    return toDefaultsView(companyId, row);
  }

  /** A setup picked as a default or for a storyline: this company's, not archived, of the right kind. */
  async function assertPickableSetup(companyId: string, setupId: string, kind: MediaSetupKind, reader: MediaSetupsReader, what: string): Promise<SetupRow> {
    const row = await getSetupRow(companyId, setupId, reader).catch(() => {
      throw unprocessable(`The ${what} is not one of this company's model setups${reader.agent ? " that are approved" : ""}. Pick one from the list.`);
    });
    if (row.status === "archived") throw unprocessable(`The ${what} "${row.name}" is archived. Pick a setup that is in use.`);
    if (row.kind !== kind) throw unprocessable(`"${row.name}" is a ${row.kind === "image" ? "picture" : "video"} setup; the ${what} must be a ${kind === "image" ? "picture" : "video"} setup.`);
    return row;
  }

  async function updateProjectDefaults(companyId: string, input: UpdateMediaProjectDefaultsInput, actor: MediaSetupsActor): Promise<MediaProjectDefaults> {
    await ensureStarters(companyId);
    if (input.defaultImageSetupId) await assertPickableSetup(companyId, input.defaultImageSetupId, "image", { agent: false }, "default picture setup");
    if (input.defaultVideoSetupId) await assertPickableSetup(companyId, input.defaultVideoSetupId, "video", { agent: false }, "default video setup");
    const now = new Date();
    await db
      .update(mediaProjectDefaults)
      .set({ ...input, updatedByUserId: userIdOf(actor), updatedAt: now })
      .where(eq(mediaProjectDefaults.companyId, companyId));
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "media.project_defaults_updated",
      entityType: "media_project_defaults",
      entityId: companyId,
      details: { ...input },
    });
    return getProjectDefaults(companyId);
  }

  // ─── Storylines: one source of truth for the model ──────────────────────

  /**
   * Pick the picture and/or video setup a storyline uses. The setup's
   * provider and model are copied, in the same transaction, into
   * video_storylines.provider_id/model (video) and picture_settings
   * providerId/model (pictures): a derived cache for the older code paths.
   * null clears the pick and leaves the copied provider/model as they are.
   * A later change to the setup's kind, provider or model is carried to the
   * storyline by updateSetup (syncStorylinesToSetup).
   */
  async function setStorylineSetups(companyId: string, storylineId: string, input: SetStorylineMediaSetupsInput, actor: MediaSetupsActor, reader: MediaSetupsReader) {
    if (!UUID_RE.test(storylineId)) throw notFound("Video storyline not found");
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    assertStorylineEditable(storyline);
    const image = input.imageSetupId ? await assertPickableSetup(companyId, input.imageSetupId, "image", reader, "picture setup") : null;
    const video = input.videoSetupId ? await assertPickableSetup(companyId, input.videoSetupId, "video", reader, "video setup") : null;
    const lib = await library(companyId);
    // The storyline's content rating decides what it may use, with the safety
    // module's rules as in every film: a LoRA refused in every film never
    // (a problem), and in a safe-for-work storyline nothing mature or not yet
    // reviewed.
    const safeForWork = storyline.contentRating !== "mature";
    for (const setup of [image, video]) {
      if (!setup) continue;
      const check = checkMediaSetup(setupForCheck(setup), lib, mediaContentRules);
      if (check.problems.length > 0) refuse([`"${setup.name}" cannot be used right now.`, ...check.problems]);
      if (safeForWork && check.contentRating === "mature") {
        refuse([`"${setup.name}" is rated mature, and this storyline is safe for work, so it can only use setups rated safe for work.`, ...check.matureReasons]);
      }
    }
    if (image && image.provider !== "fal" && image.provider !== "sogni") {
      throw unprocessable(`"${image.name}" uses ${image.provider}; a storyline's pictures are made with Fal or Sogni. Pick a Fal or Sogni picture setup.`);
    }
    await withCompanyScope(db, companyId, async (tx) => {
      // Lock order: the setup rows first, then the storyline, the same as
      // updateSetup. A setup edited since the checks above (any change bumps
      // updated_at), or a storyline whose rating changed, is refused rather
      // than copied stale.
      const picked = [image, video].filter((setup): setup is SetupRow => Boolean(setup));
      if (picked.length > 0) {
        const current = await tx
          .select()
          .from(mediaModelSetups)
          .where(and(eq(mediaModelSetups.companyId, companyId), inArray(mediaModelSetups.id, picked.map((setup) => setup.id))))
          .orderBy(asc(mediaModelSetups.id))
          .for("share");
        for (const setup of picked) {
          const now = current.find((row) => row.id === setup.id);
          if (
            !now ||
            now.kind !== setup.kind ||
            now.provider !== setup.provider ||
            now.modelId !== setup.modelId ||
            now.status !== setup.status ||
            now.updatedAt.getTime() !== setup.updatedAt.getTime()
          ) {
            throw conflict(`"${setup.name}" was changed while it was being picked. Check it and pick it again.`);
          }
        }
      }
      const locked = await lockStorylineRow(tx, companyId, storylineId);
      assertStorylineEditable(locked);
      if (locked.contentRating !== storyline.contentRating) {
        throw conflict("The storyline's content rating was changed while the setups were being picked. Pick them again.");
      }
      await tx
        .update(videoStorylines)
        .set({
          ...(input.imageSetupId !== undefined ? { imageSetupId: input.imageSetupId } : {}),
          ...(input.videoSetupId !== undefined ? { videoSetupId: input.videoSetupId } : {}),
          ...(video ? { providerId: video.provider, model: video.modelId } : {}),
          ...(image
            ? {
                pictureSettings: sql`(coalesce(${videoStorylines.pictureSettings}, '{}'::jsonb) - 'providerId' - 'model') || ${JSON.stringify({ providerId: image.provider, model: image.modelId })}::jsonb`,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(videoStorylines.id, storylineId), eq(videoStorylines.companyId, companyId)));
    });
    // A different video model changes what each clip costs, so the cached estimate follows.
    if (video) await storylines.recomputeEstimate(companyId, storylineId);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_storyline.setups_picked",
      entityType: "video_storyline",
      entityId: storylineId,
      details: { imageSetupId: input.imageSetupId, videoSetupId: input.videoSetupId },
    });
    return storylines.getStoryline(companyId, storylineId);
  }

  return {
    ensureStarters,
    listSetups,
    getSetup,
    getSetupRow,
    checkSetup,
    createSetup,
    updateSetup,
    deleteSetup,
    resolveSetup,
    listLoras,
    getLora,
    createLora,
    updateLora,
    deleteLora,
    listTrials,
    createTrial,
    deleteTrial,
    getProjectDefaults,
    updateProjectDefaults,
    setStorylineSetups,
  };
}
