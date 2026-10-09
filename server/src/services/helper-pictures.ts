import sharp from "sharp";
import type { Db } from "@paperclipai/db";
import {
  HELPER_PICTURE_MAX_BYTES,
  HELPER_PICTURES_MAX,
  type HelperPictureInput,
  type HelperPictureType,
} from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";
import { getStorageService } from "../storage/index.js";
import type { StorageService } from "../storage/types.js";
import { issueService } from "./issues.js";
import type { LaneAImage } from "./lane-a-providers.js";
import { IMAGE_ANALYSIS_MAX_SIDE } from "./plugin-image-analysis.js";

/**
 * "Ask Paperclip", Phase 2: the pictures a person attached to one question.
 *
 *  - Only pictures the person attached: an upload/paste from their computer
 *    (base64 in the request) or one of THIS company's Files (an attachment
 *    id). Nothing here ever captures the screen.
 *  - The kind of picture is decided from the bytes themselves (PNG, JPEG,
 *    WebP, GIF), never from the name or the browser's label.
 *  - At most HELPER_PICTURES_MAX pictures, each at most
 *    HELPER_PICTURE_MAX_BYTES.
 *  - Each picture is turned upright, shrunk to fit IMAGE_ANALYSIS_MAX_SIDE
 *    (the same size the plugin picture analysis uses) and re-encoded as a
 *    JPEG. That keeps every provider under its own size limit and drops the
 *    picture's hidden data (camera, GPS position) before it leaves Paperclip.
 *  - Nothing is stored: an upload exists only in this request's memory. A
 *    picked company file stays where it was and is only read.
 *  - A file of another company reads exactly like a missing one.
 */

export interface HelperPictureDeps {
  storage?: () => StorageService;
}

export interface PreparedHelperPicture extends LaneAImage {
  /** "picture 1", or the file name the person gave. */
  label: string;
}

export interface HelperPicturePrepareOptions {
  /**
   * May the person see the task this company file is attached to (issueId
   * null = a company file with no task)? A picture they may not see is
   * refused, never silently dropped, so nobody reads a task through the
   * helper that they could not open themselves.
   */
  canReadFile?: (file: { issueId: string | null }) => Promise<boolean>;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The picture type from the first bytes, or null when it is not a PNG, JPEG, WebP or GIF. */
export function sniffHelperPictureType(bytes: Uint8Array): HelperPictureType | null {
  if (bytes.length >= 8 && PNG.every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const head = Buffer.from(bytes.subarray(0, 6)).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = Buffer.from(bytes.subarray(0, 4)).toString("latin1");
    const webp = Buffer.from(bytes.subarray(8, 12)).toString("latin1");
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return null;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_MB = HELPER_PICTURE_MAX_BYTES / (1024 * 1024);

function decodeUpload(dataBase64: string, label: string): Buffer {
  // A "data:image/png;base64," prefix is tolerated; the bytes decide the type anyway.
  const raw = dataBase64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!raw || raw.length % 4 !== 0 || !BASE64_RE.test(raw)) {
    throw unprocessable(`${label} could not be read. Attach it again.`, { code: "HELPER_PICTURE_UNREADABLE" });
  }
  return Buffer.from(raw, "base64");
}

async function streamToBuffer(stream: NodeJS.ReadableStream, max: number, label: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > max) throw unprocessable(`${label} is larger than ${MAX_MB} MB.`, { code: "HELPER_PICTURE_TOO_LARGE" });
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Checks one picture's bytes and shrinks it to a JPEG for the model. */
export async function normalizeHelperPicture(bytes: Buffer, label: string): Promise<LaneAImage> {
  if (bytes.length === 0) throw unprocessable(`${label} is empty.`, { code: "HELPER_PICTURE_UNREADABLE" });
  if (bytes.length > HELPER_PICTURE_MAX_BYTES) {
    throw unprocessable(`${label} is larger than ${MAX_MB} MB. Use a smaller picture.`, { code: "HELPER_PICTURE_TOO_LARGE" });
  }
  if (!sniffHelperPictureType(bytes)) {
    throw unprocessable(`${label} is not a PNG, JPEG, WebP or GIF picture.`, { code: "HELPER_PICTURE_TYPE" });
  }
  try {
    const out = await sharp(bytes, { limitInputPixels: 50_000_000 })
      .rotate()
      .resize(IMAGE_ANALYSIS_MAX_SIDE, IMAGE_ANALYSIS_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { contentType: "image/jpeg", base64: out.toString("base64") };
  } catch {
    throw unprocessable(`${label} could not be read. Try another picture.`, { code: "HELPER_PICTURE_UNREADABLE" });
  }
}

export function helperPictureService(db: Db, deps: HelperPictureDeps = {}) {
  const storage = deps.storage ?? (() => getStorageService());
  const issues = issueService(db);

  async function readCompanyFile(
    companyId: string,
    fileId: string,
    label: string,
    options: HelperPicturePrepareOptions,
  ): Promise<Buffer> {
    const file = await issues.getAttachmentById(fileId);
    // Another company's file reads exactly like a missing one.
    if (!file || file.companyId !== companyId) {
      throw unprocessable(`${label} is not in this company's Files. Pick it again.`, { code: "HELPER_PICTURE_NOT_FOUND" });
    }
    if (options.canReadFile && !(await options.canReadFile({ issueId: file.issueId ?? null }))) {
      throw forbidden(`${label} belongs to a task you do not have access to, so it cannot be used. Remove it and try again.`, {
        code: "HELPER_PICTURE_NOT_VISIBLE",
      });
    }
    if (file.byteSize > HELPER_PICTURE_MAX_BYTES) {
      throw unprocessable(`${label} is larger than ${MAX_MB} MB. Pick a smaller picture.`, { code: "HELPER_PICTURE_TOO_LARGE" });
    }
    const object = await storage().getObject(companyId, file.objectKey);
    return streamToBuffer(object.stream, HELPER_PICTURE_MAX_BYTES, label);
  }

  /** Reads, checks and shrinks the attached pictures, in order. Nothing is written anywhere. */
  async function prepare(
    companyId: string,
    pictures: HelperPictureInput[] | undefined,
    options: HelperPicturePrepareOptions = {},
  ): Promise<PreparedHelperPicture[]> {
    const list = pictures ?? [];
    if (list.length > HELPER_PICTURES_MAX) {
      throw unprocessable(`Attach at most ${HELPER_PICTURES_MAX} pictures to one question.`, { code: "HELPER_PICTURE_COUNT" });
    }
    const out: PreparedHelperPicture[] = [];
    for (const [index, picture] of list.entries()) {
      const fallback = `Picture ${index + 1}`;
      if (picture.kind === "upload") {
        const label = picture.name?.trim() ? `Picture ${index + 1} ("${picture.name.trim().slice(0, 80)}")` : fallback;
        const bytes = decodeUpload(picture.dataBase64, label);
        out.push({ ...(await normalizeHelperPicture(bytes, label)), label });
      } else {
        const bytes = await readCompanyFile(companyId, picture.fileId, fallback, options);
        out.push({ ...(await normalizeHelperPicture(bytes, fallback)), label: fallback });
      }
    }
    return out;
  }

  return { prepare };
}
