import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySecretBindings,
  companySecrets,
  companySpeechSettings,
  speechUsageEvents,
  telegramBots,
} from "@paperclipai/db";
import {
  SPEECH_DEFAULT_DAILY_SPEAK_CHARACTERS,
  SPEECH_DEFAULT_DAILY_TRANSCRIBE_SECONDS,
  SPEECH_DEFAULT_VOICE,
  SPEECH_MAX_AUDIO_BYTES,
  SPEECH_MAX_AUDIO_SECONDS,
  SPEECH_MAX_SPOKEN_CHARACTERS,
  SPEECH_VOICE_IDS,
  type SpeechSettings,
  type SpeechSpeakResult,
  type SpeechTranscribeResult,
  type SpeechUsageSource,
  type UpdateSpeechSettingsInput,
} from "@paperclipai/shared";
import { HttpError, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { scrubLaneASecrets } from "./lane-a-providers.js";
import { secretService } from "./secrets.js";

/**
 * Voice messages: speech-to-text for a voice message coming in (Telegram, or
 * the mic in the in-app chat) and text-to-speech for an answer read aloud.
 *
 * The provider is OpenAI, called with a company secret (an OpenAI API key)
 * the operator picks under Connections -> Telegram. The key is bound through
 * company_secret_bindings (target 'speech', target id = the company id), so
 * every read of it is authorised and audited like any other credential read.
 * It lives in memory for one call and is never logged or returned.
 *
 * Every call is counted in speech_usage_events against a per-company daily
 * allowance (UTC days), and refused in plain words once it is used up.
 */

/**
 * The provider models, in one place. Chosen 28 Sep 2026 from OpenAI's docs as
 * the cheapest good ones:
 *   - speech-to-text: gpt-4o-mini-transcribe, est. $0.003 per minute of audio
 *     (half of gpt-4o-transcribe / whisper-1 at $0.006), auto-detects the
 *     language (Norwegian and English both work);
 *   - text-to-speech: gpt-4o-mini-tts, $0.60 per 1M text tokens in + $12 per
 *     1M audio tokens out (about $0.015 per minute of speech), OpenAI's
 *     "newest and most reliable" speech model; it can answer in Ogg Opus,
 *     which is what a Telegram voice message is.
 */
export const SPEECH_MODELS = {
  transcribe: "gpt-4o-mini-transcribe",
  speak: "gpt-4o-mini-tts",
} as const;

export const SPEECH_OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Where the company's key binding lives (company_secret_bindings.config_path). */
export const SPEECH_KEY_CONFIG_PATH = "openai_api_key";
const SPEECH_TIMEOUT_MS = 90_000;
/** Upper bound on the audio the speech model sends back. */
const SPEECH_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** A little slack over five minutes, for how different players round. */
const SPEECH_DURATION_TOLERANCE_SECONDS = 2;
/** Said at the end when only the start of a long answer is read aloud. */
export const SPEECH_REST_IN_TEXT = "The rest is in the text.";

// ─── Pure helpers (exported for the tests) ─────────────────────────────────

/**
 * How long an Ogg Opus recording is (a Telegram voice message), from the
 * granule position of its last page, minus the encoder's pre-skip. Null when
 * the bytes are not Ogg Opus or cannot be read.
 */
export function oggOpusDurationSeconds(bytes: Buffer): number | null {
  if (bytes.length < 28 || bytes.subarray(0, 4).toString("latin1") !== "OggS") return null;
  // OpusHead is the first packet: "OpusHead", version, channels, pre-skip (u16 LE).
  const headAt = bytes.indexOf("OpusHead", 0, "latin1");
  if (headAt < 0 || headAt > 200 || headAt + 12 > bytes.length) return null;
  const preSkip = bytes.readUInt16LE(headAt + 10);
  const lastPage = bytes.lastIndexOf("OggS", bytes.length - 4, "latin1");
  if (lastPage < 0 || lastPage + 14 > bytes.length) return null;
  const granule = bytes.readBigInt64LE(lastPage + 6);
  if (granule <= 0n) return null;
  const samples = Number(granule) - preSkip;
  if (!Number.isFinite(samples) || samples <= 0) return null;
  // Opus granule positions always count 48 kHz samples.
  return samples / 48_000;
}

/**
 * Seconds counted against the daily allowance: read from the recording when
 * it is Ogg Opus, else what the caller says it is, else a floor estimate from
 * the size (32 kbit/s). Never less than one second.
 */
export function billableAudioSeconds(bytes: Buffer, declaredSeconds?: number | null): number {
  const measured = oggOpusDurationSeconds(bytes);
  const declared = typeof declaredSeconds === "number" && declaredSeconds > 0 ? declaredSeconds : null;
  const estimate = measured ?? declared ?? bytes.length / 4_000;
  return Math.max(1, Math.ceil(estimate));
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s)>\]]+/gi;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * The part of an answer worth reading aloud: no links, no file ids, no
 * formatting marks, no code blocks, and at most `max` characters, ending on a
 * sentence where possible, followed by "The rest is in the text."
 */
