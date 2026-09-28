import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, createRequestScopedDb, telegramBots, withCompanyScope } from "@paperclipai/db";
import {
  createTelegramBotSchema,
  rotateTelegramBotTokenSchema,
  updateTelegramBotAllowedUsersSchema,
  updateTelegramBotCompanyNoticesSchema,
  updateTelegramBotVoiceSchema,
} from "@paperclipai/shared";
import type { TelegramBridgeBot } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { acceptLegacyBodyField } from "../middleware/legacy-body-field.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import {
  assertBoard,
  assertCompanyAccess,
  assertCompanyOwnerAdminOrInstanceAdmin,
  assertInstanceAdmin,
} from "./authz.js";
import { logActivity } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { normalizeVoiceReplyMode, telegramBotService } from "../services/telegram-bots.js";

/**
 * DUR-3978 slice 2: connecting a Telegram bot from company settings.
 *
 * Two families of route, with deliberately different gates:
 *
 *  (a) the company routes — list, connect, test, rotate, allow/deny a person,
 *      choose the bot for company notices, remove. Board actor + company
 *      access (owner/admin for the notices choice), like the secrets routes
 *      next door. An agent is refused by assertBoard; another company's bot
 *      is invisible because every query is company-scoped AND filtered on
 *      companyId. None of these ever returns the token.
 *
 *  (b) the bridge routes — the roster, and one token at a time. Instance-admin
 *      only.
 *
 * Why instance-admin for (b), rather than a loopback-only route with a shared
 * bridge secret in the environment:
 *
 *   - The bridge does not talk to this API over the network at all. It runs on
 *     the host as root and reaches Paperclip the way it already reaches it for
 *     approvals and tasks: `docker exec` into the container, running the CLI
 *     with the operator's stored board credential. So there is no new port to
 *     bind, no new credential to mint, rotate or leak, and no new environment
 *     variable somebody has to set on the container (which the operator cannot
 *     do himself anyway).
 *   - A shared bridge token in env would be a second credential protecting a
 *     first one, stored in plain text on the same host, readable by the same
 *     root that can already `docker exec`. It would add a rotation problem and
 *     buy nothing.
 *   - assertInstanceAdmin refuses every other actor outright: an agent key, a
 *     company service token, a board delegate token, and a board user who is
 *     not an instance admin. That is the smallest set that still lets the
 *     thing work.
 *
 * Fail-closed here, fail-open there, on purpose: this route refuses anything
 * it is not sure about, and the bridge treats a refusal as "the API did not
 * answer" and keeps running on its existing file. A wrong answer here can
 * never take the operator's bots offline.
 */
