import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden, notFound, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import type { LaneAServiceOptions } from "../services/lane-a.js";
import { agentService, laneAService } from "../services/index.js";
import { privateAccessService, PRIVATE_ACCESS_REASON_MIN_LENGTH } from "../services/private-access.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * DUR-4094: Filip's emergency-access ("break-glass") rule for the Employee
 * (light) role's private workspaces.
 *
 * Default with privacy on: an owner or admin cannot read an Employee
 * (light)'s PA conversation through the ordinary chat-history route
 * (`GET /lane-a/:agentId/conversations/:conversationId`, which
 * `assertConversationOwnedBy` refuses for anyone but the person who started
 * it). This route is the one exception -- a logged, reasoned override, never
 * a silent one.
 *
 * Today this covers the one leak already fixed with an `emergencyAccess`
 * escape hatch: Lane A PA conversations (see services/lane-a.ts
 * `getConversation`). The matching escape hatch already wired into
 * agent-memories.ts (`AgentMemoryList`'s `options.emergencyAccess`) does not
 * have a route here yet -- a memory notebook can carry notes from several
 * different people, and Filip has not said whether one written reason should
 * cover reading all of them at once or whether each protected author needs
 * her own audit row. Follow-up, not answered here.
 *
 * There is no push/email notification pipeline in this codebase yet, so
 * "notify" means the access appears in the subject's own
 * `GET /private-access-events/mine` read (below), not a message sent to her.
 * That is a deliberate, safer-default assumption -- see "Questions for
 * Filip" in the DUR-4094 PR description.
 */
const recordAccessSchema = z
  .object({
    companyId: z.string().uuid(),
    reason: z.string().trim().min(PRIVATE_ACCESS_REASON_MIN_LENGTH),
    notify: z.boolean().optional(),
  })
  .strict();

export function privateAccessRoutes(db: Db, options: { laneA?: LaneAServiceOptions } = {}) {
  const router = Router();
  const access = accessService(db);
  const laneA = laneAService(db, options.laneA);
  const agents = agentService(db);
  const privateAccess = privateAccessService(db);

  /** Owner/admin only -- the same ceiling Filip's rule puts on who may ever break glass at all. */
  async function assertOwnerOrAdmin(req: Parameters<typeof getActorInfo>[0], companyId: string) {
    if (req.actor.type !== "board") throw forbidden("Only a board owner or admin can use emergency access.");
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = req.actor.userId;
    if (!userId) throw unauthorized();
    const membership = await access.getMembership(companyId, "user", userId);
    if (!membership || membership.status !== "active" || (membership.membershipRole !== "owner" && membership.membershipRole !== "admin")) {
      throw forbidden("Only a company owner or admin can use emergency access.");
    }
  }

  /**
   * Read another person's PA conversation, logging why first. Refuses a
   * conversation that was never a person's own (an agent-initiated one has
   * no one's privacy to break glass on).
   */
  router.post(
    "/private-access/lane-a/:agentId/conversations/:conversationId",
    validate(recordAccessSchema),
    async (req, res) => {
      assertBoard(req);
      const { companyId: targetCompanyId, reason, notify } = req.body as {
        companyId: string;
        reason: string;
        notify?: boolean;
      };
      assertCompanyAccess(req, targetCompanyId);
      await assertOwnerOrAdmin(req, targetCompanyId);

      const targetAgentId = req.params.agentId as string;
      const conversationId = req.params.conversationId as string;
      const targetAgent = await agents.getById(targetAgentId);
      if (!targetAgent || targetAgent.companyId !== targetCompanyId) {
        throw notFound("Agent not found");
      }

      const owner = await laneA.getConversationOwner({
        companyId: targetCompanyId,
        targetAgentId,
        conversationId,
      });
      if (!owner) throw notFound("Lane A conversation not found");
      if (!owner.requestedByUserId) {
        throw badRequest("This conversation was not started by a person; there is no one's privacy to override here.");
      }

      const actorInfo = getActorInfo(req);
      const event = await privateAccess.recordAccess({
        companyId: targetCompanyId,
        targetUserId: owner.requestedByUserId,
        accessedByUserId: actorInfo.actorId,
        targetKind: "lane_a_conversation",
        targetId: conversationId,
        reason,
        notify,
      });

      const conversation = await laneA.getConversation({
        companyId: targetCompanyId,
        targetAgentId,
        conversationId,
        requester: { userId: owner.requestedByUserId, agentId: null },
        emergencyAccess: true,
      });

      res.status(201).json({ event, conversation });
    },
  );

  /** The owners' full audit view: every emergency-access row for this company, regardless of `notify`. */
  router.get("/private-access-events", async (req, res) => {
    const parsedCompanyId = z.string().uuid().safeParse(req.query.companyId);
    if (!parsedCompanyId.success) throw badRequest("companyId is required");
    const companyId = parsedCompanyId.data;
    assertCompanyAccess(req, companyId);
    await assertOwnerOrAdmin(req, companyId);
    res.json({ events: await privateAccess.listForCompany(companyId) });
  });

  /**
   * DUR-4094: "who has read my private stuff" -- the subject's own read.
   * This is the one route an Employee (light) may reach with no admin-
   * granted feature at all: it is how the "notify the employee" half of
   * Filip's rule is actually kept, and it is inherently self-scoped
   * (`listForSubject` is always called with the caller's own userId, never
   * a body/query value), so opting it in ahead of `assertCompanyAccess`
   * cannot let a light employee see anyone else's row.
   */
  router.get("/private-access-events/mine", async (req, res) => {
    req.lightRouteOptIn = true;
    const parsedCompanyId = z.string().uuid().safeParse(req.query.companyId);
    if (!parsedCompanyId.success) throw badRequest("companyId is required");
    const companyId = parsedCompanyId.data;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw forbidden("Only a signed-in board user has a private-access log to read.");
    }
    res.json({ events: await privateAccess.listForSubject(companyId, req.actor.userId) });
  });

  return router;
}
