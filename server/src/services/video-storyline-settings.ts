import type { Db } from "@paperclipai/db";
import {
  MEDIA_MONTHLY_CAP_DEFAULT_CENTS,
  MEDIA_MONTHLY_CAP_SETTINGS_KEY,
  MEDIA_STUDIO_PLUGIN_KEY,
  VIDEO_STORYLINE_ADVANCED_SETTINGS_KEY,
  VIDEO_STORYLINE_APPROVAL_THRESHOLD_SETTINGS_KEY,
  VIDEO_STORYLINES_SETTINGS_KEY,
} from "@paperclipai/shared";
import { badRequest, notFound, unprocessable } from "../errors.js";
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
        "Video storylines are switched off for this company. An owner or admin can turn them on at the top of the Storylines tab in Media Studio.",
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
        "Director AI, previews, transitions and music are switched off for this company. An owner or admin can turn them on at the top of the Storylines tab in Media Studio.",
      );
    }
  }

  /**
   * DUR-4317/DUR-4320: the per-company spend threshold that gates the
   * kind:"video_render" board-approval card in video-storyline-render.ts's
   * startRender -- null (the default) means "not configured", which leaves
   * that extra gate off entirely, same opt-in posture as the two feature
   * flags above. This is layered ON TOP OF the always-on, mandatory
   * per-shot storyboardStatus==='approved' gate (that one has no setting --
   * see beginShotRender), not a replacement for it.
   */
  async function getApprovalThresholdCents(companyId: string): Promise<number | null> {
    const pluginId = await getPluginId();
    const settings = await registry.getCompanySettings(pluginId, companyId);
    const value = settings?.settingsJson?.[VIDEO_STORYLINE_APPROVAL_THRESHOLD_SETTINGS_KEY];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  async function setApprovalThresholdCents(companyId: string, thresholdCents: number | null): Promise<number | null> {
    if (thresholdCents !== null && (!Number.isInteger(thresholdCents) || thresholdCents < 0)) {
      throw badRequest("thresholdCents must be a non-negative integer, or null to turn the threshold off.");
    }
    const pluginId = await getPluginId();
    const existing = await registry.getCompanySettings(pluginId, companyId);
    await registry.upsertCompanySettings(pluginId, companyId, {
      settingsJson: { ...(existing?.settingsJson ?? {}), [VIDEO_STORYLINE_APPROVAL_THRESHOLD_SETTINGS_KEY]: thresholdCents },
    });
    return thresholdCents;
  }

  /** Storyline strip: the company's monthly cap for AI transitions (design 2.11); $20 until an owner or admin changes it. */
  async function getMediaMonthlyCapCents(companyId: string): Promise<number> {
    const pluginId = await getPluginId();
    const settings = await registry.getCompanySettings(pluginId, companyId);
    const value = settings?.settingsJson?.[MEDIA_MONTHLY_CAP_SETTINGS_KEY];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : MEDIA_MONTHLY_CAP_DEFAULT_CENTS;
  }

  async function setMediaMonthlyCapCents(companyId: string, capCents: number): Promise<number> {
    if (!Number.isInteger(capCents) || capCents < 0) throw badRequest("The monthly cap must be a whole number of cents, 0 or more.");
    const pluginId = await getPluginId();
    const existing = await registry.getCompanySettings(pluginId, companyId);
    await registry.upsertCompanySettings(pluginId, companyId, {
      settingsJson: { ...(existing?.settingsJson ?? {}), [MEDIA_MONTHLY_CAP_SETTINGS_KEY]: capCents },
    });
    return capCents;
  }

  return {
    getMediaMonthlyCapCents,
    setMediaMonthlyCapCents,
    isEnabled,
    setEnabled,
    assertEnabled,
    isAdvancedEnabled,
    setAdvancedEnabled,
    assertAdvancedEnabled,
    getApprovalThresholdCents,
    setApprovalThresholdCents,
  };
}
