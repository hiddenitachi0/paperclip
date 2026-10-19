import { and, desc, eq, like, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  assets,
  companyReactionEmojiConfig,
  issueAttachments,
  laneAConversations,
  laneAMessages,
  telegramMessageReactions,
} from "@paperclipai/db";
import {
  REACTION_EMOJI_DEFAULTS,
  REACTION_EMOJI_MEANINGS,
  normalizeReactionEmoji,
  reactionEmojiMeaning,
  type ReactionEmojiConfig,
  type RecordTelegramReactionInput,
  type UpdateReactionEmojiConfigInput,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

/** How much of a reply or picture prompt the recent-reactions list shows. */
export const REACTION_EXCERPT_CHARS = 160;

function excerpt(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

/**
 * DUR-4344: the data path for Telegram emoji-reaction feedback. Raw events
 * only — no summarising or learning (DUR-4342b/c read these rows).
 *
 * Every query filters on companyId; the agent, conversation and message the
 * bridge names are each checked to belong to the company in the URL, so a
 * wrong or forged id can never attach feedback to another company's data.
 */
export function telegramReactionService(db: Db) {
  async function getConfig(companyId: string): Promise<ReactionEmojiConfig> {
    const [row] = await db
      .select()
      .from(companyReactionEmojiConfig)
      .where(eq(companyReactionEmojiConfig.companyId, companyId));
    if (!row) {
      return {
        positive: [...REACTION_EMOJI_DEFAULTS.positive],
        negative: [...REACTION_EMOJI_DEFAULTS.negative],
        neutral: [...REACTION_EMOJI_DEFAULTS.neutral],
        isDefault: true,
      };
    }
    return { positive: row.positive, negative: row.negative, neutral: row.neutral, isDefault: false };
  }

  async function updateConfig(
    companyId: string,
    input: UpdateReactionEmojiConfigInput,
    updatedBy: string | null,
  ): Promise<ReactionEmojiConfig> {
    const seen = new Map<string, string>();
    const next = { positive: [] as string[], negative: [] as string[], neutral: [] as string[] };
    for (const meaning of REACTION_EMOJI_MEANINGS) {
      for (const emoji of input[meaning]) {
        const normalized = normalizeReactionEmoji(emoji);
        const earlier = seen.get(normalized);
        if (earlier) {
          throw unprocessable(`${normalized} is listed as both ${earlier} and ${meaning}; an emoji can mean only one thing.`);
        }
        seen.set(normalized, meaning);
        next[meaning].push(normalized);
      }
    }
    const now = new Date();
    await db
      .insert(companyReactionEmojiConfig)
      .values({ companyId, ...next, updatedBy, updatedAt: now })
      .onConflictDoUpdate({
        target: companyReactionEmojiConfig.companyId,
        set: { ...next, updatedBy, updatedAt: now },
      });
    return { ...next, isDefault: false };
  }

  async function record(companyId: string, input: RecordTelegramReactionInput) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, companyId)));
    if (!agent) throw notFound("Agent not found");

    const conversationId = input.conversationId ?? null;
    if (conversationId) {
      const [conversation] = await db
        .select({ id: laneAConversations.id })
        .from(laneAConversations)
        .where(
          and(
            eq(laneAConversations.id, conversationId),
            eq(laneAConversations.companyId, companyId),
            eq(laneAConversations.agentId, input.agentId),
          ),
        );
      if (!conversation) throw unprocessable("That conversation does not belong to this agent in this company.");
    }
    const messageId = input.messageId ?? null;
    if (messageId) {
      if (!conversationId) throw unprocessable("messageId needs a conversationId.");
      const [message] = await db
        .select({ id: laneAMessages.id })
        .from(laneAMessages)
        .where(
          and(
            eq(laneAMessages.id, messageId),
            eq(laneAMessages.companyId, companyId),
            eq(laneAMessages.conversationId, conversationId),
          ),
        );
      if (!message) throw unprocessable("That message is not part of this conversation.");
    }

    // A picture reference must be a file of this company, never another's.
    if (input.action === "added" && input.picture) {
      const [file] = await db
        .select({ id: issueAttachments.id })
        .from(issueAttachments)
        .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
        .where(
          and(
            eq(issueAttachments.id, input.picture.fileId),
            eq(issueAttachments.companyId, companyId),
            like(assets.contentType, "image/%"),
          ),
        );
      if (!file) throw unprocessable("That picture is not an image file of this company.");
    }

    const key = and(
      eq(telegramMessageReactions.companyId, companyId),
      eq(telegramMessageReactions.telegramChatId, input.telegramChatId),
      eq(telegramMessageReactions.telegramMessageId, input.telegramMessageId),
      eq(telegramMessageReactions.telegramUserId, input.telegramUserId),
      eq(telegramMessageReactions.emoji, input.emoji),
    );
    const [existing] = await db.select().from(telegramMessageReactions).where(key);
    const now = new Date();

    if (input.action === "removed") {
      if (!existing || !existing.active) throw notFound("No active reaction to remove");
      const [voided] = await db
        .update(telegramMessageReactions)
        .set({ active: false, removedAt: now, updatedAt: now })
        .where(eq(telegramMessageReactions.id, existing.id))
        .returning();
      return { event: voided!, created: false };
    }

    if (existing?.active) throw conflict("That reaction is already recorded");
    const picture = input.picture ?? null;
    const pictureFields = {
      pictureFileId: picture?.fileId ?? null,
      picturePrompt: picture?.prompt ?? null,
      pictureLook: picture?.look ?? null,
      pictureProvider: picture?.provider ?? null,
      pictureModel: picture?.model ?? null,
    };
    if (existing) {
      // The person took the reaction back and put it on again: re-activate the row.
      const [revived] = await db
        .update(telegramMessageReactions)
        .set({ active: true, removedAt: null, reactedAt: now, updatedAt: now, conversationId, messageId, ...pictureFields })
        .where(eq(telegramMessageReactions.id, existing.id))
        .returning();
      return { event: revived!, created: false };
    }
    const [created] = await db
      .insert(telegramMessageReactions)
      .values({
        companyId,
        agentId: input.agentId,
        telegramUserId: input.telegramUserId,
        telegramChatId: input.telegramChatId,
        telegramMessageId: input.telegramMessageId,
        conversationId,
        messageId,
        emoji: input.emoji,
        reactedAt: now,
        ...pictureFields,
      })
      .returning();
    return { event: created!, created: true };
  }

  async function list(companyId: string, opts: { agentId?: string; activeOnly?: boolean; limit?: number } = {}) {
    const config = await getConfig(companyId);
    const conditions = [eq(telegramMessageReactions.companyId, companyId)];
    if (opts.agentId) conditions.push(eq(telegramMessageReactions.agentId, opts.agentId));
    if (opts.activeOnly !== false) conditions.push(eq(telegramMessageReactions.active, true));
    const rows = await db
      .select()
      .from(telegramMessageReactions)
      .where(and(...conditions))
      .orderBy(desc(telegramMessageReactions.reactedAt))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
    return rows.map((row) => ({ ...row, meaning: reactionEmojiMeaning(config, row.emoji) }));
  }

  /**
   * DUR-4829: the newest reactions to one agent's messages, for the "What it
   * has learned" panel. Newest first, `limit + 1` read so the caller knows
   * whether there is more. Only what the panel shows leaves here: the emoji,
   * a short excerpt of the reply or picture it was on, and when -- never the
   * Telegram user, chat or message ids.
   *
   * Privacy (DUR-4094): a reaction in a chat requested by an active Employee
   * (light) member is hers, like her PA's chat transcript, and is left out.
   */
  async function listRecentForAgent(companyId: string, agentId: string, opts: { limit: number; offset: number }) {
    const config = await getConfig(companyId);
    const rows = await db
      .select({
        reaction: telegramMessageReactions,
        replyText: laneAMessages.content,
        replyRole: laneAMessages.role,
      })
      .from(telegramMessageReactions)
      .leftJoin(laneAMessages, eq(laneAMessages.id, telegramMessageReactions.messageId))
      .leftJoin(laneAConversations, eq(laneAConversations.id, telegramMessageReactions.conversationId))
      .where(
        and(
          eq(telegramMessageReactions.companyId, companyId),
          eq(telegramMessageReactions.agentId, agentId),
          sql`NOT EXISTS (
            SELECT 1 FROM company_memberships m
            WHERE m.company_id = ${companyId}
              AND m.principal_type = 'user'
              AND m.status = 'active'
              AND m.membership_role = 'employee'
              AND m.principal_id = ${laneAConversations.requestedByUserId}
          )`,
        ),
      )
      .orderBy(desc(telegramMessageReactions.reactedAt), desc(telegramMessageReactions.id))
      .limit(opts.limit + 1)
      .offset(opts.offset);
    const items = rows.slice(0, opts.limit).map(({ reaction, replyText, replyRole }) => {
      const hasPicture = Boolean(reaction.pictureFileId || reaction.picturePrompt);
      return {
        id: reaction.id,
        emoji: reaction.emoji,
        meaning: reactionEmojiMeaning(config, reaction.emoji),
        active: reaction.active,
        reactedAt: reaction.reactedAt.toISOString(),
        removedAt: reaction.removedAt ? reaction.removedAt.toISOString() : null,
        message: {
          id: reaction.messageId,
          conversationId: reaction.conversationId,
          excerpt: !hasPicture && replyRole === "assistant" && replyText ? excerpt(replyText, REACTION_EXCERPT_CHARS) : null,
        },
        picture: hasPicture
          ? {
              fileId: reaction.pictureFileId,
              look: reaction.pictureLook,
              promptExcerpt: reaction.picturePrompt ? excerpt(reaction.picturePrompt, REACTION_EXCERPT_CHARS) : null,
            }
          : null,
      };
    });
    return { items, hasMore: rows.length > opts.limit };
  }

  return { getConfig, updateConfig, record, list, listRecentForAgent };
}
