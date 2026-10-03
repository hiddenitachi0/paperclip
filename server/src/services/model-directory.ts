import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { modelDirectoryEntries } from "@paperclipai/db";
import {
  MODEL_DIRECTORY_NAME_MAX_LENGTH,
  modelDirectoryEntryIssue,
  type CreateModelDirectoryEntry,
  type ModelDirectoryEntry,
  type UpdateModelDirectoryEntry,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

/**
 * DUR-4379: the company model directory (saved model setups). Every query
 * filters on companyId, so another company's entry is "not found" even if its
 * id is guessed; RLS is the second wall, not the first. No key is stored or
 * returned: an entry only names provider/model/address and defaults.
 */

type Row = typeof modelDirectoryEntries.$inferSelect;

export function toModelDirectoryEntry(row: Row): ModelDirectoryEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    provider: row.provider as ModelDirectoryEntry["provider"],
    model: row.model,
    baseUrl: row.baseUrl,
    providerRouting: (row.providerRouting as ModelDirectoryEntry["providerRouting"]) ?? null,
    defaultThinking: (row.defaultThinking as ModelDirectoryEntry["defaultThinking"]) ?? null,
    defaultTemperature: row.defaultTemperature,
    defaultMaxOutputTokens: row.defaultMaxOutputTokens,
    backupEntryIds: Array.isArray(row.backupEntryIds) ? row.backupEntryIds : [],
    note: row.note,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null);
  return code?.code === "23505" || code?.cause?.code === "23505";
}

