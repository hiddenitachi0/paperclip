import type { Db } from "@paperclipai/db";
import { agents, companies, heartbeatRuns, instanceSettings } from "@paperclipai/db";
import {
  DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  DEFAULT_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS,
  DEFAULT_GLOBAL_MAX_CONCURRENT_RUNS,
  DEFAULT_MAX_RUN_DURATION_MINUTES,
  DEFAULT_SILENT_RUN_TIMEOUT_MINUTES,
  DEFAULT_MAX_TURNS_PER_RUN,
  DEFAULT_SESSION_RESET_AFTER_RUNS,
  DEFAULT_SESSION_RESET_AFTER_HOURS,
  DEFAULT_QUIET_MODE_STATE,
  DEFAULT_DONE_GATE_SETTINGS,
  instanceGeneralSettingsSchema,
  type InstanceGeneralSettings,
  instanceExperimentalSettingsSchema,
  type InstanceExperimentalSettings,
  type PatchInstanceGeneralSettings,
  type InstanceSettings,
  type PatchInstanceSettings,
  type PatchInstanceExperimentalSettings,
  type QuietModeActor,
  type QuietModeAgentSnapshotEntry,
  type QuietModeState,
  type DoneGateMode,
  type DoneGateSettings,
} from "@paperclipai/shared";
import { eq, inArray, count } from "drizzle-orm";
import { parseObject, asBoolean } from "@paperclipai/adapter-utils/server-utils";

const ACTIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running"] as const;

function heartbeatFlagsFromRuntimeConfig(runtimeConfig: Record<string, unknown>) {
  const heartbeat = parseObject(runtimeConfig.heartbeat);
  return {
    enabled: asBoolean(heartbeat.enabled, false),
    wakeOnDemand: asBoolean(
      heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation,
      true,
    ),
  };
}

export interface MaxTurnsPerRunAgentOverride {
  agentId: string;
  agentName: string;
  companyId: string;
  adapterType: string;
  maxTurnsPerRun: number;
}

/**
 * DUR-3943 item 4: the per-agent turn cap, when the agent has one. Only a
 * finite number above 0 counts as an override; blank/0/junk means "use the
 * instance setting". Shared with the heartbeat's resolveMaxTurnsPerRun so
 * both sides agree on what an override is.
 */
