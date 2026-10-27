import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, goals } from "@paperclipai/db";
import { unprocessable } from "../errors.js";

/**
 * Cross-company isolation (docs/security/cross-company-isolation.md): a goal's
 * parent goal and owner agent must be in the goal's OWN company. The foreign
 * keys alone do not carry the company, so without this a member of company A
 * could hang A's goals under company B's goal tree or name B's agent as owner.
 */
async function assertGoalReferencesInCompany(
  db: Db,
  companyId: string,
  refs: { parentId?: string | null; ownerAgentId?: string | null },
) {
  if (typeof refs.parentId === "string" && refs.parentId.length > 0) {
    const parent = await db
      .select({ id: goals.id })
      .from(goals)
      .where(and(eq(goals.id, refs.parentId), eq(goals.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!parent) throw unprocessable("Parent goal must belong to the same company");
  }
  if (typeof refs.ownerAgentId === "string" && refs.ownerAgentId.length > 0) {
    const owner = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, refs.ownerAgentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!owner) throw unprocessable("Owner agent must belong to the same company");
  }
}

type GoalReader = Pick<Db, "select">;

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

export function goalService(db: Db) {
  return {
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    create: async (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) => {
      await assertGoalReferencesInCompany(db, companyId, data);
      return db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]);
    },

    update: async (id: string, data: Partial<typeof goals.$inferInsert>) => {
      const existing = await db
        .select({ companyId: goals.companyId })
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      await assertGoalReferencesInCompany(db, existing.companyId, data);
      return db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
