import { z } from "zod";
import { TELEGRAM_USER_ID_PATTERN } from "./telegram-bot.js";

/**
 * Hermes parity, slice 1: two-way Telegram chat about company data for
 * linked people (see packages/db/src/schema/telegram_chat.ts).
 *
 * The bridge-facing bodies carry the Telegram sender's id (only Telegram can
 * vouch for it; the bridge copies it from the update) and the bot's id. They
 * never carry a company: the company is the bot's, looked up on the server.
 */

export const TELEGRAM_CHAT_MESSAGE_MAX_CHARS = 4_000;
export const TELEGRAM_CHAT_DAILY_CAP_DEFAULT = 30;
export const TELEGRAM_CHAT_DAILY_CAP_MAX = 500;
/** The code a person types after /link: 8 letters/digits, no look-alikes (0/O, 1/I/L). */
export const TELEGRAM_LINK_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const TELEGRAM_LINK_CODE_LENGTH = 8;

const uuid = z.string().uuid();
const telegramUserId = z.string().regex(TELEGRAM_USER_ID_PATTERN, "Not a Telegram user id");

export const updateTelegramChatSettingsSchema = z
  .object({
    enabled: z.boolean(),
    botId: uuid.nullable(),
    quickAgentId: uuid.nullable(),
    fullAgentId: uuid.nullable(),
    dailyQuestionsPerPerson: z.number().int().min(1).max(TELEGRAM_CHAT_DAILY_CAP_MAX),
  })
  .strict();
export type UpdateTelegramChatSettingsInput = z.infer<typeof updateTelegramChatSettingsSchema>;

export const telegramChatAskSchema = z
  .object({
    botId: uuid,
    telegramUserId,
    // In a private chat the chat id is the sender's user id; the server
    // refuses anything else.
    chatId: telegramUserId,
    message: z.string().trim().min(1).max(TELEGRAM_CHAT_MESSAGE_MAX_CHARS),
    /** Start a fresh conversation with the quick agent (Telegram /new). */
    fresh: z.boolean().optional(),
  })
  .strict();
export type TelegramChatAskInput = z.infer<typeof telegramChatAskSchema>;

export const telegramChatLinkSchema = z
  .object({
    botId: uuid,
    telegramUserId,
    code: z.string().trim().min(1).max(40),
    telegramUsername: z.string().trim().max(64).nullable().optional(),
  })
  .strict();
export type TelegramChatLinkInput = z.infer<typeof telegramChatLinkSchema>;

export const ackTelegramChatAnswerSchema = z
  .object({
    outcome: z.enum(["delivered", "failed"]),
  })
  .strict();
export type AckTelegramChatAnswerInput = z.infer<typeof ackTelegramChatAnswerSchema>;

export type TelegramChatSettings = {
  companyId: string;
  enabled: boolean;
  botId: string | null;
  quickAgentId: string | null;
  fullAgentId: string | null;
  dailyQuestionsPerPerson: number;
  updatedAt: string | null;
};

export type TelegramLinkStatus = {
  linked: boolean;
  telegramUsername: string | null;
  linkedAt: string | null;
  /** When the code shown last is no longer valid; null when there is none. */
  pendingCodeExpiresAt: string | null;
};

export type TelegramLinkCode = {
  code: string;
  expiresAt: string;
};

export type TelegramChatAskOutcome =
  | "answered"
  | "handed_over"
  | "not_enabled"
  | "not_linked"
  | "no_access"
  | "over_cap"
  | "refused";

export type TelegramChatAskResult = {
  outcome: TelegramChatAskOutcome;
  /** What the bridge sends back into the chat, as plain text. */
  reply: string;
  requestId: string | null;
};

export type TelegramChatLinkResult = {
  outcome: "linked" | "bad_code" | "too_many_attempts" | "not_enabled";
  reply: string;
};

export type TelegramChatOutboxItem = {
  id: string;
  botId: string;
  chatId: string;
  text: string;
  taskIdentifier: string | null;
  createdAt: string;
};
