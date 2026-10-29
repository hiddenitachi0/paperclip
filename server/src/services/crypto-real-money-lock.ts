import { CRYPTO_REAL_MONEY_ENV } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

export { CRYPTO_REAL_MONEY_ENV };

/**
 * Server-wide lock on real-money ("mainnet") crypto.
 *
 * Real money is forbidden unless the server's operator sets
 * PAPERCLIP_CRYPTO_REAL_MONEY to exactly `allowed`. Unset, empty, or any
 * other value (including `Allowed`, `true`, `1`) keeps it forbidden, so the
 * default is safe for every install.
 *
 * The environment is read on every call and never cached: the lock cannot
 * go stale, and it can never be lifted by anything stored in the database
 * (company settings, wallet rows), which only matter once this allows it.
 */
export const CRYPTO_REAL_MONEY_LOCK_MESSAGE =
  "Real money is switched off on this server (administrator setting). Only test-network wallets can be used.";

export function isCryptoRealMoneyAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CRYPTO_REAL_MONEY_ENV] === "allowed";
}

/** Throws a 403 with a plain message while real money is forbidden on this server. */
export function assertCryptoRealMoneyAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (!isCryptoRealMoneyAllowed(env)) throw forbidden(CRYPTO_REAL_MONEY_LOCK_MESSAGE);
}

/** The one boot-time warning. Never includes secrets: only the variable name and whether it allows real money. */
export function describeCryptoRealMoneyLockForBoot(env: NodeJS.ProcessEnv = process.env): string {
  return isCryptoRealMoneyAllowed(env)
    ? `${CRYPTO_REAL_MONEY_ENV}=allowed: real-money crypto wallets are ALLOWED on this server. Company owners can switch real money on.`
    : `${CRYPTO_REAL_MONEY_ENV} is not 'allowed': real-money crypto is locked off on this server. Existing main-network wallets and settings are frozen and nothing can be signed on a main network.`;
}