export function prepareSpokenText(
  text: string,
  max: number = SPEECH_MAX_SPOKEN_CHARACTERS,
): { text: string; truncated: boolean } {
  let out = String(text ?? "");
  out = out.replace(/```[\s\S]*?```/g, " ");
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  out = out.replace(URL_PATTERN, " ");
  out = out.replace(UUID_PATTERN, " ");
  out = out.replace(/`+/g, "");
  out = out.replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "");
  out = out.replace(/[*_~|]{1,3}/g, "");
  out = out.replace(/\(\s*\)/g, " ");
  out = out.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
  if (out.length <= max) return { text: out, truncated: false };
  const room = Math.max(1, max - SPEECH_REST_IN_TEXT.length - 1);
  const head = out.slice(0, room);
  const sentenceEnd = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
    head.lastIndexOf("\n"),
  );
  const cut = sentenceEnd > room / 2 ? head.slice(0, sentenceEnd + 1) : head.replace(/\s+\S*$/, "");
  return { text: `${cut.trim()} ${SPEECH_REST_IN_TEXT}`, truncated: true };
}

/** Start of today in UTC: the allowance resets at midnight UTC. */
export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function audioExtension(filename?: string | null, contentType?: string | null): string {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(filename ?? "")?.[1]?.toLowerCase();
  const allowed = new Set(["ogg", "oga", "opus", "mp3", "mp4", "m4a", "mpeg", "mpga", "wav", "webm", "flac"]);
  if (fromName && allowed.has(fromName)) {
    // Telegram names voice files .oga; OpenAI knows the same container as .ogg.
    return fromName === "oga" || fromName === "opus" ? "ogg" : fromName;
  }
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("ogg") || type.includes("opus")) return "ogg";
  if (type.includes("webm")) return "webm";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "m4a";
  if (type.includes("wav")) return "wav";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  return "ogg";
}

function sniffAudioType(bytes: Buffer, fallback: string | null): { contentType: string; oggOpus: boolean } {
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("latin1") === "OggS") {
    return { contentType: "audio/ogg", oggOpus: bytes.indexOf("OpusHead", 0, "latin1") >= 0 };
  }
  if (bytes.length >= 3 && (bytes.subarray(0, 3).toString("latin1") === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0))) {
    return { contentType: "audio/mpeg", oggOpus: false };
  }
  const type = (fallback ?? "").split(";")[0]!.trim().toLowerCase();
  return { contentType: type.startsWith("audio/") ? type : "application/octet-stream", oggOpus: false };
}

// ─── The provider ───────────────────────────────────────────────────────────

export type SpeechProviderErrorKind = "auth" | "rate_limit" | "upstream" | "network";

export class SpeechProviderError extends Error {
  readonly kind: SpeechProviderErrorKind;
  readonly status: number | null;
  constructor(kind: SpeechProviderErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "SpeechProviderError";
    this.kind = kind;
    this.status = status;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("the answer was too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function callOpenAi(
  input: { apiKey: string; fetchImpl: typeof fetch; path: string; init: RequestInit; timeoutMs?: number },
): Promise<{ response: Response; body: Buffer }> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? SPEECH_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await input.fetchImpl(`${SPEECH_OPENAI_BASE_URL}${input.path}`, {
        ...input.init,
        headers: { ...(input.init.headers as Record<string, string> | undefined), authorization: `Bearer ${input.apiKey}` },
        signal: controller.signal,
        // The key travels as a header; never follow a redirect elsewhere.
        redirect: "error",
      });
    } catch (err) {
      throw new SpeechProviderError(
        "network",
        controller.signal.aborted
          ? `OpenAI did not answer within ${Math.round(timeoutMs / 1000)} seconds.`
          : `Could not reach OpenAI: ${scrubLaneASecrets(err instanceof Error ? err.message : String(err), input.apiKey)}`,
      );
    }
    let body: Buffer;
    try {
      body = await readCapped(response, SPEECH_MAX_RESPONSE_BYTES);
    } catch (err) {
      throw new SpeechProviderError(
        "network",
        controller.signal.aborted
          ? `OpenAI did not finish answering within ${Math.round(timeoutMs / 1000)} seconds.`
          : `OpenAI sent an answer Paperclip could not read: ${scrubLaneASecrets(err instanceof Error ? err.message : String(err), input.apiKey)}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new SpeechProviderError("auth", "OpenAI refused the key.", response.status);
    }
    if (response.status === 429) {
      throw new SpeechProviderError("rate_limit", "OpenAI is busy or the key's OpenAI limit is reached.", 429);
    }
    if (!response.ok) {
      const detail = scrubLaneASecrets(body.toString("utf8").slice(0, 300), input.apiKey);
      throw new SpeechProviderError("upstream", `OpenAI answered ${response.status}: ${detail}`, response.status);
    }
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Speech-to-text. The language is left to the model to detect. */
export async function transcribeWithOpenAi(input: {
  apiKey: string;
  audio: Buffer;
  filename: string;
  contentType: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(input.audio)], { type: input.contentType }), input.filename);
  form.append("model", SPEECH_MODELS.transcribe);
  form.append("response_format", "json");
  const { apiKey } = input;
  const { body } = await callOpenAi({
    apiKey,
    fetchImpl: input.fetchImpl ?? globalThis.fetch,
    path: "/audio/transcriptions",
    init: { method: "POST", body: form },
  });
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw new SpeechProviderError("upstream", "OpenAI answered with something that is not JSON.");
  }
  const text = (payload as { text?: unknown })?.text;
  if (typeof text !== "string") {
    throw new SpeechProviderError("upstream", "OpenAI's answer had no text in it.");
  }
  return text.trim();
}

