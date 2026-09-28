import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square, Volume2 } from "lucide-react";
import { SPEECH_MAX_AUDIO_SECONDS } from "@paperclipai/shared";
import { blobToBase64, playSpeech, speechApi } from "../api/speech";
import { ApiError } from "../api/client";
import { Button } from "@/components/ui/button";

/**
 * Voice in the in-app quick-agent chat: a mic button that records in the
 * browser (MediaRecorder) and turns the recording into text through the same
 * speech endpoint the Telegram bot uses, and a speaker button that reads one
 * answer aloud. Both use the company's OpenAI key from Connections → Telegram
 * → Voice messages, and count against the same daily allowance.
 */

function speechErrorText(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : err instanceof Error && err.message ? err.message : fallback;
}

export function canRecordInBrowser(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export function ChatMicButton({
  companyId,
  disabled,
  onTranscript,
  onError,
}: {
  companyId: string;
  disabled?: boolean;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<"idle" | "recording" | "working">("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
    },
    [],
  );

  if (!canRecordInBrowser()) return null;

  const start = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onError("The browser did not allow the microphone. Allow it for this page and try again.");
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      recorderRef.current = null;
      const type = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunks, { type });
      const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      setState("working");
      void (async () => {
        try {
          const result = await speechApi.transcribe(companyId, {
            audioBase64: await blobToBase64(blob),
            filename: type.includes("ogg") ? "recording.ogg" : type.includes("mp4") ? "recording.m4a" : "recording.webm",
            contentType: type,
            durationSeconds,
            source: "chat",
          });
          if (result.text.trim()) onTranscript(result.text.trim());
          else onError("No words were heard in that recording. Try again, or type it.");
        } catch (err) {
          onError(speechErrorText(err, "The recording could not be turned into text."));
        } finally {
          setState("idle");
        }
      })();
    });
    recorderRef.current = recorder;
    recorder.start();
    setState("recording");
    // Stop by itself at the same five minutes the server allows.
    timerRef.current = window.setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, SPEECH_MAX_AUDIO_SECONDS * 1000);
  };

  const stop = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };

  return (
    <Button
      type="button"
      variant={state === "recording" ? "destructive" : "outline"}
      size="icon"
      onClick={() => (state === "recording" ? stop() : void start())}
      disabled={disabled || state === "working"}
      aria-label={state === "recording" ? "Stop recording" : "Speak your message"}
      title={state === "recording" ? "Stop recording" : "Speak your message"}
      data-testid="chat-mic-button"
    >
      {state === "working" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : state === "recording" ? (
        <Square className="h-4 w-4" />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </Button>
  );
}

export function ChatSpeakButton({
  companyId,
  text,
  onError,
}: {
  companyId: string;
  text: string;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!text.trim()) return null;
  return (
    <button
      type="button"
      className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
      disabled={busy}
      aria-label="Read this answer aloud"
      title="Read this answer aloud"
      data-testid="chat-speak-button"
      onClick={() => {
        setBusy(true);
        void speechApi
          .speak(companyId, { text, source: "chat" })
          .then((result) => playSpeech(result))
          .catch((err) => onError(speechErrorText(err, "This answer could not be read aloud.")))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Volume2 className="h-3.5 w-3.5" />}
      Listen
    </button>
  );
}
