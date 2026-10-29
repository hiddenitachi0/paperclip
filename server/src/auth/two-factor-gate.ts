import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import type { BetterAuthSessionResult } from "./better-auth.js";
import { totpService } from "../services/totp-2fa.js";
import { logger } from "../middleware/logger.js";

// DUR-4304: the one place that decides whether a signed-in browser session may
// act as the board. When two-factor login is on and the user has a second
// factor enrolled, a session that has not passed it is NOT a board session:
// the resolver hands back "no session", so actorMiddleware leaves the request
// as `{ type: "none" }` and every board route, the live-events socket and
// anything else built on these resolvers refuses it. The only thing such a
// session may do is reach the 2FA routes, which learn about it through
// `getPendingTwoFactor`.

/** How long after password sign-in a session may still submit its second factor. */
export const TWO_FACTOR_PENDING_TTL_MS = 10 * 60 * 1000;
/** How long one passed second factor is honoured for a session before it is asked again. */
export const TWO_FACTOR_VERIFIED_TTL_MS = 12 * 60 * 60 * 1000;

export interface PendingTwoFactor {
  userId: string;
  sessionId: string;
  userEmail: string | null;
}

const pendingByRequest = new WeakMap<object, PendingTwoFactor>();

/** The session behind this request, if it is signed in but has not passed its second factor. */
export function getPendingTwoFactor(req: Request): PendingTwoFactor | null {
  return pendingByRequest.get(req) ?? null;
}

type RequestResolver = (req: Request) => Promise<BetterAuthSessionResult | null>;
type HeadersResolver = (headers: Headers) => Promise<BetterAuthSessionResult | null>;

export function twoFactorGate(db: Db, opts: { enabled: boolean }) {
  const totp = totpService(db);

  /** "ok" = may act as board, "pending" = must pass the second factor first. */
  async function classify(session: BetterAuthSessionResult): Promise<"ok" | "pending"> {
    const userId = session.user?.id;
    const sessionId = session.session?.id;
    if (!userId || !sessionId) return "pending";
    if (!(await totp.isTotpEnabled(userId))) return "ok";
    return (await totp.verifySessionTotpStatus(userId, sessionId)) ? "ok" : "pending";
  }

  return {
    enabled: opts.enabled,
    wrapRequestResolver(base: RequestResolver): RequestResolver {
      if (!opts.enabled) return base;
      return async (req) => {
        const session = await base(req);
        if (!session) return null;
        try {
          if ((await classify(session)) === "ok") return session;
          pendingByRequest.set(req, {
            userId: session.user!.id,
            sessionId: session.session!.id,
            userEmail: session.user?.email ?? null,
          });
          return null;
        } catch (err) {
          // Fail closed: if we cannot tell, the session does not act as board.
          logger.warn({ err }, "two-factor gate could not classify session; denying");
          return null;
        }
      };
    },
    wrapHeadersResolver(base: HeadersResolver): HeadersResolver {
      if (!opts.enabled) return base;
      return async (headers) => {
        const session = await base(headers);
        if (!session) return null;
        try {
          return (await classify(session)) === "ok" ? session : null;
        } catch (err) {
          logger.warn({ err }, "two-factor gate could not classify session; denying");
          return null;
        }
      };
    },
  };
}
