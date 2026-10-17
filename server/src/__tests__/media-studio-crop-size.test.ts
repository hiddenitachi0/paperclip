import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { cropPicture } from "../../../packages/plugins/media-studio/src/image-ops.js";

async function noisePicture(width: number, height: number, format: "jpeg" | "png") {
  const raw = randomBytes(width * height * 3);
  const image = sharp(raw, { raw: { width, height, channels: 3 } });
  return format === "jpeg" ? image.jpeg({ quality: 40 }).toBuffer() : image.png().toBuffer();
}

describe("cropPicture output size", () => {
  it("keeps a small crop as lossless PNG", async () => {
    const source = await noisePicture(64, 64, "png");
    const cut = await cropPicture(source, { x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(cut.contentType).toBe("image/png");
    expect(cut).toMatchObject({ width: 32, height: 32 });
  });

  it("saves a crop that would be a huge PNG as a JPEG under the cap", async () => {
    const source = await noisePicture(2400, 2400, "jpeg");
    const cut = await cropPicture(source, { x: 0, y: 0, w: 1, h: 1 });
    expect(cut.contentType).toBe("image/jpeg");
    expect(cut.bytes.length).toBeLessThanOrEqual(1_500_000);
    const meta = await sharp(cut.bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect({ w: meta.width, h: meta.height }).toEqual({ w: cut.width, h: cut.height });
  }, 60_000);

  it("flattens transparency to white when it falls back to JPEG", async () => {
    const source = await sharp({ create: { width: 1800, height: 1800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp(randomBytes(900 * 900 * 3), { raw: { width: 900, height: 900, channels: 3 } }).png().toBuffer(), left: 900, top: 900 }])
      .png()
      .toBuffer();
    const cut = await cropPicture(source, { x: 0, y: 0, w: 1, h: 1 });
    expect(cut.contentType).toBe("image/jpeg");
    const { data } = await sharp(cut.bytes).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]].every((v) => v! >= 250)).toBe(true);
  }, 60_000);
});
