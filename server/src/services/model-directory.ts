import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, modelDirectoryEntries } from "@paperclipai/db";
import {
  LANE_A_PROVIDER_CATALOGUE,
  MODEL_DIRECTORY_NAME_MAX_LENGTH,
  MODEL_DIRECTORY_STARTERS,
  modelDirectoryEntryIssue,
  normalizeLaneAProvider,
  type LaneABackupModelConfig,
  type ModelDirectoryImportResult,
  type ModelDirectoryStarterStatus,
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

type SetupKey = {
  provider: string;
  model: string;
  baseUrl: string | null;
  providerRouting: unknown;
  defaultThinking: string | null;
  defaultTemperature: number | null;
  defaultMaxOutputTokens: number | null;
};

/** Order-insensitive-by-construction identity of a setup, for de-duplication. */
function setupKeyOf(k: SetupKey): string {
  const routing = (k.providerRouting ?? null) as Record<string, unknown> | null;
  const sortedRouting = routing
    ? Object.fromEntries(
        Object.entries(routing)
          .filter(([, v]) => v !== undefined && v !== null)
          .sort(([a], [b]) => a.localeCompare(b)),
      )
    : null;
  return JSON.stringify([
    k.provider,
    k.model,
    (k.baseUrl ?? "").trim().replace(/\/+$/, ""),
    sortedRouting && Object.keys(sortedRouting).length > 0 ? sortedRouting : null,
    k.defaultThinking ?? null,
    k.defaultTemperature ?? null,
    k.defaultMaxOutputTokens ?? null,
  ]);
}

/**
 * DUR-4418: lets a backup pool entry that points at a directory entry run on
 * that entry's coordinates. A dangling/foreign id keeps the inline copy, so a
 * deleted entry degrades gracefully instead of breaking a chat turn.
 */
export async function resolveBackupModelsThroughDirectory(
  db: Db,
  companyId: string,
  backups: readonly LaneABackupModelConfig[],
): Promise<LaneABackupModelConfig[]> {
  const ids = [...new Set(backups.map((b) => b.directoryEntryId).filter((id): id is string => typeof id === "string"))];
  if (ids.length === 0) return [...backups];
  const rows = await db
    .select()
    .from(modelDirectoryEntries)
    .where(and(eq(modelDirectoryEntries.companyId, companyId), inArray(modelDirectoryEntries.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return backups.map((backup) => {
    const entry = backup.directoryEntryId ? byId.get(backup.directoryEntryId) : undefined;
    if (!entry) return backup;
    return {
      ...backup,
      provider: entry.provider as LaneABackupModelConfig["provider"],
      model: entry.model,
      baseUrl: entry.baseUrl,
      temperature: entry.defaultTemperature,
    };
  });
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

    /** Every ready-made starter, flagged with whether this company already has it. */
    async listStarters(companyId: string): Promise<ModelDirectoryStarterStatus[]> {
      const existing = await db
        .select({ provider: modelDirectoryEntries.provider, model: modelDirectoryEntries.model, baseUrl: modelDirectoryEntries.baseUrl })
        .from(modelDirectoryEntries)
        .where(eq(modelDirectoryEntries.companyId, companyId));
      const have = new Set(existing.map((e) => `${e.provider}\u0000${e.model}\u0000${(e.baseUrl ?? "").replace(/\/+$/, "")}`));
      return MODEL_DIRECTORY_STARTERS.map((starter) => ({
        ...starter,
        alreadyAdded: have.has(`${starter.provider}\u0000${starter.model}\u0000${(starter.baseUrl ?? "").replace(/\/+$/, "")}`),
      }));
    },

    /** Adds the chosen (default: all) starters this company lacks. Safe to repeat. */
    async addStarters(companyId: string, starterIds: readonly string[] | undefined, actor: { userId: string | null }) {
      const wanted = starterIds ?? MODEL_DIRECTORY_STARTERS.map((s) => s.id);
      const unknown = wanted.filter((id) => !MODEL_DIRECTORY_STARTERS.some((s) => s.id === id));
      if (unknown.length > 0) throw unprocessable("One of the ready-made model setups you picked does not exist.");
      const status = await this.listStarters(companyId);
      const created: ModelDirectoryEntry[] = [];
      for (const starter of status) {
        if (!wanted.includes(starter.id) || starter.alreadyAdded) continue;
        const taken = await db
          .select({ id: modelDirectoryEntries.id })
          .from(modelDirectoryEntries)
          .where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.name, starter.name)));
        if (taken.length > 0) continue; // the person already uses that name for something else; do not overwrite or rename theirs
        created.push(
          await insert(companyId, {
            companyId,
            name: starter.name,
            provider: starter.provider,
            model: starter.model,
            baseUrl: starter.baseUrl,
            providerRouting: null,
            defaultThinking: starter.defaultThinking,
            defaultTemperature: null,
            defaultMaxOutputTokens: null,
            backupEntryIds: [],
            note: starter.note,
            createdByUserId: actor.userId,
            updatedByUserId: actor.userId,
          }),
        );
      }
      return created;
    },

    /**
     * Saves each quick agent's current manual model setup (and each backup
     * model) as a directory entry, de-duplicated across agents, and links the
     * agent / backup to it. Read-only for the agent's live lane_a_* settings,
     * so what an agent does does not change. Idempotent: agents that already
     * point at an entry are left alone, and an identical existing entry is
     * reused instead of copied.
     */
    async importAgentSettings(companyId: string, actor: { userId: string | null }): Promise<ModelDirectoryImportResult> {
      const result: ModelDirectoryImportResult = { created: [], agentsLinked: 0, skipped: [] };
      const existing = await db.select().from(modelDirectoryEntries).where(eq(modelDirectoryEntries.companyId, companyId));
      const byKey = new Map<string, string>();
      const names = new Set<string>();
      for (const e of existing) {
        names.add(e.name);
        const key = setupKeyOf(e);
        if (!byKey.has(key)) byKey.set(key, e.id);
      }

      const nameFor = (key: SetupKey) => {
        const label = LANE_A_PROVIDER_CATALOGUE[normalizeLaneAProvider(key.provider)].label;
        const stem = `${label}: ${key.model}`.slice(0, MODEL_DIRECTORY_NAME_MAX_LENGTH - 12);
        let name = stem;
        for (let n = 2; names.has(name); n += 1) name = `${stem} (${n})`;
        return name;
      };

      const ensureEntry = async (key: SetupKey): Promise<string | { issue: string }> => {
        const issue = modelDirectoryEntryIssue({ provider: key.provider, model: key.model, baseUrl: key.baseUrl, providerRouting: key.providerRouting });
        if (issue) return { issue };
        const k = setupKeyOf(key);
        const known = byKey.get(k);
        if (known) return known;
        const name = nameFor(key);
        const entry = await insert(companyId, {
          companyId,
          name,
          provider: key.provider,
          model: key.model,
          baseUrl: key.baseUrl,
          providerRouting: (key.providerRouting ?? null) as never,
          defaultThinking: key.defaultThinking,
          defaultTemperature: key.defaultTemperature,
          defaultMaxOutputTokens: key.defaultMaxOutputTokens,
          backupEntryIds: [],
          note: "Saved from an agent's earlier settings.",
          createdByUserId: actor.userId,
          updatedByUserId: actor.userId,
        });
        names.add(name);
        byKey.set(k, entry.id);
        result.created.push(entry);
        return entry.id;
      };

      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId)));
      for (const agent of rows) {
        const hasMain = !!agent.laneAModel && agent.laneADirectoryEntryId == null;
        const backups = (Array.isArray(agent.laneABackupModels) ? agent.laneABackupModels : []) as LaneABackupModelConfig[];
        const backupsToLink = backups.filter((b) => !b.directoryEntryId);
        if (!hasMain && backupsToLink.length === 0) continue;

        if (hasMain) {
          const got = await ensureEntry({
            provider: normalizeLaneAProvider(agent.laneAProvider),
            model: agent.laneAModel!,
            baseUrl: agent.laneABaseUrl ?? null,
            providerRouting: agent.laneAProviderRouting ?? null,
            defaultThinking: agent.laneAThinking ?? null,
            defaultTemperature: agent.laneATemperature ?? null,
            defaultMaxOutputTokens: agent.laneAMaxOutputTokens ?? null,
          });
          if (typeof got === "string") {
            await db
              .update(agents)
              .set({ laneADirectoryEntryId: got })
              .where(and(eq(agents.companyId, companyId), eq(agents.id, agent.id), isNull(agents.laneADirectoryEntryId)));
            result.agentsLinked += 1;
          } else {
            result.skipped.push({ agentId: agent.id, agentName: agent.name, reason: got.issue });
          }
        }

        if (backupsToLink.length > 0) {
          let changed = false;
          const next: LaneABackupModelConfig[] = [];
          for (const backup of backups) {
            if (backup.directoryEntryId) {
              next.push(backup);
              continue;
            }
            const got = await ensureEntry({
              provider: normalizeLaneAProvider(backup.provider),
              model: backup.model,
              baseUrl: backup.baseUrl ?? null,
              providerRouting: null,
              defaultThinking: null,
              defaultTemperature: backup.temperature ?? null,
              defaultMaxOutputTokens: null,
            });
            if (typeof got === "string") {
              next.push({ ...backup, directoryEntryId: got });
              changed = true;
            } else {
              next.push(backup);
              result.skipped.push({ agentId: agent.id, agentName: agent.name, reason: `Backup model ${backup.model}: ${got.issue}` });
            }
          }
          if (changed) {
            await db.update(agents).set({ laneABackupModels: next }).where(and(eq(agents.companyId, companyId), eq(agents.id, agent.id)));
          }
        }
      }
      return result;
    },
  };
}