export function readMaxTurnsPerRunOverride(adapterConfig: Record<string, unknown>): number | null {
  const raw = adapterConfig.maxTurnsPerRun;
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

const DEFAULT_SINGLETON_KEY = "default";
const instanceGeneralSettingsStorageSchema = instanceGeneralSettingsSchema.strip();
const instanceExperimentalSettingsStorageSchema = instanceExperimentalSettingsSchema.strip();

function normalizeGeneralSettings(raw: unknown): InstanceGeneralSettings {
  const parsed = instanceGeneralSettingsStorageSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      censorUsernameInLogs: parsed.data.censorUsernameInLogs ?? false,
      keyboardShortcuts: parsed.data.keyboardShortcuts ?? false,
      feedbackDataSharingPreference:
        parsed.data.feedbackDataSharingPreference ?? DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
      backupRetention: parsed.data.backupRetention ?? DEFAULT_BACKUP_RETENTION,
      // Absent => unrestricted; only carry through an explicit policy.
      ...(parsed.data.executionMode ? { executionMode: parsed.data.executionMode } : {}),
      instructionsStalenessThresholdDays:
        parsed.data.instructionsStalenessThresholdDays ?? DEFAULT_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS,
      globalMaxConcurrentRuns:
        parsed.data.globalMaxConcurrentRuns ?? DEFAULT_GLOBAL_MAX_CONCURRENT_RUNS,
      maxRunDurationMinutes: parsed.data.maxRunDurationMinutes ?? DEFAULT_MAX_RUN_DURATION_MINUTES,
      silentRunTimeoutMinutes: parsed.data.silentRunTimeoutMinutes ?? DEFAULT_SILENT_RUN_TIMEOUT_MINUTES,
      maxTurnsPerRun: parsed.data.maxTurnsPerRun ?? DEFAULT_MAX_TURNS_PER_RUN,
      sessionResetAfterRuns: parsed.data.sessionResetAfterRuns ?? DEFAULT_SESSION_RESET_AFTER_RUNS,
      sessionResetAfterHours: parsed.data.sessionResetAfterHours ?? DEFAULT_SESSION_RESET_AFTER_HOURS,
      quietMode: parsed.data.quietMode ?? DEFAULT_QUIET_MODE_STATE,
      mergePrAutomationEnabled: parsed.data.mergePrAutomationEnabled ?? false,
      factCheckCardStrictAllowlist: parsed.data.factCheckCardStrictAllowlist ?? false,
      doneGate: parsed.data.doneGate
        ? {
            mode: parsed.data.doneGate.mode as DoneGateMode,
            maxRounds: parsed.data.doneGate.maxRounds,
            companyOverrides: (parsed.data.doneGate.companyOverrides ?? {}) as DoneGateSettings["companyOverrides"],
          }
        : DEFAULT_DONE_GATE_SETTINGS,
    };
  }
  return {
    censorUsernameInLogs: false,
    keyboardShortcuts: false,
    feedbackDataSharingPreference: DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
    backupRetention: DEFAULT_BACKUP_RETENTION,
    instructionsStalenessThresholdDays: DEFAULT_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS,
    globalMaxConcurrentRuns: DEFAULT_GLOBAL_MAX_CONCURRENT_RUNS,
    maxRunDurationMinutes: DEFAULT_MAX_RUN_DURATION_MINUTES,
    silentRunTimeoutMinutes: DEFAULT_SILENT_RUN_TIMEOUT_MINUTES,
    maxTurnsPerRun: DEFAULT_MAX_TURNS_PER_RUN,
    sessionResetAfterRuns: DEFAULT_SESSION_RESET_AFTER_RUNS,
    sessionResetAfterHours: DEFAULT_SESSION_RESET_AFTER_HOURS,
    quietMode: DEFAULT_QUIET_MODE_STATE,
    mergePrAutomationEnabled: false,
    factCheckCardStrictAllowlist: false,
    doneGate: DEFAULT_DONE_GATE_SETTINGS,
  };
}

export function normalizeExperimentalSettings(raw: unknown): InstanceExperimentalSettings {
  const parsed = instanceExperimentalSettingsStorageSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      enableEnvironments: parsed.data.enableEnvironments ?? false,
      enableIsolatedWorkspaces: parsed.data.enableIsolatedWorkspaces ?? false,
      enableStreamlinedLeftNavigation: parsed.data.enableStreamlinedLeftNavigation ?? true,
      enablePipelines: parsed.data.enablePipelines ?? false,
      enableConferenceRoomChat: parsed.data.enableConferenceRoomChat ?? false,
      enableIssuePlanDecompositions: parsed.data.enableIssuePlanDecompositions ?? false,
      enableExperimentalFileViewer: parsed.data.enableExperimentalFileViewer ?? false,
      enableTaskWatchdogs: parsed.data.enableTaskWatchdogs ?? false,
      enableCloudSync: parsed.data.enableCloudSync ?? false,
      enableExternalObjects: parsed.data.enableExternalObjects ?? false,
      enableServerInfoDebugView: parsed.data.enableServerInfoDebugView ?? false,
      autoRestartDevServerWhenIdle: parsed.data.autoRestartDevServerWhenIdle ?? false,
      enableIssueGraphLivenessAutoRecovery: parsed.data.enableIssueGraphLivenessAutoRecovery ?? false,
      issueGraphLivenessAutoRecoveryLookbackHours:
        parsed.data.issueGraphLivenessAutoRecoveryLookbackHours ??
        DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
      enableWeeklyCheckup: parsed.data.enableWeeklyCheckup ?? false,
    };
  }
  return {
    enableEnvironments: false,
    enableIsolatedWorkspaces: false,
    enableStreamlinedLeftNavigation: true,
    enablePipelines: false,
    enableConferenceRoomChat: false,
    enableTaskWatchdogs: false,
    enableIssuePlanDecompositions: false,
    enableExperimentalFileViewer: false,
    enableCloudSync: false,
    enableExternalObjects: false,
    enableServerInfoDebugView: false,
    autoRestartDevServerWhenIdle: false,
    enableIssueGraphLivenessAutoRecovery: false,
    issueGraphLivenessAutoRecoveryLookbackHours:
      DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
    enableWeeklyCheckup: false,
  };
}

