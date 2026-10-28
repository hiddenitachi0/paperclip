import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { Request, Response } from "express";
import multer from "multer";
import { isVideoContentType, maxBytesForContentType, normalizeContentType } from "../attachment-types.js";
import { HttpError } from "../errors.js";
import { tryTakeUploadSlot, UPLOAD_SLOTS_BUSY_MESSAGE } from "../services/company-upload-slots.js";
import type { CompanyFileLimits } from "../services/media-video-limits.js";
import { isLargeVideoUpload, mediaWorkDir } from "../services/media-video-limits.js";
import { verifyVideoFile } from "../services/video-ffmpeg.js";

/**
 * D18: one uploaded file for a task or the company's Files. Everything up
 * to the company's ordinary attachment limit is received in memory exactly
 * as before (`buffer`). Only a video may be larger -- up to the company's
 * video limit, and only where companyFileLimits allows it (security review
 * F1) -- and it is spooled to a temp file on the server's disk once it
 * passes the ordinary limit (`path`), so a long film is never held in
 * memory. A spooled upload holds one of the company's upload slots
 * (security review F2). The caller streams `path` into storage
 * (StorageService.putFileFromPath) and then calls discardUpload, which
 * removes the file and gives the slot back.
 */
export interface ReceivedUpload {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
  path?: string;
  /** Gives back the company's upload slot a spooled upload holds (safe to call twice). */
  releaseSlot?: () => void;
}

/** The limit a file went over: video files and other files have different ones. */
export type FileLimitError = multer.MulterError & { limitBytes?: number };

function fileLimitError(limitBytes: number, field: string): FileLimitError {
  return Object.assign(new multer.MulterError("LIMIT_FILE_SIZE", field), { limitBytes });
}

/**
 * The multer storage engine behind it: counts every byte against the limit
 * for the file's type, keeps small files in memory, spills a large video to
 * disk with backpressure, and removes the spool file on any failure. Before
 * it spills, it takes one of the company's upload slots (at most
 * UPLOADS_IN_FLIGHT_PER_COMPANY large uploads at once, shared with storyline
 * uploads); with none free the upload stops with 429 and nothing is written.
 */
export function companyFileUploadStorage(limits: CompanyFileLimits, workDir: string, companyId: string): multer.StorageEngine {
  return {
    _handleFile(req, file, callback) {
      const contentType = normalizeContentType(file.mimetype);
      const limit = maxBytesForContentType(contentType, limits);
      const memoryLimit = Math.min(limit, limits.attachmentMaxBytes);
      const stream = file.stream;
      let size = 0;
      let chunks: Buffer[] = [];
      let spool: WriteStream | null = null;
      let spoolPath: string | null = null;
      let releaseSlot: (() => void) | null = null;
      let settled = false;

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        chunks = [];
        releaseSlot?.();
        stream.resume(); // discard the rest of this file
        if (!spool || !spoolPath) {
          callback(err);
          return;
        }
        const path = spoolPath;
        spool.destroy();
        void fs.rm(path, { force: true }).catch(() => undefined).then(() => callback(err));
      };
      // A client that goes away mid-upload never ends the file stream: stop and clean up.
      req.once("close", () => {
        if (!req.readableEnded) fail(new Error("Request closed"));
      });

      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > limit) {
          fail(fileLimitError(limit, file.fieldname));
          return;
        }
        if (!spool) {
          if (size <= memoryLimit) {
            chunks.push(chunk);
            return;
          }
          // Only a video gets past the ordinary limit: from here on it goes to disk,
          // holding one of the company's upload slots until discardUpload.
          releaseSlot = tryTakeUploadSlot(companyId);
          if (!releaseSlot) {
            fail(new HttpError(429, UPLOAD_SLOTS_BUSY_MESSAGE));
            return;
          }
          spoolPath = join(workDir, `paperclip-upload-${randomUUID()}`);
          spool = createWriteStream(spoolPath, { flags: "wx", mode: 0o600 });
          spool.on("error", fail);
          for (const buffered of chunks) spool.write(buffered);
          chunks = [];
        }
        if (!spool.write(chunk)) {
          stream.pause();
          spool.once("drain", () => stream.resume());
        }
      });
      stream.on("error", fail);
      stream.on("end", () => {
        if (settled) return;
        if (!spool || !spoolPath) {
          settled = true;
          callback(null, { buffer: Buffer.concat(chunks), size });
          return;
        }
        // The slot goes with the file to the route, which gives it back in discardUpload.
        const info: Partial<Express.Multer.File> & Pick<ReceivedUpload, "releaseSlot"> = { path: spoolPath, size, releaseSlot: releaseSlot ?? undefined };
        spool.end(() => {
          if (settled) return;
          settled = true;
          callback(null, info);
        });
      });
    },

    _removeFile(_req, file, callback) {
      (file as Partial<ReceivedUpload>).releaseSlot?.();
      if (!file.path) {
        callback(null);
        return;
      }
      fs.rm(file.path, { force: true }).then(
        () => callback(null),
        (err: Error) => callback(err),
      );
    },
  };
}

