import type { CompanyArtifactMediaKind } from "./types/artifact.js";

/**
 * Shared MIME-type / extension -> file-kind classification (DUR-64).
 *
 * This is the single source of truth for how a file's content type (and,
 * where the content type is generic, its filename extension) maps to:
 *   - `tileLabel`: a short (<=4 char) label for a file-type tile, e.g. "XLSX".
 *   - `plainName`: operator-facing prose, e.g. "Excel spreadsheet" — never a
 *     raw MIME string.
 *   - `mediaKind`: the coarse bucket used for filtering/grouping
 *     (`CompanyArtifactMediaKind`).
 *
 * Used by both the server (`company-artifacts.ts` media-kind classification)
 * and the UI (`ui/src/lib/issue-output.ts` tile-label + output-eligibility
 * lookups) so the two call sites can never drift apart.
 */

export interface FileKindInfo {
  tileLabel: string;
  plainName: string;
  mediaKind: CompanyArtifactMediaKind;
}

interface FileKindRule {
  mimeTypes: readonly string[];
  /** Filename extensions (including the leading dot), lowercase. */
  extensions: readonly string[];
  mediaKind: CompanyArtifactMediaKind;
  plainName: string;
  /** Tile label, or a function deriving one from the matched extension/mime. */
  tileLabel: string | ((match: { extension: string | null; mimeType: string }) => string);
}

