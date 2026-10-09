import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { videoScenes, videoShotRenderJobs, videoShots, videoStorylines, withCompanyScope } from "@paperclipai/db";
import {
  VIDEO_SCRIPT_SCENE_NOTES_MAX_LENGTH,
  VIDEO_STORYLINE_MAX_SCENES,
  VIDEO_STORYLINE_MAX_SHOTS,
  estimateVideoStorylineCostCents,
  formatVideoScriptCharacters,
  type ParsedVideoStorylineScript,
  type VideoScriptImportMode,
  type VideoScriptImportSummary,
  type VideoStorylineProvider,
  type CreateVideoSceneInput,
  type CreateVideoShotInput,
  type CreateVideoStorylineInput,
  type UpdateVideoSceneInput,
  type UpdateVideoShotInput,
  type UpdateVideoStorylineInput,
  type VideoStorylineProgress,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

/**
 * DUR-4127: CRUD for a video storyline's project/scene/shot tree. Render
 * orchestration (starting/advancing/re-rendering shots) lives in
 * video-storyline-render.ts; stitching in video-storyline-stitch.ts. This
 * file only ever touches rows whose status allows editing -- see
 * assertEditable -- so a shot that is mid-render or already delivered can
 * never be silently rewritten out from under the render tick.
 */

type StorylineRow = typeof videoStorylines.$inferSelect;
type SceneRow = typeof videoScenes.$inferSelect;
type ShotRow = typeof videoShots.$inferSelect;

export interface VideoStorylineActor {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export interface VideoStorylineSummary {
  id: string;
  companyId: string;
  projectId: string | null;
  title: string;
  status: string;
  providerId: string;
  model: string | null;
  budgetCapCents: number | null;
  spentCents: number;
  estimatedTotalCents: number | null;
  estimatedTotalSeconds: number | null;
  characterReferenceAssetIds: string[];
  /** Storyboard picture service / model / look (see VideoStorylinePictureSettings). */
  pictureSettings: { providerId?: string | null; model?: string | null; lookId?: string | null };
  finalObjectKey: string | null;
  finalByteSize: number | null;
  finalDurationSeconds: number | null;
  stitchBlockedReason: string | null;
  errorMessage: string | null;
  qualityCheckIssues: Array<{ code: string; message: string; shotIndex: number | null; timeSeconds: number | null }>;
  qualityCheckedAt: string | null;
  defaultTransition: string;
  defaultTransitionDurationMs: number;
  musicAssetId: string | null;
  musicSourceKey: string | null;
  musicVolumeDb: number;
  createdAt: string;
  updatedAt: string;
}

export interface VideoSceneSummary {
  id: string;
  storylineId: string;
  orderIndex: number;
  title: string;
  notes: string | null;
  createdAt: string;
}

export interface VideoShotSummary {
  id: string;
  storylineId: string;
  sceneId: string;
  orderIndex: number;
  prompt: string;
  cameraNotes: string | null;
  durationSeconds: number;
  lookReferenceAssetIds: string[];
  status: string;
  providerId: string | null;
  model: string | null;
  resultObjectKey: string | null;
  resultByteSize: number | null;
  estimatedCostCents: number | null;
  actualCostCents: number | null;
  attempt: number;
  errorMessage: string | null;
  transitionIn: string | null;
  previewObjectKey: string | null;
  previewContentType: string | null;
  previewByteSize: number | null;
  previewGeneratedAt: string | null;
  // DUR-4327: AI director proposal + restorable history (see video-storyline-director-proposals.ts).
  proposedPrompt: string | null;
  proposedCameraNotes: string | null;
  proposedDurationSeconds: number | null;
  proposedTransitionIn: string | null;
  proposalStatus: string | null;
  proposalConversationId: string | null;
  promptHistory: Array<{ prompt: string; cameraNotes: string | null; durationSeconds: number; transitionIn: string | null; replacedAt: string }>;
  storyboardStatus: string;
  /** This shot's own look for its storyboard picture: a look id, "none", or null (the storyline's). */
  pictureLookId: string | null;
  stillObjectKey: string | null;
  stillContentType: string | null;
  stillByteSize: number | null;
  stillGeneratedAt: string | null;
  stillEstimatedCostCents: number | null;
  stillActualCostCents: number | null;
  createdAt: string;
}

function toStorylineSummary(row: StorylineRow): VideoStorylineSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    providerId: row.providerId,
    model: row.model,
    budgetCapCents: row.budgetCapCents,
    spentCents: row.spentCents,
    estimatedTotalCents: row.estimatedTotalCents,
    estimatedTotalSeconds: row.estimatedTotalSeconds,
    characterReferenceAssetIds: row.characterReferenceAssetIds,
    pictureSettings: row.pictureSettings ?? {},
    finalObjectKey: row.finalObjectKey,
    finalByteSize: row.finalByteSize,
    finalDurationSeconds: row.finalDurationSeconds,
    stitchBlockedReason: row.stitchBlockedReason,
    errorMessage: row.errorMessage,
    qualityCheckIssues: row.qualityCheckIssues,
    qualityCheckedAt: iso(row.qualityCheckedAt),
    defaultTransition: row.defaultTransition,
    defaultTransitionDurationMs: row.defaultTransitionDurationMs,
    musicAssetId: row.musicAssetId,
    musicSourceKey: row.musicSourceKey,
    musicVolumeDb: row.musicVolumeDb,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSceneSummary(row: SceneRow): VideoSceneSummary {
  return {
    id: row.id,
    storylineId: row.storylineId,
    orderIndex: row.orderIndex,
    title: row.title,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

function toShotSummary(row: ShotRow): VideoShotSummary {
  return {
    id: row.id,
    storylineId: row.storylineId,
    sceneId: row.sceneId,
    orderIndex: row.orderIndex,
    prompt: row.prompt,
    cameraNotes: row.cameraNotes,
    durationSeconds: row.durationSeconds,
    lookReferenceAssetIds: row.lookReferenceAssetIds,
    status: row.status,
    providerId: row.providerId,
    model: row.model,
    resultObjectKey: row.resultObjectKey,
    resultByteSize: row.resultByteSize,
    estimatedCostCents: row.estimatedCostCents,
    actualCostCents: row.actualCostCents,
    attempt: row.attempt,
    errorMessage: row.errorMessage,
    transitionIn: row.transitionIn,
    previewObjectKey: row.previewObjectKey,
    previewContentType: row.previewContentType,
    previewByteSize: row.previewByteSize,
    previewGeneratedAt: iso(row.previewGeneratedAt),
    proposedPrompt: row.proposedPrompt,
    proposedCameraNotes: row.proposedCameraNotes,
    proposedDurationSeconds: row.proposedDurationSeconds,
    proposedTransitionIn: row.proposedTransitionIn,
    proposalStatus: row.proposalStatus,
    proposalConversationId: row.proposalConversationId,
    promptHistory: row.promptHistory,
    storyboardStatus: row.storyboardStatus,
    pictureLookId: row.pictureLookId,
    stillObjectKey: row.stillObjectKey,
    stillContentType: row.stillContentType,
    stillByteSize: row.stillByteSize,
    stillGeneratedAt: iso(row.stillGeneratedAt),
    stillEstimatedCostCents: row.stillEstimatedCostCents,
    stillActualCostCents: row.stillActualCostCents,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A storyline being rendered/stitched owns its own shot tree via the render tick; hand edits mid-flight would race it. */
// "cancelled" is editable too: cancelling stops spending, it must not leave the storyline stuck forever.
const EDITABLE_STORYLINE_STATUSES = new Set(["draft", "estimated", "paused", "failed", "cancelled"]);

export function assertStorylineEditable(row: StorylineRow) {
  if (!EDITABLE_STORYLINE_STATUSES.has(row.status)) {
    throw conflict(
      `This storyline is ${row.status.replace(/_/g, " ")} and cannot be edited right now. Pause or wait for it to finish first.`,
    );
  }
}

function activityActor(actor: VideoStorylineActor) {
  return {
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
  } as const;
}


/** Temporary offset used while renumbering a storyline's shots (far above any real position). */
const SHOT_ORDER_PARK_OFFSET = 1_000_000;

/**
 * The transaction handle withCompanyScope hands its callback. Every
 * multi-statement write in this file goes through withCompanyScope(db, ...)
 * -- NEVER db.transaction(): routes/video-storylines.ts builds this service
 * on createRequestScopedDb's proxy, which refuses .transaction() outright
 * (that is exactly what made POST .../shots 500 on every real request).
 * withCompanyScope reuses the request's reserved connection when one is
 * live, uses the scheduler's bypass connection inside a tick, and opens its
 * own pooled transaction when there is no scope at all (scripts/tests).
 */
export type ScopedTx = Parameters<Parameters<typeof withCompanyScope>[2]>[0];

/**
 * The storyline's shots in play order: scene by scene (scene orderIndex),
 * then by each shot's current orderIndex within its scene. When `move` is
 * given, that one shot is taken out and put back inside its (current) scene
 * at the storyline-wide position `move.targetIndex` (clamped to that
 * scene's block), or at the end of its scene when no target is given.
 */
async function computeShotOrder(
  tx: ScopedTx,
  storylineId: string,
  move?: { shotId: string; targetIndex?: number },
): Promise<string[]> {
  const sceneRows = await tx
    .select({ id: videoScenes.id, orderIndex: videoScenes.orderIndex })
    .from(videoScenes)
    .where(eq(videoScenes.storylineId, storylineId))
    .orderBy(asc(videoScenes.orderIndex));
  const shotRows = await tx
    .select({ id: videoShots.id, sceneId: videoShots.sceneId, orderIndex: videoShots.orderIndex })
    .from(videoShots)
    .where(eq(videoShots.storylineId, storylineId))
    .orderBy(asc(videoShots.orderIndex));
  const byScene = new Map<string, string[]>(sceneRows.map((scene) => [scene.id, []]));
  let movedSceneId: string | null = null;
  for (const shot of shotRows) {
    if (move && shot.id === move.shotId) {
      movedSceneId = shot.sceneId;
      continue;
    }
    byScene.get(shot.sceneId)?.push(shot.id);
  }
  const ordered: string[] = [];
  for (const scene of sceneRows) {
    const block = byScene.get(scene.id) ?? [];
    if (move && scene.id === movedSceneId) {
      const blockStart = ordered.length;
      const position =
        move.targetIndex === undefined
          ? block.length
          : Math.min(block.length, Math.max(0, move.targetIndex - blockStart));
      block.splice(position, 0, move.shotId);
    }
    ordered.push(...block);
  }
  return ordered;
}

/** Writes 0..n-1 positions for `orderedIds`, parking every shot first so the unique (storyline, order) index never sees a clash mid-update. */
async function applyShotOrder(tx: ScopedTx, storylineId: string, orderedIds: readonly string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  await tx
    .update(videoShots)
    .set({ orderIndex: sql`${videoShots.orderIndex} + ${SHOT_ORDER_PARK_OFFSET}` })
    .where(eq(videoShots.storylineId, storylineId));
  const values = sql.join(
    orderedIds.map((id, index) => sql`(${id}::uuid, ${index}::int)`),
    sql`, `,
  );
  await tx.execute(sql`
    UPDATE ${videoShots} AS s
    SET order_index = v.rn
    FROM (VALUES ${values}) AS v(id, rn)
    WHERE s.id = v.id AND s.storyline_id = ${storylineId}
  `);
}

async function renumberShots(tx: ScopedTx, storylineId: string, move?: { shotId: string; targetIndex?: number }): Promise<void> {
  await applyShotOrder(tx, storylineId, await computeShotOrder(tx, storylineId, move));
}

/** Shot states that mean money was spent on (or is being spent on) a shot -- "replace" imports refuse to throw these away. */
function shotHasPaidWork(shot: ShotRow): boolean {
  return (
    shot.status === "done" ||
    shot.status === "rendering" ||
    shot.status === "queued" ||
    shot.resultObjectKey !== null ||
    (shot.actualCostCents ?? 0) > 0 ||
    shot.stillObjectKey !== null ||
    (shot.stillActualCostCents ?? 0) > 0 ||
    // Set before a storyboard still's paid image call starts (see
    // video-storyline-stills.ts's generateStill), so a still in flight
    // counts as paid work too.
    (shot.stillEstimatedCostCents ?? 0) > 0 ||
    shot.previewObjectKey !== null
  );
}

/**
 * Security review (replace-import TOCTOU): locks a storyline's row for the
 * rest of the caller's transaction (SELECT ... FOR UPDATE, by id AND
 * company). Every path that starts paid work (render start/re-render,
 * storyboard still, preview) and the "replace" import take this same lock
 * before their final check-and-write, so a replace can never delete scenes
 * a render or still has just started on.
 */
export async function lockStorylineRow(tx: ScopedTx, companyId: string, storylineId: string): Promise<StorylineRow> {
  const [row] = await tx
    .select()
    .from(videoStorylines)
    .where(and(eq(videoStorylines.id, storylineId), eq(videoStorylines.companyId, companyId)))
    .for("update");
  if (!row) throw notFound("Video storyline not found");
  return row;
}

const REPLACE_REFUSED_MESSAGE =
  "This storyline already has rendered or paid-for shots (videos, storyboard pictures or previews), so it can't be replaced. Import with \"Add to the end\" instead, or start a new storyline from this script.";

/** Refuses a "replace" import once anything was rendered, queued or paid for (shots, stills, previews, spend, or any render job). */
async function assertNothingPaidToReplace(executor: Db | ScopedTx, storyline: StorylineRow): Promise<void> {
  if (storyline.spentCents > 0) throw conflict(REPLACE_REFUSED_MESSAGE);
  const shots = await executor.select().from(videoShots).where(eq(videoShots.storylineId, storyline.id));
  if (shots.some(shotHasPaidWork)) throw conflict(REPLACE_REFUSED_MESSAGE);
  const [job] = await executor
    .select({ id: videoShotRenderJobs.id })
    .from(videoShotRenderJobs)
    .where(eq(videoShotRenderJobs.storylineId, storyline.id))
    .limit(1);
  if (job) throw conflict(REPLACE_REFUSED_MESSAGE);
}

export function videoStorylineService(db: Db) {
  async function getStorylineRow(companyId: string, storylineId: string): Promise<StorylineRow> {
    const [row] = await db
      .select()
      .from(videoStorylines)
      .where(and(eq(videoStorylines.id, storylineId), eq(videoStorylines.companyId, companyId)));
    if (!row) throw notFound("Video storyline not found");
    return row;
  }

  async function getSceneRow(companyId: string, storylineId: string, sceneId: string): Promise<SceneRow> {
    const [row] = await db
      .select()
      .from(videoScenes)
      .where(and(eq(videoScenes.id, sceneId), eq(videoScenes.storylineId, storylineId), eq(videoScenes.companyId, companyId)));
    if (!row) throw notFound("Scene not found");
    return row;
  }

  async function getShotRow(companyId: string, storylineId: string, shotId: string): Promise<ShotRow> {
    const [row] = await db
      .select()
      .from(videoShots)
      .where(and(eq(videoShots.id, shotId), eq(videoShots.storylineId, storylineId), eq(videoShots.companyId, companyId)));
    if (!row) throw notFound("Shot not found");
    return row;
  }

  async function listStorylines(companyId: string): Promise<VideoStorylineSummary[]> {
    const rows = await db
      .select()
      .from(videoStorylines)
      .where(eq(videoStorylines.companyId, companyId))
      .orderBy(asc(videoStorylines.createdAt));
    return rows.map(toStorylineSummary);
  }

  async function getStoryline(companyId: string, storylineId: string): Promise<VideoStorylineSummary> {
    return toStorylineSummary(await getStorylineRow(companyId, storylineId));
  }

  async function listScenes(companyId: string, storylineId: string): Promise<VideoSceneSummary[]> {
    await getStorylineRow(companyId, storylineId);
    const rows = await db
      .select()
      .from(videoScenes)
      .where(and(eq(videoScenes.storylineId, storylineId), eq(videoScenes.companyId, companyId)))
      .orderBy(asc(videoScenes.orderIndex));
    return rows.map(toSceneSummary);
  }

  async function listShots(companyId: string, storylineId: string): Promise<VideoShotSummary[]> {
    await getStorylineRow(companyId, storylineId);
    const rows = await db
      .select()
      .from(videoShots)
      .where(and(eq(videoShots.storylineId, storylineId), eq(videoShots.companyId, companyId)))
      .orderBy(asc(videoShots.orderIndex));
    return rows.map(toShotSummary);
  }

  async function createStoryline(
    companyId: string,
    input: CreateVideoStorylineInput,
    actor: VideoStorylineActor,
  ): Promise<VideoStorylineSummary> {
    const now = new Date();
    const [row] = await db
      .insert(videoStorylines)
      .values({
        companyId,
        projectId: input.projectId,
        title: input.title,
        providerId: input.providerId,
        model: input.model,
        budgetCapCents: input.budgetCapCents,
        characterReferenceAssetIds: input.characterReferenceAssetIds,
        defaultTransition: input.defaultTransition,
        defaultTransitionDurationMs: input.defaultTransitionDurationMs,
        musicAssetId: input.musicAssetId,
        musicSourceKey: input.musicSourceKey,
        musicVolumeDb: input.musicVolumeDb,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("Video storyline insert returned no row");
    await logActivity(db, {
      companyId,
      ...activityActor(actor),
      action: "video_storyline.created",
      entityType: "video_storyline",
      entityId: row.id,
      details: { title: row.title, providerId: row.providerId },
    });
    return toStorylineSummary(row);
  }

  async function updateStoryline(
    companyId: string,
    storylineId: string,
    input: UpdateVideoStorylineInput,
    actor: VideoStorylineActor,
  ): Promise<VideoStorylineSummary> {
    const existing = await getStorylineRow(companyId, storylineId);
    assertStorylineEditable(existing);
    // Mutual exclusivity (video_storylines_music_source_exclusive_check) is
    // enforced against the FULL resulting row, not just this payload: setting
    // one music field must clear the other's existing stored value, or a
    // request that only touches musicAssetId could collide with a
    // musicSourceKey left over from an earlier update.
    const settingMusicAssetId = input.musicAssetId !== undefined && input.musicAssetId !== null;
    const settingMusicSourceKey = input.musicSourceKey !== undefined && input.musicSourceKey !== null;
    const [row] = await db
      .update(videoStorylines)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.budgetCapCents !== undefined ? { budgetCapCents: input.budgetCapCents } : {}),
        ...(input.characterReferenceAssetIds !== undefined
          ? { characterReferenceAssetIds: input.characterReferenceAssetIds }
          : {}),
        ...(input.defaultTransition !== undefined ? { defaultTransition: input.defaultTransition } : {}),
        ...(input.defaultTransitionDurationMs !== undefined
          ? { defaultTransitionDurationMs: input.defaultTransitionDurationMs }
          : {}),
        ...(input.musicAssetId !== undefined ? { musicAssetId: input.musicAssetId } : {}),
        ...(input.musicSourceKey !== undefined ? { musicSourceKey: input.musicSourceKey } : {}),
        ...(settingMusicAssetId && input.musicSourceKey === undefined ? { musicSourceKey: null } : {}),
        ...(settingMusicSourceKey && input.musicAssetId === undefined ? { musicAssetId: null } : {}),
        ...(input.musicVolumeDb !== undefined ? { musicVolumeDb: input.musicVolumeDb } : {}),
        ...(input.pictureSettings !== undefined ? { pictureSettings: input.pictureSettings } : {}),
        updatedAt: new Date(),
      })
      .where(eq(videoStorylines.id, storylineId))
      .returning();
    if (!row) throw new Error("Video storyline update returned no row");
    // A different provider/model changes what each clip costs (and which
    // clip lengths are rendered), so the cached estimate must follow.
    const refreshed = input.providerId !== undefined || input.model !== undefined ? await recomputeEstimate(companyId, storylineId) : null;
    await logActivity(db, {
      companyId,
      ...activityActor(actor),
      action: "video_storyline.updated",
      entityType: "video_storyline",
      entityId: row.id,
      details: { fields: Object.keys(input) },
    });
    return refreshed ?? toStorylineSummary(row);
  }

  async function deleteStoryline(companyId: string, storylineId: string, actor: VideoStorylineActor): Promise<void> {
    const existing = await getStorylineRow(companyId, storylineId);
    assertStorylineEditable(existing);
    await db.delete(videoStorylines).where(eq(videoStorylines.id, storylineId));
    await logActivity(db, {
      companyId,
      ...activityActor(actor),
      action: "video_storyline.deleted",
      entityType: "video_storyline",
      entityId: storylineId,
      details: { title: existing.title },
    });
  }

  async function createScene(
    companyId: string,
    storylineId: string,
    input: CreateVideoSceneInput,
    actor: VideoStorylineActor,
  ): Promise<VideoSceneSummary> {
    const storyline = await getStorylineRow(companyId, storylineId);
    assertStorylineEditable(storyline);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(videoScenes)
      .where(eq(videoScenes.storylineId, storylineId));
    if (count >= VIDEO_STORYLINE_MAX_SCENES) {
      throw unprocessable(`A storyline may have at most ${VIDEO_STORYLINE_MAX_SCENES} scenes.`);
    }
    const now = new Date();
    const row = await db
      .insert(videoScenes)
      .values({
        companyId,
        storylineId,
        orderIndex: input.orderIndex,
        title: input.title ?? "",
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0])
      .catch((err) => {
        throw isUniqueViolation(err) ? conflict(`A scene already exists at position ${input.orderIndex}.`) : err;
      });
    if (!row) throw new Error("Video scene insert returned no row");
    await logActivity(db, {
      companyId,
      ...activityActor(actor),
      action: "video_scene.created",
      entityType: "video_scene",
      entityId: row.id,
      details: { storylineId, orderIndex: row.orderIndex },
    });
    return toSceneSummary(row);
  }

  async function updateScene(
    companyId: string,
    storylineId: string,
    sceneId: string,
    input: UpdateVideoSceneInput,
    actor: VideoStorylineActor,
  ): Promise<VideoSceneSummary> {
    const storyline = await getStorylineRow(companyId, storylineId);
    assertStorylineEditable(storyline);
    await getSceneRow(companyId, storylineId, sceneId);
    const row = await db
      .update(videoScenes)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.orderIndex !== undefined ? { orderIndex: input.orderIndex } : {}),
        updatedAt: new Date(),
      })
      .where(eq(videoScenes.id, sceneId))
      .returning()
      .then((rows) => rows[0])
      .catch((err) => {
        throw isUniqueViolation(err) ? conflict(`A scene already exists at position ${input.orderIndex}.`) : err;
      });
    if (!row) throw new Error("Video scene update returned no row");
    if (input.orderIndex !== undefined) {
      // Play order is scene by scene, so moving a scene moves its shots too.
      await withCompanyScope(db, companyId, (tx) => renumberShots(tx, storylineId));
    }
    await logActivity(db, {
      companyId,
      ...activityActor(actor),
      action: "video_scene.updated",
      entityType: "video_scene",
      entityId: row.id,
      details: { fields: Object.keys(input) },
    });
    return toSceneSummary(row);
  }

  async function deleteScene(companyId: string, storylineId: string, sceneId: string, actor: VideoStorylineActor): Promise<void> {
    const storyline = await getStorylineRow(companyId, storylineId);
    assertStorylineEditable(storyline);
    await getSceneRow(companyId, storylineId, sceneId);
    await withCompanyScope(db, companyId, async (tx) => {
      await tx.delete(videoScenes).where(eq(videoScenes.id, sceneId));
      await renumberShots(tx, storylineId);
    });
    await recomputeEstimate(companyId, storylineId);
    await logActivity(db, {
      companyId,
      ...activityActor(actor),
      action: "video_scene.deleted",
      entityType: "video_scene",
      entityId: sceneId,
      details: { storylineId },
    });
  }

  async function createShot(
    companyId: string,
    storylineId: string,
    input: CreateVideoShotInput,
    actor: VideoStorylineActor,
  ): Promise<VideoShotSummary> {
    const storyline = await getStorylineRow(companyId, storylineId);
    assertStorylineEditable(storyline);
    await getSceneRow(companyId, storylineId, input.sceneId);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(videoShots)
      .where(eq(videoShots.storylineId, storylineId));
    if (count >= VIDEO_STORYLINE_MAX_SHOTS) {
      throw unprocessable(`A storyline may have at most ${VIDEO_STORYLINE_MAX_SHOTS} shots.`);
    }
    const now = new Date();
    // A shot's orderIndex is its place in the whole storyline (scene by scene),
    // so the server decides it: the new shot goes at the end of its own scene and
    // every shot is renumbered 0..n-1 in scene order. The client's orderIndex is
    // ignored (the board UI used to send the position within the scene, which made
    // the first shot of every scene after the first collide at 0).
    const row = await withCompanyScope(db, companyId, async (tx) => {
      const inserted = await tx
        .insert(videoShots)
        .values({
          companyId,
          storylineId,
          sceneId: input.sceneId,
          // Above every real position (they are all < SHOT_ORDER_PARK_OFFSET),
          // so it can never clash and sorts last within its scene.
          orderIndex: SHOT_ORDER_PARK_OFFSET * 2,
          prompt: input.prompt,
          cameraNotes: input.cameraNotes,
          durationSeconds: input.durationSeconds,
          lookReferenceAssetIds: input.lookReferenceAssetIds,
          transitionIn: input.transitionIn,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);
      if (!inserted) throw new Error("Video shot insert returned no row");
      await renumberShots(tx, storylineId);
      const [final] = await tx.select().from(videoShots).where(eq(videoShots.id, inserted.id));
      return final;
    });
    if (!row) throw new Error("Video shot insert returned no row");
    await recomputeEstimate(companyId, storylineId);
    await logActivity(db, {
      companyId,
      ...activityActor(actor),
      action: "video_shot.created",
      entityType: "video_shot",
      entityId: row.id,
      details: { storylineId, sceneId: row.sceneId, orderIndex: row.orderIndex },
    });
    return toShotSummary(row);
  }

  async function updateShot(
    companyId: string,
    storylineId: string,
    shotId: string,
    input: UpdateVideoShotInput,
    actor: VideoStorylineActor,
  ): Promise<VideoShotSummary> {
    const storyline = await getStorylineRow(companyId, storylineId);
    assertStorylineEditable(storyline);
    await getShotRow(companyId, storylineId, shotId);
    if (input.sceneId !== undefined) await getSceneRow(companyId, storylineId, input.sceneId);
    // DUR-4317/DUR-4320: editing anything that changes what the shot's
    // still should look like (the prompt, camera notes, or which look
    // references it uses) invalidates any existing approval/drop AND the
    // still itself -- it must be regenerated and re-reviewed before this
    // shot can render again. durationSeconds/orderIndex/sceneId/
    // transitionIn don't affect the still's composition, so they leave
    // storyboardStatus/the still columns alone.
    const touchesStillContent = input.prompt !== undefined || input.cameraNotes !== undefined || input.lookReferenceAssetIds !== undefined;
    const fields = {
      ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.cameraNotes !== undefined ? { cameraNotes: input.cameraNotes } : {}),
      ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
      ...(input.lookReferenceAssetIds !== undefined ? { lookReferenceAssetIds: input.lookReferenceAssetIds } : {}),
      ...(input.transitionIn !== undefined ? { transitionIn: input.transitionIn } : {}),
      // A different look only changes the NEXT picture made for this shot; the
      // current picture and its approval stay until the person remakes it.
      ...(input.pictureLookId !== undefined ? { pictureLookId: input.pictureLookId } : {}),
      ...(touchesStillContent
        ? {
            storyboardStatus: "pending" as const,
            stillProvider: null,
            stillObjectKey: null,
            stillContentType: null,
            stillByteSize: null,
            stillSha256: null,
            stillGeneratedAt: null,
            stillEstimatedCostCents: null,
            stillActualCostCents: null,
          }
        : {}),
      updatedAt: new Date(),
    };
    // A move (new position and/or new scene) renumbers the whole storyline
    // in one transaction: orderIndex is the shot's place in the whole
    // storyline (scene by scene), so it is never written raw -- that used
    // to 409 on any occupied position and let scene order and play order
    // drift apart.
    const moves = input.orderIndex !== undefined || input.sceneId !== undefined;
    const row = moves
      ? await withCompanyScope(db, companyId, async (tx) => {
          await tx.update(videoShots).set(fields).where(eq(videoShots.id, shotId));
          await renumberShots(tx, storylineId, { shotId, targetIndex: input.orderIndex });
          const [final] = await tx.select().from(videoShots).where(eq(videoShots.id, shotId));
          return final;
        })
      : await db
          .update(videoShots)
          .set(fields)
          .where(eq(videoShots.id, shotId))
          .returning()
          .then((rows) => rows[0]);
    if (!row) throw new Error("Video shot update returned no row");
    if (input.durationSeconds !== undefined) await recomputeEstimate(companyId, storylineId);
    await logActivity(db, {
      companyId,
      ...activityActor(actor),
      action: "video_shot.updated",
      entityType: "video_shot",
      entityId: row.id,
      details: { fields: Object.keys(input) },
    });
    return toShotSummary(row);
  }

  async function deleteShot(companyId: string, storylineId: string, shotId: string, actor: VideoStorylineActor): Promise<void> {
    const storyline = await getStorylineRow(companyId, storylineId);
    assertStorylineEditable(storyline);
    await getShotRow(companyId, storylineId, shotId);
    await withCompanyScope(db, companyId, async (tx) => {
      await tx.delete(videoShots).where(eq(videoShots.id, shotId));
      await renumberShots(tx, storylineId);
    });
    await recomputeEstimate(companyId, storylineId);
    await logActivity(db, {
      companyId,
      ...activityActor(actor),
      action: "video_shot.deleted",
      entityType: "video_shot",
      entityId: shotId,
      details: { storylineId },
    });
  }

  /**
   * Refreshes the cached estimatedTotalCents/Seconds shown before a render
   * starts -- see POST .../estimate for the same computation exposed
   * directly. DUR-4317/DUR-4320: dropped shots are excluded, same as
   * video-storyline-render.ts's startRender does for its own live estimate
   * -- a dropped shot never renders, so it should never count toward "what
   * will this cost."
   */
  async function recomputeEstimate(companyId: string, storylineId: string): Promise<VideoStorylineSummary> {
    const storyline = await getStorylineRow(companyId, storylineId);
    const allShots = await db
      .select({ durationSeconds: videoShots.durationSeconds, storyboardStatus: videoShots.storyboardStatus })
      .from(videoShots)
      .where(eq(videoShots.storylineId, storylineId));
    const shots = allShots.filter((s) => s.storyboardStatus !== "dropped");
    const estimate = estimateVideoStorylineCostCents(shots, storyline.providerId as VideoStorylineProvider, { model: storyline.model });
    const [row] = await db
      .update(videoStorylines)
      .set({
        estimatedTotalCents: estimate.estimatedTotalCents,
        estimatedTotalSeconds: estimate.totalSeconds,
        status: storyline.status === "draft" && allShots.length > 0 ? "estimated" : storyline.status,
        updatedAt: new Date(),
      })
      .where(eq(videoStorylines.id, storylineId))
      .returning();
    return toStorylineSummary(row!);
  }

  function summarizeScript(
    script: ParsedVideoStorylineScript,
    providerId: VideoStorylineProvider,
    model: string | null,
    extra: { dryRun: boolean; mode: VideoScriptImportMode | "new"; storylineId: string | null },
  ): VideoScriptImportSummary {
    const allShots = script.scenes.flatMap((scene) => scene.shots);
    const estimate = estimateVideoStorylineCostCents(allShots, providerId, { model });
    return {
      ...extra,
      sceneCount: script.sceneCount,
      shotCount: script.shotCount,
      totalSeconds: script.totalSeconds,
      billedSeconds: estimate.totalSeconds,
      estimatedCostCents: estimate.estimatedTotalCents,
      characterCount: script.characters.length,
    };
  }

  /** The first imported scene's notes, with the script's character sheet on top (the storyline has no notes field of its own). */
  function firstSceneNotes(script: ParsedVideoStorylineScript, sceneNotes: string | null): string | null {
    const sheet = formatVideoScriptCharacters(script.characters);
    if (!sheet) return sceneNotes;
    const combined = sceneNotes ? `${sheet}\n\n${sceneNotes}` : sheet;
    if (combined.length > VIDEO_SCRIPT_SCENE_NOTES_MAX_LENGTH) {
      throw unprocessable(
        `The character list plus scene 1's notes come to ${combined.length.toLocaleString("en-US")} characters; scene notes can hold at most ${VIDEO_SCRIPT_SCENE_NOTES_MAX_LENGTH.toLocaleString("en-US")}. Shorten the character descriptions or scene 1's notes.`,
      );
    }
    return combined;
  }

  /** Writes a script's scenes and shots into a storyline inside one transaction (all or nothing). */
  async function writeScript(
    tx: ScopedTx,
    companyId: string,
    storylineId: string,
    script: ParsedVideoStorylineScript,
    mode: VideoScriptImportMode,
  ): Promise<void> {
    if (mode === "replace") {
      // Shots go with their scenes (ON DELETE CASCADE).
      await tx.delete(videoScenes).where(eq(videoScenes.storylineId, storylineId));
    }
    const [{ maxScene }] = await tx
      .select({ maxScene: sql<number>`coalesce(max(${videoScenes.orderIndex}), -1)::int` })
      .from(videoScenes)
      .where(eq(videoScenes.storylineId, storylineId));
    const now = new Date();
    let parkedPosition = SHOT_ORDER_PARK_OFFSET * 2;
    for (const [index, scene] of script.scenes.entries()) {
      const [sceneRow] = await tx
        .insert(videoScenes)
        .values({
          companyId,
          storylineId,
          orderIndex: maxScene + 1 + index,
          title: scene.title,
          notes: index === 0 ? firstSceneNotes(script, scene.notes) : scene.notes,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!sceneRow) throw new Error("Video scene insert returned no row");
      if (scene.shots.length === 0) continue;
      await tx.insert(videoShots).values(
        scene.shots.map((shot) => ({
          companyId,
          storylineId,
          sceneId: sceneRow.id,
          // Unique, above every real position; renumberShots below puts
          // everything at 0..n-1 in scene order.
          orderIndex: parkedPosition++,
          prompt: shot.prompt,
          cameraNotes: shot.cameraNotes,
          durationSeconds: shot.durationSeconds,
          lookReferenceAssetIds: [],
          transitionIn: shot.transitionIn,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    await renumberShots(tx, storylineId);
  }

  /**
   * POST .../video-storylines/:storylineId/import. "append" adds the
   * script's scenes after the existing ones; "replace" swaps the whole
   * scene/shot tree, and is refused once anything has been rendered or
   * paid for (renders, storyboard pictures, previews) so no paid work is
   * ever silently thrown away.
   */
  async function importScript(
    companyId: string,
    storylineId: string,
    script: ParsedVideoStorylineScript,
    mode: VideoScriptImportMode,
    actor: VideoStorylineActor,
    options: { dryRun?: boolean } = {},
  ): Promise<VideoScriptImportSummary> {
    const storyline = await getStorylineRow(companyId, storylineId);
    assertStorylineEditable(storyline);
    const existingShots = await db.select().from(videoShots).where(eq(videoShots.storylineId, storylineId));
    // Checked here too so a dry run reports it; re-checked under the row
    // lock below before anything is deleted.
    if (mode === "replace") await assertNothingPaidToReplace(db, storyline);
    const keptShots = mode === "replace" ? 0 : existingShots.length;
    if (keptShots + script.shotCount > VIDEO_STORYLINE_MAX_SHOTS) {
      throw unprocessable(
        `This storyline already has ${keptShots} shots; adding ${script.shotCount} more would go over the limit of ${VIDEO_STORYLINE_MAX_SHOTS.toLocaleString("en-US")} shots.`,
      );
    }
    const [{ sceneCount }] = await db
      .select({ sceneCount: sql<number>`count(*)::int` })
      .from(videoScenes)
      .where(eq(videoScenes.storylineId, storylineId));
    const keptScenes = mode === "replace" ? 0 : sceneCount;
    if (keptScenes + script.sceneCount > VIDEO_STORYLINE_MAX_SCENES) {
      throw unprocessable(
        `This storyline already has ${keptScenes} scenes; adding ${script.sceneCount} more would go over the limit of ${VIDEO_STORYLINE_MAX_SCENES} scenes.`,
      );
    }
    // Checked up front so a dry run reports it too.
    firstSceneNotes(script, script.scenes[0]?.notes ?? null);
    const summary = summarizeScript(script, storyline.providerId as VideoStorylineProvider, storyline.model, {
      dryRun: options.dryRun === true,
      mode,
      storylineId,
    });
    if (options.dryRun) return summary;

    await withCompanyScope(db, companyId, async (tx) => {
      // Security review (TOCTOU): the checks above ran outside this
      // transaction, so a render, still or preview could have started
      // since. Lock the storyline row (the same lock every paid-work start
      // path takes) and check again before deleting anything.
      const locked = await lockStorylineRow(tx, companyId, storylineId);
      assertStorylineEditable(locked);
      if (mode === "replace") await assertNothingPaidToReplace(tx, locked);
      await writeScript(tx, companyId, storylineId, script, mode);
    });
    await recomputeEstimate(companyId, storylineId);
    await logActivity(db, {
      companyId,
      ...activityActor(actor),
      action: "video_storyline.script_imported",
      entityType: "video_storyline",
      entityId: storylineId,
      details: { mode, sceneCount: script.sceneCount, shotCount: script.shotCount, characterCount: script.characters.length },
    });
    return summary;
  }

  /** POST .../video-storylines/import: a new storyline plus all its scenes and shots, in one transaction. */
  async function createStorylineFromScript(
    companyId: string,
    input: { title: string; providerId: VideoStorylineProvider; model: string | null; budgetCapCents: number | null },
    script: ParsedVideoStorylineScript,
    actor: VideoStorylineActor,
    options: { dryRun?: boolean } = {},
  ): Promise<VideoScriptImportSummary & { storyline: VideoStorylineSummary | null }> {
    firstSceneNotes(script, script.scenes[0]?.notes ?? null);
    if (options.dryRun) {
      return { ...summarizeScript(script, input.providerId, input.model, { dryRun: true, mode: "new", storylineId: null }), storyline: null };
    }
    const now = new Date();
    const storylineId = await withCompanyScope(db, companyId, async (tx) => {
      const [row] = await tx
        .insert(videoStorylines)
        .values({
          companyId,
          title: input.title,
          providerId: input.providerId,
          model: input.model,
          budgetCapCents: input.budgetCapCents,
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("Video storyline insert returned no row");
      await writeScript(tx, companyId, row.id, script, "append");
      return row.id;
    });
    const storyline = await recomputeEstimate(companyId, storylineId);
    await logActivity(db, {
      companyId,
      ...activityActor(actor),
      action: "video_storyline.created",
      entityType: "video_storyline",
      entityId: storylineId,
      details: { title: input.title, providerId: input.providerId, fromScript: true, sceneCount: script.sceneCount, shotCount: script.shotCount },
    });
    return {
      ...summarizeScript(script, input.providerId, input.model, { dryRun: false, mode: "new", storylineId }),
      storyline,
    };
  }

  async function getProgress(companyId: string, storylineId: string): Promise<VideoStorylineProgress> {
    const storyline = await getStorylineRow(companyId, storylineId);
    const shotRows = await db
      .select()
      .from(videoShots)
      .where(eq(videoShots.storylineId, storylineId))
      .orderBy(asc(videoShots.orderIndex));
    const doneShots = shotRows.filter((s) => s.status === "done").length;
    const failedShots = shotRows.filter((s) => s.status === "failed").length;
    const renderingShots = shotRows.filter((s) => s.status === "rendering" || s.status === "queued").length;
    return {
      storylineId,
      status: storyline.status as VideoStorylineProgress["status"],
      totalShots: shotRows.length,
      doneShots,
      failedShots,
      renderingShots,
      spentCents: storyline.spentCents,
      budgetCapCents: storyline.budgetCapCents,
      stitchBlockedReason: storyline.stitchBlockedReason,
      shots: shotRows.map((s) => ({
        id: s.id,
        orderIndex: s.orderIndex,
        status: s.status as VideoStorylineProgress["shots"][number]["status"],
        attempt: s.attempt,
        errorMessage: s.errorMessage,
      })),
    };
  }

  async function listRenderJobsForShot(companyId: string, shotId: string) {
    return db
      .select()
      .from(videoShotRenderJobs)
      .where(and(eq(videoShotRenderJobs.shotId, shotId), eq(videoShotRenderJobs.companyId, companyId)))
      .orderBy(asc(videoShotRenderJobs.attempt));
  }

  return {
    getStorylineRow,
    getSceneRow,
    getShotRow,
    listStorylines,
    getStoryline,
    listScenes,
    listShots,
    createStoryline,
    updateStoryline,
    deleteStoryline,
    createScene,
    updateScene,
    deleteScene,
    createShot,
    updateShot,
    deleteShot,
    recomputeEstimate,
    importScript,
    createStorylineFromScript,
    getProgress,
    listRenderJobsForShot,
    toStorylineSummary,
    toShotSummary,
  };
}

/**
 * The postgres.js driver's error surfaces either directly on the thrown
 * error (PGlite in dev) or wrapped in DrizzleQueryError.cause (real
 * Postgres) -- checking only the outer .code silently never matches
 * against a real database, so both need checking here.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "23505") return true;
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  return cause?.code === "23505";
}
