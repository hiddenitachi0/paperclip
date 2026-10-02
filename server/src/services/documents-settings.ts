import type { Db } from "@paperclipai/db";
import { DOCUMENTS_PLUGIN_KEY, DOCUMENTS_SETTINGS_KEY } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { pluginRegistryService } from "./plugin-registry.js";

/**
 * DUR-4302: the required "ships default off" flag for reading documents
 * through a company's `paperless_ngx` connection, piggybacked on a
 * `plugin_company_settings` row exactly like DUR-4127's video-storylines
 * flag (video-storyline-settings.ts) -- no row, or a row without
 * `settingsJson.documentsEnabled`, means off.
 *
 * UNLIKE media-studio, no "documents" plugin package is installed in this
 * fork yet, so `getPluginId()` throws `notFound` until one is: that is its
 * own follow-up (building and installing a plugin package is a materially
 * different, separately-reviewable task from this slice's schema/registry/
 * outbound-policy/flag plumbing). Until that follow-up ships, a company's
 * `paperless_ngx` connection can still be created and Test'ed (DUR-4302), but
 * `isEnabled`/`assertEnabled` have nothing to read and correctly report "off".
 */
export function documentsSettingsService(db: Db) {
  const registry = pluginRegistryService(db);

  async function getPluginId(): Promise<string | null> {
    const plugin = await registry.getByKey(DOCUMENTS_PLUGIN_KEY);
    return plugin?.id ?? null;
  }

  async function isEnabled(companyId: string): Promise<boolean> {
    const pluginId = await getPluginId();
    if (!pluginId) return false;
    const settings = await registry.getCompanySettings(pluginId, companyId);
    const flag = settings?.settingsJson?.[DOCUMENTS_SETTINGS_KEY];
    return flag === true;
  }

  async function setEnabled(companyId: string, enabled: boolean): Promise<boolean> {
    const pluginId = await getPluginId();
    if (!pluginId) throw notFound("The documents plugin is not installed.");
    const existing = await registry.getCompanySettings(pluginId, companyId);
    await registry.upsertCompanySettings(pluginId, companyId, {
      settingsJson: { ...(existing?.settingsJson ?? {}), [DOCUMENTS_SETTINGS_KEY]: enabled },
    });
    return enabled;
  }

  async function assertEnabled(companyId: string): Promise<void> {
    if (!(await isEnabled(companyId))) {
      throw unprocessable(
        "Documents are switched off for this company. An owner or admin can turn them on under Data sources settings.",
      );
    }
  }

  return { isEnabled, setEnabled, assertEnabled };
}
