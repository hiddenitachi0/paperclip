import { Router, type Request } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, createRequestScopedDb } from "@paperclipai/db";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { accessService, logActivity } from "../services/index.js";
import { agentRequestRightsService } from "../services/agent-request-rights.js";
import { assertBoard, assertCompanyAccess, getActorInfo, isCompanyOwnerOrAdmin } from "./authz.js";

/**
 * Per-agent "ask" rights (Agent settings > Permissions):
 *   GET /agents/:id/request-rights   any person in the agent's company
 *   PUT /agents/:id/request-rights   the company's owner or an admin only
 *
 * The two rights let an agent ASK: file a deploy approval card
 * (deploys:request) or a merge approval card (merges:request). A person still
 * approves every deploy and merge. Agents are refused on both routes, even
 * for themselves, so an agent can never hand itself (or another agent) the
 * right to ask.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const updateAgentRequestRightsSchema = z
  .object({
    deploysRequest: z.boolean().optional(),
    mergesRequest: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.deploysRequest !== undefined || body.mergesRequest !== undefined, {
    message: "Send deploysRequest, mergesRequest, or both.",
  });

function refuseAgents(req: Request) {
  if (req.actor.type === "agent") {
    throw forbidden("Agents cannot view or change what agents are allowed to ask for. A company owner or admin does this.");
  }
  assertBoard(req);
}

export function agentRequestRightsRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = agentRequestRightsService(db, rawDb);
  const access = accessService(db);

  /** Resolve the agent's company from the database, never from the request. */
  function scopeFromAgent(mode: "read" | "change") {
    return companyScope(rawDb, async (req) => {
      refuseAgents(req);
      const agentId = req.params.id as string;
      if (!UUID_RE.test(agentId)) throw notFound("Agent not found");
      const [agent] = await rawDb
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId));
      if (!agent) throw notFound("Agent not found");
      assertCompanyAccess(req, agent.companyId);
      if (mode === "change" && !isCompanyOwnerOrAdmin(req, agent.companyId)) {
        throw forbidden("Only the company's owner or an admin can change what an agent may ask for.");
      }
      return agent.companyId;
    });
  }

  router.get("/agents/:id/request-rights", scopeFromAgent("read"), async (req, res) => {
    const state = await svc.get(req.params.id as string);
    res.json({ ...state, canChange: isCompanyOwnerOrAdmin(req, state.companyId) });
  });

  router.put(
    "/agents/:id/request-rights",
    scopeFromAgent("change"),
    validate(updateAgentRequestRightsSchema),
    async (req, res) => {
      const agentId = req.params.id as string;
      const userId = req.actor.userId ?? null;
      const before = await svc.get(agentId);
      const anyOn = req.body.deploysRequest === true || req.body.mergesRequest === true;
      // Same as the other per-agent rights switches: an agent needs an active
      // membership for its grants to count.
      if (anyOn) await access.ensureMembership(before.companyId, "agent", agentId, "member", "active");
      const { state, changes } = await svc.set(agentId, req.body, userId);

      if (changes.length > 0) {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: state.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "agent.request_rights_updated",
          entityType: "agent",
          entityId: agentId,
          details: {
            changes,
            deploysRequest: state.deploysRequest.enabled,
            mergesRequest: state.mergesRequest.enabled,
            _previous: {
              deploysRequest: before.deploysRequest.enabled,
              mergesRequest: before.mergesRequest.enabled,
            },
            position: state.position?.name ?? null,
          },
        });
      }

      res.json({ ...state, canChange: true, changes });
    },
  );

  return router;
}
