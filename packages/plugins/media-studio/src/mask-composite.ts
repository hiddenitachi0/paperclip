// Mandatory server-side mask compositing for masked AI edits (DUR-4331).
//
// A fill/inpaint model is not guaranteed to leave pixels outside the mask
// byte-identical to the input it was given, so "the unselected part of the
// picture is unchanged" cannot depend on the model being well-behaved. This
// module makes that guarantee true by construction, after the model call
// returns and before the result goes back to the client:
//
//   result[x,y] = original[x,y]      where mask[x,y] == 0 (unselected)
//   result[x,y] = edited[x,y]        where mask[x,y] == 1 (selected)
//
// The mask is thresholded at its midpoint first, so this is always a hard
// per-pixel choice between the two source images, never a blend — a grey or
// anti-aliased mask edge still resolves to exactly one side or the other.

import sharp from "sharp";

export interface CompositeMaskedEditInput {
  /** The picture being edited, as originally uploaded (any format sharp can decode). */
  original: Buffer;
  /** The model's output for the same picture (same or different format/size; resized to match `original`). */
  edited: Buffer;
  /** Black-and-white selection mask: white (or any value >= the midpoint) marks the edited area. */
  mask: Buffer;
}

/**
 * Composite `edited` into `original` wherever `mask` selects, and leave every
 * other pixel exactly as it was in `original`. Returns PNG bytes so the
 * (lossless) original pixels are never re-encoded through a lossy format.
 */
export async function compositeMaskedEdit(input: CompositeMaskedEditInput): Promise<Buffer> {
  const base = sharp(input.original);
  const { width, height } = await base.metadata();
  if (!width || !height) throw new Error("Could not read the original picture's size.");

  const maskAlpha = await sharp(input.mask)
    .resize(width, height, { fit: "fill" })
    .grayscale()
    .threshold(128)
    .raw()
    .toBuffer();

  // flatten (not removeAlpha): sharp drops a channel joined right after
  // removeAlpha() in the same pipeline (observed with sharp 0.35.2/vips
  // 8.18), so any existing alpha is composited onto black first instead —
  // a no-op when `edited` has no alpha channel, which is the common case.
  const editedWithMaskAlpha = await sharp(input.edited)
    .resize(width, height, { fit: "fill" })
    .flatten({ background: "#000000" })
    .joinChannel(maskAlpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();

  return sharp(input.original)
    .ensureAlpha()
    .composite([{ input: editedWithMaskAlpha, blend: "over" }])
    .png()
    .toBuffer();
}
