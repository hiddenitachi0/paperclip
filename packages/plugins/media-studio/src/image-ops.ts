// Picture work done on the server with sharp (already a Media Studio
// dependency): cutting crops out of one picture, finding the box around a
// black-and-white mask, and shrinking a picture before it goes to the
// analysis model.

import sharp from "sharp";
import type { CropBox } from "./identity.js";

/** How a crop is encoded: longest edge in pixels and JPEG quality. */
export interface CropEncoding {
  maxEdge: number;
  quality: number;
}

/** The first try, then smaller tries for when several crops together are too big for one response. */
export const CROP_ENCODINGS: readonly CropEncoding[] = [
  { maxEdge: 2048, quality: 90 },
  { maxEdge: 1536, quality: 82 },
  { maxEdge: 1024, quality: 74 },
  { maxEdge: 768, quality: 68 },
];

/** All the crops of one call together may not pass this many bytes (before base64's +33%). */
export const CROP_BUDGET_BYTES = 12 * 1024 * 1024;

/**
 * Cut one box (fractions of the picture) out of a picture. Encoded as JPEG
 * (transparency flattened onto white, longest edge capped, never enlarged): a
 * lossless PNG of a photo crop is several times the size of the photo.
 */
export async function cropPicture(
  bytes: Buffer,
  box: CropBox,
  encoding: CropEncoding = CROP_ENCODINGS[0]!,
): Promise<{ bytes: Buffer; contentType: string; width: number; height: number }> {
  const image = sharp(bytes).rotate(); // apply EXIF orientation first, so boxes match what people see
  const meta = await image.metadata();
  const oriented = meta.orientation && meta.orientation >= 5;
  const width = (oriented ? meta.height : meta.width) ?? 0;
  const height = (oriented ? meta.width : meta.height) ?? 0;
  if (!width || !height) throw new Error("The picture's size could not be read.");
  const left = Math.max(0, Math.min(width - 1, Math.round(box.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(box.y * height)));
  const w = Math.max(1, Math.min(width - left, Math.round(box.w * width)));
  const h = Math.max(1, Math.min(height - top, Math.round(box.h * height)));
  const { data, info } = await image
    .extract({ left, top, width: w, height: h })
    .flatten({ background: "#ffffff" })
    .resize({ width: encoding.maxEdge, height: encoding.maxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: encoding.quality, chromaSubsampling: "4:4:4" })
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, contentType: "image/jpeg", width: info.width, height: info.height };
}

/**
 * Cut every box. When the crops together pass the budget, all of them are cut
 * again smaller; if even the smallest setting is too big, say so in plain words
 * instead of dropping any crop.
 */
export async function cropPictures(
  bytes: Buffer,
  boxes: CropBox[],
  budgetBytes: number = CROP_BUDGET_BYTES,
): Promise<Array<{ bytes: Buffer; contentType: string; width: number; height: number }>> {
  for (const encoding of CROP_ENCODINGS) {
    const cuts = [];
    for (const box of boxes) cuts.push(await cropPicture(bytes, box, encoding));
    if (cuts.reduce((sum, cut) => sum + cut.bytes.length, 0) <= budgetBytes) return cuts;
  }
  throw new Error("These crops are too big to save together. Draw fewer or smaller boxes and try again.");
}

/** The box around the white part of a mask, as fractions; null when the mask is empty. */
export async function maskBoundingBox(mask: Buffer): Promise<CropBox | null> {
  const { data, info } = await sharp(mask).grayscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * channels]! >= 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX / width, y: minY / height, w: (maxX - minX + 1) / width, h: (maxY - minY + 1) / height };
}

/** "WxH" close to the picture's own shape, inside Sogni's size limits (multiples of 16). */
export async function sogniSizeLike(bytes: Buffer, maxSide = 1536, minSide = 256): Promise<string | null> {
  const meta = await sharp(bytes).rotate().metadata();
  if (!meta.width || !meta.height) return null;
  const scale = Math.min(1, maxSide / Math.max(meta.width, meta.height));
  const fit = (n: number) => Math.max(minSide, Math.round((n * scale) / 16) * 16);
  return `${fit(meta.width)}x${fit(meta.height)}`;
}
