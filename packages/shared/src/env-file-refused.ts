/**
 * The real-money lock variable (DUR-4996). Read from the server's real process
 * environment only.
 */
export const CRYPTO_REAL_MONEY_ENV = "PAPERCLIP_CRYPTO_REAL_MONEY";

/**
 * Names a .env file may never put into process.env. Agents can write these
 * files, so a setting that unlocks something dangerous must come from the real
 * environment (the deploy settings) only. Shared by the server and CLI env-file
 * loaders so the list cannot drift (DUR-5042).
 */
export const ENV_FILE_REFUSED_NAMES: readonly string[] = [CRYPTO_REAL_MONEY_ENV];
