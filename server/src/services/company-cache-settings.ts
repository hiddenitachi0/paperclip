/**
 * DUR-4471 (cache-aware agent runs, parent DUR-4465): per-company cache
 * settings. Lazy-row pattern like company-job-settings.ts -- no row means
 * "off" with the defaults below; a row is created on the first update.
 * The scheduler and handoff code read this via get().
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyCacheSettings } from "@paperclipai/db";

export const DEFAULT_HANDOFF_TOKEN_THRESHOLD = 150_000;

export interface CompanyCacheSettings {
  companyId: string;
  enabled: boolean;
  schedulingEnabled: boolean;
  handoffEnabled: boolean;
  handoffTokenThreshold: number;
  /** null = use the provider default (5 min, or 60 min where the 1h cache applies). */
  cacheLifetimeMinutes: number | null;
}

export type CompanyCacheSettingsPatch = Partial<Omit<CompanyCacheSettings, "companyId">>;

export const HANDOFF_THRESHOLD_MIN = 10_000;
export const HANDOFF_THRESHOLD_MAX = 2_000_000;
export const CACHE_LIFETIME_MIN = 1;
export const CACHE_LIFETIME_MAX = 1440;

/** Plain-English copy so the UI does not hardcode it. */
export const CACHE_SETTING_DESCRIPTIONS: Record<keyof Omit<CompanyCacheSettings, "companyId">, { label: string; description: string }> = {
  enabled: {
    label: "Cache-aware runs",
    description:
      "Master switch. When on, Paperclip tries to avoid paying to re-read an agent's whole conversation after the AI provider's short-term memory (the prompt cache) has expired. When off, agents run exactly as before.",
  },
  schedulingEnabled: {
    label: "Wake agents while the cache is warm",
    description:
      "If an agent is mid-task and will be woken again soon anyway, wake it before its cache expires, since re-reading a warm conversation is about 10x cheaper. Agents that will be idle a long time are left alone, with no paid keep-alives.",
  },
  handoffEnabled: {
    label: "Hand off huge conversations",
    description:
      "When an agent wakes with a very large conversation and its cache has already expired, start a fresh session from a short written summary (task state, decisions, next steps) instead of re-reading everything.",
  },
  handoffTokenThreshold: {
    label: "Handoff size threshold (tokens)",
    description:
      `A conversation larger than this, with a cold cache, is handed off to a fresh session. Lower means more handoffs and cheaper restarts; higher keeps more history. Default ${DEFAULT_HANDOFF_TOKEN_THRESHOLD.toLocaleString("en-US")}.`,
  },
  cacheLifetimeMinutes: {
    label: "Cache lifetime override (minutes)",
    description:
      "How long we assume the provider keeps a conversation cached after its last use. Leave empty to use the provider default (5 minutes, or 60 where the extended cache applies).",
  },
};

export function companyCacheSettingsService(db: Db) {
  const columns = {
    companyId: companyCacheSettings.companyId,
    enabled: companyCacheSettings.enabled,
    schedulingEnabled: companyCacheSettings.schedulingEnabled,
    handoffEnabled: companyCacheSettings.handoffEnabled,
    handoffTokenThreshold: companyCacheSettings.handoffTokenThreshold,
    cacheLifetimeMinutes: companyCacheSettings.cacheLifetimeMinutes,
  };

  async function get(companyId: string): Promise<CompanyCacheSettings> {
    const [row] = await db.select(columns).from(companyCacheSettings).where(eq(companyCacheSettings.companyId, companyId));
    return (
      row ?? {
        companyId,
        enabled: false,
        schedulingEnabled: true,
        handoffEnabled: true,
        handoffTokenThreshold: DEFAULT_HANDOFF_TOKEN_THRESHOLD,
        cacheLifetimeMinutes: null,
      }
    );
  }

  async function update(companyId: string, patch: CompanyCacheSettingsPatch): Promise<CompanyCacheSettings> {
    const set = { ...patch, updatedAt: new Date() };
    const [row] = await db
      .insert(companyCacheSettings)
      .values({ companyId, ...set })
      .onConflictDoUpdate({ target: companyCacheSettings.companyId, set })
      .returning(columns);
    return row;
  }

  return { get, update };
}
