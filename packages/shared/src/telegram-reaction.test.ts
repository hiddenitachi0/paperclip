import { describe, expect, it } from "vitest";
import {
  REACTION_EMOJI_DEFAULTS,
  normalizeReactionEmoji,
  reactionEmojiMeaning,
  recordTelegramReactionSchema,
  updateReactionEmojiConfigSchema,
} from "./validators/telegram-reaction.js";

const base = {
  agentId: "11111111-1111-4111-8111-111111111111",
  telegramUserId: "42",
  telegramChatId: "-100123",
  telegramMessageId: 9,
  emoji: "❤️",
  action: "added",
};

describe("telegram reaction validators", () => {
  it("normalises the variation selector so ❤ and ❤️ are one emoji", () => {
    expect(normalizeReactionEmoji("❤️")).toBe("❤");
    expect(recordTelegramReactionSchema.parse(base).emoji).toBe("❤");
  });

  it("rejects non-emoji, bad ids, unknown fields and bad actions", () => {
    expect(recordTelegramReactionSchema.safeParse({ ...base, emoji: "thumbs" }).success).toBe(false);
    expect(recordTelegramReactionSchema.safeParse({ ...base, telegramUserId: "abc" }).success).toBe(false);
    expect(recordTelegramReactionSchema.safeParse({ ...base, action: "toggled" }).success).toBe(false);
    expect(recordTelegramReactionSchema.safeParse({ ...base, companyId: "x" }).success).toBe(false);
  });

  it("classifies emoji with the defaults, ignoring the variation selector", () => {
    expect(reactionEmojiMeaning(REACTION_EMOJI_DEFAULTS, "❤️")).toBe("positive");
    expect(reactionEmojiMeaning(REACTION_EMOJI_DEFAULTS, "👎")).toBe("negative");
    expect(reactionEmojiMeaning(REACTION_EMOJI_DEFAULTS, "😂")).toBe("neutral");
    expect(reactionEmojiMeaning(REACTION_EMOJI_DEFAULTS, "🦄")).toBeNull();
  });

  it("config schema needs all three lists", () => {
    expect(updateReactionEmojiConfigSchema.safeParse({ positive: ["👍"], negative: [] }).success).toBe(false);
    expect(updateReactionEmojiConfigSchema.safeParse({ positive: ["👍"], negative: [], neutral: [] }).success).toBe(true);
  });
});
