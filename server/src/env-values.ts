/**
 * DUR-3945: one rule for "is this environment variable set?".
 *
 * Deploys put optional settings (database logins, the Anthropic key) in a
 * docker/.env file. A line like `DATABASE_MIGRATION_URL=` with nothing after
 * it -- or only spaces -- is a half-finished edit, not a real value. Before
 * this helper some readers treated "" as unset while others used it as a real
 * database address, which would have made the next start's migrations fail.
 * Everything that reads these variables now goes through here: empty or
 * whitespace-only means unset, and a real value is returned trimmed.
 *
 * Deliberately free of config.ts (which loads .env files as a side effect)
 * so services can use it cheaply.
 */
import {
  holdServerSecret,
  readHeldServerSecret,
  resetServerSecretsForTests,
} from "./server-secrets.js";

export function readNonBlankEnvValue(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readNonBlankEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return readNonBlankEnvValue(env[name]);
}

/**
 * DUR-3945: the server-only name for the Anthropic key.
 *
 * A key set as plain ANTHROPIC_API_KEY on the server process is inherited by
 * every agent the server starts (claude_local builds its run environment from
 * `{ ...process.env, ...env }`). The Claude CLI prefers that key over an
 * agent's own subscription token, so the whole fleet would silently move to
 * paid API billing, agents without a credential would start running on it,
 * and any agent in any company could read it with `printenv`.
 *
 * Production therefore hands the key in under this name instead, and
 * `captureServerOnlyAnthropicApiKey()` moves it out of process.env at start-up,
 * before anything is spawned. Only the server's own callers (quick agents,
 * the secretary, the done-gate critic) can then reach it, via
 * `readAnthropicApiKey()`. Nothing that copies process.env ever sees it.
 */
export const SERVER_ANTHROPIC_API_KEY_ENV = "PAPERCLIP_SERVER_ANTHROPIC_API_KEY";

/**
 * Remove the server-only Anthropic key from `env` (process.env by default) and
 * keep it in memory for `readAnthropicApiKey()`. Safe to call more than once;
 * a later call with no key set keeps the earlier captured value.
 */
export function captureServerOnlyAnthropicApiKey(env: NodeJS.ProcessEnv = process.env): void {
  // DUR-3994 Stage 1: the key is now held with the server's other keys
  // (server-secrets.ts), which normally captured it already at boot.
  const value = readNonBlankEnv(SERVER_ANTHROPIC_API_KEY_ENV, env);
  if (value !== undefined) holdServerSecret(SERVER_ANTHROPIC_API_KEY_ENV, value);
  delete env[SERVER_ANTHROPIC_API_KEY_ENV];
}

/** Test hook: forget any captured server-only key. */
export function resetCapturedServerAnthropicApiKeyForTests(): void {
  resetServerSecretsForTests([SERVER_ANTHROPIC_API_KEY_ENV]);
}

/**
 * DUR-3995: the key an instance admin set from the settings page.
 *
 * It is kept encrypted in the database and decrypted into memory by
 * server/src/services/server-anthropic-key.ts, which registers a reader here.
 * This module deliberately knows nothing about the database (it must stay
 * cheap and free of config.ts), so the dependency points this way only: the
 * service pushes a reader in, `readAnthropicApiKey()` asks it first.
 *
 * The value never goes into `process.env` -- exactly like the captured
 * server-only variable it takes precedence over -- so nothing the server
 * spawns can inherit it (see server-secrets.ts and
 * packages/adapter-utils/src/server-env-secrets.ts `stripServerSecrets`).
 */
type StoredAnthropicApiKeyReader = () => string | undefined;
let storedAnthropicApiKeyReader: StoredAnthropicApiKeyReader | null = null;

export function registerStoredAnthropicApiKeyReader(reader: StoredAnthropicApiKeyReader | null): void {
  storedAnthropicApiKeyReader = reader;
}

function readStoredAnthropicApiKey(): string | undefined {
  if (!storedAnthropicApiKeyReader) return undefined;
  try {
    return readNonBlankEnvValue(storedAnthropicApiKeyReader());
  } catch {
    // A broken reader must never take the server's fallback key away.
    return undefined;
  }
}

/**
 * The Anthropic API key the server itself uses, or undefined when none is set
 * (unset, empty and whitespace-only all count as none). Order: the key set in
 * the settings page (DUR-3995), the captured server-only key, the server-only
 * variable if not captured yet, then plain ANTHROPIC_API_KEY (installs that
 * deliberately share one key with agents).
 *
 * The stored key is consulted only for the real process environment: a caller
 * that passes its own `env` is asking what THAT environment says.
 */
export function readAnthropicApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env === process.env) {
    const stored = readStoredAnthropicApiKey();
    if (stored !== undefined) return stored;
  }
  return readAnthropicApiKeyIgnoringStored(env);
}

/**
 * The same resolution WITHOUT the key set in the settings page: what this
 * server would use if nothing were stored. The settings page asks this to
 * tell "using the key set up on the server itself" apart from "no key at
 * all", without ever handling either value.
 */
export function readAnthropicApiKeyIgnoringStored(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    (env === process.env ? readNonBlankEnvValue(readHeldServerSecret(SERVER_ANTHROPIC_API_KEY_ENV)) : undefined) ??
    readNonBlankEnv(SERVER_ANTHROPIC_API_KEY_ENV, env) ??
    readNonBlankEnv("ANTHROPIC_API_KEY", env)
  );
}

/**
 * Which address startup migrations connect with: the dedicated migration
 * login when one is configured, otherwise the normal DATABASE_URL. Blank
 * values count as "not configured" (never used as an address).
 */
export function resolveMigrationConnectionString(
  databaseMigrationUrl: string | null | undefined,
  databaseUrl: string,
): string {
  return readNonBlankEnvValue(databaseMigrationUrl) ?? databaseUrl;
}