export function modelDirectoryService(db: Db) {
  async function getRow(companyId: string, id: string): Promise<Row> {
    const [row] = await db
      .select()
      .from(modelDirectoryEntries)
      .where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.id, id)));
    if (!row) throw notFound("Model setup not found");
    return row;
  }

  /** Every backup id must be another entry of this same company. */
  async function assertBackupsBelongToCompany(companyId: string, ids: readonly string[]) {
    if (ids.length === 0) return;
    const found = await db
      .select({ id: modelDirectoryEntries.id })
      .from(modelDirectoryEntries)
      .where(and(eq(modelDirectoryEntries.companyId, companyId), inArray(modelDirectoryEntries.id, [...ids])));
    if (found.length !== new Set(ids).size) {
      throw unprocessable("A backup model is not one of this company's saved model setups.");
    }
  }

  async function assertNameFree(companyId: string, name: string, exceptId?: string) {
    const rows = await db
      .select({ id: modelDirectoryEntries.id })
      .from(modelDirectoryEntries)
      .where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.name, name)));
    if (rows.some((r) => r.id !== exceptId)) throw conflict(`A model setup named "${name}" already exists.`);
  }

  async function insert(companyId: string, values: typeof modelDirectoryEntries.$inferInsert) {
    try {
      const [row] = await db.insert(modelDirectoryEntries).values(values).returning();
      return toModelDirectoryEntry(row!);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(`A model setup named "${values.name}" already exists.`);
      throw error;
    }
  }

  return {
    async list(companyId: string): Promise<ModelDirectoryEntry[]> {
      const rows = await db
        .select()
        .from(modelDirectoryEntries)
        .where(eq(modelDirectoryEntries.companyId, companyId))
        .orderBy(asc(modelDirectoryEntries.name));
      return rows.map(toModelDirectoryEntry);
    },

    async get(companyId: string, id: string): Promise<ModelDirectoryEntry> {
      return toModelDirectoryEntry(await getRow(companyId, id));
    },

    async create(companyId: string, input: CreateModelDirectoryEntry, actor: { userId: string | null }) {
      await assertNameFree(companyId, input.name);
      await assertBackupsBelongToCompany(companyId, input.backupEntryIds ?? []);
      return insert(companyId, {
        companyId,
        name: input.name,
        provider: input.provider,
        model: input.model,
        baseUrl: input.baseUrl ?? null,
        providerRouting: input.providerRouting ?? null,
        defaultThinking: input.defaultThinking ?? null,
        defaultTemperature: input.defaultTemperature ?? null,
        defaultMaxOutputTokens: input.defaultMaxOutputTokens ?? null,
        backupEntryIds: input.backupEntryIds ?? [],
        note: input.note ?? null,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      });
    },

    async update(companyId: string, id: string, patch: UpdateModelDirectoryEntry, actor: { userId: string | null }) {
      const current = await getRow(companyId, id);
      const merged = {
        provider: patch.provider ?? current.provider,
        model: patch.model ?? current.model,
        baseUrl: patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl,
        providerRouting: patch.providerRouting === undefined ? current.providerRouting : patch.providerRouting,
        backupEntryIds: patch.backupEntryIds ?? (current.backupEntryIds as string[]),
      };
      const issue = modelDirectoryEntryIssue({ id, ...merged });
      if (issue) throw unprocessable(issue);
      if (patch.name !== undefined && patch.name !== current.name) await assertNameFree(companyId, patch.name, id);
      if (patch.backupEntryIds) await assertBackupsBelongToCompany(companyId, patch.backupEntryIds);
      const set: Partial<typeof modelDirectoryEntries.$inferInsert> = { updatedAt: new Date(), updatedByUserId: actor.userId };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.provider !== undefined) set.provider = patch.provider;
      if (patch.model !== undefined) set.model = patch.model;
      if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
      if (patch.providerRouting !== undefined) set.providerRouting = patch.providerRouting;
      if (patch.defaultThinking !== undefined) set.defaultThinking = patch.defaultThinking;
      if (patch.defaultTemperature !== undefined) set.defaultTemperature = patch.defaultTemperature;
      if (patch.defaultMaxOutputTokens !== undefined) set.defaultMaxOutputTokens = patch.defaultMaxOutputTokens;
      if (patch.backupEntryIds !== undefined) set.backupEntryIds = patch.backupEntryIds;
      if (patch.note !== undefined) set.note = patch.note;
      try {
        const [row] = await db
          .update(modelDirectoryEntries)
          .set(set)
          .where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.id, id)))
          .returning();
        if (!row) throw notFound("Model setup not found");
        return toModelDirectoryEntry(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict(`A model setup named "${patch.name}" already exists.`);
        throw error;
      }
    },

    /** Deletes the entry and drops it from every sibling's backup chain. */
    async remove(companyId: string, id: string): Promise<ModelDirectoryEntry> {
      const current = await getRow(companyId, id);
      const siblings = await db
        .select()
        .from(modelDirectoryEntries)
        .where(eq(modelDirectoryEntries.companyId, companyId));
      for (const sibling of siblings) {
        const ids = Array.isArray(sibling.backupEntryIds) ? sibling.backupEntryIds : [];
        if (sibling.id !== id && ids.includes(id)) {
          await db
            .update(modelDirectoryEntries)
            .set({ backupEntryIds: ids.filter((x) => x !== id) })
            .where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.id, sibling.id)));
        }
      }
      await db
        .delete(modelDirectoryEntries)
        .where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.id, id)));
      return toModelDirectoryEntry(current);
    },

    async duplicate(companyId: string, id: string, name: string | undefined, actor: { userId: string | null }) {
      const source = await getRow(companyId, id);
      let chosen = name;
      if (!chosen) {
        const taken = new Set(
          (await db.select({ name: modelDirectoryEntries.name }).from(modelDirectoryEntries).where(eq(modelDirectoryEntries.companyId, companyId))).map((r) => r.name),
        );
        const stem = source.name.slice(0, MODEL_DIRECTORY_NAME_MAX_LENGTH - 12);
        chosen = `${stem} (copy)`;
        for (let n = 2; taken.has(chosen); n += 1) chosen = `${stem} (copy ${n})`;
      } else {
        await assertNameFree(companyId, chosen);
      }
      return insert(companyId, {
        companyId,
        name: chosen,
        provider: source.provider,
        model: source.model,
        baseUrl: source.baseUrl,
        providerRouting: source.providerRouting,
        defaultThinking: source.defaultThinking,
        defaultTemperature: source.defaultTemperature,
        defaultMaxOutputTokens: source.defaultMaxOutputTokens,
        backupEntryIds: source.backupEntryIds,
        note: source.note,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      });
    },
  };
}
