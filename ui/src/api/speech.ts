import type { SpeechSettings, SpeechSpeakResult, SpeechTranscribeResult } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Voice messages: the company's speech settings, and the two speech calls
 * (a recording -> text, a text -> a recording). The OpenAI key itself never
 * comes back; only the name of the saved secret that holds it.
 */
export const speechApi = {
  getSettings: (companyId: string) => api.get<SpeechSettings>(`/companies/${companyId}/speech-settings`),
  updateSettings: (
    companyId: string,
    data: { keySecretId?: string | null; dailyTranscribeSecondsCap?: number; dailySpeakCharactersCap?: number },
  ) => api.put<SpeechSettings>(`/companies/${companyId}/speech-settings`, data),
  transcribe: (
    companyId: string,
    data: { audioBase64: string; filename?: string; contentType?: string; durationSeconds?: number; source?: "chat" },
  ) => api.post<SpeechTranscribeResult>(`/companies/${companyId}/speech/transcribe`, data),
  speak: (companyId: string, data: { text: string; voice?: string; source?: "chat" | "preview" }) =>
    api.post<SpeechSpeakResult>(`/companies/${companyId}/speech/speak`, data),
};

/** Play a recording the speak call returned. Resolves when it starts playing. */
export async function playSpeech(result: Pick<SpeechSpeakResult, "audioBase64" | "contentType">): Promise<HTMLAudioElement> {
  const bytes = Uint8Array.from(atob(result.audioBase64), (ch) => ch.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: result.contentType }));
  const audio = new Audio(url);
  audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
  try {
    await audio.play();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  return audio;
}

/** A Blob as base64 (without the data: prefix). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
  }
  return btoa(binary);
}
