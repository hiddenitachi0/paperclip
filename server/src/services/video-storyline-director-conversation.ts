import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { videoStorylineDirectorConversations, videoStorylineDirectorMessages } from "@paperclipai/db";
import type {
  VideoDirectorConversationDetail,
  VideoDirectorConversationStatus,
  VideoDirectorConversationSummary,
  VideoDirectorMessageKind,
  VideoDirectorMessagePayload,
  VideoDirectorMessageRole,
  VideoDirectorMessageSummary,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { videoStorylineService } from "./video-storylines.js";

/**
 * DUR-4327: shared storage helpers for the whole-storyline AI director
 * conversation (one per storyline, append-only turns) -- used by
 * video-storyline-director-review.ts, -dialogue.ts and -proposals.ts so the
 * three stay in lockstep on conversation/message shape and state
 * transitions instead of each hand-rolling its own queries.
 */

type ConversationRow = typeof videoStorylineDirectorConversations.$inferSelect;
type MessageRow = typeof videoStorylineDirectorMessages.$inferSelect;

export function toConversationSummary(row: ConversationRow): VideoDirectorConversationSummary {
  return {
    id: row.id,
    storylineId: row.storylineId,
    status: row.status as VideoDirectorConversationStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMessageSummary(row: MessageRow): VideoDirectorMessageSummary {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as VideoDirectorMessageRole,
    kind: row.kind as VideoDirectorMessageKind,
    payload: row.payload as VideoDirectorMessagePayload,
    createdAt: row.createdAt.toISOString(),
  };
}

export function videoStorylineDirectorConversationStore(db: Db) {
  const storylines = videoStorylineService(db);

  async function getConversationRow(companyId: string, storylineId: string): Promise<ConversationRow> {
    await storylines.getStorylineRow(companyId, storylineId);
    const [row] = await db
      .select()
      .from(videoStorylineDirectorConversations)
      .where(
        and(
          eq(videoStorylineDirectorConversations.storylineId, storylineId),
          eq(videoStorylineDirectorConversations.companyId, companyId),
        ),
      );
    if (!row) throw notFound("No director conversation has been started for this storyline yet.");
    return row;
  }

  async function getConversationById(companyId: string, conversationId: string): Promise<ConversationRow> {
    const [row] = await db
      .select()
      .from(videoStorylineDirectorConversations)
      .where(
        and(
          eq(videoStorylineDirectorConversations.id, conversationId),
          eq(videoStorylineDirectorConversations.companyId, companyId),
        ),
      );
    if (!row) throw notFound("Director conversation not found");
    return row;
  }

  /** Upserts the storyline's one conversation row, resetting an existing one back to 'reviewing' for a re-run. */
  async function getOrResetConversationForReview(companyId: string, storylineId: string): Promise<ConversationRow> {
    await storylines.getStorylineRow(companyId, storylineId);
    const now = new Date();
    const [existing] = await db
      .select()
      .from(videoStorylineDirectorConversations)
      .where(
        and(
          eq(videoStorylineDirectorConversations.storylineId, storylineId),
          eq(videoStorylineDirectorConversations.companyId, companyId),
        ),
      );
    if (existing) {
      const [row] = await db
        .update(videoStorylineDirectorConversations)
        .set({ status: "reviewing", updatedAt: now })
        .where(eq(videoStorylineDirectorConversations.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await db
      .insert(videoStorylineDirectorConversations)
      .values({ companyId, storylineId, status: "reviewing", createdAt: now, updatedAt: now })
      .returning();
    if (!row) throw new Error("Director conversation insert returned no row");
    return row;
  }

  async function setStatus(conversationId: string, status: VideoDirectorConversationStatus): Promise<void> {
    await db
      .update(videoStorylineDirectorConversations)
      .set({ status, updatedAt: new Date() })
      .where(eq(videoStorylineDirectorConversations.id, conversationId));
  }

  async function appendMessage(
    companyId: string,
    conversationId: string,
    role: VideoDirectorMessageRole,
    kind: VideoDirectorMessageKind,
    payload: VideoDirectorMessagePayload,
  ): Promise<MessageRow> {
    const [row] = await db
      .insert(videoStorylineDirectorMessages)
      .values({ companyId, conversationId, role, kind, payload: payload as object })
      .returning();
    if (!row) throw new Error("Director message insert returned no row");
    return row;
  }

  async function listMessages(conversationId: string): Promise<MessageRow[]> {
    return db
      .select()
      .from(videoStorylineDirectorMessages)
      .where(eq(videoStorylineDirectorMessages.conversationId, conversationId))
      .orderBy(asc(videoStorylineDirectorMessages.createdAt));
  }

  async function getLatestMessageOfKind(conversationId: string, kind: VideoDirectorMessageKind): Promise<MessageRow | null> {
    const [row] = await db
      .select()
      .from(videoStorylineDirectorMessages)
      .where(and(eq(videoStorylineDirectorMessages.conversationId, conversationId), eq(videoStorylineDirectorMessages.kind, kind)))
      .orderBy(desc(videoStorylineDirectorMessages.createdAt))
      .limit(1);
    return row ?? null;
  }

  async function countMessagesOfKind(conversationId: string, kind: VideoDirectorMessageKind): Promise<number> {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(videoStorylineDirectorMessages)
      .where(and(eq(videoStorylineDirectorMessages.conversationId, conversationId), eq(videoStorylineDirectorMessages.kind, kind)));
    return count;
  }

  async function getConversationDetail(companyId: string, storylineId: string): Promise<VideoDirectorConversationDetail> {
    const row = await getConversationRow(companyId, storylineId);
    const messages = await listMessages(row.id);
    return { ...toConversationSummary(row), messages: messages.map(toMessageSummary) };
  }

  return {
    getConversationRow,
    getConversationById,
    getOrResetConversationForReview,
    setStatus,
    appendMessage,
    listMessages,
    getLatestMessageOfKind,
    countMessagesOfKind,
    getConversationDetail,
  };
}
