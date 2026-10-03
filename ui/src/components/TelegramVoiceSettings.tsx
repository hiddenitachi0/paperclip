import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SPEECH_DEFAULT_VOICE,
  SPEECH_VOICES,
  TELEGRAM_VOICE_REPLY_MODES,
  TELEGRAM_VOICE_REPLY_MODE_LABELS,
  type TelegramBotSummary,
  type TelegramVoiceReplyMode,
} from "@paperclipai/shared";
import { playSpeech, speechApi } from "../api/speech";
import { secretsApi } from "../api/secrets";
import { telegramBotsApi } from "../api/telegramBots";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Voice messages, on the Telegram card under Connections.
 *
 * Company-wide (TelegramVoiceSection): which OpenAI key turns voice messages
 * into text and answers into speech, how much may be used per day, and what
 * was used today. Per bot (TelegramBotVoiceControls): when the bot reads its
 * answer aloud, and with which voice, with a Preview button to hear it.
 */

const SELECT_CLASS = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";
const PREVIEW_TEXT = "Hi, this is how I sound when I read an answer aloud. Hei, sånn høres jeg ut på norsk.";

function errorText(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

function minutesAndSeconds(total: number) {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} s`;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

export function TelegramVoiceSection({ companyId, readOnly = false }: { companyId: string; readOnly?: boolean }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [minutes, setMinutes] = useState("");
  const [characters, setCharacters] = useState("");
  const [error, setError] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: queryKeys.companies.speechSettings(companyId),
    queryFn: () => speechApi.getSettings(companyId),
  });
  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: !readOnly,
  });
  const settings = settingsQuery.data;

  useEffect(() => {
    if (!settings) return;
    setMinutes(String(Math.round(settings.dailyTranscribeSecondsCap / 60)));
    setCharacters(String(settings.dailySpeakCharactersCap));
  }, [settings?.dailyTranscribeSecondsCap, settings?.dailySpeakCharactersCap]);

  const updateMutation = useMutation({
    mutationFn: (data: Parameters<typeof speechApi.updateSettings>[1]) => speechApi.updateSettings(companyId, data),
    onSuccess: (_updated, data) => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.speechSettings(companyId) });
      pushToast({
        title: data.keySecretId !== undefined ? "Key for voice messages saved" : "Daily allowance saved",
        tone: "success",
      });
    },
    onError: (err) => setError(errorText(err, "Could not save the voice message settings")),
  });

  // OpenAI keys first, then secrets saved before kinds existed (which may be one).
  const keys = (secretsQuery.data ?? [])
    .filter((secret) => secret.status === "active" && (secret.kind === "openai_api_key" || secret.kind === null))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "openai_api_key" ? -1 : 1));

  const minutesNumber = Number(minutes);
  const charactersNumber = Number(characters);
  const capsValid =
    minutes.trim() !== "" && characters.trim() !== "" &&
    Number.isInteger(minutesNumber) && minutesNumber >= 0 && minutesNumber <= 1440 &&
    Number.isInteger(charactersNumber) && charactersNumber >= 0 && charactersNumber <= 10_000_000;
  const capsChanged =
    !!settings &&
    (minutesNumber * 60 !== settings.dailyTranscribeSecondsCap || charactersNumber !== settings.dailySpeakCharactersCap);

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="telegram-voice-section">
      <p className="text-sm font-medium">Voice messages</p>
      <p className="text-xs text-muted-foreground">
        Hold the mic in Telegram and speak: the bot writes down what you said, answers, and can read the answer
        aloud. This uses an OpenAI key saved under Connections.
      </p>
      {settingsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : settingsQuery.isError || !settings ? (
        <p className="text-sm text-destructive">
          Could not load the voice message settings:{" "}
          {settingsQuery.error instanceof Error ? settingsQuery.error.message : "unknown error"}
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor={`speech-key-${companyId}`}>
              OpenAI key for voice messages
            </label>
            {readOnly ? (
              <p className="text-sm" data-testid="speech-key-readonly">
                {settings.keySecretName ?? "None picked"}
              </p>
            ) : (
              <select
                id={`speech-key-${companyId}`}
                className={SELECT_CLASS}
                value={settings.keySecretId ?? ""}
                disabled={updateMutation.isPending}
                onChange={(event) => updateMutation.mutate({ keySecretId: event.target.value || null })}
              >
                <option value="">None — voice messages are off</option>
                {settings.keySecretId && !keys.some((key) => key.id === settings.keySecretId) && (
                  <option value={settings.keySecretId}>{settings.keySecretName ?? "A saved key that is gone"}</option>
                )}
                {keys.map((key) => (
                  <option key={key.id} value={key.id}>
                    {key.name}
                    {key.kind === null ? " (type not set)" : ""}
                  </option>
                ))}
              </select>
            )}
            {!settings.keySecretId && (
              <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="speech-no-key">
                No key picked, so voice messages are refused with a short explanation.
                {!readOnly && keys.length === 0 ? " Save an OpenAI API key under Connections first." : ""}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium" htmlFor={`speech-minutes-${companyId}`}>
                Listening per day (minutes)
              </label>
              <Input
                id={`speech-minutes-${companyId}`}
                inputMode="numeric"
                className="max-w-[8rem]"
                value={minutes}
                disabled={readOnly}
                onChange={(event) => setMinutes(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium" htmlFor={`speech-characters-${companyId}`}>
                Reading aloud per day (characters)
              </label>
              <Input
                id={`speech-characters-${companyId}`}
                inputMode="numeric"
                className="max-w-[10rem]"
                value={characters}
                disabled={readOnly}
                onChange={(event) => setCharacters(event.target.value)}
              />
            </div>
            {!readOnly && (
              <Button
                size="sm"
                variant="secondary"
                disabled={!capsValid || !capsChanged || updateMutation.isPending}
                onClick={() =>
                  updateMutation.mutate({
                    dailyTranscribeSecondsCap: minutesNumber * 60,
                    dailySpeakCharactersCap: charactersNumber,
                  })
                }
              >
                Save
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground" data-testid="speech-used-today">
            Used today: {minutesAndSeconds(settings.usedToday.transcribeSeconds)} of listening,{" "}
            {settings.usedToday.speakCharacters.toLocaleString("en-US")} characters read aloud. Starts again at
            midnight UTC.
          </p>
        </>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function TelegramBotVoiceControls({
  companyId,
  bot,
  readOnly = false,
}: {
  companyId: string;
  bot: TelegramBotSummary;
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [error, setError] = useState<string | null>(null);
  const voice = bot.voice ?? SPEECH_DEFAULT_VOICE;

  const voiceMutation = useMutation({
    mutationFn: (data: { voiceReplyMode?: TelegramVoiceReplyMode; voice?: string | null }) =>
      telegramBotsApi.setVoice(companyId, bot.id, data),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.telegramBots(companyId) });
    },
    onError: (err) => setError(errorText(err, "Could not change the voice settings")),
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      const result = await speechApi.speak(companyId, { text: PREVIEW_TEXT, voice, source: "preview" });
      try {
        await playSpeech(result);
      } catch {
        throw new Error("This browser could not play the sample.");
      }
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.speechSettings(companyId) });
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Could not play the sample";
      setError(message);
      pushToast({ title: message, tone: "warn" });
    },
  });

  return (
    <div className="flex flex-wrap items-end gap-2" data-testid={`telegram-bot-voice-${bot.id}`}>
      <div className="min-w-[12rem] space-y-1.5">
        <label className="text-xs font-medium" htmlFor={`telegram-voice-mode-${bot.id}`}>
          Reply with voice
        </label>
        <select
          id={`telegram-voice-mode-${bot.id}`}
          className={SELECT_CLASS}
          value={bot.voiceReplyMode}
          disabled={readOnly || voiceMutation.isPending}
          onChange={(event) => voiceMutation.mutate({ voiceReplyMode: event.target.value as TelegramVoiceReplyMode })}
        >
          {TELEGRAM_VOICE_REPLY_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {TELEGRAM_VOICE_REPLY_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>
      <div className="min-w-[10rem] space-y-1.5">
        <label className="text-xs font-medium" htmlFor={`telegram-voice-${bot.id}`}>
          Voice
        </label>
        <select
          id={`telegram-voice-${bot.id}`}
          className={SELECT_CLASS}
          value={voice}
          disabled={readOnly || voiceMutation.isPending}
          onChange={(event) => voiceMutation.mutate({ voice: event.target.value })}
        >
          {SPEECH_VOICES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => previewMutation.mutate()}
        disabled={previewMutation.isPending}
      >
        {previewMutation.isPending ? "Playing…" : "Preview"}
      </Button>
      {error && <p className="basis-full text-xs text-destructive">{error}</p>}
    </div>
  );
}