const WORD_MIME_TYPES = [
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;
const WORD_EXTENSIONS = [".doc", ".docx"] as const;

const EXCEL_MIME_TYPES = [
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;
const EXCEL_EXTENSIONS = [".xls", ".xlsx"] as const;

const POWERPOINT_MIME_TYPES = [
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;
const POWERPOINT_EXTENSIONS = [".ppt", ".pptx"] as const;

const OPENDOCUMENT_TEXT_MIME_TYPES = ["application/vnd.oasis.opendocument.text"] as const;
const OPENDOCUMENT_SPREADSHEET_MIME_TYPES = ["application/vnd.oasis.opendocument.spreadsheet"] as const;
const OPENDOCUMENT_PRESENTATION_MIME_TYPES = ["application/vnd.oasis.opendocument.presentation"] as const;

const RTF_MIME_TYPES = ["application/rtf", "text/rtf"] as const;
const RTF_EXTENSIONS = [".rtf"] as const;

const PDF_MIME_TYPES = ["application/pdf"] as const;
const PDF_EXTENSIONS = [".pdf"] as const;

const MARKDOWN_MIME_TYPES = [
  "text/markdown",
  "text/x-markdown",
  "application/markdown",
  "application/x-markdown",
] as const;
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"] as const;

const CSV_MIME_TYPES = ["text/csv", "application/csv"] as const;
const CSV_EXTENSIONS = [".csv"] as const;

const JSON_MIME_TYPES = ["application/json", "application/ld+json"] as const;
const JSON_EXTENSIONS = [".json"] as const;

const XML_MIME_TYPES = ["application/xml", "text/xml", "application/xhtml+xml"] as const;
const XML_EXTENSIONS = [".xml"] as const;

const HTML_MIME_TYPES = ["text/html", "application/html"] as const;
const HTML_EXTENSIONS = [".html", ".htm"] as const;

const ZIP_MIME_TYPES = ["application/zip", "application/x-zip", "application/x-zip-compressed"] as const;
const ZIP_EXTENSIONS = [".zip"] as const;

const WASM_MIME_TYPES = ["application/wasm"] as const;
const WASM_EXTENSIONS = [".wasm"] as const;

const TEXT_PLAIN_MIME_TYPES = ["text/plain"] as const;
const TEXT_PLAIN_EXTENSIONS = [".txt", ".log"] as const;

/**
 * Exact-match MIME types that classify as `mediaKind: "document"` — real
 * PDF/Word/Excel/PowerPoint/OpenDocument/RTF files, as opposed to the
 * markdown-note "documents" the company-artifacts service also tracks
 * (those classify as `"text"`, see `company-artifacts.ts`).
 *
 * This is the canonical list `contentTypeKindCondition`'s `document` /
 * `file` branches (server) and `isOutputEligibleContentType`'s office-type
 * allowlist (UI) both key off of, so they can't drift from this module.
 */
export const DOCUMENT_MEDIA_CONTENT_TYPES: readonly string[] = [
  ...PDF_MIME_TYPES,
  ...WORD_MIME_TYPES,
  ...EXCEL_MIME_TYPES,
  ...POWERPOINT_MIME_TYPES,
  ...OPENDOCUMENT_TEXT_MIME_TYPES,
  ...OPENDOCUMENT_SPREADSHEET_MIME_TYPES,
  ...OPENDOCUMENT_PRESENTATION_MIME_TYPES,
  ...RTF_MIME_TYPES,
];

/** Office MIME types only (documents minus PDF) — Word/Excel/PowerPoint/OpenDocument/RTF. */
export const OFFICE_DOCUMENT_CONTENT_TYPES: readonly string[] = DOCUMENT_MEDIA_CONTENT_TYPES.filter(
  (contentType) => contentType !== "application/pdf",
);

const RULES: readonly FileKindRule[] = [
  {
    mimeTypes: PDF_MIME_TYPES,
    extensions: PDF_EXTENSIONS,
    mediaKind: "document",
    plainName: "PDF document",
    tileLabel: "PDF",
  },
  {
    mimeTypes: WORD_MIME_TYPES,
    extensions: WORD_EXTENSIONS,
    mediaKind: "document",
    plainName: "Word document",
    tileLabel: ({ extension, mimeType }) =>
      extension === ".doc" || (!extension && mimeType === "application/msword") ? "DOC" : "DOCX",
  },
  {
    mimeTypes: EXCEL_MIME_TYPES,
    extensions: EXCEL_EXTENSIONS,
    mediaKind: "document",
    plainName: "Excel spreadsheet",
    tileLabel: ({ extension, mimeType }) =>
      extension === ".xls" || (!extension && mimeType === "application/vnd.ms-excel") ? "XLS" : "XLSX",
  },
  {
    mimeTypes: POWERPOINT_MIME_TYPES,
    extensions: POWERPOINT_EXTENSIONS,
    mediaKind: "document",
    plainName: "PowerPoint presentation",
    tileLabel: ({ extension, mimeType }) =>
      extension === ".ppt" || (!extension && mimeType === "application/vnd.ms-powerpoint") ? "PPT" : "PPTX",
  },
  {
    mimeTypes: OPENDOCUMENT_TEXT_MIME_TYPES,
    extensions: [".odt"],
    mediaKind: "document",
    plainName: "OpenDocument text document",
    tileLabel: "ODT",
  },
  {
    mimeTypes: OPENDOCUMENT_SPREADSHEET_MIME_TYPES,
    extensions: [".ods"],
    mediaKind: "document",
    plainName: "OpenDocument spreadsheet",
    tileLabel: "ODS",
  },
  {
    mimeTypes: OPENDOCUMENT_PRESENTATION_MIME_TYPES,
    extensions: [".odp"],
    mediaKind: "document",
    plainName: "OpenDocument presentation",
    tileLabel: "ODP",
  },
  {
    mimeTypes: RTF_MIME_TYPES,
    extensions: RTF_EXTENSIONS,
    mediaKind: "document",
    plainName: "Rich Text document",
    tileLabel: "RTF",
  },
  {
    mimeTypes: MARKDOWN_MIME_TYPES,
    extensions: MARKDOWN_EXTENSIONS,
    mediaKind: "text",
    plainName: "Markdown document",
    tileLabel: "MD",
  },
  {
    mimeTypes: CSV_MIME_TYPES,
    extensions: CSV_EXTENSIONS,
    mediaKind: "text",
    plainName: "CSV file",
    tileLabel: "CSV",
  },
  {
    mimeTypes: JSON_MIME_TYPES,
    extensions: JSON_EXTENSIONS,
    mediaKind: "text",
    plainName: "JSON file",
    tileLabel: "JSON",
  },
  {
    mimeTypes: XML_MIME_TYPES,
    extensions: XML_EXTENSIONS,
    mediaKind: "text",
    plainName: "XML file",
    tileLabel: "XML",
  },
  {
    mimeTypes: HTML_MIME_TYPES,
    extensions: HTML_EXTENSIONS,
    mediaKind: "text",
    plainName: "HTML file",
    tileLabel: "HTML",
  },
  {
    mimeTypes: TEXT_PLAIN_MIME_TYPES,
    extensions: TEXT_PLAIN_EXTENSIONS,
    mediaKind: "text",
    plainName: "Text file",
    tileLabel: "TXT",
  },
  {
    mimeTypes: ZIP_MIME_TYPES,
    extensions: ZIP_EXTENSIONS,
    mediaKind: "file",
    plainName: "ZIP archive",
    tileLabel: "ZIP",
  },
  {
    mimeTypes: WASM_MIME_TYPES,
    extensions: WASM_EXTENSIONS,
    mediaKind: "file",
    plainName: "WebAssembly file",
    tileLabel: "WASM",
  },
];

const GENERIC_BINARY_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-binary",
]);

function extensionOf(filename: string): string | null {
  const trimmed = filename.trim().toLowerCase();
  const idx = trimmed.lastIndexOf(".");
  return idx >= 0 ? trimmed.slice(idx) : null;
}

function resolveTileLabel(rule: FileKindRule, match: { extension: string | null; mimeType: string }): string {
  return typeof rule.tileLabel === "function" ? rule.tileLabel(match) : rule.tileLabel;
}

function imageKind(mimeType: string): FileKindInfo {
  const subtype = mimeType.slice("image/".length);
  const label = subtype === "svg+xml" ? "SVG" : (subtype || "img").toUpperCase().slice(0, 4);
  return { tileLabel: label || "IMG", plainName: "Image", mediaKind: "image" };
}

function videoKind(mimeType: string): FileKindInfo {
  const subtype = mimeType.slice("video/".length);
  if (subtype === "quicktime") return { tileLabel: "MOV", plainName: "Video", mediaKind: "video" };
  const label = (subtype || "vid").toUpperCase().slice(0, 4);
  return { tileLabel: label || "VID", plainName: "Video", mediaKind: "video" };
}

/**
 * Classify a file by content type and/or filename.
 *
 * `contentType` is preferred when present and recognized. When it's missing
 * or one of the known generic-binary placeholders (`application/octet-stream`
 * and friends), the filename extension is used instead so a `.docx` saved
 * with a generic content type still classifies as a Word document.
 *
 * Falls back to a generic "File" / `mediaKind: "file"` classification when
 * nothing matches.
 */
export function classifyFileKind(input: {
  contentType?: string | null;
  filename?: string | null;
}): FileKindInfo {
  const contentType = (input.contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  const extension = extensionOf(input.filename ?? "");

  if (contentType.startsWith("image/")) return imageKind(contentType);
  if (contentType.startsWith("video/")) return videoKind(contentType);

  const isGenericOrMissing = !contentType || GENERIC_BINARY_CONTENT_TYPES.has(contentType);

  for (const rule of RULES) {
    if (rule.mimeTypes.includes(contentType)) {
      return {
        tileLabel: resolveTileLabel(rule, { extension, mimeType: contentType }),
        plainName: rule.plainName,
        mediaKind: rule.mediaKind,
      };
    }
  }

  if (contentType.endsWith("+zip")) {
    return { tileLabel: "ZIP", plainName: "ZIP archive", mediaKind: "file" };
  }
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    return { tileLabel: "JSON", plainName: "JSON file", mediaKind: "text" };
  }
  if (contentType === "application/xml" || contentType.endsWith("+xml")) {
    return { tileLabel: "XML", plainName: "XML file", mediaKind: "text" };
  }
  if (contentType.startsWith("text/")) {
    return { tileLabel: "TXT", plainName: "Text file", mediaKind: "text" };
  }

  if (isGenericOrMissing && extension) {
    for (const rule of RULES) {
      if (rule.extensions.includes(extension)) {
        return {
          tileLabel: resolveTileLabel(rule, { extension, mimeType: contentType }),
          plainName: rule.plainName,
          mediaKind: rule.mediaKind,
        };
      }
    }
  }

  return { tileLabel: "BIN", plainName: "File", mediaKind: "file" };
}
