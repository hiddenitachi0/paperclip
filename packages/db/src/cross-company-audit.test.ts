import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROUTINE_SCHEDULER_BYPASS_ACTOR_TYPE,
  ROUTINE_SCHEDULER_BYPASS_ROUTES,
  ROUTINE_SCHEDULER_BYPASS_SUMMARY_INTERVAL_MS,
  isRoutineSchedulerBypass,
  recordRoutineSchedulerBypass,
  resetRoutineSchedulerBypassCounts,
  snapshotRoutineSchedulerBypassCounts,
} from "./cross-company-audit.js";

describe("isRoutineSchedulerBypass (DUR-386)", () => {
  it("silences every enumerated scheduler chain", () => {
    for (const route of ROUTINE_SCHEDULER_BYPASS_ROUTES) {
      expect(isRoutineSchedulerBypass({ actorType: ROUTINE_SCHEDULER_BYPASS_ACTOR_TYPE, route })).toBe(true);
    }
  });

  it("does not silence a scheduler route that is not on the list (fail-open)", () => {
    expect(isRoutineSchedulerBypass({ actorType: "scheduler", route: "heartbeat-scheduler:startup-recovery" })).toBe(
      false,
    );
    expect(isRoutineSchedulerBypass({ actorType: "scheduler", route: "heartbeat-scheduler:brandNewChain" })).toBe(false);
    // A near-miss on a listed route must not match either -- exact strings only.
    expect(isRoutineSchedulerBypass({ actorType: "scheduler", route: "heartbeat-scheduler:tickTimers " })).toBe(false);
    expect(isRoutineSchedulerBypass({ actorType: "scheduler", route: "tickTimers" })).toBe(false);
  });

  it("does not silence a listed route claimed by a non-scheduler actor", () => {
    expect(isRoutineSchedulerBypass({ actorType: "user", route: "heartbeat-scheduler:tickTimers" })).toBe(false);
    expect(isRoutineSchedulerBypass({ actorType: "agent", route: "heartbeat-scheduler:tickTimers" })).toBe(false);
    expect(isRoutineSchedulerBypass({ actorType: null, route: "heartbeat-scheduler:tickTimers" })).toBe(false);
    expect(isRoutineSchedulerBypass({ route: "heartbeat-scheduler:tickTimers" })).toBe(false);
  });

  it("never silences a request-driven bypass", () => {
    expect(isRoutineSchedulerBypass({ actorType: "user", route: "/board-api-keys" })).toBe(false);
    expect(isRoutineSchedulerBypass({ actorType: "none", route: "/bootstrap/claim" })).toBe(false);
    expect(isRoutineSchedulerBypass({ actorType: "agent", route: null })).toBe(false);
    expect(isRoutineSchedulerBypass({})).toBe(false);
    expect(isRoutineSchedulerBypass(null)).toBe(false);
    expect(isRoutineSchedulerBypass(undefined)).toBe(false);
  });
});

describe("routine scheduler bypass counter (DUR-386)", () => {
  beforeEach(() => {
    resetRoutineSchedulerBypassCounts();
  });

  it("counts every silenced bypass per route so the rate stays answerable", () => {
    const log = vi.fn();
    recordRoutineSchedulerBypass("heartbeat-scheduler:tickTimers", 0, log);
    recordRoutineSchedulerBypass("heartbeat-scheduler:tickTimers", 1_000, log);
    recordRoutineSchedulerBypass("heartbeat-scheduler:quietModeAlerts", 2_000, log);

    expect(snapshotRoutineSchedulerBypassCounts()).toEqual({
      "heartbeat-scheduler:tickTimers": 2,
      "heartbeat-scheduler:quietModeAlerts": 1,
    });
  });

  it("stays quiet until a full summary interval has elapsed", () => {
    const log = vi.fn();
    recordRoutineSchedulerBypass("heartbeat-scheduler:tickTimers", 0, log);
    recordRoutineSchedulerBypass(
      "heartbeat-scheduler:tickTimers",
      ROUTINE_SCHEDULER_BYPASS_SUMMARY_INTERVAL_MS - 1,
      log,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("logs one summary per interval and starts a fresh window", () => {
    const log = vi.fn();
    recordRoutineSchedulerBypass("heartbeat-scheduler:tickTimers", 0, log);
    recordRoutineSchedulerBypass("heartbeat-scheduler:quietModeAlerts", 10, log);
    recordRoutineSchedulerBypass("heartbeat-scheduler:tickTimers", ROUTINE_SCHEDULER_BYPASS_SUMMARY_INTERVAL_MS, log);

    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("bypassed company scoping 3 time(s)");
    expect(message).toContain("tickTimers=2");
    expect(message).toContain("quietModeAlerts=1");

    // Next window starts empty; the cumulative total keeps growing.
    recordRoutineSchedulerBypass(
      "heartbeat-scheduler:tickTimers",
      ROUTINE_SCHEDULER_BYPASS_SUMMARY_INTERVAL_MS * 2,
      log,
    );
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[1]?.[0])).toContain("bypassed company scoping 1 time(s)");
    expect(snapshotRoutineSchedulerBypassCounts()["heartbeat-scheduler:tickTimers"]).toBe(3);
  });
});
