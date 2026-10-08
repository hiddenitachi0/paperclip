// Picture work done on the server with sharp (already a Media Studio
// dependency): cutting crops out of one picture, finding the box around a
// black-and-white mask, and shrinking a picture before it goes to the
// analysis model.

import sharp from "sharp";
import type { CropBox } from "./identity.js";

/** Cut one box (fractions of the picture) out of a picture. PNG keeps it lossless. */
export async function cropPicture(bytes: Buffer, box: CropBox): Promise<{ bytes: Buffer; contentType: string; width: number; height: number }> {
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
  const out = await image.extract({ left, top, width: w, height: h }).png().toBuffer();
  return { bytes: out, contentType: "image/png", width: w, height: h };
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

/** A JPEG no bigger than `maxSide` on its longest side, for the analysis model. */
export async function shrinkForAnalysis(bytes: Buffer, maxSide = 1536): Promise<{ contentType: string; contentBase64: string }> {
  const out = await sharp(bytes).rotate().resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  return { contentType: "image/jpeg", contentBase64: out.toString("base64") };
}

/** "WxH" close to the picture's own shape, inside Sogni's size limits (multiples of 16). */
export async function sogniSizeLike(bytes: Buffer, maxSide = 1536, minSide = 256): Promise<string | null> {
  const meta = await sharp(bytes).rotate().metadata();
  if (!meta.width || !meta.height) return null;
  const scale = Math.min(1, maxSide / Math.max(meta.width, meta.height));
  const fit = (n: number) => Math.max(minSide, Math.round((n * scale) / 16) * 16);
  return `${fit(meta.width)}x${fit(meta.height)}`;
}
