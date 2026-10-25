import { ApiError } from "../../api/client";

/**
 * Plain words for anything that goes wrong in the Ask panel.
 *
 * The helper's own server errors are already written for people ("OpenRouter
 * is busy right now. Try again in a moment."), so those are shown as they
 * are. What is not — a bare status code, "Validation error", "Internal server
 * error", a dropped connection — is replaced with what happened and what to do.
 */

export type HelperErrorAction = "ask" | "investigate" | "load" | "save";

const GENERIC_SERVER_MESSAGES = new Set(["Validation error", "Internal server error", "Forbidden", "Not found", "Unauthorized"]);

function isGeneric(message: string): boolean {
  return !message.trim() || GENERIC_SERVER_MESSAGES.has(message.trim()) || /^Request failed: \d+$/.test(message.trim());
}

function looksLikeNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TypeError" || err.name === "AbortError") return true;
  return /failed to fetch|networkerror|load failed|network request failed/i.test(err.message);
}

export function helperErrorText(err: unknown, action: HelperErrorAction = "ask"): string {
  const what =
    action === "investigate"
      ? "The investigation could not start"
      : action === "load"
        ? "This could not be loaded"
        : action === "save"
          ? "The settings could not be saved"
          : "The helper could not answer";
  if (err instanceof ApiError) {
    const message = err.message ?? "";
    if (!isGeneric(message)) return message;
    switch (err.status) {
      case 400:
      case 422:
        return action === "ask"
          ? "The question could not be sent as it was. Try a shorter question, remove the pictures, or press “New conversation” and ask again."
          : `${what}: something in it could not be sent. Try a shorter question.`;
      case 401:
        return "You are signed out. Sign in again, then try once more.";
      case 403:
        return action === "save"
          ? "Only a company owner or admin can change these settings."
          : "You do not have access to the helper in this company.";
      case 404:
        return `${what}: Paperclip could not find what it needed. Reload the page and try again.`;
      case 408:
      case 504:
        return `${what} in time. Try again, or pick a faster model.`;
      case 413:
        return "The pictures are too large together. Remove one or two and try again.";
      case 429:
        return "Too many requests right now. Wait a minute and try again.";
      case 502:
      case 503:
        return `${what}: the model service is not answering right now. Try again in a moment, or pick another model.`;
      default:
        if (err.status >= 500) return `${what}: something went wrong on Paperclip's side. Try again in a moment.`;
        return `${what}. Try again.`;
    }
  }
  if (looksLikeNetworkFailure(err)) return "Could not reach Paperclip. Check your connection and try again.";
  if (err instanceof Error && err.message && !isGeneric(err.message)) return err.message;
  return `${what}. Try again.`;
}
