// Redaction for HTTP log payloads.
//
// `customProps` in logger.ts copies `req.body` / `req.params` / `req.query`
// verbatim into the 4xx/5xx log lines so operators can diagnose. That means
// Better Auth's `POST /api/auth/sign-in/email` body (which has the user's
// plaintext password) and similar payloads (sign-up, reset-password, API
// keys via Authorization header equivalents) end up on disk.
//
// This walker returns a shallow copy of the input with values for sensitive
// keys replaced with the literal string "[REDACTED]". Recurses into nested
// objects/arrays. Caps depth so a hostile or accidental cycle can't pin
// the logger.

const SENSITIVE_KEYS = new Set<string>([
  "password",
  "currentpassword",
  "newpassword",
  "passwordconfirmation",
  "password_confirmation",
  "passwordconfirm",
  "password_confirm",
  "confirmpassword",
  "confirm_password",
  "secret",
  "client_secret",
  "clientsecret",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "api_key",
  "apikey",
  "authorization",
  "auth_token",
  "authtoken",
  "session_token",
  "sessiontoken",
  "private_key",
  "privatekey",
  // DUR-3995: `key` too. A request body that calls its one secret `key` used
  // to land verbatim in server.log and stdout on any 4xx/5xx, and on this
  // server every agent can read that file. Bare `token` stays readable on
  // purpose -- it is a pagination cursor far more often than a credential --
  // so bodies that carry a real token name the field `authToken` instead.
  "key",
  "anthropic_api_key",
  "anthropicapikey",
  // DUR-3997: every credential field a data-source form can carry, plus the
  // `credential` object itself as belt and braces. A 400 from the new form is
  // the most likely first outcome of a paste, and that line must not carry
  // the pasted key.
  "credential",
  "consumerkey",
  "consumer_key",
  "consumersecret",
  "consumer_secret",
  "apitoken",
  "api_token",
  "passphrase",
  // DUR-3997: `value` too. Every body that stores or rotates a company
  // secret carries the plaintext as `value` (POST /companies/:id/secrets,
  // POST /secrets/:id/rotate, and the plain env binding {type:"plain",value}),
  // and a 409 "name already taken" on either used to write it to server.log.
  // A field called `value` is very rarely something an operator needs to
  // read back from an error log.
  "value",
]);

const MAX_DEPTH = 6;
const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth + 1 > MAX_DEPTH) return undefined;
    return value.map((entry) => redactSensitive(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactSensitive(entry, depth + 1);
  }
  return out;
}
