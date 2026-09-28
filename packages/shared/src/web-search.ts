/**
 * Web search for quick agents: the few names the server, the routes and the
 * screens share.
 *
 * Where things live (no migration):
 *   - The company's Brave Search key is an ordinary company secret. The
 *     operator's pick is a company_secret_bindings row: target_type
 *     WEB_SEARCH_BINDING_TARGET_TYPE, target_id = the company id, config_path
 *     WEB_SEARCH_KEY_CONFIG_PATH. Set under Company settings → Connections →
 *     Web search; every read of the key lands in secret_access_events.
 *   - "Can search the web" is per quick agent, at adapterConfig.laneA.webSearch
 *     (off when absent), next to the quick agent's own model key.
 *   - Searches are counted per agent per UTC day in agent_daily_counters
 *     (kind WEB_SEARCH_COUNTER_KIND) and capped per company per day.
 */

export const WEB_SEARCH_BINDING_TARGET_TYPE = "web_search" as const;
export const WEB_SEARCH_KEY_CONFIG_PATH = "braveSearch.apiKey";
/** Searches one company's quick agents may make per UTC day, all together. */
export const WEB_SEARCH_DEFAULT_DAILY_CAP = 100;
export const WEB_SEARCH_COUNTER_KIND = "web_search" as const;
/** Brave's published price and free monthly credit, for the help text. */
export const WEB_SEARCH_PRICE_TEXT = "$5 per 1,000 searches";
export const WEB_SEARCH_FREE_CREDIT_TEXT = "$5 of free credit every month (about 1,000 searches)";

/** What the Connections → Web search card shows. Never the key itself. */
export interface CompanyWebSearchSettings {
  /** The company secret picked as the Brave key, or null when none is picked. */
  keySecretId: string | null;
  keySecretName: string | null;
  /** The picked secret's kind tag (null for an untagged secret). */
  keySecretKind: string | null;
  /**
   * "none": nothing picked. "ok": picked and active. "unusable": picked, but
   * the secret was deleted or switched off, so searches are refused.
   */
  keyStatus: "none" | "ok" | "unusable";
  dailyCap: number;
  /** Searches the company's quick agents made today (UTC). */
  usedToday: number;
}

/** adapterConfig.laneA.webSearch, read defensively: anything but `true` is off. */
export function readLaneAWebSearchSwitch(adapterConfig: unknown): boolean {
  if (typeof adapterConfig !== "object" || adapterConfig === null) return false;
  const laneA = (adapterConfig as { laneA?: unknown }).laneA;
  if (typeof laneA !== "object" || laneA === null) return false;
  return (laneA as { webSearch?: unknown }).webSearch === true;
}
