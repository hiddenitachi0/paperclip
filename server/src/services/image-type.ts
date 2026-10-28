// DUR-4902: a stored picture's content type and file extension must say what
// the bytes are. The picture services answer with a content-type header that
// is sometimes wrong (a PNG sent as image/jpeg, or the other way round), and
// stills used to be saved as "...-still.jpg" with whatever the header said.

const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** The image type the bytes start with (PNG, JPEG, WebP, GIF), or null when they are none of those. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  return null;
}

/** The content type to store (what the bytes are; else the declared type without parameters) and a file extension that matches it. */
export function storedImageType(bytes: Uint8Array, declared: string): { contentType: string; extension: string } {
  const header = declared.split(";")[0]!.trim().toLowerCase();
  const contentType = sniffImageType(bytes) ?? header;
  return { contentType, extension: EXTENSION[contentType] ?? "bin" };
}
