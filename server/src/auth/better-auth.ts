import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { betterAuth, type Auth } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler } from "better-auth/node";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "@paperclipai/db";
import type { Config } from "../config.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthGetSessionApi = {
  getSession?: (input: { headers: Headers }) => Promise<unknown>;
};

type BetterAuthHandlerTarget = Extract<Parameters<typeof toNodeHandler>[0], { handler: Auth["handler"] }>;

type BetterAuthSessionResolver = {
  api?: BetterAuthGetSessionApi;
};

type BetterAuthInstance = BetterAuthHandlerTarget & BetterAuthSessionResolver;

const AUTH_COOKIE_PREFIX_FALLBACK = "default";
const AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE = /[^a-zA-Z0-9_-]+/g;

export function deriveAuthCookiePrefix(instanceId = resolvePaperclipInstanceId()): string {
  const scopedInstanceId = instanceId
    .trim()
    .replace(AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE, "-")
    .replace(/^-+|-+$/g, "") || AUTH_COOKIE_PREFIX_FALLBACK;
  return `paperclip-${scopedInstanceId}`;
}

export function buildBetterAuthAdvancedOptions(input: { disableSecureCookies: boolean }) {
  return {
    cookiePrefix: deriveAuthCookiePrefix(),
    ...(input.disableSecureCookies ? { useSecureCookies: false } : {}),
  };
}

export function shouldDisableSecureAuthCookies(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  authBaseUrlMode: Config["authBaseUrlMode"];
  authPublicBaseUrl: string | undefined;
  publicUrl?: string | undefined;
}): boolean {
  const publicUrl = (
    input.publicUrl?.trim() ||
    (input.authBaseUrlMode === "explicit" ? input.authPublicBaseUrl?.trim() : "")
  );
  if (publicUrl) return publicUrl.startsWith("http://");

  return (
    input.deploymentMode === "authenticated" &&
    (
      (input.deploymentExposure === "private" && input.authBaseUrlMode === "auto") ||
      input.deploymentExposure === undefined
    )
  );
}

// better-auth holds an internal in-process lock/queue around each auth
// request (e.g. sign-in) that is only released once the awaited DB adapter
// call settles. If that DB call hangs (dead connection, stuck pool, etc.)
// the await never settles, the lock is never released, and every later
// sign-in blocks on it forever -- the only recovery today is restarting the
// process. We cannot patch better-auth's own lock-release code from here, so
// instead we bound every DB adapter call it awaits: past the timeout we
// force that awaited promise to reject, which unblocks better-auth's own
// control flow (and its lock/finally handling) even though the underlying
// query may still be running in the background.
export const AUTH_DB_ADAPTER_TIMEOUT_MS = 5000;

export function withAdapterCallTimeout<TAdapter extends object>(adapter: TAdapter, timeoutMs: number): TAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
        if (!(result instanceof Promise)) return result;
        return Promise.race([result, adapterCallTimeout(String(prop), timeoutMs, result)]);
      };
    },
  });
}

function adapterCallTimeout(methodName: string, timeoutMs: number, settle: Promise<unknown>): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`better-auth DB adapter call "${methodName}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    settle.finally(() => clearTimeout(timer)).catch(() => {});
  });
}

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function headersFromExpressRequest(req: Request): Headers {
  return headersFromNodeHeaders(req.headers);
}

export function deriveAuthTrustedOrigins(config: Config, opts?: { listenPort?: number }): string[] {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const trustedOrigins = new Set<string>();

  if (baseUrl) {
    try {
      trustedOrigins.add(new URL(baseUrl).origin);
    } catch {
      // Better Auth will surface invalid base URL separately.
    }
  }
  if (config.deploymentMode === "authenticated") {
    const port = opts?.listenPort ?? config.port;
    const needsPortVariants = port !== 80 && port !== 443;
    for (const hostname of config.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      trustedOrigins.add(`https://${trimmed}`);
      trustedOrigins.add(`http://${trimmed}`);
      if (needsPortVariants) {
        trustedOrigins.add(`https://${trimmed}:${port}`);
        trustedOrigins.add(`http://${trimmed}:${port}`);
      }
    }
  }

  return Array.from(trustedOrigins);
}

/**
 * Security audit hooks (admin auth hardening). Each is best-effort: it is
 * awaited by better-auth after the row is written, but any error it throws is
 * swallowed here so a logging problem can never break sign-in or a password
 * change. The login flow itself is untouched.
 */
