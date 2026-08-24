/**
 * Plugin secrets host-side handler — resolves secret references through the
 * Paperclip secret provider system.
 *
 * When a plugin worker calls `ctx.secrets.resolve(secretRef)`, the JSON-RPC
 * request arrives at the host with `{ secretRef }`. This module provides the
 * concrete `HostServices.secrets` adapter that:
 *
 * 1. Parses the `secretRef` string to identify the secret.
 * 2. Looks up the secret record and its latest version in the database.
 * 3. Delegates to the configured `SecretProviderModule` to decrypt /
 *    resolve the raw value.
 * 4. Returns the resolved plaintext value to the worker.
 *
 * ## Secret Reference Format
 *
 * A `secretRef` is a **secret UUID** — the primary key (`id`) of a row in
 * the `company_secrets` table. Operators place these UUIDs into plugin
 * config values; plugin workers resolve them at execution time via
 * `ctx.secrets.resolve(secretId)`.
 *
 * ## Security Invariants
 *
 * - Resolved values are **never** logged, persisted, or included in error
 *   messages (per PLUGIN_SPEC.md §22).
 * - The handler is capability-gated: only plugins with `secrets.read-ref`
 *   declared in their manifest may call it (enforced by `host-client-factory`).
 * - The host handler itself does not cache resolved values. Each call goes
 *   through the secret provider to honour rotation.
 *
 * @see PLUGIN_SPEC.md §22 — Secrets
 * @see host-client-factory.ts — capability gating
 * @see services/secrets.ts — secretService used by agent env bindings
 */

import type { Db } from "@paperclipai/db";
import type { WorkerHostCallContext } from "@paperclipai/plugin-sdk";
import {
  collectSecretRefPaths,
  isUuidSecretRef,
  readConfigValueAtPath,
} from "./json-schema-secret-refs.js";
import { secretService } from "./secrets.js";

export const PLUGIN_SECRET_REFS_DISABLED_MESSAGE =
  "Plugin secret references are disabled until company-scoped plugin config lands";

/**
 * Plugins whose secret-ref resolution is allowed, keyed by manifest `id`.
 *
 * The blanket disable (see the fail-closed throw at the bottom of `resolve`)
 * stays in force for every other plugin: `plugin_config` is one row per
 * plugin instance-wide (no per-company scope at all — see
 * packages/db/src/schema/plugin_config.ts), so lifting the disable is only
 * safe where resolution also asserts the secret's own companyId matches the
 * invocation's verified companyId (below). That check makes cross-company
 * leakage impossible (a mismatched company gets a clean failure, not someone
 * else's secret) but does not make the config itself per-company — only one
 * company's `falKeySecretRef` can usefully be configured at a time until
 * DUR-189 (per-agent/per-company provider config) lands.
 *
 * DUR-174 sub-item (a).
 *
 * Exported so `plugin-loader.ts` can tell `plugin-worker-manager.ts` to
 * serialize invocation-scope registration for exactly these plugins (see
 * `WorkerStartOptions.serializeInvocationScope`) — the DUR-193 security
 * review found that a shared worker process can hold two different
 * companies' invocation scopes active at once, which turns
 * `context.invocationScope.companyId` into a replayable bearer credential
 * for a malicious/compromised worker. Every plugin not on this list keeps
 * the unconditional fail-closed throw below regardless of invocation scope,
 * so only plugins that can actually resolve secrets need serialization.
 */
