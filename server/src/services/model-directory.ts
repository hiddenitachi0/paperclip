import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, modelDirectoryEntries, modelDirectorySettings, withCompanyScope } from "@paperclipai/db";
import {
  LANE_A_BACKUP_MODELS_MAX,
  LANE_A_PROVIDER_CATALOGUE,
  MODEL_DIRECTORY_EXPORT_VERSION,
  MODEL_DIRECTORY_NAME_MAX_LENGTH,
  MODEL_DIRECTORY_NEEDS_LOCAL_ADDRESS_MESSAGE,
  MODEL_DIRECTORY_STARTERS,
  modelDirectoryEntryIssue,
  normalizeLaneAProvider,
  cleanOpenRouterHostList,
  openRouterHostChoicesFromRouting,
  resolveOpenRouterHostRouting,
  type ImportModelDirectoryCatalogue,
  type LaneABackupModelConfig,
  type ModelDirectoryCatalogueEntry,
  type ModelDirectoryCatalogueExport,
  type ModelDirectoryCatalogueImportResult,
  type ModelDirectoryImportResult,
  type ModelDirectorySpecs,
  type ModelDirectoryStarterStatus,
  type CreateModelDirectoryEntry,
  type ModelDirectoryEntry,
  type ModelDirectoryRating,
  type ModelDirectorySettings,
  type ModelDirectoryStartersResult,
  type UpdateModelDirectorySettings,
  type LocalInstalledModel,
  type LocalModelsSyncResult,
  type UpdateModelDirectoryEntry,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

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
    maker: row.maker ?? null,
    baseModel: row.baseModel ?? null,
    lane: (row.lane as ModelDirectoryEntry["lane"]) ?? null,
    availability: (row.availability as ModelDirectoryEntry["availability"]) ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    specs: (row.specs as ModelDirectorySpecs | null) ?? null,
    favorite: row.favorite === true,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    family: row.family ?? null,
    variant: row.variant ?? null,
    ratings: ratingsOf(row.ratings),
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Stored ratings, defensively: anything that is not a rating object is dropped. */
function ratingsOf(value: unknown): ModelDirectoryRating[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is ModelDirectoryRating =>
      !!r && typeof r === "object" && typeof (r as { criterion?: unknown }).criterion === "string" && typeof (r as { score?: unknown }).score === "number",
  );
}

/** Ratings as saved: each one stamped with when it was set, unless the caller gave a time. */
function stampRatings(ratings: readonly ModelDirectoryRating[], now: Date = new Date()): ModelDirectoryRating[] {
  return ratings.map((r) => ({ ...r, updatedAt: r.updatedAt ?? now.toISOString() }));
}

