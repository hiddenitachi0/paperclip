import { redactKnownLeakedSecretPatterns, redactSensitiveText } from "../redaction.js";

/**
 * DUR-4520 (Brag video, parent DUR-4518): nothing from a repo or a fetched
 * page may reach a rendered frame without passing through here first. Two
 * layers: (1) whole files that are credential-bearing by name are never read
 * at all, (2) every line of what is left is redacted with the repo's shared
 * secret patterns plus key=value / private-key-block heuristics.
 */

const SECRET_FILE_NAME_RES: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /^\.envrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^credentials(\.\w+)?$/i,
  /^secrets?(\.\w+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /^docker-compose.*\.ya?ml$/i,
  /^terraform\.tfstate(\.backup)?$/i,
  /\.tfvars$/i,
];

const SECRET_DIR_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".git", "node_modules", "secrets"]);

export const BRAG_REDACTION_MARKER = "[REDACTED]";

/** True when a repo-relative path must never be read, shown, or diffed. */
export function isSecretBearingPath(relPath: string): boolean {
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return false;
  const base = parts[parts.length - 1]!;
  if (SECRET_FILE_NAME_RES.some((re) => re.test(base))) return true;
  return parts.slice(0, -1).some((seg) => SECRET_DIR_SEGMENTS.has(seg.toLowerCase()));
}

const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
// KEY=value / "key": "value" where the key name looks credential-like.
const KV_SECRET_RE =
  /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|passwd|api[_-]?key|apikey|private[_-]?key|credential|auth|bearer|dsn|connection[_-]?string)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi;
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const AUTH_HEADER_RE = /\b(authorization\s*[:=]\s*)(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const LONG_TOKEN_RE = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g;

/** Redacts credential-shaped content from free text. Idempotent. */
export function redactForScreen(text: string): string {
  let out = text.replace(PRIVATE_KEY_BLOCK_RE, BRAG_REDACTION_MARKER);
  out = out.replace(URL_CREDENTIALS_RE, (_m, scheme: string) => `${scheme}${BRAG_REDACTION_MARKER}@`);
  out = out.replace(AUTH_HEADER_RE, (_m, prefix: string) => `${prefix}${BRAG_REDACTION_MARKER}`);
  out = out.replace(KV_SECRET_RE, (_m, key: string, sep: string) => `${key}${sep}${BRAG_REDACTION_MARKER}`);
  out = redactKnownLeakedSecretPatterns(out);
  out = redactSensitiveText(out);
  // Last resort: opaque mixed letter+digit blobs of 32+ chars (API keys, hashes with no prefix).
  out = out.replace(LONG_TOKEN_RE, BRAG_REDACTION_MARKER);
  return out;
}

export interface MaskedFile {
  path: string;
  content: string | null;
  skipped: boolean;
}

/** Applies both layers to one file. A secret-bearing path yields skipped:true and no content at all. */
export function maskFileForScreen(relPath: string, content: string): MaskedFile {
  if (isSecretBearingPath(relPath)) return { path: relPath, content: null, skipped: true };
  return { path: relPath, content: redactForScreen(content), skipped: false };
}

/** True if text still contains something the redactor would change -- used as a final assertion before text reaches a scene. */
export function containsUnredactedSecret(text: string): boolean {
  return redactForScreen(text) !== text;
}
