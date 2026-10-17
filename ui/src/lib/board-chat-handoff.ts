import { HELPER_MESSAGE_MAX_CHARS, capHelperText, maskSecretLikeText } from "@paperclipai/shared";

/**
 * Hand-off from "Ask Paperclip" to Board chat.
 *
 * Ask only explains; Board chat can make changes. When a question in Ask is
 * really a request ("hire a marketing agent"), the panel offers "Do this in
 * Board chat": it opens /board-chat with the question and a one-line note of
 * where it was asked already typed into the message box. The person reviews
 * it and presses Send themselves; nothing is sent for them.
 *
 * The text travels in the router's navigation state (kept by the browser for
 * that one history entry), never in the URL, so it does not end up in the
 * address bar, server logs or shared links.
 */

/** What Board chat is, in one line: under its page title and as the sidebar item's hover text. */
export const BOARD_CHAT_SUBTITLE =
  "Talk to an AI board member that can make changes for you (hire agents, create tasks, change settings).";

/** Key in the router's location.state that carries the prefill. */
export const BOARD_CHAT_PREFILL_STATE_KEY = "boardChatPrefill" as const;

const CONTEXT_MAX_CHARS = 200;

/** One plain line about where the question was asked: the page title (which names the records on it). */
export function boardChatContextLine(pageTitle: string | null | undefined): string | null {
  const title = (pageTitle ?? "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  const masked = capHelperText(maskSecretLikeText(title), CONTEXT_MAX_CHARS).text;
  return `(I asked this while looking at the page “${masked}”.)`;
}

/** The message Board chat opens with: the question, then the context line. Secrets are masked. */
export function buildBoardChatHandoffText(input: { question: string; pageTitle?: string | null }): string {
  const question = maskSecretLikeText(input.question.trim());
  const context = boardChatContextLine(input.pageTitle);
  const text = context ? `${question}\n\n${context}` : question;
  return capHelperText(text, HELPER_MESSAGE_MAX_CHARS).text;
}

/** The navigation state to open Board chat with. */
export function boardChatPrefillState(text: string): Record<typeof BOARD_CHAT_PREFILL_STATE_KEY, string> {
  return { [BOARD_CHAT_PREFILL_STATE_KEY]: text };
}

/** Reads a prefill out of location.state (anything else gives null). */
export function readBoardChatPrefill(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[BOARD_CHAT_PREFILL_STATE_KEY];
  return typeof value === "string" && value.trim() ? value : null;
}
