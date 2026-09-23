// DUR-133 / DUR-4000: persona CRUD. Board-only — creating or editing a
// person, or deciding which job they hold, is an operator decision,
// mirroring agent-roles.ts. A persona is a person (its own row); an agent is
// a job that may have one persona attached (agents.persona_id). Nothing here
// renames or rewrites an agent.
import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, createRequestScopedDb } from "@paperclipai/db";
import { attachPersonaSchema, createPersonaSchema, updatePersonaSchema } from "@paperclipai/shared/validators/persona";
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
      const persona = await rawService.getPersonaById(req.params[personaIdParam] as string);
      if (!persona) throw notFound("Persona not found");
      assertCompanyAccess(req, persona.companyId);
      return persona.companyId;
    });
  }

  // ── Agent-scoped: the job side ─────────────────────────────────────────

  // Create a person and attach it to this job in one go (what the persona
  // screens call today). 409 when the job already has a person.
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
    const persona = await service.getPersonaViewByAgentId(agentId);
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

  // DUR-4000: the persona picker. Attach an existing person to this job, or
  // detach with { personaId: null }. Board-only like everything here; the
  // agent PATCH route accepts the same `personaId` field under the same
  // board-only guard (assertNoAgentPersonaJobFieldMutation in agents.ts).
  router.put(
    "/agents/:agentId/persona",
    scopeFromAgentIdParam("agentId"),
    validate(attachPersonaSchema),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const persona = await service.attachPersonaToAgent(agentId, req.body.personaId ?? null);
      if (!persona) {
        res.status(204).end();
        return;
      }
      res.json(persona);
    },
  );

  // ── Company-scoped: the person side ────────────────────────────────────

  router.get("/companies/:companyId/personas", scopeFromCompanyIdParam(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const list = await service.listPersonasForCompany(companyId);
    res.json(list);
  });

  // DUR-4000: create a person without attaching it to any job yet.
  router.post(
    "/companies/:companyId/personas",
    scopeFromCompanyIdParam(),
    validate(createPersonaSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const persona = await service.createPersonaForCompany(companyId, req.body);
      res.status(201).json(persona);
    },
  );

  // DUR-4000: the jobs this person holds.
  router.get("/companies/:companyId/personas/:personaId/agents", scopeFromCompanyIdParam(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const persona = await service.getPersonaById(req.params.personaId as string);
    if (!persona || persona.companyId !== companyId) {
      res.status(404).json({ error: "Persona not found" });
      return;
    }
    res.json(await service.listAgentsForPersona(persona.id));
  });

  router.get("/personas/:personaId", scopeFromPersonaIdParam("personaId"), async (req, res) => {
    const persona = await service.getPersonaById(req.params.personaId as string);
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
      const existing = await service.getPersonaById(req.params.personaId as string);
      if (!existing) {
        res.status(404).json({ error: "Persona not found" });
        return;
      }
      const persona = await service.updatePersonaById(existing.id, req.body);
      res.json(persona);
    },
  );

  router.delete("/personas/:personaId", scopeFromPersonaIdParam("personaId"), async (req, res) => {
    const existing = await service.getPersonaById(req.params.personaId as string);
    if (!existing) {
      res.status(404).json({ error: "Persona not found" });
      return;
    }
    await service.deletePersonaById(existing.id);
    res.status(204).end();
  });

  return router;
}
