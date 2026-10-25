import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, createRequestScopedDb } from "@paperclipai/db";
import {
  AGENT_MEMORY_SOURCES,
  createAgentMemorySchema,
  updateAgentMemorySchema,
} from "@paperclipai/shared/validators/agent-memory";
import { z } from "zod";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { accessService } from "../services/access.js";
import { agentMemoryService, type AgentMemoryActor } from "../services/agent-memories.js";
import { telegramReactionService } from "../services/telegram-reactions.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Quick-agent memory notebook, the board side: the "Memory" section on a
 * quick agent's page. List, add, edit, delete one, and clear all.
 *
 * Who may use these: exactly who may change the agent's quick-agent settings
 * (the board-only PATCH guard in routes/agents.ts): a board user with access
 * to the agent's company and the agents:create permission there. Agents are
 * refused on every route, reading included, so an agent can neither read
 * nor plant notes here; a quick agent changes its notebook only through its
 * remember/forget tools, on a person's request.
 *
 * The notebook is the agent's persona's when it has one, else the agent's
 * own; the service decides that from the agent row, never from the request.
 * Every change is written to the activity log by the service.
 */
const memoryListQuerySchema = z.object({ source: z.enum(AGENT_MEMORY_SOURCES).optional() });

/** DUR-4829: the newest reactions to this agent's messages, one page at a time. */
export const RECENT_REACTIONS_DEFAULT_LIMIT = 25;
export const RECENT_REACTIONS_MAX_LIMIT = 100;
const recentReactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(RECENT_REACTIONS_MAX_LIMIT).default(RECENT_REACTIONS_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function agentMemoryRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = agentMemoryService(db);
  const reactions = telegramReactionService(db);
  const access = accessService(rawDb);

  function boardEditorScope() {
    return companyScope(rawDb, async (req) => {
      // Board-only, before anything is looked up: an agent learns nothing.
      assertBoard(req);
      if (!UUID_RE.test(req.params.agentId as string)) throw notFound("Agent not found");
      const [agent] = await rawDb
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, req.params.agentId as string));
      if (!agent) throw notFound("Agent not found");
      assertCompanyAccess(req, agent.companyId);
      const decision = await access.decide({
        actor: req.actor,
        action: "agents:create",
        resource: { type: "company", companyId: agent.companyId },
      });
      if (!decision.allowed) {
        throw forbidden("Only people who can change this agent's settings can see and change its memory.");
      }
      (req as Request & { memoryCompanyId?: string }).memoryCompanyId = agent.companyId;
      return agent.companyId;
    });
  }

  function companyOf(req: Request): string {
    return (req as Request & { memoryCompanyId?: string }).memoryCompanyId as string;
  }

  /** A note id that is not a uuid is a note that does not exist (never a database error). */
  function memoryIdOf(req: Request): string {
    const value = req.params.memoryId as string;
    if (!UUID_RE.test(value)) throw notFound("That note was not found. It may already have been deleted.");
    return value;
  }

  function actorOf(req: Request): AgentMemoryActor {
    const userId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    return { actorType: "user", actorId: userId ?? "board", userId, via: "page" };
  }

  // ?source=reaction lists only the notes learned from emoji reactions (the
  // "What it has learned" panel); without it the whole notebook, as before.
  router.get("/agents/:agentId/memories", boardEditorScope(), async (req, res) => {
    const query = memoryListQuerySchema.parse(req.query);
    res.json(await svc.list(companyOf(req), req.params.agentId as string, { source: query.source }));
  });

  // DUR-4829: what the person reacted to, newest first. Same gate as the
  // notebook above (board, with the right to change this agent's settings).
  router.get("/agents/:agentId/reactions", boardEditorScope(), async (req, res) => {
    const query = recentReactionsQuerySchema.parse(req.query);
    const companyId = companyOf(req);
    const agentId = req.params.agentId as string;
    const [owner, page] = await Promise.all([
      svc.resolveOwner(companyId, agentId),
      reactions.listRecentForAgent(companyId, agentId, query),
    ]);
    res.json({
      agentId,
      reactionLearningEnabled: owner.reactionLearningEnabled,
      limit: query.limit,
      offset: query.offset,
      hasMore: page.hasMore,
      items: page.items,
    });
  });

  router.post("/agents/:agentId/memories", boardEditorScope(), validate(createAgentMemorySchema), async (req, res) => {
    const note = await svc.add(companyOf(req), req.params.agentId as string, { text: req.body.text, source: "user" }, actorOf(req));
    res.status(201).json(note);
  });

  router.patch(
    "/agents/:agentId/memories/:memoryId",
    boardEditorScope(),
    validate(updateAgentMemorySchema),
    async (req, res) => {
      const note = await svc.update(
        companyOf(req),
        req.params.agentId as string,
        memoryIdOf(req),
        { text: req.body.text },
        actorOf(req),
      );
      res.json(note);
    },
  );

  router.delete("/agents/:agentId/memories/:memoryId", boardEditorScope(), async (req, res) => {
    await svc.remove(companyOf(req), req.params.agentId as string, memoryIdOf(req), actorOf(req));
    res.status(204).end();
  });

  router.delete("/agents/:agentId/memories", boardEditorScope(), async (req, res) => {
    res.json(await svc.clear(companyOf(req), req.params.agentId as string, actorOf(req)));
  });

  return router;
}
