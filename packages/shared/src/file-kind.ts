// packages/shared/src/file-kind.ts

export type FileMediaKind = "image" | "video" | "text" | "document" | "file";

export interface FileKindInfo {
  /** Short (≤4 char) label for the file-type tile, e.g. "PDF". */
  tileLabel: string;
  /** Operator prose description, e.g. "Excel spreadsheet". Never a MIME string. */
  plainName: string;
  mediaKind: FileMediaKind;
}

/**
 * MIME types that classify as mediaKind "document" (binary office/PDF documents).
 * Used in classifyMediaKind and contentTypeKindCondition.
 */
export const OFFICE_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  // Word
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  // Excel
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  // PowerPoint
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.template",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  // OpenDocument
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  // RTF
  "application/rtf",
  "text/rtf",
]);

/**
 * Returns FileKindInfo for a given content type, or null for empty/unknown input.
 * Recognized types: image/*, video/*, PDF, Word, Excel, PowerPoint, OpenDocument, RTF,
 * text/* (and JSON/XML), ZIP archives. Falls back to mediaKind "file".
 */
export function getFileKindInfo(contentType: string | null | undefined): FileKindInfo {
  const normalized = (contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";

  if (normalized.startsWith("image/")) {
    const sub = normalized.slice("image/".length);
    const label = sub === "svg+xml" ? "SVG" : (sub || "img").toUpperCase().slice(0, 4);
    return { tileLabel: label, plainName: "Image", mediaKind: "image" };
  }
  if (normalized.startsWith("video/")) {
    const sub = normalized.slice("video/".length);
    const label = sub === "quicktime" ? "MOV" : (sub || "vid").toUpperCase().slice(0, 4);
    return { tileLabel: label, plainName: "Video", mediaKind: "video" };
  }
  if (normalized === "application/pdf") {
    return { tileLabel: "PDF", plainName: "PDF document", mediaKind: "document" };
  }
  if (
    normalized === "application/msword" ||
    normalized === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    normalized === "application/vnd.openxmlformats-officedocument.wordprocessingml.template"
  ) {
    return { tileLabel: "DOC", plainName: "Word document", mediaKind: "document" };
  }
  if (
    normalized === "application/vnd.ms-excel" ||
    normalized === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    normalized === "application/vnd.openxmlformats-officedocument.spreadsheetml.template"
  ) {
    return { tileLabel: "XLS", plainName: "Excel spreadsheet", mediaKind: "document" };
  }
  if (
    normalized === "application/vnd.ms-powerpoint" ||
    normalized === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    normalized === "application/vnd.openxmlformats-officedocument.presentationml.template" ||
    normalized === "application/vnd.openxmlformats-officedocument.presentationml.slideshow"
  ) {
    return { tileLabel: "PPT", plainName: "PowerPoint presentation", mediaKind: "document" };
  }
  if (normalized === "application/vnd.oasis.opendocument.spreadsheet") {
    return { tileLabel: "ODS", plainName: "OpenDocument spreadsheet", mediaKind: "document" };
  }
  if (normalized === "application/vnd.oasis.opendocument.presentation") {
    return { tileLabel: "ODP", plainName: "OpenDocument presentation", mediaKind: "document" };
  }
  if (normalized === "application/vnd.oasis.opendocument.text") {
    return { tileLabel: "ODT", plainName: "OpenDocument document", mediaKind: "document" };
  }
  if (normalized === "application/rtf" || normalized === "text/rtf") {
    return { tileLabel: "RTF", plainName: "Rich Text document", mediaKind: "document" };
  }
  if (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized.endsWith("+json") ||
    normalized === "application/xml" ||
    normalized.endsWith("+xml") ||
    normalized === "application/markdown"
  ) {
    return { tileLabel: "TXT", plainName: "Text file", mediaKind: "text" };
  }
  if (
    normalized === "application/zip" ||
    normalized === "application/x-zip" ||
    normalized === "application/x-zip-compressed" ||
    normalized.endsWith("+zip")
  ) {
    return { tileLabel: "ZIP", plainName: "ZIP archive", mediaKind: "file" };
  }
  if (!normalized) {
    return { tileLabel: "FILE", plainName: "File", mediaKind: "file" };
  }
  return { tileLabel: "FILE", plainName: "File", mediaKind: "file" };
}
