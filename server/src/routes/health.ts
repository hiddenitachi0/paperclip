import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus, writeDevServerRestartRequest } from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { getServerInfoSnapshot, type ServerInfoSnapshot } from "../server-info.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { computeFleetHealth } from "../services/fleet-health.js";
import { getRequestLoadSnapshot } from "../services/request-load.js";
import { schedulerLiveness } from "../services/scheduler-liveness.js";
import {
  describePublicSchedulerDiagnostics,
  describeSchedulerRescues,
  describeStuckSchedulerChain,
  schedulerTickSingleFlight,
  type PublicSchedulerDiagnostics,
} from "../services/scheduler-tick-single-flight.js";
import type { FleetHealth, FleetSchedulerRescues } from "@paperclipai/shared";
import { serverVersion } from "../version.js";

function shouldExposeFullHealthDetails(
  // "service" is deliberately absent from the full-details branch below: a
  // company service token gets the same reduced health payload an
  // unauthenticated caller does (DUR-3977).
  actorType: "none" | "board" | "agent" | "board_delegate" | "service" | null | undefined,
  deploymentMode: DeploymentMode,
) {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board" || actorType === "agent";
}

function hasDevServerStatusToken(providedToken: string | undefined) {
  const expectedToken = process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN?.trim();
  const token = providedToken?.trim();
  if (!expectedToken || !token) return false;

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * DUR-3991: the scheduler watchdog's last rescue and the last tick's slowest
 * step, as code-level phase names and millisecond timings only -- no company,
 * agent, user, task, or count of any of them (describePublicSchedulerDiagnostics
 * drops the per-phase run counts because they would reveal how many agents
 * were woken).
 *
 * Who gets it: every FULL-details caller (the board, agents, and any caller in
 * local_trusted mode) -- NOT the anonymous body in authenticated mode, which
 * stays exactly status/deployment/bootstrap. Considered and rejected for the
 * anonymous body: on an internet-exposed instance, "the scheduler is wedged and
 * out of automatic restarts" is precisely the feedback someone trying to knock
 * the server over would want, and nobody who needs it lacks a sign-in -- the
 * operator reads it on the Now page and an on-box script can use an agent key.
 *
 * Diagnostics only: any failure to build it omits the field rather than
 * failing the health check (fail open).
 */
function publicSchedulerDiagnostics(): PublicSchedulerDiagnostics | undefined {
  try {
    const slowest = schedulerLiveness.snapshot().lastTickSlowestPhase;
    return describePublicSchedulerDiagnostics(
      schedulerTickSingleFlight.snapshot(),
      schedulerTickSingleFlight.diagnostics(),
      slowest ? { phase: slowest.phase, ms: slowest.ms } : null,
    );
  } catch (error) {
    logger.warn({ err: error }, "Health check scheduler diagnostics failed to compute");
    return undefined;
  }
}

/** Fail open: a failure here drops the rescue detail, never the fleet signal. */
function safeSchedulerRescues(): FleetSchedulerRescues | null {
  try {
    return describeSchedulerRescues(schedulerTickSingleFlight.snapshot(), schedulerTickSingleFlight.diagnostics());
  } catch (error) {
    logger.warn({ err: error }, "Health check scheduler rescue detail failed to compute");
    return null;
  }
}

/**
 * DUR-277/DUR-350 (Wave 4): deliberately stays bypass-scoped, not wired to
 * `companyScope`/`runInCompanyScope*`. Every query here is instance-wide by
 * nature -- `SELECT 1` liveness probe, `instanceUserRoles`/`invites` counts
 * used only to compute bootstrap status, and a queued/running `heartbeatRuns`
 * count for dev-server auto-restart gating -- none of it is scoped to, or
 * filtered by, any single company. `/` also runs pre-auth (deploymentMode
 * "authenticated" callers get a reduced body, but the route itself has no
 * actor/company context to scope against at all in the unauthenticated case).
 * See the DUR-277 design doc §1 (health.ts: category (c)).
 */
export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    serverInfo?: ServerInfoSnapshot;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();

  router.post("/dev-server/restart", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    if (opts.deploymentMode === "authenticated" && actorType !== "board") {
      res.status(403).json({ error: "board_access_required" });
      return;
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    if (!persistedDevServerStatus) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    const restartRequired =
      persistedDevServerStatus.dirty ||
      persistedDevServerStatus.changedPathCount > 0 ||
      persistedDevServerStatus.pendingMigrations.length > 0;
    if (!restartRequired) {
      res.status(409).json({ error: "restart_not_required" });
      return;
    }

    const written = writeDevServerRestartRequest({
      requestedAt: new Date().toISOString(),
      reason: "manual_restart_now",
    });
    if (!written) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    res.status(202).json({ status: "restart_requested" });
  });

  router.get("/", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    const exposeFullDetails = shouldExposeFullHealthDetails(
      actorType,
      opts.deploymentMode,
    );
    // serverInfo (git SHA + process start) rides on the full-details responses
    // only, so it reaches board/agent actors in authenticated mode or any caller
    // in local_trusted dev — never anonymous authenticated callers. The
    // enableServerInfoDebugView experimental flag gates the UI surface, not this
    // already access-controlled field.
    const serverInfo = opts.serverInfo ?? getServerInfoSnapshot();
    const exposeDevServerDetails =
      exposeFullDetails || hasDevServerStatusToken(req.get("x-paperclip-dev-server-status-token"));

    if (!db) {
      res.json(
        exposeFullDetails
          ? { status: "ok", version: serverVersion, serverInfo }
          : { status: "ok", deploymentMode: opts.deploymentMode },
      );
      return;
    }

    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      logger.warn({ err: error }, "Health check database probe failed");
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        error: "database_unreachable",
        ...(exposeFullDetails ? { serverInfo } : {}),
      });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

      if (bootstrapStatus === "bootstrap_pending") {
        const now = new Date();
        const inviteCount = await db
          .select({ count: count() })
          .from(invites)
          .where(
            and(
              eq(invites.inviteType, "bootstrap_ceo"),
              isNull(invites.revokedAt),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, now),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        bootstrapInviteActive = inviteCount > 0;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (exposeDevServerDetails && persistedDevServerStatus && typeof (db as { select?: unknown }).select === "function") {
      const instanceSettings = instanceSettingsService(db);
      const experimentalSettings = await instanceSettings.getExperimental();
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]))
        .then((rows) => Number(rows[0]?.count ?? 0));

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount,
      });
    }

    if (!exposeFullDetails) {
      res.json({
        status: "ok",
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        bootstrapStatus,
        bootstrapInviteActive,
        ...(devServer ? { devServer } : {}),
      });
      return;
    }

    const schedulerDiagnostics = publicSchedulerDiagnostics();

    // DUR-3939/DUR-3940/DUR-272: fleet run-rate, slot saturation, agents in
    // error, zombie candidates, scheduler liveness and request load -- all
    // computed from live state right now. Board callers only: the signal
    // spans every company on the instance (agent names across companies),
    // so an agent's API key -- which belongs to one company -- never gets
    // it, even though agents do get the rest of the full-details body. A
    // failure to compute is reported as such, never rendered as "healthy"
    // (DUR-98 item 4).
    let fleet: FleetHealth | undefined;
    if (actorType === "board" && typeof (db as { select?: unknown }).select === "function") {
      try {
        fleet = await computeFleetHealth(db, {
          scheduler: {
            ...schedulerLiveness.snapshot(),
            // DUR-3991: when the scheduler has stopped completing ticks, the
            // reason is almost always one chain that has not returned. The
            // single-flight guard is the only thing that knows which, so the
            // Now page can name it instead of saying "something is stuck".
            stuckChain: describeStuckSchedulerChain(schedulerTickSingleFlight.snapshot()),
            // DUR-3991: the watchdog's last rescue (with where it was stuck)
            // and whether any stuck step has run out of automatic restarts.
            rescues: safeSchedulerRescues(),
          },
          requests: getRequestLoadSnapshot(),
        });
      } catch (error) {
        logger.warn({ err: error }, "Health check fleet signal failed to compute");
        fleet = {
          available: false,
          reason: error instanceof Error ? error.message : "fleet_health_unavailable",
        };
      }
    }

    res.json({
      status: "ok",
      version: serverVersion,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      serverInfo,
      ...(devServer ? { devServer } : {}),
      ...(schedulerDiagnostics ? { scheduler: schedulerDiagnostics } : {}),
      ...(fleet ? { fleet } : {}),
    });
  });

  return router;
}
