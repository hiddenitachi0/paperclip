import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { serverVersion } from "../version.js";

const mockReadPersistedDevServerStatus = vi.hoisted(() => vi.fn());
const testServerInfo = {
  processStartedAt: "2026-06-26T00:00:00.000Z",
  git: {
    available: true,
    fullSha: "0123456789abcdef0123456789abcdef01234567",
    shortSha: "0123456",
    subject: "Add server info debug view",
    committedAt: "2026-06-25T23:00:00.000Z",
    localChanges: {
      available: true,
      hasLocalChanges: false,
      stagedFileCount: 0,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
    },
  },
} as const;

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: mockReadPersistedDevServerStatus,
  toDevServerHealthStatus: vi.fn(),
}));

// DUR-3939/DUR-3940: the fleet signal is computed by its own service (tested
// against a real database in fleet-health.test.ts); here it is mocked so the
// route's exposure rules can be checked on the same stub db the other cases use.
const mockComputeFleetHealth = vi.hoisted(() => vi.fn());
vi.mock("../services/fleet-health.js", () => ({
  computeFleetHealth: mockComputeFleetHealth,
}));

const testFleet = {
  available: true as const,
  computedAt: "2026-09-06T10:00:00.000Z",
  runs: {
    windowMinutes: 15,
    startedInWindow: 9,
    succeededInWindow: 7,
    failedInWindow: 1,
    cancelledInWindow: 0,
    running: 4,
    queued: 15,
    queuedWithNoRunningAgent: 11,
    oldestQueuedWaitMs: 20 * 60_000,
    zombieCandidates: 0,
    zombieSilenceMinutes: 30,
  },
  slots: { max: 4, used: 4, available: 0, saturated: true },
  agents: { inError: 0, inErrorSample: [] },
  scheduler: {
    enabled: true,
    intervalMs: 30_000,
    lastTickStartedAt: "2026-09-06T09:59:30.000Z",
    lastTickFinishedAt: "2026-09-06T09:59:30.200Z",
    lastTickResult: { checked: 12, enqueued: 8, skipped: 4 },
    lastTickError: null,
    sinceLastTickMs: 29_800,
    stale: false,
  },
  requests: {
    inFlight: 1,
    streaming: 0,
    peakInFlight: 4,
    peakInFlightAt: "2026-09-06T09:00:00.000Z",
    longestInFlightMs: 12,
    slowInFlight: 0,
    slowThresholdMs: 10_000,
    overloadThreshold: 50,
    overloaded: false,
    totalStarted: 10,
    totalFinished: 9,
  },
  database: { available: true, poolMax: 20, connections: 3, active: 1, idleInTransaction: 0, waitingOnLocks: 0 },
  summary: {
    level: "warning" as const,
    headline: "All 4 run slots are in use and 15 runs are waiting for one (the oldest has waited 20 minutes). Nothing is broken; raise \"Max concurrent runs (whole instance)\" under Settings > Instance settings > General to let more through.",
    notes: ["Runs are flowing: 9 started, 7 finished, 1 failed in the last 15 minutes. 4 of 4 slots in use, 15 queued."],
  },
};

// What actorMiddleware stamps on every request in local_trusted mode (the
// browser is the local board). Pass `actor: null` to leave it unset.
const localBoardActor = { type: "board", userId: "local-board", source: "local_implicit" } as const;

function createApp(
  db?: Db,
  serverInfo = testServerInfo,
  actor: { type: string; [key: string]: unknown } | null = localBoardActor,
) {
  const app = express();
  if (actor) {
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
  }
  app.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      serverInfo,
    }),
  );
  return app;
}

describe("GET /health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadPersistedDevServerStatus.mockReturnValue(undefined);
    mockComputeFleetHealth.mockResolvedValue(testFleet);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion, serverInfo: testServerInfo });
  }, 15_000);

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      serverInfo: testServerInfo,
    });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable",
      serverInfo: testServerInfo,
    });
  });

  it("returns safe server info fallbacks when git metadata is unavailable", async () => {
    const app = createApp(undefined, {
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: false,
        unavailableReason: "git_unavailable",
      },
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.serverInfo).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: false,
        unavailableReason: "git_unavailable",
      },
    });
  });

  it("redacts detailed metadata for anonymous requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
        serverInfo: testServerInfo,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
    expect(res.body.serverInfo).toBeUndefined();
    // The fleet signal names agents and counts runs: never for anonymous callers.
    expect(res.body.fleet).toBeUndefined();
    expect(mockComputeFleetHealth).not.toHaveBeenCalled();
  });

  it("redacts detailed metadata when authenticated mode is reached without auth middleware", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
        serverInfo: testServerInfo,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
    expect(res.body.serverInfo).toBeUndefined();
  });

  it("keeps detailed metadata for authenticated requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "user-1", source: "session" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
        serverInfo: testServerInfo,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: true,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      features: {
        companyDeletionEnabled: false,
      },
      serverInfo: testServerInfo,
      fleet: testFleet,
    });
    expect(mockComputeFleetHealth).toHaveBeenCalledTimes(1);
    const [, options] = mockComputeFleetHealth.mock.calls[0]!;
    expect(options).toMatchObject({
      scheduler: expect.objectContaining({ enabled: expect.any(Boolean), stale: expect.any(Boolean) }),
      requests: expect.objectContaining({ inFlight: expect.any(Number), overloaded: expect.any(Boolean) }),
    });
  });

  it("includes the fleet signal for the local board in local_trusted mode", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.fleet).toEqual(testFleet);
  });

  it("omits the fleet signal for agent callers, who still get the rest of the full-details body", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const agentActor = { type: "agent", agentId: "agent-1", companyId: "company-a", source: "agent_key" };

    for (const deploymentMode of ["local_trusted", "authenticated"] as const) {
      const app = express();
      app.use((req, _res, next) => {
        (req as any).actor = agentActor;
        next();
      });
      app.use(
        "/health",
        healthRoutes(db, {
          deploymentMode,
          deploymentExposure: "private",
          authReady: true,
          companyDeletionEnabled: true,
          serverInfo: testServerInfo,
        }),
      );

      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      // Full details (version, serverInfo) are still there for an agent...
      expect(res.body).toMatchObject({ status: "ok", version: serverVersion, serverInfo: testServerInfo });
      // ...but the fleet signal names agents across every company, so an
      // agent key from one company never receives it.
      expect(res.body.fleet).toBeUndefined();
      expect(mockComputeFleetHealth).not.toHaveBeenCalled();
    }
  });

  it("reports the fleet signal as unavailable, not as healthy, when it cannot be computed (DUR-98)", async () => {
    mockComputeFleetHealth.mockRejectedValueOnce(new Error("relation heartbeat_runs is locked"));
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.fleet).toEqual({ available: false, reason: "relation heartbeat_runs is locked" });
  });

  it("skips the fleet signal when the db handle cannot run queries", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.fleet).toBeUndefined();
    expect(mockComputeFleetHealth).not.toHaveBeenCalled();
  });
});
