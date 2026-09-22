/**
 * DUR-3995: Paperclip's own Claude key, set from the settings page.
 *
 * The server calls Claude directly for a few things that are not an agent
 * run: the quick-answer lane (services/lane-a.ts), deciding who a request
 * goes to (services/secretary-classifier.ts), the quality check before a task
 * is marked done (services/done-gate-critic.ts) and the business-data trial.
 * All of them ask `readAnthropicApiKey()` for the key.
 *
 * Until now the only way to give it one was to write
 * PAPERCLIP_SERVER_ANTHROPIC_API_KEY into the server's .env file and restart
 * it. The owner of a business cannot do that, so Paperclip's own abilities
 * silently stayed off. This service lets an instance admin paste the key in
 * the settings page instead.
 *
 * How it is kept:
 *  - sealed with the local_encrypted material scheme (secrets/local-encrypted-
 *    provider.ts), the same one company secrets and the instance-wide Claude
 *    sign-in use: AES-256-GCM under the instance master key, which lives
 *    outside the database. The plaintext is never written to a table.
 *  - decrypted once into a module-level cache, which `readAnthropicApiKey()`
 *    reads through a registered reader. Writes update the cache straight
 *    away, so a new key works without a restart; the cache also re-reads
 *    itself when it is older than CACHE_TTL_MS, so a change made by another
 *    process is picked up within a minute.
 *  - NEVER put into `process.env`. That is the whole point of DUR-3994 Stage
 *    0/1: anything in the server's environment is inherited by every agent
 *    the server starts, and `stripServerSecrets` can only remove what it can
 *    see by name. Keeping the value in a closure means there is nothing to
 *    inherit and nothing to strip.
 *
 * No method here ever returns the key to a route, and nothing here logs it.
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceServerAnthropicKey } from "@paperclipai/db";
import type {
  InstanceServerAnthropicKeyStatus,
  InstanceServerAnthropicKeyTestResult,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  readAnthropicApiKey,
  readAnthropicApiKeyIgnoringStored,
  registerStoredAnthropicApiKeyReader,
} from "../env-values.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

const SINGLETON_KEY = "default";
const SEALED_PREFIX = "instance-server-anthropic-key:";

/** How long the decrypted key is trusted before it is quietly re-read. */
export const SERVER_ANTHROPIC_KEY_CACHE_TTL_MS = 60_000;

/**
 * The model the "Test" button calls. The cheapest one already used elsewhere
 * in the server (done-gate-critic.ts), asked for a single token: this is a
 * "does Claude accept this key" check, not a question.
 */
export const SERVER_ANTHROPIC_KEY_TEST_MODEL = "claude-haiku-4-5";

// ---------------------------------------------------------------------------
// Pure helpers (no database, no network) -- unit-tested directly.
// ---------------------------------------------------------------------------

/** The only part of a key that may ever be shown: its last four characters. */
export function serverAnthropicKeyHint(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 4 ? "…" : `…${trimmed.slice(-4)}`;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value.trim()).digest("hex").slice(0, 12);
}

