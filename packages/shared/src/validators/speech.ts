import { z } from "zod";

/**
 * Voice messages (Telegram quick-agent chat, and the in-app chat): the
 * settings the operator picks, and what the speech routes accept.
 */

/** When a Telegram bot reads its answer aloud. */
export const TELEGRAM_VOICE_REPLY_MODES = ["never", "when_voice", "always"] as const;
export type TelegramVoiceReplyMode = (typeof TELEGRAM_VOICE_REPLY_MODES)[number];
export const TELEGRAM_VOICE_REPLY_MODE_DEFAULT: TelegramVoiceReplyMode = "when_voice";
export const TELEGRAM_VOICE_REPLY_MODE_LABELS: Record<TelegramVoiceReplyMode, string> = {
  never: "Never",
  when_voice: "When I sent a voice message",
  always: "Always",
};

/**
 * The voices the text-to-speech model offers (OpenAI gpt-4o-mini-tts). The
 * provider recommends Marin and Cedar for the best quality, so they come first.
 */
export const SPEECH_VOICES = [
  { id: "marin", label: "Marin (recommended)" },
  { id: "cedar", label: "Cedar (recommended)" },
  { id: "alloy", label: "Alloy" },
  { id: "ash", label: "Ash" },
  { id: "ballad", label: "Ballad" },
  { id: "coral", label: "Coral" },
  { id: "echo", label: "Echo" },
  { id: "fable", label: "Fable" },
  { id: "nova", label: "Nova" },
  { id: "onyx", label: "Onyx" },
  { id: "sage", label: "Sage" },
  { id: "shimmer", label: "Shimmer" },
  { id: "verse", label: "Verse" },
] as const;
export type SpeechVoice = (typeof SPEECH_VOICES)[number]["id"];
export const SPEECH_VOICE_IDS = SPEECH_VOICES.map((voice) => voice.id) as [SpeechVoice, ...SpeechVoice[]];
export const SPEECH_DEFAULT_VOICE: SpeechVoice = "marin";

/** Per-company daily allowances, unless the operator changes them. */
export const SPEECH_DEFAULT_DAILY_TRANSCRIBE_SECONDS = 60 * 60;
export const SPEECH_DEFAULT_DAILY_SPEAK_CHARACTERS = 50_000;
/** A voice message longer than this is refused. */
export const SPEECH_MAX_AUDIO_SECONDS = 5 * 60;
/** A voice message larger than this is refused (Telegram's own bot download limit is 20 MB). */
export const SPEECH_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** At most this much of an answer is read aloud; the rest stays in the text. */
export const SPEECH_MAX_SPOKEN_CHARACTERS = 1_500;
/** Where a speech call came from, for the usage log. */
export const SPEECH_USAGE_SOURCES = ["telegram", "chat", "preview"] as const;
export type SpeechUsageSource = (typeof SPEECH_USAGE_SOURCES)[number];

export const updateSpeechSettingsSchema = z
  .object({
    /** Pick (an id) or clear (null) the OpenAI key. Omitted = unchanged. */
    keySecretId: z.string().uuid().nullable().optional(),
    dailyTranscribeSecondsCap: z.number().int().min(0).max(24 * 60 * 60).optional(),
    dailySpeakCharactersCap: z.number().int().min(0).max(10_000_000).optional(),
  })
  .strict();

// Base64 of SPEECH_MAX_AUDIO_BYTES, plus a little room.
const MAX_AUDIO_BASE64_LENGTH = Math.ceil((SPEECH_MAX_AUDIO_BYTES * 4) / 3) + 16;

export const speechTranscribeSchema = z
  .object({
    /**
     * The recording, base64. Named `audioBase64` so the HTTP log blanks it on
     * a failed request (see server/src/middleware/redact-sensitive.ts): a
     * person's voice does not belong in a log file.
     */
    audioBase64: z.string().min(1).max(MAX_AUDIO_BASE64_LENGTH),
    /** e.g. "voice.ogg" or "recording.webm"; only the extension is used. */
    filename: z.string().trim().max(200).optional(),
    contentType: z.string().trim().max(100).optional(),
    /** How long the recording says it is (Telegram tells the bridge). */
    durationSeconds: z.number().min(0).max(24 * 60 * 60).optional(),
    source: z.enum(SPEECH_USAGE_SOURCES).default("chat"),
    telegramBotId: z.string().uuid().optional(),
  })
  .strict();

export const speechSpeakSchema = z
  .object({
    text: z.string().max(100_000),
    voice: z.enum(SPEECH_VOICE_IDS).optional(),
    source: z.enum(SPEECH_USAGE_SOURCES).default("chat"),
    telegramBotId: z.string().uuid().optional(),
  })
  .strict();

export const updateTelegramBotVoiceSchema = z
  .object({
    voiceReplyMode: z.enum(TELEGRAM_VOICE_REPLY_MODES).optional(),
    /** A voice id, or null for the default voice. */
    voice: z.enum(SPEECH_VOICE_IDS).nullable().optional(),
  })
  .strict()
  .refine((value) => value.voiceReplyMode !== undefined || value.voice !== undefined, {
    message: "Choose when to reply with voice, or a voice.",
  });

export type UpdateSpeechSettingsInput = z.infer<typeof updateSpeechSettingsSchema>;
export type SpeechTranscribeInput = z.infer<typeof speechTranscribeSchema>;
export type SpeechSpeakInput = z.infer<typeof speechSpeakSchema>;
export type UpdateTelegramBotVoiceInput = z.infer<typeof updateTelegramBotVoiceSchema>;