export function telegramBotRoutes(rawDb: Db, deps: { fetchImpl?: typeof fetch } = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = telegramBotService(db, deps);
  const instanceSettings = instanceSettingsService(rawDb);

  function boardScope() {
    return companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    });
  }

  function actorUserId(req: Request): string {
    return req.actor.type === "board" ? (req.actor.userId ?? "board") : "board";
  }

  // ─── (a) Company settings ──────────────────────────────────────────────────

  router.get("/companies/:companyId/telegram-bots", boardScope(), async (req, res) => {
    res.json(await svc.list(req.params.companyId as string));
  });

  router.post(
    "/companies/:companyId/telegram-bots",
    // DUR-3996: first in the chain, before the board gate can refuse. The
    // field is `botToken` so the HTTP log blanks it on a failed request;
    // `token` is still accepted for one release. See legacy-body-field.ts.
    acceptLegacyBodyField("token", "botToken"),
    boardScope(),
    validate(createTelegramBotSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const created = await svc.create(
        companyId,
        {
          agentId: req.body.agentId,
          name: req.body.name,
          token: req.body.botToken,
          uiBase: req.body.uiBase ?? null,
        },
        { userId: actorUserId(req) },
      );
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId(req),
        action: "telegram_bot.connected",
        entityType: "telegram_bot",
        entityId: created.id,
        // Never the token, and never the hint either — the activity log is
        // read by more eyes than the settings screen.
        details: { name: created.name, agentId: created.agentId },
      });
      res.status(201).json(created);
    },
  );

  router.post(
    "/companies/:companyId/telegram-bots/:botId/token",
    acceptLegacyBodyField("token", "botToken"),
    boardScope(),
    validate(rotateTelegramBotTokenSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const updated = await svc.rotateToken(
        companyId,
        req.params.botId as string,
        req.body.botToken,
        { userId: actorUserId(req) },
      );
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId(req),
        action: "telegram_bot.token_rotated",
        entityType: "telegram_bot",
        entityId: updated.id,
        details: { name: updated.name },
      });
      res.json(updated);
    },
  );

  router.post("/companies/:companyId/telegram-bots/:botId/test", boardScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const result = await svc.check(companyId, req.params.botId as string, {
      actorType: "user",
      actorId: actorUserId(req),
    });
    res.json(result);
  });

  router.put(
    "/companies/:companyId/telegram-bots/:botId/allowed-users",
    boardScope(),
    validate(updateTelegramBotAllowedUsersSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const updated = await svc.setAllowedUsers(
        companyId,
        req.params.botId as string,
        req.body.telegramUserIds,
      );
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId(req),
        action: "telegram_bot.allowed_users_changed",
        entityType: "telegram_bot",
        entityId: updated.id,
        details: { name: updated.name, allowedCount: updated.allowedTelegramUserIds.length },
      });
      res.json(updated);
    },
  );

  /**
   * Choose the bot that gets this company's approvals and questions when no
   * agent's own bot, or its boss's, should — a card the board filed itself,
   * for example. Turning one on turns every other bot in the company off.
   *
   * Owner or admin only: the bot chosen here receives Approve buttons that
   * act with board rights, so this is stricter than the other bot settings.
   */
  router.put(
    "/companies/:companyId/telegram-bots/:botId/company-notices",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "which bot gets the company's approvals and questions");
    }),
    validate(updateTelegramBotCompanyNoticesSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const updated = await svc.setReceivesCompanyNotices(
        companyId,
        req.params.botId as string,
        req.body.receivesCompanyNotices,
      );
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId(req),
        action: "telegram_bot.company_notices_changed",
        entityType: "telegram_bot",
        entityId: updated.id,
        details: { name: updated.name, receivesCompanyNotices: updated.receivesCompanyNotices },
      });
      res.json(updated);
    },
  );

  /**
   * Voice messages: "Reply with voice" (never / when I sent a voice message /
   * always) and the voice the answers are read with.
   */
  router.put(
    "/companies/:companyId/telegram-bots/:botId/voice",
    boardScope(),
    validate(updateTelegramBotVoiceSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const updated = await svc.setVoice(companyId, req.params.botId as string, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId(req),
        action: "telegram_bot.voice_changed",
        entityType: "telegram_bot",
        entityId: updated.id,
        details: { name: updated.name, voiceReplyMode: updated.voiceReplyMode, voice: updated.voice },
      });
      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/telegram-bots/:botId", boardScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const botId = req.params.botId as string;
    const existing = await svc.get(companyId, botId);
    await svc.remove(companyId, botId);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId(req),
      action: "telegram_bot.removed",
      entityType: "telegram_bot",
      entityId: botId,
      details: { name: existing.name },
    });
    res.json({ ok: true });
  });

  // ─── (b) What the host-side bridge reads ───────────────────────────────────

  /**
   * The roster: every enabled bot on this instance, across companies, with NO
   * token. Deliberately separate from the token route below, so the call the
   * bridge makes most often carries no credential at all.
   *
   * Read per company inside that company's scope rather than in one unscoped
   * query, so the company-scope rules that protect every other table protect
   * this one too.
   */
  router.get("/instance/telegram-bridge-config", async (req, res) => {
    assertInstanceAdmin(req);
    const companyIds = await instanceSettings.listCompanyIds();
    const bots: Array<Omit<TelegramBridgeBot, "token">> = [];
    for (const companyId of companyIds) {
      // Read through the handle withCompanyScope hands out, not through the
      // request-scoped proxy: this route has no companyId of its own, so there
      // is no request scope for the proxy to resolve against.
      const { rows, roles } = await withCompanyScope(rawDb, companyId, async (tx) => {
        const botRows = await tx.select().from(telegramBots).where(eq(telegramBots.companyId, companyId));
        const agentRows = await tx
          .select({ id: agents.id, role: agents.role })
          .from(agents)
          .where(eq(agents.companyId, companyId));
        return { rows: botRows, roles: new Map(agentRows.map((agent) => [agent.id, agent.role])) };
      });
      for (const row of rows) {
        if (!row.enabled) continue;
        bots.push({
          id: row.id,
          agentId: row.agentId,
          name: row.name,
          companyId: row.companyId,
          uiBase: row.uiBase,
          allowedUserIds: row.allowedTelegramUserIds ?? [],
          // What the bridge needs to pick the bot that gets the company's
          // approvals and questions when no agent's own bot should.
          receivesCompanyNotices: row.receivesCompanyNotices,
          createdAt: row.createdAt.toISOString(),
          agentRole: roles.get(row.agentId) ?? null,
          // Voice messages: when the bridge reads an answer aloud, and how.
          voiceReplyMode: normalizeVoiceReplyMode(row.voiceReplyMode),
          voice: row.voice ?? null,
        });
      }
    }
    res.json({ bots });
  });

  /**
   * One bot's token. Instance-admin only, company-scoped, one bot at a time,
   * and recorded in secret_access_events like every other credential read —
   * modelled on GET /companies/:companyId/deploy-github-token, which is the
   * same shape of problem (an on-box process that needs one specific secret).
   */
  router.get(
    "/companies/:companyId/telegram-bots/:botId/bridge-token",
    companyScopeFromParam(rawDb, (req) => assertInstanceAdmin(req)),
    async (req, res) => {
      const token = await svc.resolveBotToken(
        req.params.companyId as string,
        req.params.botId as string,
        { actorType: "user", actorId: actorUserId(req) },
      );
      res.json({ token });
    },
  );

  return router;
}
