import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { helperAskSchema, helperModelCanSeePictures, HELPER_PICTURE_MAX_BYTES } from "@paperclipai/shared";
import { normalizeHelperPicture, sniffHelperPictureType } from "../services/helper-pictures.ts";
import { buildOpenAiCompatibleBody, toAnthropicMessages } from "../services/lane-a-providers.ts";

/**
 * "Ask Paperclip" Phase 2 without a database: the picture checks (bytes
 * decide the type, size cap, re-encoded to JPEG), the request shape (count
 * cap, only upload/file, no unknown fields), the "can it see pictures"
 * answer, and the wire shape each provider gets.
 */

async function png(width = 40, height = 30) {
  return sharp({ create: { width, height, channels: 4, background: { r: 200, g: 10, b: 10, alpha: 0.5 } } }).png().toBuffer();
}

describe("helper pictures", () => {
  it("decides the picture type from the bytes, not the label", async () => {
    expect(sniffHelperPictureType(await png())).toBe("image/png");
    expect(sniffHelperPictureType(await sharp(await png()).jpeg().toBuffer())).toBe("image/jpeg");
    expect(sniffHelperPictureType(await sharp(await png()).webp().toBuffer())).toBe("image/webp");
    expect(sniffHelperPictureType(await sharp(await png()).gif().toBuffer())).toBe("image/gif");
    expect(sniffHelperPictureType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(sniffHelperPictureType(Buffer.from("%PDF-1.7 hello"))).toBeNull();
    expect(sniffHelperPictureType(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it("re-encodes a picture as a JPEG no larger than the cap, and refuses non-pictures and oversized ones", async () => {
    const out = await normalizeHelperPicture(await png(3000, 1000), "Picture 1");
    expect(out.contentType).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(out.base64, "base64")).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1536);

    await expect(normalizeHelperPicture(Buffer.from("this is plain text, not a picture"), "Picture 1")).rejects.toMatchObject({
      status: 422,
      details: { code: "HELPER_PICTURE_TYPE" },
    });
    await expect(normalizeHelperPicture(Buffer.alloc(HELPER_PICTURE_MAX_BYTES + 1, 0xff), "Picture 2")).rejects.toMatchObject({
      status: 422,
      details: { code: "HELPER_PICTURE_TOO_LARGE" },
    });
    // Right magic bytes, broken picture.
    await expect(normalizeHelperPicture(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]), "Picture 3")).rejects.toMatchObject({
      status: 422,
      details: { code: "HELPER_PICTURE_UNREADABLE" },
    });
  });

  it("accepts at most 4 pictures, only uploads or company file ids, and nothing else", () => {
    const upload = { kind: "upload", dataBase64: "aGVsbG8=", name: "a.png" };
    expect(helperAskSchema.safeParse({ message: "hi", pictures: [upload, upload, upload, upload] }).success).toBe(true);
    expect(helperAskSchema.safeParse({ message: "hi", pictures: [upload, upload, upload, upload, upload] }).success).toBe(false);
    expect(helperAskSchema.safeParse({ message: "hi", pictures: [{ kind: "file", fileId: "not-a-uuid" }] }).success).toBe(false);
    expect(helperAskSchema.safeParse({ message: "hi", pictures: [{ kind: "url", url: "http://x/y.png" }] }).success).toBe(false);
    expect(helperAskSchema.safeParse({ message: "hi", pictures: [{ ...upload, path: "/etc/passwd" }] }).success).toBe(false);
    expect(
      helperAskSchema.safeParse({ message: "hi", pictures: [{ kind: "upload", dataBase64: "A".repeat(7_000_000) }] }).success,
    ).toBe(false);
  });

  it("knows which models can see pictures: the saved model's own setting first, then known models, then the name", () => {
    expect(helperModelCanSeePictures({ provider: "openrouter", model: "vendor/plain-text", specs: { vision: true } })).toEqual({
      canSee: true,
      source: "setting",
    });
    expect(helperModelCanSeePictures({ provider: "anthropic", model: "claude-sonnet-5", specs: { vision: false } }).canSee).toBe(false);
    expect(helperModelCanSeePictures({ provider: "anthropic", model: "claude-sonnet-5" }).canSee).toBe(true);
    expect(helperModelCanSeePictures({ provider: "openai", model: "gpt-4o-mini" }).canSee).toBe(true);
    expect(helperModelCanSeePictures({ provider: "google", model: "gemini-2.5-flash" }).canSee).toBe(true);
    expect(helperModelCanSeePictures({ provider: "local", model: "llava:13b" }).canSee).toBe(true);
    expect(helperModelCanSeePictures({ provider: "local", model: "qwen2.5vl:7b" }).canSee).toBe(true);
    expect(helperModelCanSeePictures({ provider: "local", model: "llama3.2:3b" }).canSee).toBe(false); // known model: no
    expect(helperModelCanSeePictures({ provider: "openrouter", model: "vendor/small-model" })).toEqual({ canSee: null, source: "unknown" });
  });

  it("sends pictures in each provider's own shape", () => {
    const images = [{ contentType: "image/jpeg" as const, base64: "QUJD" }];
    const anthropic = toAnthropicMessages([{ role: "user", content: "Describe this", images }]);
    expect(anthropic[0]).toEqual({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
        { type: "text", text: "Describe this" },
      ],
    });
    // Without pictures the turn is unchanged (plain string).
    expect(toAnthropicMessages([{ role: "user", content: "hi" }])[0]).toEqual({ role: "user", content: "hi" });

    for (const provider of ["openrouter", "openai", "local"] as const) {
      const body = buildOpenAiCompatibleBody(provider, {
        model: "m",
        system: "sys",
        maxTokens: 100,
        messages: [{ role: "user", content: "Describe this", images }],
      });
      expect((body.messages as unknown[])[1]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
        ],
      });
      expect(body.tools).toBeUndefined();
    }
  });
});
