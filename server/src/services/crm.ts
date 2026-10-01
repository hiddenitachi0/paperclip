import { and, desc, eq, ilike, or } from "drizzle-orm";
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
  UpsertCrmContact,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

type ActorRef = { agentId?: string | null; userId?: string | null };

const SEARCH_RESULT_LIMIT = 20;

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

      const organizationRoles = await db
        .select({
          roleId: crmContactOrgRoles.id,
          role: crmContactOrgRoles.role,
          startDate: crmContactOrgRoles.startDate,
          endDate: crmContactOrgRoles.endDate,
          organization: crmOrganizations,
        })
        .from(crmContactOrgRoles)
        .innerJoin(crmOrganizations, eq(crmOrganizations.id, crmContactOrgRoles.organizationId))
        .where(and(eq(crmContactOrgRoles.contactId, id), eq(crmContactOrgRoles.companyId, companyId)));

      return { ...row, organizations: organizationRoles };
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

      const contactRoles = await db
        .select({
          roleId: crmContactOrgRoles.id,
          role: crmContactOrgRoles.role,
          startDate: crmContactOrgRoles.startDate,
          endDate: crmContactOrgRoles.endDate,
          contact: crmContacts,
        })
        .from(crmContactOrgRoles)
        .innerJoin(crmContacts, eq(crmContacts.id, crmContactOrgRoles.contactId))
        .where(and(eq(crmContactOrgRoles.organizationId, id), eq(crmContactOrgRoles.companyId, companyId)));

      return { ...row, contacts: contactRoles };
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

    // --- Search (crm.search tool) ---
    search: async (companyId: string, query: string) => {
      const pattern = `%${query}%`;
      const contacts = await db
        .select()
        .from(crmContacts)
        .where(
          and(
            eq(crmContacts.companyId, companyId),
            or(ilike(crmContacts.firstName, pattern), ilike(crmContacts.lastName, pattern), ilike(crmContacts.email, pattern)),
          ),
        )
        .orderBy(desc(crmContacts.createdAt))
        .limit(SEARCH_RESULT_LIMIT);

      const organizations = await db
        .select()
        .from(crmOrganizations)
        .where(
          and(
            eq(crmOrganizations.companyId, companyId),
            or(ilike(crmOrganizations.name, pattern), ilike(crmOrganizations.email, pattern)),
          ),
        )
        .orderBy(desc(crmOrganizations.createdAt))
        .limit(SEARCH_RESULT_LIMIT);

      return { contacts, organizations };
    },

    // --- Upsert (crm.upsert_contact tool) ---
    upsertContact: async (companyId: string, data: UpsertCrmContact, actor: ActorRef) => {
      const dedupConditions = data.email
        ? eq(crmContacts.email, data.email)
        : and(eq(crmContacts.firstName, data.firstName), eq(crmContacts.lastName, data.lastName));

      const existing = await db
        .select()
        .from(crmContacts)
        .where(and(eq(crmContacts.companyId, companyId), dedupConditions))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        const updated = await db
          .update(crmContacts)
          .set({ ...data, updatedAt: new Date() })
          .where(and(eq(crmContacts.id, existing.id), eq(crmContacts.companyId, companyId)))
          .returning()
          .then((rows) => rows[0]);
        return { contact: updated, created: false };
      }

      const created = await db
        .insert(crmContacts)
        .values({
          ...data,
          companyId,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
      return { contact: created, created: true };
    },
  };
}