function toInstanceSettings(row: typeof instanceSettings.$inferSelect): InstanceSettings {
  return {
    id: row.id,
    defaultEnvironmentId: row.defaultEnvironmentId ?? null,
    general: normalizeGeneralSettings(row.general),
    experimental: normalizeExperimentalSettings(row.experimental),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as InstanceSettings;
}

export function instanceSettingsService(db: Db) {
  async function getOrCreateRow() {
    const existing = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const now = new Date();
    const [created] = await db
      .insert(instanceSettings)
      .values({
        singletonKey: DEFAULT_SINGLETON_KEY,
        general: {},
        experimental: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: {
          updatedAt: now,
        },
      })
      .returning();

    if (created) return created;

    const raced = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (raced) return raced;

    throw new Error("Failed to initialize instance settings row");
  }

  return {
    get: async (): Promise<InstanceSettings> => toInstanceSettings(await getOrCreateRow()),

    update: async (patch: PatchInstanceSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          ...(Object.prototype.hasOwnProperty.call(patch, "defaultEnvironmentId")
            ? { defaultEnvironmentId: patch.defaultEnvironmentId ?? null }
            : {}),
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    getGeneral: async (): Promise<InstanceGeneralSettings> => {
      const row = await getOrCreateRow();
      return normalizeGeneralSettings(row.general);
    },

    getExperimental: async (): Promise<InstanceExperimentalSettings> => {
      const row = await getOrCreateRow();
      return normalizeExperimentalSettings(row.experimental);
    },

    updateGeneral: async (patch: PatchInstanceGeneralSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextGeneral = normalizeGeneralSettings({
        ...normalizeGeneralSettings(current.general),
        ...patch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          general: { ...nextGeneral },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    updateExperimental: async (patch: PatchInstanceExperimentalSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextExperimental = normalizeExperimentalSettings({
        ...normalizeExperimentalSettings(current.experimental),
        ...patch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          experimental: { ...nextExperimental },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    listCompanyIds: async (): Promise<string[]> =>
      db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id)),

    // DUR-3943 item 4: an agent whose adapterConfig carries its own
    // maxTurnsPerRun keeps that number, whatever the instance setting says.
    // Agents created before the instance setting existed all carry one (the
    // create form always wrote it), so the operator needs to see who still
    // overrides and be able to switch everyone to the instance default in
    // one go -- otherwise the new default would be a no-op on a real fleet.
    listMaxTurnsPerRunAgentOverrides: async (): Promise<MaxTurnsPerRunAgentOverride[]> => {
      const rows = await db
        .select({
          id: agents.id,
          name: agents.name,
          companyId: agents.companyId,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents);
      const overrides: MaxTurnsPerRunAgentOverride[] = [];
      for (const row of rows) {
        const value = readMaxTurnsPerRunOverride(parseObject(row.adapterConfig));
        if (value === null) continue;
        overrides.push({
          agentId: row.id,
          agentName: row.name,
          companyId: row.companyId,
          adapterType: row.adapterType,
          maxTurnsPerRun: value,
        });
      }
      return overrides.sort((a, b) => a.agentName.localeCompare(b.agentName));
    },

    clearMaxTurnsPerRunAgentOverrides: async (): Promise<{ clearedAgentIds: string[] }> => {
      const rows = await db
        .select({ id: agents.id, adapterConfig: agents.adapterConfig })
        .from(agents);
      const clearedAgentIds: string[] = [];
      for (const row of rows) {
        const adapterConfig = parseObject(row.adapterConfig);
        if (!Object.prototype.hasOwnProperty.call(adapterConfig, "maxTurnsPerRun")) continue;
        const { maxTurnsPerRun: _dropped, ...rest } = adapterConfig;
        await db
          .update(agents)
          .set({ adapterConfig: rest, updatedAt: new Date() })
          .where(eq(agents.id, row.id));
        clearedAgentIds.push(row.id);
      }
      return { clearedAgentIds };
    },

    getQuietMode: async (): Promise<QuietModeState & { activeRunCount: number }> => {
      const row = await getOrCreateRow();
      const quietMode = normalizeGeneralSettings(row.general).quietMode;
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ACTIVE_HEARTBEAT_RUN_STATUSES))
        .then((rows) => Number(rows[0]?.count ?? 0));
      return { ...quietMode, activeRunCount };
    },

    // DUR-224: freezes every agent (both timer and on-demand wakes) across
    // every company without touching runs already in flight -- deliberately
    // NOT the same as Pause, which cancels active runs. Snapshots each
    // agent's exact prior flags first so deactivateQuietMode can restore
    // them precisely instead of blanket re-enabling agents that were
    // deliberately asleep beforehand.
    activateQuietMode: async (actor: QuietModeActor): Promise<QuietModeState> => {
      const current = await getOrCreateRow();
      const existing = normalizeGeneralSettings(current.general).quietMode;
      if (existing.active) return existing;

      const allAgents = await db
        .select({ id: agents.id, companyId: agents.companyId, runtimeConfig: agents.runtimeConfig })
        .from(agents);

      const snapshot: QuietModeAgentSnapshotEntry[] = [];
      for (const row of allAgents) {
        const runtimeConfig = parseObject(row.runtimeConfig);
        const flags = heartbeatFlagsFromRuntimeConfig(runtimeConfig);
        snapshot.push({ agentId: row.id, companyId: row.companyId, ...flags });
        if (!flags.enabled && !flags.wakeOnDemand) continue;
        const heartbeat = parseObject(runtimeConfig.heartbeat);
        await db
          .update(agents)
          .set({
            runtimeConfig: { ...runtimeConfig, heartbeat: { ...heartbeat, enabled: false, wakeOnDemand: false } },
            updatedAt: new Date(),
          })
          .where(eq(agents.id, row.id));
      }

      const nextQuietMode: QuietModeState = {
        active: true,
        activatedAt: new Date().toISOString(),
        activatedBy: actor,
        deactivatedAt: null,
        snapshot,
      };
      const nextGeneral = { ...normalizeGeneralSettings(current.general), quietMode: nextQuietMode };
      await db
        .update(instanceSettings)
        .set({ general: { ...nextGeneral }, updatedAt: new Date() })
        .where(eq(instanceSettings.id, current.id));
      return nextQuietMode;
    },

    deactivateQuietMode: async (_actor: QuietModeActor): Promise<QuietModeState> => {
      const current = await getOrCreateRow();
      const quietMode = normalizeGeneralSettings(current.general).quietMode;
      if (!quietMode.active) return quietMode;

      for (const entry of quietMode.snapshot ?? []) {
        const [row] = await db
          .select({ runtimeConfig: agents.runtimeConfig })
          .from(agents)
          .where(eq(agents.id, entry.agentId));
        if (!row) continue; // agent deleted since the snapshot was taken
        const runtimeConfig = parseObject(row.runtimeConfig);
        const heartbeat = parseObject(runtimeConfig.heartbeat);
        await db
          .update(agents)
          .set({
            runtimeConfig: {
              ...runtimeConfig,
              heartbeat: { ...heartbeat, enabled: entry.enabled, wakeOnDemand: entry.wakeOnDemand },
            },
            updatedAt: new Date(),
          })
          .where(eq(agents.id, entry.agentId));
      }

      const nextQuietMode: QuietModeState = {
        active: false,
        activatedAt: quietMode.activatedAt,
        activatedBy: quietMode.activatedBy,
        deactivatedAt: new Date().toISOString(),
        snapshot: null,
      };
      const nextGeneral = { ...normalizeGeneralSettings(current.general), quietMode: nextQuietMode };
      await db
        .update(instanceSettings)
        .set({ general: { ...nextGeneral }, updatedAt: new Date() })
        .where(eq(instanceSettings.id, current.id));
      return nextQuietMode;
    },
  };
}
