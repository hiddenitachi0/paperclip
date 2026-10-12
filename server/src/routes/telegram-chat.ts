import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  ackTelegramChatAnswerSchema,
  telegramChatAskSchema,
  telegramChatLinkSchema,
  updateTelegramChatSettingsSchema,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { heartbeatService, laneAService } from "../services/index.js";
import type { LaneAServiceOptions } from "../services/lane-a.js";
import { telegramChatService, type TelegramChatServiceDeps } from "../services/telegram-chat.js";
import {
  assertBoard,
  assertCompanyAccess,
  assertCompanyOwnerAdminOrInstanceAdmin,
  assertInstanceAdmin,
} from "./authz.js";

/**
 * Hermes parity, slice 1: two-way Telegram chat for linked people.
 *
 * Three families of route, with deliberately different gates:
 *
 *  (a) the person's own Telegram link (profile page): any signed-in person,
 *      always about THEIR OWN account -- the user id is the session's, never
 *      a parameter, so nobody can make or remove a link for someone else.
 *  (b) the company setting (which bot, which quick agent, which full agent,
 *      daily limit): readable by members, changed by an owner or admin.
 *  (c) the bridge routes (ask, link, outbox, ack): instance admin only, the
 *      same gate as the bridge's roster and token routes (see
 *      routes/telegram-bots.ts for why). The company is the path's, which the
 *      bridge takes from the bot's stored config; the service then checks the
 *      bot really belongs to it. The sender is identified by the Telegram user
 *      id in the body, which the bridge copies from Telegram's own update.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bridge's "ask" can carry one photo of up to 10 MB as base64, more than the default JSON limit. */
export const TELEGRAM_CHAT_ASK_API_PATH = "/api/companies/:companyId/telegram-chat/ask";
export const TELEGRAM_CHAT_ASK_JSON_BODY_LIMIT = "16mb";

function ownUserId(req: Request): string {
  assertBoard(req);
  const userId = req.actor.type === "board" ? req.actor.userId : null;
  if (!userId) throw forbidden("Sign in to link your Telegram account.");
  return userId;
}

export function telegramChatRoutes(
  rawDb: Db,
  deps: TelegramChatServiceDeps & { laneAOptions?: LaneAServiceOptions } = {},
) {
  const router = Router();
  const svc = telegramChatService(rawDb, {
    laneA: deps.laneA ?? laneAService(rawDb, deps.laneAOptions),
    heartbeat: deps.heartbeat ?? heartbeatService(rawDb),
    now: deps.now,
    storage: deps.storage,
  });

  // ─── (a) The person's own link ─────────────────────────────────────────────

  router.get("/me/telegram-link", async (req, res) => {
    res.json(await svc.linkStatus(ownUserId(req)));
  });

  router.post("/me/telegram-link/code", async (req, res) => {
    res.status(201).json(await svc.createLinkCode(ownUserId(req)));
  });

  router.delete("/me/telegram-link", async (req, res) => {
    res.json(await svc.unlink(ownUserId(req)));
  });

  // ─── (b) The company setting ───────────────────────────────────────────────

  router.get(
    "/companies/:companyId/telegram-chat/settings",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    }),
    async (req, res) => {
      res.json(await svc.getSettings(req.params.companyId as string));
    },
  );

  router.put(
    "/companies/:companyId/telegram-chat/settings",
    companyScopeFromParam(rawDb, (req, companyId) =>
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "who answers questions on Telegram"),
    ),
    validate(updateTelegramChatSettingsSchema),
    async (req, res) => {
      const userId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
      res.json(await svc.updateSettings(req.params.companyId as string, req.body, userId));
    },
  );

  // ─── (c) The bridge ────────────────────────────────────────────────────────

  const bridgeScope = () => companyScopeFromParam(rawDb, (req) => assertInstanceAdmin(req));

  router.post(
    "/companies/:companyId/telegram-chat/link",
    bridgeScope(),
    validate(telegramChatLinkSchema),
    async (req, res) => {
      res.json(await svc.claimLink(req.params.companyId as string, req.body));
    },
  );

  router.post(
    "/companies/:companyId/telegram-chat/ask",
    bridgeScope(),
    validate(telegramChatAskSchema),
    async (req, res) => {
      res.json(await svc.ask(req.params.companyId as string, req.body));
    },
  );

  router.get("/companies/:companyId/telegram-chat/outbox", bridgeScope(), async (req, res) => {
    res.json({ answers: await svc.outbox(req.params.companyId as string) });
  });

  router.post(
    "/companies/:companyId/telegram-chat/outbox/:requestId/ack",
    bridgeScope(),
    validate(ackTelegramChatAnswerSchema),
    async (req, res) => {
      const requestId = req.params.requestId as string;
      if (!UUID_RE.test(requestId)) throw notFound("That answer was not found.");
      res.json(await svc.ack(req.params.companyId as string, requestId, req.body.outcome));
    },
  );

  return router;
}
