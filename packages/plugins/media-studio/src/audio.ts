// DUR-4062: audio generation on Fal — music/sound generation and
// text-to-speech/voice, both through Fal's queue API (fal-queue.ts). Routed
// through the same background-job engine as video (media-jobs.ts) for one
// consistent "start, poll, deliver" story, even though a short TTS line
// often finishes well inside a minute: the poll tick still picks it up on
// its next run, same as a slower music generation would.

import type { FetchImpl } from "./providers.js";
import { falQueueCancel, falQueuePoll, falQueueSubmit } from "./fal-queue.js";
import type { MediaJobHandle, MediaJobInput, MediaJobProvider, MediaPollOutcome } from "./media-jobs-types.js";

export const FAL_DEFAULT_MUSIC_MODEL = "cassetteai/music-generator";
export const FAL_DEFAULT_SPEECH_MODEL = "fal-ai/kokoro";

export class FalAudioProvider implements MediaJobProvider {
  readonly name = "fal";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchImpl,
    private readonly defaultMusicModel = FAL_DEFAULT_MUSIC_MODEL,
    private readonly defaultSpeechModel = FAL_DEFAULT_SPEECH_MODEL,
  ) {}

  async start(input: MediaJobInput): Promise<MediaJobHandle> {
    const mode = input.mode ?? "music";
    const model = input.model ?? (mode === "speech" ? this.defaultSpeechModel : this.defaultMusicModel);
    const body: Record<string, unknown> =
      mode === "speech"
        ? { text: input.prompt, ...(input.voice ? { voice: input.voice } : {}) }
        : { prompt: input.prompt, ...(typeof input.durationSeconds === "number" ? { duration: input.durationSeconds } : {}) };
    if (typeof input.seed === "number") body.seed = input.seed;
    const { requestId } = await falQueueSubmit(this.fetchImpl, this.apiKey, model, body);
    return { externalId: requestId, model, provider: this.name };
  }

  poll(handle: MediaJobHandle): Promise<MediaPollOutcome> {
    return falQueuePoll(this.fetchImpl, this.apiKey, handle, "audio");
  }

  cancel(handle: MediaJobHandle): Promise<void> {
    return falQueueCancel(this.fetchImpl, this.apiKey, handle);
  }
}

