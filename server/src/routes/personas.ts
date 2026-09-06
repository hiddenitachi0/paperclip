// DUR-133: persona CRUD. Board-only — creating or editing a persona's
// identity is an operator decision, mirroring agent-roles.ts.
import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, createRequestScopedDb } from "@paperclipai/db";
import { createPersonaSchema, updatePersonaSchema } from "@paperclipai/shared/validators/persona";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { personaService } from "../services/personas.js";
import { companyScope } from "../middleware/company-scope.js";
import { notFound } from "../errors.js";

export function personaRoutes(rawDb: Db) {
  const router = Router();
  // DUR-348 (DUR-277 Wave 2): this file's own request-scoped instance; rawDb
  // stays unwrapped for the pre-scope lookups below. See
  // middleware/company-scope.ts.
  const db = createRequestScopedDb(rawDb);
  const service = personaService(db);
  const rawService = personaService(rawDb);

  // Board-only throughout: assertBoard needs no companyId/scope, so it
  // always runs first, ahead of (and outside) the scope resolvers below --
  // per DUR-348's should-fix.
  function scopeFromAgentIdParam(agentIdParam: string) {
    return companyScope(rawDb, async (req) => {
      assertBoard(req);
      const [agent] = await rawDb
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, req.params[agentIdParam] as string));
      if (!agent) throw notFound("Agent not found");
      assertCompanyAccess(req, agent.companyId);
      return agent.companyId;
    });
  }

  function scopeFromCompanyIdParam() {
    return companyScope(rawDb, (req) => {
      assertBoard(req);
      const value = req.params.companyId;
      if (typeof value !== "string") return undefined;
      assertCompanyAccess(req, value);
      return value;
    });
  }

  function scopeFromPersonaIdParam(personaIdParam: string) {
    return companyScope(rawDb, async (req) => {
      assertBoard(req);
      const persona = await rawService.getPersonaWithAgentById(req.params[personaIdParam] as string);
      if (!persona) throw notFound("Persona not found");
      assertCompanyAccess(req, persona.companyId);
      return persona.companyId;
    });
  }

  router.post(
    "/agents/:agentId/persona",
    scopeFromAgentIdParam("agentId"),
    validate(createPersonaSchema),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const persona = await service.createPersona(agentId, req.body);
      res.status(201).json(persona);
    },
  );

  router.get("/agents/:agentId/persona", scopeFromAgentIdParam("agentId"), async (req, res) => {
    const agentId = req.params.agentId as string;
    const persona = await service.getPersonaByAgentId(agentId);
    if (!persona) {
      res.status(404).json({ error: "This agent has no persona yet." });
      return;
    }
    res.json(persona);
  });

  router.patch(
    "/agents/:agentId/persona",
    scopeFromAgentIdParam("agentId"),
    validate(updatePersonaSchema),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const persona = await service.updatePersona(agentId, req.body);
      res.json(persona);
    },
  );

  router.get("/companies/:companyId/personas", scopeFromCompanyIdParam(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const list = await service.listPersonasForCompany(companyId);
    res.json(list);
  });

  router.get("/personas/:personaId", scopeFromPersonaIdParam("personaId"), async (req, res) => {
    const persona = await service.getPersonaWithAgentById(req.params.personaId as string);
    if (!persona) {
      res.status(404).json({ error: "Persona not found" });
      return;
    }
    res.json(persona);
  });

  router.patch(
    "/personas/:personaId",
    scopeFromPersonaIdParam("personaId"),
    validate(updatePersonaSchema),
    async (req, res) => {
      const existing = await service.getPersonaWithAgentById(req.params.personaId as string);
      if (!existing) {
        res.status(404).json({ error: "Persona not found" });
        return;
      }
      const persona = await service.updatePersonaById(existing.id, req.body);
      res.json(persona);
    },
  );

  router.delete("/personas/:personaId", scopeFromPersonaIdParam("personaId"), async (req, res) => {
    const existing = await service.getPersonaWithAgentById(req.params.personaId as string);
    if (!existing) {
      res.status(404).json({ error: "Persona not found" });
      return;
    }
    await service.deletePersonaById(existing.id);
    res.status(204).end();
  });

  return router;
}