/** A blank maker / base model is "not said" (null), so it groups and sorts with the other unsaid ones. */
function label(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function compareText(a: string | null, b: string | null): number {
  const x = a?.trim() || null;
  const y = b?.trim() || null;
  if (x === y) return 0;
  if (x === null) return 1; // nulls last
  if (y === null) return -1;
  // Case-insensitive, and "8B" before "14B".
  return x.localeCompare(y, "en", { sensitivity: "base", numeric: true });
}

/**
 * Catalogue order: favourites first, then maker, base model and name (each
 * case-insensitive, blanks last). Done here rather than in SQL so the order
 * does not depend on the database's collation.
 */
export function compareModelDirectoryRows(
  a: Pick<Row, "favorite" | "maker" | "baseModel" | "name" | "id">,
  b: Pick<Row, "favorite" | "maker" | "baseModel" | "name" | "id">,
): number {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
  return (
    compareText(a.maker, b.maker) ||
    compareText(a.baseModel, b.baseModel) ||
    compareText(a.name, b.name) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Exact name first (the unique index is on the exact name), else a case-insensitive match. */
function findByName<T extends { name: string }>(rows: readonly T[], name: string): T | undefined {
  const exact = rows.find((r) => r.name === name);
  if (exact) return exact;
  const lower = name.trim().toLowerCase();
  return rows.find((r) => r.name.trim().toLowerCase() === lower);
}

/** Catalogue (export/import) fields that map 1:1 onto columns. */
function catalogueColumns(entry: ModelDirectoryCatalogueEntry): Partial<typeof modelDirectoryEntries.$inferInsert> {
  const set: Partial<typeof modelDirectoryEntries.$inferInsert> = {
    provider: entry.provider,
    model: entry.model,
  };
  if (entry.baseUrl !== undefined) set.baseUrl = entry.baseUrl;
  if (entry.providerRouting !== undefined) set.providerRouting = entry.providerRouting;
  if (entry.defaultThinking !== undefined) set.defaultThinking = entry.defaultThinking;
  if (entry.defaultTemperature !== undefined) set.defaultTemperature = entry.defaultTemperature;
  if (entry.defaultMaxOutputTokens !== undefined) set.defaultMaxOutputTokens = entry.defaultMaxOutputTokens;
  if (entry.note !== undefined) set.note = entry.note;
  if (entry.maker !== undefined) set.maker = label(entry.maker);
  if (entry.baseModel !== undefined) set.baseModel = label(entry.baseModel);
  if (entry.lane !== undefined) set.lane = entry.lane;
  if (entry.availability !== undefined) set.availability = entry.availability;
  if (entry.tags !== undefined) set.tags = entry.tags;
  if (entry.specs !== undefined) set.specs = entry.specs;
  if (entry.favorite !== undefined) set.favorite = entry.favorite;
  if (entry.family !== undefined) set.family = label(entry.family);
  if (entry.variant !== undefined) set.variant = label(entry.variant);
  if (entry.ratings !== undefined) set.ratings = stampRatings(entry.ratings);
  return set;
}

/** One row as it appears in an exported catalogue file: no ids, company, people or timestamps. */
function toCatalogueEntry(row: Row, nameById: ReadonlyMap<string, string>): ModelDirectoryCatalogueEntry {
  const backupIds = Array.isArray(row.backupEntryIds) ? row.backupEntryIds : [];
  return {
    name: row.name,
    provider: row.provider as ModelDirectoryEntry["provider"],
    model: row.model,
    baseUrl: row.baseUrl,
    providerRouting: (row.providerRouting as ModelDirectoryEntry["providerRouting"]) ?? null,
    defaultThinking: (row.defaultThinking as ModelDirectoryEntry["defaultThinking"]) ?? null,
    defaultTemperature: row.defaultTemperature,
    defaultMaxOutputTokens: row.defaultMaxOutputTokens,
    note: row.note,
    maker: row.maker ?? null,
    baseModel: row.baseModel ?? null,
    lane: (row.lane as ModelDirectoryEntry["lane"]) ?? null,
    availability: (row.availability as ModelDirectoryEntry["availability"]) ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    specs: (row.specs as ModelDirectorySpecs | null) ?? null,
    favorite: row.favorite === true,
    family: row.family ?? null,
    variant: row.variant ?? null,
    ratings: ratingsOf(row.ratings),
    // A dangling id (entry deleted outside the service) is left out, as on read.
    backupNames: backupIds.map((id) => nameById.get(id)).filter((n): n is string => typeof n === "string"),
    archived: row.archivedAt != null,
  };
}

/** What importCatalogue did: the API result plus the touched rows, for the activity log. */
export interface ModelDirectoryCatalogueImportOutcome {
  result: ModelDirectoryCatalogueImportResult;
  createdEntries: ModelDirectoryEntry[];
  updatedEntries: ModelDirectoryEntry[];
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

/** How long the local resync waits for Ollama's model list. */
export const LOCAL_MODELS_SYNC_TIMEOUT_MS = 10_000;

/**
 * One key for a local model address, however it was typed: case, trailing
 * slashes and the OpenAI-compatible "/v1" suffix do not matter. Ollama's own
 * API (/api/tags) lives at this root.
 */
type SettingsRow = typeof modelDirectorySettings.$inferSelect;

function toSettings(row: SettingsRow | undefined): ModelDirectorySettings {
  return {
    localGpuVramGb: row?.localGpuVramGb ?? null,
    localBaseUrl: row?.localBaseUrl ?? null,
    openrouterPreferredHosts: cleanOpenRouterHostList(row?.openrouterPreferredHosts ?? []),
    openrouterBlockedHosts: cleanOpenRouterHostList(row?.openrouterBlockedHosts ?? []),
  };
}

/**
 * A new OpenRouter setup gets the company's blocked hosts in its "never"
 * list, except hosts the setup itself lists under "use" (an explicit
 * exception). The preferred list needs the live host list (tool support per
 * model), so the Saved model dialog applies it; this only does what can be
 * done without asking OpenRouter. See packages/shared/src/openrouter-hosts.ts.
 */
export function withCompanyBlockedHosts(
  provider: string,
  routing: CreateModelDirectoryEntry["providerRouting"] | null | undefined,
  blocked: readonly string[],
): CreateModelDirectoryEntry["providerRouting"] | null {
  const current = routing ?? null;
  if (normalizeLaneAProvider(provider) !== "openrouter" || blocked.length === 0) return current;
  const choices = openRouterHostChoicesFromRouting(current);
  return resolveOpenRouterHostRouting({ choices, rules: { preferred: [], blocked }, base: current });
}

/** The one plain message for any failed local resync (unreachable, error status, not Ollama). */
export function localSyncFailedMessage(address: string): string {
  return `Could not read the installed models from ${address}. Check that the computer is on and the model server is running.`;
}

export function localAddressKey(baseUrl: string | null | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "").toLowerCase();
}

/** Ollama lists "name:tag"; a bare name means ":latest". */
function ollamaTagKey(tag: string): string {
  const t = tag.trim().toLowerCase();
  return t.includes(":") ? t : `${t}:latest`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Parses Ollama's GET /api/tags body; null when it does not look like Ollama. */
export function parseOllamaTags(body: unknown): Array<Omit<LocalInstalledModel, "entryIds">> | null {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  const out: Array<Omit<LocalInstalledModel, "entryIds">> = [];
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as { name?: unknown; model?: unknown; size?: unknown; details?: Record<string, unknown> | null };
    const name = stringOrNull(m.name) ?? stringOrNull(m.model);
    if (!name) continue;
    const details = m.details && typeof m.details === "object" ? m.details : {};
    out.push({
      name,
      sizeGb: typeof m.size === "number" && Number.isFinite(m.size) && m.size >= 0 ? Math.round((m.size / 1e9) * 10) / 10 : null,
      parameterSize: stringOrNull(details.parameter_size),
      quantization: stringOrNull(details.quantization_level),
      family: stringOrNull(details.family),
    });
  }
  return out;
}

export interface ModelDirectoryServiceDeps {
  /** Used for the local resync (GET /api/tags); tests pass a stub. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function modelDirectoryService(db: Db, deps: ModelDirectoryServiceDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const nowOf = () => deps.now?.() ?? new Date();

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
    /** Settings > Models settings for this company (defaults when never saved). */
    async getSettings(companyId: string): Promise<ModelDirectorySettings> {
      const [row] = await db.select().from(modelDirectorySettings).where(eq(modelDirectorySettings.companyId, companyId));
      return toSettings(row);
    },

    /** Saves only the fields sent; a field left out keeps its value, null clears it. */
    async updateSettings(companyId: string, input: UpdateModelDirectorySettings, actor: { userId: string | null }): Promise<ModelDirectorySettings> {
      const now = nowOf();
      const changed: {
        localGpuVramGb?: number | null;
        localBaseUrl?: string | null;
        openrouterPreferredHosts?: string[];
        openrouterBlockedHosts?: string[];
      } = {};
      if (input.localGpuVramGb !== undefined) changed.localGpuVramGb = input.localGpuVramGb;
      if (input.localBaseUrl !== undefined) changed.localBaseUrl = input.localBaseUrl?.trim() ? input.localBaseUrl.trim() : null;
      if (input.openrouterPreferredHosts !== undefined || input.openrouterBlockedHosts !== undefined) {
        // A host cannot be both preferred and blocked, also when only one list is sent.
        const saved = await this.getSettings(companyId);
        const preferred = input.openrouterPreferredHosts ?? saved.openrouterPreferredHosts;
        const blocked = input.openrouterBlockedHosts ?? saved.openrouterBlockedHosts;
        const both = blocked.filter((host) => preferred.includes(host));
        if (both.length > 0) {
          throw unprocessable(`${both.join(", ")} cannot be both preferred and blocked. Take it off one of the lists.`);
        }
        if (input.openrouterPreferredHosts !== undefined) changed.openrouterPreferredHosts = preferred;
        if (input.openrouterBlockedHosts !== undefined) changed.openrouterBlockedHosts = blocked;
      }
      const values = { ...changed, updatedByUserId: actor.userId, updatedAt: now };
      const [row] = await db
        .insert(modelDirectorySettings)
        .values({ companyId, ...values })
        .onConflictDoUpdate({ target: modelDirectorySettings.companyId, set: values })
        .returning();
      return toSettings(row);
    },

    /**
     * Asks a local Ollama which models it has and marks this company's local
     * entries at that address: "installed" when their tag is there, back to
     * "planned" when they were "installed" and the tag is gone. "downloading"
     * is left alone until the tag shows up. The address must already be one
     * this company uses (its model server address setting, a saved local
     * entry or a quick agent on a local model), so the server never calls a
     * host on someone's say-so. Redirects are not followed, and every failure
     * gives the same plain message (details only in the server log).
     */
    async syncLocalModels(companyId: string, rawBaseUrl: string): Promise<LocalModelsSyncResult> {
      const key = localAddressKey(rawBaseUrl);
      const entries = (
        await db.select().from(modelDirectoryEntries).where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.provider, "local")))
      ).filter((e) => e.baseUrl && localAddressKey(e.baseUrl) === key);
      let known = entries.length > 0 ? entries[0]!.baseUrl! : null;
      if (!known) {
        const [settingsRow] = await db.select().from(modelDirectorySettings).where(eq(modelDirectorySettings.companyId, companyId));
        const setting = settingsRow?.localBaseUrl ?? null;
        if (setting && localAddressKey(setting) === key) known = setting;
      }
      if (!known) {
        const agentRows = await db
          .select({ baseUrl: agents.laneABaseUrl })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), eq(agents.laneAProvider, "local")));
        known = agentRows.find((a) => a.baseUrl && localAddressKey(a.baseUrl) === key)?.baseUrl ?? null;
      }
      if (!key || !known) {
        throw unprocessable(
          "That address is not one this company uses for local models. Set it as the model server address in Settings > Models (or save a local model with it) first, then try again.",
        );
      }
      // Built from the stored address, not the request, so only a known host is called.
      const root = known.trim().replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "");
      // One plain message for every failure; the detail goes to the server log only.
      const unreadable = (detail: string) => {
        logger.warn({ companyId, baseUrl: known, detail }, "model directory local sync failed");
        return unprocessable(localSyncFailedMessage(known!));
      };
      let res: Response;
      try {
        res = await fetchImpl(`${root}/api/tags`, {
          signal: AbortSignal.timeout(LOCAL_MODELS_SYNC_TIMEOUT_MS),
          // A saved address that redirects elsewhere is not followed.
          redirect: "error",
        });
      } catch (error) {
        throw unreadable(error instanceof Error ? error.message : "request failed");
      }
      if (!res.ok) throw unreadable(`HTTP ${res.status}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const listed = parseOllamaTags(body);
      if (!listed) throw unreadable("answer is not an Ollama model list");

      const present = new Set(listed.map((m) => ollamaTagKey(m.name)));
      const now = nowOf();
      const markedInstalledEntryIds: string[] = [];
      const missingEntryIds: string[] = [];
      for (const entry of entries) {
        const has = present.has(ollamaTagKey(entry.model));
        let next: string | null = null;
        if (has && entry.availability !== "installed") next = "installed";
        if (!has && entry.availability === "installed") next = "planned";
        if (!has && entry.availability === "installed") missingEntryIds.push(entry.id);
        if (next === "installed") markedInstalledEntryIds.push(entry.id);
        if (next) {
          await db
            .update(modelDirectoryEntries)
            .set({ availability: next, updatedAt: now })
            .where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.id, entry.id)));
        }
      }
      const installed: LocalInstalledModel[] = listed.map((m) => ({
        ...m,
        entryIds: entries.filter((e) => ollamaTagKey(e.model) === ollamaTagKey(m.name)).map((e) => e.id),
      }));
      return { baseUrl: known, checkedAt: now.toISOString(), installed, missingEntryIds, markedInstalledEntryIds };
    },

    /**
     * The company's setups in catalogue order (see compareModelDirectoryRows).
     * Archived entries are left out unless asked for: they are hidden from
     * agent pickers but still listed in Settings > Models on request.
     */
    async list(companyId: string, opts: { includeArchived?: boolean } = {}): Promise<ModelDirectoryEntry[]> {
      const rows = await db
        .select()
        .from(modelDirectoryEntries)
        .where(
          opts.includeArchived
            ? eq(modelDirectoryEntries.companyId, companyId)
            : and(eq(modelDirectoryEntries.companyId, companyId), isNull(modelDirectoryEntries.archivedAt)),
        );
      return rows.sort(compareModelDirectoryRows).map(toModelDirectoryEntry);
    },

    async get(companyId: string, id: string): Promise<ModelDirectoryEntry> {
      return toModelDirectoryEntry(await getRow(companyId, id));
    },

    async create(companyId: string, input: CreateModelDirectoryEntry, actor: { userId: string | null }) {
      await assertNameFree(companyId, input.name);
      await assertBackupsBelongToCompany(companyId, input.backupEntryIds ?? []);
      const blocked = (await this.getSettings(companyId)).openrouterBlockedHosts;
      input = { ...input, providerRouting: withCompanyBlockedHosts(input.provider, input.providerRouting, blocked) };
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
        maker: label(input.maker) ?? null,
        baseModel: label(input.baseModel) ?? null,
        lane: input.lane ?? null,
        availability: input.availability ?? null,
        tags: input.tags ?? [],
        specs: input.specs ?? null,
        favorite: input.favorite ?? false,
        family: label(input.family) ?? null,
        variant: label(input.variant) ?? null,
        ratings: stampRatings(input.ratings ?? [], nowOf()),
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
      if (patch.maker !== undefined) set.maker = label(patch.maker);
      if (patch.baseModel !== undefined) set.baseModel = label(patch.baseModel);
      if (patch.lane !== undefined) set.lane = patch.lane;
      if (patch.availability !== undefined) set.availability = patch.availability;
      if (patch.tags !== undefined) set.tags = patch.tags;
      if (patch.specs !== undefined) set.specs = patch.specs;
      if (patch.favorite !== undefined) set.favorite = patch.favorite;
      if (patch.family !== undefined) set.family = label(patch.family);
      if (patch.variant !== undefined) set.variant = label(patch.variant);
      if (patch.ratings !== undefined) set.ratings = stampRatings(patch.ratings, nowOf());
      // Archiving keeps the first archive time; un-archiving clears it.
      if (patch.archived === true) set.archivedAt = current.archivedAt ?? new Date();
      if (patch.archived === false) set.archivedAt = null;
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
        maker: source.maker,
        baseModel: source.baseModel,
        lane: source.lane,
        availability: source.availability,
        tags: Array.isArray(source.tags) ? source.tags : [],
        specs: source.specs,
        family: source.family,
        variant: source.variant,
        ratings: ratingsOf(source.ratings),
        // A copy starts as an ordinary, visible entry.
        favorite: false,
        archivedAt: null,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      });
    },

    /**
     * Every ready-made starter, flagged with whether this company already has
     * it. A local starter has no address of its own, so it counts as added
     * when the company has a local setup with the same model id at any address.
     */
    async listStarters(companyId: string): Promise<ModelDirectoryStarterStatus[]> {
      const existing = await db
        .select({ provider: modelDirectoryEntries.provider, model: modelDirectoryEntries.model, baseUrl: modelDirectoryEntries.baseUrl })
        .from(modelDirectoryEntries)
        .where(eq(modelDirectoryEntries.companyId, companyId));
      const keyOf = (provider: string, model: string, baseUrl: string | null) =>
        provider === "local" ? `local\u0000${model}` : `${provider}\u0000${model}\u0000${(baseUrl ?? "").replace(/\/+$/, "")}`;
      const have = new Set(existing.map((e) => keyOf(e.provider, e.model, e.baseUrl)));
      return MODEL_DIRECTORY_STARTERS.map((starter) => ({
        ...starter,
        alreadyAdded: have.has(keyOf(starter.provider, starter.model, starter.baseUrl)),
      }));
    },

    /**
     * Adds the chosen (default: all) starters this company lacks. Safe to
     * repeat. Local starters get the company's model server address; while it
     * is not set they are skipped with a plain reason (cloud ones are still
     * added). Asking only for local starters without an address is refused.
     */
    async addStarters(companyId: string, starterIds: readonly string[] | undefined, actor: { userId: string | null }): Promise<ModelDirectoryStartersResult> {
      const wanted = starterIds ?? MODEL_DIRECTORY_STARTERS.map((s) => s.id);
      const unknown = wanted.filter((id) => !MODEL_DIRECTORY_STARTERS.some((s) => s.id === id));
      if (unknown.length > 0) throw unprocessable("One of the ready-made model setups you picked does not exist.");
      const settings = await this.getSettings(companyId);
      const localAddress = settings.localBaseUrl;
      const status = await this.listStarters(companyId);
      const pending = status.filter((starter) => wanted.includes(starter.id) && !starter.alreadyAdded);
      if (!localAddress && pending.length > 0 && pending.every((starter) => starter.provider === "local")) {
        throw unprocessable(MODEL_DIRECTORY_NEEDS_LOCAL_ADDRESS_MESSAGE);
      }
      const created: ModelDirectoryEntry[] = [];
      const skipped: ModelDirectoryStartersResult["skipped"] = [];
      for (const starter of pending) {
        if (starter.provider === "local" && !localAddress) {
          skipped.push({ starterId: starter.id, name: starter.name, reason: MODEL_DIRECTORY_NEEDS_LOCAL_ADDRESS_MESSAGE });
          continue;
        }
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
            baseUrl: starter.provider === "local" ? localAddress : starter.baseUrl,
            providerRouting: withCompanyBlockedHosts(starter.provider, starter.providerRouting, settings.openrouterBlockedHosts),
            defaultThinking: starter.defaultThinking,
            defaultTemperature: starter.defaultTemperature,
            defaultMaxOutputTokens: starter.defaultMaxOutputTokens,
            backupEntryIds: [],
            note: starter.note,
            maker: starter.maker,
            baseModel: starter.baseModel,
            family: starter.family,
            variant: starter.variant,
            lane: starter.lane,
            availability: starter.availability,
            tags: starter.tags,
            specs: starter.specs,
            createdByUserId: actor.userId,
            updatedByUserId: actor.userId,
          }),
        );
      }
      return { created, skipped };
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
      // Every name blocks a new entry (archived ones too: the unique index
      // covers them), but an identical setup links to a visible entry before
      // an archived one.
      const names = new Set<string>();
      const visibleFirst = [...existing].sort((x, y) => Number(x.archivedAt != null) - Number(y.archivedAt != null));
      for (const e of visibleFirst) {
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

    /**
     * The whole catalogue as a plain file, archived entries included. Backups
     * are written as names (ids differ between companies). Never a key, id,
     * company, person or timestamp.
     */
    async exportCatalogue(companyId: string, now: Date = new Date()): Promise<ModelDirectoryCatalogueExport> {
      const rows = await db.select().from(modelDirectoryEntries).where(eq(modelDirectoryEntries.companyId, companyId));
      const nameById = new Map(rows.map((r) => [r.id, r.name]));
      return {
        version: MODEL_DIRECTORY_EXPORT_VERSION,
        exportedAt: now.toISOString(),
        entries: rows.sort(compareModelDirectoryRows).map((r) => toCatalogueEntry(r, nameById)),
      };
    },

    /**
     * Imports a catalogue file in ONE transaction: nothing is half-imported.
     * A setup whose name already exists (any capitalisation) is skipped, or
     * with onExisting "update" overwritten with the fields the file gives
     * (its name is kept). Backups are matched by name against the file and
     * the existing entries; an unknown name, or an entry naming itself, is
     * left out of that entry's backups and reported, but the entry is saved.
     */
    async importCatalogue(
      companyId: string,
      input: ImportModelDirectoryCatalogue,
      actor: { userId: string | null },
    ): Promise<ModelDirectoryCatalogueImportOutcome> {
      try {
        return await withCompanyScope(db, companyId, (tx) => importCatalogueWith(tx as unknown as Db, companyId, input, actor));
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("Another model setup with one of these names was saved at the same time. Try the import again.");
        throw error;
      }
    },
  };
}

async function importCatalogueWith(
  q: Db,
  companyId: string,
  input: ImportModelDirectoryCatalogue,
  actor: { userId: string | null },
): Promise<ModelDirectoryCatalogueImportOutcome> {
  const onExisting = input.onExisting ?? "skip";
  const result: ModelDirectoryCatalogueImportResult = { created: [], updated: [], skipped: [] };
  const existing = await q.select().from(modelDirectoryEntries).where(eq(modelDirectoryEntries.companyId, companyId));
  // Everything a backup name may point at: existing entries plus what this import creates.
  const known: Row[] = [...existing];
  // File entries that were saved (created or updated), for the backup pass.
  const saved: Array<{ entry: ModelDirectoryCatalogueEntry; row: Row; created: boolean }> = [];
  const now = new Date();

  for (const entry of input.entries) {
    const match = findByName(existing, entry.name);
    if (match) {
      if (onExisting === "skip") {
        result.skipped.push({ name: entry.name, reason: `Not imported: a model setup named "${match.name}" already exists.` });
        continue;
      }
      const set = catalogueColumns(entry);
      const issue = modelDirectoryEntryIssue({
        id: match.id,
        provider: set.provider,
        model: set.model,
        baseUrl: set.baseUrl === undefined ? match.baseUrl : set.baseUrl,
        providerRouting: set.providerRouting === undefined ? match.providerRouting : set.providerRouting,
      });
      if (issue) {
        result.skipped.push({ name: entry.name, reason: `Not updated: ${issue}` });
        continue;
      }
      if (entry.archived === true) set.archivedAt = match.archivedAt ?? now;
      if (entry.archived === false) set.archivedAt = null;
      const [row] = await q
        .update(modelDirectoryEntries)
        .set({ ...set, updatedAt: now, updatedByUserId: actor.userId })
        .where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.id, match.id)))
        .returning();
      known[known.indexOf(match)] = row!;
      saved.push({ entry, row: row!, created: false });
      result.updated.push(match.name);
      continue;
    }
    const [row] = await q
      .insert(modelDirectoryEntries)
      .values({
        companyId,
        name: entry.name,
        provider: entry.provider,
        model: entry.model,
        baseUrl: entry.baseUrl ?? null,
        providerRouting: entry.providerRouting ?? null,
        defaultThinking: entry.defaultThinking ?? null,
        defaultTemperature: entry.defaultTemperature ?? null,
        defaultMaxOutputTokens: entry.defaultMaxOutputTokens ?? null,
        backupEntryIds: [],
        note: entry.note ?? null,
        maker: label(entry.maker) ?? null,
        baseModel: label(entry.baseModel) ?? null,
        lane: entry.lane ?? null,
        availability: entry.availability ?? null,
        tags: entry.tags ?? [],
        specs: entry.specs ?? null,
        favorite: entry.favorite ?? false,
        family: label(entry.family) ?? null,
        variant: label(entry.variant) ?? null,
        ratings: stampRatings(entry.ratings ?? [], now),
        archivedAt: entry.archived ? now : null,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      })
      .returning();
    known.push(row!);
    saved.push({ entry, row: row!, created: true });
    result.created.push(row!.name);
  }

  // Backups second, so an entry may name one that comes later in the file.
  // An exact name wins; otherwise a case-insensitive match, the file's own
  // entries before older ones.
  const fileRows = saved.map((s) => s.row);
  const resolve = (name: string) => known.find((r) => r.name === name) ?? findByName(fileRows, name) ?? findByName(known, name);
  for (const item of saved) {
    if (item.entry.backupNames === undefined) continue; // update: leave the chain as it is
    const ids: string[] = [];
    const missing: string[] = [];
    let namedItself = false;
    for (const backupName of item.entry.backupNames) {
      const target = resolve(backupName);
      if (!target) missing.push(backupName);
      else if (target.id === item.row.id) namedItself = true;
      else if (!ids.includes(target.id)) ids.push(target.id);
    }
    const backupEntryIds = ids.slice(0, LANE_A_BACKUP_MODELS_MAX);
    const reasons: string[] = [];
    if (missing.length > 0) {
      reasons.push(
        missing.length === 1
          ? `backup "${missing[0]}" was left out because no model setup has that name`
          : `backups ${missing.map((n) => `"${n}"`).join(", ")} were left out because no model setups have those names`,
      );
    }
    if (namedItself) reasons.push("it was listed as its own backup, which was left out");
    if (reasons.length > 0) {
      result.skipped.push({ name: item.row.name, reason: `${item.created ? "Imported" : "Updated"}, but ${reasons.join(", and ")}.` });
    }
    const current = Array.isArray(item.row.backupEntryIds) ? item.row.backupEntryIds : [];
    if (item.created && backupEntryIds.length === 0) continue;
    if (!item.created && JSON.stringify(current) === JSON.stringify(backupEntryIds)) continue;
    const [row] = await q
      .update(modelDirectoryEntries)
      .set({ backupEntryIds })
      .where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.id, item.row.id)))
      .returning();
    item.row = row!;
  }

  return {
    result,
    createdEntries: saved.filter((s) => s.created).map((s) => toModelDirectoryEntry(s.row)),
    updatedEntries: saved.filter((s) => !s.created).map((s) => toModelDirectoryEntry(s.row)),
  };
}
