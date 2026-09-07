// One-click Claude sign-in. Instance-wide like instance-settings.ts (no
// companyId anywhere: the token is shared by every claude_local agent on
// this server), so this file deliberately stays bypass-scoped. Reading the
// status is open to any org member (it carries no secret — only a
// fingerprint, dates and plain-language health); everything that changes the
// sign-in is instance-admin only. An agent can never reach any of these.
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  saveInstanceClaudeAuthTokenSchema,
  submitInstanceClaudeSignInCodeSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { instanceClaudeAuthService, type InstanceClaudeAuthService } from "../services/instance-claude-auth.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { logActivity } from "../services/activity-log.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";

function actorUserId(req: Request): string | null {
  return req.actor.type === "board" ? (req.actor.userId ?? null) : null;
}

export function instanceClaudeAuthRoutes(db: Db, deps: { service?: InstanceClaudeAuthService } = {}) {
  const router = Router();
  const svc = deps.service ?? instanceClaudeAuthService(db);
  const instanceSettings = instanceSettingsService(db);

  async function logInstanceActivity(req: Request, action: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    const companyIds = await instanceSettings.listCompanyIds().catch(() => [] as string[]);
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action,
          entityType: "instance_claude_auth",
          entityId: "default",
          details,
        }).catch(() => undefined),
      ),
    );
  }

  router.get("/instance/claude-auth", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await svc.getStatus());
  });

  // Paste path: a token made elsewhere with `claude setup-token`.
  router.post("/instance/claude-auth/token", validate(saveInstanceClaudeAuthTokenSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const status = await svc.saveToken({ token: req.body.token, source: "pasted", userId: actorUserId(req) });
    await logInstanceActivity(req, "instance.claude_auth.saved", { source: "pasted", fingerprint: status.fingerprint });
    res.json(status);
  });

  router.post("/instance/claude-auth/check", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await svc.checkNow());
  });

  router.delete("/instance/claude-auth", async (req, res) => {
    assertInstanceAdmin(req);
    const status = await svc.clear();
    await logInstanceActivity(req, "instance.claude_auth.removed", {});
    res.json(status);
  });

  // Automatic path: `claude setup-token` driven from the dashboard.
  router.post("/instance/claude-auth/sign-in", async (req, res) => {
    assertInstanceAdmin(req);
    const session = svc.startInteractiveSignIn({ userId: actorUserId(req) });
    res.status(201).json(session);
  });

  router.get("/instance/claude-auth/sign-in/:sessionId", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(svc.getSignIn(req.params.sessionId as string));
  });

  router.post(
    "/instance/claude-auth/sign-in/:sessionId/code",
    validate(submitInstanceClaudeSignInCodeSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const session = svc.submitSignInCode(req.params.sessionId as string, req.body.code);
      res.json(session);
    },
  );

  router.post("/instance/claude-auth/sign-in/:sessionId/cancel", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(svc.cancelSignIn(req.params.sessionId as string));
  });

  return router;
}
