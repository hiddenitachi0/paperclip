import type { NextFunction, Request, Response } from "express";
import type { StorageService } from "../storage/types.js";

/**
 * D18: one `Range: bytes=...` request, as browsers send it to play and seek
 * a video (and download managers send it to resume). Only a single range is
 * served; a multi-range or malformed header is "invalid" (416), the same
 * rules the task attachment route has used since it first streamed videos.
 */
export type ParsedByteRange =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "range"; start: number; end: number };

export function parseByteRangeHeader(raw: string | undefined, contentLength: number): ParsedByteRange {
  if (!raw) return { kind: "none" };
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) return { kind: "invalid" };

  const prefix = "bytes=";
  if (!raw.toLowerCase().startsWith(prefix)) return { kind: "invalid" };
  const spec = raw.slice(prefix.length).trim();
  if (!spec || spec.includes(",")) return { kind: "invalid" };

  const [startRaw, endRaw] = spec.split("-", 2);
  if (endRaw === undefined) return { kind: "invalid" };

  if (startRaw === "") {
    const suffixLength = Number.parseInt(endRaw, 10);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: "invalid" };
    const start = Math.max(contentLength - suffixLength, 0);
    return { kind: "range", start, end: contentLength - 1 };
  }

  const start = Number.parseInt(startRaw, 10);
  if (!Number.isSafeInteger(start) || start < 0 || start >= contentLength) return { kind: "invalid" };
  const end = endRaw === "" ? contentLength - 1 : Number.parseInt(endRaw, 10);
  if (!Number.isSafeInteger(end) || end < start) return { kind: "invalid" };
  return { kind: "range", start, end: Math.min(end, contentLength - 1) };
}

/**
 * A Content-Disposition value that never breaks on a title with quotes or
 * letters outside ASCII (a Norwegian film title, say): a plain ASCII
 * `filename` for old clients plus the exact name as RFC 5987 `filename*`.
 */
export function contentDispositionHeader(disposition: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "").trim() || "file";
  const exact = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${exact}`;
}

export interface StoredObjectToSend {
  companyId: string;
  /** Always from a stored row, never from the request. */
  objectKey: string;
  /** The stored size; when it is unknown the whole object is sent and Range is ignored. */
  byteSize: number | null | undefined;
  /** The stored content type; falls back to the object's own, then to `fallbackContentType`. */
  contentType: string | null | undefined;
  fallbackContentType: string;
}

/**
 * Streams one company-scoped stored object to the response, honouring a
 * single byte range (206 with Content-Range, or 416 when it cannot be
 * served). Nothing is buffered: a 2 GB film goes from disk to the socket in
 * chunks. The caller sets its own caching/disposition headers first and has
 * already done every access check; the storage service still refuses a key
 * outside the company's prefix.
 */
export async function sendStoredObject(
  req: Request,
  res: Response,
  next: NextFunction,
  storage: Pick<StorageService, "getObject">,
  object: StoredObjectToSend,
): Promise<void> {
  const size = typeof object.byteSize === "number" && Number.isSafeInteger(object.byteSize) && object.byteSize > 0 ? object.byteSize : null;
  const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : undefined;
  const range: ParsedByteRange = size ? parseByteRangeHeader(rangeHeader, size) : { kind: "none" };
  if (size) res.setHeader("Accept-Ranges", "bytes");
  if (range.kind === "invalid") {
    res.setHeader("Content-Range", `bytes */${size ?? "*"}`);
    res.status(416).end();
    return;
  }

  const stored =
    range.kind === "range"
      ? await storage.getObject(object.companyId, object.objectKey, { range: { start: range.start, end: range.end } })
      : await storage.getObject(object.companyId, object.objectKey);
  res.setHeader("Content-Type", object.contentType || stored.contentType || object.fallbackContentType);
  if (range.kind === "range") {
    res.status(206);
    res.setHeader("Content-Length", String(range.end - range.start + 1));
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  } else {
    const length = size ?? stored.contentLength;
    if (typeof length === "number" && length >= 0) res.setHeader("Content-Length", String(length));
  }

  stored.stream.on("error", (err) => next(err));
  // A player that seeks or closes drops its request: release the file at once, not when it is collected.
  res.on("close", () => {
    if (!stored.stream.destroyed) stored.stream.destroy?.();
  });
  stored.stream.pipe(res);
}
