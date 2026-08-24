// DUR-133: persona CRUD. Board-only — creating or editing a persona's
// identity is an operator decision, mirroring agent-roles.ts.
import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { createPersonaSchema, updatePersonaSchema } from "@paperclipai/shared/validators/persona";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { personaService } from "../services/personas.js";

export function personaRoutes(db: Db) {
  const router = Router();
  const service = personaService(db);

  async function loadAgentOrRespond(req: import("express").Request, res: import("express").Response, agentId: string) {
    const [agent] = await db.select({ id: agents.id, companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId));
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return null;
    }
    await assertCompanyAccess(req, agent.companyId);
    return agent;
  }

  router.post(
    "/agents/:agentId/persona",
    validate(createPersonaSchema),
    async (req, res) => {
      assertBoard(req);
      const agentId = req.params.agentId as string;
      const agent = await loadAgentOrRespond(req, res, agentId);
      if (!agent) return;
      const persona = await service.createPersona(agentId, req.body);
      res.status(201).json(persona);
    },
  );

  router.get("/agents/:agentId/persona", async (req, res) => {
    assertBoard(req);
    const agentId = req.params.agentId as string;
    const agent = await loadAgentOrRespond(req, res, agentId);
    if (!agent) return;
    const persona = await service.getPersonaByAgentId(agentId);
    if (!persona) {
      res.status(404).json({ error: "This agent has no persona yet." });
      return;
    }
    res.json(persona);
  });

  router.patch(
    "/agents/:agentId/persona",
    validate(updatePersonaSchema),
    async (req, res) => {
      assertBoard(req);
      const agentId = req.params.agentId as string;
      const agent = await loadAgentOrRespond(req, res, agentId);
      if (!agent) return;
      const persona = await service.updatePersona(agentId, req.body);
      res.json(persona);
    },
  );

  router.get("/companies/:companyId/personas", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const list = await service.listPersonasForCompany(companyId);
    res.json(list);
  });

  async function loadPersonaOrRespond(req: import("express").Request, res: import("express").Response, personaId: string) {
    const persona = await service.getPersonaWithAgentById(personaId);
    if (!persona) {
      res.status(404).json({ error: "Persona not found" });
      return null;
    }
    await assertCompanyAccess(req, persona.companyId);
    return persona;
  }

  router.get("/personas/:personaId", async (req, res) => {
    assertBoard(req);
    const persona = await loadPersonaOrRespond(req, res, req.params.personaId as string);
    if (!persona) return;
    res.json(persona);
  });

  router.patch(
    "/personas/:personaId",
    validate(updatePersonaSchema),
    async (req, res) => {
      assertBoard(req);
      const existing = await loadPersonaOrRespond(req, res, req.params.personaId as string);
      if (!existing) return;
      const persona = await service.updatePersonaById(existing.id, req.body);
      res.json(persona);
    },
  );

  router.delete("/personas/:personaId", async (req, res) => {
    assertBoard(req);
    const existing = await loadPersonaOrRespond(req, res, req.params.personaId as string);
    if (!existing) return;
    await service.deletePersonaById(existing.id);
    res.status(204).end();
  });

  return router;
}