/** Text-to-speech, asked for as Opus (OpenAI sends it in an Ogg container). */
export async function speakWithOpenAi(input: {
  apiKey: string;
  text: string;
  voice: string;
  fetchImpl?: typeof fetch;
}): Promise<{ audio: Buffer; contentType: string; oggOpus: boolean }> {
  const { response, body } = await callOpenAi({
    apiKey: input.apiKey,
    fetchImpl: input.fetchImpl ?? globalThis.fetch,
    path: "/audio/speech",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: SPEECH_MODELS.speak,
        voice: input.voice,
        input: input.text,
        response_format: "opus",
      }),
    },
  });
  if (body.length === 0) throw new SpeechProviderError("upstream", "OpenAI sent no audio.");
  return { audio: body, ...sniffAudioType(body, response.headers.get("content-type")) };
}

// ─── The service ────────────────────────────────────────────────────────────

type SpeechActor = { userId: string | null };

function providerRefusal(err: SpeechProviderError): HttpError {
  if (err.kind === "auth") {
    return new HttpError(
      503,
      "OpenAI refused the saved key for voice messages. Replace the key under Connections, or pick another one under Connections → Telegram.",
      { code: "SPEECH_KEY_REFUSED" },
    );
  }
  if (err.kind === "rate_limit") {
    return new HttpError(429, "OpenAI is busy right now. Try again in a minute.", { code: "SPEECH_PROVIDER_BUSY" });
  }
  return new HttpError(502, `The speech service did not work this time. ${err.message}`, {
    code: "SPEECH_PROVIDER_FAILED",
  });
}

