// DUR-133 (persona-mcp Ticket B, items 10-11, 14): CRUD for a persona's
// identity (name, face, bio, voice) layered on top of an agent. Board-only
// throughout, same posture as company_agent_roles.ts and
// mcp-tool-library.ts: an agent can never grant or edit its own persona.
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createPersonaSchema, updatePersonaSchema } from "@paperclipai/shared/validators/persona";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import {
  createPersona,
  getPersona,
  listPersonas,
  updatePersona,
  deletePersona,
} from "../services/personas.js";

export function personaRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/personas", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const rows = await listPersonas(db, companyId);
    res.json(rows);
  });

  router.post(
    "/companies/:companyId/personas",
    validate(createPersonaSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);
      const persona = await createPersona(db, companyId, req.body);
      res.status(201).json(persona);
    },
  );

  router.get("/personas/:personaId", async (req, res) => {
    assertBoard(req);
    const persona = await getPersona(db, req.params.personaId!);
    if (!persona) {
      res.status(404).json({ error: "Persona not found" });
      return;
    }
    await assertCompanyAccess(req, persona.companyId);
    res.json(persona);
  });

  router.patch(
    "/personas/:personaId",
    validate(updatePersonaSchema),
    async (req, res) => {
      assertBoard(req);
      const personaId = req.params.personaId as string;
      const existing = await getPersona(db, personaId);
      if (!existing) {
        res.status(404).json({ error: "Persona not found" });
        return;
      }
      await assertCompanyAccess(req, existing.companyId);
      const updated = await updatePersona(db, personaId, req.body);
      res.json(updated);
    },
  );

  router.delete("/personas/:personaId", async (req, res) => {
    assertBoard(req);
    const existing = await getPersona(db, req.params.personaId!);
    if (!existing) {
      res.status(404).json({ error: "Persona not found" });
      return;
    }
    await assertCompanyAccess(req, existing.companyId);
    await deletePersona(db, req.params.personaId!);
    res.status(204).send();
  });

  return router;
}
