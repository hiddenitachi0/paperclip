import type { Db } from "@paperclipai/db";
import { QUIET_MODE_STUCK_AFTER_MS } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";
import { buildQuietModeStuckNotice } from "./operator-notices.js";
import { isDeployQuietModeActor, resolveQuietModeStuckMs } from "./fleet-health.js";

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

export const DEFAULT_QUIET_MODE_STUCK_THRESHOLD_MS = QUIET_MODE_STUCK_AFTER_MS;

export interface QuietModeAlertsTickResult {
  active: boolean;
  /** How long quiet mode has been on, in ms (null when off or unknown). */
  activeForMs: number | null;
  stuck: boolean;
  /** How many companies got the notice on this tick. */
  alerted: number;
}

export function quietModeAlertsService(db: Db, options: { thresholdMs?: number } = {}) {
  const thresholdMs = options.thresholdMs ?? resolveQuietModeStuckMs();

  async function tick(now = new Date()): Promise<QuietModeAlertsTickResult> {
    const settings = instanceSettingsService(db);
    const general = await settings.getGeneral();
    const quietMode = general.quietMode;

    if (!quietMode.active) {
      // Reset the bookkeeping so a future stuck quiet mode is reported again.
      if (quietMode.stuckNoticeAt) await settings.setQuietModeStuckNoticeAt(null);
      return { active: false, activeForMs: null, stuck: false, alerted: 0 };
    }

    const activatedAt = quietMode.activatedAt ? new Date(quietMode.activatedAt) : null;
    const activeForMs =
      activatedAt && !Number.isNaN(activatedAt.getTime()) ? Math.max(0, now.getTime() - activatedAt.getTime()) : null;
    // A quiet mode with no usable start time is treated as stuck rather than
    // as fine: "we cannot tell how long the fleet has been paused" is never a
    // reason to stay quiet about it.
    const stuck = activeForMs === null || activeForMs >= thresholdMs;
    if (!stuck) return { active: true, activeForMs, stuck: false, alerted: 0 };
    // Already said once for this activation. activateQuietMode and
    // deactivateQuietMode both clear this, so the next stuck window is
    // reported afresh.
    if (quietMode.stuckNoticeAt) return { active: true, activeForMs, stuck: true, alerted: 0 };

    const message = buildQuietModeStuckNotice({
      activatedAt: quietMode.activatedAt,
      activeForMs,
      activatedForDeploy: isDeployQuietModeActor(quietMode.activatedBy?.actorType),
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
          thresholdMinutes: Math.round(thresholdMs / 60_000),
        },
      });
    }
    await settings.setQuietModeStuckNoticeAt(now);
    return { active: true, activeForMs, stuck: true, alerted: companyIds.length };
  }

  return { tick };
}
