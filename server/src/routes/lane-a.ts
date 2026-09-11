import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { laneATransformSchema, sendLaneAMessageSchema } from "@paperclipai/shared";
import { badRequest, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { agentService, laneAService } from "../services/index.js";
import { assertCompanyAccess, assertServiceOrBoard, getActorInfo } from "./authz.js";

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

/**
 * Which company a transform call acts for. For a service token this is the
 * company the token was issued to, read off the stored row — it is the one
 * fact the caller cannot influence. A board user has no token, so they say
 * which of their own companies they mean with ?companyId=, and
 * assertCompanyAccess then checks they actually have access to it.
 */
function resolveTransformCompanyId(req: Parameters<typeof getActorInfo>[0]): string {
  if (req.actor.type === "service") {
    if (!req.actor.companyId) throw unauthorized("Service token is not bound to a company");
    return req.actor.companyId;
  }
  const parsed = conversationQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw badRequest("companyId is required when calling this as a board user");
  }
  return parsed.data.companyId;
}

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
      actor: req.actor,
      message,
      context,
      conversationId,
    });

    res.json(result);
  });

  /**
   * DUR-3977: the stateless transform call. One product field in, one text
   * out, for a batch caller (Nordstrand's dashboard) rather than a person in
   * a chat panel.
   *
   * Company scoping, in the order it happens:
   *   1. assertServiceOrBoard — a per-company service token, or the operator
   *      themselves. An agent key is refused here: an agent must not be able
   *      to drive this lane.
   *   2. The company is READ OFF the credential (`req.actor.companyId` for a
   *      service token), never taken from the body. There is no companyId
   *      field on this request to spoof.
   *   3. The named agent is loaded and its own `companyId` is compared with
   *      that company. A token for company A naming an agent of company B
   *      gets the same 404 it would get for an agent that does not exist —
   *      the caller learns nothing about the other company's agents.
   */
  router.post("/lane-a/:agentId/transform", validate(laneATransformSchema), async (req, res) => {
    assertServiceOrBoard(req);
    const targetAgentId = req.params.agentId as string;
    const { input, variables, maxOutputChars } = req.body as {
      input: string;
      variables?: Record<string, string | number | boolean | null>;
      maxOutputChars?: number;
    };

    const companyId = resolveTransformCompanyId(req);
    assertCompanyAccess(req, companyId);

    const targetAgent = await agents.getById(targetAgentId);
    if (!targetAgent || targetAgent.companyId !== companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const result = await laneA.transform({
      companyId,
      targetAgent: {
        id: targetAgent.id,
        companyId: targetAgent.companyId,
        name: targetAgent.name,
        role: targetAgent.role,
        laneAEnabled: targetAgent.laneAEnabled,
        laneAInstructions: targetAgent.laneAInstructions ?? null,
        laneAModel: targetAgent.laneAModel ?? null,
        laneAMaxOutputTokens: targetAgent.laneAMaxOutputTokens ?? null,
        laneATransformDailyCallCap: targetAgent.laneATransformDailyCallCap ?? null,
      },
      input,
      variables,
      maxOutputChars,
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
