import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * Passphrase-encrypted transport for the secret VALUES that travel with a
 * company migration ("selective secrets").
 *
 * Secret material is encrypted per-instance under an instance master.key, so it
 * cannot be copied raw between servers. The migration therefore decrypts the
 * operator's SELECTED secrets on the source and re-encrypts them on the
 * destination. In between, the plaintext values would be exposed — so we never
 * write them to the shareable package or hand them to the CLI in the clear.
 * Instead the source server seals `{envInputScopedKey -> value}` into this
 * bundle under an operator passphrase; the destination server opens it with the
 * same passphrase and feeds the values into the normal import secret-creation
 * path. The CLI only ever carries the opaque sealed blob and forwards the
 * passphrase — plaintext values stay server-side on both ends.
 *
 * Format: AES-256-GCM with an scrypt-derived key. The envelope (base64-encoded
 * JSON) self-describes its KDF params so it stays openable if defaults change.
 */

const BUNDLE_VERSION = 1;
const SCRYPT_N = 1 << 15; // 32768 — CPU/memory cost
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 32; // AES-256
const SALT_LEN = 16;
const IV_LEN = 12; // GCM standard nonce

interface SealedBundleEnvelope {
  v: number;
  kdf: "scrypt";
  n: number;
  r: number;
  p: number;
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64 ciphertext
  tag: string; // base64 GCM auth tag
}

function deriveKey(passphrase: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  // maxmem must be raised above the default 32MB for N=32768.
  return scryptSync(passphrase, salt, KEY_LEN, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
}

/**
 * Seal a map of secret values under `passphrase`. Returns an opaque base64
 * string safe to write to a sidecar file / send over the wire. Throws on an
 * empty passphrase (a passphrase-less bundle would defeat the purpose).
 */
export function sealSecretBundle(values: Record<string, string>, passphrase: string): string {
  if (!passphrase || passphrase.length === 0) {
    throw new Error("A passphrase is required to seal a secret bundle.");
  }
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt, SCRYPT_N, SCRYPT_r, SCRYPT_p);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(values), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: SealedBundleEnvelope = {
    v: BUNDLE_VERSION,
    kdf: "scrypt",
    n: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

function isSealedEnvelope(value: unknown): value is SealedBundleEnvelope {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    e.kdf === "scrypt" &&
    typeof e.salt === "string" &&
    typeof e.iv === "string" &&
    typeof e.ct === "string" &&
    typeof e.tag === "string" &&
    typeof e.n === "number" &&
    typeof e.r === "number" &&
    typeof e.p === "number"
  );
}

/**
 * Open a bundle sealed by {@link sealSecretBundle}. Throws
 * `SecretBundlePassphraseError` when the passphrase is wrong or the blob has
 * been tampered with (GCM auth failure) — so callers can surface a clean
 * "wrong passphrase" message instead of a raw crypto error.
 */
export class SecretBundlePassphraseError extends Error {
  constructor(message = "Could not open the secret bundle — wrong passphrase or corrupted data.") {
    super(message);
    this.name = "SecretBundlePassphraseError";
  }
}

export function openSecretBundle(blob: string, passphrase: string): Record<string, string> {
  if (!passphrase || passphrase.length === 0) {
    throw new Error("A passphrase is required to open a secret bundle.");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(blob, "base64").toString("utf8"));
  } catch {
    throw new SecretBundlePassphraseError("Malformed secret bundle.");
  }
  if (!isSealedEnvelope(envelope)) {
    throw new SecretBundlePassphraseError("Unrecognized secret bundle format.");
  }
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ct = Buffer.from(envelope.ct, "base64");
  const key = deriveKey(passphrase, salt, envelope.n, envelope.r, envelope.p);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new SecretBundlePassphraseError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new SecretBundlePassphraseError("Secret bundle payload was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretBundlePassphraseError("Secret bundle payload had an unexpected shape.");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Constant-time equality for two same-length secrets (test/util helper). */
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
