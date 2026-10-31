import { once } from "node:events";
import { crc32, createInflateRaw } from "node:zlib";

/**
 * A small read-only ZIP reader for the candle store (DUR-5007). Kraken ships
 * its history as one ~10 GB archive in ~2 GB parts; reading just the entries we
 * need through byte ranges means nothing large is ever written to disk and no
 * archive library (and its supply chain) is added.
 *
 * Only what the store needs: the central directory (with ZIP64), stored and
 * deflated entries, a CRC check, and hard limits so a hostile or broken archive
 * cannot make us read or inflate more than it declares.
 */

export interface RandomAccess {
  size: number;
  read(start: number, length: number): Promise<Buffer>;
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_ENTRIES = 1_000_000;
const MAX_CENTRAL_DIRECTORY_BYTES = 256 * 1024 * 1024;
const READ_CHUNK = 4 * 1024 * 1024;
const MAX_LINE_CHARS = 64 * 1024;

export function bufferSource(buffer: Buffer): RandomAccess {
  return {
    size: buffer.length,
    async read(start, length) {
      return buffer.subarray(start, start + length);
    },
  };
}

function safeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError(`${what} is too large`);
  return Number(value);
}

export async function listZipEntries(source: RandomAccess): Promise<ZipEntry[]> {
  const tailLength = Math.min(source.size, 22 + 0xffff);
  if (tailLength < 22) throw new ZipFormatError("not a zip file");
  const tail = await source.read(source.size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError("zip end record not found");
  let totalEntries = BigInt(tail.readUInt16LE(eocd + 10));
  let directorySize = BigInt(tail.readUInt32LE(eocd + 12));
  let directoryOffset = BigInt(tail.readUInt32LE(eocd + 16));
  if (totalEntries === 0xffffn || directorySize === 0xffffffffn || directoryOffset === 0xffffffffn) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR_SIG) throw new ZipFormatError("zip64 locator not found");
    const zip64Offset = safeNumber(tail.readBigUInt64LE(locator + 8), "zip64 record offset");
    const record = await source.read(zip64Offset, 56);
    if (record.length < 56 || record.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new ZipFormatError("zip64 end record not found");
    totalEntries = record.readBigUInt64LE(32);
    directorySize = record.readBigUInt64LE(40);
    directoryOffset = record.readBigUInt64LE(48);
  }
  const count = safeNumber(totalEntries, "entry count");
  const size = safeNumber(directorySize, "central directory size");
  const offset = safeNumber(directoryOffset, "central directory offset");
  if (count > MAX_ENTRIES || size > MAX_CENTRAL_DIRECTORY_BYTES || offset + size > source.size) throw new ZipFormatError("zip directory is out of range");
  const directory = await source.read(offset, size);
  if (directory.length !== size) throw new ZipFormatError("zip directory is truncated");

  const entries: ZipEntry[] = [];
  let pos = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > directory.length || directory.readUInt32LE(pos) !== CENTRAL_SIG) throw new ZipFormatError("zip directory is corrupt");
    const flags = directory.readUInt16LE(pos + 8);
    const method = directory.readUInt16LE(pos + 10);
    const entryCrc = directory.readUInt32LE(pos + 16);
    let compressed = BigInt(directory.readUInt32LE(pos + 20));
    let uncompressed = BigInt(directory.readUInt32LE(pos + 24));
    const nameLength = directory.readUInt16LE(pos + 28);
    const extraLength = directory.readUInt16LE(pos + 30);
    const commentLength = directory.readUInt16LE(pos + 32);
    let localOffset = BigInt(directory.readUInt32LE(pos + 42));
    const next = pos + 46 + nameLength + extraLength + commentLength;
    if (next > directory.length) throw new ZipFormatError("zip directory is corrupt");
    const name = directory.toString("utf8", pos + 46, pos + 46 + nameLength);
    let extra = pos + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = directory.readUInt16LE(extra);
      const length = directory.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let at = extra + 4;
        if (uncompressed === 0xffffffffn) {
          uncompressed = directory.readBigUInt64LE(at);
          at += 8;
        }
        if (compressed === 0xffffffffn) {
          compressed = directory.readBigUInt64LE(at);
          at += 8;
        }
        if (localOffset === 0xffffffffn) localOffset = directory.readBigUInt64LE(at);
      }
      extra += 4 + length;
    }
    if (flags & 1) throw new ZipFormatError(`zip entry ${name} is encrypted`);
    entries.push({
      name,
      method,
      compressedSize: safeNumber(compressed, "entry size"),
      uncompressedSize: safeNumber(uncompressed, "entry size"),
      crc32: entryCrc,
      localHeaderOffset: safeNumber(localOffset, "entry offset"),
    });
    pos = next;
  }
  return entries;
}

