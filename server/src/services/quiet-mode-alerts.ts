import type { Db } from "@paperclipai/db";
import { QUIET_MODE_STALE_AFTER_MS, QUIET_MODE_STUCK_AFTER_MS } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";
import { buildQuietModeNotice } from "./operator-notices.js";
import { isDeployQuietMode, quietModeThresholdMs, resolveQuietModeStuckMs } from "./fleet-health.js";

// DUR-3965 (with DUR-98: "silence must mean healthy"). Quiet mode freezes
// every agent in every company. On 2026-09-10 a failed deploy switched it on
// and could not switch it back off -- the undo call needs Paperclip's own API,
// which was down because Paperclip was the thing being redeployed -- and the
// instance sat completely silent for 27 minutes with nothing anywhere saying
// why. The fleet-health strip now shows it, and this tick makes sure an
// operator who is not looking at that strip still finds out, in their own
// Activity feed.
//
// It deliberately does NOT clear quiet mode. Someone may have switched it on
// on purpose (an overnight quota window, maintenance), and a server that
// un-pauses the whole fleet on its own is a worse failure than a paused one
// that is clearly labelled. Surfacing it is the whole job.
//
// And it deliberately does not treat every quiet mode as an incident. Filip
// uses quiet mode most nights for the Claude quota reset -- roughly a
// 22-hour window, on purpose. Writing "everything is paused and nobody took
// it out" into both companies' feeds every night would be crying wolf, and
// the sentence would be false besides. So a quiet mode a PERSON switched on
// stays silent until the long QUIET_MODE_STALE_AFTER_MS window and then says
// only what is true; a quiet mode a DEPLOY switched on is the incident, and
// gets the short window.

export const DEFAULT_QUIET_MODE_STUCK_THRESHOLD_MS = QUIET_MODE_STUCK_AFTER_MS;
export const DEFAULT_QUIET_MODE_MANUAL_THRESHOLD_MS = QUIET_MODE_STALE_AFTER_MS;

export interface QuietModeAlertsTickResult {
  active: boolean;
  /** How long quiet mode has been on, in ms (null when off or unknown). */
  activeForMs: number | null;
  /** True when a deploy switched it on (recorded reason), not a person. */
  activatedForDeploy: boolean;
  /** The window that applied to this activation, in ms (null when off). */
  thresholdMs: number | null;
  stuck: boolean;
  /** How many companies got the notice on this tick. */
  alerted: number;
}

export function quietModeAlertsService(
  db: Db,
  options: {
    /** Window for a quiet mode a DEPLOY switched on (default 30 minutes). */
    thresholdMs?: number;
    /** Window for a quiet mode a PERSON switched on (default 24 hours). */
    manualThresholdMs?: number;
  } = {},
) {
  const deployThresholdMs = options.thresholdMs ?? resolveQuietModeStuckMs();

  async function tick(now = new Date()): Promise<QuietModeAlertsTickResult> {
    const settings = instanceSettingsService(db);
    const general = await settings.getGeneral();
    const quietMode = general.quietMode;

    if (!quietMode.active) {
      // Reset the bookkeeping so a future stuck quiet mode is reported again.
      if (quietMode.stuckNoticeAt) await settings.setQuietModeStuckNoticeAt(null);
      return { active: false, activeForMs: null, activatedForDeploy: false, thresholdMs: null, stuck: false, alerted: 0 };
    }

    const activatedForDeploy = isDeployQuietMode(quietMode);
    const thresholdMs = quietModeThresholdMs({
      activatedForDeploy,
      deployStuckAfterMs: deployThresholdMs,
      manualStuckAfterMs: options.manualThresholdMs,
    });
    const activatedAt = quietMode.activatedAt ? new Date(quietMode.activatedAt) : null;
    const activeForMs =
      activatedAt && !Number.isNaN(activatedAt.getTime()) ? Math.max(0, now.getTime() - activatedAt.getTime()) : null;
    // A quiet mode with no usable start time is treated as past its window
    // rather than as fine: "we cannot tell how long the fleet has been
    // paused" is never a reason to stay quiet about it.
    const stuck = activeForMs === null || activeForMs >= thresholdMs;
    const base = { active: true as const, activeForMs, activatedForDeploy, thresholdMs };
    if (!stuck) return { ...base, stuck: false, alerted: 0 };
    // Already said once for this activation. activateQuietMode and
    // deactivateQuietMode both clear this, so the next stuck window is
    // reported afresh.
    if (quietMode.stuckNoticeAt) return { ...base, stuck: true, alerted: 0 };

    const message = buildQuietModeNotice({
      activatedAt: quietMode.activatedAt,
      activeForMs,
      activatedForDeploy,
    });
    const companyIds = await settings.listCompanyIds();
    for (const companyId of companyIds) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "quiet-mode-alerts",
        action: "instance.quiet_mode_stuck",
        entityType: "instance_settings",
        entityId: "default",
        details: {
          message,
          quietModeActivatedAt: quietMode.activatedAt,
          activeForMs,
          activatedForDeploy,
          thresholdMinutes: Math.round(thresholdMs / 60_000),
        },
      });
    }
    await settings.setQuietModeStuckNoticeAt(now);
    return { ...base, stuck: true, alerted: companyIds.length };
  }

  return { tick };
}
