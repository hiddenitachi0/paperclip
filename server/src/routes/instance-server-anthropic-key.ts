// DUR-3995: Paperclip's own Claude key. Instance-wide like
// instance-settings.ts and instance-claude-auth.ts -- one key for the whole
// server, no companyId anywhere in the path, body or query -- so this file
// deliberately stays bypass-scoped, and its writes fan an activity row out to
// every company.
//
// Everything here is instance-admin only, including the read: unlike the
// Claude sign-in status, this page exists to change the server's own
// credential, and there is no reason for an ordinary member to see when it
// was last replaced. No response ever carries the key; the most any of them
// carries is the last four characters.
//
// No agent can reach these routes: assertInstanceAdmin requires a board actor,
// and agent tokens are never that. One caveat worth stating plainly -- in
// `local_trusted` deployment mode an unauthenticated local request counts as
// an implicit instance admin, and agents run on the same host, so the write
// routes below refuse that implicit actor. Production runs in `authenticated`
// mode, where it cannot arise at all.
import { Router, type Request } from "express";
import { HttpError } from "../errors.js";
import type { Db } from "@paperclipai/db";
import { saveInstanceServerAnthropicKeySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  serverAnthropicKeyService,
  type ServerAnthropicKeyService,
} from "../services/server-anthropic-key.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { logActivity } from "../services/activity-log.js";
import { assertInstanceAdmin, getActorInfo } from "./authz.js";

/**
 * `local_trusted` mode treats an unauthenticated local request as an instance
 * admin. Agents run on this host, so for this one credential that implicit
 * actor may read the status but never change, test or remove the key.
 */
function assertNotImplicitLocalActor(req: Request): void {
  if (req.actor.type === "board" && req.actor.source === "local_implicit") {
    throw new HttpError(403, "Sign in as an instance admin to change Paperclip's own Claude key.");
  }
}

function actorUserId(req: Request): string | null {
  return req.actor.type === "board" ? (req.actor.userId ?? null) : null;
}

export function instanceServerAnthropicKeyRoutes(
  db: Db,
  deps: { service?: ServerAnthropicKeyService } = {},
) {
  const router = Router();
  const svc = deps.service ?? serverAnthropicKeyService(db);
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
          entityType: "instance_server_anthropic_key",
          entityId: "default",
          details,
        }).catch(() => undefined),
      ),
    );
  }

  router.get("/instance/server-anthropic-key", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await svc.getStatus());
  });

  // Admin check BEFORE validate(): a non-admin must not get a body-shape
  // verdict, and their body must not reach the error path at all.
  router.put(
    "/instance/server-anthropic-key",
    (req, _res, next) => {
      assertInstanceAdmin(req);
      assertNotImplicitLocalActor(req);
      next();
    },
    validate(saveInstanceServerAnthropicKeySchema),
    async (req, res) => {
      const result = await svc.save({ key: req.body.apiKey, userId: actorUserId(req) });
      // The fingerprint, never the key: enough to see in the feed that the
      // key was replaced (and with what, across replacements), nothing more.
      await logInstanceActivity(req, "instance.server_anthropic_key.saved", {
        fingerprint: result.status.fingerprint,
        testOk: result.ok,
      });
      res.json(result);
    },
  );

  router.post("/instance/server-anthropic-key/test", async (req, res) => {
    assertInstanceAdmin(req);
    assertNotImplicitLocalActor(req);
    res.json(await svc.test());
  });

  router.delete("/instance/server-anthropic-key", async (req, res) => {
    assertInstanceAdmin(req);
    assertNotImplicitLocalActor(req);
    const status = await svc.remove();
    await logInstanceActivity(req, "instance.server_anthropic_key.removed", {});
    res.json(status);
  });

  return router;
}
