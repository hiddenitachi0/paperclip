import Anthropic from "@anthropic-ai/sdk";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { STORYLINE_WRITER_NO_MODEL_MESSAGE } from "./video-storyline-company-model.js";

/**
 * The AI director (review, follow-up questions, rewrite proposals) makes
 * plain Anthropic calls. A failure there used to escape as a raw SDK error,
 * which the error handler turns into a bare 500 "Internal server error" --
 * meaningless to the person in the editor. These map every known failure to
 * a plain sentence with a non-500 status the editor can show as-is.
 */

/** Storyline Phase 0: the director runs on the company's own model, never the server-wide key. */
export const DIRECTOR_AI_NOT_CONFIGURED_MESSAGE = STORYLINE_WRITER_NO_MODEL_MESSAGE;

/**
 * Security review: shown (and stored on a failed director run) for any
 * failure that is not one of the specific cases below. The upstream error
 * text is never passed through -- it can carry provider internals, request
 * ids or echoed input -- only logged server-side.
 */
export const DIRECTOR_AI_GENERIC_FAILURE_MESSAGE = "The AI director could not answer this time. Try again in a moment.";

export function directorAiNotConfigured(): HttpError {
  return new HttpError(503, DIRECTOR_AI_NOT_CONFIGURED_MESSAGE);
}

/** instanceof that tolerates an SDK build (or test double) missing one of the error classes. */
function isInstance(err: unknown, ctor: unknown): boolean {
  return typeof ctor === "function" && err instanceof (ctor as new (...args: never[]) => unknown);
}

export function directorAiFailure(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  logger.warn({ err }, "video-storyline-director: AI call failed");
  if (isInstance(err, Anthropic.AuthenticationError) || isInstance(err, Anthropic.PermissionDeniedError)) {
    return new HttpError(502, "The AI director's key was refused. A company owner or admin can check it under Company settings → General → Helper.");
  }
  if (isInstance(err, Anthropic.RateLimitError)) {
    return new HttpError(503, "The AI director is busy right now (rate limited). Try again in a minute.");
  }
  if (isInstance(err, Anthropic.APIConnectionError)) {
    return new HttpError(502, "Could not reach the AI director service. Check the connection and try again.");
  }
  if (isInstance(err, Anthropic.APIError)) {
    const apiErr = err as { status?: unknown; message: string };
    const status = typeof apiErr.status === "number" ? apiErr.status : null;
    if (status !== null && status >= 500) {
      return new HttpError(502, "The AI director service had a problem on its side. Try again in a moment.");
    }
  }
  return new HttpError(502, DIRECTOR_AI_GENERIC_FAILURE_MESSAGE);
}

/** Runs one director model call, turning any failure into a plain-language HttpError. */
export async function callDirectorModel<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw directorAiFailure(err);
  }
}