export interface ServerAnthropicKeyRow {
  hint: string;
  fingerprintSha256: string;
  savedAt: Date;
  savedByUserId: string | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

/**
 * Plain-language status for the settings page. `row` is the stored key (if
 * any) and `environmentKeyPresent` says whether the old
 * PAPERCLIP_SERVER_ANTHROPIC_API_KEY is still in place -- an install that has
 * one keeps working untouched, and the page says so rather than claiming
 * nothing is set.
 */
export function describeServerAnthropicKeyStatus(
  row: ServerAnthropicKeyRow | null,
  environmentKeyPresent: boolean,
): InstanceServerAnthropicKeyStatus {
  if (row) {
    const headline =
      row.lastTestOk === false
        ? "A key is saved, but Claude did not accept it the last time it was tested."
        : row.lastTestOk === true
          ? "Paperclip has its own Claude key and Claude accepted it."
          : "A key is saved. Press Test to check that Claude accepts it.";
    return {
      configured: true,
      source: "stored",
      headline,
      hint: row.hint,
      fingerprint: row.fingerprintSha256,
      savedAt: row.savedAt.toISOString(),
      savedByUserId: row.savedByUserId,
      lastTestAt: row.lastTestAt ? row.lastTestAt.toISOString() : null,
      lastTestOk: row.lastTestOk,
      lastTestMessage: row.lastTestMessage,
    };
  }
  if (environmentKeyPresent) {
    return {
      configured: true,
      source: "environment",
      headline:
        "Paperclip is using a key set up on the server itself. Paste a key below to manage it from here instead.",
      hint: null,
      fingerprint: null,
      savedAt: null,
      savedByUserId: null,
      lastTestAt: null,
      lastTestOk: null,
      lastTestMessage: null,
    };
  }
  return {
    configured: false,
    source: null,
    headline:
      "Paperclip has no Claude key of its own yet. Quick answers, routing and the quality check stay off until you add one.",
    hint: null,
    fingerprint: null,
    savedAt: null,
    savedByUserId: null,
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: null,
  };
}

/**
 * Turn whatever the Anthropic SDK threw into one plain sentence, with
 * anything key-shaped removed. The exact upstream wording is kept -- a wrong
 * key must be obvious -- but never the key itself.
 */
export function describeAnthropicTestError(err: unknown, key: string): string {
  let message: string;
  if (err instanceof Anthropic.AuthenticationError) {
    message = `Claude did not accept this key (${err.message}).`;
  } else if (err instanceof Anthropic.PermissionDeniedError) {
    message = `This key is not allowed to use the Claude API (${err.message}).`;
  } else if (err instanceof Anthropic.RateLimitError) {
    message = `Claude is rate limiting this key right now (${err.message}). The key itself may still be fine.`;
  } else if (err instanceof Anthropic.APIError) {
    message = `Claude returned an error: ${err.message}`;
  } else if (err instanceof Error) {
    message = `Could not reach Claude: ${err.message}`;
  } else {
    message = "Could not reach Claude.";
  }
  return scrubKey(message, key);
}

/** Belt and braces: never let a key travel back out inside a message. */
export function scrubKey(text: string, key: string): string {
  const trimmed = key.trim();
  let out = trimmed.length >= 8 ? text.split(trimmed).join("[key]") : text;
  out = out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[key]");
  return out;
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

async function sealKey(value: string): Promise<string> {
  const prepared = await localEncryptedProvider.createSecret({ value });
  return `${SEALED_PREFIX}${JSON.stringify(prepared.material)}`;
}

async function unsealKey(sealed: string): Promise<string> {
  if (!sealed.startsWith(SEALED_PREFIX)) {
    throw badRequest("The saved Claude key is in an unknown format");
  }
  const material = JSON.parse(sealed.slice(SEALED_PREFIX.length)) as Record<string, unknown>;
  return localEncryptedProvider.resolveVersion({ material, externalRef: null });
}

// ---------------------------------------------------------------------------
// The cache readAnthropicApiKey() reads through
// ---------------------------------------------------------------------------

type CacheEntry = { value: string | undefined; at: number };

let cache: CacheEntry | null = null;
let loader: (() => Promise<string | undefined>) | null = null;
let refreshing: Promise<void> | null = null;
let now: () => number = () => Date.now();

function kickRefresh(): void {
  if (!loader || refreshing) return;
  const run = loader;
  refreshing = run()
    .then((value) => {
      cache = { value, at: now() };
    })
    .catch((err) => {
      // Never take the server's fallback key away because one read failed;
      // the last known value (or the environment key) keeps working.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "server-anthropic-key: could not read the saved Claude key",
      );
    })
    .finally(() => {
      refreshing = null;
    });
}

/** What `readAnthropicApiKey()` calls. Synchronous by contract: never blocks. */
function readCachedKey(): string | undefined {
  if (!cache) {
    kickRefresh();
    return undefined;
  }
  if (now() - cache.at >= SERVER_ANTHROPIC_KEY_CACHE_TTL_MS) kickRefresh();
  return cache.value;
}

/**
 * Wire the saved key into `readAnthropicApiKey()` and load it once. Called at
 * start-up, after the database is available. Resolves when the first read is
 * done, so the first quick-answer request already sees the saved key.
 */
export async function installServerAnthropicKeyReader(
  db: Db,
  deps: { now?: () => number } = {},
): Promise<void> {
  if (deps.now) now = deps.now;
  loader = () => loadStoredKey(db);
  registerStoredAnthropicApiKeyReader(readCachedKey);
  try {
    cache = { value: await loadStoredKey(db), at: now() };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "server-anthropic-key: could not read the saved Claude key at start-up",
    );
  }
}

/** Test hook: forget the cache and unregister the reader. */
export function resetServerAnthropicKeyCacheForTests(): void {
  cache = null;
  loader = null;
  refreshing = null;
  now = () => Date.now();
  registerStoredAnthropicApiKeyReader(null);
}

/** Test hook: put a value straight into the cache (no database). */
export function primeServerAnthropicKeyCacheForTests(value: string | undefined): void {
  registerStoredAnthropicApiKeyReader(readCachedKey);
  cache = { value, at: now() };
}

