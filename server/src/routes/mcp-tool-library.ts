// DUR-143: the MCP "tool library" — add a server once in Settings, then
// tick a checkbox per agent to grant/revoke it. Board-only throughout, same
// posture as agent-roles.ts: agents are structurally blocked from reaching
// these routes, so an agent can never grant itself a new tool connection.
import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
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
import { unprocessable } from "../errors.js";

export function mcpToolLibraryRoutes(db: Db) {
  const router = Router();
  const svc = agentService(db);

  // ── Company tool library CRUD ───────────────────────────────────────────

  router.get("/companies/:companyId/mcp-tools", async (req, res) => {
    assertBoard(req);
    await assertCompanyAccess(req, req.params.companyId!);
    const tools = await listMcpTools(db, req.params.companyId!);
    res.json(tools);
  });

  router.post(
    "/companies/:companyId/mcp-tools",
    validate(mcpToolLibraryEntryBodySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);
      const tool = await createMcpTool(db, companyId, req.body);
      res.status(201).json(tool);
    },
  );

  router.get("/mcp-tools/:toolId", async (req, res) => {
    assertBoard(req);
    const tool = await getMcpTool(db, req.params.toolId!);
    if (!tool) {
      res.status(404).json({ error: "Tool not found" });
      return;
    }
    await assertCompanyAccess(req, tool.companyId);
    res.json(tool);
  });

  router.patch(
    "/mcp-tools/:toolId",
    validate(mcpToolLibraryEntryUpdateSchema),
    async (req, res) => {
      assertBoard(req);
      const toolId = req.params.toolId as string;
      const existing = await getMcpTool(db, toolId);
      if (!existing) {
        res.status(404).json({ error: "Tool not found" });
        return;
      }
      await assertCompanyAccess(req, existing.companyId);
      const updated = await updateMcpTool(db, toolId, req.body);
      res.json(updated);
    },
  );

  router.delete("/mcp-tools/:toolId", async (req, res) => {
    assertBoard(req);
    const existing = await getMcpTool(db, req.params.toolId!);
    if (!existing) {
      res.status(404).json({ error: "Tool not found" });
      return;
    }
    await assertCompanyAccess(req, existing.companyId);
    await deleteMcpTool(db, req.params.toolId!);
    res.status(204).send();
  });

  // ── Per-agent checkbox assignment ───────────────────────────────────────

  router.get("/agents/:agentId/mcp-tools", async (req, res) => {
    assertBoard(req);
    const [agent] = await db
      .select({ id: agents.id, companyId: agents.companyId, mcpToolIds: agents.mcpToolIds })
      .from(agents)
      .where(eq(agents.id, req.params.agentId!));
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(req, agent.companyId);
    const tools = await listMcpToolsForAgent(db, agent.companyId, (agent.mcpToolIds as string[] | null) ?? []);
    res.json(tools);
  });

  router.post(
    "/agents/:agentId/mcp-tools/sync",
    validate(agentMcpToolSelectionSchema),
    async (req, res) => {
      assertBoard(req);
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
      await assertCompanyAccess(req, agent.companyId);

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