export const SECRET_REF_ENABLED_PLUGIN_KEYS = new Set<string>(["paperclip.media-studio"]);

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function invalidSecretRef(secretRef: string): Error {
  const err = new Error(`Invalid secret reference: ${secretRef}`);
  err.name = "InvalidSecretRefError";
  return err;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Extract secret reference UUIDs from a plugin's configJson, scoped to only
 * the fields annotated with `format: "secret-ref"` in the schema.
 *
 * When no schema is provided, falls back to collecting all UUID-shaped strings
 * (backwards-compatible for plugins without a declared instanceConfigSchema).
 */
export function extractSecretRefsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Set<string> {
  return new Set(extractSecretRefPathsFromConfig(configJson, schema).keys());
}

export function extractSecretRefPathsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  const addRef = (secretRef: string, path: string) => {
    const existing = refs.get(secretRef) ?? new Set<string>();
    existing.add(path);
    refs.set(secretRef, existing);
  };
  if (configJson == null || typeof configJson !== "object") return new Map();

  const secretPaths = collectSecretRefPaths(schema);

  // If schema declares secret-ref paths, extract only those values.
  if (secretPaths.size > 0) {
    for (const dotPath of secretPaths) {
      const current = readConfigValueAtPath(configJson as Record<string, unknown>, dotPath);
      if (typeof current === "string" && isUuidSecretRef(current)) {
        addRef(current, dotPath);
      }
    }
    return refs;
  }

  // Fallback: no schema or no secret-ref annotations — collect all UUIDs.
  // This preserves backwards compatibility for plugins that omit
  // instanceConfigSchema.
  function walkAll(value: unknown): void {
    if (typeof value === "string") {
      if (isUuidSecretRef(value)) addRef(value, "$");
    } else if (Array.isArray(value)) {
      for (const item of value) walkAll(item);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walkAll(v);
    }
  }

  walkAll(configJson);
  return refs;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Input shape for the `secrets.resolve` handler.
 *
 * Matches `WorkerToHostMethods["secrets.resolve"][0]` from `protocol.ts`.
 */
export interface PluginSecretsResolveParams {
  /** The secret reference string (a secret UUID). */
  secretRef: string;
}

/**
 * Options for creating the plugin secrets handler.
 */
export interface PluginSecretsHandlerOptions {
  /** Database connection. */
  db: Db;
  /**
   * The plugin ID using this handler.
   * Used for logging context only; never included in error payloads
   * that reach the plugin worker.
   */
  pluginId: string;
  /**
   * The plugin's manifest `id` (e.g. `"paperclip.media-studio"`), used only
   * to check `SECRET_REF_ENABLED_PLUGIN_KEYS` — every plugin not on that list
   * keeps the unconditional fail-closed behavior regardless of what it passes
   * here. Optional so existing callers/tests that don't care about the
   * allowlist keep working unchanged (undefined never matches the allowlist).
   */
  pluginKey?: string;
}

/**
 * The `HostServices.secrets` adapter for the plugin host-client factory.
 */
export interface PluginSecretsService {
  /**
   * Resolve a secret reference to its current plaintext value.
   *
   * @param params - Contains the `secretRef` (UUID of the secret)
   * @param context - Worker→host call context; `context.invocationScope.companyId`
   *   is the only thing that can lift the fail-closed default, and only for an
   *   allow-listed plugin (see `SECRET_REF_ENABLED_PLUGIN_KEYS`).
   * @returns The resolved secret value
   * @throws {Error} If the secret is not found, has no versions, belongs to a
   *   different company than the invocation, or the provider fails to resolve
   */
  resolve(params: PluginSecretsResolveParams, context?: WorkerHostCallContext): Promise<string>;
}

/**
 * Create a `HostServices.secrets` adapter for a specific plugin.
 *
 * The returned service looks up secrets by UUID, fetches the latest version
 * material, and delegates to the appropriate `SecretProviderModule` for
 * decryption.
 *
 * @example
 * ```ts
 * const secretsHandler = createPluginSecretsHandler({ db, pluginId });
 * const handlers = createHostClientHandlers({
 *   pluginId,
 *   capabilities: manifest.capabilities,
 *   services: {
 *     secrets: secretsHandler,
 *     // ...
 *   },
 * });
 * ```
 *
 * @param options - Database connection and plugin identity
 * @returns A `PluginSecretsService` suitable for `HostServices.secrets`
 */
/** Simple sliding-window rate limiter for secret resolution attempts. */
function createRateLimiter(maxAttempts: number, windowMs: number) {
  const attempts = new Map<string, number[]>();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const windowStart = now - windowMs;
      const existing = (attempts.get(key) ?? []).filter((ts) => ts > windowStart);
      if (existing.length >= maxAttempts) return false;
      existing.push(now);
      attempts.set(key, existing);
      return true;
    },
  };
}

