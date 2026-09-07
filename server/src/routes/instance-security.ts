import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { signOutEverywhereSchema, type RevokeSessionResult, type SignOutEverywhereResult } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  ADMIN_AUTH_ACTIONS,
  buildInstanceSecurityOverview,
  buildSignedOutEverywhereNotice,
  notifyOperators,
  reconcileAdminAuthSnapshot,
  resolveAdminAuthSigningSecret,
  revokeAllSessions,
  revokeSessionById,
  revokeSessionsForUser,
} from "../services/admin-auth-audit.js";

function assertInstanceAdminBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

function actorLabel(req: Request): string {
  const name = req.actor.userName?.trim();
  const email = req.actor.userEmail?.trim();
  if (name && email) return `${name} (${email})`;
  return name || email || "An instance admin";
}

/**
 * Security section of Instance settings (admin auth hardening). Instance-wide
 * by nature -- sessions and admin roles have no company -- so, like
 * instance-settings.ts, it stays bypass-scoped and fans its notices out to
 * every company's Activity feed. Every route is instance-admin only.
 */
export function instanceSecurityRoutes(db: Db, opts: { checkIntervalMinutes: number }) {
  const router = Router();
  const secret = resolveAdminAuthSigningSecret();

  router.get("/instance/security", async (req, res) => {
    assertInstanceAdminBoard(req);
    res.json(
      await buildInstanceSecurityOverview(db, {
        currentSessionId: req.actor.sessionId ?? null,
        checkIntervalMinutes: opts.checkIntervalMinutes,
        secret,
      }),
    );
  });

  // Runs the admin-set check right now (same check the server runs on its
  // own schedule) and returns what it found, so the operator can confirm
  // "nothing has changed" on demand.
  router.post("/instance/security/check", async (req, res) => {
    assertInstanceAdminBoard(req);
    res.json(await reconcileAdminAuthSnapshot(db, { secret, trigger: "manual" }));
  });

  router.post("/instance/security/sign-out-everywhere", validate(signOutEverywhereSchema), async (req, res) => {
    assertInstanceAdminBoard(req);
    const scope = req.body.scope === "everyone" ? "everyone" : "me";
    const currentSessionId = req.actor.sessionId ?? null;
    let revoked = 0;
    if (scope === "everyone") {
      revoked = await revokeAllSessions(db);
    } else if (req.actor.userId) {
      revoked = await revokeSessionsForUser(db, req.actor.userId);
    }
    const by = actorLabel(req);
    await notifyOperators(db, {
      action: ADMIN_AUTH_ACTIONS.signedOutEverywhere,
      entityType: "user",
      entityId: req.actor.userId ?? "local-board",
      message: buildSignedOutEverywhereNotice({ by, scope, revoked }),
      details: { scope, revokedSessions: revoked, source: "app" },
      actor: { actorType: "user", actorId: req.actor.userId ?? "local-board", actorName: req.actor.userName ?? null },
    }).catch(() => {});
    const result: SignOutEverywhereResult = {
      scope,
      revokedSessions: revoked,
      // A session-backed caller always loses their own session in both scopes;
      // an API-key or local caller has no browser session to lose.
      signedOutSelf: currentSessionId !== null && revoked > 0,
    };
    res.json(result);
  });

  router.delete("/instance/security/sessions/:sessionId", async (req, res) => {
    assertInstanceAdminBoard(req);
    const sessionId = req.params.sessionId as string;
    const removed = await revokeSessionById(db, sessionId);
    if (!removed) throw notFound("That session is already gone");
    await notifyOperators(db, {
      action: ADMIN_AUTH_ACTIONS.sessionRevoked,
      entityType: "user",
      entityId: removed.userId,
      message: `${actorLabel(req)} ended one open session${removed.userId === req.actor.userId ? " of their own" : " for another user"}. That device has to sign in again.`,
      details: { sessionId: removed.id, userId: removed.userId, source: "app" },
      actor: { actorType: "user", actorId: req.actor.userId ?? "local-board", actorName: req.actor.userName ?? null },
    }).catch(() => {});
    const result: RevokeSessionResult = {
      revoked: true,
      signedOutSelf: req.actor.sessionId === removed.id,
    };
    res.json(result);
  });

  return router;
}