async function loadStoredKey(db: Db): Promise<string | undefined> {
  const row = await db
    .select({ keySealed: instanceServerAnthropicKey.keySealed })
    .from(instanceServerAnthropicKey)
    .where(eq(instanceServerAnthropicKey.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  if (!row) return undefined;
  const value = (await unsealKey(row.keySealed)).trim();
  return value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ServerAnthropicKeyServiceDeps {
  /**
   * One minimal Claude call with the given key. Injected so tests never go
   * near the network. Must resolve on success and throw on failure.
   */
  callAnthropic?: (key: string) => Promise<void>;
  now?: () => Date;
}

async function defaultCallAnthropic(key: string): Promise<void> {
  const client = new Anthropic({ apiKey: key });
  await client.messages.create({
    model: SERVER_ANTHROPIC_KEY_TEST_MODEL,
    max_tokens: 1,
    messages: [{ role: "user", content: "Hi" }],
  });
}

export function serverAnthropicKeyService(db: Db, deps: ServerAnthropicKeyServiceDeps = {}) {
  const callAnthropic = deps.callAnthropic ?? defaultCallAnthropic;
  const clock = deps.now ?? (() => new Date());

  async function readRow(): Promise<ServerAnthropicKeyRow | null> {
    const row = await db
      .select()
      .from(instanceServerAnthropicKey)
      .where(eq(instanceServerAnthropicKey.singletonKey, SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    return row ?? null;
  }

  async function getStatus(): Promise<InstanceServerAnthropicKeyStatus> {
    const row = await readRow();
    // "environment" means: this server would still have a key even with
    // nothing saved here (PAPERCLIP_SERVER_ANTHROPIC_API_KEY, captured at
    // boot, or a shared ANTHROPIC_API_KEY). Never the value, only whether.
    return describeServerAnthropicKeyStatus(row, readAnthropicApiKeyIgnoringStored() !== undefined);
  }

  return {
    getStatus,

    /**
     * Save (or replace) the key and immediately check it with Claude, so a
     * mistyped key is obvious at once. The key is kept even when the check
     * fails -- a network blip must not throw away a key the operator just
     * pasted -- and the page shows exactly what Claude said.
     */
    async save(input: {
      key: string;
      userId: string | null;
    }): Promise<InstanceServerAnthropicKeyTestResult> {
      const key = input.key.trim();
      if (key.length === 0) throw badRequest("Paste the key first.");

      const sealed = await sealKey(key);
      const at = clock();
      const values = {
        singletonKey: SINGLETON_KEY,
        keySealed: sealed,
        hint: serverAnthropicKeyHint(key),
        fingerprintSha256: fingerprint(key),
        savedByUserId: input.userId,
        savedAt: at,
        lastTestAt: null,
        lastTestOk: null,
        lastTestMessage: null,
        createdAt: at,
        updatedAt: at,
      };
      await db
        .insert(instanceServerAnthropicKey)
        .values(values)
        .onConflictDoUpdate({
          target: [instanceServerAnthropicKey.singletonKey],
          set: {
            keySealed: values.keySealed,
            hint: values.hint,
            fingerprintSha256: values.fingerprintSha256,
            savedByUserId: values.savedByUserId,
            savedAt: values.savedAt,
            lastTestAt: null,
            lastTestOk: null,
            lastTestMessage: null,
            updatedAt: at,
          },
        });

      // No restart: the new key is live for the next quick answer.
      cache = { value: key, at: now() };
      registerStoredAnthropicApiKeyReader(readCachedKey);

      return runTest(key);
    },

    /** One minimal Claude call with whatever key the server would use. */
    async test(): Promise<InstanceServerAnthropicKeyTestResult> {
      const key = readAnthropicApiKey();
      if (!key) {
        return {
          ok: false,
          message: "There is no Claude key to test yet.",
          status: await getStatus(),
        };
      }
      return runTest(key);
    },

    /** Forget the saved key. An install that also has the old server-file key falls back to it. */
    async remove(): Promise<InstanceServerAnthropicKeyStatus> {
      await db
        .delete(instanceServerAnthropicKey)
        .where(eq(instanceServerAnthropicKey.singletonKey, SINGLETON_KEY));
      cache = { value: undefined, at: now() };
      registerStoredAnthropicApiKeyReader(readCachedKey);
      return getStatus();
    },
  };

  async function runTest(key: string): Promise<InstanceServerAnthropicKeyTestResult> {
    let ok = true;
    let message = "Claude answered. This key works.";
    try {
      await callAnthropic(key);
    } catch (err) {
      ok = false;
      message = describeAnthropicTestError(err, key);
    }

    const at = clock();
    // Only a stored key has a row to record the result on; an environment key
    // is still worth testing, it just has nowhere to write the outcome.
    await db
      .update(instanceServerAnthropicKey)
      .set({ lastTestAt: at, lastTestOk: ok, lastTestMessage: message, updatedAt: at })
      .where(eq(instanceServerAnthropicKey.singletonKey, SINGLETON_KEY));

    return { ok, message, status: await getStatus() };
  }
}

export type ServerAnthropicKeyService = ReturnType<typeof serverAnthropicKeyService>;
