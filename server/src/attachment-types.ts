/**
 * Shared attachment content-type configuration.
 *
 * By default a curated set of image/document/text/media types are allowed. Set the
 * `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES` environment variable to a
 * comma-separated list of MIME types or wildcard patterns to expand the
 * allowed set for routes that use this allowlist.
 *
 * Examples:
 *   PAPERCLIP_ALLOWED_ATTACHMENT_TYPES=image/*,application/pdf
 *   PAPERCLIP_ALLOWED_ATTACHMENT_TYPES=image/*,application/pdf,text/*
 *
 * Supported pattern syntax:
 *   - Exact types:   "application/pdf"
 *   - Wildcards:     "image/*"  or  "application/vnd.openxmlformats-officedocument.*"
 */
import {
  DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
  MEDIA_VIDEO_FILE_DEFAULT_MAX_BYTES,
  MEDIA_VIDEO_FILE_HARD_MAX_BYTES,
} from "@paperclipai/shared";

export const DEFAULT_ALLOWED_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/zip",
  "text/markdown",
  "text/plain",
  "application/json",
  "text/csv",
  "text/html",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
];

export const DEFAULT_ATTACHMENT_CONTENT_TYPE = "application/octet-stream";
export const SVG_CONTENT_TYPE = "image/svg+xml";
export const INLINE_ATTACHMENT_TYPES: readonly string[] = [
  "image/*",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
];

/**
 * Parse a comma-separated list of MIME type patterns into a normalised array.
 * Returns the default image-only list when the input is empty or undefined.
 */
export function parseAllowedTypes(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_ALLOWED_TYPES];
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_TYPES];
}

/**
 * Check whether `contentType` matches any entry in `allowedPatterns`.
 *
 * Supports exact matches ("application/pdf") and wildcard / prefix
 * patterns ("image/*", "application/vnd.openxmlformats-officedocument.*").
 */
export function matchesContentType(contentType: string, allowedPatterns: string[]): boolean {
  const ct = contentType.toLowerCase();
  return allowedPatterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("/*") || pattern.endsWith(".*")) {
      return ct.startsWith(pattern.slice(0, -1));
    }
    return ct === pattern;
  });
}

export function normalizeContentType(contentType: string | null | undefined): string {
  const normalized = (contentType ?? "").trim().toLowerCase();
  return normalized || DEFAULT_ATTACHMENT_CONTENT_TYPE;
}

export function isInlineAttachmentContentType(contentType: string): boolean {
  return matchesContentType(contentType, [...INLINE_ATTACHMENT_TYPES]);
}

// ---------- Module-level singletons read once at startup ----------

const allowedPatterns: string[] = parseAllowedTypes(
  process.env.PAPERCLIP_ALLOWED_ATTACHMENT_TYPES,
);

/** Convenience wrapper using the process-level allowed list. */
export function isAllowedContentType(contentType: string): boolean {
  return matchesContentType(contentType, allowedPatterns);
}

export const MAX_ATTACHMENT_BYTES =
  Number(process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES) || 25 * 1024 * 1024;

export function normalizeIssueAttachmentMaxBytes(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.min(DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES, MAX_ATTACHMENT_BYTES);
  }
  return Math.min(Math.floor(value), MAX_COMPANY_ATTACHMENT_MAX_BYTES, MAX_ATTACHMENT_BYTES);
}

// ---------- D18: video files (finished films, Media Studio videos) ----------

/** Reads the server-wide ceiling for one video file: a positive byte count, never above the hard maximum. */
export function parseVideoFileMaxBytes(raw: string | undefined): number {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) return MEDIA_VIDEO_FILE_HARD_MAX_BYTES;
  return Math.min(Math.floor(value), MEDIA_VIDEO_FILE_HARD_MAX_BYTES);
}

/**
 * The largest video file this server keeps, for every company
 * (`PAPERCLIP_VIDEO_FILE_MAX_BYTES`, at most 4 GB; 4 GB when unset). Each
 * company's own limit (Media Studio settings, 2 GB by default) sits under it.
 */
export const MAX_VIDEO_FILE_BYTES = parseVideoFileMaxBytes(process.env.PAPERCLIP_VIDEO_FILE_MAX_BYTES);

/** A video file, by its (normalised) content type: video/mp4, video/webm, video/quicktime, ... */
export function isVideoContentType(contentType: string | null | undefined): boolean {
  return normalizeContentType(contentType).startsWith("video/");
}

/** One company's per-file video limit in bytes, from its setting (or the default), under the server's ceiling. */
export function normalizeVideoFileMaxBytes(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.min(MEDIA_VIDEO_FILE_DEFAULT_MAX_BYTES, MAX_VIDEO_FILE_BYTES);
  }
  return Math.min(Math.floor(value), MAX_VIDEO_FILE_BYTES);
}

/**
 * The limit that applies to one file: video files get the larger video
 * limit (never less than they had before), everything else keeps the
 * company's ordinary attachment limit.
 */
export function maxBytesForContentType(contentType: string | null | undefined, limits: { attachmentMaxBytes: number; videoFileMaxBytes: number }): number {
  return isVideoContentType(contentType) ? Math.max(limits.attachmentMaxBytes, limits.videoFileMaxBytes) : limits.attachmentMaxBytes;
}
