// Photos someone sent in a chat (a Telegram photo to a quick agent's bot).
//
// The Telegram bridge stores each one in the company's Files under a name
// that starts with CHAT_PHOTO_FILENAME_PREFIX (packages/shared's
// chat-attachments.ts; a server test pins that the two match). Such a photo
// is a real photo of real people, so before Media Studio sends it to any
// picture service (as a reference, a start picture, or a Sogni tool's input)
// it must pass the same age check as identity and training pictures
// (requireAdultPictures): only a photo that clearly shows adults is sent.
// When the check is unsure, or no person can be made out, nothing is sent
// and the person gets one plain sentence.

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { AGE_CHECK_NO_MODEL_MESSAGE, AGE_CHECK_UNREADABLE_MESSAGE } from "./age-check.js";
import { requireAdultPictures } from "./anchors.js";

export const CHAT_PHOTO_FILENAME_PREFIX = "chat-photo-";

export const CHAT_PHOTO_REFUSED_MESSAGE =
  "I can't change this photo, and it was not sent anywhere: it is not clear that everyone in it is an adult. Only photos that clearly show adults can be changed.";

export const CHAT_PHOTO_NO_MODEL_MESSAGE =
  "A photo sent in a chat is checked for apparent age before it is changed, and no model is picked for that check yet. An owner or admin picks one (a model that can see pictures) in Media Studio's identity settings.";

export const CHAT_PHOTO_UNREADABLE_MESSAGE =
  "The age check of this photo gave an answer that could not be read, so the photo was not changed or sent anywhere. Try again in a moment.";

export const CHAT_PHOTO_NOT_IN_CHAT_MESSAGE =
  "This photo has not been checked for apparent age yet, and that check only runs in a chat with a quick agent. Ask the quick agent to change it instead.";

export function isChatPhoto(file: { originalFilename: string | null | undefined }): boolean {
  return typeof file.originalFilename === "string" && file.originalFilename.toLowerCase().startsWith(CHAT_PHOTO_FILENAME_PREFIX);
}

/** The age check's own wording, turned into one sentence for the person in the chat. */
export function chatPhotoRefusal(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message === AGE_CHECK_NO_MODEL_MESSAGE) return CHAT_PHOTO_NO_MODEL_MESSAGE;
  if (message === AGE_CHECK_UNREADABLE_MESSAGE) return CHAT_PHOTO_UNREADABLE_MESSAGE;
  if (message.startsWith("Picture analysis only works")) return CHAT_PHOTO_NOT_IN_CHAT_MESSAGE;
  if (
    message.startsWith("Nothing was sent:") ||
    message.startsWith("Not every picture could be checked") ||
    message.includes("possibly showing someone under 18")
  ) {
    return CHAT_PHOTO_REFUSED_MESSAGE;
  }
  return message;
}

/**
 * Throws one plain sentence unless every chat photo among `files` clearly
 * shows adults. Pictures that are not chat photos are left alone (looks,
 * identities and pictures Media Studio made have their own rules).
 */
export async function requireAdultChatPhotos(
  ctx: PluginContext,
  companyId: string,
  files: Array<{ id: string; originalFilename: string | null | undefined }>,
  runId?: string | null,
): Promise<void> {
  const ids = files.filter(isChatPhoto).map((file) => file.id);
  if (ids.length === 0) return;
  try {
    await requireAdultPictures(ctx, companyId, ids, "The photo", { runId });
  } catch (err) {
    throw new Error(chatPhotoRefusal(err));
  }
}
