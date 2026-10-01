import type { Db } from "@paperclipai/db";
import {
  MEDIA_STUDIO_PLUGIN_KEY,
  VIDEO_STORYLINE_ADVANCED_SETTINGS_KEY,
  VIDEO_STORYLINES_SETTINGS_KEY,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { pluginRegistryService } from "./plugin-registry.js";

/**
 * DUR-4127: the required "ships default off" flag, piggybacked on the
 * media-studio plugin's existing per-company settings row
 * (plugin_company_settings) rather than a new table -- see
 * packages/db/src/schema/plugin_company_settings.ts: no row, or a row
 * without this key, means off. This is the one place that reads/writes
 * `settingsJson.videoStorylinesEnabled`/`settingsJson.videoStorylineAdvancedFeaturesEnabled`;
 * nothing else should touch those keys directly, since upsertCompanySettings
 * replaces the whole settingsJson blob, not just one key.
 *
 * DUR-4196: round 2 (director AI, still-frame preview, transitions/music)
 * ships behind a second, narrower flag, ON TOP OF (never instead of) the
 * round-1 flag -- a company that already has video storylines on keeps the
 * exact round-1 behavior until it separately opts in. See
 * VIDEO_STORYLINE_ADVANCED_SETTINGS_KEY's doc comment in packages/shared.
 */
export function videoStorylineSettingsService(db: Db) {
  const registry = pluginRegistryService(db);

  async function getPluginId(): Promise<string> {
    const plugin = await registry.getByKey(MEDIA_STUDIO_PLUGIN_KEY);
    if (!plugin) throw notFound("The media-studio plugin is not installed.");
    return plugin.id;
  }

  async function isEnabled(companyId: string): Promise<boolean> {
    const pluginId = await getPluginId();
    const settings = await registry.getCompanySettings(pluginId, companyId);
    const flag = settings?.settingsJson?.[VIDEO_STORYLINES_SETTINGS_KEY];
    return flag === true;
  }

  async function setEnabled(companyId: string, enabled: boolean): Promise<boolean> {
    const pluginId = await getPluginId();
    const existing = await registry.getCompanySettings(pluginId, companyId);
    await registry.upsertCompanySettings(pluginId, companyId, {
      settingsJson: { ...(existing?.settingsJson ?? {}), [VIDEO_STORYLINES_SETTINGS_KEY]: enabled },
    });
    return enabled;
  }

  async function assertEnabled(companyId: string): Promise<void> {
    if (!(await isEnabled(companyId))) {
      throw unprocessable(
        "Video storylines are switched off for this company. An owner or admin can turn them on under Media Studio settings.",
      );
    }
  }

  async function isAdvancedEnabled(companyId: string): Promise<boolean> {
    const pluginId = await getPluginId();
    const settings = await registry.getCompanySettings(pluginId, companyId);
    const flag = settings?.settingsJson?.[VIDEO_STORYLINE_ADVANCED_SETTINGS_KEY];
    return flag === true;
  }

  async function setAdvancedEnabled(companyId: string, enabled: boolean): Promise<boolean> {
    const pluginId = await getPluginId();
    const existing = await registry.getCompanySettings(pluginId, companyId);
    await registry.upsertCompanySettings(pluginId, companyId, {
      settingsJson: { ...(existing?.settingsJson ?? {}), [VIDEO_STORYLINE_ADVANCED_SETTINGS_KEY]: enabled },
    });
    return enabled;
  }

  async function assertAdvancedEnabled(companyId: string): Promise<void> {
    await assertEnabled(companyId);
    if (!(await isAdvancedEnabled(companyId))) {
      throw unprocessable(
        "Director AI, previews, transitions and music are switched off for this company. An owner or admin can turn them on under Media Studio settings.",
      );
    }
  }

  return { isEnabled, setEnabled, assertEnabled, isAdvancedEnabled, setAdvancedEnabled, assertAdvancedEnabled };
}
