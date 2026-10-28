import { readFileSync } from "node:fs";
import { parse as parseDotenv } from "dotenv";
import { CRYPTO_REAL_MONEY_ENV } from "./services/crypto-real-money-lock.js";
import { adoptServerSecretsFromEnvFile } from "./server-secrets.js";

/**
 * Names a .env file may never put into process.env. Agents can write these
 * files, so a setting that unlocks something dangerous must come from the real
 * environment (the deploy settings) only. DUR-4996: the real-money lock.
 */
const ENV_FILE_REFUSED_NAMES: readonly string[] = [CRYPTO_REAL_MONEY_ENV];

function warn(message: string): void {
  // The logger is not loaded yet at boot (and must not be: it reads config).
  try {
    process.stderr.write(`[env-file] ${message}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * Load a .env file into process.env without overriding what is already set
 * (dotenv's `override: false`). DUR-3994 Stage 1: the server's own key names
 * never go into process.env from here -- agents would inherit them, and an
 * agent can write these files, so a key there could be planted for the next
 * restart. See adoptServerSecretsFromEnvFile for what happens to them.
 * DUR-4996: the real-money lock variable is refused the same way, by name only.
 */
export function loadEnvFileIntoProcessEnv(path: string, label: string): void {
  let entries: Record<string, string>;
  try {
    entries = parseDotenv(readFileSync(path));
  } catch {
    return;
  }
  const refused = ENV_FILE_REFUSED_NAMES.filter((name) => name in entries);
  if (refused.length > 0) {
    entries = { ...entries };
    for (const name of refused) delete entries[name];
    warn(
      `ignored ${refused.join(", ")} in ${label}: this setting is only read from the server's deploy settings`,
    );
  }
  const passThrough = adoptServerSecretsFromEnvFile(entries, label);
  for (const [name, value] of Object.entries(passThrough)) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
}
