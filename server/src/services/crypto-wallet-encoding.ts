/**
 * Small, dependency-free encoders the crypto wallet chains need: hex,
 * base58 (Solana addresses, Bitcoin WIF keys), bech32/bech32m (Bitcoin
 * address checksums), RLP (Ethereum transactions) and a minimal MessagePack
 * writer (Hyperliquid action hashing). Pure functions, no key material is
 * ever logged or kept here. Hashing and signing live behind the primitives
 * adapter in crypto-wallet-chains.ts.
 */

// ─── hex ─────────────────────────────────────────────────────────────────────

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error("Not valid hex.");
  return new Uint8Array(Buffer.from(clean, "hex"));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
}

/** Big-endian bytes of a non-negative integer, minimal length (0 -> empty). */
export function bigintToBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("Negative values cannot be encoded.");
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return hexToBytes(hex);
}

export function bigintToFixedBytes(value: bigint, length: number): Uint8Array {
  const raw = bigintToBytes(value);
  if (raw.length > length) throw new Error("Value does not fit.");
  const out = new Uint8Array(length);
  out.set(raw, length - raw.length);
  return out;
}

export function bytesToBigint(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${bytesToHex(bytes)}`);
}

// ─── base58 ──────────────────────────────────────────────────────────────────

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58_ALPHABET].map((char, i) => [char, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let value = bytesToBigint(bytes);
  let out = "";
  while (value > 0n) {
    out = B58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  let value = 0n;
  for (const char of text) {
    const digit = B58_INDEX.get(char);
    if (digit === undefined) throw new Error("Not valid base58.");
    value = value * 58n + BigInt(digit);
  }
  const body = bigintToBytes(value);
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

// ─── bech32 / bech32m (BIP-173 / BIP-350) ───────────────────────────────────

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i]!;
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null;
  }
  return out;
}

/** Decodes and checks a segwit address. Returns null when the checksum or shape is wrong. */
export function decodeSegwitAddress(expectedHrp: "bc" | "tb", address: string): { version: number; program: Uint8Array } | null {
  if (address.length < 14 || address.length > 90) return null;
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return null;
  const lower = address.toLowerCase();
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) return null;
  const hrp = lower.slice(0, sep);
  if (hrp !== expectedHrp) return null;
  const data: number[] = [];
  for (const char of lower.slice(sep + 1)) {
    const v = BECH32_CHARSET.indexOf(char);
    if (v === -1) return null;
    data.push(v);
  }
  const check = bech32Polymod([...bech32HrpExpand(hrp), ...data]);
  const version = data[0]!;
  const expectedConst = version === 0 ? BECH32_CONST : BECH32M_CONST;
  if (check !== expectedConst) return null;
  const program = convertBits(data.slice(1, -6), 5, 8, false);
  if (!program || program.length < 2 || program.length > 40 || version > 16) return null;
  if (version === 0 && program.length !== 20 && program.length !== 32) return null;
  return { version, program: new Uint8Array(program) };
}

export function encodeSegwitAddress(hrp: "bc" | "tb", version: number, program: Uint8Array): string {
  const data = [version, ...(convertBits([...program], 8, 5, true) ?? [])];
  const constant = version === 0 ? BECH32_CONST : BECH32M_CONST;
  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ constant;
  const checksum = Array.from({ length: 6 }, (_, i) => (polymod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((v) => BECH32_CHARSET[v]).join("")}`;
}

// ─── RLP (Ethereum) ──────────────────────────────────────────────────────────

export type RlpInput = Uint8Array | RlpInput[];

function rlpLength(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  const lenBytes = bigintToBytes(BigInt(length));
  return concatBytes(Uint8Array.of(offset + 55 + lenBytes.length), lenBytes);
}

export function rlpEncode(input: RlpInput): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 1 && input[0]! < 0x80) return input;
    return concatBytes(rlpLength(input.length, 0x80), input);
  }
  const body = concatBytes(...input.map(rlpEncode));
  return concatBytes(rlpLength(body.length, 0xc0), body);
}

// ─── MessagePack (only what Hyperliquid actions use) ─────────────────────────

export type MsgpackValue = null | boolean | number | string | MsgpackValue[] | { [key: string]: MsgpackValue };

/**
 * Encodes maps in insertion order, which is what Hyperliquid's action hash
 * relies on (it mirrors the Python SDK's msgpack.packb on a dict). Numbers
 * must be safe integers -- every price and size in an action is a string.
 */
export function msgpackEncode(value: MsgpackValue): Uint8Array {
  const parts: number[] = [];
  const push = (...bytes: number[]): void => {
    parts.push(...bytes);
  };
  const pushBytes = (bytes: Uint8Array) => {
    for (const b of bytes) parts.push(b);
  };
  const write = (v: MsgpackValue): void => {
    if (v === null) return push(0xc0);
    if (v === true) return push(0xc3);
    if (v === false) return push(0xc2);
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) throw new Error("Only whole numbers can be packed; send decimals as text.");
      if (v >= 0) {
        if (v < 0x80) return push(v);
        if (v <= 0xff) return push(0xcc, v);
        if (v <= 0xffff) return push(0xcd, v >> 8, v & 0xff);
        if (v <= 0xffffffff) return push(0xce, ...bigintToFixedBytes(BigInt(v), 4));
        return push(0xcf, ...bigintToFixedBytes(BigInt(v), 8));
      }
      if (v >= -32) return push(v & 0xff);
      if (v >= -128) return push(0xd0, v & 0xff);
      if (v >= -32768) return push(0xd1, (v >> 8) & 0xff, v & 0xff);
      if (v >= -2147483648) return push(0xd2, ...bigintToFixedBytes(BigInt.asUintN(32, BigInt(v)), 4));
      return push(0xd3, ...bigintToFixedBytes(BigInt.asUintN(64, BigInt(v)), 8));
    }
    if (typeof v === "string") {
      const bytes = new TextEncoder().encode(v);
      const n = bytes.length;
      if (n < 32) push(0xa0 | n);
      else if (n <= 0xff) push(0xd9, n);
      else if (n <= 0xffff) push(0xda, n >> 8, n & 0xff);
      else push(0xdb, ...bigintToFixedBytes(BigInt(n), 4));
      return pushBytes(bytes);
    }
    if (Array.isArray(v)) {
      const n = v.length;
      if (n < 16) push(0x90 | n);
      else if (n <= 0xffff) push(0xdc, n >> 8, n & 0xff);
      else push(0xdd, ...bigintToFixedBytes(BigInt(n), 4));
      for (const item of v) write(item);
      return;
    }
    const entries = Object.entries(v);
    const n = entries.length;
    if (n < 16) push(0x80 | n);
    else if (n <= 0xffff) push(0xde, n >> 8, n & 0xff);
    else push(0xdf, ...bigintToFixedBytes(BigInt(n), 4));
    for (const [key, item] of entries) {
      write(key);
      write(item);
    }
  };
  write(value);
  return Uint8Array.from(parts);
}

/** "1.500" -> "1.5", "2.0" -> "2": the decimal-text form Hyperliquid expects. */
export function normalizeDecimalString(value: string): string {
  if (!value.includes(".")) return value.replace(/^0+(?=\d)/, "");
  const [whole, frac] = value.split(".");
  const trimmedFrac = frac!.replace(/0+$/, "");
  const trimmedWhole = whole!.replace(/^0+(?=\d)/, "") || "0";
  return trimmedFrac ? `${trimmedWhole}.${trimmedFrac}` : trimmedWhole;
}
