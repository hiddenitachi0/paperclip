// DUR-4898 (film studio Phase 0): every storyline is safe for work (SFW) unless
// its owner switched it to mature. This module turns that rating into the
// rules each request obeys: which models and LoRAs may be used, what the
// Sogni content filter is set to, and the words added to a prompt. The deny
// lists are the plugin SDK's (packages/plugins/sdk/src/media/safety.ts), so
// the server and the Media Studio plugin refuse the same things.
//
// Two rules sit above everything here:
//   * nothing works around a provider's own filter (the filter is never
//     turned off here; a mature film only stops being forced ON), and
//   * a missing or unreadable rating is SFW.

import {
  applyLoraRules,
  evaluateModel,
  readContentMode,
  withSfwNegativePrompt,
  withSfwPositiveWords,
  withSfwPromptWords,
  type ContentMode,
  type SogniLoraInfo,
} from "@paperclipai/plugin-sdk/media";
import { unprocessable } from "../errors.js";

/** Sogni's limit on the "things to avoid" text (the plugin's SOGNI_NEGATIVE_PROMPT_MAX). */
const SOGNI_NEGATIVE_PROMPT_MAX = 1000;

/** The rating of a storyline row; anything unreadable is "sfw". */
export function filmContentMode(storyline: { contentRating?: unknown } | null | undefined): ContentMode {
  return readContentMode(storyline?.contentRating);
}

/** Stops a request that names a model a SFW film may not use (spicy, uncensored, Dark Beast, 10Eros, ...). A mature film may use them. */
export function assertFilmModelAllowed(model: string | null | undefined, mode: ContentMode): void {
  const trimmed = model?.trim();
  if (!trimmed) return;
  const verdict = evaluateModel({ id: trimmed }, mode);
  if (!verdict.allowed) throw unprocessable(`${verdict.message} An owner can switch the film to mature, or pick another model.`);
}

export interface FilmLoraOutcome<T extends { id: string }> {
  loras: T[];
  /** One plain sentence per LoRA left out of the request. */
  notes: string[];
}

/**
 * The LoRAs a film request may carry. A filter-bypass LoRA stops the request
 * in every film; in SFW, flagged, anatomy-slider and unreviewed LoRAs are
 * dropped with a note.
 */
export function filmLoras<T extends { id: string }>(loras: readonly T[], mode: ContentMode, known: readonly SogniLoraInfo[] | null): FilmLoraOutcome<T> {
  const result = applyLoraRules(loras, mode, known);
  const [refused] = result.refused;
  if (refused) throw unprocessable(refused.message);
  return { loras: result.kept, notes: result.notes };
}

/**
 * The Sogni content filter for one request. In a SFW film it is ON, whatever
 * the look says. In a mature film it follows the look (off only through a look
 * an owner or admin saved that way): a mature film never turns it off by
 * itself. The note says so when a look's filter-off setting was overridden.
 */
export function filmContentFilter(mode: ContentMode, lookFilterOn: boolean | null): { safeContentFilter: boolean; note: string | null } {
  if (mode === "sfw") {
    return {
      safeContentFilter: true,
      note: lookFilterOn === false ? "The look has Sogni's content filter off, but this film is safe for work, so the filter stayed on." : null,
    };
  }
  return { safeContentFilter: lookFilterOn !== false, note: null };
}

export interface FilmPictureText {
  prompt: string;
  negativePrompt?: string;
}

/**
 * The SFW words for a picture. "Fully clothed." plus the avoid-list go in the
 * prompt where the request has no negative-prompt field (edit_image, Fal);
 * where it has one (Sogni generate_image) the avoid-list goes there, and
 * falls back to the prompt when it would not fit. A mature film is unchanged.
 */
export function filmPictureText(mode: ContentMode, text: FilmPictureText, hasNegativeField: boolean): FilmPictureText {
  if (mode !== "sfw") return text;
  if (hasNegativeField) {
    const negativePrompt = withSfwNegativePrompt(text.negativePrompt, SOGNI_NEGATIVE_PROMPT_MAX);
    if (negativePrompt !== null) return { prompt: withSfwPositiveWords(text.prompt), negativePrompt };
  }
  return { prompt: withSfwPromptWords(text.prompt), ...(text.negativePrompt ? { negativePrompt: text.negativePrompt } : {}) };
}

/** The SFW words for a video clip. No video request takes a negative prompt yet (Sogni video waits for the protocol bump), so all of it goes in the prompt. */
export function filmVideoPrompt(mode: ContentMode, prompt: string): string {
  return mode === "sfw" ? withSfwPromptWords(prompt) : prompt;
}
