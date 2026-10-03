import { z } from "zod";

/**
 * DUR-4344: Telegram emoji-reaction feedback.
 *
 * Telegram sends a reaction update with the person's old and new reaction
 * sets; the bridge diffs them and posts one event per emoji that was added or
 * removed. The server never sees a "set", only single add/remove events.
 */

/** Telegram ids: users are positive, group chats negative; all fit 64 bits. */
export const TELEGRAM_CHAT_ID_PATTERN = /^-?[1-9]\d{0,18}$/;

export const REACTION_EMOJI_MEANINGS = ["positive", "negative", "neutral"] as const;
export type ReactionEmojiMeaning = (typeof REACTION_EMOJI_MEANINGS)[number];

/** Built-in meanings, used until a company saves its own. */
export const REACTION_EMOJI_DEFAULTS: Record<ReactionEmojiMeaning, string[]> = {
  positive: ["👍", "❤", "🔥", "😍", "👏"],
  negative: ["👎", "🤔", "🤨", "🤮", "💩"],
  neutral: ["😁", "🤣", "😂"],
};

export const MAX_REACTION_EMOJI_PER_MEANING = 30;

/**
 * One canonical spelling per emoji: Telegram and keyboards disagree about the
 * trailing variation selector (❤ vs ❤️), which would otherwise make the same
 * reaction look like two different ones.
 */
export function normalizeReactionEmoji(emoji: string): string {
  return emoji.replace(/[︎️]/g, "").trim();
}

const emojiSchema = z
  .string()
  .max(32)
  .transform(normalizeReactionEmoji)
  .refine((value) => value.length > 0 && /\p{Extended_Pictographic}/u.test(value), {
    message: "That is not an emoji.",
  });

const pictureSchema = z
  .object({
    fileId: z.string().uuid(),
    prompt: z.string().max(4000).nullish(),
    look: z.string().max(200).nullish(),
    provider: z.string().max(100).nullish(),
    model: z.string().max(200).nullish(),
  })
  .strict();

export const recordTelegramReactionSchema = z
  .object({
    agentId: z.string().uuid(),
    telegramUserId: z.string().trim().regex(/^[1-9]\d{0,18}$/, "Not a Telegram user id."),
    telegramChatId: z.string().trim().regex(TELEGRAM_CHAT_ID_PATTERN, "Not a Telegram chat id."),
    telegramMessageId: z.number().int().positive().max(2_147_483_647),
    conversationId: z.string().uuid().nullish(),
    messageId: z.string().uuid().nullish(),
    emoji: emojiSchema,
    action: z.enum(["added", "removed"]),
    picture: pictureSchema.nullish(),
  })
  .strict();
export type RecordTelegramReactionInput = z.infer<typeof recordTelegramReactionSchema>;

export const updateReactionEmojiConfigSchema = z
  .object({
    positive: z.array(emojiSchema).max(MAX_REACTION_EMOJI_PER_MEANING),
    negative: z.array(emojiSchema).max(MAX_REACTION_EMOJI_PER_MEANING),
    neutral: z.array(emojiSchema).max(MAX_REACTION_EMOJI_PER_MEANING),
  })
  .strict();
export type UpdateReactionEmojiConfigInput = z.infer<typeof updateReactionEmojiConfigSchema>;

export interface ReactionEmojiConfig extends Record<ReactionEmojiMeaning, string[]> {
  /** True while the company has not saved its own meanings. */
  isDefault: boolean;
}

/** Which meaning an emoji has under a config, or null when it is not listed. */
export function reactionEmojiMeaning(
  config: Record<ReactionEmojiMeaning, string[]>,
  emoji: string,
): ReactionEmojiMeaning | null {
  const wanted = normalizeReactionEmoji(emoji);
  for (const meaning of REACTION_EMOJI_MEANINGS) {
    if (config[meaning].some((candidate) => normalizeReactionEmoji(candidate) === wanted)) return meaning;
  }
  return null;
}
