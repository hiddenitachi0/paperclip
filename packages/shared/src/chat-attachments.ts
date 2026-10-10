/**
 * Pictures a person sends with a chat message (Telegram photo, an image file
 * sent as a document). The Telegram bridge stores each one in the company's
 * Files and the quick agent's turn carries its file id, so Media Studio can
 * use it as a reference ("alter this picture to show you helping him").
 *
 *  - The file name starts with CHAT_PHOTO_FILENAME_PREFIX. Media Studio reads
 *    that prefix as "a real photo someone sent in": such a picture must pass
 *    the age check before it is sent to any picture service. The plugin keeps
 *    its own copy of the prefix (it does not depend on this package); a
 *    server test pins that the two match.
 *  - At most CHAT_ATTACHMENTS_MAX pictures per message, each at most
 *    CHAT_PHOTO_MAX_BYTES (Media Studio reads pictures up to 10 MB).
 */
export const CHAT_PHOTO_FILENAME_PREFIX = "chat-photo-";
export const CHAT_ATTACHMENTS_MAX = 4;
export const CHAT_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
/** Base64 length of the largest picture allowed (4 characters per 3 bytes, padded). */
export const CHAT_PHOTO_MAX_BASE64_CHARS = Math.ceil(CHAT_PHOTO_MAX_BYTES / 3) * 4;
/** The picture types a chat photo may be (decided from the bytes, never the name). */
export const CHAT_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ChatPhotoType = (typeof CHAT_PHOTO_TYPES)[number];

/** The chat photo's type from its first bytes (JPEG, PNG or WebP), or null. */
export function sniffChatPhotoType(bytes: Uint8Array): ChatPhotoType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return "image/png";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === "RIFF" &&
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** "chat-photo-20261010-142233.jpg": the name a chat photo is stored under (UTC time). */
export function chatPhotoFilename(type: ChatPhotoType, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const extension = type === "image/jpeg" ? "jpg" : type === "image/png" ? "png" : "webp";
  return `${CHAT_PHOTO_FILENAME_PREFIX}${stamp}.${extension}`;
}
