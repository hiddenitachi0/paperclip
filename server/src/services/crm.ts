import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { crmActivities, crmContactOrgRoles, crmContacts, crmFacts, crmOrganizations } from "@paperclipai/db";
import type {
  CreateCrmActivity,
  CreateCrmContact,
  CreateCrmContactOrgRole,
  CreateCrmFact,
  CreateCrmOrganization,
  UpdateCrmContact,
  UpdateCrmOrganization,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

type ActorRef = { agentId?: string | null; userId?: string | null };

export function crmService(db: Db) {
  return {
    // --- Contacts ---
    listContacts: (companyId: string) =>
      db.select().from(crmContacts).where(eq(crmContacts.companyId, companyId)).orderBy(desc(crmContacts.createdAt)),

    getContact: async (companyId: string, id: string) => {
      const row = await db
        .select()
        .from(crmContacts)
        .where(and(eq(crmContacts.id, id), eq(crmContacts.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Contact not found");
      return row;
    },

    createContact: (companyId: string, data: CreateCrmContact, actor: ActorRef) =>
      db
        .insert(crmContacts)
        .values({
          ...data,
          companyId,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]),

    updateContact: async (companyId: string, id: string, data: UpdateCrmContact) => {
      const updated = await db
        .update(crmContacts)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(crmContacts.id, id), eq(crmContacts.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) throw notFound("Contact not found");
      return updated;
    },

    removeContact: async (companyId: string, id: string) => {
      const removed = await db
        .delete(crmContacts)
        .where(and(eq(crmContacts.id, id), eq(crmContacts.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!removed) throw notFound("Contact not found");
      return removed;
    },

    // --- Organisations ---
    listOrganizations: (companyId: string) =>
      db
        .select()
        .from(crmOrganizations)
        .where(eq(crmOrganizations.companyId, companyId))
        .orderBy(desc(crmOrganizations.createdAt)),

    getOrganization: async (companyId: string, id: string) => {
      const row = await db
        .select()
        .from(crmOrganizations)
        .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Organisation not found");
      return row;
    },

    createOrganization: (companyId: string, data: CreateCrmOrganization, actor: ActorRef) =>
      db
        .insert(crmOrganizations)
        .values({
          ...data,
          companyId,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]),

    updateOrganization: async (companyId: string, id: string, data: UpdateCrmOrganization) => {
      const updated = await db
        .update(crmOrganizations)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) throw notFound("Organisation not found");
      return updated;
    },

    removeOrganization: async (companyId: string, id: string) => {
      const removed = await db
        .delete(crmOrganizations)
        .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!removed) throw notFound("Organisation not found");
      return removed;
    },

    // --- Contact/org roles ---
    listContactOrgRoles: (companyId: string, filter?: { contactId?: string; organizationId?: string }) => {
      const conditions = [eq(crmContactOrgRoles.companyId, companyId)];
      if (filter?.contactId) conditions.push(eq(crmContactOrgRoles.contactId, filter.contactId));
      if (filter?.organizationId) conditions.push(eq(crmContactOrgRoles.organizationId, filter.organizationId));
      return db
        .select()
        .from(crmContactOrgRoles)
        .where(and(...conditions))
        .orderBy(desc(crmContactOrgRoles.createdAt));
    },

    createContactOrgRole: async (companyId: string, data: CreateCrmContactOrgRole) => {
      const contact = await db
        .select({ id: crmContacts.id })
        .from(crmContacts)
        .where(and(eq(crmContacts.id, data.contactId), eq(crmContacts.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!contact) throw unprocessable("Contact does not belong to this company");

      const organization = await db
        .select({ id: crmOrganizations.id })
        .from(crmOrganizations)
        .where(and(eq(crmOrganizations.id, data.organizationId), eq(crmOrganizations.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!organization) throw unprocessable("Organisation does not belong to this company");

      return db
        .insert(crmContactOrgRoles)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]);
    },

    // --- Activities ---
    listActivities: (companyId: string, filter?: { contactId?: string; organizationId?: string }) => {
      const conditions = [eq(crmActivities.companyId, companyId)];
      if (filter?.contactId) conditions.push(eq(crmActivities.contactId, filter.contactId));
      if (filter?.organizationId) conditions.push(eq(crmActivities.organizationId, filter.organizationId));
      return db
        .select()
        .from(crmActivities)
        .where(and(...conditions))
        .orderBy(desc(crmActivities.activityDate));
    },

    createActivity: async (companyId: string, data: CreateCrmActivity, actor: ActorRef) => {
      if (data.contactId) {
        const contact = await db
          .select({ id: crmContacts.id })
          .from(crmContacts)
          .where(and(eq(crmContacts.id, data.contactId), eq(crmContacts.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!contact) throw unprocessable("Contact does not belong to this company");
      }
      if (data.organizationId) {
        const organization = await db
          .select({ id: crmOrganizations.id })
          .from(crmOrganizations)
          .where(and(eq(crmOrganizations.id, data.organizationId), eq(crmOrganizations.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!organization) throw unprocessable("Organisation does not belong to this company");
      }

      return db
        .insert(crmActivities)
        .values({
          ...data,
          companyId,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    // --- Facts ---
    listFacts: (companyId: string, filter?: { contactId?: string; organizationId?: string }) => {
      const conditions = [eq(crmFacts.companyId, companyId)];
      if (filter?.contactId) conditions.push(eq(crmFacts.contactId, filter.contactId));
      if (filter?.organizationId) conditions.push(eq(crmFacts.organizationId, filter.organizationId));
      return db
        .select()
        .from(crmFacts)
        .where(and(...conditions))
        .orderBy(desc(crmFacts.observedAt));
    },

    createFact: async (companyId: string, data: CreateCrmFact, actor: ActorRef & { runId?: string | null }) => {
      if (data.contactId) {
        const contact = await db
          .select({ id: crmContacts.id })
          .from(crmContacts)
          .where(and(eq(crmContacts.id, data.contactId), eq(crmContacts.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!contact) throw unprocessable("Contact does not belong to this company");
      }
      if (data.organizationId) {
        const organization = await db
          .select({ id: crmOrganizations.id })
          .from(crmOrganizations)
          .where(and(eq(crmOrganizations.id, data.organizationId), eq(crmOrganizations.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!organization) throw unprocessable("Organisation does not belong to this company");
      }

      return db
        .insert(crmFacts)
        .values({
          ...data,
          companyId,
          createdByAgentId: actor.agentId ?? null,
          createdByRunId: actor.runId ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
    },
  };
}
