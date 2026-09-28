/**
 * Voice messages: what the app tells the operator about a company's speech
 * set-up (speech-to-text for voice messages in, text-to-speech for answers
 * read aloud). No key value ever travels in any of these shapes; the key is a
 * company secret and only its name is shown.
 */
export type SpeechSettings = {
  companyId: string;
  /** The company secret (an OpenAI API key) the speech calls use, if one is picked. */
  keySecretId: string | null;
  /** That secret's name, for the dropdown. Null when none is picked or it was deleted. */
  keySecretName: string | null;
  /** Speech-to-text allowance per day (UTC), in seconds of audio. */
  dailyTranscribeSecondsCap: number;
  /** Text-to-speech allowance per day (UTC), in characters read aloud. */
  dailySpeakCharactersCap: number;
  /** What has been used today (UTC). */
  usedToday: {
    transcribeSeconds: number;
    speakCharacters: number;
  };
  /** The provider models in use, for the settings page's small print. */
  models: {
    transcribe: string;
    speak: string;
  };
};

/** A voice message turned into text. */
export type SpeechTranscribeResult = {
  text: string;
  /** Seconds of audio counted against the daily allowance. */
  billedSeconds: number;
  model: string;
};

/** A text read aloud. */
export type SpeechSpeakResult = {
  /** The audio file, base64. */
  audioBase64: string;
  /** "audio/ogg" (Ogg Opus, fit for a Telegram voice message) or another audio type. */
  contentType: string;
  /** True when the audio is Ogg Opus, i.e. can be sent as a Telegram voice message. */
  oggOpus: boolean;
  /** Characters actually read aloud (after cleaning and shortening). */
  characters: number;
  /** True when the text was too long and only the start was read. */
  truncated: boolean;
  voice: string;
  model: string;
};
