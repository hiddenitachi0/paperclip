import { z } from "zod";

/**
 * DUR-3978 slice 2: connecting a Telegram bot from the app.
 *
 * A BotFather token looks like `8123456789:AAH-x9_Q...`: the part before the
 * colon is the bot's public account id, the part after it is the secret. The
 * pattern below is deliberately loose about the secret half's exact length
 * (Telegram has changed it before) and strict about the shape, so a pasted
 * bot *username* or a half-copied token is refused here, in plain language,
 * rather than becoming a silent 401 from Telegram hours later.
 */
export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{30,}$/;

/** Telegram user ids are 64-bit integers, so they travel as digit strings. */
export const TELEGRAM_USER_ID_PATTERN = /^[1-9]\d{0,18}$/;

export const MAX_TELEGRAM_BOT_ALLOWED_USERS = 50;

const telegramBotTokenSchema = z
  .string()
  .trim()
  .min(1, "Lim inn tokenet fra BotFather først.")
  .max(512)
  .refine((value) => TELEGRAM_BOT_TOKEN_PATTERN.test(value), {
    message:
      "Dette ser ikke ut som et bot-token fra BotFather. Det skal se slik ut: 8123456789:AAH… — tall, kolon, og en lang bokstavrekke, alt på én linje.",
  });

export const createTelegramBotSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().trim().min(1, "Gi boten et navn.").max(80),
  token: telegramBotTokenSchema,
  /**
   * The link base used in the messages this bot sends. Optional: the bridge
   * falls back to the instance's own UI address when it is not set, which is
   * right for every company on a single-instance install.
   */
  uiBase: z.string().trim().url().max(500).optional().nullable(),
});

export const rotateTelegramBotTokenSchema = z.object({
  token: telegramBotTokenSchema,
});

export const updateTelegramBotAllowedUsersSchema = z.object({
  telegramUserIds: z
    .array(
      z
        .string()
        .trim()
        .refine((value) => TELEGRAM_USER_ID_PATTERN.test(value), {
          message: "En Telegram-ID er bare tall, for eksempel 123456789.",
        }),
    )
    .max(MAX_TELEGRAM_BOT_ALLOWED_USERS),
});

export type CreateTelegramBotInput = z.infer<typeof createTelegramBotSchema>;
export type RotateTelegramBotTokenInput = z.infer<typeof rotateTelegramBotTokenSchema>;
export type UpdateTelegramBotAllowedUsersInput = z.infer<typeof updateTelegramBotAllowedUsersSchema>;