/**
 * Receives the single "file" field with the company's limits. A file over
 * its limit rejects with multer's LIMIT_FILE_SIZE error carrying
 * `limitBytes` (see uploadLimitBytes); a large video while the company's
 * upload slots are taken rejects with a 429 HttpError; nothing is left on
 * disk either way.
 */
export async function receiveCompanyFileUpload(req: Request, res: Response, limits: CompanyFileLimits, companyId: string): Promise<ReceivedUpload | undefined> {
  const workDir = await mediaWorkDir();
  const upload = multer({
    storage: companyFileUploadStorage(limits, workDir, companyId),
    // A backstop only: the storage engine stops each file at its own type's limit first.
    limits: { fileSize: Math.max(limits.attachmentMaxBytes, limits.videoFileMaxBytes) + 1, files: 1 },
  });
  await new Promise<void>((resolve, reject) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
  return (req as Request & { file?: ReceivedUpload }).file;
}

/** The byte limit a LIMIT_FILE_SIZE error was raised for (the larger limit when multer's own backstop fired). */
export function uploadLimitBytes(err: unknown, limits: CompanyFileLimits): number {
  const limit = (err as FileLimitError | null)?.limitBytes;
  return typeof limit === "number" ? limit : Math.max(limits.attachmentMaxBytes, limits.videoFileMaxBytes);
}

/**
 * A file over the ordinary limit is accepted only because it says it is a
 * video: it must really be one (security review F3) -- its first bytes MP4/MOV
 * or WebM, and ffprobe, reading only the local spool file within a time
 * limit, must find a picture stream (verifyVideoFile). If the check cannot
 * run (no ffprobe, a timeout), the file is refused. `verify` is a seam for
 * tests.
 */
export async function assertLargeUploadIsVideo(
  file: ReceivedUpload,
  limits: CompanyFileLimits,
  verify: (filePath: string) => Promise<boolean> = verifyVideoFile,
): Promise<void> {
  if (!isLargeVideoUpload(file.size, limits)) return;
  if (!isVideoContentType(file.mimetype) || !file.path) {
    throw new HttpError(422, `File exceeds ${limits.attachmentMaxBytes} bytes`);
  }
  if (!(await verify(file.path))) {
    throw new HttpError(422, "This file is not a video this server can keep at this size. Upload an MP4, MOV or WebM video, or a smaller file.");
  }
}

/** Removes an upload's spool file and gives back its upload slot (never fails the request over it). */
export async function discardUpload(file: ReceivedUpload | undefined): Promise<void> {
  try {
    if (file?.path) await fs.rm(file.path, { force: true }).catch(() => undefined);
  } finally {
    file?.releaseSlot?.();
  }
}
