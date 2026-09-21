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
 * Remove the server's own keys from `env` IN PLACE and return it.
 *
 * Apply this to the FINAL environment a child will receive -- after every
 * merge -- so an adapter that copies all of `process.env` into its own env
 * (hermes does) is covered too, not only the inherited base.
 *
 * `serverEnv` is where the server's own database addresses are read from for
 * the equality rule (process.env by default). Never throws: a malformed
 * entry is simply left for the name rule.
 */
export function stripServerSecrets<T extends Record<string, string | undefined>>(
  env: T,
  serverEnv: NodeJS.ProcessEnv = process.env,
): T {
  const serverDatabaseValues = new Set<string>();
  for (const name of SERVER_DATABASE_ENV_NAMES) {
    const value = serverEnv[name];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    serverDatabaseValues.add(trimmed);
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
