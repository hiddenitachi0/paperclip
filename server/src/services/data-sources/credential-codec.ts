import type { DataConnectionCredentialInput, DataConnectionCredentialKind } from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";

/**
 * DUR-3997 slice 3: how a connection's credential is written into, and read
 * back out of, its company secret. Keyed by credential kind, which belongs to
 * exactly one source kind.
 *
 * The two Shopify encodings are exactly what slice S1 wrote (a bare token for
 * admin_access_token, a JSON pair for client_credentials), so the secret the
 * live Shopify connection already holds decodes unchanged. New kinds use the
 * same two shapes: a single value is stored bare, several values as JSON.
 */

/** The last four characters of the secret part, and nothing else. */
export function credentialHint(credential: DataConnectionCredentialInput): string {
  const secretPart = credentialSecretValues(credential)[0] ?? "";
  return `••••${secretPart.slice(-4)}`;
}

/** Every value that must be scrubbed out of any text, most secret first. */
export function credentialSecretValues(credential: DataConnectionCredentialInput): string[] {
  switch (credential.kind) {
    case "admin_access_token":
      return [credential.accessToken];
    case "client_credentials":
      return [credential.clientSecret, credential.clientId];
    case "consumer_key_secret":
      return [credential.consumerSecret, credential.consumerKey];
    case "api_token":
      return [credential.apiToken];
    case "password":
      return [credential.password];
    case "private_key":
      return credential.passphrase ? [credential.privateKey, credential.passphrase] : [credential.privateKey];
  }
}

export function encodeCredential(credential: DataConnectionCredentialInput): string {
  switch (credential.kind) {
    case "admin_access_token":
      return credential.accessToken;
    case "client_credentials":
      return JSON.stringify({ clientId: credential.clientId, clientSecret: credential.clientSecret });
    case "consumer_key_secret":
      return JSON.stringify({ consumerKey: credential.consumerKey, consumerSecret: credential.consumerSecret });
    case "api_token":
      return credential.apiToken;
    case "password":
      return credential.password;
    case "private_key":
      return JSON.stringify({
        privateKey: credential.privateKey,
        ...(credential.passphrase ? { passphrase: credential.passphrase } : {}),
      });
  }
}

function parseRecord(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function unreadable(): never {
  throw unprocessable("Den lagrede nøkkelen for denne koblingen kan ikke leses. Lim den inn på nytt.", {
    code: "credential_unreadable",
  });
}

/** Never logs and never includes `raw` in any error. */
export function decodeCredential(kind: string, raw: string): DataConnectionCredentialInput {
  switch (kind as DataConnectionCredentialKind) {
    case "admin_access_token":
      return raw ? { kind: "admin_access_token", accessToken: raw } : unreadable();
    case "client_credentials": {
      const record = parseRecord(raw);
      const clientId = str(record.clientId);
      const clientSecret = str(record.clientSecret);
      return clientId && clientSecret ? { kind: "client_credentials", clientId, clientSecret } : unreadable();
    }
    case "consumer_key_secret": {
      const record = parseRecord(raw);
      const consumerKey = str(record.consumerKey);
      const consumerSecret = str(record.consumerSecret);
      return consumerKey && consumerSecret ? { kind: "consumer_key_secret", consumerKey, consumerSecret } : unreadable();
    }
    case "api_token":
      return raw ? { kind: "api_token", apiToken: raw } : unreadable();
    case "password":
      return raw ? { kind: "password", password: raw } : unreadable();
    case "private_key": {
      const record = parseRecord(raw);
      const privateKey = str(record.privateKey);
      const passphrase = str(record.passphrase);
      return privateKey ? { kind: "private_key", privateKey, ...(passphrase ? { passphrase } : {}) } : unreadable();
    }
    default:
      return unreadable();
  }
}
