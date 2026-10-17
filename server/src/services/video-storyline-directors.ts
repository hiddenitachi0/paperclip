import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, modelDirectoryEntries, videoStorylineDirectors, videoStorylines } from "@paperclipai/db";
import {
  VIDEO_DIRECTOR_MAX_PER_COMPANY,
  VIDEO_DIRECTOR_STARTERS,
  VIDEO_DIRECTOR_TEXT_ONLY_EXPLANATION,
  VIDEO_DIRECTOR_TEXT_ONLY_NO_HELPER_EXPLANATION,
  helperModelCanSeePictures,
  laneAProviderLabel,
  modelPickerReadiness,
  normalizeLaneAProvider,
  readinessHealthReading,
  readinessSetupFromDirectoryEntry,
  savedModelToolSupport,
  type CreateVideoStorylineDirectorInput,
  type LaneAProvider,
  type ModelDirectoryEntry,
  type ModelKeyState,
  type UpdateVideoStorylineDirectorInput,
  type VideoDirectorModelView,
  type VideoDirectorThinking,
  type VideoStorylineDirector,
  type VideoStorylineDirectorsView,
  type VideoStorylineProvider,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { readAnthropicApiKey } from "../env-values.js";
import { logActivity } from "./activity-log.js";
import { helperService, type HelperServiceOptions } from "./helper.js";
import { modelDirectoryService } from "./model-directory.js";
import { modelHealthService } from "./model-health.js";
import { videoStorylineSettingsService } from "./video-storyline-settings.js";
import { assertStorylineEditable, videoStorylineService, type VideoStorylineActor } from "./video-storylines.js";

/**
 * Storyline directors (see packages/shared/src/video-storyline-directors.ts):
 * per-company CRUD, the two starters, and the view the editor and the
 * pickers show (each model's readiness, whether a key is in place, whether
 * it can see pictures and use tools, and how the writer will run).
 *
 * Company isolation: every query filters on the caller's company; a saved
 * model or secret named in a director must be this company's (checked on
 * every save), and a director picked for a storyline must be too.
 */

export type DirectorRow = typeof videoStorylineDirectors.$inferSelect;

/** The secret consumer recorded when a director's own key is read. */
export const VIDEO_DIRECTOR_KEY_CONSUMER = "video-storyline-director";

function iso(date: Date): string {
  return date.toISOString();
}

export function videoStorylineDirectorsService(db: Db, options: HelperServiceOptions = {}) {
  const settings = videoStorylineSettingsService(db);
  const helper = helperService(db, options);
  const models = modelDirectoryService(db);
  const storylines = videoStorylineService(db);

  /** The two starters, once per company (deleting them later does not bring them back). */
  async function ensureStarters(companyId: string): Promise<void> {
    if (await settings.directorsSeeded(companyId)) return;
    const start = Date.now();
    for (const [index, starter] of VIDEO_DIRECTOR_STARTERS.entries()) {
      // One millisecond apart, so the list keeps the starters' own order.
      const now = new Date(start + index);
      await db
        .insert(videoStorylineDirectors)
        .values({
          companyId,
          name: starter.name,
          description: starter.description,
          builtinKey: starter.key,
          temperature: starter.temperature,
          styleInstructions: starter.styleInstructions,
          defaultShotSeconds: starter.defaultShotSeconds,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
    await settings.markDirectorsSeeded(companyId);
  }

  async function listRows(companyId: string): Promise<DirectorRow[]> {
    return db
      .select()
      .from(videoStorylineDirectors)
      .where(eq(videoStorylineDirectors.companyId, companyId))
      .orderBy(asc(videoStorylineDirectors.createdAt), asc(videoStorylineDirectors.name));
  }

  async function getRow(companyId: string, directorId: string): Promise<DirectorRow> {
    const [row] = await db
      .select()
      .from(videoStorylineDirectors)
      .where(and(eq(videoStorylineDirectors.id, directorId), eq(videoStorylineDirectors.companyId, companyId)));
    if (!row) throw notFound("That director is not in this company (it may have been deleted).");
    return row;
  }

  /** What the views need to know about the company once, not per director. */
  async function viewContext(companyId: string) {
    const [entries, dirSettings, overview, keys, helperDefault, builtIn] = await Promise.all([
      models.list(companyId, { includeArchived: true }),
      models.getSettings(companyId),
      modelHealthService(db).overview(companyId).catch(() => ({ entries: [] as Array<{ entryId: string; status: string; lastCheckedAt: string | null }> })),
      helper.listKeyBindings(companyId),
      helper.resolveCompanyModelEntry(companyId, null),
      helper.builtInDefaultUsable(companyId),
    ]);
    return {
      entriesById: new Map(entries.map((e) => [e.id, e])),
      settings: dirSettings,
      healthById: new Map(overview.entries.map((h) => [h.entryId, h])),
      keys,
      helperDefault,
      builtIn,
    };
  }
  type ViewContext = Awaited<ReturnType<typeof viewContext>>;

  function keyStateFor(provider: LaneAProvider, ownKey: boolean, ctx: ViewContext): { state: ModelKeyState; ready: boolean; note: string } {
    const label = laneAProviderLabel(provider);
    if (ownKey) return { state: "set", ready: true, note: "Uses the key picked here." };
    if (provider === "local") return { state: "not_needed", ready: true, note: "Runs on the company's own model server; no key needed." };
    const helperKey = ctx.keys.get(provider);
    if (helperKey?.status === "ok") return { state: "set", ready: true, note: `Uses the helper's ${label} key (Company settings → General → Helper).` };
    if (provider === "anthropic" && !helperKey && (options.createModelClient || readAnthropicApiKey())) {
      return { state: "paperclip", ready: true, note: "Uses Paperclip's own Claude key." };
    }
    return {
      state: "missing",
      ready: false,
      note: `Needs a ${label} key: pick one here, or add one for the helper under Company settings → General → Helper.`,
    };
  }

  function modelView(entryId: string | null, keySecretId: string | null, ctx: ViewContext): VideoDirectorModelView | null {
    if (!entryId) return null;
    const entry = ctx.entriesById.get(entryId);
    if (!entry || entry.archivedAt) {
      return {
        entryId,
        name: null,
        provider: null,
        model: null,
        keySecretId,
        keyReady: false,
        keyNote: "This saved model is gone from Settings > Models. Pick another one.",
        canSeePictures: null,
        toolSupport: null,
        readiness: null,
      };
    }
    const provider = normalizeLaneAProvider(entry.provider);
    const key = keyStateFor(provider, Boolean(keySecretId), ctx);
    const readiness = modelPickerReadiness(readinessSetupFromDirectoryEntry(entry), {
      key: key.state,
      companyLocalBaseUrl: ctx.settings.localBaseUrl,
      gpuVramGb: ctx.settings.localGpuVramGb,
      blockedHosts: ctx.settings.openrouterBlockedHosts,
      health: readinessHealthReading(ctx.healthById.get(entry.id) as never),
    });
    return {
      entryId,
      name: entry.name,
      provider: entry.provider,
      model: entry.model,
      keySecretId,
      keyReady: key.ready,
      keyNote: key.note,
      canSeePictures: helperModelCanSeePictures({ provider, model: entry.model, specs: (entry.specs as Record<string, unknown> | null) ?? null }).canSee,
      toolSupport: savedModelToolSupport(entry as never, ctx.settings.openrouterBlockedHosts),
      readiness,
    };
  }

  function writerMode(row: DirectorRow, writing: VideoDirectorModelView | null, helperModel: VideoDirectorModelView | null, ctx: ViewContext) {
    let tools = writing?.toolSupport?.canUseTools ?? null;
    if (!row.writingEntryId) {
      // No writing model picked: the company's AI director model (the helper's default), else Paperclip's built-in Claude.
      const fallback = ctx.helperDefault;
      if (!fallback && !ctx.builtIn) {
        return {
          writerMode: "no_model" as const,
          writerModeNote:
            "This director has no writing model, and the company has no AI model for the helper either. A company owner or admin can pick a writing model for this director, or one for the helper under Company settings → General → Helper.",
        };
      }
      tools = fallback ? savedModelToolSupport(fallback as never, ctx.settings.openrouterBlockedHosts).canUseTools : true;
    } else if (!writing?.name) {
      return { writerMode: "no_model" as const, writerModeNote: "The writing model is gone from Settings > Models. Pick another one." };
    }
    if (tools) return { writerMode: "tools" as const, writerModeNote: "The writing model can use tools, so it looks things up itself." };
    if (helperModel?.name && helperModel.toolSupport?.canUseTools) {
      return { writerMode: "text_with_helper" as const, writerModeNote: VIDEO_DIRECTOR_TEXT_ONLY_EXPLANATION };
    }
    return { writerMode: "text_only" as const, writerModeNote: VIDEO_DIRECTOR_TEXT_ONLY_NO_HELPER_EXPLANATION };
  }

  function toView(row: DirectorRow, ctx: ViewContext): VideoStorylineDirector {
    const writing = modelView(row.writingEntryId, row.writingKeySecretId, ctx);
    const analysis = modelView(row.analysisEntryId, row.analysisKeySecretId, ctx);
    const helperModel = modelView(row.helperEntryId, row.helperKeySecretId, ctx);
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      description: row.description,
      builtinKey: row.builtinKey,
      writing,
      analysis,
      helper: helperModel,
      temperature: row.temperature,
      thinking: (row.thinking as VideoDirectorThinking | null) ?? null,
      styleInstructions: row.styleInstructions,
      defaultVideoProviderId: (row.defaultVideoProviderId as VideoStorylineProvider | null) ?? null,
      defaultVideoModel: row.defaultVideoModel,
      defaultLookId: row.defaultLookId,
      defaultShotSeconds: row.defaultShotSeconds,
      ...writerMode(row, writing, helperModel, ctx),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  async function list(companyId: string, opts: { canEdit: boolean }): Promise<VideoStorylineDirectorsView> {
    await ensureStarters(companyId);
    const [rows, ctx] = await Promise.all([listRows(companyId), viewContext(companyId)]);
    return { directors: rows.map((row) => toView(row, ctx)), canEdit: opts.canEdit };
  }

  async function get(companyId: string, directorId: string): Promise<VideoStorylineDirector> {
    const row = await getRow(companyId, directorId);
    return toView(row, await viewContext(companyId));
  }

  /** Every saved model and secret named must be this company's (a saved model also not archived). */
  async function assertReferences(companyId: string, input: Partial<CreateVideoStorylineDirectorInput>): Promise<void> {
    const entryFields = [
      ["writingEntryId", "writing model"],
      ["analysisEntryId", "picture analysis model"],
      ["helperEntryId", "helper model"],
    ] as const;
    for (const [field, label] of entryFields) {
      const id = input[field];
      if (!id) continue;
      const [entry] = await db
        .select({ id: modelDirectoryEntries.id, archivedAt: modelDirectoryEntries.archivedAt })
        .from(modelDirectoryEntries)
        .where(and(eq(modelDirectoryEntries.id, id), eq(modelDirectoryEntries.companyId, companyId)));
      if (!entry) throw unprocessable(`The ${label} is not one of this company's saved models. Pick one from the list.`);
      if (entry.archivedAt) throw unprocessable(`The ${label} is archived. Pick a saved model that is in use.`);
    }
    const secretFields = [
      ["writingKeySecretId", "writing model"],
      ["analysisKeySecretId", "picture analysis model"],
      ["helperKeySecretId", "helper model"],
    ] as const;
    for (const [field, label] of secretFields) {
      const id = input[field];
      if (!id) continue;
      const [secret] = await db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(and(eq(companySecrets.id, id), eq(companySecrets.companyId, companyId)));
      if (!secret) throw unprocessable(`The key picked for the ${label} is not one of this company's secrets. Pick one from the list.`);
    }
  }

  async function assertNameFree(companyId: string, name: string, exceptId: string | null): Promise<void> {
    const rows = await db
      .select({ id: videoStorylineDirectors.id })
      .from(videoStorylineDirectors)
      .where(and(eq(videoStorylineDirectors.companyId, companyId), sql`lower(${videoStorylineDirectors.name}) = lower(${name})`));
    if (rows.some((r) => r.id !== exceptId)) throw conflict(`There is already a director called "${name}". Pick another name.`);
  }

  async function create(companyId: string, input: CreateVideoStorylineDirectorInput, actor: VideoStorylineActor): Promise<VideoStorylineDirector> {
    await ensureStarters(companyId);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(videoStorylineDirectors)
      .where(eq(videoStorylineDirectors.companyId, companyId));
    if (count >= VIDEO_DIRECTOR_MAX_PER_COMPANY) {
      throw unprocessable(`A company can have at most ${VIDEO_DIRECTOR_MAX_PER_COMPANY} directors. Delete one you no longer use first.`);
    }
    await assertNameFree(companyId, input.name, null);
    await assertReferences(companyId, input);
    const now = new Date();
    const [row] = await db
      .insert(videoStorylineDirectors)
      .values({
        companyId,
        name: input.name,
        description: input.description,
        writingEntryId: input.writingEntryId,
        writingKeySecretId: input.writingKeySecretId,
        analysisEntryId: input.analysisEntryId,
        analysisKeySecretId: input.analysisKeySecretId,
        helperEntryId: input.helperEntryId,
        helperKeySecretId: input.helperKeySecretId,
        temperature: input.temperature,
        thinking: input.thinking,
        styleInstructions: input.styleInstructions,
        defaultVideoProviderId: input.defaultVideoProviderId,
        defaultVideoModel: input.defaultVideoModel,
        defaultLookId: input.defaultLookId,
        defaultShotSeconds: input.defaultShotSeconds,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("Director insert returned no row");
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_storyline.director_created",
      entityType: "video_storyline_director",
      entityId: row.id,
      details: { name: row.name },
    });
    return get(companyId, row.id);
  }

  async function update(companyId: string, directorId: string, input: UpdateVideoStorylineDirectorInput, actor: VideoStorylineActor): Promise<VideoStorylineDirector> {
    await getRow(companyId, directorId);
    if (input.name !== undefined) await assertNameFree(companyId, input.name, directorId);
    await assertReferences(companyId, input);
    const [row] = await db
      .update(videoStorylineDirectors)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(videoStorylineDirectors.id, directorId), eq(videoStorylineDirectors.companyId, companyId)))
      .returning();
    if (!row) throw notFound("That director is not in this company (it may have been deleted).");
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_storyline.director_updated",
      entityType: "video_storyline_director",
      entityId: directorId,
      details: { fields: Object.keys(input) },
    });
    return get(companyId, directorId);
  }

  async function remove(companyId: string, directorId: string, actor: VideoStorylineActor): Promise<void> {
    const row = await getRow(companyId, directorId);
    await db.delete(videoStorylineDirectors).where(and(eq(videoStorylineDirectors.id, directorId), eq(videoStorylineDirectors.companyId, companyId)));
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_storyline.director_deleted",
      entityType: "video_storyline_director",
      entityId: directorId,
      details: { name: row.name },
    });
  }

  /** PUT .../video-storylines/:id/director: which director writes this storyline. */
  async function setStorylineDirector(companyId: string, storylineId: string, directorId: string | null, actor: VideoStorylineActor) {
    const storyline = await storylines.getStorylineRow(companyId, storylineId);
    assertStorylineEditable(storyline);
    if (directorId) await getRow(companyId, directorId);
    await db
      .update(videoStorylines)
      .set({ directorId, updatedAt: new Date() })
      .where(and(eq(videoStorylines.id, storylineId), eq(videoStorylines.companyId, companyId)));
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "video_storyline.director_picked",
      entityType: "video_storyline",
      entityId: storylineId,
      details: { directorId },
    });
    return storylines.getStoryline(companyId, storylineId);
  }

  return { ensureStarters, list, get, getRow, create, update, remove, setStorylineDirector, viewContext, modelView };
}

/** The saved model a director role resolves to, for the writer: its own pick, never another company's. */
export type DirectorEntry = ModelDirectoryEntry;
