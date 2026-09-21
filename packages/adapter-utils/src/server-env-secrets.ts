/**
 * DUR-3994 Stage 0: environment variables that belong to the Paperclip server
 * alone and must never reach any process the server starts (agents, board
 * chat, workspace setup commands, runtime services, previews, CLI probes).
 *
 * `BETTER_AUTH_SECRET` signs every login session and (without a separate
 * agent-token key) every agent token for every company; an agent that could
 * `printenv` it could forge a signed-in board session. The other names are
 * the server's own signing / encryption / backend keys.
 *
 * This is a list of names to REMOVE rather than a list of names to keep, so
 * nothing agents legitimately rely on (HOME, OPENCODE_ALLOW_ALL_MODELS,
 * GEMINI_SANDBOX, the PAPERCLIP_* settings setup commands read) disappears.
 */
export const SERVER_ONLY_ENV_NAMES: readonly string[] = Object.freeze([
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_TELEMETRY_BACKEND_TOKEN",
  "PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN",
  "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN",
  "PAPERCLIP_DEV_SERVER_STATUS_TOKEN",
]);

/** Any name starting with one of these is server-only too (e.g. PAPERCLIP_SERVER_ANTHROPIC_API_KEY). */
export const SERVER_ONLY_ENV_PREFIXES: readonly string[] = Object.freeze(["PAPERCLIP_SERVER_"]);

/**
 * The server's own database addresses. These are removed from a child's
 * environment only when the value is one the server itself holds (under any
 * of these names), so a database address someone deliberately configured for
 * one agent -- a different, scoped login -- still reaches that agent (DUR-294).
 */
export const SERVER_DATABASE_ENV_NAMES: readonly string[] = Object.freeze([
  "DATABASE_URL",
  "DATABASE_BYPASS_URL",
  "DATABASE_MIGRATION_URL",
]);

export function isServerOnlyEnvName(name: string): boolean {
  if (SERVER_ONLY_ENV_NAMES.includes(name)) return true;
  return SERVER_ONLY_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * DUR-3994 Stage 1: every name the server treats as its own secret -- the
 * server-only names above plus its database addresses. The server keeps the
 * values of these names in memory only (server/src/server-secrets.ts), and
 * the container entrypoint hands them over through a one-shot pipe instead of
 * the environment, so they never appear in /proc/<server>/environ. This is the
 * one list both of those read (the entrypoint asks it through
 * server/src/server-secrets-handoff.ts); do not copy it anywhere else.
 */
export function isServerSecretEnvName(name: string): boolean {
  return isServerOnlyEnvName(name) || SERVER_DATABASE_ENV_NAMES.includes(name);
}

/**
 * Where the server's in-memory secrets are published for the equality rule
 * below. Once the server has moved its database addresses out of process.env
 * (Stage 1), `stripServerSecrets` can no longer find them there, so the
 * server registers a reader here. Kept on a global symbol, not a module
 * variable, so a second copy of this module (source vs. built) still sees it.
 */
const SERVER_SECRET_VALUES_KEY = Symbol.for("paperclip.dur3994.serverSecretValues");

type ServerSecretValuesReader = () => Iterable<readonly [string, string]>;

export function registerServerSecretValuesReader(reader: ServerSecretValuesReader | null): void {
  (globalThis as Record<symbol, unknown>)[SERVER_SECRET_VALUES_KEY] = reader ?? undefined;
}

function readRegisteredServerSecretValues(): Array<readonly [string, string]> {
  const reader = (globalThis as Record<symbol, unknown>)[SERVER_SECRET_VALUES_KEY];
  if (typeof reader !== "function") return [];
  try {
    return Array.from((reader as ServerSecretValuesReader)());
  } catch {
    return [];
  }
}

/**
 * Remove the server's own keys from `env` IN PLACE and return it.
 *
 * Apply this to the FINAL environment a child will receive -- after every
 * merge -- so an adapter that copies all of `process.env` into its own env
 * (hermes does) is covered too, not only the inherited base.
 *
 * `serverEnv` is where the server's own database addresses are read from for
 * the equality rule (process.env by default), together with any values the
 * server registered through `registerServerSecretValuesReader`. Never throws: a malformed
 * entry is simply left for the name rule.
 */
export function stripServerSecrets<T extends Record<string, string | undefined>>(
  env: T,
  serverEnv: NodeJS.ProcessEnv = process.env,
): T {
  const serverDatabaseValues = new Set<string>();
  const addServerDatabaseValue = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    serverDatabaseValues.add(trimmed);
  };
  for (const name of SERVER_DATABASE_ENV_NAMES) {
    addServerDatabaseValue(serverEnv[name]);
  }
  // Stage 1: the server's own addresses now live in memory, not process.env.
  for (const [name, value] of readRegisteredServerSecretValues()) {
    if (SERVER_DATABASE_ENV_NAMES.includes(name)) addServerDatabaseValue(value);
  }
  for (const key of Object.keys(env)) {
    if (isServerOnlyEnvName(key)) {
      delete env[key];
      continue;
    }
    if (SERVER_DATABASE_ENV_NAMES.includes(key)) {
      const value = env[key];
      if (typeof value === "string" && serverDatabaseValues.has(value.trim())) {
        delete env[key];
      }
    }
  }
  return env;
}