async function* compressedChunks(source: RandomAccess, entry: ZipEntry): AsyncGenerator<Buffer> {
  const header = await source.read(entry.localHeaderOffset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIG) throw new ZipFormatError(`zip entry ${entry.name} has no data header`);
  const dataStart = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (dataStart + entry.compressedSize > source.size) throw new ZipFormatError(`zip entry ${entry.name} is out of range`);
  for (let done = 0; done < entry.compressedSize; ) {
    const length = Math.min(READ_CHUNK, entry.compressedSize - done);
    const chunk = await source.read(dataStart + done, length);
    if (chunk.length !== length) throw new ZipFormatError(`zip entry ${entry.name} is truncated`);
    done += length;
    yield chunk;
  }
}

/**
 * The entry's uncompressed bytes, in order. Never yields more than the
 * entry declares, and the CRC is checked at the end (throws on mismatch), so a
 * truncated or tampered download cannot be mistaken for a clean one.
 */
export async function* readZipEntry(source: RandomAccess, entry: ZipEntry): AsyncGenerator<Buffer> {
  let produced = 0;
  let crc = 0;
  const finish = (): void => {
    if (produced !== entry.uncompressedSize) throw new ZipFormatError(`zip entry ${entry.name} has the wrong size`);
    if (crc >>> 0 !== entry.crc32) throw new ZipFormatError(`zip entry ${entry.name} failed its checksum`);
  };
  if (entry.method === 0) {
    for await (const chunk of compressedChunks(source, entry)) {
      produced += chunk.length;
      crc = crc32(chunk, crc);
      yield chunk;
    }
    finish();
    return;
  }
  if (entry.method !== 8) throw new ZipFormatError(`zip entry ${entry.name} uses an unsupported compression method`);
  const inflate = createInflateRaw();
  const feeder = (async () => {
    try {
      for await (const chunk of compressedChunks(source, entry)) {
        if (!inflate.write(chunk)) await once(inflate, "drain");
      }
      inflate.end();
    } catch (err) {
      inflate.destroy(err instanceof Error ? err : new Error("zip read failed"));
    }
  })();
  try {
    for await (const out of inflate) {
      const chunk = out as Buffer;
      produced += chunk.length;
      if (produced > entry.uncompressedSize) throw new ZipFormatError(`zip entry ${entry.name} is larger than it declares`);
      crc = crc32(chunk, crc);
      yield chunk;
    }
  } finally {
    inflate.destroy();
    await feeder;
  }
  finish();
}

/** Splits a byte stream into text lines (`\n`, with a trailing `\r` removed). */
export async function* readLines(chunks: AsyncIterable<Buffer>): AsyncGenerator<string> {
  let rest = "";
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of chunks) {
    rest += decoder.decode(chunk, { stream: true });
    if (rest.length > MAX_LINE_CHARS && !rest.includes("\n")) throw new ZipFormatError("a line in the file is far too long");
    let at = rest.indexOf("\n");
    let from = 0;
    while (at >= 0) {
      const line = rest.slice(from, at);
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
      from = at + 1;
      at = rest.indexOf("\n", from);
    }
    rest = rest.slice(from);
  }
  rest += decoder.decode();
  if (rest.length > 0) yield rest.endsWith("\r") ? rest.slice(0, -1) : rest;
}
