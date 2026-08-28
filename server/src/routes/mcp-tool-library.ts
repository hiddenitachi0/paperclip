// DUR-143: the MCP "tool library" — add a server once in Settings, then
// tick a checkbox per agent to grant/revoke it. Board-only throughout, same
// posture as agent-roles.ts: agents are structurally blocked from reaching
// these routes, so an agent can never grant itself a new tool connection.
import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, createRequestScopedDb } from "@paperclipai/db";
import { agentService } from "../services/index.js";
import {
  mcpToolLibraryEntryBodySchema,
  mcpToolLibraryEntryUpdateSchema,
  agentMcpToolSelectionSchema,
} from "@paperclipai/shared/validators/mcp-tool-library";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import {
  createMcpTool,
  listMcpTools,
  getMcpTool,
  updateMcpTool,
  deleteMcpTool,
  listMcpToolsForAgent,
} from "../services/mcp-tool-library.js";
import { unprocessable, notFound } from "../errors.js";
import { companyScope } from "../middleware/company-scope.js";

// Board-only throughout (see file header comment above): assertBoard needs
// no companyId/scope at all, so it always runs first, ahead of (and outside)
// the company-scope resolver below -- per DUR-348's should-fix, an
// authorization check that doesn't need the scope should never run after
// scope has already been established for the request.
function requireBoardCheck(req: Parameters<typeof assertBoard>[0]) {
  assertBoard(req);
}

export function mcpToolLibraryRoutes(rawDb: Db) {
  const router = Router();
  // DUR-348 (DUR-277 Wave 2): this file's own request-scoped instance; rawDb
  // stays unwrapped for the pre-scope lookups the agent/tool-id routes below
  // need before their companyId is known. See middleware/company-scope.ts.
  const db = createRequestScopedDb(rawDb);
  const svc = agentService(db);

  function scopeFromCompanyIdParam() {
    return companyScope(rawDb, (req) => {
      requireBoardCheck(req);
      const value = req.params.companyId;
      if (typeof value !== "string") return undefined;
      assertCompanyAccess(req, value);
      return value;
    });
  }

  function scopeFromTool(toolIdParam: string) {
    return companyScope(rawDb, async (req) => {
      requireBoardCheck(req);
      const tool = await getMcpTool(rawDb, req.params[toolIdParam] as string);
      if (!tool) throw notFound("Tool not found");
      assertCompanyAccess(req, tool.companyId);
      return tool.companyId;
    });
  }

  function scopeFromAgent(agentIdParam: string) {
    return companyScope(rawDb, async (req) => {
      requireBoardCheck(req);
      const [agent] = await rawDb
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, req.params[agentIdParam] as string));
      if (!agent) throw notFound("Agent not found");
      assertCompanyAccess(req, agent.companyId);
      return agent.companyId;
    });
  }

  // ── Company tool library CRUD ───────────────────────────────────────────

  router.get("/companies/:companyId/mcp-tools", scopeFromCompanyIdParam(), async (req, res) => {
    const tools = await listMcpTools(db, req.params.companyId as string);
    res.json(tools);
  });

  router.post(
    "/companies/:companyId/mcp-tools",
    scopeFromCompanyIdParam(),
    validate(mcpToolLibraryEntryBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const tool = await createMcpTool(db, companyId, req.body);
      res.status(201).json(tool);
    },
  );

  router.get("/mcp-tools/:toolId", scopeFromTool("toolId"), async (req, res) => {
    const tool = await getMcpTool(db, req.params.toolId as string);
    if (!tool) {
      res.status(404).json({ error: "Tool not found" });
      return;
    }
    res.json(tool);
  });

  router.patch(
    "/mcp-tools/:toolId",
    scopeFromTool("toolId"),
    validate(mcpToolLibraryEntryUpdateSchema),
    async (req, res) => {
      const toolId = req.params.toolId as string;
      const existing = await getMcpTool(db, toolId);
      if (!existing) {
        res.status(404).json({ error: "Tool not found" });
        return;
      }
      const updated = await updateMcpTool(db, toolId, req.body);
      res.json(updated);
    },
  );

  router.delete("/mcp-tools/:toolId", scopeFromTool("toolId"), async (req, res) => {
    const existing = await getMcpTool(db, req.params.toolId as string);
    if (!existing) {
      res.status(404).json({ error: "Tool not found" });
      return;
    }
    await deleteMcpTool(db, req.params.toolId as string);
    res.status(204).send();
  });

  // ── Per-agent checkbox assignment ───────────────────────────────────────

  router.get("/agents/:agentId/mcp-tools", scopeFromAgent("agentId"), async (req, res) => {
    const [agent] = await db
      .select({ id: agents.id, companyId: agents.companyId, mcpToolIds: agents.mcpToolIds })
      .from(agents)
      .where(eq(agents.id, req.params.agentId as string));
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const tools = await listMcpToolsForAgent(db, agent.companyId, (agent.mcpToolIds as string[] | null) ?? []);
    res.json(tools);
  });

  router.post(
    "/agents/:agentId/mcp-tools/sync",
    scopeFromAgent("agentId"),
    validate(agentMcpToolSelectionSchema),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const { desiredToolIds } = req.body as { desiredToolIds: string[] };

      const [agent] = await db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId));
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const uniqueIds = [...new Set(desiredToolIds)];
      for (const toolId of uniqueIds) {
        const tool = await getMcpTool(db, toolId);
        if (!tool || tool.companyId !== agent.companyId) {
          throw unprocessable(`Tool ${toolId} does not belong to this agent's company`);
        }
      }

      const updated = await svc.syncMcpToolSelection(agentId, uniqueIds);
      res.json(updated);
    },
  );

  return router;
}
