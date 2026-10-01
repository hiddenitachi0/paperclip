import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { companyScope } from "../middleware/company-scope.js";
import { forbidden } from "../errors.js";
import {
  AGENT_WORK_SUMMARY_DEFAULT_SEARCH_LIMIT,
  AGENT_WORK_SUMMARY_MAX_SEARCH_LIMIT,
  searchAgentWorkSummaries,
} from "../services/agent-work-summaries.js";

/**
 * DUR-4197: work-history search for full agents, the MCP-server-facing
 * read side of agent_work_summaries. An agent may only search its own
 * summaries -- there is no "search another agent's history" or
 * board-wide path here, by design (least privilege: a run only ever
 * needs continuity with its own past, never another agent's).
 */
const searchQuerySchema = z.object({
  q: z.string().trim().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(AGENT_WORK_SUMMARY_MAX_SEARCH_LIMIT).optional(),
});

export function agentWorkSummaryRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);

  function selfScope() {
    return companyScope(rawDb, (req) => {
      if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
        throw forbidden("Agent authentication required");
      }
      return req.actor.companyId;
    });
  }

  router.get("/agents/me/work-summaries", selfScope(), async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }
    const parsed = searchQuerySchema.parse(req.query);
    const rows = await searchAgentWorkSummaries(db, {
      companyId: req.actor.companyId,
      agentId: req.actor.agentId,
      query: parsed.q ?? null,
      limit: parsed.limit ?? AGENT_WORK_SUMMARY_DEFAULT_SEARCH_LIMIT,
    });
    res.json({ summaries: rows });
  });

  return router;
}
