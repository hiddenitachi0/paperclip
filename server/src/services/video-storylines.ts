import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { videoScenes, videoShotRenderJobs, videoShots, videoStorylines } from "@paperclipai/db";
import {
  VIDEO_STORYLINE_MAX_SCENES,
  VIDEO_STORYLINE_MAX_SHOTS,
  estimateVideoStorylineCostCents,
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
  finalObjectKey: string | null;
  finalByteSize: number | null;
  finalDurationSeconds: number | null;
  stitchBlockedReason: string | null;
  errorMessage: string | null;
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
    finalObjectKey: row.finalObjectKey,
    finalByteSize: row.finalByteSize,
    finalDurationSeconds: row.finalDurationSeconds,
    stitchBlockedReason: row.stitchBlockedReason,
    errorMessage: row.errorMessage,
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
    createdAt: row.createdAt.toISOString(),
  };
}

/** A storyline being rendered/stitched owns its own shot tree via the render tick; hand edits mid-flight would race it. */
const EDITABLE_STORYLINE_STATUSES = new Set(["draft", "estimated", "paused", "failed"]);

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
        updatedAt: new Date(),
      })
      .where(eq(videoStorylines.id, storylineId))
      .returning();
    if (!row) throw new Error("Video storyline update returned no row");
    await logActivity(db, {
      companyId,
      ...activityActor(actor),
      action: "video_storyline.updated",
      entityType: "video_storyline",
      entityId: row.id,
      details: { fields: Object.keys(input) },
    });
    return toStorylineSummary(row);
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
    await db.delete(videoScenes).where(eq(videoScenes.id, sceneId));
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
    const row = await db.transaction(async (tx) => {
      // Move existing shots out of the way so the renumbering never collides.
      await tx
        .update(videoShots)
        .set({ orderIndex: sql`${videoShots.orderIndex} + ${SHOT_ORDER_PARK_OFFSET}` })
        .where(eq(videoShots.storylineId, storylineId));
      const inserted = await tx
        .insert(videoShots)
        .values({
          companyId,
          storylineId,
          sceneId: input.sceneId,
          // Larger than every parked shot, so it sorts last within its scene.
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
      await tx.execute(sql`
        UPDATE ${videoShots} AS s
        SET order_index = r.rn
        FROM (
          SELECT s2.id, (row_number() OVER (ORDER BY sc.order_index, s2.order_index) - 1)::int AS rn
          FROM ${videoShots} AS s2
          JOIN ${videoScenes} AS sc ON sc.id = s2.scene_id
          WHERE s2.storyline_id = ${storylineId}
        ) AS r
        WHERE s.id = r.id
      `);
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
    const row = await db
      .update(videoShots)
      .set({
        ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
        ...(input.orderIndex !== undefined ? { orderIndex: input.orderIndex } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.cameraNotes !== undefined ? { cameraNotes: input.cameraNotes } : {}),
        ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
        ...(input.lookReferenceAssetIds !== undefined ? { lookReferenceAssetIds: input.lookReferenceAssetIds } : {}),
        ...(input.transitionIn !== undefined ? { transitionIn: input.transitionIn } : {}),
        updatedAt: new Date(),
      })
      .where(eq(videoShots.id, shotId))
      .returning()
      .then((rows) => rows[0])
      .catch((err) => {
        throw isUniqueViolation(err) ? conflict(`A shot already exists at position ${input.orderIndex}.`) : err;
      });
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
    await db.delete(videoShots).where(eq(videoShots.id, shotId));
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

  /** Refreshes the cached estimatedTotalCents/Seconds shown before a render starts -- see POST .../estimate for the same computation exposed directly. */
  async function recomputeEstimate(companyId: string, storylineId: string): Promise<VideoStorylineSummary> {
    const storyline = await getStorylineRow(companyId, storylineId);
    const shots = await db
      .select({ durationSeconds: videoShots.durationSeconds })
      .from(videoShots)
      .where(eq(videoShots.storylineId, storylineId));
    const estimate = estimateVideoStorylineCostCents(shots, storyline.providerId as "fal" | "sogni");
    const [row] = await db
      .update(videoStorylines)
      .set({
        estimatedTotalCents: estimate.estimatedTotalCents,
        estimatedTotalSeconds: estimate.totalSeconds,
        status: storyline.status === "draft" && shots.length > 0 ? "estimated" : storyline.status,
        updatedAt: new Date(),
      })
      .where(eq(videoStorylines.id, storylineId))
      .returning();
    return toStorylineSummary(row!);
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