export function createPluginSecretsHandler(
  options: PluginSecretsHandlerOptions,
): PluginSecretsService {
  const { db, pluginId, pluginKey } = options;
  const secretsSvc = secretService(db);

  // Rate limit: max 30 resolution attempts per plugin per minute
  const rateLimiter = createRateLimiter(30, 60_000);

  return {
    async resolve(params: PluginSecretsResolveParams, context?: WorkerHostCallContext): Promise<string> {
      const { secretRef } = params;

      // ---------------------------------------------------------------
      // 0. Rate limiting — prevent brute-force UUID enumeration
      // ---------------------------------------------------------------
      if (!rateLimiter.check(pluginId)) {
        const err = new Error("Rate limit exceeded for secret resolution");
        err.name = "RateLimitExceededError";
        throw err;
      }

      // ---------------------------------------------------------------
      // 1. Validate the ref format
      // ---------------------------------------------------------------
      if (!secretRef || typeof secretRef !== "string" || secretRef.trim().length === 0) {
        throw invalidSecretRef(secretRef ?? "<empty>");
      }

      const trimmedRef = secretRef.trim();

      if (!isUuidSecretRef(trimmedRef)) {
        throw invalidSecretRef(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 2. Fail closed for every plugin except the ones explicitly scoped
      //    in (see SECRET_REF_ENABLED_PLUGIN_KEYS doc comment above).
      // ---------------------------------------------------------------
      if (!pluginKey || !SECRET_REF_ENABLED_PLUGIN_KEYS.has(pluginKey)) {
        throw new Error(PLUGIN_SECRET_REFS_DISABLED_MESSAGE);
      }

      // ---------------------------------------------------------------
      // 3. Require a server-verified invocation scope. This can only be
      //    populated by the host's executeTool dispatch (plugin-worker-
      //    manager.ts registerInvocation/deriveInvocationScope) after
      //    validateToolRunContextScope has confirmed the calling agent is
      //    who it claims to be (DUR-187) — a background job, webhook, or
      //    scheduler tick that never went through executeTool has no
      //    invocation scope and must not be able to resolve secrets.
      // ---------------------------------------------------------------
      if (context?.invalidInvocationScope) {
        throw new Error(PLUGIN_SECRET_REFS_DISABLED_MESSAGE);
      }
      const invocationCompanyId = context?.invocationScope?.companyId;
      if (!invocationCompanyId) {
        throw new Error(PLUGIN_SECRET_REFS_DISABLED_MESSAGE);
      }

      // ---------------------------------------------------------------
      // 4. Resolve through the audited secret path. resolveSecretValueForPlugin
      //    asserts the secret's own companyId matches invocationCompanyId —
      //    that's what makes this safe even though plugin_config itself is
      //    still one row per plugin instance-wide, not per company: a
      //    mismatched company gets a clean failure, never another company's
      //    secret value.
      // ---------------------------------------------------------------
      try {
        return await secretsSvc.resolveSecretValueForPlugin(invocationCompanyId, trimmedRef, "latest", {
          consumerType: "plugin",
          consumerId: pluginId,
          actorType: "plugin",
          pluginId,
        });
      } catch {
        // Never let secret-service internals (not-found vs wrong-company vs
        // inactive vs provider error) leak to the plugin worker — collapse
        // to the same invalid-ref shape a plugin author would see for any
        // other bad reference.
        throw invalidSecretRef(trimmedRef);
      }
    },
  };
}
