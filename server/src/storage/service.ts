import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import type { StorageService, StorageProvider, PutFileInput, PutFileFromPathInput, PutFileResult } from "./types.js";
import { HttpError, badRequest, forbidden, unprocessable } from "../errors.js";

const MAX_SEGMENT_LENGTH = 120;

function sanitizeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "file";
  return cleaned.slice(0, MAX_SEGMENT_LENGTH);
}

function normalizeNamespace(namespace: string): string {
  const normalized = namespace
    .split("/")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => sanitizeSegment(entry));
  if (normalized.length === 0) return "misc";
  return normalized.join("/");
}

function splitFilename(filename: string | null): { stem: string; ext: string } {
  if (!filename) return { stem: "file", ext: "" };
  const base = path.basename(filename).trim();
  if (!base) return { stem: "file", ext: "" };

  const extRaw = path.extname(base);
  const stemRaw = extRaw ? base.slice(0, base.length - extRaw.length) : base;
  const stem = sanitizeSegment(stemRaw);
  const ext = extRaw
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "")
    .slice(0, 16);
  return {
    stem,
    ext,
  };
}

function ensureCompanyPrefix(companyId: string, objectKey: string): void {
  const expectedPrefix = `${companyId}/`;
  if (!objectKey.startsWith(expectedPrefix)) {
    throw forbidden("Object does not belong to company");
  }
  if (objectKey.includes("..")) {
    throw badRequest("Invalid object key");
  }
}

function hashBuffer(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function buildObjectKey(companyId: string, namespace: string, originalFilename: string | null): string {
  const ns = normalizeNamespace(namespace);
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const { stem, ext } = splitFilename(originalFilename);
  const suffix = randomUUID();
  const filename = `${suffix}-${stem}${ext}`;
  return `${companyId}/${ns}/${year}/${month}/${day}/${filename}`;
}

function assertPutFileMeta(input: Pick<PutFileInput, "companyId" | "namespace" | "contentType">): void {
  if (!input.companyId || input.companyId.trim().length === 0) {
    throw unprocessable("companyId is required");
  }
  if (!input.namespace || input.namespace.trim().length === 0) {
    throw unprocessable("namespace is required");
  }
  if (!input.contentType || input.contentType.trim().length === 0) {
    throw unprocessable("contentType is required");
  }
}

/** Size of a regular file on disk, or a plain 422 when there is none. */
async function sourceFileSize(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) throw unprocessable("File to store was not found");
  return stat.size;
}

function assertPutFileInput(input: PutFileInput): void {
  assertPutFileMeta(input);
  if (!(input.body instanceof Buffer)) {
    throw unprocessable("body must be a Buffer");
  }
  if (input.body.length <= 0) {
    throw unprocessable("File is empty");
  }
}

export function createStorageService(provider: StorageProvider): StorageService {
  return {
    provider: provider.id,

    async putFile(input: PutFileInput): Promise<PutFileResult> {
      assertPutFileInput(input);
      const objectKey = buildObjectKey(input.companyId, input.namespace, input.originalFilename);
      const byteSize = input.body.length;
      const contentType = input.contentType.trim().toLowerCase();
      await provider.putObject({
        objectKey,
        body: input.body,
        contentType,
        contentLength: byteSize,
      });

      return {
        provider: provider.id,
        objectKey,
        contentType,
        byteSize,
        sha256: hashBuffer(input.body),
        originalFilename: input.originalFilename,
      };
    },

    async putFileFromPath(input: PutFileFromPathInput): Promise<PutFileResult> {
      assertPutFileMeta(input);
      const byteSize = await sourceFileSize(input.filePath);
      if (byteSize <= 0) {
        throw unprocessable("File is empty");
      }
      if (input.maxBytes !== undefined && byteSize > input.maxBytes) {
        throw new HttpError(413, `File exceeds ${input.maxBytes} bytes`);
      }
      const objectKey = buildObjectKey(input.companyId, input.namespace, input.originalFilename);
      const contentType = input.contentType.trim().toLowerCase();

      // One pass over the file: hashed on its way to the provider, never held whole in memory.
      const hash = createHash("sha256");
      let streamedBytes = 0;
      const source = createReadStream(input.filePath);
      const hashing = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          streamedBytes += chunk.length;
          callback(null, chunk);
        },
      });
      source.on("error", (err) => hashing.destroy(err));
      source.pipe(hashing);
      try {
        await provider.putObject({ objectKey, body: hashing, contentType, contentLength: byteSize });
      } finally {
        // A provider that gave up early must not leave the file open.
        source.destroy();
      }

      if (streamedBytes !== byteSize) {
        // The file changed while it was being stored: never keep a half-written copy.
        await provider.deleteObject({ objectKey }).catch(() => undefined);
        throw unprocessable("File changed while it was being stored");
      }

      return {
        provider: provider.id,
        objectKey,
        contentType,
        byteSize,
        sha256: hash.digest("hex"),
        originalFilename: input.originalFilename,
      };
    },

    async getObject(companyId: string, objectKey: string, options) {
      ensureCompanyPrefix(companyId, objectKey);
      return provider.getObject({ objectKey, range: options?.range });
    },

    async headObject(companyId: string, objectKey: string) {
      ensureCompanyPrefix(companyId, objectKey);
      return provider.headObject({ objectKey });
    },

    async putObjectAt(companyId: string, objectKey: string, body: Buffer, contentType: string) {
      ensureCompanyPrefix(companyId, objectKey);
      await provider.putObject({ objectKey, body, contentType, contentLength: body.length });
    },

    async deleteObject(companyId: string, objectKey: string) {
      ensureCompanyPrefix(companyId, objectKey);
      await provider.deleteObject({ objectKey });
    },
  };
}