export function speechService(db: Db, deps: { fetchImpl?: typeof fetch; now?: () => Date } = {}) {
  const secrets = secretService(db);
  const now = deps.now ?? (() => new Date());

  async function readKeyBinding(companyId: string) {
    const [binding] = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "speech"),
          eq(companySecretBindings.targetId, companyId),
          eq(companySecretBindings.configPath, SPEECH_KEY_CONFIG_PATH),
        ),
      );
    return binding ?? null;
  }

  async function readCaps(companyId: string) {
    const [row] = await db
      .select()
      .from(companySpeechSettings)
      .where(eq(companySpeechSettings.companyId, companyId));
    return {
      dailyTranscribeSecondsCap: row?.dailyTranscribeSecondsCap ?? SPEECH_DEFAULT_DAILY_TRANSCRIBE_SECONDS,
      dailySpeakCharactersCap: row?.dailySpeakCharactersCap ?? SPEECH_DEFAULT_DAILY_SPEAK_CHARACTERS,
    };
  }

  async function usedToday(companyId: string): Promise<{ transcribeSeconds: number; speakCharacters: number }> {
    const rows = await db
      .select({ kind: speechUsageEvents.kind, total: sql<string>`coalesce(sum(${speechUsageEvents.amount}), 0)` })
      .from(speechUsageEvents)
      .where(and(eq(speechUsageEvents.companyId, companyId), gte(speechUsageEvents.createdAt, startOfUtcDay(now()))))
      .groupBy(speechUsageEvents.kind);
    const total = (kind: string) => Number(rows.find((row) => row.kind === kind)?.total ?? 0);
    return { transcribeSeconds: total("transcribe"), speakCharacters: total("speak") };
  }

  async function getSettings(companyId: string): Promise<SpeechSettings> {
    const [binding, caps, used] = await Promise.all([readKeyBinding(companyId), readCaps(companyId), usedToday(companyId)]);
    let keySecretName: string | null = null;
    if (binding) {
      const [secret] = await db
        .select({ name: companySecrets.name, status: companySecrets.status })
        .from(companySecrets)
        .where(and(eq(companySecrets.id, binding.secretId), eq(companySecrets.companyId, companyId)));
      keySecretName = secret && secret.status !== "deleted" ? secret.name : null;
    }
    return {
      companyId,
      keySecretId: binding?.secretId ?? null,
      keySecretName,
      ...caps,
      usedToday: used,
      models: { transcribe: SPEECH_MODELS.transcribe, speak: SPEECH_MODELS.speak },
    };
  }

  async function updateSettings(companyId: string, input: UpdateSpeechSettingsInput, actor: SpeechActor) {
    if (input.keySecretId !== undefined) {
      if (input.keySecretId === null) {
        await secrets.syncSecretRefsForTarget(companyId, { targetType: "speech", targetId: companyId }, [], {
          replaceAll: true,
        });
      } else {
        const [secret] = await db
          .select({ id: companySecrets.id, kind: companySecrets.kind, status: companySecrets.status })
          .from(companySecrets)
          .where(and(eq(companySecrets.id, input.keySecretId), eq(companySecrets.companyId, companyId)));
        if (!secret || secret.status === "deleted") throw notFound("That saved key was not found in this company.");
        if (secret.kind !== null && secret.kind !== "openai_api_key") {
          throw unprocessable("Voice messages need an OpenAI API key. That saved secret is something else.", {
            code: "SPEECH_KEY_WRONG_KIND",
          });
        }
        await secrets.syncSecretRefsForTarget(
          companyId,
          { targetType: "speech", targetId: companyId },
          [{ secretId: secret.id, configPath: SPEECH_KEY_CONFIG_PATH, label: "Voice messages (speech)" }],
          { replaceAll: true },
        );
      }
    }
    if (input.dailyTranscribeSecondsCap !== undefined || input.dailySpeakCharactersCap !== undefined) {
      const current = await readCaps(companyId);
      const next = {
        dailyTranscribeSecondsCap: input.dailyTranscribeSecondsCap ?? current.dailyTranscribeSecondsCap,
        dailySpeakCharactersCap: input.dailySpeakCharactersCap ?? current.dailySpeakCharactersCap,
      };
      await db
        .insert(companySpeechSettings)
        .values({ companyId, ...next, updatedByUserId: actor.userId })
        .onConflictDoUpdate({
          target: companySpeechSettings.companyId,
          set: { ...next, updatedByUserId: actor.userId, updatedAt: new Date() },
        });
    }
    return getSettings(companyId);
  }

  /** The company's OpenAI key for one call, or a plain refusal. */
  async function resolveKey(companyId: string, actor: SpeechActor): Promise<string> {
    const binding = await readKeyBinding(companyId);
    if (!binding) {
      throw new HttpError(
        503,
        "Voice messages are not set up yet: pick an OpenAI key under Connections → Telegram → Voice messages.",
        { code: "SPEECH_KEY_MISSING" },
      );
    }
    try {
      return await secrets.resolveSecretValue(companyId, binding.secretId, "latest", {
        consumerType: "speech",
        consumerId: companyId,
        configPath: SPEECH_KEY_CONFIG_PATH,
        actorType: actor.userId ? "user" : "system",
        actorId: actor.userId,
      });
    } catch (err) {
      // Never the value, never the upstream message.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), companyId },
        "speech: the company's OpenAI key could not be resolved",
      );
      throw new HttpError(
        503,
        "The saved OpenAI key for voice messages could not be used. Pick it again under Connections → Telegram → Voice messages.",
        { code: "SPEECH_KEY_UNRESOLVED" },
      );
    }
  }

  async function assertUnderCap(companyId: string, kind: "transcribe" | "speak", amount: number) {
    const [caps, used] = await Promise.all([readCaps(companyId), usedToday(companyId)]);
    if (kind === "transcribe") {
      const cap = caps.dailyTranscribeSecondsCap;
      if (used.transcribeSeconds + amount > cap) {
        const minutes = Math.max(1, Math.round(cap / 60));
        const allowance = minutes === 1 ? "1 minute" : `${minutes} minutes`;
        throw tooManyRequests(
          cap === 0
            ? "Voice messages are switched off for this company (the daily allowance is 0 minutes)."
            : `Today's allowance for voice messages (${allowance}) is used up. It starts again at midnight UTC, or the owner can raise it under Connections → Telegram.`,
          { code: "SPEECH_DAILY_LIMIT", reason: "speech_daily_limit", kind, limit: cap, used: used.transcribeSeconds },
        );
      }
      return;
    }
    const cap = caps.dailySpeakCharactersCap;
    if (used.speakCharacters + amount > cap) {
      throw tooManyRequests(
        cap === 0
          ? "Reading answers aloud is switched off for this company (the daily allowance is 0 characters)."
          : `Today's allowance for reading answers aloud (${cap.toLocaleString("en-US")} characters) is used up. It starts again at midnight UTC, or the owner can raise it under Connections → Telegram.`,
        { code: "SPEECH_DAILY_LIMIT", reason: "speech_daily_limit", kind, limit: cap, used: used.speakCharacters },
      );
    }
  }

  /** A telegramBotId given by the caller counts only when it is this company's bot. */
  async function botInCompany(companyId: string, botId: string | undefined) {
    if (!botId) return null;
    const [bot] = await db
      .select({ id: telegramBots.id, voice: telegramBots.voice })
      .from(telegramBots)
      .where(and(eq(telegramBots.id, botId), eq(telegramBots.companyId, companyId)));
    if (!bot) throw notFound("Telegram bot not found");
    return bot;
  }

  async function recordUsage(input: {
    companyId: string;
    kind: "transcribe" | "speak";
    amount: number;
    model: string;
    source: SpeechUsageSource;
    telegramBotId: string | null;
    actor: SpeechActor;
  }) {
    await db.insert(speechUsageEvents).values({
      companyId: input.companyId,
      kind: input.kind,
      amount: input.amount,
      model: input.model,
      source: input.source,
      telegramBotId: input.telegramBotId,
      actorUserId: input.actor.userId,
    });
  }

  async function transcribe(
    companyId: string,
    input: {
      audioBase64: string;
      filename?: string;
      contentType?: string;
      durationSeconds?: number;
      source: SpeechUsageSource;
      telegramBotId?: string;
    },
    actor: SpeechActor,
  ): Promise<SpeechTranscribeResult> {
    const cleaned = input.audioBase64.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
      throw unprocessable("The recording did not arrive intact. Try again.", { code: "SPEECH_AUDIO_UNREADABLE" });
    }
    const audio = Buffer.from(cleaned, "base64");
    if (audio.length === 0) {
      throw unprocessable("The recording was empty.", { code: "SPEECH_AUDIO_EMPTY" });
    }
    if (audio.length > SPEECH_MAX_AUDIO_BYTES) {
      throw unprocessable("That recording is larger than 20 MB. Please send a shorter one.", {
        code: "SPEECH_AUDIO_TOO_LARGE",
      });
    }
    const seconds = billableAudioSeconds(audio, input.durationSeconds);
    if (seconds > SPEECH_MAX_AUDIO_SECONDS + SPEECH_DURATION_TOLERANCE_SECONDS) {
      throw unprocessable("That recording is longer than 5 minutes. Please send a shorter one, or type it.", {
        code: "SPEECH_AUDIO_TOO_LONG",
      });
    }
    const bot = await botInCompany(companyId, input.telegramBotId);
    await assertUnderCap(companyId, "transcribe", seconds);
    const apiKey = await resolveKey(companyId, actor);
    const extension = audioExtension(input.filename, input.contentType);
    const contentType =
      extension === "ogg" ? "audio/ogg" : extension === "webm" ? "audio/webm" : extension === "wav" ? "audio/wav"
        : extension === "m4a" ? "audio/mp4" : extension === "mp3" ? "audio/mpeg" : `audio/${extension}`;
    let text: string;
    try {
      text = await transcribeWithOpenAi({
        apiKey,
        audio,
        filename: `voice.${extension}`,
        contentType,
        fetchImpl: deps.fetchImpl,
      });
    } catch (err) {
      if (err instanceof SpeechProviderError) {
        logger.warn({ companyId, kind: err.kind, status: err.status, message: err.message }, "speech: transcription failed");
        throw providerRefusal(err);
      }
      throw err;
    }
    await recordUsage({
      companyId,
      kind: "transcribe",
      amount: seconds,
      model: SPEECH_MODELS.transcribe,
      source: input.source,
      telegramBotId: bot?.id ?? null,
      actor,
    });
    return { text, billedSeconds: seconds, model: SPEECH_MODELS.transcribe };
  }

  async function speak(
    companyId: string,
    input: { text: string; voice?: string; source: SpeechUsageSource; telegramBotId?: string },
    actor: SpeechActor,
  ): Promise<SpeechSpeakResult> {
    const bot = await botInCompany(companyId, input.telegramBotId);
    const prepared = prepareSpokenText(input.text);
    if (!prepared.text) {
      throw unprocessable("There is nothing in that answer to read aloud.", { code: "SPEECH_NOTHING_TO_SAY" });
    }
    const voiceIds = new Set<string>(SPEECH_VOICE_IDS);
    const requested = input.voice ?? bot?.voice ?? null;
    const voice = requested && voiceIds.has(requested) ? requested : SPEECH_DEFAULT_VOICE;
    const characters = prepared.text.length;
    await assertUnderCap(companyId, "speak", characters);
    const apiKey = await resolveKey(companyId, actor);
    let spoken: { audio: Buffer; contentType: string; oggOpus: boolean };
    try {
      spoken = await speakWithOpenAi({ apiKey, text: prepared.text, voice, fetchImpl: deps.fetchImpl });
    } catch (err) {
      if (err instanceof SpeechProviderError) {
        logger.warn({ companyId, kind: err.kind, status: err.status, message: err.message }, "speech: text-to-speech failed");
        throw providerRefusal(err);
      }
      throw err;
    }
    await recordUsage({
      companyId,
      kind: "speak",
      amount: characters,
      model: SPEECH_MODELS.speak,
      source: input.source,
      telegramBotId: bot?.id ?? null,
      actor,
    });
    return {
      audioBase64: spoken.audio.toString("base64"),
      contentType: spoken.contentType,
      oggOpus: spoken.oggOpus,
      characters,
      truncated: prepared.truncated,
      voice,
      model: SPEECH_MODELS.speak,
    };
  }

  return { getSettings, updateSettings, usedToday, transcribe, speak };
}

export type SpeechService = ReturnType<typeof speechService>;
