import { and, count, desc, eq, gt, inArray, isNull, max, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemories, laneAConversations, laneAMessages, telegramMessageReactions } from "@paperclipai/db";
import { AGENT_MEMORY_MAX_LENGTH, AGENT_MEMORY_MAX_NOTES } from "@paperclipai/shared/validators/agent-memory";
import { reactionEmojiMeaning, type ReactionEmojiConfig } from "@paperclipai/shared";
import { agentMemoryService } from "./agent-memories.js";
import { logActivity } from "./activity-log.js";
import { telegramReactionService } from "./telegram-reactions.js";

/**
 * DUR-4345: reaction learning. Turns a person's emoji reactions (DUR-4344's
 * telegram_message_reactions rows) into short `agent_memories` notes with
 * source 'reaction', and tells the picture tool which "do more of / avoid"
 * rules those notes imply.
 *
 * No model is involved: the summary is a deterministic tally, so it is
 * testable, free, and cannot be steered by a prompt hidden in a picture's
 * prompt or a reply. Two consequences worth knowing:
 *   - A picture's prompt is never copied anywhere. Only terms from the fixed
 *     PICTURE_LEXICON below can reach a picture rule; everything else about a
 *     picture (its look name) appears only in a note a human reads.
 *   - The set is REWRITTEN by every run (delete this agent's reaction notes,
 *     insert the fresh ones), so a removed reaction stops counting the next
 *     time it runs, and a hand-edited reaction note is replaced (an operator
 *     who dislikes one deletes it; the next run may bring it back only if the
 *     reactions still say so).
 *
 * Cadence: a run happens when a reaction is REMOVED (so its effect goes away
 * at once) or when REACTION_SUMMARY_EVERY_N reactions have been added or
 * changed for the agent since the last run.
 *
 * Whose notebook: the agent's owner, exactly as `agent_memories` already
 * decides (persona = the person, otherwise the job). Every Telegram person who
 * reacts to one agent therefore shares that owner's notes; Telegram chats are
 * private and allowlisted, so in practice that is one person per agent.
 */

/** A summarization run happens once this many reactions changed since the last one. */
export const REACTION_SUMMARY_EVERY_N = 5;
/** How many of the newest reactions one run reads. */
export const REACTION_SUMMARY_WINDOW = 300;
/** Most terms in one picture note. */
export const MAX_PICTURE_TERMS = 6;
/** The single follow-up question Maja may ask about a disliked picture. */
export const PICTURE_FOLLOW_UP_QUESTION =
  "What should I change: the style, the subject, or the colours? Just reply to this message.";

export type ReactionNoteCategory =
  | "picture_like"
  | "picture_avoid"
  | "picture_look"
  | "picture_answer"
  | "reply_style";

/**
 * The only words a picture rule can be made of: a label, and the words in a
 * picture's prompt (or a person's answer) that count as that label. Matched
 * as whole words, any case.
 */
