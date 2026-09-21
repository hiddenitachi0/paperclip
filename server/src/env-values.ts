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
 * Deliberately dependency-free (no config.ts import, which loads .env files
 * as a side effect) so services can use it cheaply.
 */
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

/** The Anthropic API key, or undefined when it is unset, empty or blank. */
export function readAnthropicApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readNonBlankEnv("ANTHROPIC_API_KEY", env);
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
