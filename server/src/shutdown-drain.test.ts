import { describe, expect, it, vi } from "vitest";
import { waitForInFlightRunsToDrain } from "./shutdown-drain.js";

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("DUR-257: waitForInFlightRunsToDrain", () => {
  it("returns immediately when nothing is in flight", async () => {
    const logger = fakeLogger();
    const getInFlightRunCount = vi.fn(() => 0);
    const sleep = vi.fn(async () => {});

    await waitForInFlightRunsToDrain("SIGTERM", 60000, { getInFlightRunCount, logger, sleep });

    expect(sleep).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("polls until the count drops to 0, then returns without hitting the timeout", async () => {
    const logger = fakeLogger();
    let count = 2;
    let elapsed = 0;
    const getInFlightRunCount = vi.fn(() => count);
    const now = vi.fn(() => elapsed);
    const sleep = vi.fn(async () => {
      count -= 1;
      elapsed += 1000;
    });

    await waitForInFlightRunsToDrain("SIGTERM", 60000, { getInFlightRunCount, logger, sleep, now, pollIntervalMs: 1000 });

    expect(count).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM" }),
      "shutdown: all in-flight heartbeat runs finished, proceeding",
    );
  });

  it("gives up and warns once the deadline passes with runs still active", async () => {
    const logger = fakeLogger();
    const getInFlightRunCount = vi.fn(() => 3); // never drains
    let elapsed = 0;
    const now = vi.fn(() => elapsed);
    const sleep = vi.fn(async () => {
      elapsed += 1000;
    });

    await waitForInFlightRunsToDrain("SIGINT", 3000, { getInFlightRunCount, logger, sleep, now, pollIntervalMs: 1000 });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGINT", stillRunning: 3, timeoutMs: 3000 }),
      expect.stringContaining("drain timed out"),
    );
  });

  it("skips waiting and warns when the drain timeout is disabled (0)", async () => {
    const logger = fakeLogger();
    const getInFlightRunCount = vi.fn(() => 1);
    const sleep = vi.fn(async () => {});

    await waitForInFlightRunsToDrain("SIGTERM", 0, { getInFlightRunCount, logger, sleep });

    expect(sleep).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM", remaining: 1 }),
      expect.stringContaining("draining disabled"),
    );
  });
});