export interface BetterAuthAuditHooks {
  onSessionCreated?: (session: { id: string; userId: string; ipAddress?: string | null; userAgent?: string | null }) => Promise<void>;
  onUserUpdated?: (user: { id: string; email?: string | null; name?: string | null }) => Promise<void>;
  /** Fired after better-auth's change-password / set-password / reset-password endpoints succeed. */
  onPasswordChanged?: (input: { userId: string | null; path: string }) => Promise<void>;
}

const PASSWORD_CHANGE_PATHS = new Set(["/change-password", "/set-password", "/reset-password"]);

/**
 * better-auth runs `hooks.after` even when the endpoint threw: the APIError is
 * caught and stored as `ctx.context.returned` before the after hooks run. A
 * rejected change-password (wrong current password -- exactly what someone
 * probing an admin account produces) must therefore never look like a
 * successful change. Only a non-error result counts as "the password changed".
 */
export function endpointSucceeded(returned: unknown): boolean {
  if (returned === undefined || returned === null) return true;
  if (isAPIError(returned) || returned instanceof Error) return false;
  if (typeof Response !== "undefined" && returned instanceof Response) return returned.ok;
  return true;
}

function swallow(label: string, fn: () => Promise<void>): Promise<void> {
  return fn().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(`[better-auth audit hook] ${label} failed:`, err);
  });
}

export function buildBetterAuthDatabaseHooks(hooks: BetterAuthAuditHooks | undefined) {
  if (!hooks) return {};
  return {
    databaseHooks: {
      session: {
        create: {
          after: async (session: { id: string; userId: string; ipAddress?: string | null; userAgent?: string | null }) => {
            if (!hooks.onSessionCreated) return;
            await swallow("onSessionCreated", () =>
              hooks.onSessionCreated!({
                id: session.id,
                userId: session.userId,
                ipAddress: session.ipAddress ?? null,
                userAgent: session.userAgent ?? null,
              }),
            );
          },
        },
      },
      user: {
        update: {
          after: async (user: { id: string; email?: string | null; name?: string | null }) => {
            if (!hooks.onUserUpdated || !user?.id) return;
            await swallow("onUserUpdated", () =>
              hooks.onUserUpdated!({ id: user.id, email: user.email ?? null, name: user.name ?? null }),
            );
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (!hooks.onPasswordChanged || !PASSWORD_CHANGE_PATHS.has(ctx.path)) return;
        if (!endpointSucceeded((ctx.context as { returned?: unknown }).returned)) return;
        const session = (ctx.context as { session?: { user?: { id?: string } } | null }).session;
        const userId = typeof session?.user?.id === "string" ? session.user.id : null;
        await swallow("onPasswordChanged", () => hooks.onPasswordChanged!({ userId, path: ctx.path }));
      }),
    },
  };
}

export function createBetterAuthInstance(
  db: Db,
  config: Config,
  trustedOrigins: string[],
  auditHooks?: BetterAuthAuditHooks,
): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() || baseUrl;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set. " +
      "For local development, set BETTER_AUTH_SECRET=paperclip-dev-secret in your .env file.",
    );
  }
  const disableSecureCookies = shouldDisableSecureAuthCookies({
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    authBaseUrlMode: config.authBaseUrlMode,
    authPublicBaseUrl: config.authPublicBaseUrl,
    publicUrl,
  });

  const authConfig = {
    baseURL: baseUrl,
    secret,
    trustedOrigins,
    database: (() => {
      const buildAdapter = drizzleAdapter(db, {
        provider: "pg",
        schema: {
          user: authUsers,
          session: authSessions,
          account: authAccounts,
          verification: authVerifications,
        },
      });
      return (options: Parameters<typeof buildAdapter>[0]) =>
        withAdapterCallTimeout(buildAdapter(options), AUTH_DB_ADAPTER_TIMEOUT_MS);
    })(),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      disableSignUp: config.authDisableSignUp,
    },
    advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies }),
    ...buildBetterAuthDatabaseHooks(auditHooks),
  };

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  return betterAuth(authConfig);
}

export function createBetterAuthHandler(auth: BetterAuthHandlerTarget): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthSessionResolver,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const api = auth.api;
  if (!api?.getSession) return null;

  const sessionValue = await api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session = value.session?.id && value.session.userId
    ? { id: value.session.id, userId: value.session.userId }
    : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthSessionResolver,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}
