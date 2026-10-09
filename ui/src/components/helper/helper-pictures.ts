import { HELPER_PICTURE_MAX_BYTES, HELPER_PICTURE_TYPES, HELPER_PICTURES_MAX, type HelperPictureInput } from "@paperclipai/shared";

/**
 * Pictures the person attached in the Ask panel. They stay in this browser
 * tab until the question is sent (then they are cleared); the server checks
 * the bytes again, shrinks them and keeps nothing. Only pictures the person
 * picked, pasted or chose from Files: the screen is never captured.
 */
export interface HelperAttachedPicture {
  /** Local id for the list. */
  key: string;
  name: string;
  /** What the panel shows: a data: URL for an upload, the thumbnail path for a company file. */
  previewUrl: string;
  input: HelperPictureInput;
}

export const HELPER_PICTURE_ACCEPT = HELPER_PICTURE_TYPES.join(",");
const MAX_MB = HELPER_PICTURE_MAX_BYTES / (1024 * 1024);

let counter = 0;
const nextKey = () => `pic-${Date.now().toString(36)}-${(counter += 1)}`;

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * Turns picked or pasted files into attached pictures. Returns the pictures
 * that fit and one plain message per file that did not (wrong kind, too big,
 * too many).
 */
export async function filesToHelperPictures(
  files: readonly File[],
  alreadyAttached: number,
): Promise<{ pictures: HelperAttachedPicture[]; problems: string[] }> {
  const pictures: HelperAttachedPicture[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const name = file.name || "Pasted picture";
    if (!(HELPER_PICTURE_TYPES as readonly string[]).includes(file.type)) {
      problems.push(`"${name}" is not a PNG, JPEG, WebP or GIF picture.`);
      continue;
    }
    if (file.size > HELPER_PICTURE_MAX_BYTES) {
      problems.push(`"${name}" is larger than ${MAX_MB} MB.`);
      continue;
    }
    if (alreadyAttached + pictures.length >= HELPER_PICTURES_MAX) {
      problems.push(`You can attach at most ${HELPER_PICTURES_MAX} pictures to one question.`);
      break;
    }
    let dataUrl: string;
    try {
      dataUrl = await readAsDataUrl(file);
    } catch {
      problems.push(`"${name}" could not be read.`);
      continue;
    }
    const comma = dataUrl.indexOf(",");
    pictures.push({
      key: nextKey(),
      name,
      previewUrl: dataUrl,
      input: { kind: "upload", name, contentType: file.type, dataBase64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl },
    });
  }
  return { pictures, problems };
}

/** A picture of the company's Files (an attachment), by its attachment id. */
export function companyFilePicture(attachmentId: string, name: string, thumbnailPath: string | null): HelperAttachedPicture {
  return {
    key: nextKey(),
    name,
    previewUrl: thumbnailPath ?? `/api/attachments/${attachmentId}/content`,
    input: { kind: "file", fileId: attachmentId },
  };
}

/** Image files on a paste event (screenshots copied to the clipboard). */
export function picturesFromClipboard(data: Pick<DataTransfer, "files" | "items"> | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const file of Array.from(data.files ?? [])) if (file.type.startsWith("image/")) out.push(file);
  if (out.length > 0) return out;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }
  return out;
}
