import { buffer as streamToBuffer } from "node:stream/consumers";
import type { StorageService } from "../storage/types.js";

export const THUMBNAIL_MAX_SIDE = 256;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

export type ThumbnailResizer = (source: Buffer) => Promise<Buffer>;

export const sharpThumbnailResizer: ThumbnailResizer = async (source) => {
  const sharp = (await import("sharp")).default;
  return sharp(source, { limitInputPixels: 100_000_000 })
    .rotate()
    .resize({ width: THUMBNAIL_MAX_SIDE, height: THUMBNAIL_MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
};

export function thumbnailObjectKey(objectKey: string) {
  return `${objectKey}.thumb${THUMBNAIL_MAX_SIDE}.webp`;
}

export function isThumbnailableContentType(contentType: string | null | undefined) {
  const ct = (contentType ?? "").toLowerCase();
  return ct.startsWith("image/") && !ct.includes("svg");
}

/** Returns the cached thumbnail, generating + storing it on first request. */
export async function getOrCreateThumbnail(
  storage: StorageService,
  attachment: { companyId: string; objectKey: string },
  resize: ThumbnailResizer = sharpThumbnailResizer,
): Promise<Buffer | null> {
  const key = thumbnailObjectKey(attachment.objectKey);
  const head = await storage.headObject(attachment.companyId, key).catch(() => ({ exists: false }));
  if (head.exists) {
    const cached = await storage.getObject(attachment.companyId, key);
    return streamToBuffer(cached.stream);
  }
  const original = await storage.getObject(attachment.companyId, attachment.objectKey);
  const source = await streamToBuffer(original.stream);
  if (source.length > MAX_SOURCE_BYTES) return null;
  const thumb = await resize(source);
  if (storage.putObjectAt) {
    await storage.putObjectAt(attachment.companyId, key, thumb, "image/webp").catch(() => undefined);
  }
  return thumb;
}
