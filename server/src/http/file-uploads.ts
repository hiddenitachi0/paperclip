import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { Request, Response } from "express";
import multer from "multer";
import { isVideoContentType, maxBytesForContentType, normalizeContentType } from "../attachment-types.js";
import { HttpError } from "../errors.js";
import type { CompanyFileLimits } from "../services/media-video-limits.js";
import { mediaWorkDir } from "../services/media-video-limits.js";
import { sniffVideoContainer } from "../services/video-ffmpeg.js";

/**
 * D18: one uploaded file for a task or the company's Files. Everything up
 * to the company's ordinary attachment limit is received in memory exactly
 * as before (`buffer`). Only a video may be larger -- up to the company's
 * video limit (2 GB by default) -- and it is spooled to a temp file on the
 * server's disk once it passes the ordinary limit (`path`), so a long film
 * is never held in memory. The caller streams `path` into storage
 * (StorageService.putFileFromPath) and removes it afterwards.
 */
export interface ReceivedUpload {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
  path?: string;
}

/** The limit a file went over: video files and other files have different ones. */
export type FileLimitError = multer.MulterError & { limitBytes?: number };

function fileLimitError(limitBytes: number, field: string): FileLimitError {
  return Object.assign(new multer.MulterError("LIMIT_FILE_SIZE", field), { limitBytes });
}

/**
 * The multer storage engine behind it: counts every byte against the limit
 * for the file's type, keeps small files in memory, spills a large video to
 * disk with backpressure, and removes the spool file on any failure.
 */
export function companyFileUploadStorage(limits: CompanyFileLimits, workDir: string): multer.StorageEngine {
  return {
    _handleFile(_req, file, callback) {
      const contentType = normalizeContentType(file.mimetype);
      const limit = maxBytesForContentType(contentType, limits);
      const memoryLimit = Math.min(limit, limits.attachmentMaxBytes);
      const stream = file.stream;
      let size = 0;
      let chunks: Buffer[] = [];
      let spool: WriteStream | null = null;
      let spoolPath: string | null = null;
      let settled = false;

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        chunks = [];
        stream.resume(); // discard the rest of this file
        if (!spool || !spoolPath) {
          callback(err);
          return;
        }
        const path = spoolPath;
        spool.destroy();
        void fs.rm(path, { force: true }).catch(() => undefined).then(() => callback(err));
      };

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
          // Only a video gets past the ordinary limit: from here on it goes to disk.
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
        const path = spoolPath;
        spool.end(() => {
          if (settled) return;
          settled = true;
          callback(null, { path, size });
        });
      });
    },

    _removeFile(_req, file, callback) {
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
 * `limitBytes` (see uploadLimitBytes); nothing is left on disk.
 */
export async function receiveCompanyFileUpload(req: Request, res: Response, limits: CompanyFileLimits): Promise<ReceivedUpload | undefined> {
  const workDir = await mediaWorkDir();
  const upload = multer({
    storage: companyFileUploadStorage(limits, workDir),
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
 * video; its first bytes must agree (MP4/MOV or WebM/Matroska), so a large
 * file of another kind cannot pass as a video to get the larger limit.
 */
export async function assertLargeUploadIsVideo(file: ReceivedUpload, limits: CompanyFileLimits): Promise<void> {
  if (file.size <= limits.attachmentMaxBytes) return;
  if (!isVideoContentType(file.mimetype) || !file.path) {
    throw new HttpError(422, `File exceeds ${limits.attachmentMaxBytes} bytes`);
  }
  const head = Buffer.alloc(16);
  const handle = await fs.open(file.path, "r");
  try {
    await handle.read(head, 0, head.length, 0);
  } finally {
    await handle.close();
  }
  if (!sniffVideoContainer(head)) {
    throw new HttpError(422, "This file is not a video this server can keep at this size. Upload an MP4, MOV or WebM video, or a smaller file.");
  }
}

/** Removes an upload's spool file (never fails the request over it). */
export async function discardUpload(file: ReceivedUpload | undefined): Promise<void> {
  if (file?.path) await fs.rm(file.path, { force: true }).catch(() => undefined);
}
