import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { sendLaneAMessageSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { agentService, laneAService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Lane A routes (DUR-217): `POST /api/lane-a/:agentId/messages`, a direct
 * Anthropic Messages API call scoped to a single opted-in agent persona. No
 * agent runtime, no filesystem, no CLI subprocess — contrast `board-chat.ts`,
 * which spawns a full `claude` CLI subprocess and is therefore restricted to
 * the local-trusted single-operator deployment mode. Lane A is a safe
 * multi-tenant primitive by construction: it can only read the prompt +
 * optional caller-supplied context, call a small allow-list of built-in
 * actions (hand work to a colleague, weather, task lookup — see
 * services/lane-a-tools.ts) plus the agent's own Tools-library grants through
 * a capped synchronous tool-use loop (at most `LANE_A_MAX_TOOL_CALLS` tool
 * calls per message, no approval card), and write text back. Quick agents
 * (round 2) also remember earlier turns of the same conversation.
 */
const conversationQuerySchema = z.object({ companyId: z.string().uuid() });

export function laneARoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const laneA = laneAService(db);

  function requesterFor(req: Parameters<typeof getActorInfo>[0]) {
    const actor = getActorInfo(req);
    return actor.actorType === "agent"
      ? { userId: null, agentId: actor.agentId }
      : { userId: actor.actorId, agentId: null };
  }

  router.post("/lane-a/:agentId/messages", validate(sendLaneAMessageSchema), async (req, res) => {
    const targetAgentId = req.params.agentId as string;
    const { companyId, message, context, conversationId } = req.body as {
      companyId: string;
      message: string;
      context?: string;
      conversationId?: string;
    };

    assertCompanyAccess(req, companyId);

    const targetAgent = await agents.getById(targetAgentId);
    if (!targetAgent || targetAgent.companyId !== companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const result = await laneA.sendMessage({
      companyId,
      targetAgent: {
        id: targetAgent.id,
        companyId: targetAgent.companyId,
        name: targetAgent.name,
        role: targetAgent.role,
        laneAEnabled: targetAgent.laneAEnabled,
        laneAInstructions: targetAgent.laneAInstructions ?? null,
        mcpToolIds: (targetAgent.mcpToolIds as string[] | null) ?? [],
      },
      requester: requesterFor(req),
      message,
      context,
      conversationId,
    });

    res.json(result);
  });

  router.get("/lane-a/:agentId/conversations/:conversationId", async (req, res) => {
    const targetAgentId = req.params.agentId as string;
    const conversationId = req.params.conversationId as string;
    const parsedQuery = conversationQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }
    const { companyId } = parsedQuery.data;
    assertCompanyAccess(req, companyId);

    const targetAgent = await agents.getById(targetAgentId);
    if (!targetAgent || targetAgent.companyId !== companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const result = await laneA.getConversation({
      companyId,
      targetAgentId: targetAgent.id,
      conversationId,
      requester: requesterFor(req),
    });
    res.json(result);
  });

  return router;
}
