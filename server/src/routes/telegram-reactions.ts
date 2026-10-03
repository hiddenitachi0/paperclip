import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { recordTelegramReactionSchema, updateReactionEmojiConfigSchema } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoard, assertCompanyAccess, assertCompanyOwnerAdminOrInstanceAdmin } from "./authz.js";
import { logActivity } from "../services/index.js";
import { telegramReactionService } from "../services/telegram-reactions.js";
import { reactionLearningService } from "../services/reaction-learning.js";

/**
 * DUR-4344: Telegram reaction feedback.
 *
 * The bridge reaches the API the way it does for every other call: `docker
 * exec` running the CLI under the operator's board credential (see
 * telegram-bots.ts). So the gate is board actor + company access — an agent
 * key or service token is refused, and a person from another company gets 403
 * from assertCompanyAccess. Changing what an emoji means is a company-policy
 * decision and needs owner/admin.
 */
const followUpAnswerSchema = z.object({ answer: z.string().trim().min(1).max(1000) }).strict();

const listQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  includeRemoved: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export function telegramReactionRoutes(db: Db) {
  const router = Router();
  const svc = telegramReactionService(db);
  const learning = reactionLearningService(db);

  const boardScope = () =>
    companyScopeFromParam(db, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    });

  const actorId = (req: Parameters<typeof assertBoard>[0]) =>
    req.actor.type === "board" ? (req.actor.userId ?? "board") : "board";

  router.post(
    "/companies/:companyId/telegram-reactions",
    companyScopeFromParam(db, (req, companyId) =>
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "reaction feedback"),
    ),
    validate(recordTelegramReactionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const { event, created } = await svc.record(companyId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorId(req),
        agentId: event.agentId,
        action: req.body.action === "added" ? "telegram_reaction.added" : "telegram_reaction.removed",
        entityType: "telegram_reaction",
        entityId: event.id,
        // The emoji and where it landed — never anything the person typed.
        details: {
          emoji: event.emoji,
          conversationId: event.conversationId,
          messageId: event.messageId,
          hasPicture: Boolean(event.pictureFileId),
        },
      });
      // DUR-4345: learn from it (never fails the request), and say whether the bot
      // should ask its one follow-up question about this picture.
      await learning.maybeSummarize(companyId, event.agentId, req.body.action);
      const followUpQuestion = req.body.action === "added" ? await learning.claimFollowUp(companyId, event).catch(() => null) : null;
      res.status(created ? 201 : 200).json({ ...event, followUpQuestion });
    },
  );

  router.post(
    "/companies/:companyId/telegram-reactions/:reactionId/follow-up-answer",
    companyScopeFromParam(db, (req, companyId) =>
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "reaction feedback"),
    ),
    validate(followUpAnswerSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const event = await learning.recordFollowUpAnswer(companyId, req.params.reactionId as string, req.body.answer);
      if (!event) throw notFound("No active reaction to attach that answer to");
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorId(req),
        agentId: event.agentId,
        action: "telegram_reaction.follow_up_answered",
        entityType: "telegram_reaction",
        entityId: event.id,
        details: { emoji: event.emoji },
      });
      res.json(event);
    },
  );

  router.get("/companies/:companyId/telegram-reactions", boardScope(), async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    res.json(
      await svc.list(req.params.companyId as string, {
        agentId: query.agentId,
        activeOnly: query.includeRemoved !== "true",
        limit: query.limit,
      }),
    );
  });

  router.get("/companies/:companyId/reaction-emoji-config", boardScope(), async (req, res) => {
    res.json(await svc.getConfig(req.params.companyId as string));
  });

  router.put(
    "/companies/:companyId/reaction-emoji-config",
    companyScopeFromParam(db, (req, companyId) =>
      assertCompanyOwnerAdminOrInstanceAdmin(req, companyId, "what reaction emoji mean"),
    ),
    validate(updateReactionEmojiConfigSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const config = await svc.updateConfig(companyId, req.body, actorId(req));
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorId(req),
        action: "reaction_emoji_config.updated",
        entityType: "company",
        entityId: companyId,
        details: { positive: config.positive, negative: config.negative, neutral: config.neutral },
      });
      res.json(config);
    },
  );

  return router;
}
