import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  createCrmActivitySchema,
  createCrmContactOrgRoleSchema,
  createCrmContactSchema,
  createCrmFactSchema,
  createCrmOrganizationSchema,
  updateCrmContactSchema,
  updateCrmOrganizationSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";
import { crmService } from "../services/crm.js";

/**
 * DUR-4191 (DUR-4150 slice): CRUD + list routes for the CRM data model --
 * contacts, organisations, contact-org roles, activities, facts. Every
 * route is scoped by `:companyId` through `companyScopeFromParam`, the same
 * primitive goals.ts and data-connections.ts use, so cross-company reads
 * and writes are refused before any query runs. Board users and agents
 * both get full access via `assertCompanyAccess` (unlike the owner-only
 * data-connections routes) -- the parent ticket calls out agent tools as
 * part of this slice.
 */
export function crmRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = crmService(db);

  function scope() {
    return companyScopeFromParam(rawDb, assertCompanyAccess);
  }

  function actorRef(actor: ReturnType<typeof getActorInfo>) {
    return { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null, runId: actor.runId };
  }

  // --- Contacts ---
  router.get("/companies/:companyId/crm/contacts", scope(), async (req, res) => {
    res.json(await svc.listContacts(req.params.companyId as string));
  });

  router.get("/companies/:companyId/crm/contacts/:id", scope(), async (req, res) => {
    res.json(await svc.getContact(req.params.companyId as string, req.params.id as string));
  });

  router.post(
    "/companies/:companyId/crm/contacts",
    scope(),
    validate(createCrmContactSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const actor = getActorInfo(req);
      const created = await svc.createContact(companyId, req.body, actorRef(actor));
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "crm_contact.created",
        entityType: "crm_contact",
        entityId: created.id,
        details: { firstName: created.firstName, lastName: created.lastName, email: created.email },
      });
      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/crm/contacts/:id",
    scope(),
    validate(updateCrmContactSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      const updated = await svc.updateContact(companyId, id, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "crm_contact.updated",
        entityType: "crm_contact",
        entityId: id,
        details: { changed: Object.keys(req.body).sort() },
      });
      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/crm/contacts/:id", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    const removed = await svc.removeContact(companyId, id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "crm_contact.deleted",
      entityType: "crm_contact",
      entityId: id,
      details: { firstName: removed.firstName, lastName: removed.lastName },
    });
    res.json({ ok: true });
  });

  // --- Organisations ---
  router.get("/companies/:companyId/crm/organisations", scope(), async (req, res) => {
    res.json(await svc.listOrganizations(req.params.companyId as string));
  });

  router.get("/companies/:companyId/crm/organisations/:id", scope(), async (req, res) => {
    res.json(await svc.getOrganization(req.params.companyId as string, req.params.id as string));
  });

  router.post(
    "/companies/:companyId/crm/organisations",
    scope(),
    validate(createCrmOrganizationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const actor = getActorInfo(req);
      const created = await svc.createOrganization(companyId, req.body, actorRef(actor));
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "crm_organization.created",
        entityType: "crm_organization",
        entityId: created.id,
        details: { name: created.name },
      });
      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/crm/organisations/:id",
    scope(),
    validate(updateCrmOrganizationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      const updated = await svc.updateOrganization(companyId, id, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "crm_organization.updated",
        entityType: "crm_organization",
        entityId: id,
        details: { changed: Object.keys(req.body).sort() },
      });
      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/crm/organisations/:id", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    const removed = await svc.removeOrganization(companyId, id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "crm_organization.deleted",
      entityType: "crm_organization",
      entityId: id,
      details: { name: removed.name },
    });
    res.json({ ok: true });
  });

  // --- Contact/org roles ---
  router.get("/companies/:companyId/crm/contact-org-roles", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const contactId = typeof req.query.contactId === "string" ? req.query.contactId : undefined;
    const organizationId = typeof req.query.organizationId === "string" ? req.query.organizationId : undefined;
    res.json(await svc.listContactOrgRoles(companyId, { contactId, organizationId }));
  });

  router.post(
    "/companies/:companyId/crm/contact-org-roles",
    scope(),
    validate(createCrmContactOrgRoleSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const created = await svc.createContactOrgRole(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "crm_contact_org_role.created",
        entityType: "crm_contact_org_role",
        entityId: created.id,
        details: { contactId: created.contactId, organizationId: created.organizationId, role: created.role },
      });
      res.status(201).json(created);
    },
  );

  // --- Activities ---
  router.get("/companies/:companyId/crm/activities", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const contactId = typeof req.query.contactId === "string" ? req.query.contactId : undefined;
    const organizationId = typeof req.query.organizationId === "string" ? req.query.organizationId : undefined;
    res.json(await svc.listActivities(companyId, { contactId, organizationId }));
  });

  router.post(
    "/companies/:companyId/crm/activities",
    scope(),
    validate(createCrmActivitySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const actor = getActorInfo(req);
      const created = await svc.createActivity(companyId, req.body, actorRef(actor));
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "crm_activity.created",
        entityType: "crm_activity",
        entityId: created.id,
        details: { type: created.type, title: created.title, contactId: created.contactId, organizationId: created.organizationId },
      });
      res.status(201).json(created);
    },
  );

  // --- Facts ---
  router.get("/companies/:companyId/crm/facts", scope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const contactId = typeof req.query.contactId === "string" ? req.query.contactId : undefined;
    const organizationId = typeof req.query.organizationId === "string" ? req.query.organizationId : undefined;
    res.json(await svc.listFacts(companyId, { contactId, organizationId }));
  });

  router.post("/companies/:companyId/crm/facts", scope(), validate(createCrmFactSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const actor = getActorInfo(req);
    const created = await svc.createFact(companyId, req.body, actorRef(actor));
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "crm_fact.created",
      entityType: "crm_fact",
      entityId: created.id,
      details: { factKey: created.factKey, contactId: created.contactId, organizationId: created.organizationId },
    });
    res.status(201).json(created);
  });

  return router;
}