export const PICTURE_LEXICON: ReadonlyArray<{ label: string; words: readonly string[] }> = [
  { label: "golden-hour light", words: ["golden hour", "golden-hour", "sunset", "sunrise"] },
  { label: "soft daylight", words: ["soft daylight", "daylight", "natural light"] },
  { label: "night scenes", words: ["night", "moonlight", "neon", "dark"] },
  { label: "warm colours", words: ["warm", "warm colours", "warm colors", "cozy", "cosy"] },
  { label: "cool colours", words: ["cool tones", "cool colours", "cool colors", "cold", "blue tones"] },
  { label: "pastel colours", words: ["pastel", "pastels", "soft colours", "soft colors"] },
  { label: "vivid colours", words: ["vibrant", "vivid", "saturated", "colourful", "colorful", "bright colours", "bright colors"] },
  { label: "muted colours", words: ["muted", "desaturated", "faded"] },
  { label: "black and white", words: ["black and white", "monochrome", "b&w"] },
  { label: "close-ups", words: ["close-up", "closeup", "headshot", "portrait"] },
  { label: "wide shots", words: ["wide shot", "wide-angle", "landscape", "panorama", "full body", "full-body"] },
  { label: "text in the picture", words: ["text", "caption", "lettering", "typography", "words", "writing", "sign", "poster", "watermark", "logo"] },
  { label: "busy backgrounds", words: ["crowd", "crowded", "busy", "cluttered"] },
  { label: "plain backgrounds", words: ["minimal", "minimalist", "plain background", "simple background", "clean background"] },
  { label: "nature", words: ["nature", "forest", "mountains", "lake", "garden", "flowers", "beach"] },
  { label: "city scenes", words: ["city", "street", "urban", "skyline"] },
  { label: "illustrated style", words: ["illustration", "illustrated", "cartoon", "anime", "painting", "watercolor", "watercolour", "sketch"] },
  { label: "photo-realistic style", words: ["photorealistic", "photo-realistic", "photograph", "photo", "realistic"] },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LEXICON_PATTERNS = PICTURE_LEXICON.map((entry) => ({
  label: entry.label,
  pattern: new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${entry.words.map((w) => escapeRegExp(w).replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`,
    "iu",
  ),
}));

/** The lexicon labels a piece of text mentions (each at most once). */
export function pictureTermsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return LEXICON_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.label);
}

/**
 * The sentences the picture tool itself adds to a prompt (this feature's own
 * rules, and the look's "keep out of the picture" list). A stored prompt
 * contains them, so they are removed before counting: otherwise "Avoid: text"
 * would make every picture look like it has text in it, and a rule would
 * feed on itself.
 */
export function stripInjectedPictureRules(prompt: string | null | undefined): string {
  return (prompt ?? "")
    .split(/\n+/)
    .filter((line) => !/^\s*(?:Do more of:|Avoid, unless the request above asks for it:|Keep out of the picture:|Fully clothed\.)/i.test(line))
    .join("\n");
}

/** One reaction, reduced to what the summary needs. */
export interface ReactionLearningEvent {
  meaning: "positive" | "negative";
  /** Set for a picture. */
  picture?: { prompt: string | null; look: string | null; answer: string | null };
  /** The text of our reply the reaction was about (a text reply, not a picture). */
  replyText?: string | null;
}

export interface DerivedReactionNote {
  category: ReactionNoteCategory;
  text: string;
  /** Lexicon labels only; empty for notes that do not drive picture rules. */
  terms: string[];
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s+\S/m;

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function oneLine(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim().replace(/["“”]/g, "'");
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function fit(text: string): string {
  return text.length <= AGENT_MEMORY_MAX_LENGTH ? text : `${text.slice(0, AGENT_MEMORY_MAX_LENGTH - 1)}…`;
}

/** The pure part: reactions in, notes out. Same input, same notes. */
export function summarizeReactions(events: ReactionLearningEvent[]): DerivedReactionNote[] {
  const notes: DerivedReactionNote[] = [];
  const pictures = events.filter((event) => event.picture);

  // Picture terms: a term only counts for the side that has more evidence.
  const tally = new Map<string, { positive: number; negative: number }>();
  for (const event of pictures) {
    const seen = new Set(pictureTermsIn(stripInjectedPictureRules(event.picture!.prompt)));
    // What the person said they would change is evidence against, whatever the emoji.
    if (event.meaning === "negative") for (const term of pictureTermsIn(event.picture!.answer)) seen.add(term);
    for (const term of seen) {
      const entry = tally.get(term) ?? { positive: 0, negative: 0 };
      entry[event.meaning] += 1;
      tally.set(term, entry);
    }
  }
  const order = PICTURE_LEXICON.map((entry) => entry.label);
  const ranked = [...tally.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  const liked = ranked.filter(([, t]) => t.positive > t.negative).map(([label]) => label).slice(0, MAX_PICTURE_TERMS);
  const avoided = ranked.filter(([, t]) => t.negative > t.positive).map(([label]) => label).slice(0, MAX_PICTURE_TERMS);
  if (liked.length > 0) {
    notes.push({ category: "picture_like", text: `Likes pictures with: ${liked.join(", ")}.`, terms: liked });
  }
  if (avoided.length > 0) {
    notes.push({ category: "picture_avoid", text: `Dislikes pictures with: ${avoided.join(", ")}.`, terms: avoided });
  }

  // Looks (for a human reading the notebook; never part of a picture prompt).
  const looks = new Map<string, number>();
  for (const event of pictures) {
    const look = event.picture!.look?.trim();
    if (look) looks.set(look, (looks.get(look) ?? 0) + (event.meaning === "positive" ? 1 : -1));
  }
  const likedLooks = [...looks].filter(([, net]) => net > 0).map(([name]) => oneLine(name, 40)).slice(0, 3);
  const dislikedLooks = [...looks].filter(([, net]) => net < 0).map(([name]) => oneLine(name, 40)).slice(0, 3);
  if (likedLooks.length > 0) notes.push({ category: "picture_look", text: fit(`Liked pictures made with the look: ${likedLooks.join(", ")}.`), terms: [] });
  if (dislikedLooks.length > 0) notes.push({ category: "picture_look", text: fit(`Did not like pictures made with the look: ${dislikedLooks.join(", ")}.`), terms: [] });

  // What they said they would change on a disliked picture (their words, shortened).
  const answers = pictures
    .filter((event) => event.meaning === "negative" && event.picture!.answer)
    .map((event) => oneLine(event.picture!.answer!, 120))
    .slice(0, 2);
  for (const answer of answers) {
    notes.push({ category: "picture_answer", text: fit(`Asked what to change on a picture they disliked, they said: "${answer}"`), terms: [] });
  }

  // Text replies: length and format.
  const replies = events.filter((event) => !event.picture && event.replyText);
  const positive = replies.filter((event) => event.meaning === "positive");
  const negative = replies.filter((event) => event.meaning === "negative");
  const posWords = positive.map((event) => wordCount(event.replyText!));
  const negWords = negative.map((event) => wordCount(event.replyText!));
  const posAvg = average(posWords);
  const negAvg = average(negWords);
  if (negative.length > 0) {
    const shorter = positive.length === 0 ? negAvg >= 80 : negAvg >= posAvg * 1.3 && negAvg - posAvg >= 20;
    const longer = positive.length > 0 && negAvg <= posAvg * 0.7 && posAvg - negAvg >= 20;
    if (shorter) {
      const detail = positive.length > 0 ? `liked replies averaged ${Math.round(posAvg)} words, disliked ones ${Math.round(negAvg)}` : `a disliked reply ran ${Math.round(negAvg)} words`;
      notes.push({ category: "reply_style", text: fit(`Prefers shorter replies (${detail}).`), terms: [] });
    } else if (longer) {
      notes.push({
        category: "reply_style",
        text: fit(`Prefers fuller replies (liked replies averaged ${Math.round(posAvg)} words, disliked ones ${Math.round(negAvg)}).`),
        terms: [],
      });
    }
  }
  const netList =
    positive.filter((event) => LIST_LINE.test(event.replyText!)).length -
    negative.filter((event) => LIST_LINE.test(event.replyText!)).length;
  if (netList > 0) notes.push({ category: "reply_style", text: "Likes replies laid out as a list.", terms: [] });
  if (netList < 0) notes.push({ category: "reply_style", text: "Dislikes replies laid out as a list; write in plain sentences.", terms: [] });
  return notes;
}

export function reactionLearningService(db: Db) {
  const reactions = telegramReactionService(db);
  const memories = agentMemoryService(db);

  function ownerFilter(owner: { companyId: string; agentId: string; personaId: string | null }): SQL {
    return owner.personaId
      ? and(eq(agentMemories.companyId, owner.companyId), eq(agentMemories.personaId, owner.personaId))!
      : and(
          eq(agentMemories.companyId, owner.companyId),
          eq(agentMemories.agentId, owner.agentId),
          isNull(agentMemories.personaId),
        )!;
  }

  async function loadEvents(companyId: string, agentId: string, config: ReactionEmojiConfig) {
    const rows = await db
      .select({
        reaction: telegramMessageReactions,
        replyText: laneAMessages.content,
        replyRole: laneAMessages.role,
        requestedByUserId: laneAConversations.requestedByUserId,
      })
      .from(telegramMessageReactions)
      .leftJoin(laneAMessages, eq(laneAMessages.id, telegramMessageReactions.messageId))
      .leftJoin(laneAConversations, eq(laneAConversations.id, telegramMessageReactions.conversationId))
      .where(
        and(
          eq(telegramMessageReactions.companyId, companyId),
          eq(telegramMessageReactions.agentId, agentId),
          eq(telegramMessageReactions.active, true),
        ),
      )
      .orderBy(desc(telegramMessageReactions.reactedAt))
      .limit(REACTION_SUMMARY_WINDOW);
    const events: ReactionLearningEvent[] = [];
    let requestedByUserId: string | null = null;
    for (const row of rows) {
      const meaning = reactionEmojiMeaning(config, row.reaction.emoji);
      if (meaning !== "positive" && meaning !== "negative") continue;
      requestedByUserId ??= row.requestedByUserId ?? null;
      const isPicture = Boolean(row.reaction.pictureFileId || row.reaction.picturePrompt);
      if (isPicture) {
        events.push({
          meaning,
          picture: {
            prompt: row.reaction.picturePrompt,
            look: row.reaction.pictureLook,
            answer: row.reaction.followUpAnswer,
          },
        });
      } else if (row.replyText && row.replyRole === "assistant") {
        events.push({ meaning, replyText: row.replyText });
      }
    }
    return { events, requestedByUserId };
  }

  /** Rewrite this agent's reaction notes from the reactions that still stand. */
  async function summarizeAgent(companyId: string, agentId: string) {
    const owner = await memories.resolveOwner(companyId, agentId);
    const config = await reactions.getConfig(companyId);
    const { events, requestedByUserId } = await loadEvents(companyId, agentId, config);
    const derived = summarizeReactions(events);
    const written = await db.transaction(async (tx) => {
      const removed = await tx
        .delete(agentMemories)
        .where(and(ownerFilter(owner), eq(agentMemories.source, "reaction"), eq(agentMemories.agentId, agentId)))
        .returning({ id: agentMemories.id });
      // The 100-note cap is the notebook's, shared with notes people wrote.
      const [{ value: others } = { value: 0 }] = await tx
        .select({ value: count() })
        .from(agentMemories)
        .where(ownerFilter(owner));
      const room = Math.max(0, AGENT_MEMORY_MAX_NOTES - Number(others));
      const keep = derived.slice(0, room);
      const now = new Date();
      if (keep.length > 0) {
        await tx.insert(agentMemories).values(
          keep.map((note) => ({
            companyId,
            agentId,
            personaId: owner.personaId,
            text: note.text,
            source: "reaction",
            createdByUserId: requestedByUserId,
            category: note.category,
            terms: note.terms.length > 0 ? note.terms : null,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }
      return { removed: removed.length, added: keep.length };
    });
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "reaction-learning",
      agentId,
      action: "agent_memory.reaction_summarized",
      entityType: "agent",
      entityId: agentId,
      details: { reactionsRead: events.length, notesRemoved: written.removed, notesWritten: written.added },
    });
    return { ...written, reactionsRead: events.length };
  }

  /**
   * Run a summarization when the cadence says so. Never throws: learning is a
   * nicety, and recording the reaction has already succeeded.
   */
  async function maybeSummarize(companyId: string, agentId: string, options: { force?: boolean } = {}) {
    try {
      if (!options.force) {
        const owner = await memories.resolveOwner(companyId, agentId);
        const [{ lastRun } = { lastRun: null }] = await db
          .select({ lastRun: max(agentMemories.createdAt) })
          .from(agentMemories)
          .where(and(ownerFilter(owner), eq(agentMemories.source, "reaction"), eq(agentMemories.agentId, agentId)));
        const since = lastRun ?? new Date(0);
        const [{ value: pending } = { value: 0 }] = await db
          .select({ value: count() })
          .from(telegramMessageReactions)
          .where(
            and(
              eq(telegramMessageReactions.companyId, companyId),
              eq(telegramMessageReactions.agentId, agentId),
              gt(telegramMessageReactions.updatedAt, since),
            ),
          );
        if (Number(pending) < REACTION_SUMMARY_EVERY_N) return null;
      }
      return await summarizeAgent(companyId, agentId);
    } catch (err) {
      console.warn("reaction learning: summarization failed", err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * The one short follow-up for a freshly disliked picture, or null. At most
   * once per picture: any earlier ask on the same Telegram message (by any
   * emoji, from any reaction row) blocks another, however often it is
   * reacted to again.
   */
  async function claimPictureFollowUp(
    companyId: string,
    event: typeof telegramMessageReactions.$inferSelect,
    config: ReactionEmojiConfig,
  ): Promise<{ text: string } | null> {
    if (!event.active || !(event.pictureFileId || event.picturePrompt)) return null;
    if (reactionEmojiMeaning(config, event.emoji) !== "negative") return null;
    const [claimed] = await db
      .update(telegramMessageReactions)
      .set({ followUpAskedAt: new Date() })
      .where(
        and(
          eq(telegramMessageReactions.id, event.id),
          isNull(telegramMessageReactions.followUpAskedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM telegram_message_reactions sibling
            WHERE sibling.company_id = ${companyId}
              AND sibling.telegram_chat_id = ${event.telegramChatId}
              AND sibling.telegram_message_id = ${event.telegramMessageId}
              AND sibling.follow_up_asked_at IS NOT NULL
          )`,
        ),
      )
      .returning({ id: telegramMessageReactions.id });
    return claimed ? { text: PICTURE_FOLLOW_UP_QUESTION } : null;
  }

  /**
   * Store the person's answer on the reaction the question was asked for.
   * Only the person who reacted, only on a picture we asked about, only once.
   */
  async function recordFollowUpAnswer(
    companyId: string,
    input: { agentId: string; telegramUserId: string; telegramChatId: string; telegramMessageId: number; answer: string },
  ): Promise<{ id: string } | null> {
    const [row] = await db
      .update(telegramMessageReactions)
      .set({ followUpAnswer: input.answer, followUpAnsweredAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(telegramMessageReactions.companyId, companyId),
          eq(telegramMessageReactions.agentId, input.agentId),
          eq(telegramMessageReactions.telegramUserId, input.telegramUserId),
          eq(telegramMessageReactions.telegramChatId, input.telegramChatId),
          eq(telegramMessageReactions.telegramMessageId, input.telegramMessageId),
          sql`${telegramMessageReactions.followUpAskedAt} IS NOT NULL`,
          isNull(telegramMessageReactions.followUpAnswer),
        ),
      )
      .returning({ id: telegramMessageReactions.id });
    return row ?? null;
  }

  /**
   * The "do more of / avoid" rules the picture tool adds to a prompt for this
   * agent's person: lexicon labels read back from the stored reaction notes.
   * The labels are re-checked against the lexicon, so a note edited by hand
   * can never smuggle free text into a prompt.
   */
  async function pictureRules(companyId: string, agentId: string): Promise<{ doMore: string[]; avoid: string[] }> {
    const owner = await memories.resolveOwner(companyId, agentId);
    const rows = await db
      .select({ category: agentMemories.category, terms: agentMemories.terms })
      .from(agentMemories)
      .where(
        and(
          ownerFilter(owner),
          eq(agentMemories.source, "reaction"),
          inArray(agentMemories.category, ["picture_like", "picture_avoid"]),
        ),
      );
    const known = new Set(PICTURE_LEXICON.map((entry) => entry.label));
    const pick = (category: string) => [
      ...new Set(
        rows
          .filter((row) => row.category === category)
          .flatMap((row) => (Array.isArray(row.terms) ? row.terms : []))
          .filter((term): term is string => typeof term === "string" && known.has(term)),
      ),
    ];
    const doMore = pick("picture_like");
    const avoid = pick("picture_avoid");
    // A term both liked (by one agent's notes) and avoided (by another's) cancels out.
    return { doMore: doMore.filter((t) => !avoid.includes(t)), avoid: avoid.filter((t) => !doMore.includes(t)) };
  }

  return { summarizeAgent, maybeSummarize, claimPictureFollowUp, recordFollowUpAnswer, pictureRules };
}

export type ReactionLearningService = ReturnType<typeof reactionLearningService>;
