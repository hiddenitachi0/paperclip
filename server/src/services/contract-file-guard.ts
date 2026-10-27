import { inflateRawSync } from "node:zlib";

/**
 * File checks for contract uploads (Legal Phase 2a, DUR-4853).
 *
 * Everything here is pure and synchronous so it can be unit-tested with crafted
 * files. Nothing in this module reads or logs document text: errors carry a
 * fixed code and, at most, a number.
 */

export type ContractFileKind = "pdf" | "docx";

export const CONTRACT_FILE_CONTENT_TYPES: Record<ContractFileKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export const CONTRACT_FILE_EXTENSIONS: Record<ContractFileKind, string> = { pdf: ".pdf", docx: ".docx" };

const DEFAULT_CONTRACT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const HARD_CONTRACT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** `PAPERCLIP_CONTRACT_UPLOAD_MAX_BYTES`, default 25 MB, never above 100 MB. */
export function resolveContractUploadMaxBytes(raw: string | undefined = process.env.PAPERCLIP_CONTRACT_UPLOAD_MAX_BYTES) {
  const value = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CONTRACT_UPLOAD_MAX_BYTES;
  return Math.min(Math.floor(value), HARD_CONTRACT_UPLOAD_MAX_BYTES);
}

/**
 * The kind a file really is, from its first bytes. The client's file name and
 * MIME type are never trusted for this. A PDF starts with `%PDF-`; a DOCX is a
 * ZIP (`PK\x03\x04`), and `inspectDocxArchive` then checks it really is a
 * Word document.
 */
export function detectContractFileKind(buffer: Buffer): ContractFileKind | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return "docx";
  }
  return null;
}

export type DocxGuardLimits = {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  /** Total uncompressed bytes may not exceed this multiple of the archive size... */
  maxCompressionRatio: number;
  /** ...but ratios are only judged once the archive expands past this size. */
  ratioFloorBytes: number;
};

export const DEFAULT_DOCX_GUARD_LIMITS: DocxGuardLimits = {
  maxEntries: 1_000,
  maxEntryUncompressedBytes: 50 * 1024 * 1024,
  maxTotalUncompressedBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 100,
  ratioFloorBytes: 1024 * 1024,
};

export type DocxGuardFailure =
  | "not_a_zip"
  | "too_many_entries"
  | "entry_too_large"
  | "archive_too_large"
  | "compression_ratio"
  | "encrypted_entry"
  | "unsupported_compression"
  | "corrupt_entry"
  | "size_mismatch"
  | "not_a_word_document"
  | "macro_enabled";

export class DocxGuardError extends Error {
  constructor(readonly code: DocxGuardFailure) {
    super(`DOCX rejected: ${code}`);
    this.name = "DocxGuardError";
  }
}

type ZipEntry = {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The comment is at most 65535 bytes, so the record starts in the last 65557.
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function readCentralDirectory(buffer: Buffer, limits: DocxGuardLimits): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new DocxGuardError("not_a_zip");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  // 0xffff / 0xffffffff mean ZIP64, which a Word document never needs.
  if (entryCount === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new DocxGuardError("not_a_zip");
  }
  if (entryCount > limits.maxEntries) throw new DocxGuardError("too_many_entries");
  if (directoryOffset + directorySize > eocd) throw new DocxGuardError("not_a_zip");

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new DocxGuardError("not_a_zip");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength > buffer.length) throw new DocxGuardError("not_a_zip");
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new DocxGuardError("not_a_zip");
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntryBody(buffer: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  const header = entry.localHeaderOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new DocxGuardError("corrupt_entry");
  }
  const start = header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new DocxGuardError("corrupt_entry");
  const raw = buffer.subarray(start, end);
  if (entry.method === 0) {
    if (raw.length > maxBytes) throw new DocxGuardError("archive_too_large");
    return raw;
  }
  try {
    // maxOutputLength is what makes this safe against a lying header: inflate
    // stops (and throws) the moment the real output passes the budget.
    return inflateRawSync(raw, { maxOutputLength: maxBytes });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ERR_BUFFER_TOO_LARGE") throw new DocxGuardError("archive_too_large");
    throw new DocxGuardError("corrupt_entry");
  }
}

/**
 * Cheap pre-storage check: does the archive's table of contents list a VBA
 * macro part? Reads only the central directory (nothing is inflated), so it is
 * safe to run on the request thread. An archive that cannot be listed is not
 * judged here; the extraction worker fails it closed.
 */
export function docxHasMacroPart(buffer: Buffer): boolean {
  try {
    const entries = readCentralDirectory(buffer, { ...DEFAULT_DOCX_GUARD_LIMITS, maxEntries: 0xfffe });
    return entries.some((entry) => entry.name.toLowerCase().endsWith("vbaproject.bin"));
  } catch {
    return false;
  }
}

export type DocxArchiveReport = { entryCount: number; totalUncompressedBytes: number };

/**
 * Checks a DOCX archive before it is handed to the text extractor.
 *
 * Zip-bomb defence: the entry count, each entry's size, the declared and the
 * real total uncompressed size, and the overall compression ratio are all
 * capped. Declared sizes are not trusted: every entry is actually inflated here
 * with a hard output cap, so a header that understates its size cannot slip a
 * large entry through. Also rejects encrypted entries, compression methods
 * other than stored/deflate, archives without `word/document.xml`, and
 * macro-enabled documents (a `vbaProject.bin` part). Nothing is executed.
 */
export function inspectDocxArchive(
  buffer: Buffer,
  limits: DocxGuardLimits = DEFAULT_DOCX_GUARD_LIMITS,
): DocxArchiveReport {
  const entries = readCentralDirectory(buffer, limits);

  let declaredTotal = 0;
  for (const entry of entries) {
    if ((entry.flags & 0x1) !== 0) throw new DocxGuardError("encrypted_entry");
    if (entry.method !== 0 && entry.method !== 8) throw new DocxGuardError("unsupported_compression");
    if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) throw new DocxGuardError("entry_too_large");
    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > limits.maxTotalUncompressedBytes) throw new DocxGuardError("archive_too_large");
  }

  const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
  if (!names.has("word/document.xml") || !names.has("[content_types].xml")) {
    throw new DocxGuardError("not_a_word_document");
  }
  if ([...names].some((name) => name.endsWith("vbaproject.bin"))) throw new DocxGuardError("macro_enabled");

  let actualTotal = 0;
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    const budget = Math.max(
      1,
      Math.min(limits.maxEntryUncompressedBytes, limits.maxTotalUncompressedBytes - actualTotal),
    );
    const body = readEntryBody(buffer, entry, budget);
    if (body.length !== entry.uncompressedSize) throw new DocxGuardError("size_mismatch");
    actualTotal += body.length;
    if (actualTotal > limits.maxTotalUncompressedBytes) throw new DocxGuardError("archive_too_large");
  }

  if (actualTotal > limits.ratioFloorBytes && actualTotal / Math.max(buffer.length, 1) > limits.maxCompressionRatio) {
    throw new DocxGuardError("compression_ratio");
  }
  return { entryCount: entries.length, totalUncompressedBytes: actualTotal };
}
