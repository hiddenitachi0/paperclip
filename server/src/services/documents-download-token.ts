import { createHmac, timingSafeEqual } from "node:crypto";
import { readServerSecret } from "../server-secrets.js";

/**
 * DUR-4303: the short-lived, server-proxied download link get_document hands
 * back. The browser/agent must never see the raw paperless-ngx URL or token
 * (design doc), so the link names neither: it carries only `company_id`,
 * `document_id` and `exp`, signed with a key derived from the master secret
 * the same way agent-auth-jwt.ts derives its per-company signing key --
 * domain-separated with a distinct `documents-download:` prefix so this
 * token kind can never be replayed as, or forged from, an agent run JWT even
 * if the same master secret leaked.
 *
 * `company_id` is carried so the download route can look up ONLY that
 * company's `paperless_ngx` connection -- never a connection id, host or
 * credential, which would let a stale/forged token point at a container that
 * is no longer (or never was) this company's own. The route still re-reads
 * that company's connection row fresh from the database on every request
 * (data-connections.ts's own company-scoped lookup); the token's job is only
 * to say WHICH company and WHICH document, for a bounded amount of time.
 */

const DEFAULT_TTL_SECONDS = 300;

export interface DocumentDownloadTokenClaims {
  companyId: string;
  documentId: number;
  exp: number;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function deriveSigningKey(masterSecret: string, companyId: string): string {
  return createHmac("sha256", masterSecret).update(`documents-download:${companyId}`).digest("hex");
}

function masterSecret(): string | null {
  return readServerSecret("PAPERCLIP_AGENT_JWT_SECRET")?.trim() || readServerSecret("BETTER_AUTH_SECRET")?.trim() || null;
}

function sign(secret: string, signingInput: string): string {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Null when the server has no signing secret configured; callers must refuse to offer a download link in that case. */
export function createDocumentDownloadToken(
  companyId: string,
  documentId: number,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string | null {
  const secret = masterSecret();
  if (!secret) return null;
  const claims: DocumentDownloadTokenClaims = {
    companyId,
    documentId,
    exp: Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSeconds)),
  };
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = sign(deriveSigningKey(secret, companyId), payload);
  return `${payload}.${signature}`;
}

/** Null on any invalid, malformed, mis-signed or expired token. Never throws. */
export function verifyDocumentDownloadToken(token: string): DocumentDownloadTokenClaims | null {
  if (!token) return null;
  const secret = masterSecret();
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;

  let claims: Record<string, unknown> | null;
  try {
    claims = JSON.parse(base64UrlDecode(payload!)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!claims) return null;

  const companyId = typeof claims.companyId === "string" ? claims.companyId : null;
  const documentId = typeof claims.documentId === "number" ? claims.documentId : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!companyId || documentId === null || exp === null) return null;

  const expectedSignature = sign(deriveSigningKey(secret, companyId), payload!);
  if (!safeCompare(signature!, expectedSignature)) return null;

  if (exp < Math.floor(Date.now() / 1000)) return null;

  return { companyId, documentId, exp };
}
